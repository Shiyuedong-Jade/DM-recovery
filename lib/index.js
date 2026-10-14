/**
 * 达梦数据库可恢复能力评估 —— DSH 插件入口。
 *
 * 边界（写死在实现里，不是配置项）：
 *   · 只注册**只读**查询，桥只放行 SELECT / WITH；
 *   · **不提供**主动扫描坏页、**不提供**调用 SF_*_PAGE_REPAIR、**不提供**任何改配置建议。
 *     原因见 README：本类环境 PAGE_CHECK_POLICY=1，读到坏页即 HALT。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { runQueries, defaultHome, ensureHome, classifyDbError } from './bridge.js';
import { FORM_QUERIES, READINESS_QUERIES, LIST_QUERIES, TABLESPACE_QUERY, ARCHIVE_QUERIES } from './queries.js';
import { judgeReadiness, buildPageList, buildReverseLookups, attachObjects, tablespaceMap, assessTablespaceStatus, toCount } from './analyze.js';
import { checkArchiveParams, measureGrowth, recommendArchiveParams } from './archive.js';
import {
  BACKUP_QUERIES,
  parseBackupSets,
  assessBackupCoverage,
  assessArchiveChain,
  assessTimeLsnAnchors,
  bracketTable,
  timeForLsn,
  verifySuppliedPath,
  relatePagesToBackups,
  dmrmanCheckCommand,
  scalarOf,
  rowsAsObjects,
  normalizePath,
  fmtStamp,
  fmtMinutes,
} from './backup.js';
import {
  parseTargets,
  judgeConsistency,
  describeCoverage,
  renderDsc,
  attributePages,
  renderNodeAttribution,
  kvFrom,
  singleRowFields,
} from './dsc.js';
import { buildReportHtml, LEVEL_LABEL, esc } from './report.js';
// ★ 输出格式规范（DESIGN §24）：骨架四层 + 唯一词表。
//   六个 action 的正文一律经 `renderResult` 组装，不再各写各的标题与层。
import { renderResult, point, splitH2Sections } from './format.js';
import { CAP_MARK, COND, COND_MARK, levelTag, renderVocabTable, TOOL_TITLE } from './vocab.js';
import { CAP_LABEL as CAP_LABEL_FOR } from './vocab.js';
// ★ 结果信封与稳定 ID（DESIGN §25）：六个 action 一律经 `buildResult` 返回。
import { buildResult, finding, ID, PROV, resultJson, topLevelOf, TOOL_ID } from './result.js';
import {
  assessScenarios,
  gradeScenarios,
  renderScenarioMatrix,
  renderScenarioEvidence,
  assessConditions,
  renderScenarioBlocks,
  renderTopActions,
  renderAdviceList,
} from './scenarios.js';
import { checkBackupsetViaSsh, scanBackupLogViaSsh, findBackupsViaSsh, pickFindDir, deriveBackupSets } from './ossh.js';
// ★ （原 `./requirements.js` 的 import 在这里 —— 2026-10-13 需求达成度整项移除，模块已删，DESIGN §29.10）
import fs from 'node:fs';
import path from 'node:path';

/**
 * 恢复能力**专项探测** —— 这些不是"巡检项"，而是 DESIGN §18.1 场景清单里
 * 每个场景判定所依赖的**事实**。少一项，对应场景就只能判成「无法判定」。
 */
const CAP_QUERIES = [
  {
    key: 'capIni',
    sql:
      `SELECT PARA_NAME, PARA_VALUE FROM V$DM_INI WHERE PARA_NAME IN ` +
      `('ENABLE_FLASHBACK','UNDO_RETENTION','CTL_BAK_PATH','CTL_BAK_NUM','BAK_PATH','RECYCLEBIN')`,
    optional: true,
  },
  { key: 'datafile', sql: `SELECT ID, GROUP_ID, PATH, STATUS$ FROM V$DATAFILE`, optional: true },
  { key: 'rlogfile', sql: `SELECT GROUP_ID, FILE_ID FROM V$RLOGFILE`, optional: true },
  { key: 'recyclebin', sql: `SELECT COUNT(*) AS N FROM DBA_RECYCLEBIN`, optional: true },
  /**
   * 表空间状态（B8「表空间被误删」的证据）。
   * ★ 实测（2026-10-12）：`DBA_TABLESPACES.STATUS` 是**自描述**的 `ONLINE`，
   *   而 `V$TABLESPACE.STATUS$` 是数值 `0`（含义未核实）→ **主口径用自描述那个**。
   */
  { key: 'tablespace', sql: `SELECT TABLESPACE_NAME, STATUS, CONTENTS FROM DBA_TABLESPACES`, optional: true },
  { key: 'tablespaceRaw', sql: `SELECT ID, NAME, STATUS$ FROM V$TABLESPACE`, optional: true },
];

const TOOL_NAME = 'dm_recovery_readiness';

/**
 * 每个调用方声明的参数**被哪些 action 真正使用**（DESIGN §29.7）。
 *
 * 为什么需要它：六个 action 共用**同一张参数表**，但每个 action 只认其中一部分。
 * 以前"收了但没用"的参数会被静默丢掉 —— 调用方给 `backup` 传个它不认的参数后
 * 只看到一堆素材，很容易读成"插件算过了"。
 * 现在 `meta.inputsDeclaredByUser[].used` 会说清它有没有参与本次判定。
 */
export const USED_BY = {
  backupPath: ['backup', 'report'],
  targets: ['list', 'triage', 'readiness', 'backup', 'report'],
  retentionHours: ['capacity', 'report'],
  sshHost: ['backup', 'report'],
  dmrmanDcrIni: ['backup', 'report'],
};

/** 按动作中文名（`ACTION_LABEL`）说清"这个参数该用哪个 action"。 */
const ACTION_CN = { list: 'list', readiness: 'readiness', triage: 'triage', capacity: 'capacity', backup: 'backup', report: 'report' };

/**
 * 「你给了但本次没用」的提示行（DESIGN §29.7）。
 *
 * 只在**有**这样的参数时返回一条，附带它能用的 action —— 不写"请改用 report"这种命令句，
 * 只陈述事实（换不换 action 是调用方的判断）。
 */
export function ignoredParamNotes(args) {
  const ignored = Object.keys(USED_BY).filter((k) => {
    const v = args[k];
    const given = v !== undefined && v !== null && v !== '';
    return given && !USED_BY[k].includes(args.action);
  });
  if (ignored.length === 0) return [];
  return [
    `⚠️ 你给了 ${ignored.map((k) => `\`${k}\``).join('、')}，但 \`${args.action}\` **不使用**它 —— ` +
      `本次**没有**据此做任何判定（能用的是：${[...new Set(ignored.flatMap((k) => USED_BY[k].map((a) => ACTION_CN[a] ?? a)))].join(' / ')}）。`,
  ];
}

/** 需要 tools 服务；没有它本插件不加载。 */
const inject = ['tools'];

/**
 * 参数 spec 用的是 **DSH 自定义 DSL，不是 JSON Schema**（defineTool 会把它编译成 JSON Schema）：
 * 参数对象是**隐式开放根**，直接写成「名字 → spec」的映射，
 * 必填靠每个属性上的 `required: true`；只有嵌套 object 才需要显式 `additionalProperties`。
 */
const PARAMETERS = {
  action: {
    type: 'string',
    enum: ['list', 'readiness', 'triage', 'capacity', 'backup', 'report'],
    required: true,
    description:
      'list=列出已知损坏页并按时间判断是否需再次修复；readiness=处置能力体检（能否在线修、能恢复到什么程度、能否主动扫描）；' +
      'triage=逐页分诊（定位到具体对象）；capacity=归档空间参数检查，并按实测速率推荐应设的值；' +
      'backup=备份可用性：库里有哪些备份、能恢复到哪一点、备份本身可不可信，并核对调用方自带的备份位置；' +
      'report=把上述几块汇总成**一份 HTML 报告落盘**（对齐 dm8-inspect 的交付形态）。',
  },
  outDir: {
    type: 'string',
    description: 'report 用：HTML 报告输出目录，默认 <插件工作目录>/dm-recovery-reports。可用 ~ 开头。',
  },
  sampleSec: {
    type: 'integer',
    description:
      '**已废弃、不再使用**（保留仅为兼容旧调用）。capacity 原先靠它做速率采样，' +
      '但归档文件可能几十分钟才新建一个，工具会挂在等待上；且该速率既不外推、也不参与推荐，故已取消采样。',
  },
  retentionHours: {
    type: 'integer',
    description: 'capacity 用的回溯窗口假设（小时），默认 24。**这是业务决策**：出事后需要能恢复到多久之前。',
  },
  backupPath: {
    type: 'string',
    description:
      'backup 用：调用方自行提供的备份位置（备份集路径或备份名，ASM 路径以 + 开头同样可以）。' +
      '本插件会拿它去库的账本 V$BACKUPSET 里核对，并给出唯一能真正校验备份集的 dmrman 命令。' +
      '基于现有信息没发现备份时，用这个参数把位置告诉插件。',
  },
  targets: {
    type: 'string',
    description:
      'DMDSC 多节点：各节点的 host:port，逗号/空格/换行分隔（端口省略则 5236）。' +
      '**为什么必须由你给**：实测 `V$DSC_EP_INFO` 只有 6 列、没有地址列，插件无法自动发现对端节点。' +
      '给了之后 readiness 会逐节点核对参数配置并报告节点间差异，list/triage 会标出坏页是哪个节点记录的。' +
      '不给也能用，但插件会明确告诉你「本库是 N 节点、只检查了 1 个」。',
  },
  sshHost: { type: 'string', description: 'OS 访问用：数据库主机。**不给则不做任何 OS 级检查**（插件保持纯 JDBC 只读）' },
  sshPort: { type: 'integer', description: 'OS 访问用：SSH 端口，默认 22' },
  sshUser: { type: 'string', description: 'OS 访问用：SSH 账号（通常 dmdba 或 root）' },
  sshPassword: {
    type: 'string',
    description: 'OS 访问用：SSH 口令。**不建议填**（会进会话日志）；不填则不做 OS 级检查。启用后插件会在主机上执行**只读**命令。',
  },
  sshHostKey: {
    type: 'string',
    description:
      'OS 访问用：目标主机密钥指纹（形如 `ssh-ed25519 255 SHA256:...`）。**plink 在 -batch 模式下要求密钥已知**，' +
      '不给会在主机密钥确认处中止 —— 要么填这里，要么先手工接受一次。',
  },
  plinkPath: { type: 'string', description: 'plink 可执行文件路径，默认从 PATH 找 `plink`' },
  dmrmanPath: { type: 'string', description: 'OS 访问用：主机上 dmrman 的路径，默认 `dmrman`（走 PATH）' },
  dmrmanDcrIni: {
    type: 'string',
    description:
      'OS 访问用：**DM 的 DCR 配置文件 `dmdcr.ini` 在主机上的路径**（DMDSC 上必需）。' +
      '**为什么需要**：实测备份集在 **ASM** 上时，`dmrman CHECK BACKUPSET` 默认报 ' +
      '`SBT[-127] 无效的备份集目录` + `MML[-10001] 设置第三方MM属性失败` —— ' +
      '那不是备份坏了，而是 dmrman **够不到 ASM**；换用户（root/dmdba）都一样。' +
      '加上 `DCR_INI=<dmdcr.ini>` 后同一条命令就变成 `check backupset successfully`（真机实测 2.9 秒），' +
      '于是"备份到底能不能读"从**未知**变成**确定**。' +
      '**在哪找**：`ps -ef | grep dmserver` 的命令行里有 `dcr_ini=…`；DMDSC 上逐节点不同' +
      '（如 `/home/dmdba/dmdbms/data/DSC01/dmdcr.ini`）。不给则退回不带 DCR 的命令，结论会是「未取到」。',
  },
  sshLogDir: {
    type: 'string',
    description:
      'OS 访问用：**数据库主机上** DM 日志目录（如 `/home/dmdba/dmdbms/log`）。给了它插件才会跑日志扫描，' +
      '把「全库逐页裁决」（`N corrupted pages during backup`）直接取回来 —— 那是 `V$ERROR_PAGE` 永远给不了的东西。',
  },
  sshScriptPath: {
    type: 'string',
    description:
      'OS 访问用：`scan-backup-log.sh` **在数据库主机上**的路径。插件没有上传通道，需先把 ' +
      '`assets/shell/scan-backup-log.sh` 拷到主机上。不给则默认 `<sshLogDir>/scan-backup-log.sh`。',
  },
  sshBackupDir: {
    type: 'string',
    description:
      'OS 访问用：在主机文件系统上找备份文件的目录。**只在路径不是 ASM（不以 `+` 开头）时才有意义** —— ' +
      'ASM 不是文件系统，`find`/`ls` 本来就看不到。不给则自动取「调用方给的备份位置 / 账本里的备份路径」' +
      '所在目录（仍是文件系统形态才用）。',
  },
  host: {
    type: 'string',
    description:
      '数据库服务器 IP 或主机名，**支持 `host:port` 简写**（如 `10.127.11.61:7236`）。' +
      '本插件**不落任何默认连接信息**（口令每次手输），少填一个字段是一个；' +
      '若同时给了 `port` 参数，以 `port` 为准。',
  },
  port: { type: 'integer', description: '数据库端口，默认 5236（DMDSC 常见 7236 / 7237）；写了它即压过 `host` 里带的端口' },
  // ★ 恢复需求三参数（`rpoMinutes` / `targetTime` / `targetWindow`）已于 2026-10-13 **整项删除**：
  //   用户决定不要「恢复需求达成度」这一节（DESIGN §29.10）。RTO 更早在 §29.9 就删掉了。
  //   连带删掉的还有：`req.*` 命名空间、§32 的「先决条件」行、以及 `lib/requirements.js` 整个模块。
  // ★ RTO 三项（`rtoMinutes` / `drillRtoMinutes` / `drillAt`）已于 2026-10-13 **整项删除**
  //   （用户决定不做恢复演练）。留着"传了也没用"的壳比删掉更坏：卡片上多三个字段，
  //   每次评估还会多出一条永远判不了的「无法判定」。理由详见 lib/requirements.js 顶部注释 与 DESIGN §29.9。
  user: { type: 'string', description: '数据库账号，默认 SYSDBA' },
  password: {
    type: 'string',
    description:
      '数据库口令。**本项目约定：每次运行在卡片里手输、用完即弃** —— 不配凭据库、不落默认值、插件不保存。' +
      '实测：口令**不会**出现在 `<工作目录>/runtime/`（那里只有 SQL 与结果 JSON）、报告 HTML、`findings.json` 里；' +
      '但它会进入本次会话日志与子进程命令行 —— 这是非交互传口令的固有限制。',
  },
};

/**
 * 输出 schema —— **对外契约**（DESIGN §25）。
 *
 * 新增的是信封字段（`tool`/`resultVersion`/`level`/`conclusion`/`summary`/`findings`/`result`/
 * `meta`/`disclaimer`/`findingsPath`）；`verdict`/`distinctPages`/`needAttention` 三个旧字段
 * **保留一代**做兼容，但已在描述里标明废弃 —— 它们的语义随 action 变（见 `lib/result.js` 头部）。
 *
 * 嵌套对象用 `additionalProperties: true` 声明为**开放式**：它们的形状随 action 与库而变，
 * 逐字段声明既写不完也跟不上（`summary` 里没有的项显式给 `null`，而不是缺键）。
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool: { type: 'string', required: true, description: '工具标识，恒为 dm_recovery_readiness' },
    resultVersion: { type: 'integer', required: true, description: '结果信封版本号；形状变更时递增' },
    action: { type: 'string', required: true, description: '本次执行的动作：list / readiness / triage / capacity / backup / report' },
    generatedAt: { type: 'string', required: true, description: '生成时间（见 generatedAtSource）' },
    generatedAtSource: { type: 'string', required: true, description: '时钟来源：local=插件所在机器（库服务器时钟可能与之不同）' },
    level: { type: 'string', description: '总体等级：crit / warn / info / unknown；无可权威分级时**不返回此项**' },
    conclusion: { type: 'string', required: true, description: '一句话结论（机器可读的主结论）' },
    summary: { type: 'object', additionalProperties: true, required: true, description: '合计：byLevel{} / total / scenarios / pages / nodes / backups / archiveContinuous（无者显式为 null）' },
    findings: { type: 'array', required: true, items: { type: 'object', additionalProperties: true }, description: '结论项：[{id(稳定语义ID), level, title, detail, evidence[], advice?}]' },
    result: { type: 'object', additionalProperties: true, required: true, description: 'action 专属的结构化事实（完整记录，不只是需要关注的）' },
    meta: { type: 'object', additionalProperties: true, required: true, description: '环境：host/port/user/db/instance/version/form/nodes/startedAt/finishedAt/durationMs/osAccess' },
    disclaimer: { type: 'string', required: true, description: '假阴性免责等固定声明' },
    text: { type: 'string', required: true, description: '渲染后的完整正文（四层骨架）' },
    reportPath: { type: 'string', description: 'report 动作落盘的 HTML 报告绝对路径；其它动作不返回此项' },
    findingsPath: { type: 'string', description: 'report 动作落盘的 findings.json 绝对路径；其它动作不返回此项' },
    // ---- 兼容旧契约（一代，已废弃）----
    verdict: { type: 'string', required: true, description: '【已废弃，用 conclusion】旧字段：一句话结论' },
    distinctPages: { type: 'integer', required: true, description: '【已废弃，用 summary.pages.distinct】旧的坏页数；部分 action 恒为 0' },
    needAttention: { type: 'integer', required: true, description: '【已废弃，用 findings/summary】旧字段：**语义随 action 变**（坏页数 / 节点不一致数 / 连接失败数 / 0）' },
  },
};

const fmtT = (d) => (d instanceof Date ? d.toISOString().slice(0, 19).replace('T', ' ') : '—');

/**
 * **本机**时间戳。
 * ⚠️ 不用 `toISOString()`：它按本地时区解释再转 UTC，会把 10:50 显示成 02:50
 * （§11.9 记过同一类缺陷）。信封里同时给 `generatedAtSource: 'local'` 说明时钟来源。
 */
const localStamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/**
 * 连接 / 桥层失败时的**兜底信封**（DESIGN §28）。
 *
 * 要点：**失败也必须走 §25 的信封**（而不是抛栈），并且要说清三件事：
 * ① 是什么错（归类）；② **该做什么**；③ **别再重复试**（达梦连续登录失败会锁账号 ——
 * 本项目真的踩过一次）。`level` 用归类给的档位（账号锁定 = `crit`：它已经影响可用性了）。
 *
 * 它**不依赖** `execute` 里的局部函数（`mkMeta` 等），所以自带一份最小 meta。
 */
export function connectionFailureEnvelope({ action, args, error }) {
  const cls = classifyDbError(error?.message ?? error);
  const raw = String(error?.message ?? error);
  const conclusion = `${cls.title} —— **未做任何判断**`;
  return buildResult({
    action,
    generatedAt: localStamp(),
    level: cls.level,
    conclusion,
    findings: [
      finding(
        ID.form('connection'),
        cls.level,
        cls.title,
        `${cls.hint}\n\n原始错误：\`${raw.split('\n')[0].slice(0, 300)}\``,
        [`错误类别：${cls.kind}`],
        null,
        PROV.derived('连接 / 桥层异常'),
      ),
    ],
    result: { errorKind: cls.kind, rawError: raw.slice(0, 2000) },
    meta: {
      host: args?.host ?? null,
      port: args?.port ?? null,
      user: args?.user ?? null,
      startedAt: null,
      finishedAt: localStamp(),
      durationMs: null,
      osAccess: null,
      inputsDeclaredByUser: [],
    },
    disclaimer: '连接或桥层失败时**不给任何结论** —— 「没查到」不等于「没问题」。',
    text: renderResult({
      action,
      level: cls.level,
      conclusion,
      points: [point(cls.level, cls.hint), point(null, `错误类别：\`${cls.kind}\``)],
      boundaries: [
        `原始错误：\`${raw.split('\n')[0].slice(0, 300)}\``,
        // 「别再试」只对**账号类**错误说 —— 那是真的会锁号；连不上时重复试并无额外危害
        ...(cls.kind === 'auth-locked' || cls.kind === 'auth-failed'
          ? ['连接失败时**不要反复重试**：达梦连续登录失败会**锁定账号**，解锁需要 DBA 执行 `ALTER USER … ACCOUNT UNLOCK;`。']
          : []),
        // 失败路径同样要说清"你给的需求参数本次没用上"（§29.7）——失败不等于可以忽略这点
        ...ignoredParamNotes(args ?? {}),
      ],
    }),
    legacy: { verdict: cls.title, distinctPages: 0, needAttention: 0 },
  });
}

/**
 * 「一个目标都没采到」时该说什么（DESIGN §39）。
 *
 * **不能写死一句「所有目标节点均无法连接」**：失败原因根本不是同一件事，而措辞决定读者去哪里排查。
 *
 * | 真因 | 说成"无法连接"的后果 |
 * | --- | --- |
 * | 网络 / 端口 / 实例没起 | 准确 —— 就该这么写 |
 * | **本机写不了工作目录（`EPERM`）** | **错**：数据库还没被连上，读者会去查网络（本项目实测踩过） |
 * | 账号 / 口令错 | 该劝「别再重试，会锁号」 |
 * | 上面前两种混着出现 | 合并成一句就是撒谎 —— 要**分别计数** |
 *
 * 顺带修掉一个同类毛病：报表路径原来**无条件**贴「不要反复重试：连续登录失败会锁定账号」——
 * 那句话只对账号类错误成立，贴给网络失败是错的（`connectionFailureEnvelope` 里本来就有 kind 判断，
 * 这条并行路径漏了）。所以 `advice` 由**分类结果**决定，不由调用方拍。
 *
 * 返回 `{ kind, title, conclusion, advice[] }`；等级由调用方定（`readiness`=未取到 / `report`=未生成报告），
 * 两条路径的既有等级语义不改。
 */
export function collectionFailureHeadline(failed = []) {
  const list = failed ?? [];
  const kinds = list.map((f) => classifyDbError(f?.error ?? '').kind);
  const n = kinds.length;
  const localIo = kinds.filter((k) => k === 'local-io').length;
  const auth = kinds.filter((k) => k === 'auth-failed' || k === 'auth-locked').length;
  const advice = [];
  // ★ 只在**真的**涉及账号时才说这句（乱贴会把网络问题说成锁号问题）
  if (auth > 0) {
    advice.push('**不要反复重试**：达梦连续登录失败会**锁定账号**，解锁需要 DBA 执行 `ALTER USER … ACCOUNT UNLOCK;`。');
  }
  if (localIo > 0) {
    advice.push(
      '**这次不是数据库的问题**：插件要在工作目录（默认 `~/.dsh/dm-recovery-readiness`）下写 SQL 与结果文件，' +
        '那一步失败了。用 `dm_recovery_readiness_HOME=<可写目录>` 指到可写位置后重试；**不要**去查网络或实例状态。',
    );
  }
  if (n > 0 && localIo === n) {
    return {
      kind: 'local-io',
      title: '本机读写插件工作目录失败 —— **尚未连到数据库**',
      conclusion: `本机读写插件工作目录失败 —— **未做任何判断**（${n} 个目标都还没连上）`,
      advice,
    };
  }
  if (localIo > 0) {
    return {
      kind: 'mixed',
      title: `目标未能完成采集（本机写目录失败 ${localIo} 个 / 其它 ${n - localIo} 个）`,
      conclusion: `目标未能完成采集 —— **未做任何判断**（本机写目录失败 ${localIo} 个、其它原因 ${n - localIo} 个）`,
      advice,
    };
  }
  return {
    kind: 'unreachable',
    title: '所有目标节点均无法连接',
    conclusion: `所有目标节点均无法连接（${n} 个目标全失败）`,
    advice,
  };
}

/**
 * 解析 SSH 节点列表（DESIGN §38）。**默认端口 22**（不是数据库的 5236 ——
 * 复用 `parseTargets` 会把 22 写成 5236，所以这里单独一个解析器）。
 * 支持 `host`、`host:port`、IPv6 字面量 `[::1]:22`；分隔符：逗号 / 空格 / 换行。
 */
export function parseSshHosts(v) {
  return String(v ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => {
      const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
      if (m) return { host: m[1], port: m[2] ? Number(m[2]) : null };
      const i = s.lastIndexOf(':');
      if (i > 0 && /^\d+$/.test(s.slice(i + 1))) return { host: s.slice(0, i), port: Number(s.slice(i + 1)) };
      return { host: s, port: null };
    })
    .filter((x) => x.host !== '')
    .filter((x, i, a) => a.findIndex((y) => y.host === x.host && y.port === x.port) === i);
}

/**
 * 把「一个值或等长列表」对齐到 N 个节点。
 * 1 个值 → 全员共用；个数相等 → 按序一一对应；**个数既不是 1 也不相等 → 用第一个值并记一条说明**
 * （不猜、也不静默：对不上就明说"无法按序对齐"）。
 */
function alignList(raw, n, what, notes) {
  const vals = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (vals.length === 0) return Array(n).fill(null);
  if (vals.length === 1) return Array(n).fill(vals[0]);
  if (vals.length === n) return vals;
  notes.push(
    `⚠️ \`${what}\` 给了 **${vals.length}** 个值、但有 **${n}** 个 SSH 节点 —— **无法按序对齐**，` +
      `本次全部用第一个值「${vals[0]}」。要逐节点不同值，请给同样个数、同样顺序的逗号列表。`,
  );
  return Array(n).fill(vals[0]);
}

/**
 * 汇总 OS 访问参数（DESIGN §38：**支持多节点**）。
 *
 * 之前只支持**一个** `sshHost`，于是 DMDSC 上第二个节点永远不跑那三条只读命令 ——
 * 报告里"2 个节点"是 JDBC 采集数，OS 检查数却是 1，容易被读成"两个节点都查过了"。
 *
 * `sshHost` 现在可以是列表；**逐节点会不同的那几项**（`sshHostKey`、`dmrmanDcrIni`、
 * `sshLogDir`、`sshScriptPath`）支持**同序逗号列表** —— 真机上 `dmdcr.ini` 正是逐节点不同
 * （`…/data/DSC01/dmdcr.ini` vs `…/data/DSC02/dmdcr.ini`），不给逐节点值就只能靠共用一个。
 *
 * 仍然：`sshHost` / `sshUser` / `sshPassword` **三者缺一即视为「没配 OS 访问」**（保持纯 JDBC 只读）。
 */
function sshConfigOf({ args, cfg }) {
  const rawHost = args.sshHost ?? cfg.sshHost;
  const user = args.sshUser ?? cfg.sshUser;
  const password = args.sshPassword ?? cfg.sshPassword;
  if (!rawHost || !user || !password) return null;
  const hosts = parseSshHosts(rawHost);
  if (hosts.length === 0) return null;
  const notes = [];
  const n = hosts.length;
  const ports = alignList(args.sshPort ?? cfg.sshPort, n, 'sshPort', notes);
  const keys = alignList(args.sshHostKey ?? cfg.sshHostKey, n, 'sshHostKey', notes);
  const dcrs = alignList(args.dmrmanDcrIni ?? cfg.dmrmanDcrIni, n, 'dmrmanDcrIni', notes);
  const logDirs = alignList(args.sshLogDir ?? cfg.sshLogDir, n, 'sshLogDir', notes);
  const scripts = alignList(args.sshScriptPath ?? cfg.sshScriptPath, n, 'sshScriptPath', notes);
  return {
    nodes: hosts.map((h, i) => {
      const port = h.port ?? (ports[i] ? Number(ports[i]) : 22);
      return {
        // ⚠️ 标签里**只在非默认端口时**才带 `:port` —— 否则 `10.127.11.61:22` 很容易被读成
        //    "数据库端口 22"（同一份报告里还有 `host:7236` 这种数据库目标，两种 port 不能长得一样）。
        label: port === 22 ? h.host : `${h.host}:${port}`,
        host: h.host,
        port,
        hostKey: keys[i] ?? null,
        dcrIni: dcrs[i] ?? null,
        logDir: logDirs[i] ?? null,
        scriptPath: scripts[i] ?? null,
      };
    }),
    user,
    password,
    plinkPath: args.plinkPath ?? cfg.plinkPath ?? 'plink',
    timeoutMs: 180000,
    notes,
  };
}

/** 单个节点的 SSH 参数（`checkBackupsetViaSsh` 等只认这一层）。 */
const sshForNode = (ssh, node) => ({
  host: node.host,
  port: node.port,
  user: ssh.user,
  password: ssh.password,
  hostKey: node.hostKey,
  plinkPath: ssh.plinkPath,
  timeoutMs: ssh.timeoutMs,
});

/**
 * OS 级三项 → **结论项**与**结构化事实**（`backup` 与 `report` 共用同一份构造）。
 *
 * 为什么抽出来：这两个 action 都会跑同样的三条只读命令，而结论项 ID（`backup.os-check` /
 * `backup.os-logscan` / `backup.os-find`）是**稳定契约**。各写一套的话，同一个 ID
 * 在两处会慢慢长成两种语义 —— 正是本项目反复踩的坑。
 *
 * ★ 多节点（§38）：每个节点各出一条结论项；**单节点时 ID 不变**（`backup.os-check`），
 *   多节点时追加节点后缀（`backup.os-check.10-127-11-61-7236`）—— 因为"节点 62 的备份集校验"
 *   与"节点 61 的"是**两条不同的结论**，共用一个 ID 会让跨次对比失去意义。
 */
const osNodeSuffix = (label) => String(label ?? '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function osFindingsOf({ osCheck, osLogScan, osFind }) {
  const multi = (osCheck ?? osLogScan ?? osFind ?? []).length > 1;
  const out = [];
  const each = (kind, arr, mk) => {
    for (const r of arr ?? []) out.push(mk(r, multi ? ID.backup(`${kind}.${osNodeSuffix(r.label)}`) : ID.backup(kind)));
  };
  const tag = (r) => (multi ? `（${r.label}）` : '');
  each('os-check', osCheck, (o, id) =>
    finding(
      id,
      o.verdict.state === 'bad' ? 'crit' : o.verdict.state === 'unknown' ? 'warn' : 'info',
      `dmrman CHECK BACKUPSET（OS 级实测）${tag(o)}`,
      o.verdict.detail ?? '—',
      [`命令：${o.command}`],
      null,
      // 留痕：这条是**插件亲手在主机上跑出来的**（三条只读命令之一），不是调用方说的
      PROV.toolOs(o.command),
    ),
  );
  each('os-logscan', osLogScan, (o, id) =>
    finding(
      id,
      o.verdict.state === 'corrupt' ? 'crit' : o.verdict.state === 'unknown' ? 'warn' : 'info',
      // ★ §46：标题不再自称"全库裁决" —— 它是**两个日志来源的证据**，二者都非决定性
      `页面完整性证据（备份日志 + 实例日志）${tag(o)}`,
      o.verdict.detail ?? '—',
      [
        `命令：${o.command}`,
        `最坏一次损坏页数 = ${o.verdict.count ?? '—'}`,
        // 证据里也带上坐标 —— 结论项是要进 findings.json 的，别让人只能去正文里找
        ...((o.verdict.pageCheckErrors ?? []).length
          ? [`实例日志页校验失败 ${o.verdict.pageCheckErrors.length} 条：` +
            o.verdict.pageCheckErrors.slice(0, 5).map((e) => `(${e.tsId}, ${e.fileId}, ${e.pageNo})`).join('、')]
          : []),
      ],
      null,
      PROV.toolOs(o.command),
    ),
  );
  each('os-find', osFind, (o, id) =>
    finding(
      id,
      o.verdict.state === 'found' ? 'info' : 'warn',
      `磁盘上的备份文件（文件系统查找）${tag(o)}`,
      o.verdict.detail ?? '—',
      [`命令：${o.command}`],
      null,
      PROV.toolOs(o.command),
    ),
  );
  return out;
}

/**
 * OS 三项的**保守合并**（DESIGN §38）：
 *   · `check`：**全部 ok 才算 ok**；有一个 bad 就是 bad；其余 unknown
 *   · `logScan`：有一个 corrupt 就是 corrupt；**只要有节点给出了 clean 裁决就算 clean**
 *   · `logScanCount`：各节点取**最大**（任一处报告有损坏页，都是"这个库有坏页"的证据）
 *   · 另给 `anyOk` / `anyBad` —— `facts.backupVerified` 的语义是"**至少一份**经校验通过"，
 *     与上面的"保守合并"**不是同一个问法**，所以两个都留着，别让下游去猜。
 *
 * ★ `logScan` 这一条是**真机逼出来的**（2 节点 DMDSC）：全备只在**一个**节点上发起，
 *   `N corrupted pages during backup` 也只出现在那个节点的 `dm_BAKRES_*.log` 里；
 *   另一个节点的日志里 **"none found"**。第一版按"有一个 unknown 就整体 unknown"合并，
 *   于是"全库 0 坏页"这个**已经拿到的正面结论**被另一个节点拖成了"无法判定" ——
 *   **精度凭空倒退**。正确读法是：那条记录是**备份事件**的属性（谁跑的全备谁记），
 *   所以"任一节点给出了裁决"就足够下结论，**并同时披露是哪个节点给的、哪些节点没有记录**。
 */
function osAggregateOf({ osCheck, osLogScan }) {
  const st = (arr) => (arr ?? []).map((r) => r?.verdict?.state).filter(Boolean);
  const cs = st(osCheck);
  const ls = st(osLogScan);
  const counts = (osLogScan ?? []).map((r) => r?.verdict?.count).filter((x) => typeof x === 'number');
  const corruptNodes = (osLogScan ?? []).filter((r) => r.verdict.state === 'corrupt').map((r) => r.label);
  const cleanNodes = (osLogScan ?? []).filter((r) => r.verdict.state === 'clean').map((r) => r.label);
  const noRecordNodes = (osLogScan ?? [])
    .filter((r) => r.verdict.state !== 'clean' && r.verdict.state !== 'corrupt')
    .map((r) => r.label);
  return {
    check: cs.includes('bad') ? 'bad' : cs.length > 0 && cs.every((s) => s === 'ok') ? 'ok' : cs.length ? 'unknown' : null,
    logScan: corruptNodes.length > 0 ? 'corrupt' : cleanNodes.length > 0 ? 'clean' : ls.length ? 'unknown' : null,
    logScanCount: counts.length ? Math.max(...counts) : null,
    // 供报告正文披露："裁决是哪个节点给的、哪些节点没有记录"
    logScanFrom: corruptNodes.length > 0 ? corruptNodes : cleanNodes,
    logScanNoRecord: noRecordNodes,
    anyOk: cs.includes('ok'),
    anyBad: cs.includes('bad'),
    anyCorrupt: corruptNodes.length > 0,
  };
}

/** OS 小节标题后缀：**多节点时写明节点数**（§38 —— 否则读者会以为所有节点都查过了）。 */
const osTag = (list) => ((list ?? []).length > 1 ? `（${(list ?? []).length} 个节点）` : '');

/** OS 级三项的**机器可读**摘要（写进 `result.os`，供 JSON 消费者直接用；**按节点分列**）。 */
function osResultOf({ osCheck, osLogScan, osFind }) {
  const nodes = (osCheck ?? osLogScan ?? osFind ?? []).map((r) => r.label);
  const pick = (arr, label) => (arr ?? []).find((r) => r.label === label) ?? null;
  return {
    nodeCount: nodes.length,
    nodes: nodes.map((label) => {
      const c = pick(osCheck, label);
      const l = pick(osLogScan, label);
      const f = pick(osFind, label);
      return {
        label,
        check: c ? { command: c.command, state: c.verdict.state, target: c.target?.path ?? null, targetFrom: c.target?.from ?? null } : null,
        logScan: l ? { command: l.command, state: l.verdict.state, count: l.verdict.count } : null,
        find: f ? { command: f.command, state: f.verdict.state } : null,
      };
    }),
    aggregate: osAggregateOf({ osCheck, osLogScan }),
  };
}

/** 目录形态：去掉结尾斜杠，便于拼默认脚本路径。 */
const trimSlash = (p) => String(p ?? '').replace(/\/+$/, '');

/**
 * 挑出「这一次拿哪个目录去校验」。
 *
 * 三个来源**按可信度排序**，每一档都带 `from` 标记 —— 报告里要说清「这查的是哪一个、凭什么查它」：
 *
 * | 序 | 来源 | 为什么在这一档 |
 * | --- | --- | --- |
 * | ① | 库的账本（`V$BACKUPSET`） | 库自己认的备份，最权威 |
 * | ② | 磁盘上 `find` 找到的备份集 | **账本为空时唯一的准确线索**（`deriveBackupSets` 反推目录） |
 * | ③ | 调用方给的 `backupPath` | 兜底：ASM 路径、或 `find` 够不到（没给 `sshBackupDir`）时只剩它 |
 *
 * ★ ② 为什么排在 ③ 前面：`backupPath` 的文档只说「备份位置」，调用方给的多半是**上层目录**
 *   （真机实测给的是 `.../DAMENG/bak`，真正的备份集在它下面一层）。拿上层目录跑
 *   `CHECK BACKUPSET` 只会得到 `无效的备份集目录`，结论停在 `unknown` —— 而磁盘查找
 *   已经把准确的备份集目录算出来了，没有理由不用它。
 *
 * 三档都取不到 → 返回 `null`。**不猜路径**：拿一个来路不明的目录去撞，
 * 会把「本次没校验」变成「备份可能坏了」，那是更坏的结果。
 */
export function resolveCheckTarget({ backups, supplied, osFind }) {
  const fromCatalog = backups.find((b) => b.path) ?? backups[0];
  if (fromCatalog) return { path: fromCatalog.path || fromCatalog.name, from: 'catalog' };
  const onDisk = deriveBackupSets((osFind ?? []).flatMap((o) => o.verdict?.files ?? []));
  if (onDisk.length) return { path: onDisk[0], from: 'disk-find' };
  if (supplied?.normalized) return { path: supplied.normalized, from: 'supplied' };
  return null;
}

/**
 * 可选：通过 OS 访问在每个节点上跑一次 `dmrman CHECK BACKUPSET`。
 *
 * 未配置 SSH、**没有可校验的目标**、或参数不合法时返回 `null`（**静默跳过**）——
 * OS 访问是**增强项**，不该因为它没配就让 action 失败。
 * 但真去执行后失败（连不上、口令错、主机密钥未确认）**必须如实报出来**，不能吞。
 *
 * ★ 账本为空也要校验（原来不是这样）：早先这里写的是
 *   `const target = backups.find((b) => b.path) ?? backups[0]; if (!target) return null;`
 *   —— 于是**账本为空时整步被跳过**。而账本为空恰恰是**最需要**这一步的场景：
 *   磁盘上明明躺着备份文件（`find` 已经找到了），库却不认它，到底能不能用只有
 *   `CHECK BACKUPSET` 答得了。真机实测就是这么卡住的：报告把 10 个场景标成
 *   「需先 `dmrman CHECK BACKUPSET` 确认」却从没执行过，而手边已经有备份集路径。
 *   现在目标改为 `resolveCheckTarget()` 的三档兜底，账本为空时会退到磁盘上找到的那一份。
 *
 * ★ 多节点（§38）：返回**按节点的一条数组**；单节点时长度 1（行为与以前一致）。
 * ★ 并发（§42）：节点之间**互相独立**，所以 `Promise.all` 一起发。
 *   注意 `ossh.runRemote` 必须是**异步**的（它现在就是）—— 同步的 `spawnSync` 用 `Promise.all` 包不出并发。
 *
 * ⚠️ 调用时机：本函数依赖 `osFind` 的结果，所以它**必须排在磁盘查找之后**（见 `backup` action 里的说明）。
 */
async function runBackupsetCheck({ args, cfg, backups, supplied, osFind }) {
  const ssh = sshConfigOf({ args, cfg });
  if (!ssh) return null;
  const target = resolveCheckTarget({ backups, supplied, osFind });
  if (!target) return null;
  return Promise.all(
    ssh.nodes.map(async (node) => {
      const label = node.label;
      try {
        return {
          label,
          target,
          ...(await checkBackupsetViaSsh({
            backupPath: target.path,
            dmrmanPath: args.dmrmanPath ?? cfg.dmrmanPath ?? 'dmrman',
            // ★ DCR 配置：备份在 ASM 上时**必需**（否则 dmrman 只报 SBT[-127]，结论只能是"未取到"）。
            //   逐节点可不同（真机上 DSC01/DSC02 的 dmdcr.ini 路径就不一样）。
            dcrIni: node.dcrIni,
            ssh: sshForNode(ssh, node),
          })),
        };
      } catch (e) {
        // 参数校验阶段就抛了（例如备份路径含可疑字符）—— 如实报出，不吞
        return { label, target, command: '（未构造）', res: null, verdict: { state: 'unknown', detail: `未执行：${String(e?.message ?? e)}` } };
      }
    }),
  );
}

/**
 * 可选：通过 OS 访问在每个节点上跑一次日志扫描，取「**全库逐页裁决**」。
 *
 * 为什么值钱：`V$ERROR_PAGE` 只记录**被访问到**的坏页；而全量备份会读取每个数据文件的
 * **每一页**，所以备份日志里那行 `N corrupted pages during backup` 是**对整个库所有
 * 数据页的完整性裁决**，且零额外 IO。没配 `sshLogDir` 就完全不做。
 *
 * 多节点：**每个节点扫自己的日志目录**（各节点只记自己那一半的事件）—— 所以合成一份
 * 保守结论（任一节点报损坏 → 整体报损坏），逐节点明细留在 `result.os.nodes`。
 */
function runBackupLogScan({ args, cfg }) {
  const ssh = sshConfigOf({ args, cfg });
  if (!ssh) return null;
  if (!ssh.nodes.some((n) => n.logDir)) return null; // 一个节点的日志目录都没给 → 整体不做
  return Promise.all(
    ssh.nodes.map(async (node) => {
      const label = node.label;
      if (!node.logDir) {
        return {
          label,
          command: '（未执行）',
          res: null,
          verdict: { state: 'unknown', count: null, detail: `该节点没给日志目录 —— 本次未扫（多节点时可用逗号列表逐节点给 \`sshLogDir\`）` },
        };
      }
      const scriptPath = node.scriptPath ?? `${trimSlash(node.logDir)}/scan-backup-log.sh`;
      try {
        return { label, ...(await scanBackupLogViaSsh({ logDir: node.logDir, scriptPath, ssh: sshForNode(ssh, node) })) };
      } catch (e) {
        return { label, command: '（未构造）', res: null, verdict: { state: 'unknown', count: null, detail: `未执行：${String(e?.message ?? e)}` } };
      }
    }),
  );
}

/**
 * 可选：在每个节点的文件系统上找备份文件。
 *
 * **只在「已知路径不是 ASM」时才跑** —— ASM 不是文件系统，`find`/`ls` 看不到那几个文件，
 * 拿它去回答「备份是不是丢了」会得到一个反向的假结论（§11 与 README 都写过这一条）。
 * 返回 `null` = 不做（没配 OS 访问 / 没有可用的文件系统路径）。
 */
function runFindBackupsOnDisk({ args, cfg, backups, supplied, bakPathParam }) {
  const ssh = sshConfigOf({ args, cfg });
  if (!ssh) return null;
  // 「该去 find 哪个目录」的规则收在 `ossh.js` 的 `pickFindDir` 里（纯函数、可离线测）——
  // 它要跳过 ASM、并把「备份集目录」与「备份文件」区分开，猜错就会指错目录。
  const dir = pickFindDir([
    args.sshBackupDir ?? cfg.sshBackupDir,
    supplied?.kind === 'filesystem' ? supplied.normalized : null,
    ...backups.map((b) => b.path || b.name),
    // dm.ini 的 BAK_PATH：账本为空时，这是唯一已知的「备份该在哪」的线索。
    bakPathParam,
  ]);
  if (!dir) return null;
  return Promise.all(
    ssh.nodes.map(async (node) => {
      const label = node.label;
      try {
        return { label, ...(await findBackupsViaSsh({ backupDir: dir, ssh: sshForNode(ssh, node) })) };
      } catch (e) {
        return { label, command: '（未构造）', res: null, verdict: { state: 'unknown', files: [], paths: [], detail: `未执行：${String(e?.message ?? e)}` } };
      }
    }),
  );
}

const OS_STATE_LABEL = { ok: '✅ 校验通过 —— 备份集可读', bad: '❌ 校验失败 —— 备份集有问题', unknown: '❓ 无法判定' };

/** 校验目标是从哪儿来的（报告里要说清「这查的是哪一个、凭什么查它」）。 */
const CHECK_TARGET_SRC = {
  catalog: '库的账本 `V$BACKUPSET`',
  'disk-find': '磁盘上 `find` 找到的备份集',
  supplied: '调用方通过 `backupPath` 提供的备份位置',
};

/**
 * 渲染 OS 级备份校验结果（DESIGN §38：**入参是按节点的一条数组**）。
 * 单节点时与以前逐字一致；多节点时每个节点一个小节 —— 否则读者会以为"两个节点都查过了"。
 */
function renderOsCheck(list) {
  const L = [];
  L.push('## 备份可用性 —— OS 级实测');
  L.push('');
  for (const o of list ?? []) {
    if ((list ?? []).length > 1) {
      L.push(`### ${o.label}`);
      L.push('');
    }
    L.push(`**${OS_STATE_LABEL[o.verdict.state] ?? o.verdict.state}**`);
    L.push('');
    if (o.target) {
      L.push(`- 校验对象：\`${o.target.path}\`（来源：${CHECK_TARGET_SRC[o.target.from] ?? o.target.from}）`);
    }
    L.push(`- 执行的命令：\`${o.command ?? '（未执行）'}\``);
    L.push(`- 结论依据：${o.verdict.detail ?? '—'}`);
    L.push('');
  }
  L.push(
    '> 这是本插件离开 JDBC 的**三条只读命令之一**：在数据库主机上执行 `CHECK BACKUPSET`，' +
      '不恢复、不改任何配置。',
  );
  L.push('> `未知` 不等于通过 —— 连不上、口令错、主机密钥未确认都会落在这里。');
  if ((list ?? []).length > 1) {
    L.push('> 多节点上各查一次：它们在**同一份共享存储**上校验同一个备份集，所以结论应当一致；不一致本身就是线索。');
  }
  return L.join('\n');
}

const LOG_STATE_LABEL = {
  clean: '⚠️ 未发现坏页证据（但**不等于**「全库无坏页」—— 见下）',
  corrupt: '🚨 发现了坏页证据',
  unknown: '❓ 无法判定',
};

/**
 * 渲染「全库页完整性裁决」。
 *
 * ★ **这里同时看两个来源，且都不是决定性的**（DESIGN §46，实测）：
 *   · 备份日志的 `N corrupted pages during backup`（全备自己的页计数器）—— **会漏**：
 *     真机上把一页数据清零后做全备，它照样报 `0`，而读那一页直接把实例打停；
 *   · 实例日志的 `[EID:48] Server page check error! page:(…)` 与 `SHUTDOWN ABORT`
 *     —— 这是**在线唯一真的抓到过坏页**的证据。
 *
 * 所以措辞不能再说"这是全库裁决、正面答案"。要正面结论只有离线 `dmchk`（DM 自带）：
 * 它要求**停库**，插件不能替运维停库，只能给出命令与理由。
 *
 * 导出仅供离线断言：真机交付件里印出过字面的 `null 个损坏页`（`Number(null) === 0` 那个坑），
 * 只靠"读源码"的静态断言拦不住，得真渲染一遍才看得见。
 */
export function renderOsLogScan(list, agg = null) {
  const L = [];
  L.push('## 全库页完整性裁决 —— OS 级实测（日志扫描）');
  L.push('');
  const anyClean = (list ?? []).some((o) => o.verdict.state === 'clean');
  const anyUnknown = (list ?? []).some((o) => o.verdict.state === 'unknown');
  for (const o of list ?? []) {
    if ((list ?? []).length > 1) {
      L.push(`### ${o.label}`);
      L.push('');
    }
    L.push(`**${LOG_STATE_LABEL[o.verdict.state] ?? o.verdict.state}**`);
    L.push('');
    L.push(`- 执行的命令：\`${o.command ?? '（未执行）'}\``);
    L.push(`- 结论依据：${o.verdict.detail ?? '—'}`);
    // ★ §46：实例日志里的页校验失败事件 —— **坐标要摊开**（这是唯一能给出"哪一页"的在线证据）
    const evs = o.verdict.pageCheckErrors ?? [];
    if (evs.length > 0) {
      L.push(`- **页校验失败记录 ${evs.length} 条**（实例日志）：`);
      for (const e of evs.slice(0, 5)) {
        L.push(`  - 页 \`(${e.tsId}, ${e.fileId}, ${e.pageNo})\`（TS_ID, FILE_ID, PAGE_NO）`);
      }
      if (evs.length > 5) L.push(`  - ……另有 ${evs.length - 5} 条`);
      L.push(
        `  - 伴随 \`SHUTDOWN ABORT\`／\`dm_sys_halt\` **${o.verdict.abortCount ?? 0}** 次 ` +
          '—— 读到坏页会把**整个实例**打停，不是只让那条查询报错',
      );
    }
    // ⚠️ 这里原来写的是 `Number.isFinite(Number(o.verdict.count))` —— 而 `Number(null) === 0`
    //    且 `Number.isFinite(0) === true`，于是守着"没取到"的那道门形同虚设：
    //    真机交付件里 62 那一段直接印出了 **`null 个损坏页`**。改用 `toCount`（DESIGN §38.9）。
    const worst = toCount(o.verdict.count);
    if (worst !== null) {
      L.push(`- 最坏一次：**${worst}** 个损坏页（共 ${o.verdict.occurrences ?? '—'} 次记录）`);
    } else {
      // 没有这个数就**不说数**：空着会被读成"0 个坏页"，而那与"没查"是两件事。
      L.push('- 没有「最坏一次损坏页数」可报 —— 该节点日志里没有这条记录（**不等于** 0 个坏页）');
    }
    L.push('');
  }
  // ★ 多节点合并口径（§38）：那条记录是**备份事件**的属性 —— 谁跑的全备谁记。
  if ((list ?? []).length > 1 && agg) {
    L.push(
      `**本次结论取的是：${(agg.logScanFrom ?? []).join('、') || '（没有节点给出裁决）'}**` +
        (agg.logScan === 'clean' ? '（报告 0 坏页）' : agg.logScan === 'corrupt' ? '（报告存在损坏页）' : '') +
        (agg.logScanNoRecord?.length
          ? `。另有 **${agg.logScanNoRecord.join('、')}** 的日志里**没有**这条记录 —— ` +
            '全备只在其中一个节点上发起，`N corrupted pages during backup` 也只写在那个节点的 `dm_BAKRES_*.log` 里；' +
            '**「没有记录」不等于「没有坏页」**，但也**不该**把已经拿到的裁决拖成"无法判定"。'
          : '。'),
    );
    L.push('');
  }
  L.push(
    '> **这两个来源都不能给出「全库无坏页」的正面结论**（真机实测）：' +
      '备份日志那行 `N corrupted pages during backup` 是**全备自己的计数器** —— ' +
      '真机上把一页数据清零后做全备，它照样报 `0`；而实例日志只在**有人碰到过坏页**时才有记录（且日志会滚动）。',
  );
  L.push(
    '> **要正面结论，只能停库跑 DM 自带的离线体检**（插件**不会**替运维停库，所以这里只给命令）：\n' +
      '> ```\n' +
      '> dmdbchk path=<dm.ini 绝对路径> OUTPUT_FIL=/tmp/dbchk_err.txt PARALLEL=8\n' +
      '> ```\n' +
      '> 实测它会把坏页逐条写成 `page(TS_ID, FILE_ID, PAGE_NO) is broken`，' +
      '**并直接给出所属表名**（`table_name=…`）—— 这一点连本插件的对象反查都做不到（`DBA_EXTENTS` 可能没列全数据区，见下）。',
  );
  if (anyClean && (list ?? []).length > 0) {
    L.push('> 注意它的**时间边界**：它只覆盖「最近一次全备」那一刻；其后新产生的坏页不在其中。');
  }
  if (anyUnknown) {
    L.push('> `无法判定` **不等于**「没有问题」—— 也可能是从未做过全备、或日志已按月滚掉。');
  }
  if ((list ?? []).length > 1) {
    L.push('> 多节点分别扫**各自主机**的日志；DMDSC 上每个节点只记自己那一半的事件，所以**两边都要看**。');
  }
  L.push('> 只读：`sh scan-backup-log.sh <日志目录>`，脚本只匹配日志里的结构化标记，不做任何修改。');
  return L.join('\n');
}

const FIND_STATE_LABEL = {
  found: '✅ 磁盘上确实有疑似备份文件',
  none: '❓ 该目录下没有匹配到备份文件',
  unknown: '❓ 无法判定',
  'not-applicable': '— 不适用（该路径是 ASM，`find`/`ls` 看不到）',
};

/**
 * 正文小节拼装：**固定小节 + OS 级实测小节，统一连续编号**。
 *
 * 抽成函数只为能被离线断言（`smoke.mjs`）—— 编号出现空缺是那种
 * 「眼睛看不出来、但读报告的人会以为漏了一节」的缺陷。
 */
export function composeSections(fixed, os) {
  const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  return [...(fixed ?? []), ...(os ?? [])]
    .filter(Boolean)
    .map((s, i) => ({ title: `${CN[i] ?? `(${i + 1})`}、${s.title}`, body: s.body }));
}

/** 渲染「文件系统上实际有哪些备份文件」（入参同样是按节点的一条数组，§38）。 */
function renderOsFind(list) {
  const L = [];
  L.push('## 磁盘上的备份文件 —— OS 级实测（文件系统查找）');
  L.push('');
  for (const o of list ?? []) {
    if ((list ?? []).length > 1) {
      L.push(`### ${o.label}`);
      L.push('');
    }
    L.push(`**${FIND_STATE_LABEL[o.verdict.state] ?? o.verdict.state}**`);
    L.push('');
    L.push(`- 执行的命令：\`${o.command ?? '（未执行）'}\``);
    L.push(`- 结论依据：${o.verdict.detail ?? '—'}`);
    for (const f of o.verdict.files ?? []) L.push(`- \`${f}\``);
    L.push('');
  }
  L.push('> 这一步**只回答「文件在不在」**，不回答「备份能不能用」—— 后者只有 `CHECK BACKUPSET` 能给。');
  L.push('> 反过来也要说清：这里是 `find`/`ls` 的视野，**ASM 上的备份它本来就看不见**，所以找不到不等于丢了。');
  return L.join('\n');
}

/** 归档空间参数检查渲染。 */
function renderArchiveParams(chk) {
  const L = [];
  L.push('');
  L.push('| 参数 | 位置 | 当前值 | 状态 | 含义 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const it of chk.items) {
    L.push(`| ${it.name} | ${it.where} | ${it.value ?? '—'} | ${it.set ? '已设' : '未设'} | ${it.meaning} |`);
  }
  L.push('');
  L.push('归档目标的空间上限（**这个参数在 dmarch.ini，不在 dm.ini**）：');
  L.push('');
  for (const d of chk.destinations) {
    // ARCH_SPACE_LIMIT ÷ ARCH_FILE_SIZE：**两个数都是实测的**，商就是「能保留几个归档文件」，
    // 不需要任何速率假设。单实例实测：2048 MB ÷ 1024 MB = 2 个 —— 回溯窗口极短。
    const retainN =
      d.fileSizeMB && d.spaceLimit && d.spaceLimit > 0 ? Math.floor(d.spaceLimit / d.fileSizeMB) : null;
    L.push(
      `- ${d.name}（${d.type} → ${d.dest}）单文件 ${d.fileSizeMB ?? '?'} MB，` +
        `空间上限 ${d.spaceLimit === 0 ? '**0（不限制）**' : d.spaceLimit} MB，有效 ${d.valid}` +
        (retainN !== null ? `，**约可保留 ${retainN} 个归档文件**` : '') +
        (d.destIp ? `，对端地址 \`${d.destIp}${d.destPort ? ':' + d.destPort : ''}\`` : ''),
    );
    if (d.hangFlag !== null && d.hangFlag !== undefined) {
      L.push(`  - \`ARCH_HANG_FLAG\` = **${d.hangFlag}**（ARCH_RESERVE_TIME = ${d.reserveTime ?? '—'}）`);
    }
  }

  // ---- ARCH_HANG_FLAG 解读（依据达梦官方《配置文件说明》5.3 dmarch.ini）----
  // 它定义的是「**本地归档写入失败时**」的行为，而归档空间上限触顶正是一种写入失败。
  // 所以 `ARCH_SPACE_LIMIT` 的超限语义**不再需要猜** —— 读这个参数即可判定。
  const locals = chk.destinations.filter((d) => String(d.type ?? '').toUpperCase() === 'LOCAL');
  const HANG = {
    0: '**不挂起，直接报错返回、不再尝试写入** —— 归档会**缺失**，而库继续跑（最隐蔽的一种）',
    1: '**挂起**，反复尝试写入直到成功 —— 不会丢归档，但**数据库会卡住**',
    2: '**先删除最老的归档文件**再重试，直到成功或归档被删光 —— 即**循环覆盖**语义',
  };
  if (locals.length > 0) {
    L.push('');
    L.push('### `ARCH_HANG_FLAG` 解读 —— 它决定 `ARCH_SPACE_LIMIT` 触顶时会发生什么');
    L.push('');
    for (const d of locals) {
      const v = Number(d.hangFlag);
      L.push(`- ${d.name}：**${d.hangFlag}** —— ${HANG[v] ?? '取值不在官方文档定义的 0~2 范围内'}`);
    }
    L.push('');
    L.push(
      '> 因此本库 `ARCH_SPACE_LIMIT` 的语义是**可判定的**，不再是未知量：' +
        '值为 2 时上限即回溯窗口；值为 1 时上限只是把「磁盘满挂起」提前、**并未解决问题**；' +
        '值为 0 时归档会静默缺失。',
    );
    const vals = locals.map((d) => Number(d.hangFlag));
    if (vals.every((v) => v !== 1)) {
      L.push('');
      L.push(
        '🚨 **所有本地归档的 `ARCH_HANG_FLAG` 都不是 1。** 官方文档明确指出这种情况下' +
          '「写入归档失败后**可能会出现归档日志缺失**，进而可能产生特定情况下' +
          '**备份还原无法正常进行**等问题」。请优先评估是否改为 1（代价是归档写入失败时数据库会挂起）。',
      );
    }
  }

  // 「上限已设、但空间检查没开」这个组合，会让「上限到底会不会被执行」变得存疑。
  const checkInt = chk.items.find((x) => x.name === 'ARCH_SPACE_CHECK_INTERVAL')?.value;
  const hasLimit = chk.destinations.some((d) => d.spaceLimit > 0);
  if (hasLimit && Number(checkInt) === 0) {
    L.push('');
    L.push(
      '⚠️ **上限已设，但空间告警未开**：`ARCH_SPACE_CHECK_INTERVAL = 0`。' +
        '按官方文档，它与 `ARCH_SPACE_FREE_THRESHOLD` 的作用只是' +
        '「检查到剩余空间低于阈值时**打印警告日志**」，**并不控制上限是否生效**。' +
        '所以这里缺的不是保护，而是**预警** —— 磁盘真要写满时，你会直接从「没事」跳到' +
        '`ARCH_HANG_FLAG` 所定义的行为（本库为**挂起**），中间没有任何告警。',
    );
  }
  L.push('');
  L.push(chk.summary);
  return L.join('\n');
}

/** 归档容量推荐渲染。 */
function renderArchiveRec(rec, growth) {
  const L = [];
  L.push('');
  L.push(growth?.skipped ? '## 速率 —— 本 action 不测算' : '## 增长速率');
  if (!growth?.ok) {
    L.push(growth?.skipped ? `**不测算速率**：${growth.reason}` : `**无法测算**：${growth?.reason ?? '未知原因'}`);
    // ★ 不再直接 return。原先这里一返，连「推荐值」整节都跳过了 ——
    //   而其中两项**根本不依赖速率**。门禁是反的：恰恰在测不出速率的系统上最需要它们。
    L.push('');
    L.push(
      growth?.skipped
        ? '> 这是**有意的设计**，不是失败。下面的建议全部只用到磁盘容量或固定值，**不需要任何速率假设**。'
        : '> 速率测不出来**不影响下面两项** —— 它们只用到磁盘容量，不需要任何速率假设。',
    );
  } else {
    L.push(`采样 ${growth.totalHours.toFixed(2)} 小时，新建归档文件 ${growth.totalCreated} 个，合计 ${growth.totalMB} MB`);
    L.push(`- **平均速率 ≈ ${growth.avgMBPerHour.toFixed(1)} MB/小时**（只作对照，不建议用它定值）`);
    L.push(`- **观测峰值 ≈ ${growth.peakMBPerHour.toFixed(1)} MB/小时**（仅代表**上一段窗口**）`);
  }
  const recs = rec.recommendations ?? {};
  if (Object.keys(recs).length === 0) {
    L.push('');
    L.push('**不给任何推荐值** —— 拿一个默认值去算，比不算更危险：它会让人以为算过了。');
    return L.join('\n');
  }
  L.push('');
  L.push('## 推荐值');
  for (const [name, r] of Object.entries(recs)) {
    L.push(`- **${name} = ${r.value ?? '（不给数值）'}**${r.perDestination ? '（每个归档目标）' : ''}`);
    L.push(`  ${r.why}`);
    if (r.caveat) L.push(`  ${r.caveat}`);
  }
  for (const n of rec.notes ?? []) L.push(`- ${n}`);
  return L.join('\n');
}

/** 逐页分诊渲染：定位到对象 + 唯一推荐处置路径。
 *  ⚠️ **免责与提示不在这里输出** —— 它们归「边界与免责」层（DESIGN §24），
 *     放在这里会和那一层重复（真机验证时看到同一段话出现两遍）。 */
function renderTriage(list, enriched, tsMap) {
  const L = [];
  if (list.entries.length === 0) {
    L.push('未发现坏页记录，无需逐页分诊。');
    return L.join('\n');
  }
  for (const e of enriched) {
    L.push('');
    L.push(`页 ${e.page}   ${e.statusText}`);
    L.push(`  表空间 ${tsMap[String(e.tsId)] ?? '—'}（TS_ID=${e.tsId}）  文件 ${e.fileName ?? '—'}`);
    L.push(
      `  最近报错 ${fmtT(e.lastError)} / 最近修复 ${fmtT(e.lastRepair)}（报错 ${e.errorCount} 次，修复 ${e.repairCount} 次）`,
    );
    if (e.object) {
      L.push(`  所属对象 ${e.object.owner}.${e.object.segmentName}（${e.object.segmentType}）`);
      L.push(`  区位置 BLOCK_ID=${e.object.blockId} BLOCKS=${e.object.blocks}`);
    } else {
      L.push(`  所属对象 未定位：${e.objectNote}`);
    }
    for (const s of e.skips) {
      L.push(`  受影响语句：会话 ${s.sessId} / 语句 ${s.stmtId} / 第 ${s.execId} 次执行 / 共跳 ${s.nTotal} 页`);
    }
  }
  L.push('');
  L.push('ℹ️ 处置路径请用 action=readiness 获取（能否在线修 / 能恢复到什么程度）。');
  return L.join('\n');
}

const fmtLsn = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

/**
 * 归档链逐段核对渲染（DESIGN §22）。
 *
 * 这一段存在的理由：上面那段「两端对齐」是**必要条件**，中间断了它看不出来，
 * 而「能不能恢复到某个点」恰恰取决于**中间有没有洞**。
 */
/**
 * 时间 ↔ LSN 锚点与夹逼渲染（DESIGN §23、§35）。
 *
 * 用户问「能不能把恢复到的 LSN 与时间点对应起来」。§35 已把服务端那一层探清：
 * **`DBMS_LOGMNR` 存在，且 `V$LOGMNR_PARAMETERS` 里同时有 `START_DATE/END_DATE` 与
 * `START_SCN/END_SCN`** —— 服务端确实能换算，但只能通过 `dbms_logmnr.start_logmnr()`
 * （包过程，不是 SELECT），而本插件的桥只放行 SELECT/WITH，所以**刻意不做**。
 * 于是这里一律走**夹逼**：严格下界 + 依赖前提的上界，两者分开标注。
 */
export function renderTimeLsn(tl) {
  const L = [];
  L.push('**时间 ↔ LSN 对应（夹逼）**');
  L.push('');
  if (!tl || tl.count < 2) {
    L.push(`❓ ${tl?.note ?? '没有锚点'}`);
    L.push('');
    L.push(
      '> 锚点来自四个来源：**`V$RLOG_HISTORY` 的 `(RECORD_TIME, CUR_LSN)`**（有行时最密 —— ' +
        '但它是**观测历史**，有保留窗口，**本次取到几行就几行**）、归档文件的 `(CREATE_TIME, ARCH_LSN)`、' +
        '备份的 `(BACKUP_TIME, BEGIN/END_LSN)`、以及每次运行时采到的 `(SYSDATE, V$RLOG.CUR_LSN)`。' +
        '**至少两个不同时刻的锚点才能夹逼。**',
    );
    return L;
  }
  L.push(tl.note);
  L.push('');
  // 锚点可能很多（`V$RLOG_HISTORY` 分钟级），只列**最近**的若干条，不把报告淹掉
  const MAXROW = 12;
  const anchorRows = tl.anchors.slice(-MAXROW);
  L.push(`| # | 观测时刻 | LSN | 来源 | 能否用于「上界」 |`);
  L.push('| --- | --- | --- | --- | --- |');
  anchorRows.forEach((a, i) => {
    L.push(
      `| ${tl.anchors.length - anchorRows.length + i + 1} | ${a.time} | ${a.lsn} | ${a.source} | ${a.tight ? '✅' : '❌ 只做严格下界'} |`,
    );
  });
  if (tl.anchors.length > anchorRows.length) {
    L.push('');
    L.push(`（锚点共 ${tl.anchors.length} 个，上表只列**最近 ${MAXROW}** 个；来源：${Object.entries(tl.sourceCounts ?? {}).map(([k, v]) => `${k} ${v}`).join('、')}）`);
  }
  L.push('');
  L.push('**目标时刻 → LSN 区间**（按锚点时刻分段，段内结论相同）：');
  L.push('');
  L.push('| 时刻区间（左闭右开） | 对应 LSN 区间 | 区间宽度 |');
  L.push('| --- | --- | --- |');
  const allSegs = bracketTable(tl.anchors);
  const segs = allSegs.slice(-MAXROW);
  if (allSegs.length > segs.length) {
    L.push(`| …（更早的 ${allSegs.length - segs.length} 段已省略） | | |`);
  }
  for (const r of segs) {
    const to = r.toTime ?? '现在';
    const span = r.practicalUpperLsn === null ? `> ${r.strictLowerLsn ?? '—'}（只能给下界）` : `${r.strictLowerLsn} → ${r.practicalUpperLsn}`;
    L.push(`| [${r.fromTime} , ${to}) | ${span} | ${r.widthLsn ?? '—'} |`);
  }
  L.push('');
  L.push('**反向：LSN → 时刻区间**');
  L.push('');
  L.push('| LSN | 不晚于（严格结论） | 不早于（依赖前提） |');
  L.push('| --- | --- | --- |');
  for (const a of anchorRows) {
    const t = timeForLsn(tl.anchors, a.lsn);
    L.push(`| ${a.lsn} | ${t.strictUpperTime ?? '—'} | ${t.practicalLowerTime ?? '—'} |`);
  }
  L.push('');
  L.push(
    '> **两端不是同一性质，必须分开看**（`backup.js` 的 `assessTimeLsnAnchors`）：\n' +
      '> · 下界 / 上界（严格）是**逻辑结论**：`LSN 先被生成、后才可能被观测到` ⇒ `t(A) ≤ S`。' +
      '所以「某时刻之前的锚点 LSN」一定小于该时刻的 LSN。\n' +
      '> · 另一半要求**观测时刻 ≈ LSN 生成时刻**。这个前提**因来源而异**：归档文件与当前前沿' +
      '（`ARCH_LSN`/`CUR_LSN`）几乎即时；而备份的 `BACKUP_TIME` 是**完成**时刻，' +
      '`BEGIN_LSN` 早在备份开始时就生成了（实测那次备份跑了 31 秒）—— 所以**备份锚点只做严格下界**。\n' +
      '> · 本插件会**自查**这个前提：一旦出现「下界 > 上界」，就丢掉依赖前提的那一半并说明。',
  );
  if (tl.premiseViolated) {
    L.push('>');
    L.push('> ⚠️ 本次**自查发现冲突**：部分区间已降级为「只给严格下界」。');
  }
  L.push('>');
  L.push(
    // ⚠️ 这里**不再重复**上面 note 里的那两个间距数字（同一节里说两遍 = 报告变胖、且两处会走样）。
    //    上面那条 note 是"本次实测值"，这一段只讲**机制**：精度随锚点密度变，别拿全局最小值当结论。
    '> ⚠️ **精度由锚点密度决定**（上面那条 note 里的两个间距就是本次实测值）——' +
      '**任意时刻的精度取它落在哪一段，而不是取全局最小值**。各来源的精度与含金量：\n' +
      '> · 最密的来源通常是 `V$RLOG_HISTORY`（观测历史，≈ 采样间隔），但它**有保留窗口**：' +
      `本次只取到 **${tl.rlogRows ?? 0} 行**（真机上单实例见过 ~72 行/≈1 小时，DMDSC 节点刚重启时只有 1 行）。` +
      '所以"最密来源"每次都不同，**报告里写的是本次实测值**。\n' +
      '> · 窗口之外只能靠归档文件锚点，而它的精度 = **一个归档文件的跨度**（低负载库的文件横跨几十小时）。' +
      '每个**已关闭**的归档文件贡献**两个**锚点（`CREATE_TIME`+`ARCH_LSN` 与 `CLOSE_TIME`+`CLSN`）；' +
      '正在写的那个（`STATUS=ACTIVE`）**只算「开」** —— 它的 `CLOSE_TIME` 实测等于 `CREATE_TIME`、`CLSN` 是移动末端，' +
      '配成对会**伪造**一个偏差达数万 LSN 的观测。\n' +
      '> · **闪回事务锚点**（`V$FLASHBACK_TRX_INFO` 的 `(COMMIT_TIMESTAMP, COMMIT_LSN)`，每事务一对、最密）：' +
      `本次取到 **${tl.flashbackCount ?? 0} 条**` +
      (tl.flashbackCount ? '，已计入上面的密度。' : ' —— 该视图为空（本库未开启闪回），**不是"没有对应关系"**；开了会更密。') +
      '\n> · 想把窗口外也变准：把 `ARCH_FILE_SIZE` 调小（归档切换更频繁 ⇒ 锚点更密），' +
      '或让插件**定期跑**（每次采一帧 `(SYSDATE, CUR_LSN)` 留存，就补出一段自己的锚点历史）。\n' +
      '> · **服务端确实有换算入口，但本插件刻意不用**：`DBMS_LOGMNR` + `V$LOGMNR_PARAMETERS`' +
      '（同时有 `START_DATE/END_DATE` 与 `START_SCN/END_SCN`）就是那张映射，' +
      '但它要 `dbms_logmnr.start_logmnr()`（**包过程，不是 SELECT**）—— 本插件的桥只放行 `SELECT / WITH`。' +
      '需要事务级精确对应时请手工用它（那属运维动作）。',
  );
  return L;
}

export function renderArchiveChain(chain) {
  const L = [];
  L.push('**归档链逐段核对（强判据）**');
  L.push('');
  if (chain.verdict === 'unknown') {
    L.push(`❓ ${chain.note}`);
    return L;
  }
  L.push(
    chain.verdict === 'continuous'
      ? '✅ **并集无洞** —— 实测到的归档区间拼起来是连续的。'
      : `🚨 **并集里有 ${chain.holes.length} 处洞** —— 恢复到这些 LSN 区间时会断。`,
  );
  L.push('');
  L.push(
    `- 归档序列：**${chain.series.length}** 个（按「目录 + 归档目标名 + 节点」分开）、文件 ${chain.fileCount} 个；` +
      `并集覆盖 LSN ${fmtLsn(chain.coveredFrom)} → ${fmtLsn(chain.coveredTo)}`,
  );
  if (chain.unarchivedLsn !== null) {
    L.push(
      chain.unarchivedLsn > 0
        ? `- **未归档尾部**：${chain.unarchivedLsn}（LSN 计）—— 这段还在**联机日志**里，尚未进归档。` +
            '它不影响「恢复到当前」，但**联机日志损坏或要异机恢复时，这一段就是缺口**。'
        : '- 未归档尾部：0 —— 归档已追平当前 LSN。',
    );
  }
  if (chain.oldestCreateTime) {
    L.push(
      `- **可回溯窗口（时间）**：最早一个归档文件创建于 \`${chain.oldestCreateTime}\` —— ` +
        '这是「能回到多久之前」的实测起点。',
    );
  }
  L.push('');
  L.push('| 归档目录 | 归档目标 | 节点 | 文件数 | 覆盖 LSN | 序列内断档 |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const s of chain.series) {
    const brk = s.breaks.length === 0 ? '无' : `${s.breaks.length} 处`;
    L.push(`| \`${s.dir}\` | ${s.target} | ${s.node} | ${s.count} | ${s.fromLsn} → ${s.toLsn} | ${brk} |`);
  }
  L.push('');
  if (chain.byDir.length > 1) {
    L.push('**单目录自足性**（只保留某一个归档目录时还缺多少）：');
    L.push('');
    for (const d of chain.byDir) {
      L.push(
        `- \`${d.dir}\`（${d.targets.join(' + ')}）：${d.selfSufficient ? '**单独即自足**' : `缺失 **${d.holes.length}** 段`}`,
      );
    }
    if (chain.byDir.some((d) => !d.selfSufficient)) {
      const notSelf = chain.byDir.filter((d) => !d.selfSufficient);
      L.push('');
      L.push(
        notSelf.length === chain.byDir.length
          ? '> ⚠️ 这几个目录**各自都不自足**是交叉配置的**正常形态**（每个序列只含一部分 LSN 区间），' +
              '恢复时要用各节点的归档目录**一起**。反过来说：**少保留任何一个节点的归档目录，就会缺一段。**'
          : `> ⚠️ 有 **${notSelf.length}** 个目录**单独不足以**恢复（见上表）：` +
              '恢复时要把各目录**一起**用。反过来说：**少保留其中任何一个，就会缺一段。**',
      );
    } else if (chain.byDir.length > 1) {
      L.push('');
      L.push('> ✅ 每个目录单独都自足 —— 任一份归档副本都足以恢复（这比"各自都不自足"更强的容错）。');
    }
    L.push('');
  }
  L.push('');
  L.push('判据与已知边界（都来自真机夹具，不是推理）：');
  L.push('');
  L.push(
    '- 相邻判据是 `next.ARCH_LSN === prev.CLSN + 1`，**不是 `NEXT_SEQ` 递增** —— ' +
      '真机单实例上 `NEXT_SEQ` 从 136616 跳到 136641（一个归档文件内含多个 redo 序列号），拿它判档会**误报**。',
  );
  L.push(
    '- **多序列环境下，序列内有断档属正常**（各序列只含一部分 LSN 区间），判定看**并集**；' +
      '单实例（单序列）上序列内有洞才是**真断档**。',
  );
  L.push(
    '- 上面「可回溯窗口」的时间来自归档文件的 `CREATE_TIME`，**精度 = 一个归档文件的跨度**' +
      '（低负载库一个文件能横跨几十小时 —— 单实例上实测过 41 小时）。所以本插件**不承诺精确到秒的 PITR**；' +
      // ⚠️ 原来写的是「见**上一节**」—— 而「时间 ↔ LSN」紧随本节**之后**（先归档链、后夹逼）。
      //    报告里的指路话指错方向比不写更坏：读者会往回翻，然后以为那节不存在。
      '本次实测的夹逼精度见**紧随其后**的「时间 ↔ LSN 对应（夹逼）」。',
  );
  return L;
}

// ★ 这一段原来是「恢复需求达成度渲染」（`renderRequirements` + `REQ_TARGET_IDS`），
//   2026-10-13 按用户决定**整项移除**（DESIGN §29.10）：报告里不再有「恢复需求达成度」这一节，
//   参数 `rpoMinutes` / `targetTime` / `targetWindow`、`req.*` 命名空间、
//   以及 §32 的「先决条件」行也一并删除，`lib/requirements.js` 整个模块不复存在。
//   本节剩下的内容（归档链、时间↔LSN 夹逼、备份可用性）**不变** —— 它们回答的是
//   "这套库能恢复到哪一点"，那是客观事实，不依赖调用方填什么需求值。

/**
 * 备份可用性渲染。
 *
 * 这份输出里每一个判断都必须能追到一个实测值或调用方的输入；
 * **不能自动得到的，就明确写成「请运维执行 X」**，不写含糊话。
 */
function renderBackup({ backups, cov, rel, supplied, pages, osAccess = false, chain = null, anchors = null }) {
  const L = [];
  L.push('');

  // ---- 一、账本 ----
  L.push('## 一、库的账本里有什么（V$BACKUPSET）');
  L.push('');
  if (backups.length === 0) {
    L.push('**账本为空：没查到任何备份记录。**');
    L.push('');
    L.push('这**不等于没有备份** —— 账本只反映当前控制文件记得的备份集。');
    L.push('若确认库外存在备份，用 `backupPath` 参数把位置交给本插件核对，');
    L.push('或在数据库主机上用 `dmrman` 直接校验（见第三节）。');
  } else {
    L.push('| # | 备份名 | 完成时间 | 类型 | 起 LSN | 止 LSN | 设备 | 数据文件 | 分片 |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    backups.forEach((b, i) => {
      const kind = b.isFull ? '完全备份' : `type=${b.type} level=${b.level}`;
      const hint = !b.isFull && b.nameHint ? `（名含 ${b.nameHint}）` : '';
      L.push(
        `| ${i + 1} | ${b.name} | ${fmtStamp(b.time)} | ${kind}${hint} | ${fmtLsn(b.beginLsn)} | ${fmtLsn(b.endLsn)} | ` +
          `${b.device} | ${b.dbfNum ?? '—'} | ${b.bkpNum ?? '—'} |`,
      );
    });
    L.push('');
    const nf = backups.filter((b) => b.isFull).length;
    L.push(`共 ${backups.length} 条：完全备份 ${nf} 条、其它 ${backups.length - nf} 条。`);
    L.push('');
    L.push('路径：');
    for (const b of backups) L.push(`- ${b.name} → \`${b.path || '（账本未给路径）'}\``);
    L.push('');
    L.push('> `isFull` 的判据是 `TYPE=0 且 LEVEL=0`；这是实测标定（一次 `backup database;` 得到该取值），');
    L.push('> 其它取值未在本环境验证，故按原始数字展示，不替它编含义。');
  }
  L.push('');

  // ---- 二、能恢复到哪一点 ----
  L.push('## 二、能恢复到哪一点');
  L.push('');
  if (!cov.newest) {
    L.push('无备份记录，无法给出恢复可达点。');
  } else {
    const b = cov.newest;
    L.push(`最近一次备份：**${b.name}**，完成于 ${fmtStamp(b.time)}。`);
    L.push('');
    L.push(`- 该备份覆盖到 LSN **${fmtLsn(b.endLsn)}**；当前 V$RLOG.CUR_LSN = **${fmtLsn(cov.needTo)}**。`);
    if (cov.redoGap !== null) {
      L.push(`- 两者之差 **${cov.redoGap}** —— 要把库恢复到「当前」这一点，`);
      L.push(`  必须用归档补齐 ${fmtLsn(cov.needFrom)} → ${fmtLsn(cov.needTo)} 这段 redo。`);
    }
    L.push('');
    L.push('归档覆盖（**仅两端**：最早 `ARCH_LSN` / 最晚 `CLSN`）：');
    L.push('');
    L.push(`- 归档文件数：${cov.span.count}`);
    L.push(`- 最早 ARCH_LSN：${fmtLsn(cov.span.oldestArchLsn)}`);
    L.push(`- 最晚 CLSN：${fmtLsn(cov.span.latestClsn)}`);
    L.push('');
    if (cov.covered === true) {
      L.push('✅ 两端**对得上**：最早归档早于备份结束点、最晚归档已越过当前 LSN。');
      L.push('   ⚠️ 但这是**必要条件**，不是结论 —— **中间有没有洞它看不出来**，见下面的逐段核对。');
    } else if (cov.covered === false) {
      L.push('⚠️ **归档未覆盖缺口**：按实测两端判断，归档接不上备份结束点到当前 LSN 这段。');
      L.push('   这种情况下只能恢复到备份结束点（会丢掉其后的改动），请核实归档是否被清理过。');
    } else {
      L.push('❓ **无法确认**：`ARCH_LSN` 或 `CLSN` 有缺失（可能归档为空、或该文件尚未关闭）。');
      L.push('   本插件**不给猜测结论** —— 请人工核对归档目录的完整性。');
    }
    L.push('');
    L.push('> 刻意没有使用 `V$ARCH_FILE.FREE`：实测它在归档推进过程中是**增大**的，语义未验证，');
    L.push('> 拿它当「剩余/进度」会得到反向结论。');
    if (chain) {
      L.push('');
      L.push(...renderArchiveChain(chain));
    }
    if (anchors) {
      L.push('');
      L.push(...renderTimeLsn(anchors));
    }
  }
  L.push('');

  // ---- 三、备份本身可不可信 ----
  L.push('## 三、备份本身可不可信（本节最要紧）');
  L.push('');
  L.push('`V$BACKUPSET` 是**库自己的账本**，只能证明「库认为这个备份集存在」，');
  L.push('**不能证明备份文件可读、完好**。');
  if (osAccess) {
    L.push('');
    L.push(
      '已启用 OS 访问（**只读**）：插件会在数据库主机上执行 `dmrman CHECK BACKUPSET` 与随附的日志扫描脚本，' +
        // ⚠️ 原来写的是「见本节之后的小节」—— OS 那两节在**正文、附录之前**，说"之后"是**反的**。
        //    指路话指错方向比不写更坏：读者会往附录后面找，然后以为没写。
        '实测结论见**正文**的「备份可用性 —— OS 级实测」与「全库页完整性裁决 —— OS 级实测（日志扫描）」两节。' +
        '本节只讲**库内 JDBC 侧**的账本与覆盖度。',
    );
  } else {
    L.push('');
    L.push(
      '本插件**默认没有 OS 访问**（纯 JDBC 只读），所以既读不到服务器日志、也跑不了 dmrman —— ' +
        '下面两步请运维在**数据库主机**上执行。',
    );
    L.push('（也可以用 `sshHost`/`sshUser`/`sshPassword` 让插件自己跑这两步，它只执行**只读**命令；见 README。）');
  }
  L.push('');
  L.push('**第 1 步：真正校验备份集（唯一权威手段）**');
  L.push('');
  if (backups.length > 0) {
    L.push('```');
    L.push(dmrmanCheckCommand(backups[0].path || backups[0].name));
    L.push('```');
  } else {
    L.push('```');
    L.push(dmrmanCheckCommand(supplied?.normalized || '<备份集路径>'));
    L.push('```');
  }
  L.push('');
  L.push('**第 2 步：从日志里取页面完整性证据**');
  L.push('');
  if (osAccess) {
    // ★ §40 去重：这一段的"为什么这行最重要"与正文「全库页完整性裁决」那节**逐句重复**。
    //   结论在哪节、解释就放哪节 —— 这里只留**手工复核**要用的东西（行格式 + 命令 + 一个引路）。
    L.push(
      '（已启用 OS 访问：插件本次**已自己跑过**这一步，结论与完整解释见正文「全库页完整性裁决 —— OS 级实测（日志扫描）」。' +
        '下面留作**手工复核**用。）',
    );
    L.push('');
  } else {
    L.push('全量备份会读取每个数据文件的**每一页**，所以备份日志里留有一行：');
    L.push('');
  }
  L.push('```');
  L.push('0 corrupted pages during backup      ← 或 N corrupted pages during backup');
  L.push('```');
  L.push('');
  if (!osAccess) {
    // 没有 OS 访问时这里是**唯一**讲得清这件事的地方，所以解释留全
    L.push('⚠️ **但这一行不足以回答「有没有坏页」**（真机实测）：它只是**全备自己的计数器** ——');
    L.push('把一页数据清零后再做全备，它照样报 `0`，而读那一页会把整个实例打停。');
    L.push('真正抓到过坏页的**在线**证据是**实例日志**里的这两行（同一个脚本会一并取回）：');
    L.push('');
    L.push('```');
    L.push('[EID:48]Server page check error! page:(4, 0, 73000) ... dump page to ../log/dm_BINARY_*.log');
    L.push('[EID:316]SYSTEM SHUTDOWN ABORT     [EID:617]dm_sys_halt now!!!');
    L.push('```');
    L.push('');
    L.push('**要正面结论只能停库跑 DM 自带的离线体检**（插件不会替运维停库，只给命令）：');
    L.push('');
    L.push('```');
    L.push('dmdbchk path=<dm.ini 绝对路径> OUTPUT_FIL=/tmp/dbchk_err.txt PARALLEL=8');
    L.push('```');
    L.push('');
    L.push('实测它会把坏页写成 `page(TS_ID, FILE_ID, PAGE_NO) is broken`，**并直接给出所属表名**。');
    L.push('');
  }
  L.push('在数据库主机上取这两类证据（脚本随插件提供，纯 ASCII，可直接 scp 过去跑 —— **每个节点都要放一份**）：');
  L.push('');
  L.push('```');
  L.push('sh scan-backup-log.sh /home/dmdba/dmdbms/log');
  L.push('```');
  L.push('');
  L.push('若不跑脚本，也可以分别抓：');
  L.push('');
  L.push('```');
  L.push('grep -hE "[0-9]+ corrupted pages during backup" /home/dmdba/dmdbms/log/dm_BAKRES_*.log');
  L.push('grep -hE "\\[EID:48\\]|SHUTDOWN ABORT"            /home/dmdba/dmdbms/log/dm_DMSERVER_*.log');
  L.push('```');
  L.push('');
  L.push('> 反向提醒：`ERROR` / `FATAL` 这两个级别**不能**用来找损坏。');
  L.push('> 实测本环境的 ERROR/FATAL 全部是启动时连 `localhost:7536` 的 ASM 重试，与损坏无关。');
  L.push('');

  // ---- 四、坏页与备份的时间关系 ----
  L.push('## 四、已知坏页与备份的时间关系');
  L.push('');
  if (!pages || pages.length === 0) {
    L.push('`V$ERROR_PAGE` 无记录。');
    L.push('');
    // ★ §40：这句免责在**边界与免责**里已经有一遍（那是全局声明），这里只需要一小句 + 引路。
    //   §38.4 又给多节点日志裁决专门讲过一遍 —— 三处同义重复，读者会以为看到了三段不同的结论。
    // ★ §46.4-①：措辞改了 —— 实测"页被访问到也不记"（读到坏页直接 abort 实例），
    //   所以不能说"只记录被访问到的页"当解释。
    L.push('⚠️ 这个视图为空**几乎说明不了什么**：实测读到坏页会让 DM **直接 abort 实例**，而重启后它**仍然是 0 行**。');
    if (osAccess) {
      L.push(
        '   本次的页面证据以正文「全库页完整性裁决 —— OS 级实测（日志扫描）」为准（那里含实例日志里的页校验失败记录）。',
      );
    } else {
      L.push('   要拿到全库裁决，只能靠上面第三节那行 `N corrupted pages during backup`。');
    }
  } else if (!cov.newest || !cov.newest.isFull) {
    L.push(`已知坏页 ${pages.length} 页，但账本里**没有完全备份**，无法做「坏页 vs 备份」的时间比对。`);
  } else {
    const bt = fmtStamp(cov.newest.time);
    L.push(`最近一次完全备份：**${cov.newest.name}**（${bt}）。逐页比对：`);
    L.push('');
    L.push('| 表空间/文件/页 | 发现时间 | 相对该备份 | 能得出的结论 |');
    L.push('| --- | --- | --- | --- |');
    let after = 0;
    let before = 0;
    let unknown = 0;
    for (const it of rel) {
      const p = it.page;
      const loc = `TS ${p.TS_ID ?? '—'} / FILE ${p.FILE_ID ?? '—'} / PAGE ${p.PAGE_NO ?? '—'}`;
      let relTxt;
      let concl;
      if (it.rel === 'after-backup') {
        after += 1;
        relTxt = '晚于备份';
        concl = '该备份**不含**此页损坏（逻辑上确定）';
      } else if (it.rel === 'before-backup') {
        before += 1;
        relTxt = '早于备份';
        concl = '该备份**可能**已含此页损坏，必须用第三节两步确认';
      } else {
        unknown += 1;
        relTxt = '无法比较';
        concl = '时间字段缺失或无法解析';
      }
      L.push(`| ${loc} | ${fmtStamp(it.pageTime)} | ${relTxt} | ${concl} |`);
    }
    L.push('');
    L.push(`合计：晚于备份 ${after} 页、早于备份 ${before} 页、无法比较 ${unknown} 页。`);
    L.push('');
    L.push('> 这条比对的逻辑边界：`RECORD_TIME` 是「**被发现**」的时间，不是「变坏」的时间。');
    L.push('> 所以「坏页晚于备份」可以确定备份干净；但「坏页早于备份」**推不出**备份里一定有坏页，');
    L.push('> 只说明不能排除。反方向要下结论，只有靠 dmrman 校验和日志里那行计数。');
  }
  L.push('');

  // ---- 五、调用方提供的备份位置 ----
  if (supplied) {
    L.push('## 五、你提供的备份位置核对');
    L.push('');
    L.push(`输入：\`${supplied.raw}\``);
    L.push(`规范化后：\`${supplied.normalized}\``);
    L.push(`形态：**${supplied.kind === 'asm' ? 'ASM（+ 开头）' : supplied.kind === 'filesystem' ? '文件系统路径' : '无法识别'}**`);
    L.push('');
    if (supplied.inCatalog) {
      L.push(`✅ **账本里有匹配记录**（命中 ${supplied.matches.length} 条，方式：${supplied.matches[0].how}）：`);
      L.push('');
      for (const m of supplied.matches) {
        const b = m.backup;
        L.push(
          `- ${b.name} ｜ ${fmtStamp(b.time)} ｜ LSN ${fmtLsn(b.beginLsn)} → ${fmtLsn(b.endLsn)} ｜ ` +
            `${b.isFull ? '完全备份' : `type=${b.type} level=${b.level}`}`,
        );
      }
      L.push('');
      L.push('⚠️ 但这**只说明库的账本里有这条记录**，仍然**不等于**备份文件可读、完好。');
      L.push('   可用性结论必须由下面这条命令给出：');
      L.push('');
      L.push('```');
      // 用**命中的那条备份集自己的路径**：调用方给的往往是目录，
      // 而 dmrman CHECK BACKUPSET 要的是备份集本身。
      L.push(dmrmanCheckCommand(supplied.matches[0].backup.path || supplied.normalized));
      L.push('```');
    } else {
      L.push('❌ **账本里没有匹配记录。**');
      L.push('');
      if (supplied.kindMismatch) {
        L.push('重要：本库账本里的备份都在 **ASM**（路径以 `+` 开头）。');
        L.push('ASM 不是文件系统 —— 在操作系统上 `find`/`ls` **本来就看不到**这些备份文件。');
        L.push('「文件系统上找不到」在本环境是**预期行为**，不代表备份丢了。');
        L.push('');
      }
      L.push('可能的原因，请逐条排除：');
      L.push('');
      L.push('1. 该备份属于**另一个库实例**（拿错了库的备份）；');
      L.push('2. 备份文件已被**清理/迁移**，而账本尚未刷新；');
      L.push('3. 路径写错（注意 ASM 路径以 `+` 开头、区分大小写）；');
      L.push('4. 备份是**手工拷贝**过来的，从未在本库登记过。');
      L.push('');
      L.push('不管哪种，下一步都一样 —— 用 dmrman 直接问那个备份集本身：');
      L.push('');
      L.push('```');
      L.push(dmrmanCheckCommand(supplied.normalized));
      L.push('```');
      L.push('');
      L.push('该命令**不依赖本插件、也不依赖本库账本**，它直接打开备份集校验其结构；');
      L.push('能通过就说明这份备份可用，通不过会给出具体的损坏位置。');
    }
    L.push('');
  }

  L.push('---');
  L.push('本插件全程只读：不扫描、不修复、不改配置、不执行备份或恢复。');
  return L.join('\n');
}

function renderReadiness(r) {
  const L = [];
  L.push(`形态：${r.form.label}${r.form.dscNodes ? `（${r.form.dscNodes} 节点）` : ''}`);
  const mark = { yes: '可用', no: '不可用', limited: '受限', 'high-risk': '高风险（不推荐）' };
  for (const p of r.paths) L.push(`- [${mark[p.available] ?? p.available}] ${p.name}：${p.reason}`);
  for (const w of r.warnings) L.push(`- ${w}`);
  return L.join('\n');
}

function renderList(list) {
  const L = [];
  L.push(
    `V$ERROR_PAGE ${list.counts.errorRows} 行 / V$REPAIRED_PAGE ${list.counts.repairedRows} 行 / ` +
      `V$SQL_SKIP_CPAGE ${list.counts.skipRows} 行`,
  );
  if (list.entries.length === 0) {
    L.push('未发现坏页记录。');
  } else {
    L.push('');
    L.push('| 页 (TS,FILE,PAGE) | 文件 | 状态 | 最近报错 | 最近修复 | 报错次数 |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    for (const e of list.entries) {
      L.push(
        `| ${e.page} | ${e.fileName ?? '—'} | ${e.statusText} | ` +
          `${e.lastError ? e.lastError.toISOString().slice(0, 19).replace('T', ' ') : '—'} | ` +
          `${e.lastRepair ? e.lastRepair.toISOString().slice(0, 19).replace('T', ' ') : '—'} | ${e.errorCount} |`,
      );
    }
    if (list.reCorrupted.length > 0) {
      L.push('');
      L.push('⚠️ 修复后再次损坏：反复损坏同一位置是**存储问题信号**，处置方向应是查盘 / RAID 卡 / HBA。');
    }
  }
  return L.join('\n');
}

/**
 * 口令解析：显式参数 > 凭据库 > 配置。
 * 凭据服务用 ctx.get 软取——它由 dsh-base 恒定挂载；取不到时插件其余部分照常工作。
 */
async function resolvePassword(ctx, args, config) {
  const explicit = args.password ?? config.password;
  if (typeof explicit === 'string' && explicit !== '') return { value: explicit, source: '配置/调用参数' };
  const ref = config.credentialRef;
  if (!ref) return { value: null, source: '未提供' };
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined;
  if (!credentials || typeof credentials.resolve !== 'function') return { value: null, source: '凭据服务不可用' };
  try {
    const got = await credentials.resolve(ref);
    const v = typeof got === 'string' ? got : (got?.secret ?? got?.value ?? null);
    return { value: v ?? null, source: v ? `凭据库(${ref})` : `凭据库(${ref}) 中无值` };
  } catch (e) {
    return { value: null, source: `凭据库读取失败: ${e.message}` };
  }
}

function apply(ctx, config = {}) {
  const getConfig = () => ({
    home: config.home || defaultHome(),
    host: config.host,
    port: config.port ?? 5236,
    user: config.user ?? 'SYSDBA',
    password: config.password,
    credentialRef: config.credentialRef,
    driverJar: config.driverJar,
    javaHome: config.javaHome,
    timeoutSec: config.timeoutSec ?? 120,
    // OS 访问（可选）。全部为空时插件保持纯 JDBC 只读，不执行任何主机命令。
    sshHost: config.sshHost,
    sshPort: config.sshPort,
    sshUser: config.sshUser,
    sshPassword: config.sshPassword,
    sshHostKey: config.sshHostKey,
    plinkPath: config.plinkPath,
    dmrmanPath: config.dmrmanPath,
  });

  const tool = defineTool({
    name: TOOL_NAME,
    description: [
      '达梦数据库**可恢复能力评估**：逐场景回答「这套库能不能恢复、能恢复到哪一点、要丢什么」。',
      '16 个恢复场景（逻辑损坏 / 物理损坏 / 集群容灾）× 「要求 vs 本库实际」条件对照 + 针对性建议；',
      '含归档链逐段核对、时间↔LSN 对应、备份可用性。',
      '**只读**：不扫描、不修复、不改配置。',
      '注意 `V$ERROR_PAGE` 只记录被访问到的坏页，「未发现」不等于「没有坏页」。',
    ].join(''),
    timeoutMs: 300000,
    isConcurrencySafe: () => true,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, v) => [{ type: 'text', text: String(v?.text ?? '') }],
    },
    /**
     * ★ 方法与 action 的**所有**失败都在这里兜住，转成标准信封（DESIGN §28）。
     * 以前异常直接抛出去，用户看到的是一段 JS 栈 —— 既读不懂、也看不出"该做什么"。
     * 现在按 §25 的信封返回，并把达梦错误归类成一句**可执行**的话（含"别再重复试"）。
     */
    async execute(args) {
      const cfg = getConfig();
      try {
      const home = ensureHome(cfg.home);
      const startedAt = new Date();
      /** 本次运行的环境信息（信封的 `meta`）。 */
      const mkMeta = (conn, extra = {}) => ({
        host: conn?.host ?? null,
        port: conn?.port ?? null,
        user: conn?.user ?? null,
        startedAt: localStamp(startedAt),
        finishedAt: localStamp(),
        durationMs: Date.now() - startedAt.getTime(),
        osAccess: sshConfigOf({ args, cfg }) !== null,
        /**
         * ★ 留痕（DESIGN §26）：**调用方显式声明、而工具没有验证过**的输入。
         *
         * 为什么单列出来：这些值直接影响结论（备份位置、要检查哪些节点、回溯窗口假设），
         * 但它们**不是实测**。以前它们混在参数里，读报告的人看不出"哪些是插件查的、
         * 哪些是调用方说的"。口令等敏感项**不列出**。
         *
         * ★★ §29.7：每项还带 `usedBy` / `used` —— **参数被收下但没人用**这件事必须说出来。
         *   不然调用方给 `backup` 传了某个它不认的参数，看到 `meta` 里列着它、
         *   正文里却什么都没有，就会以为"插件算过了"。
         *   六个 action 的参数表是**同一张**，所以"这个 action 认不认这个参数"只能在这里标。
         */
        inputsDeclaredByUser: [
          ...(args.backupPath ? [{ name: 'backupPath', value: String(args.backupPath) }] : []),
          ...(args.targets ? [{ name: 'targets', value: String(args.targets) }] : []),
          ...(args.retentionHours ? [{ name: 'retentionHours', value: String(args.retentionHours) }] : []),
          ...(args.sshHost ? [{ name: 'sshHost', value: String(args.sshHost) }] : []),
          ...(args.dmrmanDcrIni ? [{ name: 'dmrmanDcrIni', value: String(args.dmrmanDcrIni) }] : []),
        ].map((x) => {
          const usedBy = USED_BY[x.name] ?? [];
          return {
            ...x,
            usedBy,
            // `used=false` 时，调用方必须知道这个参数**本次没有参与任何判定**
            used: usedBy.includes(args.action),
          };
        }).map((x) => ({ ...x, ...PROV.userDeclared('调用参数') })),
        ...extra,
      });
      /**
       * 「边界与免责」条目 = 各 action 自己的 + 「你给了但本次没用到的参数」提示（§29.7）
       * + 「参数层面要提醒的事」（`argNotes`，例如 `host` 里的端口与 `port` 参数不一致，§36）。
       * 只在真有这种参数时才会多一条（`ignoredParamNotes` 对 backup/report 恒为空）。
       */
      const argNotes = [];
      const bnd = (items = []) => [...items, ...ignoredParamNotes(args), ...argNotes];
      const { value: password, source: pwSource } = await resolvePassword(ctx, args, cfg);

      /**
       * ★ `host` 支持 **`host:port` 简写**（DESIGN §36）。
       *
       * 为什么加：本项目**不配凭据库、也不落任何默认连接信息** —— 每次运行都在卡片里手输。
       * 既然要反复手输，就该少输一个字段：`host=10.127.11.61:7236` 一行顶两行。
       * 复用 `parseTargets`（它已经处理了 `host:port` 与 IPv6 字面量 `[::1]:5236`），
       * **显式 `port` 参数优先级更高**（写了 port 就以 port 为准，避免"两处不一致"时猜）。
       */
      const hostArg = String(args.host ?? '').trim();
      const hostParsed = hostArg.includes(':') ? parseTargets(hostArg)[0] ?? null : null;
      const hostOnly = hostParsed ? hostParsed.host : hostArg || null;
      const portExplicit = args.port !== undefined && args.port !== null ? Number(args.port) : null;
      if (hostArg && hostParsed && portExplicit !== null && portExplicit !== hostParsed.port) {
        // 两处都给了且不一致 —— 不猜，明确以 port 为准并留痕（在 meta.inputsDeclaredByUser 里有原始值）
        argNotes.push(
          `⚠️ \`host\` 里带的端口（${hostParsed.port}）与 \`port\` 参数（${portExplicit}）不一致 —— ` +
            '本次以 `port` 为准。',
        );
      }

      if (!password) {
        const conclusion = `未取得数据库口令（来源：${pwSource}），**未做任何判断**`;
        return buildResult({
          action: args.action,
          generatedAt: localStamp(),
          level: 'unknown',
          conclusion,
          findings: [
            finding(
              ID.form('credentials'),
              'unknown',
              '未取得数据库口令',
              `${conclusion}。请先配置凭据库并在插件配置里填 \`credentialRef\`；直接传 \`password\` 参数会进入会话日志，不推荐。`,
              [`口令来源：${pwSource}`],
              null,
              PROV.derived('凭据解析（配置 / 凭据库 / 调用参数）'),
            ),
          ],
          result: { passwordSource: pwSource },
          meta: mkMeta(null),
          text: renderResult({
            action: args.action,
            level: 'unknown',
            conclusion,
            points: [point('unknown', `口令来源：${pwSource}`)],
            boundaries: bnd(['未取得口令时**不下任何结论** —— 「没查到」不等于「没问题」。']),
          }),
          disclaimer: '未取得口令，本次未做任何判断。',
        });
      }

      const conn = {
        home,
        // `host:port` 简写已在上面的 `hostOnly` / `hostParsed` 里解析（§36）；
        // **显式 `port` 参数优先**，两者都没有才落到默认端口。
        host: hostOnly ?? cfg.host ?? '127.0.0.1',
        port: portExplicit ?? hostParsed?.port ?? Number(cfg.port),
        user: args.user ?? cfg.user,
        password,
        driverJar: cfg.driverJar,
        javaHome: cfg.javaHome,
        timeoutSec: cfg.timeoutSec,
      };

      if (args.action === 'capacity') {
        const sampleSec = Number(args.sampleSec ?? 60);
        const first = await runQueries(conn, [...FORM_QUERIES, ...READINESS_QUERIES, ...ARCHIVE_QUERIES]);
        const chk = checkArchiveParams({ params: first.archParams, arch: first.archTargets });
        const capPoints = [
          point(null, `归档：**${chk.items[0].set ? '已开启' : '未开启'}**（\`ARCH_INI = ${chk.items[0].value ?? '未取到'}\`）`),
          point(
            null,
            `空间**预警**参数：${chk.items.filter((x) => x.set).length}/${chk.items.length} 项已设` +
              `（未设的是 ${chk.items.filter((x) => !x.set).map((x) => `\`${x.name}\``).join('、') || '无'}）`,
          ),
          point(null, `归档目标：**${chk.destinations.length}** 个`),
        ];
        const capUnset = chk.items.filter((x) => !x.set);
        const capFindings = [
          ...(chk.items[0].blocking
            ? [
                finding(
                  ID.archive('params'),
                  'crit',
                  '归档未开启 —— 没有时间点恢复能力',
                  '`ARCH_INI` 不为 1。这不是"参数没调好"，而是坏页/误操作发生时没有任何回溯手段。',
                  [`V$DM_INI.ARCH_INI = ${chk.items[0].value ?? '未取到'}`],
                ),
              ]
            : capUnset.length > 0
              ? [
                  finding(
                    ID.archive('params'),
                    'warn',
                    `${capUnset.length} 个归档空间参数未设置`,
                    `未设：${capUnset.map((x) => x.name).join('、')}。注意这两个参数是**预警**机制（只打印告警日志），不是保护机制。`,
                    capUnset.map((x) => `${x.name} = ${x.value ?? '未取到'}（${x.where}）`),
                  ),
                ]
              : []),
        ];
        if (chk.items[0].blocking) {
          // 归档没开 → 后面所有"空间参数怎么设"都无从谈起，**短路**（结论层直说）
          return buildResult({
            action: 'capacity',
            generatedAt: localStamp(),
            level: 'crit',
            conclusion: chk.summary,
            summary: { pages: null, nodes: null, backups: null },
            findings: capFindings,
            result: { params: chk.items, destinations: chk.destinations },
            meta: mkMeta(conn),
            disclaimer: '本 action 只**检查与建议**，不改任何参数。',
            text: renderResult({
              action: 'capacity',
              level: 'crit',
              conclusion: chk.summary,
              points: capPoints,
              sections: splitH2Sections(renderArchiveParams(chk), '归档空间参数检查'),
              boundaries: bnd(['本 action 只**检查与建议**，不改任何参数；所述命令由人执行。']),
            }),
            legacy: { verdict: chk.summary, distinctPages: 0, needAttention: 0 },
          });
        }
        // ★ **不做速率采样。**
        //   原先这里会 sleep(sampleSec) 再取第二帧，靠「等一个新归档文件出现」来测速率 ——
        //   而归档文件可能几十分钟才新建一个（取决于 ARCH_FILE_SIZE 与负载），
        //   于是工具要么久等、要么在没有新文件时**永远测不出来**。诊断工具不能挂在等待上。
        //   更根本的是：这个数字**没有用** —— 历史速率预测不了未来增长，
        //   而下面所有建议都不依赖它。为了一个既不外推、也不参与推荐的数字让运维等待，是不合理的。
        const growth = {
          ok: false,
          skipped: true,
          reason: '本 action **不做速率采样**（历史速率预测不了未来增长，且下面的建议都不依赖它）。',
        };
        const ac = first.asm?.columns ?? [];
        const pick = (rows, group, frag) => {
          const row = (rows ?? []).find((r) => {
            const i = ac.findIndex((x) => /GROUP_NAME/i.test(x));
            return i >= 0 && String(r[i]).toUpperCase().includes(group);
          });
          if (!row) return null;
          const i = ac.findIndex((x) => new RegExp(frag, 'i').test(x));
          return i >= 0 ? Number(row[i]) : null;
        };
        // 节点系数必须是实测值：`V$DATABASE.DSC_NODES`（DMDSC 上=节点数，单实例=1）。
        // 它决定「每个归档目录要容纳几个节点的归档」，取不到时宁可不出数值。
        // 注意显式排除 null —— `Number(null)===0`，直接 Number() 会把「取不到」变成 0。
        const dscNodesRaw = scalarOf(first.database, '^DSC_NODES$');
        const dscNodes =
          dscNodesRaw === null || dscNodesRaw === undefined || dscNodesRaw === '' ? null : Number(dscNodesRaw);
        const rec = recommendArchiveParams({
          growth,
          totalMB: pick(first.asm?.rows, 'DMDATA', 'TOTAL_MB'),
          freeMB: pick(first.asm?.rows, 'DMDATA', 'FREE_MB'),
          retentionHours: Number(args.retentionHours ?? 24),
          destCount: chk.destinations.length || 2,
          nodeFactor: dscNodes,
        });
        // 节点系数的说明进「依据」（它是解释，不是结论）；结论层只留数值。
        const nodeFactorNote =
          `归档目录**节点系数**：${Number.isFinite(dscNodes) ? `**${dscNodes}**` : '**未取得**（DSC_NODES 查询失败）'}` +
          `　实测自 \`V$DATABASE.DSC_NODES\`。\n` +
          `DMDSC 交叉配置下（每节点 LOCAL + REMOTE 互相投递），**每个归档目录都会收到所有节点的归档**；` +
          `单实例则只有 LOCAL（系数 1）。按单节点速率算每目标上限会少算 (N-1)/N。`;
        capPoints.push(
          point(null, `归档目录**节点系数**：**${Number.isFinite(dscNodes) ? dscNodes : '未取得'}**（实测 \`V$DATABASE.DSC_NODES\`）`),
          point(
            null,
            rec.ok
              ? `推荐值已给出（速率 ${growth.mbPerHour.toFixed(1)} MB/h）`
              : '**速率不做采样** —— 它是上一段观测，预测不了未来；`ARCH_SPACE_LIMIT` **恒不给推荐值**',
          ),
        );
        const capLevel = topLevelOf(capFindings);
        return buildResult({
          action: 'capacity',
          generatedAt: localStamp(),
          level: capLevel,
          conclusion: chk.summary,
          summary: { backups: null },
          findings: [
            ...capFindings,
            finding(
              ID.archive('node-factor'),
              null,
              '归档目录节点系数',
              '每个归档目录要容纳几个节点的归档（DMDSC 交叉配置下每个目录都会收到所有节点的归档）。',
              [`DSC_NODES = ${Number.isFinite(dscNodes) ? dscNodes : '未取得'}`],
            ),
          ],
          result: {
            params: chk.items,
            destinations: chk.destinations,
            nodeFactor: Number.isFinite(dscNodes) ? dscNodes : null,
            recommended: rec,
            rateSampling: 'skipped（不做速率采样）',
          },
          meta: mkMeta(conn),
          disclaimer: '本 action 只**检查与建议**，不改任何参数；所述命令由人执行。',
          text: renderResult({
            action: 'capacity',
            level: capLevel,
            conclusion: chk.summary,
            points: capPoints,
            sections: [
              ...splitH2Sections(renderArchiveParams(chk), '归档空间参数检查'),
              ...splitH2Sections(`${nodeFactorNote}\n\n${renderArchiveRec(rec, growth)}`, '节点系数与推荐明细'),
            ],
            boundaries: bnd(['本 action 只**检查与建议**，不改任何参数；所述命令由人执行。']),
          }),
          legacy: {
            verdict: rec.ok ? `速率 ${growth.mbPerHour.toFixed(1)} MB/h` : '速率无法测算',
            distinctPages: 0,
            needAttention: 0,
          },
        });
      }

      if (args.action === 'backup') {
        const archQ = ARCHIVE_QUERIES.filter((q) => q.key === 'archFiles');
        // CAP_QUERIES 里带 `BAK_PATH`（dm.ini 的默认备份路径）—— 账本为空时，
        // 「磁盘上到底有没有备份」只能从这个路径出发去找（见下面的 find 一节）。
        const data = await runQueries(conn, [
          ...FORM_QUERIES,
          ...LIST_QUERIES,
          ...BACKUP_QUERIES,
          ...archQ,
          ...CAP_QUERIES,
        ]);
        const backups = parseBackupSets(data.backupset);
        const curLsn = scalarOf(data.backupRlog, '^CUR_LSN$');
        const cov = assessBackupCoverage({ backups, curLsn, archRes: data.archFiles });
        // ★ 归档链**逐段核对**（强判据）：`cov.covered` 只看两端，中间断了它看不出来。
        //   `needFrom` 用备份的 **BEGIN_LSN**：热备需要从备份开始那一点起的 redo 才能一致。
        const chain = assessArchiveChain(data.archFiles, {
          curLsn,
          needFrom: backups[0]?.beginLsn ?? null,
        });
        // ★ 时间 ↔ LSN 锚点：归档边界 + 备份 + 当前前沿（用**数据库自己的 SYSDATE**）
        const anchors = assessTimeLsnAnchors({
          archRes: data.archFiles,
          backups,
          curLsn,
          nowTime: scalarOf(data.backupDbTime, '^NOW$'),
          rlogHistory: data.backupRlogHistory,
          // ★ 机会性锚点源（DESIGN §35）：开了闪回的库上每事务一对 (时刻, LSN)；0 行即本库没开
          flashbackTrx: data.flashbackTrx,
        });
        const pages = rowsAsObjects(data.errorPage);
        const rel = relatePagesToBackups(pages, backups);
        const supplied = args.backupPath ? verifySuppliedPath(args.backupPath, backups) : null;
        const bakPathParam = kvFrom(data.capIni).BAK_PATH;
        // ★ （原「恢复需求达成度」判定在这里 —— 2026-10-13 整项移除，DESIGN §29.10）
        const verdict =
          backups.length === 0
            ? '账本内未发现备份'
            : `最近一次 ${cov.newest.name}（${fmtStamp(cov.newest.time)}），redo 缺口 ${cov.redoGap ?? '未知'}`;
        // ---- 可选：配了 OS 访问就顺手把三件「库内查不到的事」查掉 ----
        // 没配 ssh 就完全不做（保持纯 JDBC 只读）；配了也只走 ossh.js 白名单里那**三条只读命令**：
        //   ① dmrman CHECK BACKUPSET（备份集可不可读）
        //   ② scan-backup-log.sh（全库逐页裁决 —— V$ERROR_PAGE 永远给不了）
        //   ③ ls/find（磁盘上到底有哪些备份文件；**仅在路径不是 ASM 时才有意义**）
        // ★ §42 并发：日志扫描与磁盘查找**互不依赖**（服务端是两个不同的东西），所以一起发。
        //   实测串行时这一段独占整份报告 12.8/18 秒。
        const [osLogScan, osFind] = await Promise.all([
          runBackupLogScan({ args, cfg }),
          runFindBackupsOnDisk({ args, cfg, backups, supplied, bakPathParam }),
        ]);
        // ★ `dmrman CHECK BACKUPSET` **必须排在磁盘查找之后**：账本为空时，校验目标就是
        //   `find` 找到的那一份备份集（`resolveCheckTarget` 第 ② 档）。把它塞回上面的
        //   `Promise.all` 就拿不到 `osFind` → 又退回「账本为空就跳过校验」的老毛病。
        //   代价是这两步串行 —— 但它们本来就是「先找到文件、再校验文件」的因果关系，
        //   不是可以并发的工作；`osLogScan` 仍与 `osFind` 并发，慢的那条没有被拖长。
        const osCheck = await runBackupsetCheck({ args, cfg, backups, supplied, osFind });
        const beforeBackup = rel.filter((x) => x.rel === 'before-backup').length;
        const bkPoints = [
          point(
            null,
            backups.length === 0
              ? '库的账本里**没有任何备份记录**（注意：账本为空不等于没有备份）'
              : `账本里 **${backups.length}** 份备份；最近一次 **${cov.newest.name}**（${fmtStamp(cov.newest.time)}，${cov.newest.isFull ? '完全备份' : '非完全备份'}）`,
          ),
          point(
            null,
            cov.redoGap === null
              ? '能否恢复到「当前」**未取到**（缺 CUR_LSN 或备份 END_LSN）'
              : `恢复到「当前」需要归档补齐 **${cov.redoGap}** 个 LSN（备份末端 → CUR_LSN）`,
          ),
          point(
            chain.verdict === 'gap' ? 'warn' : null,
            chain.verdict === 'unknown'
              ? '归档链连续性**未判定**'
              : chain.verdict === 'gap'
                ? `归档并集里有 **${chain.holes.length}** 处洞 —— 恢复到这些 LSN 区间时会断`
                : `归档链 **${chain.series.length}** 个序列逐段连续、并集无洞；未归档尾部 ${chain.unarchivedLsn ?? '—'}`,
          ),
          point(
            null,
            // 来源与窗口都取**本次实测值**：DMDSC 上最密的可能是归档文件，而不是 `V$RLOG_HISTORY`
            anchors && anchors.dense
              ? `时间↔LSN：最密一档 **${fmtMinutes(anchors.minGapHours * 60)}**（来源：${anchors.minGapSource ?? '未取到'}）——` +
                ` 但只在 **${anchors.denseWindow?.from ?? '—'} ~ ${anchors.denseWindow?.to ?? '—'}** 内；` +
                `窗口外最大间距 **${fmtMinutes((anchors.maxGapHours ?? 0) * 60)}**`
              : anchors
                ? `时间↔LSN：锚点 ${anchors.count} 个，最大间距 **${fmtMinutes((anchors.maxGapHours ?? 0) * 60)}** —— 间距即精度上限`
                : '时间↔LSN：锚点不足，未做对应',
          ),
          point(
            null,
            pages.length === 0
              ? '本轮 `V$ERROR_PAGE` **无记录**（⚠️ 这只代表**还没人碰到过**，不等于没有坏页）'
              : `坏页记录 **${pages.length}** 页${beforeBackup > 0 ? `，其中 **${beforeBackup}** 页早于最近一次全备（该备份**可能已含**此损坏）` : '（均晚于或无法与该备份比较）'}`,
          ),
        ];
        const osParts = [
          osCheck && { title: `备份可用性 —— OS 级实测${osTag(osCheck)}`, md: renderOsCheck(osCheck) },
          osLogScan && {
            title: `全库页完整性裁决 —— OS 级实测（日志扫描）${osTag(osLogScan)}`,
            md: renderOsLogScan(osLogScan, osAggregateOf({ osLogScan })),
          },
          osFind && { title: `磁盘上的备份文件 —— OS 级实测（文件系统查找）${osTag(osFind)}`, md: renderOsFind(osFind) },
        ].filter(Boolean);
        // ---- 结论项（稳定 ID，见 result.js 的命名表）----
        const bkFindings = [
          ...(backups.length === 0
            ? [
                finding(
                  ID.backup('catalog'),
                  'warn',
                  '库的账本里没有任何备份记录',
                  '`V$BACKUPSET` 为空。注意这**不等于**没有备份 —— 账本只反映当前控制文件记得的备份集。',
                  ['V$BACKUPSET 返回 0 行'],
                ),
              ]
            : [
                ...(backups.length === 1
                  ? [
                      finding(
                        ID.backup('redundancy'),
                        'warn',
                        '只有 1 份备份，没有冗余',
                        '「备份集本身损坏」这个场景假设的正是这一份会坏，而它没有任何后备。',
                        [`V$BACKUPSET 返回 ${backups.length} 行`],
                      ),
                    ]
                  : []),
                finding(
                  ID.backup('coverage'),
                  null,
                  '最近一次备份与 redo 缺口',
                  `最近一次 **${cov.newest.name}**（${fmtStamp(cov.newest.time)}）。`,
                  [
                    `END_LSN = ${cov.newest.endLsn ?? '—'}`,
                    `CUR_LSN = ${curLsn ?? '—'}`,
                    `redo 缺口 = ${cov.redoGap ?? '未取到'}`,
                  ],
                ),
              ]),
          finding(
            ID.backup('chain'),
            chain.verdict === 'gap' ? 'crit' : chain.verdict === 'unknown' ? 'unknown' : null,
            '归档链逐段核对',
            chain.note,
            [
              `序列数 = ${chain.series.length}`,
              `并集覆盖 LSN ${chain.coveredFrom ?? '—'} → ${chain.coveredTo ?? '—'}`,
              `洞 = ${chain.holes.length}`,
              `未归档尾部 = ${chain.unarchivedLsn ?? '—'}`,
            ],
          ),
          finding(
            ID.backup('time-lsn'),
            null,
            '时间 ↔ LSN 对应',
            anchors?.note ?? '锚点不足，未做对应',
            anchors
              ? [`锚点 ${anchors.count} 个`, `最密间距 ${anchors.minGapHours === null ? '—' : (anchors.minGapHours * 60).toFixed(1) + ' 分钟'}`, `最大间距 ${anchors.maxGapHours === null ? '—' : anchors.maxGapHours.toFixed(1) + ' 小时'}`]
              : [],
          ),
          ...(beforeBackup > 0
            ? [
                finding(
                  ID.backup('pages-before'),
                  'warn',
                  `${beforeBackup} 个坏页早于最近一次全备`,
                  '`RECORD_TIME` 是「被发现」的时间，不是「变坏」的时间 —— 所以只能说**不能排除该备份含此损坏**，反方向要下结论只能靠 dmrman 校验与全备日志计数。',
                  rel.filter((x) => x.rel === 'before-backup').map((x) => `页 TS ${x.page.TS_ID} / FILE ${x.page.FILE_ID} / PAGE ${x.page.PAGE_NO} @ ${fmtStamp(x.pageTime)}`),
                ),
              ]
            : []),
          // OS 级三项：**与 report 共用同一份构造**（`osFindingsOf`），ID 与语义一致
          ...osFindingsOf({ osCheck, osLogScan, osFind }),
        ];
        // 等级**由结论项推出来**（单一来源，`topLevelOf`）—— 六处手写推导已全部收敛。
        const bkAllFindings = [...bkFindings];
        const bkLevel = topLevelOf(bkAllFindings);
        const bkConclusion = verdict;
        return buildResult({
          action: 'backup',
          generatedAt: localStamp(),
          level: bkLevel,
          conclusion: bkConclusion,
          summary: {
            pages: { distinct: pages.length, needAttention: beforeBackup },
            backups: backups.length,
            archiveContinuous: chain.verdict === 'unknown' ? null : chain.verdict === 'continuous',
          },
          findings: bkAllFindings,
          result: {
            backups,
            coverage: { newest: cov.newest?.name ?? null, endLsn: cov.newest?.endLsn ?? null, redoGap: cov.redoGap, covered: cov.covered, span: cov.span },
            chain,
            anchors,
            pages: pages.map((p) => ({ tsId: p.TS_ID, fileId: p.FILE_ID, pageNo: p.PAGE_NO, recordTime: p.RECORD_TIME, errcode: p.ERRCODE })),
            supplied: supplied ?? null,
            // OS 级三项的机器可读摘要（与 report 共用 `osResultOf`）
            os: osResultOf({ osCheck, osLogScan, osFind }),
          },
          meta: mkMeta(conn),
          disclaimer: '「未发现坏页」不等于「没有坏页」；账本里有记录也不等于备份文件可读。',
          text: renderResult({
            action: 'backup',
            level: bkLevel,
            conclusion: bkConclusion,
            meta: [`采集目标：${conn.host}:${conn.port}`, `OS 访问：${sshConfigOf({ args, cfg }) ? '已启用（只读，三条命令）' : '未启用（纯 JDBC）'}`],
            points: [
              ...bkPoints,
            ],
            sections: [
              ...splitH2Sections(
                renderBackup({
                  backups,
                  cov,
                  rel,
                  supplied,
                  pages,
                  chain,
                  anchors,
                  osAccess: sshConfigOf({ args, cfg }) !== null,
                }),
              ),
              ...osParts.flatMap((p) => splitH2Sections(p.md, p.title)),
            ],
          }),
          legacy: { verdict: bkConclusion, distinctPages: pages.length, needAttention: beforeBackup },
        });
      }

      if (args.action === 'report') {
        // 报告 = 把 5 个主题汇总成一份 HTML 落盘。
        // **不做速率采样** —— 那要两次采样 + 等待，而速率本来就不能外推（见 capacity 的说明）。
        const targetList = parseTargets(args.targets);
        const sweep =
          targetList.length > 0
            ? targetList
            : [{ host: conn.host, port: conn.port, label: `${conn.host}:${conn.port}` }];
        const perNode = [];
        const failed = [];
        for (const t of sweep) {
          try {
            const d = await runQueries({ ...conn, host: t.host, port: t.port }, [
              ...FORM_QUERIES,
              ...READINESS_QUERIES,
              ...LIST_QUERIES,
              ...ARCHIVE_QUERIES,
              ...BACKUP_QUERIES,
              ...CAP_QUERIES,
            ]);
            perNode.push({ label: t.label, ...d });
          } catch (e) {
            failed.push({ label: t.label, error: String(e?.message ?? e) });
          }
        }
        if (perNode.length === 0) {
          // ⚠️ 这里**也必须走信封**：它是"所有目标都连不上"，而不是正常结果。
          //   第一版返回的是旧契约的裸对象（只有 action/verdict/distinctPages/text）——
          //   同一次会话里 §28 刚给 execute 的 catch 加了兜底信封，这条**并行的失败路径**却漏了：
          //   消费者按信封取值时会拿到一堆 undefined。失败路径有几条，就得补几条。
          const firstErr = failed[0]?.error ?? '';
          const cls = classifyDbError(firstErr);
          // ★ §39：措辞由**分类结果**决定 —— EPERM 那种"本机写不了工作目录"绝不能被说成"连不上数据库"
          const head = collectionFailureHeadline(failed);
          const conclusion = `${head.title} —— **未生成报告**（${failed.length} 个目标全失败）`;
          return buildResult({
            action: 'report',
            generatedAt: localStamp(),
            level: 'crit',
            conclusion,
            findings: [
              finding(
                ID.form('coverage'),
                'crit',
                `未生成报告：${head.title}`,
                `${cls.hint}\n\n失败目标：\n${failed.map((f) => `- ${f.label}：${f.error}`).join('\n')}`,
                failed.map((f) => `${f.label} → ${f.error}`),
                null,
                PROV.derived('连接失败（未采到任何数据）'),
              ),
            ],
            summary: { nodes: { checked: 0, failed: failed.length } },
            result: { coverage: { attempted: sweep.map((t) => t.label), connected: [], failed }, errorKind: head.kind },
            meta: {
              host: conn.host,
              port: conn.port,
              user: conn.user,
              startedAt: null,
              finishedAt: localStamp(),
              durationMs: null,
              osAccess: null,
              inputsDeclaredByUser: [],
            },
            disclaimer: '**没有采到任何数据 ⇒ 不给任何结论。** 报告未生成，「没查到」不等于「没问题」。',
            text: renderResult({
              action: 'report',
              level: 'crit',
              conclusion,
              points: [
                point('crit', cls.hint),
                point(null, `失败目标：${failed.map((f) => `${f.label}（${f.error}）`).join('；')}`),
              ],
              boundaries: bnd([...head.advice, `错误类别：\`${head.kind}\``]),
            }),
            legacy: { verdict: head.title, distinctPages: 0, needAttention: failed.length },
          });
        }

        const p0 = perNode[0];
        const r = judgeReadiness(p0);
        const list = buildPageList(p0);
        const chk = checkArchiveParams({ params: p0.archParams, arch: p0.archTargets });
        const backups = parseBackupSets(p0.backupset);
        const curLsn = scalarOf(p0.backupRlog, '^CUR_LSN$');
        const cov = assessBackupCoverage({ backups, curLsn, archRes: p0.archFiles });
        // ★ 归档链逐段核对（强判据）。`facts.archiveChainOk` 现在**由它决定**，
        //   而不再是「最早归档 LSN ≤ 备份起点」这个必要条件 —— 后者两端对齐但中间有洞时会谎报"可恢复"。
        const chain = assessArchiveChain(p0.archFiles, {
          curLsn,
          needFrom: backups[0]?.beginLsn ?? null,
        });
        const anchors = assessTimeLsnAnchors({
          archRes: p0.archFiles,
          backups,
          curLsn,
          nowTime: scalarOf(p0.backupDbTime, '^NOW$'),
          rlogHistory: p0.backupRlogHistory,
          // ★ 机会性锚点源（DESIGN §35）：开了闪回的库上每事务一对 (时刻, LSN)；0 行即本库没开
          flashbackTrx: p0.flashbackTrx,
        });
        // ★ （原「恢复需求达成度」判定 + 「先决条件」构造在这里 —— 2026-10-13 整项移除，DESIGN §29.10）
        /**
         * 原先这里把"我要恢复到哪个点/段"变成 `facts.targetRequirement`，于是凡走
         * 「备份 + 归档恢复」的场景，条件表里都会多一行「恢复到你要的时间点/段（先决条件）」。
         * 需求整项移除之后，**没有"你要的那个点"可言**，这一行也随之消失 ——
         * 场景条件表只回答"这套库有没有这条路、这条路通不通"，不再回答"通不通到某个具体的点"。
         * 注意：这不是把 §32 的做法否掉，而是它服务的那件事（需求达成度）已经不做了。
         */
        const pages = rowsAsObjects(p0.errorPage);
        const rel = relatePagesToBackups(pages, backups);
        const supplied = args.backupPath ? verifySuppliedPath(args.backupPath, backups) : null;
        const consistency = judgeConsistency(perNode);
        const dscNodes = scalarOf(p0.database, '^DSC_NODES$');
        const coverage = describeCoverage({
          dscNodes,
          targets: targetList,
          connected: perNode.map((n) => n.label),
          failedCount: failed.length,
        });

        const ini = kvFrom(p0.params);
        const cap = kvFrom(p0.capIni);
        const dwApply = Number(p0.dwApply?.rows?.[0]?.[0] ?? 0);
        const dwSend = Number(p0.dwSend?.rows?.[0]?.[0] ?? 0);
        const dbName = String(singleRowFields(p0.database, ['NAME']).NAME ?? 'DAMENG');
        const instName = String(singleRowFields(p0.instance, ['INSTANCE_NAME']).INSTANCE_NAME ?? '—');
        const version = String(singleRowFields(p0.instance, ['SVR_VERSION']).SVR_VERSION ?? '');

        // ---- 场景判定所依赖的事实。缺一项 → 对应场景判成「无法判定」，**不猜**。----
        // 备份与数据是否**确定**在同一存储上。只做**单向**推断：
        //   能证明同存储 → true；证明不了 → false（于是 offsiteCopy = null = 未判定）。
        // 为什么单向：不同磁盘组 / 不同目录**也可能**在同一块物理盘上，凭路径证不出「异地」。
        const pIdx = (p0.datafile?.columns ?? []).findIndex((x) => String(x).toUpperCase() === 'PATH');
        const dataPaths = (p0.datafile?.rows ?? []).map((r) => (pIdx >= 0 ? String(r[pIdx] ?? '') : ''));
        const bakPath = String(cap.BAK_PATH ?? '');
        const dirOf = (p) => String(p ?? '').replace(/\/[^/]+$/, '');
        const sameStorage = (() => {
          if (!bakPath) return false;
          if (bakPath.startsWith('+')) {
            const g = bakPath.split('/')[0] + '/';
            return dataPaths.some((p) => p.startsWith(g)); // ASM：同磁盘组 ⇒ 确定同存储
          }
          // 文件系统：一方目录是另一方的前缀 ⇒ 同一目录树 ⇒ 确定同存储。
          // 实测单实例正是这种情况：数据 /home/dmdba/dmdbms/data/DAMENG/*.DBF、
          // 备份 /home/dmdba/dmdbms/data/DAMENG/bak —— 明明同存储，
          // 早先却因为「只认 ASM」虚报成「无法判定」。
          const b = bakPath.replace(/\/+$/, '');
          return dataPaths.some((p) => {
            const d = dirOf(p);
            return Boolean(d) && (d === b || d.startsWith(b + '/') || b.startsWith(d + '/'));
          });
        })();
        const offsiteCopy = sameStorage ? false : null;

        const gc = (p0.rlogfile?.columns ?? []).findIndex((x) => String(x).toUpperCase() === 'GROUP_ID');
        const rlogByGroup = {};
        for (const r of p0.rlogfile?.rows ?? []) {
          const k = String(gc >= 0 ? r[gc] : '?');
          rlogByGroup[k] = (rlogByGroup[k] ?? 0) + 1;
        }
        const rlogMirrored =
          (p0.rlogfile?.rows ?? []).length === 0 ? null : Object.values(rlogByGroup).some((n) => n > 1);

        // 表空间状态（B8 的证据；口径选择见 analyze.js 的 assessTablespaceStatus）
        const tsStat = assessTablespaceStatus(p0.tablespace, p0.tablespaceRaw);

        // 回收站开关就是 `V$DM_INI.RECYCLEBIN`（实测 DMDSC 上为 **0 = 关闭**）。
        // 若开关取不到，退回「有内容才敢说启用」——**空不能证明未启用**。
        const rbSwitch = cap.RECYCLEBIN;
        const rbCount = Number(p0.recyclebin?.rows?.[0]?.[0] ?? NaN);
        const recyclebinEnabled =
          rbSwitch === '1'
            ? true
            : rbSwitch === '0'
              ? false
              : Number.isFinite(rbCount) && rbCount > 0
                ? true
                : null;

        const backupsCount = backups.length;
        const earliestArchLsn = chain.coveredFrom ?? cov.span?.oldestArchLsn ?? null;
        const backupBeginLsn = backups[0]?.beginLsn ?? null;
        // ★ 归档链是否覆盖备份起点 —— 现在取自**逐段核对**的结果（强判据）：
        //   需要「备份起点被覆盖」且「它之后到归档末端没有洞」。
        //   旧口径是 `earliestArchLsn <= backupBeginLsn`，只看两端。
        //   取不到时返回 null（= 未判定），**不默认成 true**。
        const archiveChainOk = chain.verdict === 'unknown' ? null : chain.coversNeedFrom;

        // OS 级校验（可选）—— 必须**在 facts 之前**求值，因为 facts.backupVerified 要用它。
        // 没配 ssh 就返回 null，报告里这一段不出现。
        // ★ §42 并发：与 `backup` action 同一口径 —— 日志扫描与磁盘查找一起发，
        //   而 `CHECK BACKUPSET` **要等磁盘查找**（账本为空时校验目标就是 find 找到的那一份）。
        const [osLogScan, osFind] = await Promise.all([
          // 「全库逐页裁决」与「磁盘上的备份文件」同理：没配 `sshLogDir` / 没有文件系统路径就不做。
          // 前者是本报告里**唯一**能正面回答「这个库到底有没有坏页」的东西。
          runBackupLogScan({ args, cfg }),
          runFindBackupsOnDisk({
            args,
            cfg,
            backups,
            supplied,
            bakPathParam: cap.BAK_PATH,
          }),
        ]);
        const osCheck = await runBackupsetCheck({ args, cfg, backups, supplied, osFind });
        // 多节点时的**保守合并**（§38）：报告档位用"全部 ok 才算 ok"，
        // 而 facts.backupVerified 用"至少一份通过"——两个问法不同，都在 osAgg 里。
        const osAgg = osAggregateOf({ osCheck, osLogScan });
        /**
         * ★ §46.5：**账本为空 ≠ 确定没有备份** —— 这个区分必须进 `facts`，否则场景引擎会把
         * "没查到"当"没有"（真机实测：还原之后账本是空的、磁盘上备份都在，插件却判 12 个场景
         * "当前救不回来"，同时又在另一处写着"账本为空不等于没有备份"）。
         *
         * 判据用**两个来源**：库的账本（`V$BACKUPSET`）+ OS 的 `find` 结果。
         * 只有"文件系统真的找过、且一个都没找到"才算**确定没有**；
         * 其余（找到了文件 / 没配 OS 访问 / 备份在 ASM 上 `find` 够不到）一律**不确认** → 相关场景判「无法判定」。
         */
        const findStates = (osFind ?? []).map((o) => o.verdict?.state ?? 'unknown');
        const backupFilesFound = (osFind ?? []).reduce((n, o) => n + (o.verdict?.files?.length ?? 0), 0);
        const backupsAbsentConfirmed =
          backups.length === 0 && findStates.length > 0 && findStates.every((s) => s === 'none');
        const backupsUncertain = backups.length === 0 && !backupsAbsentConfirmed;

        const facts = {
          archOn: String(chk.items.find((x) => x.name === 'ARCH_INI')?.value) === '1',
          enableFlashback: cap.ENABLE_FLASHBACK ?? null,
          undoRetention: cap.UNDO_RETENTION ?? null,
          ctlBakPath: cap.CTL_BAK_PATH ?? null,
          ctlBakNum: cap.CTL_BAK_NUM ?? null,
          bakPath: cap.BAK_PATH ?? null,
          hasStandby: dwApply > 0 || dwSend > 0,
          // ★ 两个来源取并集，否则报告会**自相矛盾**：
          //   `V$ERROR_PAGE` 只记录被访问到的页；若它为空、而全备日志说「有损坏页」，
          //   只按前者判就会得出「没有坏页」，与同一份报告里的日志裁决直接打架。
          //   多节点（§38）：**任一节点**报损坏即算有坏页 —— 一个节点看到的就是全库的证据。
          hasBadPages: list.counts.distinctPages > 0 || osAgg.anyCorrupt,
          backupsCount,
          // ★ §46.5：账本为空但**无法确认"确实没有备份"** → 场景引擎判 unknown，不判 none
          backupsUncertain,
          backupFilesFound,
          /**
           * ★ 只有配了 OS 访问才可能为真值 —— 这是本插件里唯一"离开 JDBC"拿到的实测结论。
           *
           * ⚠️ 多节点时**不能**直接用"保守合并"：B6 那一条要求的原话是
           * 「**至少一份**经 `CHECK BACKUPSET` 校验通过」—— 所以 `anyOk` 就算通过；
           * 而报告正文里显示的档位用的是保守合并（全部 ok 才 ok）。
           * 两个问法不同，这里各用各的（不让下游去猜）。
           */
          backupVerified: osAgg.anyOk ? true : osAgg.anyBad ? false : null,
          archiveTargets: chk.destinations.length,
          archiveChainOk,
          // 归档链的完整实测结果（逐段核对 / 并集覆盖 / 未归档尾部 / 单目录自足性）。
          // 场景渲染层用它把「归档已开、备份存在」升级为「逐段连续、覆盖到 X」。
          archiveChain: chain,
          earliestArchLsn,
          backupBeginLsn,
          dscNodes: Number(dscNodes ?? 1),
          checkedNodes: perNode.length,
          rlogMirrored,
          recyclebinEnabled,
          offsiteCopy,
          // ★ 表空间状态：以前恒为 null，导致 B8 的证据行永远显示「未取到」。
          //   现在从 `DBA_TABLESPACES.STATUS`（自描述）取，取不到才退回数值口径并标注未核实。
          tsStatus: tsStat.label,
          tsStatusSource: tsStat.source,
          tablespacesOffline: tsStat.offline,
        };

        // ★ 分级依据是「**哪个场景救不了**」，不是「哪个参数没设」。
        const scenarios = assessScenarios(facts);
        const grades = gradeScenarios(scenarios);
        // ★ 结构化条件 + 建议：每条场景一张「要求 vs 本库实际」对照表；
        //   建议**只对未满足项**给出，且按「要改的东西」复用（见 scenarios.js 的 ADVICE 表）。
        const rich = assessConditions(scenarios, facts);

        // ---- 正文小节：四节固定 + 「OS 级实测」按实际跑到的条数**连续编号** ----
        // 为什么动态编号：三个 OS 小节各自取决于不同参数（`sshHost` / `sshLogDir` / 非 ASM 路径），
        // 写死「五/六/七」会在只跑到其中一条时留下空缺，读的人会以为漏了一节。
        const body0 = [
          { title: '最要紧的几件事', body: renderTopActions(rich, 5) },
          // ★ 去重后的建议表（DESIGN §26.3）：每件事只说一次，并列出它影响哪些场景
          { title: '该改的 N 件事（按要改的东西去重）', body: renderAdviceList(rich) },
          { title: '逐场景条件对照（建议见上一节）', body: renderScenarioBlocks(rich) },
          { title: '场景能力汇总', body: renderScenarioMatrix(scenarios) },
          { title: '场景判定的实测依据', body: renderScenarioEvidence(scenarios) },
        ];
        /**
         * ★ 「全库逐页裁决」单独成节：它是整份报告里**唯一**能正面回答
         *   「这个库到底有没有坏页」的东西（其余都只能给「还没人碰到过」）。
         *
         * §38：多节点时**小节标题写明节点数**（`osTag` 在模块层）—— 否则读者看到"OS 级实测"
         * 会以为所有节点都查过了（以前正是这个毛病：JDBC 采了 2 个节点、OS 只查了 1 个）。
         */
        const os0 = [
          osCheck && { title: `备份可用性 —— OS 级实测${osTag(osCheck)}`, body: renderOsCheck(osCheck).replace(/^## .*\n/, '') },
          osLogScan && {
            title: `全库页完整性裁决 —— OS 级实测（日志扫描）${osTag(osLogScan)}`,
            body: renderOsLogScan(osLogScan, osAgg).replace(/^## .*\n/, ''),
          },
          osFind && { title: `磁盘上的备份文件 —— OS 级实测（文件系统查找）${osTag(osFind)}`, body: renderOsFind(osFind).replace(/^## .*\n/, '') },
        ].filter(Boolean);
        const sections = [
          ...composeSections(body0, os0),
          { title: '附录 A · 处置能力体检', body: renderReadiness(r) },
          { title: '附录 B · 坏页清单', body: renderList(list) },
          { title: '附录 C · 归档空间', body: renderArchiveParams(chk) },
          {
            title: '附录 D · 备份可用性',
            body: renderBackup({
              backups,
              cov,
              rel,
              supplied,
              pages,
              chain,
              anchors,
              osAccess: sshConfigOf({ args, cfg }) !== null,
            }),
          },
          { title: '附录 E · 部署形态与节点核对', body: renderDsc({ coverage, consistency, failed }) },
          // ★ 词表对照（DESIGN §24）：报告里出现三套词（分级 / 场景能力 / 条件满足），
          //   读者不该自己去映射 —— 附一张表，**且它与渲染层用的是同一份定义**（vocab.js）。
          { title: '附录 F · 输出词表', body: renderVocabTable() },
        ];
        const disclaimer =
          '**「未发现坏页」不等于「没有坏页」。** `V$ERROR_PAGE` 只记录**被访问到**的页 —— ' +
          '库没被人读到的坏页，它一条都不会有。要拿到**全库**的页完整性裁决，' +
          '只能靠全量备份日志里的 `N corrupted pages during backup`（全备会读取每个数据文件的每一页）。\n\n' +
          '本报告全程只读：不扫描、不修复、不改配置、不执行备份或恢复。';

        // ⚠️ **不能用 `toISOString()`**：它会按本地时区解释再转 UTC，
        //   把 10:50 显示成 02:50（本项目 §11.9 记过同一类缺陷）。
        //   这里用本机年月日时分秒直接拼，并**标明是本机时间**（库的时钟可能与之不同）。
        const nowD = new Date();
        const pad2 = (n) => String(n).padStart(2, '0');
        const generatedAtText = `${nowD.getFullYear()}-${pad2(nowD.getMonth() + 1)}-${pad2(nowD.getDate())} ${pad2(nowD.getHours())}:${pad2(nowD.getMinutes())}:${pad2(nowD.getSeconds())}`;
        /**
         * ★ 封面与「评估概况」用的元信息（DESIGN §34）。
         *
         * 版式对齐同族的《达梦数据库安全评估报告》：封面信息带 + 评估概况/版本信息两张
         * **定义式面板**。这里只做一件事 —— 把**已经在手边的实测值**摆进去，
         * 不新增任何查询、也不推断：取不到的照实写「未取到」。
         */
        const reportId = `DM-RCV-${generatedAtText.replace(/[^0-9]/g, '').slice(0, 14)}`;
        const capCount = (k) => scenarios.filter((s) => s.cap === k).length;
        const capability = {
          ok: capCount('ok'),
          partial: capCount('partial'),
          none: capCount('none'),
          unknown: capCount('unknown'),
          na: capCount('na'),
        };
        const osOn = sshConfigOf({ args, cfg }) !== null;
        const newest = backups[0] ?? null;

        const html = buildReportHtml({
          meta: {
            dbName,
            instance: instName,
            version,
            form: Number(dscNodes) > 1 ? `DMDSC 共享存储集群（${dscNodes} 节点）` : '单实例',
            target: perNode.map((n) => n.label).join(' / '),
            nodes: perNode.length,
            account: conn.user,
            reportId,
            scenarioCount: scenarios.length,
            capability,
            boardFoot:
              `另有 <b>${scenarios.length}</b> 个恢复场景的能力判定` +
              `，以及 <b>${pages.length}</b> 条坏页记录。`,
            overview: [
              ['评估对象', esc(perNode.map((n) => n.label).join(' / '))],
              ['数据库 / 实例', `${esc(dbName)} / ${esc(instName)}`],
              [
                '数据来源',
                osOn
                  ? '只读 JDBC 采集（桥只放行 SELECT / WITH）+ 主机上三条<b>只读</b>命令'
                  : '只读 JDBC 采集（桥只放行 SELECT / WITH）；<span class="muted">未配置 OS 访问</span>',
              ],
              ['采集账号', esc(conn.user) + ' <span class="muted">· 权限层由插件自动判定</span>'],
              [
                '判定基准',
                `恢复场景：<b>${scenarios.length}</b> 个（覆盖逻辑损坏 / 物理损坏 / 集群容灾）×「要求 vs 本库实测」；` +
                  // ⚠️ 这一格进的是**评估概况的定义式面板**，那是**原样 HTML**、不走 markdown 管线。
                  //    写 `**实测值**` 会原样印出星号（§37.2③ 那条老毛病又犯了一次，真机成品抓到的）。
                  '每条结论都必须能追到一个<b>实测值</b>（取不到的照实写「未取到」）',
              ],
              [
                '检查面',
                `${scenarios.length} 个场景 · ${grades.length} 条分级结论 · ${list.counts.distinctPages} 条坏页记录`,
              ],
            ],
            versionRows: [
              ['库名 / 实例', `${esc(dbName)} / ${esc(instName)}`],
              ['服务版本', esc(version || '未取到')],
              ['形态 / 节点数', `${esc(Number(dscNodes) > 1 ? 'DMDSC 共享存储集群' : '单实例')} / ${esc(dscNodes ?? '未取到')}`],
              ['采集目标', esc(perNode.map((n) => n.label).join(' / ')) + (failed.length ? ` <span class="mini crit">${failed.length} 个失败</span>` : '')],
              ['归档模式', `ARCH_INI=${esc(chk.items.find((x) => x.name === 'ARCH_INI')?.value ?? '未取到')} · 归档目标 ${chk.destinations.length} 个`],
              [
                '归档链',
                `序列 ${chain.series.length} 个 / 文件 ${chain.fileCount} 个 · 并集覆盖 <code>${esc(chain.coveredFrom ?? '—')} → ${esc(chain.coveredTo ?? '—')}</code>` +
                  (chain.verdict === 'unknown'
                    ? ' <span class="mk m-unk">未判定</span>'
                    : chain.holes.length
                      ? ` <span class="mk m-bad">有洞 ${chain.holes.length} 处</span>`
                      : ' <span class="mk m-ok">并集无洞</span>'),
              ],
              ['未归档尾部', chain.unarchivedLsn === null ? '未取到' : `${esc(chain.unarchivedLsn)} <span class="muted">（LSN 计，仍在联机日志里）</span>`],
              ['可回溯起点', esc(chain.oldestCreateTime ?? '未取到') + ' <span class="muted">· 最早归档文件的创建时间</span>'],
              [
                '备份账本',
                backups.length === 0
                  ? '<span class="mk m-warn">0 份</span> <span class="muted">账本为空不等于没有备份</span>'
                  : `${backups.length} 份 · 最近一次 <code>${esc(newest?.name ?? '—')}</code> @ ${esc(fmtStamp(newest?.time))}`,
              ],
              ['坏页记录', `${list.counts.distinctPages} 条 <span class="muted">· V$ERROR_PAGE 只记录被访问到的页</span>`],
              ['表空间状态', esc(tsStat.label ?? '未取到')],
              [
                '时间↔LSN 精度',
                anchors?.dense
                  ? `最密 ${esc(fmtMinutes(anchors.minGapHours * 60))}（${esc(anchors.minGapSource ?? '未取到')}）· 窗口外最大间距 ${esc(fmtMinutes((anchors.maxGapHours ?? 0) * 60))}`
                  : `锚点 ${anchors?.count ?? 0} 个${anchors?.maxGapHours != null ? ` · 最大间距 ${esc(fmtMinutes(anchors.maxGapHours * 60))}` : ''}`,
              ],
              ['OS 级实测', osOn ? `${['备份集校验', '全库页裁决', '文件系统查找'].filter((_, i) => [osCheck, osLogScan, osFind][i]).length} 项已执行 <span class="muted">· 只读命令</span>` : '<span class="muted">未启用（纯 JDBC）</span>'],
            ],
            overviewNote:
              '本报告里的每个数字都能指到**一次实测查询或一条只读命令**；取不到的照实写「未取到」，' +
              '**不推断成"正常"**。判定规则见本报告第 5~7 节，**不做不可解释的综合评分**。',
          },
          grades,
          sections,
          disclaimer,
          generatedAt: generatedAtText,
        });

        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        let dir = String(args.outDir ?? path.join(home, 'dm-recovery-reports'));
        if (dir.startsWith('~')) dir = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', dir.slice(1));
        /**
         * ⚠️ 这里**不能**用 `ensureHome()`：那个函数会顺手建齐
         * `drivers/ java/ runtime/ classes/` 四件套（那是**插件工作目录**的骨架）。
         * 报告目录只需要"存在"，否则每次出报告都会在**交付目录**里多出四个空文件夹 ——
         * 真机上就是这么发现的（第一次从 GUI 生成报告时，输出目录里冒出了这四个目录）。
         */
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `dm-recovery-${dbName}-${stamp}.html`);
        // 机器可读的第二份交付物：与 HTML 同名不同后缀，放在同一目录（便于一起归档/对比）
        const findingsFile = path.join(dir, `dm-recovery-${dbName}-${stamp}.findings.json`);
        fs.writeFileSync(file, html, 'utf8');

        const by = (lv) => grades.filter((x) => x.level === lv).length;
        const capN = (k) => scenarios.filter((s) => s.cap === k).length;
        // 分级项 → 结论项（ID 用 `grade.<level>`：分级按等级分桶，每桶最多一条）
        const reportFindings = grades.map((x) =>
          finding(
            ID.grade(x.level),
            x.level,
            x.title,
            x.detail,
            // 该桶覆盖了哪些场景：让 JSON 消费者知道"谁"触发这条
            scenarios
              .filter((s) => (x.level === 'crit' ? s.cap === 'none' : x.level === 'warn' ? s.cap === 'partial' : s.cap === 'unknown'))
              .map((s) => `${ID.scenario(s.id)} ${s.name}（${CAP_LABEL_FOR[s.cap] ?? s.cap}）`),
            null,
            // 留痕：分级不是"实测值"，是**由实测事实推导**出来的汇总
            PROV.derived('场景引擎（facts → 16 场景判定 → 分级）'),
          ),
        );
        /**
         * 结论项 = 场景分级 + **OS 级实测**。
         *
         * ★ OS 三项（真机上发现的缺口）：第一版只在正文/HTML 里渲染它们，
         *   于是 HTML 说「备份集校验通过」、而 `findings.json` 里一条 OS 结论都没有 ——
         *   **一半交付物有、另一半没有**，比都没有更糟。现在与 `backup` 共用 `osFindingsOf`。
         */
        const osFindings = osFindingsOf({ osCheck, osLogScan, osFind });
        const allFindings = [...osFindings, ...reportFindings];
        // ★ 结论只有一处定义，信封与正文**共用**它 —— 两处各写一遍迟早各说各话（§26 的老毛病）。
        const reportConclusion = `已生成评估报告：${file}`;
        const env = buildResult({
          action: 'report',
          generatedAt: generatedAtText,
          level: topLevelOf(allFindings),
          conclusion: reportConclusion,
          summary: {
            // 五项都要给：消费者拿 ok+partial+none+unknown+na 应当等于 total（少一项就会对不上）
            scenarios: {
              ok: capN('ok'),
              partial: capN('partial'),
              none: capN('none'),
              unknown: capN('unknown'),
              na: capN('na'),
              total: scenarios.length,
            },
            pages: { distinct: list.counts.distinctPages, needAttention: list.needAttention.length },
            nodes: { checked: perNode.length, failed: failed.length },
            backups: backups.length,
            archiveContinuous: chain.verdict === 'unknown' ? null : chain.verdict === 'continuous',
          },
          findings: allFindings,
          result: {
            reportPath: file,
            scenarios: scenarios.map((s) => ({
              id: ID.scenario(s.id),
              name: s.name,
              group: s.group,
              capability: s.cap,
              capabilityLabel: CAP_LABEL_FOR[s.cap] ?? s.cap,
              how: s.how,
              gap: s.gap ?? null,
              // 条件带稳定 ID，便于"这条要求"跨次对比
              conditions: (rich.find((r2) => r2.id === s.id)?.conds ?? []).map((c, i) => ({
                id: ID.condition(s.id, i + 1),
                key: c.key,
                name: c.name,
                require: c.require,
                actual: c.actual,
                state: c.state,
              })),
            })),
            facts,
            archiveChain: chain,
            timeLsnAnchors: anchors,
            backups,
            // OS 级三项（命令 + 状态），与 `backup` 动作同形
            os: osResultOf({ osCheck, osLogScan, osFind }),
            coverage: { newest: cov.newest?.name ?? null, redoGap: cov.redoGap, span: cov.span },
            archiveParams: chk.items,
            deployment: { coverage, consistency, failed },
          },
          meta: mkMeta(conn, {
            db: dbName,
            instance: instName,
            version,
            form: Number(dscNodes) > 1 ? `DMDSC 共享存储集群（${dscNodes} 节点）` : '单实例',
            nodes: perNode.map((n) => n.label),
          }),
          disclaimer,
          reportPath: file,
          text: renderResult({
            action: 'report',
            level: topLevelOf(allFindings),
            conclusion: reportConclusion,
            meta: [
              `分级合计：${['crit', 'warn', 'info', 'unknown'].map((lv) => `${levelTag(lv)} ${by(lv)}`).join(' ／ ')}`,
              `场景能力合计：${Object.entries(CAP_MARK).map(([k, mk]) => `${mk} ${CAP_LABEL_FOR[k] ?? k} ${capN(k)}`).join(' ／ ')}（共 ${scenarios.length} 个场景）`,
              `采集目标：${perNode.map((n) => n.label).join(' / ')}${failed.length ? `（另有 ${failed.length} 个目标连接失败，未纳入）` : ''}`,
            ],
            points: [
              ...(grades.length
                // `title` 自带的 `**…**` 不要再包一层（否则出现 `****` —— 真机首版踩过）
                ? grades.map((x) => point(x.level, `\`${ID.grade(x.level)}\` ${x.title} —— ${String(x.detail).split('\n')[0]}`))
                : []),
            ].concat(grades.length ? [] : [point(null, '本次未发现需要分级的问题。')]),
            sections: [
              {
                title: '报告落盘位置与结构',
                body:
                  `- HTML：\`${file}\`\n` +
                  `- 机器可读：\`${findingsFile}\`（去掉正文，只承载结论与事实）\n` +
                  `- 生成时间：${generatedAtText}（**本机时间**，库服务器时钟可能与之不同）\n` +
                  `- 报告小节（HTML 内的顺序）：\n` +
                  sections.map((s) => `  - ${s.title}`).join('\n'),
              },
              {
                title: '本次结论项（稳定 ID）',
                body:
                  (allFindings.length
                    ? allFindings
                        .map((f) => `- \`${f.id}\`${f.level ? ` [${levelTag(f.level)}]` : ''} ${f.title}`)
                        .join('\n')
                    : '- （无）') +
                  '\n\n> ID 是**语义 slug 不是流水号** —— 同一个结论跨次运行 ID 不变，可直接做对比与趋势。',
              },
            ],
            boundaries: bnd([disclaimer]),
          }),
          legacy: {
            verdict: `严重 ${by('crit')} 项、警告 ${by('warn')} 项`,
            distinctPages: list.counts.distinctPages,
            needAttention: list.needAttention.length,
          },
        });
        // ★ 第二份交付物：机器可读的 findings.json（DESIGN §25.3）。
        //   写在 HTML 旁边、同名不同后缀，便于一起归档与对比。
        fs.writeFileSync(findingsFile, resultJson(env), 'utf8');
        return { ...env, findingsPath: findingsFile };
      }

      if (args.action === 'readiness') {
        // DMDSC：逐节点核配置。不给 targets 时退化成单节点，但覆盖度会**如实说明**「没检查全」。
        const targetList = parseTargets(args.targets);
        const sweep =
          targetList.length > 0
            ? targetList
            : [{ host: conn.host, port: conn.port, label: `${conn.host}:${conn.port}` }];
        const perNode = [];
        const failed = [];
        for (const t of sweep) {
          try {
            const d = await runQueries(
              { ...conn, host: t.host, port: t.port },
              [...FORM_QUERIES, ...READINESS_QUERIES, ...ARCHIVE_QUERIES],
            );
            perNode.push({ label: t.label, ...d });
          } catch (e) {
            failed.push({ label: t.label, error: String(e?.message ?? e) });
          }
        }
        if (perNode.length === 0) {
          // ★ §39：同一套措辞判定，两条失败路径不许各写一句
          const head = collectionFailureHeadline(failed);
          const conclusion = `**未做任何判断** —— ${head.title}`;
          return buildResult({
            action: 'readiness',
            generatedAt: localStamp(),
            level: 'unknown',
            conclusion,
            summary: { pages: null, nodes: { checked: 0, failed: failed.length }, backups: null },
            findings: [
              finding(
                ID.form('deployment'),
                'unknown',
                head.title,
                '无法完成采集时**不给任何结论** —— 「没查到」不等于「没问题」。',
                failed.map((f) => `${f.label}：${f.error}`),
              ),
            ],
            result: { targets: failed, errorKind: head.kind },
            meta: mkMeta(conn, { nodes: [] }),
            disclaimer: '未连接成功，本次未做任何判断。',
            text: renderResult({
              action: 'readiness',
              level: 'unknown',
              conclusion,
              points: failed.map((f) => point('unknown', `\`${f.label}\`：${f.error}`)),
              boundaries: bnd(['无法完成采集时不给任何结论 —— 「没查到」不等于「没问题」。', ...head.advice]),
            }),
            legacy: { verdict: head.title, distinctPages: 0, needAttention: failed.length },
          });
        }
        const primary = perNode[0];
        const r = judgeReadiness(primary);
        const consistency = judgeConsistency(perNode);
        const coverage = describeCoverage({
          dscNodes: scalarOf(primary.database, '^DSC_NODES$'),
          targets: targetList,
          connected: perNode.map((n) => n.label),
          failedCount: failed.length,
        });
        /**
         * 四条处置路径 → 结论项。
         *
         * ★ 级别映射是**真机验证时改正**的（见 §25.4）：第一版把 `high-risk` 映射成 `crit`，
         *   而「跳过损坏页」这条路径**在任何库上恒为 high-risk** —— 于是每次 readiness 都报
         *   「严重」，这是**永久假告警**（假告警会让真告警被忽略，§12.3）。
         *   同理「主动扫描不可用」（`PAGE_CHECK_POLICY=1` 是达梦的默认且推荐值）
         *   也不是"本库的毛病"，它是**工具的边界说明**。
         *
         * 所以：只有**能通过运维动作改善的能力缺失**才给级别；
         * 「高风险路径警示」与「工具自身的边界」记为 `null`（陈述，不进分级计数）。
         */
        const pathLevel = (p) => {
          if (p.available === 'yes') return null; // 可用 → 不进 findings
          if (p.id === 'skip-page') return null; // 高风险警示：只陈述，不作为本库的问题
          if (p.id === 'active-scan') return null; // 工具边界（PAGE_CHECK_POLICY=1）—— 不是本库的毛病
          if (p.id === 'restore') return r.archived ? 'info' : 'crit'; // 非归档 = 真问题：没有时间点恢复能力
          return p.available === 'high-risk' ? null : 'warn';
        };
        const rdFindings = [
          ...r.paths
            .map((p) => ({ p, lv: pathLevel(p) }))
            .filter((x) => x.lv !== null || x.p.id === 'skip-page' || x.p.id === 'active-scan')
            .map(({ p, lv }) => finding(ID.readiness(p.id), lv, p.name, p.reason, p.evidence)),
          ...(consistency.divergent.length > 0
            ? [
                finding(
                  ID.form('consistency'),
                  'warn',
                  `节点间配置有 ${consistency.divergent.length} 处不一致`,
                  'DMDSC 上参数是节点级的 —— 只连一个节点看不出对端漏配。',
                  consistency.divergent.map((d) => `${d.name}：${(d.vals ?? []).join(' ／ ')}`),
                ),
              ]
            : []),
          ...(coverage.state === 'single' || coverage.state === 'full'
            ? []
            : [
                finding(
                  ID.form('coverage'),
                  coverage.state === 'partial' ? 'warn' : 'unknown',
                  `节点覆盖度：${coverage.state}`,
                  coverage.note ?? '未把所有节点纳入检查 —— 留白会被读成「没问题」。',
                  [`已连接：${perNode.map((n) => n.label).join(' / ')}`, `失败：${failed.length}`],
                ),
              ]),
        ];
        const rdLevel = topLevelOf(rdFindings);
        return buildResult({
          action: 'readiness',
          generatedAt: localStamp(),
          level: rdLevel,
          conclusion: r.verdict,
          summary: {
            pages: null,
            nodes: { checked: perNode.length, failed: failed.length },
            backups: null,
          },
          findings: rdFindings,
          result: {
            form: r.form,
            archived: r.archived,
            archMode: r.archMode,
            pageCheckPolicy: r.policy,
            ptxRollback: r.ptxRollback,
            pageSize: r.pageSize,
            // **完整记录**四条路径（不只"需要关注"的）—— findings 只放要看的，result 放全部
            paths: r.paths,
            consistency: { labels: consistency.labels, divergent: consistency.divergent, rows: consistency.rows },
            coverage,
            targets: perNode.map((n) => n.label),
            failed,
          },
          meta: mkMeta(conn, {
            db: singleRowFields(primary.database, ['NAME']).NAME ?? null,
            version: singleRowFields(primary.instance, ['SVR_VERSION']).SVR_VERSION ?? null,
            form: r.form.label,
            nodes: perNode.map((n) => n.label),
          }),
          disclaimer: '「未发现坏页」不等于「没有坏页」；`PAGE_CHECK_POLICY=1` 时本插件不做任何主动扫描。',
          text: renderResult({
            action: 'readiness',
            level: rdLevel,
            conclusion: r.verdict,
            meta: [
              `目标：${perNode.map((n) => n.label).join(' / ')}（覆盖度：${coverage.state}${failed.length ? `，${failed.length} 个连接失败` : ''}）`,
            ],
            points: [
              // 要点只给**聚合事实**，不复述下面「依据」里的逐条明细
              point(
                r.paths.some((p) => p.available === 'yes') ? null : 'warn',
                `四条处置路径：可用 **${r.paths.filter((p) => p.available === 'yes').length}** ／ ` +
                  `不可用 **${r.paths.filter((p) => p.available === 'no').length}** ／ ` +
                  `受限 **${r.paths.filter((p) => p.available === 'limited').length}** ／ ` +
                  `高风险 **${r.paths.filter((p) => p.available === 'high-risk').length}**（明细见「依据 1」）`,
              ),
              ...r.paths
                .filter((p) => p.available === 'no' || p.available === 'high-risk')
                .map((p) => point(p.available === 'high-risk' ? 'crit' : 'warn', `\`${ID.readiness(p.id)}\` **${p.name}** 不可用：${String(p.reason).split('。')[0]}。`)),
              ...(consistency.divergent.length > 0
                ? [point('warn', `节点间配置有 **${consistency.divergent.length}** 处不一致`)]
                : perNode.length > 1
                  ? [point(null, '节点间配置**一致**')]
                  : []),
            ],
            sections: [
              { title: '处置能力体检', body: renderReadiness(r) },
              // `renderDsc` 内部自带 `## 部署形态` 这类 H2 —— 必须走拆分，
              // 否则它会**漏成顶层小节**（真机复跑时 readiness 多出一个 `## 部署形态` 就是这么来的）。
              ...splitH2Sections(renderDsc({ coverage, consistency, failed }), '部署形态与节点核对'),
            ],
            boundaries: bnd(r.warnings),
          }),
          legacy: { verdict: r.verdict, distinctPages: 0, needAttention: consistency.divergent.length },
        });
      }

      const data = await runQueries(conn, LIST_QUERIES);
      const list = buildPageList(data);

      if (args.action === 'list') {
        // DMDSC：逐节点查 V$ERROR_PAGE，保住「哪个节点记录到」这个 GV$ 给不了的信息。
        const targetList = parseTargets(args.targets);
        let attribution = null;
        if (targetList.length > 0) {
          const perNode = [];
          const sweepFailed = [];
          for (const t of targetList) {
            try {
              const d = await runQueries({ ...conn, host: t.host, port: t.port }, [
                { key: 'errorPage', sql: 'SELECT * FROM V$ERROR_PAGE' },
              ]);
              perNode.push({ label: t.label, res: d.errorPage });
            } catch (e) {
              sweepFailed.push({ label: t.label, error: String(e?.message ?? e) });
            }
          }
          attribution = renderNodeAttribution({
            attributed: attributePages(perNode),
            labels: perNode.map((n) => n.label),
            failed: sweepFailed,
          });
        }
        // 逐页结论项：ID 是 `page.<TS_ID>.<FILE_ID>.<PAGE_NO>` —— **语义可寻址**，
        // 同一个坏页跨次运行 ID 不变（这是 ID 的全部意义）。
        const pageFindings = list.entries.map((e) =>
          finding(
            ID.page(e.tsId, e.fileId, e.pageNo),
            e.status === 're-corrupted' ? 'crit' : e.status === 'repaired' ? 'info' : 'warn',
            `页 ${e.page}（${e.statusText}）`,
            `表空间 TS_ID=${e.tsId} ／ 文件 ${e.fileName ?? '—'} ／ 报错 ${e.errorCount} 次 ／ 修复 ${e.repairCount} 次`,
            [
              `最近报错 ${fmtT(e.lastError)}`,
              `最近修复 ${fmtT(e.lastRepair)}`,
              ...(e.skips ?? []).map((s) => `跳页记录：会话 ${s.sessId} / 语句 ${s.stmtId} / 共跳 ${s.nTotal} 页`),
            ],
          ),
        );
        // 无坏页时给一条 `pages.none-found` 陈述（**不是** `page.none.found.0` 那种哨兵 —— 真机验证时改的）
        const listFindings =
          list.counts.distinctPages === 0
            ? [
                finding(
                  ID.pages('none-found'),
                  'info',
                  'V$ERROR_PAGE 无记录',
                  // ★ §46.4-①：**这句免责原来是错的**。原文说"该视图只记录被访问到的页 ——
                  //   本结果为空只代表还没有人碰到过"。真机实测（DESIGN §46）：读到坏页会让
                  //   DM **直接 abort 整个实例**，而重启后 `V$ERROR_PAGE` **仍然是 0 行** ——
                  //   页被访问到了，它也没记。所以空的真正含义是"这个视图不承载页校验失败这类事件"，
                  //   而不是"还没人碰到过"。
                  '注意：**这个视图为空，几乎说明不了什么**。真机实测：读到坏页时 DM 会' +
                    '**直接 abort 整个实例**（`[EID:48] Server page check error` + `SHUTDOWN ABORT`），' +
                    '而重启后 `V$ERROR_PAGE` **仍然是 0 行** —— 页被访问到了它也不记。' +
                    '要判断"到底有没有坏页"，只能看**实例日志**里的页校验失败记录（需 OS 访问），' +
                    '或停库跑 DM 自带的 `dmdbchk`（离线、权威、且能给出所属表名）。',
                  [`V$ERROR_PAGE ${list.counts.errorRows} 行 ／ V$REPAIRED_PAGE ${list.counts.repairedRows} 行 ／ V$SQL_SKIP_CPAGE ${list.counts.skipRows} 行`],
                ),
              ]
            : pageFindings;
        const listLevel = topLevelOf(listFindings);
        return buildResult({
          action: 'list',
          generatedAt: localStamp(),
          level: listLevel,
          conclusion:
            list.counts.distinctPages === 0
              ? '**未发现坏页记录**（这个视图为空**几乎说明不了什么** —— 见要点）'
              : `识别到 **${list.counts.distinctPages}** 个不同的损坏页，其中 **${list.needAttention.length}** 页需要关注`,
          summary: null,
          findings: listFindings,
          result: {
            counts: list.counts,
            needAttention: list.needAttention.map((e) => ID.page(e.tsId, e.fileId, e.pageNo)),
            distinctPages: list.counts.distinctPages,
            attribution: attribution ?? null,
          },
          meta: mkMeta(conn),
          disclaimer: list.disclaimer,
          text: renderResult({
            action: 'list',
            level: listLevel,
            conclusion:
              list.counts.distinctPages === 0
                ? '**未发现坏页记录**（这个视图为空**几乎说明不了什么** —— 见要点）'
                : `识别到 **${list.counts.distinctPages}** 个不同的损坏页，其中 **${list.needAttention.length}** 页需要关注`,
            meta: [
              `原始记录：V$ERROR_PAGE ${list.counts.errorRows} 行 ／ V$REPAIRED_PAGE ${list.counts.repairedRows} 行 ／ V$SQL_SKIP_CPAGE ${list.counts.skipRows} 行`,
            ],
            points: [
              ...(list.counts.distinctPages > 0
                ? [
                    point('warn', `从未修复：**${list.entries.filter((e) => e.status === 'never-repaired').length}** 页`),
                    point(
                      'crit',
                      `修复后**再次损坏**：**${list.entries.filter((e) => e.status === 're-corrupted').length}** 页 —— 反复损坏同一位置是**存储问题信号**（查盘 / RAID 卡 / HBA），不是反复修数据`,
                    ),
                    point(null, `已修复：**${list.entries.filter((e) => e.status === 'repaired').length}** 页（其 ID 见「依据」与 findings.json）`),
                  ]
                : []),
            ],
            sections: [
              { title: '坏页清单', body: renderList(list) },
              ...(attribution ? [{ title: '节点归属（DMDSC）', body: attribution }] : []),
            ],
            boundaries: bnd([list.disclaimer, `逐页定位到对象请用 \`action=triage\`。`]),
          }),
          legacy: { verdict: '', distinctPages: list.counts.distinctPages, needAttention: list.needAttention.length },
        });
      }

      // ---- triage：逐页定位到对象 + 给唯一推荐处置路径 ----
      // ⚠️ 必须把 FORM / READINESS 查询也带上：judgeReadiness 依赖 `V$DATABASE.ARCH_MODE`
      //    与 `V$DM_INI` 的参数。先前这里只传 LIST_QUERIES 的结果，
      //    导致 triage 结论里把「归档已开」**误报成「非归档：中间数据全丢」** ——
      //    同一份环境上 readiness 说归档已开、triage 说非归档，自相矛盾。
      const formAndReadiness = await runQueries(conn, [...FORM_QUERIES, ...READINESS_QUERIES]);
      const r = judgeReadiness({ ...data, ...formAndReadiness });
      const targets = list.entries.filter((e) => e.status === 'never-repaired' || e.status === 're-corrupted');
      const tsRes = await runQueries(conn, [TABLESPACE_QUERY]);
      const tsMap = tablespaceMap(tsRes.tablespaces);
      const lookups = buildReverseLookups(targets, tsMap);
      // 反查一律走 DBA_EXTENTS 区间匹配（字典查询），绝不扫用户表
      const withSql = lookups.filter((l) => l.sql);
      let results = [];
      if (withSql.length > 0) {
        const res = await runQueries(conn, withSql.map((l, i) => ({ key: `lk${i}`, sql: l.sql })));
        results = withSql.map((_, i) => res[`lk${i}`]);
      }
      const enriched = attachObjects(targets, lookups, results);

      const triageFindings = [
        ...(list.entries.length === 0
          ? [finding(ID.pages('none-found'), 'info', '无需逐页分诊', '未发现坏页记录。', [list.disclaimer])]
          : enriched.map((e) =>
              finding(
                ID.page(e.tsId, e.fileId, e.pageNo),
                e.status === 're-corrupted' ? 'crit' : 'warn',
                `页 ${e.page}（${e.statusText}）`,
                e.object
                  ? `定位到 \`${e.object.owner}.${e.object.segmentName}\`（${e.object.segmentType}）`
                  : `未定位到对象：${e.objectNote}`,
                [
                  `表空间 ${tsMap[String(e.tsId)] ?? '—'}（TS_ID=${e.tsId}）`,
                  `文件 ${e.fileName ?? '—'}`,
                  ...(e.object ? [`区位置 BLOCK_ID=${e.object.blockId} BLOCKS=${e.object.blocks}`] : []),
                  `报错 ${e.errorCount} 次 ／ 修复 ${e.repairCount} 次`,
                ],
              ),
            )),
      ];
      const triageLevel = topLevelOf(triageFindings);
      return buildResult({
        action: 'triage',
        generatedAt: localStamp(),
        level: triageLevel,
        conclusion:
          list.entries.length === 0
            ? '未发现坏页记录，无需逐页分诊'
            : `${r.verdict}；需逐页处置 **${targets.length}** 页`,
        summary: { nodes: null, backups: null },
        findings: triageFindings,
        result: {
          recommendedPath: r.verdict,
          paths: r.paths,
          pages: enriched.map((e) => ({
            id: ID.page(e.tsId, e.fileId, e.pageNo),
            status: e.status,
            object: e.object ?? null,
            objectNote: e.objectNote ?? null,
            skips: e.skips ?? [],
          })),
        },
        meta: mkMeta(conn),
        disclaimer: list.disclaimer,
        text: renderResult({
          action: 'triage',
          level: triageLevel,
          conclusion:
            list.entries.length === 0
              ? '未发现坏页记录，无需逐页分诊'
              : `${r.verdict}；需逐页处置 **${targets.length}** 页`,
          meta:
            targets.length > 0
              ? [`对象反查：已定位 **${enriched.filter((e) => e.object).length}** ／ ${enriched.length}`]
              : [],
          points: [
            // 同样是聚合，不复述「依据」里的逐页明细
            point(
              targets.some((e) => e.status === 're-corrupted') ? 'crit' : targets.length > 0 ? 'warn' : null,
              `需逐页处置 **${targets.length}** 页：从未修复 **${targets.filter((e) => e.status === 'never-repaired').length}** ／ ` +
                `修复后再次损坏 **${targets.filter((e) => e.status === 're-corrupted').length}**`,
            ),
            point(
              enriched.every((e) => e.object) ? null : 'warn',
              `对象反查：已定位 **${enriched.filter((e) => e.object).length}** ／ ${enriched.length}` +
                (enriched.some((e) => !e.object) ? '（未定位的见「依据」里的 `objectNote`）' : ''),
            ),
          ],
          sections: [{ title: '逐页定位与处置路径', body: renderTriage(list, enriched, tsMap) }],
          boundaries: bnd([list.disclaimer]),
        }),
        legacy: { verdict: r.verdict, distinctPages: list.counts.distinctPages, needAttention: list.needAttention.length },
      });
      } catch (e) {
        // 兜底：连接 / 桥 / 任何未预期的失败 → 标准信封 + 可执行的一句话
        return connectionFailureEnvelope({ action: args.action, args, error: e });
      }
    },
  });

  ctx.tools.register(tool);
}

const name = 'dm-recovery-readiness';

export { apply, inject, name };
