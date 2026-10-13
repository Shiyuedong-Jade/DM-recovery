/**
 * 真机回归：**六个 action × 信封不变量 × 交付物形状**（DESIGN §37）。
 *
 * 为什么需要它：`tools/smoke.mjs` 的 500+ 项断言**全是离线的**（不连库），
 * 真机只能靠人工跑 `live-check.mjs` 看输出 —— 改一行代码，没人知道我有没有把信封改坏。
 * 这个脚本把"真机上必须成立的那些事"固化成断言：信封形状、等级与结论项**同源**、
 * ID 落在白名单、**需求达成度已整项移除**（§29.10：给了相关参数也不许再出现 `req.*`）、
 * DSC 覆盖数、OS 三项、报告落盘与版式结构、以及**口令不落盘**（§36 的承诺，现在自动验）。
 *
 * 用法（口令只从环境变量来，**不写进任何文件**）：
 *   $env:DM_HOST='10.127.11.61:7236'; $env:DM_USER='awr1'; $env:DM_PASSWORD='…'
 *   node tools/live-smoke.mjs
 *
 * 可选环境变量：
 *   DM_TARGETS             DMDSC 各节点（逗号分隔的 host:port）→ 会额外断言"两节点都采到"
 *   SSH_HOST / SSH_USER / SSH_PASSWORD / SSH_HOST_KEY / SSH_LOG_DIR / SSH_SCRIPT_PATH /
 *   DMRMAN_PATH / DMRMAN_DCR_INI   → 给了会额外断言"OS 三项真的跑了"
 *   （需求相关变量 `RPO_MINUTES` / `TARGET_WINDOW` / `TARGET_TIME` 已随功能整项移除，§29.10）
 *
 * 退出码：`0` 全部通过；`1` 有断言失败；`2` **环境不可用**（连不上库）—— 与"代码坏了"分开，
 *         免得库没起来时误报成回归失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

/**
 * ★ 插件工作目录：**默认那个在沙箱下不可写**（DESIGN §38.4，实测踩过）。
 *
 * `~/.dsh/dm-recovery-readiness/runtime` 在工作区之外，而本脚本常在 **workspace-write** 沙箱里跑，
 * 于是插件写 SQL 临时文件时 EPERM，六个 action 全部变成
 * 「所有目标节点均无法连接」——**看起来像库挂了，其实是本地写权限**（差一点又误判成回归失败）。
 *
 * 所以：没显式给 `dm_recovery_readiness_HOME` 时，脚本自己把它指到仓库内一份可写副本，
 * 并把**驱动 jar**（及其编译产物）搬过去。显式给了就用给的（CI / 真机上按原样跑）。
 */
const REAL_HOME = path.join(os.homedir(), '.dsh', 'dm-recovery-readiness');
const HOME = process.env.dm_recovery_readiness_HOME ?? path.resolve(PKG, '..', '.live-home', 'plugin-home');
if (!process.env.dm_recovery_readiness_HOME) {
  for (const sub of ['drivers', 'java', 'runtime', 'classes']) fs.mkdirSync(path.join(HOME, sub), { recursive: true });
  const copyDir = (from, to, filter) => {
    if (!fs.existsSync(from)) return 0;
    let n = 0;
    for (const f of fs.readdirSync(from)) {
      if (!filter(f)) continue;
      const dst = path.join(to, f);
      if (!fs.existsSync(dst)) {
        fs.copyFileSync(path.join(from, f), dst);
        n += 1;
      }
    }
    return n;
  };
  const jars = copyDir(path.join(REAL_HOME, 'drivers'), path.join(HOME, 'drivers'), (f) => /\.jar$/i.test(f));
  copyDir(path.join(REAL_HOME, 'classes'), path.join(HOME, 'classes'), (f) => /\.class$/i.test(f));
  if (fs.readdirSync(path.join(HOME, 'drivers')).filter((f) => /\.jar$/i.test(f)).length === 0) {
    console.error(
      `插件工作目录里没有 JDBC 驱动（找过 ${path.join(REAL_HOME, 'drivers')}）。\n` +
        `把 DmJdbcDriver8.jar 放进 ${path.join(HOME, 'drivers')}，或用 dm_recovery_readiness_HOME 指定一个含驱动的目录。`,
    );
    process.exit(2);
  }
  process.env.dm_recovery_readiness_HOME = HOME;
  console.log(`[环境] 插件工作目录 → ${HOME}（搬来驱动 ${jars} 个；默认目录在沙箱外不可写）`);
}

let failed = 0;
let skipped = 0;
const ok = (c, m) => {
  console.log(`  [${c ? '通过' : '失败'}] ${m}`);
  if (!c) failed += 1;
};
const skip = (m) => {
  console.log(`  [跳过] ${m}`);
  skipped += 1;
};

const plugin = await import(pathToFileURL(path.join(PKG, 'lib', 'index.js')).href);
const res = await import(pathToFileURL(path.join(PKG, 'lib', 'result.js')).href);
let registered = null;
plugin.apply({ tools: { register: (t) => { registered = t; return () => {}; } }, get: () => undefined }, {});

const PASSWORD = process.env.DM_PASSWORD;
if (!PASSWORD) {
  console.error('缺少 DM_PASSWORD 环境变量（口令不走命令行参数，避免进 shell 历史）。');
  process.exit(2);
}
const baseArgs = {
  host: process.env.DM_HOST ?? '127.0.0.1',
  user: process.env.DM_USER ?? 'SYSDBA',
  password: PASSWORD,
  ...(process.env.DM_PORT ? { port: Number(process.env.DM_PORT) } : {}),
  ...(process.env.DM_TARGETS ? { targets: process.env.DM_TARGETS } : {}),
};
const sshArgs = process.env.SSH_HOST
  ? {
      sshHost: process.env.SSH_HOST,
      sshUser: process.env.SSH_USER ?? 'root',
      sshPassword: process.env.SSH_PASSWORD ?? '',
      ...(process.env.SSH_HOST_KEY ? { sshHostKey: process.env.SSH_HOST_KEY } : {}),
      ...(process.env.SSH_LOG_DIR ? { sshLogDir: process.env.SSH_LOG_DIR } : {}),
      ...(process.env.SSH_SCRIPT_PATH ? { sshScriptPath: process.env.SSH_SCRIPT_PATH } : {}),
      ...(process.env.DMRMAN_PATH ? { dmrmanPath: process.env.DMRMAN_PATH } : {}),
      ...(process.env.DMRMAN_DCR_INI ? { dmrmanDcrIni: process.env.DMRMAN_DCR_INI } : {}),
    }
  : {};

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-live-smoke-'));
const ACTIONS = ['readiness', 'list', 'triage', 'capacity', 'backup', 'report'];
const envelopes = {};

const ENVELOPE_KEYS = [
  'tool', 'resultVersion', 'action', 'generatedAt', 'generatedAtSource', 'conclusion',
  'summary', 'findings', 'result', 'meta', 'disclaimer', 'text',
];
// ★ §29.10：`requirements` 已随需求达成度整项移除 —— 这里少了它，**同时也就锁住了它不许回来**
//   （多一个键会被 `env.summary` 的"只多不少"？不 —— 所以下面另有一条断言专门盯它回来）
const SUMMARY_KEYS = ['byLevel', 'total', 'scenarios', 'pages', 'nodes', 'backups', 'archiveContinuous'];

console.log(`\n=== 1. 六个 action 连真机跑一遍（${baseArgs.host}）===`);
for (const action of ACTIONS) {
  let env;
  try {
    env = await registered.execute({ ...baseArgs, ...sshArgs, action, ...(action === 'report' ? { outDir: OUT } : {}) }, {});
  } catch (e) {
    ok(false, `${action}：**抛异常**了（应该走兜底信封而不是抛栈）：${String(e?.message ?? e)}`);
    continue;
  }
  envelopes[action] = env;
  /**
   * ★ 「环境不可用 → 退出码 2」的判据必须**覆盖两条失败路径**（DESIGN §45.3 踩到的）。
   *
   * 原来只认 `form.connection` —— 那是**单目标**连接失败时用的 ID。
   * 给了 `DM_TARGETS`（多节点）时，全节点失败走的是**另一条**分支，结论项 ID 是 `form.deployment`，
   * 于是"库全关了"被当成"断言失败"，一次报出 10 条红：
   * 读者会以为是自己刚改的代码坏了（实际只是 DMDSC 停机）。
   *
   * 判据用**结果**而不是 ID 更稳：`summary.nodes.checked === 0 && failed > 0` = 一个目标都没采到。
   */
  const zeroCollected =
    action === 'readiness' && (env.summary?.nodes?.checked ?? 0) === 0 && (env.summary?.nodes?.failed ?? 0) > 0;
  const connFail = env.findings?.some((f) => f.id === 'form.connection' || f.id === 'form.deployment');
  if (connFail || zeroCollected) {
    console.error(`\n环境不可用：${baseArgs.host} 一个目标都没采到。原始错误见下：`);
    console.error(String(env.result?.rawError ?? env.conclusion).slice(0, 300));
    if (env.result?.targets) console.error(`各目标：${JSON.stringify(env.result.targets).slice(0, 300)}`);
    console.error('（这不是回归失败 —— 退出码 2 表示"库没起来/连不上"。）');
    fs.rmSync(OUT, { recursive: true, force: true });
    process.exit(2);
  }
  const missing = ENVELOPE_KEYS.filter((k) => !(k in env));
  ok(missing.length === 0, `${action}：信封字段齐全${missing.length ? `（缺 ${missing.join(',')}）` : ''}`);
}

console.log('\n=== 2. 信封不变量（§25 / §29 / §35）===');
for (const action of ACTIONS) {
  const env = envelopes[action];
  if (!env) continue;
  ok(env.tool === 'dm_recovery_readiness' && env.resultVersion === 1, `${action}：tool / resultVersion 固定`);
  ok(env.action === action, `${action}：action 字段与实际动作一致`);
  ok(!('text' in env) === false && typeof env.text === 'string' && env.text.length > 0, `${action}：正文非空`);
  // ★ 等级必须**由结论项派生**（同一个函数），否则会出现"信封说严重、结论项里没有严重"
  const expected = res.topLevelOf(env.findings);
  ok(env.level === undefined || env.level === expected, `${action}：level(${env.level}) = topLevelOf(findings)(${expected})`);
  const missSum = SUMMARY_KEYS.filter((k) => !(k in env.summary));
  ok(missSum.length === 0, `${action}：summary 七个键都在（无者显式为 null）${missSum.length ? `（缺 ${missSum.join(',')}）` : ''}`);
  // 反向锁：`requirements` 是被删掉的键，**不许**再回来（少一个键的断言挡不住"多一个键"）
  ok(!('requirements' in env.summary), `${action}：summary 里没有 `+ '`requirements`' + `（§29.10 已整项移除）`);
  ok(
    env.findings.every((f) => res.ID_NAMESPACES.includes(String(f.id).split('.')[0])),
    `${action}：结论项 ID 都落在已发布命名空间`,
  );
  ok(
    env.findings.every((f) => {
      const [ns, slug] = [String(f.id).split('.')[0], String(f.id).split('.').slice(1).join('.')];
      const list = res.ID_SLUGS[ns];
      if (!list) return true; // 没有 slug 白名单的命名空间（如 scenario/condition）用各自格式
      return ns === 'condition' || ns === 'scenario' || ns === 'page' || list.includes(slug) || list.includes(slug.split('.')[0]);
    }),
    `${action}：结论项 slug 在白名单内`,
  );
  ok(Array.isArray(env.findings) && env.findings.every((f) => 'id' in f && 'title' in f && 'detail' in f), `${action}：结论项形状`);
}
// 场景能力五项之和 = 场景数（少一项就会"对不上"）
const se = envelopes.report?.summary?.scenarios;
if (se) {
  ok(se.ok + se.partial + se.none + se.unknown + se.na === se.total, `场景能力五项之和 = total（${se.ok}+${se.partial}+${se.none}+${se.unknown}+${se.na}=${se.total}）`);
} else skip('report 未跑成，跳过场景计数断言');

console.log('\n=== 3. 「恢复需求达成度」已整项移除（§29.10）：真机上也不许再冒出来 ===');
// ★ 这一组原来是"给了就判、没给就不许有结论"。需求整项删除之后它反过来验：
//   **即使把老的参数名传进来，也不许产生任何需求结论**（参数已从工具契约里删掉，
//   传了只会进 `ignoredParamNotes` 的提示；真机回归要能证明这一点，而不是只在离线自检里证明）。
{
  const reqGiven = envelopes.report?.summary?.requirements;
  ok(reqGiven === undefined || reqGiven === null, '★ `summary.requirements` 不再是报告的一部分（实得 ' + JSON.stringify(reqGiven) + '）');
  ok(
    !envelopes.report.findings.some((f) => String(f.id).startsWith('req.')),
    '★ 真机 report 的结论项里**没有** `req.*`（命名空间已从契约里删除）',
  );
  ok(
    !(envelopes.report.result?.scenarios ?? []).some((s) => s.conditions.some((c) => c.key === 'TARGET_REACH')),
    '★ 场景条件表里**没有**「先决条件」行（§32 的输出随需求一起移除）',
  );
  ok(
    !('requirements' in (envelopes.report.result ?? {})),
    '★ `result.requirements` 也删掉了（消费者不会拿到一个永远是 null 的键）',
  );
}

console.log('\n=== 4. DMDSC 节点覆盖（给了 targets 才断言）===');
if (process.env.DM_TARGETS) {
  const want = process.env.DM_TARGETS.split(',').filter(Boolean).length;
  const n = envelopes.readiness.summary.nodes;
  ok(n.checked === want && n.failed === 0, `readiness 采到 ${n.checked}/${want} 个节点，失败 ${n.failed}`);
  // ⚠️ 路径是 `result.coverage`（readiness 自己那套），不是 `result.deployment.coverage`（report 的）——
  //    第一版这里写错了，脚本自己报了"覆盖度不是 full"。**断言写错和代码写错一样要查**。
  const cov = envelopes.readiness.result.coverage ?? envelopes.readiness.result.deployment?.coverage;
  ok(cov?.state === 'full', `覆盖度判为 full（实得 ${cov?.state}：${String(cov?.verdict ?? '').slice(0, 40)}）`);
  const cons = envelopes.readiness.result.consistency ?? envelopes.readiness.result.deployment?.consistency;
  ok(cons && cons.labels.length === want, `节点间一致性比对了 ${cons?.labels?.length} 个节点`);
} else skip('未给 DM_TARGETS，跳过节点覆盖断言');

console.log('\n=== 5. OS 级三项（给了 ssh 才断言；§38 支持多节点）===');
if (sshArgs.sshHost) {
  const os0 = envelopes.report.result.os;
  // ★ §38：`sshHost` 给几个节点，OS 就应当在几个节点上各跑一遍
  const want = plugin.parseSshHosts(sshArgs.sshHost).length;
  ok(os0?.nodeCount === want, `OS 检查覆盖 ${os0?.nodeCount}/${want} 个节点（§38：以前只会跑 1 个）`);
  /**
   * ★ 「备份集校验」这一步**依赖账本里有一份带路径的备份** —— 账本为空时它**本来就该是 null**
   *   （没有可校验的备份集，硬跑 `CHECK BACKUPSET` 只能瞎编一个路径）。
   *
   * 这条断言原来无条件要求 `check != null`，于是在一个**账本为空**的环境上假失败了一次：
   * 单实例做过一次「还原回到备份点」（§46.3）之后，`V$BACKUPSET` 里连它自己那份备份都不在册了
   * （控制文件被还原到备份开始那一刻），而实例是健康的、磁盘上也有备份文件。
   * ⇒ 断言要跟着**账本状态**走，而不是假设账本非空。
   */
  const ledgerBackups = envelopes.backup?.summary?.backups ?? envelopes.report?.summary?.backups ?? 0;
  ok(
    (os0?.nodes ?? []).every((n) => n.logScan != null),
    '每个节点都各有一条 logScan 记录（只要配了 sshLogDir，日志扫描就该跑）',
  );
  ok(
    ledgerBackups > 0
      ? (os0?.nodes ?? []).every((n) => n.check != null && /dmrman/.test(n.check?.command ?? ''))
      : (os0?.nodes ?? []).every((n) => n.check === null),
    ledgerBackups > 0
      ? `账本里有 ${ledgerBackups} 份备份 → 每个节点都跑了 dmrman CHECK BACKUPSET 并摊开了命令`
      : '账本为空（`V$BACKUPSET` 0 行）→ **不跑** CHECK BACKUPSET、如实地给 null（不瞎编路径）',
  );
  if (sshArgs.dmrmanDcrIni) {
    ok(
      (os0?.nodes ?? []).every((n) => n.check.command.includes('DCR_INI=')),
      '每个节点都带上了 `DCR_INI`（§31 + §38：dmdcr.ini 逐节点不同）',
    );
    ok(os0?.aggregate?.check === 'ok', `备份集校验合并 = ${os0?.aggregate?.check}（全部节点 ok 才算 ok）`);
  }
  ok(
    ['clean', 'corrupt', 'unknown'].includes(os0?.aggregate?.logScan),
    `全库页裁决合并 = ${os0?.aggregate?.logScan}（count=${os0?.aggregate?.logScanCount}）`,
  );
  if (os0?.aggregate?.logScan === 'clean' && (os0?.aggregate?.logScanNoRecord ?? []).length > 0) {
    ok(
      (os0.aggregate.logScanFrom ?? []).length > 0,
      `给出了裁决的节点：${(os0.aggregate.logScanFrom ?? []).join('、')}；没有记录的：${os0.aggregate.logScanNoRecord.join('、')}`,
    );
  } else skip('合并裁决不是"部分节点有记录"的形态，跳过披露断言');
  const osFindings = envelopes.report.findings.filter((f) => String(f.id).includes('.os-'));
  ok(osFindings.length >= want, `OS 结论项按节点各出一条（${osFindings.length} 条 / ${want} 个节点）`);
  ok(osFindings.every((f) => f.provenance?.via?.includes('OS 只读命令')), 'OS 结论项都标了 `toolOs` 留痕');
  ok(
    want === 1 ? osFindings.every((f) => !/\.\d/.test(String(f.id).split('.os-')[1])) : osFindings.some((f) => /\.\d/.test(String(f.id))),
    want === 1 ? '单节点时 ID 不带节点后缀（契约不变）' : '多节点时 ID 带节点后缀（各节点是不同结论）',
  );
} else {
  ok(envelopes.report.result.os?.nodes?.length === 0, '没配 ssh → result.os.nodes 为空（不假装做过）');
  ok(envelopes.report.result.os?.aggregate?.check === null, '没配 ssh → aggregate 全 null');
}

console.log('\n=== 6. 报告落盘与版式（§25 / §34）===');
const htmlPath = envelopes.report?.reportPath;
const jsonPath = envelopes.report?.findingsPath;
ok(htmlPath && fs.existsSync(htmlPath), `HTML 落盘：${path.basename(htmlPath ?? '')}`);
ok(jsonPath && fs.existsSync(jsonPath), `findings.json 落盘：${path.basename(jsonPath ?? '')}`);
if (htmlPath && fs.existsSync(htmlPath)) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  ok(/<header class="cover">/.test(html), '有封面信息带');
  ok(/--brand:#12395c/.test(html), '沿用安全评估报告的配色 token');
  ok(/<span class="hno">1<\/span>/.test(html) && /<span class="hno">A<\/span>/.test(html), '小节编号徽章 + 附录字母徽章');
  const tocLinks = (html.match(/<ul class="toc">[\s\S]*?<\/ul>/) ?? [''])[0].match(/href="#s\d+"/g) ?? [];
  ok(tocLinks.length === (html.match(/<h2 id="s\d+"/g) ?? []).length, `目录链接数(${tocLinks.length}) = 小节数`);
  ok(!/\u001b/.test(html), '交付件里没有终端控制序列（§31.4 的回归）');
  ok(!/\*\*/.test(html.replace(/<style>[\s\S]*?<\/style>/, '')), '正文里没有残留未渲染的 `**`');
  ok(!/\|\s*---/.test(html), '正文里没有残留 Markdown 表格分隔行');
  // ★ §40 去重 + 指路方向：报告里"同一件事说两遍"与"指错方向"都属于交付件缺陷
  ok(!/本节之后/.test(html), '★ 不出现「见本节之后」这类**指错方向**的指路话（OS 小节在正文、附录之前）');
  const dupWording = (html.match(/全量备份会读取每个数据文件的/g) ?? []).length;
  ok(dupWording <= 1, `★ 「全量备份会读每一页」这段解释最多讲一遍（实得 ${dupWording} 遍）`);
  const dupGap = (html.match(/窗口之外最大相邻间距/g) ?? []).length;
  ok(dupGap <= 1, `★ 「窗口外最大间距」在同一节里只说一次（实得 ${dupGap} 次）`);
  // ★ §38.9：真机交付件里印出过字面的 `null 个损坏页`（`Number(null) === 0` 那个坑）。
  //   源码级断言拦不住这类"渲染出来才知道"的缺陷，所以直接在**成品文本**上验。
  //
  // ⚠️ **必须先剔掉 `/dev/null`**（§45.2）：单实例上「磁盘上的备份文件」那一步是**适用**的
  //   （DMDSC 的备份在 ASM 上 → 判"不适用"，所以那条命令在集群报告里从不出现），
  //   而它的命令原文里就带 `ls … 2>/dev/null; find … 2>/dev/null` ——
  //   于是这条断言在单实例上**假失败**了一次。断言要验的是"JS 空值漏出来"，
  //   不是"正文里不许出现 null 这五个字母"。
  const bodyNoNull = html
    .replace(/<style>[\s\S]*?<\/style>/, '')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    // 替换串里**不能**再出现 null 这五个字母 —— 第一版写成 `/dev/<devnull>`，
    // 结果"剔掉再查"照样命中（自己给自己下套）。
    .replace(/\/dev\/null/g, '/dev/');
  const nullHits = [...bodyNoNull.matchAll(/.{0,40}null.{0,40}/g)].map((m) => m[0]);
  ok(
    nullHits.length === 0,
    `★ 正文里没有**漏出的 JS 空值**（已剔掉命令里的 /dev/null）${nullHits.length ? ` —— 命中：${nullHits.join(' | ')}` : ''}`,
  );
  // ★★ §44 目录：真机成品上验"能不能当目录用" —— 位置、落点、回程三件事
  ok(
    html.indexOf('<nav class="tocbox"') > 0 && html.indexOf('<nav class="tocbox"') < html.indexOf('<h2 id="s1"'),
    '★★ 目录在**第 1 节之前**（原来夹在第 1 节后面：打开报告看不到，点第 1 条还往回跳）',
  );
  {
    // 每个内链都要有落点 —— 这条比"链接数 = 小节数"强：数对了但 id 写错时，读者看到的就是"点了没反应"
    const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const dead = [...new Set(hrefs)].filter((h) => !ids.has(h));
    ok(dead.length === 0, `★ 成品里 ${hrefs.length} 个内链全部有落点（死链 ${dead.length} 个${dead.length ? `：${dead.join(',')}` : ''}）`);
  }
  {
    const backs = (html.match(/class="backtoc"><a href="#toc"/g) ?? []).length;
    const secs = (html.match(/<h2 id="s\d+"/g) ?? []).length;
    ok(backs === secs, `★ 每节末尾都有「↑ 返回目录」（${backs}/${secs}）`);
  }
  ok(/scroll-margin-top:16px/.test(html), '★ 锚点落点留 16px 上边距（否则标题顶在视口最上沿，像"点了没反应"）');
}
if (jsonPath && fs.existsSync(jsonPath)) {
  const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  ok(!('text' in j) && /同名 \.html/.test(j.textOmitted ?? ''), 'findings.json 去掉正文并说明原因');
  ok(
    JSON.stringify(j.findings.map((f) => f.id)) === JSON.stringify(envelopes.report.findings.map((f) => f.id)),
    'findings.json 与信封的结论项**同一批**（同源）',
  );
}

console.log('\n=== 7. 口令不落盘（§36 的承诺，自动验）===');
const home = process.env.dm_recovery_readiness_HOME ?? path.join(os.homedir(), '.dsh', 'dm-recovery-readiness');
const scanDirs = [path.join(home, 'runtime'), OUT].filter((d) => fs.existsSync(d));
let leaked = 0;
let scanned = 0;
for (const dir of scanDirs) {
  for (const f of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!f.isFile()) continue;
    scanned += 1;
    if (fs.readFileSync(path.join(f.parentPath ?? dir, f.name), 'utf8').includes(PASSWORD)) leaked += 1;
  }
}
ok(leaked === 0, `扫了 ${scanned} 个文件（runtime + 报告），口令出现 ${leaked} 次`);
ok(!JSON.stringify(envelopes).includes(PASSWORD), '信封里（含 findings/result/meta）不含口令');

fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n=== 结果：${failed === 0 ? `全部通过（跳过 ${skipped} 组）` : `${failed} 项失败`} ===`);
console.log(`（本次临时报告目录已清理：${OUT}）\n`);
process.exit(failed === 0 ? 0 : 1);
