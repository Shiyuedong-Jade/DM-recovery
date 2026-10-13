/**
 * 插件装配离线自检：不连库，验证 DSH 契约形状与安全边界。
 * 用法：node tools/smoke.mjs
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

let failed = 0;
let asserted = 0; // ★ 断言**实际执行**的条数（循环里的也算）——以前 DESIGN 里那个数字是手工数的，迟早数错
const ok = (c, m) => {
  asserted++;
  console.log((c ? '  [通过] ' : '  [失败] ') + m);
  if (!c) failed++;
};

console.log('\n=== 1. 插件契约形状 ===');
const plugin = await import(pathToFileURL(path.join(PKG, 'lib', 'index.js')).href);
ok(typeof plugin.apply === 'function', 'apply 是函数');
ok(Array.isArray(plugin.inject) && plugin.inject.includes('tools'), "inject 含 'tools'");
ok(plugin.name === 'dm-recovery-readiness', `插件名 = ${plugin.name}`);

console.log('\n=== 2. 注册到桩 ctx，检查工具定义 ===');
let registered = null;
const ctx = {
  tools: { register: (t) => { registered = t; return () => {}; } },
  get: () => undefined,
};
plugin.apply(ctx, {});
ok(registered !== null, 'apply() 调用了 ctx.tools.register()');
ok(registered.name === 'dm_recovery_readiness', `工具名 = ${registered.name}`);
ok(typeof registered.execute === 'function', '工具提供 execute');

/**
 * 注意：defineTool 会把参数 DSL **编译成 JSON Schema** 再挂到 tool 上，
 * 所以这里看到的是编译产物（`required` 是数组），不是我们写的原始 spec。
 * 断言按编译后形状写，否则会误判。
 */
const isRequired = (schema, name) =>
  Array.isArray(schema?.required) ? schema.required.includes(name) : schema?.properties?.[name]?.required === true;

const p = registered.parameters;
ok(p?.type === 'object', '编译后参数是 object');
ok(Array.isArray(p?.required) && p.required.includes('action'), 'action 为必填（编译后 required 数组含 action）');
ok(
  Array.isArray(p?.properties?.action?.enum) &&
    p.properties.action.enum.join() === 'list,readiness,triage,capacity,backup,report',
  'action 允许 list / readiness / triage / capacity / backup / report',
);
ok(typeof registered.output?.render === 'function', '提供 output.render');
const os = registered.output?.schema;
ok(os?.type === 'object' && os?.additionalProperties === false, '输出 schema 显式声明 object + additionalProperties: false');
ok(
  ['action', 'verdict', 'distinctPages', 'needAttention', 'text'].every((k) => isRequired(os, k)),
  '输出 schema 五个字段全部 required',
);

console.log('\n=== 3. 安全边界（实现层面写死，非配置）===');
const fsmod = await import('node:fs');
const src = fsmod.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8');
const queries = fsmod.readFileSync(path.join(PKG, 'lib', 'queries.js'), 'utf8');
const both = src + queries;
ok(/isConcurrencySafe:\s*\(\)\s*=>\s*true/.test(src), '声明了并发安全（纯只读）');
ok(!/PAGE_REPAIR\s*\(/i.test(both), '代码里没有任何 SF_*_PAGE_REPAIR 调用');
ok(!/\bUPDATE\b|\bDELETE\b|\bINSERT\b|ALTER\s+SYSTEM|SP_SET_PARA/i.test(queries.replace(/--.*$/gm, '')), '查询里没有写语句 / 改参数');
ok(/(不提供|不做|禁止)[^。\n]{0,12}主动扫描/.test(src), '代码里写明了不做主动扫描');
ok(/只代表/.test(fsmod.readFileSync(path.join(PKG, 'lib', 'analyze.js'), 'utf8')), '假阴性免责写死在分析层');
// 回归：triage 必须把 FORM/READINESS 的结果一并交给 judgeReadiness。
// 先前只传 LIST_QUERIES 的结果，导致同一份环境上 readiness 说「归档已开」、
// triage 说「非归档：中间数据全丢」—— 自相矛盾，且是对恢复能力的谎报。
ok(
  /judgeReadiness\(\{\s*\.\.\.data,\s*\.\.\.formAndReadiness\s*\}\)/.test(src),
  'triage 把 FORM/READINESS 结果一并交给 judgeReadiness（否则会把「归档已开」误报为「非归档」）',
);

console.log('\n=== 4. Java 桥的只读兜底 ===');
const javaSrc = (await import('node:fs')).readFileSync(path.join(PKG, 'assets', 'java', 'DmQuery.java'), 'utf8');
ok(/isReadOnly/.test(javaSrc), '桥里有只读白名单');
ok(/startsWith\("SELECT"\)/.test(javaSrc), '白名单只放行 SELECT');
ok(/setReadOnly\(true\)/.test(javaSrc), '连接按只读打开');
ok(/REJECTED_NOT_SELECT/.test(javaSrc), '非 SELECT 语句会被拒绝并记录');

console.log('\n=== 5. 备份模块离线检查（不连库，夹具取真机形状）===');
const bk = await import(pathToFileURL(path.join(PKG, 'lib', 'backup.js')).href);

// V$BACKUPSET 的 34 列**实测列名**（由 JDBC 元数据取得）。
// 注意 RANGE# / DESC# 带 # —— 所以绝不能用「列名片段」去模糊匹配。
const COLS34 = [
  'DEVICE_TYPE', 'BACKUP_ID', 'PARENT_ID', 'BACKUP_NAME', 'BACKUP_PATH', 'TYPE', 'LEVEL', 'RANGE#',
  'OBJECT_NAME', 'OBJECT_ID', 'BASE_NAME', 'BACKUP_TIME', 'DESC#', 'ENCRYPT_TYPE', 'COMPRESS_LEVEL',
  'WITHOUT_LOG', 'USE_PWR', 'PKG_SIZE', 'BEGIN_LSN', 'END_LSN', 'BKP_NUM', 'DBF_NUM', 'PARALLEL_NUM',
  'BAKSET_TYPE', 'MPP_FLAG', 'MIN_TRX_START_LSN', 'MIN_EXEC_VER', 'CUMULATIVE', 'MIN_DCT_VER',
  'DDL_CLONE', 'BAK_MAGIC', 'VERSION', 'SUB_VERSION', 'BAKSET_MAGIC',
];
// 一次真实的 `backup database;` 在 V$BACKUPSET 里的取值
const ROW1 = [
  'DISK', 195402333, -1, 'DB_dameng_FULL_20261010_150250_003731',
  '+DMDATA/data/dameng/bak/DB_dameng_FULL_20261010_150250_003731', 0, 0, 1,
  'dameng', -1, '', '2026-10-10 15:03:21.084961', '', 0, 0,
  0, 0, 8388608, 42246718, 42251246, 2, 6, 1,
  0, 0, 0, 134283815, 0, 4,
  0, 0, 'V8.10.15.2', 15, 195402333,
];
const bkps = bk.parseBackupSets({ columns: COLS34, rows: [ROW1] });
ok(bkps.length === 1, 'V$BACKUPSET 夹具解析出 1 条');
ok(bkps[0].name === 'DB_dameng_FULL_20261010_150250_003731', '备份名解析正确');
ok(bkps[0].isFull === true, 'TYPE=0 且 LEVEL=0 判为完全备份');
ok(bkps[0].endLsn === 42251246, 'END_LSN 解析成数字而不是字符串');
ok(bkps[0].nameHint === 'FULL', '从名称里取到 FULL 旁证');

// 时间戳回归：BACKUP_TIME 经 JDBC 回来是**字符串**，早先直接喂给只认 Date 的
// fmtT() 会渲染成「—」；而若先 new Date() 再 toISOString() 又会做时区换算，
// 把 15:03 显示成 07:03。必须原样保留。
ok(
  bk.fmtStamp('2026-10-10 15:03:21.084961') === '2026-10-10 15:03:21',
  'fmtStamp 原样保留时间，不做时区往返',
);
ok(bk.fmtStamp('不是时间') === '—' && bk.fmtStamp(null) === '—', 'fmtStamp 对非法/空输入给 —');

// 关键回归：TYPE / LEVEL / DEVICE_TYPE / BAKSET_TYPE / ENCRYPT_TYPE 都含 'TYPE'，
// 必须锚定整列名，否则会串列（这是本模块最容易写错的地方）。
ok(bkps[0].type === 0 && bkps[0].device === 'DISK', '^TYPE$ 锚定未误吃 DEVICE_TYPE');
ok(bkps[0].level === 0 && bkps[0].cumulative === 0, 'LEVEL / CUMULATIVE 未串列');

const covOk = bk.assessBackupCoverage({
  backups: bkps,
  curLsn: 42254588,
  archRes: { columns: ['ARCH_LSN', 'CLSN'], rows: [[42246718, 42254588]] },
});
ok(covOk.redoGap === 3342, `redo 缺口 = CUR_LSN - END_LSN = ${covOk.redoGap}`);
ok(covOk.covered === true, '归档两端都实测到时才给出 covered=true');
const covUnknown = bk.assessBackupCoverage({
  backups: bkps,
  curLsn: 42254588,
  archRes: { columns: ['ARCH_LSN', 'CLSN'], rows: [[0, 0]] },
});
ok(covUnknown.covered === null, '归档缺失时 covered=null —— 不给猜测结论');
ok(
  bk.assessBackupCoverage({ backups: [], curLsn: 1, archRes: null }).newest === null,
  '账本为空时不抛异常，正常返回 none',
);

const hit = bk.verifySuppliedPath('+DMDATA/data/dameng/bak', bkps);
ok(hit.inCatalog === true && hit.kind === 'asm', '调用方给的 ASM 目录能命中账本');
const miss = bk.verifySuppliedPath('/backup/db', bkps);
ok(miss.inCatalog === false && miss.kindMismatch === true, '文件系统路径对 ASM 备份给出 kindMismatch 提示');
ok(bk.dmrmanCheckCommand("'/a/b'") === `dmrman CTLSTMT="CHECK BACKUPSET '/a/b'"`, 'dmrman 命令用实测语法且去掉多余引号');

const rel = bk.relatePagesToBackups(
  [
    { TS_ID: 4, FILE_ID: 0, PAGE_NO: 100, RECORD_TIME: '2026-10-10 16:00:00' },
    { TS_ID: 4, FILE_ID: 0, PAGE_NO: 200, RECORD_TIME: '2026-10-10 14:00:00' },
  ],
  bkps,
);
ok(rel[0].rel === 'after-backup', '坏页晚于全备 → after-backup（可确定备份不含它）');
ok(rel[1].rel === 'before-backup', '坏页早于全备 → before-backup（只能说不能排除）');
ok(bk.relatePagesToBackups([{ RECORD_TIME: '不是时间' }], bkps)[0].rel === 'unknown', '时间无法解析时归为 unknown，不瞎猜');

console.log('\n=== 5b. 归档链逐段核对（DESIGN §22，夹具取两个真机环境的原文）===');
/**
 * 为什么必须有这一节：`archiveSpan()` 只取 min ARCH_LSN / max CLSN **两端** ——
 * 两端对得上、中间断了它看不出来，而「能不能恢复到某个点」恰恰取决于中间有没有洞。
 * 下面两个夹具是**真机原文**，一个单实例、一个 DMDSC 交叉配置。
 */
const ARCC = ['PATH', 'STATUS', 'LEN', 'ARCH_LSN', 'CLSN', 'NEXT_SEQ', 'CREATE_TIME'];
// 真机：单实例 10.127.11.40（.dm-home/runtime/res-20704-*.json）
const FX_SINGLE = {
  columns: ARCC,
  rows: [
    ['/home/dmdba/dmbak/ARCHIVE_LOCAL1_0x17BB7BB9_EP0_2026-10-10_15-44-59.log', 'INACTIVE', '135168', '132032628', '132032738', '136616', '2026-10-10 15:44:59.567997'],
    ['/home/dmdba/dmbak/ARCHIVE_LOCAL1_0x17BB7BB9_EP0_2026-10-12_09-11-09.log', 'ACTIVE', '1073741824', '132032739', '132033144', '136641', '2026-10-12 09:11:09.802527'],
  ],
};
// 真机：DMDSC 两节点交叉配置（.dm-home/runtime/res-15116-*.json）——同一目录里混着 LOCAL 与 REMOTE 两个序列
const FX_DSC = {
  columns: ARCC,
  rows: [
    ['+DMDATA/DSC01/arch/ARCHIVE_LOCAL1_0x5397A3BF_EP0_2026-10-10_14-29-12.log', 'INACTIVE', '11804672', '42231283', '42254846', '154669', '2026-10-10 14:29:12.901120'],
    ['+DMDATA/DSC01/arch/ARCHIVE_LOCAL1_0x5397A3BF_EP0_2026-10-10_16-07-31.log', 'INACTIVE', '241664', '42254847', '42255063', '154726', '2026-10-10 16:07:31.006043'],
    ['+DMDATA/DSC01/arch/ARCHIVE_LOCAL1_0x5397A3BF_EP0_2026-10-10_16-35-52.log', 'INACTIVE', '36864', '42255064', '42255125', '154733', '2026-10-10 16:35:52.223564'],
    ['+DMDATA/DSC01/arch/ARCH_REMOTE1_0x5397A3BF_EP0_2026-10-10_16-37-51.log', 'INACTIVE', '8192', '42255130', '42255130', '154734', '2026-10-10 16:37:51.241216'],
    ['+DMDATA/DSC01/arch/ARCHIVE_LOCAL1_0x5397A3BF_EP0_2026-10-10_17-10-07.log', 'INACTIVE', '8192', '42255179', '42255183', '154735', '2026-10-10 17:10:07.503153'],
    ['+DMDATA/DSC01/arch/ARCHIVE_LOCAL1_0x5397A3BF_EP0_2026-10-10_17-16-17.log', 'ACTIVE', '134217728', '42255232', '42255260', '154740', '2026-10-10 17:16:17.755200'],
    ['+DMDATA/DSC02/arch/ARCHIVE_LOCAL1_0x5397A3BF_EP1_2026-10-10_14-29-29.log', 'INACTIVE', '11059200', '42231338', '42254846', '113021', '2026-10-10 14:29:29.240258'],
    ['+DMDATA/DSC02/arch/ARCHIVE_LOCAL1_0x5397A3BF_EP1_2026-10-10_16-07-37.log', 'INACTIVE', '212992', '42254875', '42255063', '113071', '2026-10-10 16:07:37.259632'],
    ['+DMDATA/DSC02/arch/ARCHIVE_LOCAL1_0x5397A3BF_EP1_2026-10-10_16-36-34.log', 'INACTIVE', '24576', '42255126', '42255144', '113076', '2026-10-10 16:36:34.939881'],
    ['+DMDATA/DSC02/arch/ARCHIVE_LOCAL1_0x5397A3BF_EP1_2026-10-10_17-09-34.log', 'INACTIVE', '36864', '42255145', '42255185', '113083', '2026-10-10 17:09:34.641580'],
    ['+DMDATA/DSC02/arch/ARCHIVE_LOCAL1_0x5397A3BF_EP1_2026-10-10_17-15-31.log', 'ACTIVE', '134217728', '42255186', '42255252', '113090', '2026-10-10 17:15:31.512679'],
  ],
};

// 单实例：单序列、逐段连续（132032738 → 132032739 正好 +1）
const chSingle = bk.assessArchiveChain(FX_SINGLE, { curLsn: 132033200, needFrom: 132032738 });
ok(chSingle.verdict === 'continuous' && chSingle.series.length === 1, '单实例：1 个序列、逐段连续');
ok(chSingle.series[0].target === 'ARCHIVE_LOCAL1' && chSingle.series[0].node === 'EP0', '从 PATH 解析出归档目标名与节点号');
ok(chSingle.coversNeedFrom === true, '并集覆盖备份起点 → 可配归档恢复');
ok(chSingle.unarchivedLsn === 56, `未归档尾部 = CUR_LSN − 并集末端 = ${chSingle.unarchivedLsn}`);
ok(chSingle.singleSeriesBreakIsDefect === true, '**单序列**环境：序列内有洞才是真断档');
ok(
  chSingle.oldestCreateTime === '2026-10-10 15:44:59.567997',
  '给出可回溯窗口的时间起点（归档文件 CREATE_TIME）',
);

// ★ 真机单实例的 NEXT_SEQ 从 136616 跳到 136641（跳 25）—— 拿它判档会误报，本实现根本不读它
ok(
  FX_SINGLE.rows[1][5] !== String(Number(FX_SINGLE.rows[0][5]) + 1) && chSingle.verdict === 'continuous',
  '**NEXT_SEQ 跳跃不算断档**（一个归档文件内含多个 redo 序列号）—— 判据是 ARCH_LSN === 前一个 CLSN + 1',
);

// 真造一个单实例断档：第二个文件的起点跳过了 261 个 LSN
const chBroken = bk.assessArchiveChain(
  { columns: ARCC, rows: [FX_SINGLE.rows[0], [FX_SINGLE.rows[1][0], 'ACTIVE', '1024', '132033000', '132033144', '136641', '2026-10-12 09:11:09.802527']] },
  { curLsn: 132033200, needFrom: 132032738 },
);
ok(chBroken.verdict === 'gap' && chBroken.holes.length === 1, '真断档时 verdict=gap 且给出洞的位置');
ok(chBroken.holes[0].gap === 261 && chBroken.coversNeedFrom === false, `洞算出缺口 261 个 LSN，且**不再**声称覆盖备份起点`);

// ★ DMDSC 交叉配置：同一目录里混着 LOCAL 与 REMOTE 两个序列
const chDsc = bk.assessArchiveChain(FX_DSC, { curLsn: 42255290, needFrom: 42246718 });
ok(chDsc.series.length === 3, `按「目录 + 目标名 + 节点」拆成 3 个序列（实得 ${chDsc.series.length}）`);
ok(
  chDsc.series.some((s) => s.target === 'ARCH_REMOTE1') && chDsc.series.some((s) => s.node === 'EP1'),
  'LOCAL 与 REMOTE、EP0 与 EP1 被正确分开（全局排序会报出**假断档**）',
);
const dscLocal0 = chDsc.series.find((s) => s.target === 'ARCHIVE_LOCAL1' && s.node === 'EP0');
ok(dscLocal0.breaks.length === 2, `DSC01 的 LOCAL 序列内有 2 处断档（实得 ${dscLocal0.breaks.length}）`);
ok(chDsc.verdict === 'continuous' && chDsc.holes.length === 0, '**但并集无洞** —— 判定看并集（另一节点的序列把洞补上了）');
ok(chDsc.singleSeriesBreakIsDefect === false, '多序列环境：序列内断档**属正常形态**，不算缺陷');
ok(chDsc.coversNeedFrom === true, '并集覆盖备份起点（LSN 42246718）');
// 单目录自足性 —— 这是真机上最有用的一条：少留任何一个节点的归档目录就会缺一段
ok(chDsc.byDir.length === 2 && chDsc.byDir.every((d) => !d.selfSufficient), 'DMDSC 上**两个归档目录各自都不自足**');
ok(
  chDsc.byDir.find((d) => d.dir.startsWith('+DMDATA/DSC01')).holes.length === 3,
  'DSC01 的目录单独缺 3 段（LOCAL + 收到的 REMOTE 拼起来仍有洞）',
);

// 缺 LSN 列 / 空结果：必须判 unknown，**不能**默认成「连续」
ok(bk.assessArchiveChain({ columns: ARCC, rows: [] }, {}).verdict === 'unknown', '没有可用行 → unknown，不猜');
ok(
  bk.assessArchiveChain({ columns: ['PATH', 'STATUS'], rows: [['/a/x.log', 'ACTIVE']] }, {}).verdict === 'unknown',
  '缺少 ARCH_LSN / CLSN 列 → unknown（不把缺列当成 0，那会伪造出一个巨大区间）',
);

console.log('\n=== 5c. 逐段核对已接线进判定（不是只算不判）===');
// archiveChainOk 必须**由逐段核对决定**，不再是「最早归档 ≤ 备份起点」这个两端判据。
// （后者两端对齐、中间有洞时会把「无法配归档恢复」谎报成可恢复。）
const idxSrc5c = fsmod.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8');
// 断言前**去掉行注释**：注释里保留「旧口径是 X」这种记录是有价值的，
// 不该被当成"旧代码还在"（这与 queries.js 那条断言去掉 `--` 注释是同一个道理）。
const idxCode5c = idxSrc5c.replace(/^\s*\/\/.*$/gm, '');
ok(
  /archiveChainOk = chain\.verdict === 'unknown' \? null : chain\.coversNeedFrom/.test(idxCode5c),
  'facts.archiveChainOk 取自 assessArchiveChain().coversNeedFrom',
);
ok(!/earliestArchLsn <= backupBeginLsn/.test(idxCode5c), '旧的「最早归档 ≤ 备份起点」两端判据已从判定路径移除（注释里的记录不算）');
ok(/assessArchiveChain\(/.test(idxCode5c), 'backup 与 report 都真的调用 assessArchiveChain');
ok(/renderArchiveChain\(chain\)/.test(idxCode5c), '逐段核对结果被渲染进输出');
// 判定升级了，说法也必须跟着升级：不能还留着「最早归档 LSN 早于备份起点」当结论
ok(
  /chainNote\(f\)/.test(fsmod.readFileSync(path.join(PKG, 'lib', 'scenarios.js'), 'utf8')),
  '场景的「靠什么救」改用逐段核对的摘要（说法与判据同源）',
);
// 渲染层也要把「已知边界」写出来 —— 结论越强，越要写清它在哪不成立
// 混合夹具：DSC01 的目录不自足（LOCAL 有洞）、DSC02 单个文件覆盖全程（自足）
const chMixed = bk.assessArchiveChain(
  { columns: ARCC, rows: [FX_DSC.rows[0], FX_DSC.rows[3], FX_DSC.rows[5], ['+DMDATA/DSC02/arch/ARCHIVE_LOCAL1_0x5397A3BF_EP1_2026-10-10_14-29-29.log', 'INACTIVE', '1', '42231338', '42255252', '113090', '2026-10-10 14:29:29.240258']] },
  { curLsn: 42255290, needFrom: 42246718 },
);
const arcDsc = plugin.renderArchiveChain(chDsc);
const arcSingle = plugin.renderArchiveChain(chSingle);
const arcGap = plugin.renderArchiveChain(chBroken);
ok(/单目录自足性/.test(arcDsc) && /各自都不自足/.test(arcDsc), 'DMDSC 输出给出「单目录自足性」，两者都不自足时说「各自都不自足」');
ok(/少保留任何一个节点的归档目录/.test(arcDsc), '并把运维含义写出来：少留一个节点的归档目录就会缺一段');
// 措辞必须与数据相符：DSC02 单独即自足时，**不能**再说「各自都不自足」
const arcMixed = plugin.renderArchiveChain(chMixed);
ok(/单独即自足/.test(arcMixed), '某个目录单独自足时，表格里如实写「单独即自足」');
ok(/有 \*\*1\*\* 个目录|最少保留/.test(arcMixed) && !/各自都不自足/.test(arcMixed), '部分自足时改说「有 N 个目录单独不足以恢复」，不再说「各自都不自足」');
ok(/序列内有断档属正常|多序列环境下/.test(arcDsc), '解释「序列内断档在多序列下正常」，不把它误报成缺陷');
ok(/NEXT_SEQ/.test(arcDsc), '写明判据是 ARCH_LSN === 前一个 CLSN + 1，**不是** NEXT_SEQ');
ok(/41 小时/.test(arcSingle) && /不承诺精确到秒的 PITR/.test(arcSingle), '写明时间锚精度 = 一个归档文件的跨度，不承诺精确 PITR');
ok(/🚨/.test(arcGap) && /洞/.test(arcGap), '有洞时输出 🚨 并指明「恢复到这些 LSN 区间时会断」');
ok(/无法判定|unknown|未判定/.test(plugin.renderArchiveChain(bk.assessArchiveChain({ columns: ARCC, rows: [] }, {}))), '取不到归档信息时输出「未判定」，不给结论');

console.log('\n=== 5d. 时间 ↔ LSN 夹逼（DESIGN §23）===');
/**
 * 只用一条不等式：`t(A) ≤ S`（LSN 先被生成、后才可能被观测到）。
 * 严格结论由此而来；另一半（上界）要求「观测时刻 ≈ LSN 生成时刻」，
 * **这个前提因来源而异** —— 下面用真机形状把它钉死。
 */
const tlBackups = [
  { name: 'DB_DAMENG_FULL_20261012_091257_630040', time: '2026-10-12 09:12:57.630040', beginLsn: 132032738, endLsn: 132033100 },
];
const TL = bk.assessTimeLsnAnchors({
  archRes: FX_SINGLE,
  backups: tlBackups,
  curLsn: 132033144,
  nowTime: '2026-10-12 09:23:43',
});
ok(TL.count === 5, `锚点 5 个：2 归档 + 2 备份 + 1 当前前沿（实得 ${TL.count}）`);
ok(
  TL.anchors.filter((a) => a.source === '备份 BEGIN_LSN' || a.source === '备份 END_LSN').every((a) => a.tight === false),
  '**备份锚点标为 tight:false**（BACKUP_TIME 是完成时刻）—— 只用它做严格下界',
);
const TLARCH = TL.anchors.filter((a) => a.source.startsWith('归档文件') || a.source === '当前前沿');
ok(
  TLARCH.length === 3 && TLARCH.every((a) => a.tight === true),
  '归档文件(开/关)与当前前沿标为 tight:true（滞后小，可用于上界）',
);
ok(Math.abs(TL.maxGapHours - 41.4) < 0.2, `最大相邻时间间距 = ${TL.maxGapHours.toFixed(1)} 小时 —— **间距就是精度上限**`);

// 时刻 → LSN：严格下界 + 前提上界
const b0800 = bk.lsnForTime(TL.anchors, bk.toMs('2026-10-12 08:00:00'));
ok(b0800.strictLowerLsn === 132032628 && b0800.practicalUpperLsn === 132032739, '10-12 08:00 → LSN ∈ [132032628, 132032739]');
ok(b0800.widthLsn === 111, `区间宽度 111 个 LSN（实得 ${b0800.widthLsn}）`);
ok(
  bk.lsnForTime(TL.anchors, bk.toMs('2026-10-12 09:20:00')).widthLsn === 44,
  '09:20（备份之后）区间收窄到 44 —— 锚点越密越准',
);
const tooEarly = bk.lsnForTime(TL.anchors, bk.toMs('2026-10-10 10:00:00'));
ok(tooEarly.strictLowerLsn === null && /早于所有锚点/.test(tooEarly.note ?? ''), '早于所有锚点时明确说「无法给下界」');
const tooLate = bk.lsnForTime(TL.anchors, bk.toMs('2026-10-13 00:00:00'));
ok(tooLate.strictLowerLsn === 132033144 && tooLate.practicalUpperLsn === null, '晚于所有锚点时只给下界');

// 反方向：LSN → 时刻
const lTo = bk.timeForLsn(TL.anchors, 132033100);
ok(
  lTo.strictUpperTime === '2026-10-12 09:12:57.630040' && lTo.practicalLowerTime === '2026-10-12 09:11:09.802527',
  'LSN 132033100 → 「不晚于 09:12:57（严格）/ 不早于 09:11:09（依赖前提）」',
);
// ★ 反证 + 防线：**朴素做法（不区分锚点来源）在这个真机形状上必然算出「上界 < 下界」**。
//   原因是备份的 `BACKUP_TIME` 是**完成**时刻，而它的 `BEGIN_LSN` 早在备份开始时就生成了
//   （夹具里差 1.5 分钟；真机那次备份跑了 31 秒）。所以：
//     ① 先证明朴素公式确实会翻转；
//     ② 再证明实现的 `tight` 标记 + 自查把它挡住（丢掉依赖前提的那一半，**不给负区间**）。
const tConflict = bk.toMs('2026-10-12 09:12:03');
const naiveLower = Math.max(...TL.anchors.filter((a) => a.timeMs < tConflict).map((a) => a.lsn));
const naiveUpper = Math.min(...TL.anchors.filter((a) => a.timeMs > tConflict).map((a) => a.lsn));
ok(naiveUpper < naiveLower, `（反证）朴素做法算出「上界 ${naiveUpper} < 下界 ${naiveLower}」—— 区间宽度会是 ${naiveUpper - naiveLower}`);
const guarded = bk.lsnForTime(TL.anchors, tConflict);
ok(
  guarded.practicalUpperLsn === 132033144 && guarded.widthLsn === 405,
  '实现靠**按来源过滤**（备份锚点不参与上界）避开了负区间：上界取到 132033144，宽 405',
);
ok(guarded.premiseDropped === false, '这一步没有触发前提否决（紧锚点之间本就一致）');
ok(bk.bracketTable(TL.anchors).every((r) => r.widthLsn === null || r.widthLsn >= 0), '分段表里**没有负宽度**');
// 这个夹具的紧锚点本身是单调的 → 前提自查不报警（false 也是"如实"，不是漏检）
ok(TL.premiseViolated === false, '本夹具按来源区分后无冲突 → premiseViolated=false（如实，不是漏检）');
// 但换一对**时钟倒挂**的紧锚点（例如多节点时钟偏差），自查必须报警
const skewed = bk.assessTimeLsnAnchors({
  archRes: {
    columns: ['PATH', 'ARCH_LSN', 'CREATE_TIME'],
    rows: [['/a/A1_EP0_x.log', '100', '2026-10-12 10:00:00'], ['/a/A2_EP0_x.log', '50', '2026-10-12 11:00:00']],
  },
});
ok(skewed.premiseViolated === true, '**时钟倒挂**（后观测到的 LSN 反而更小）时前提自查报警');
// ★ 冲突点在两个锚点**之间** —— 只在锚点时刻取样会漏检（第一版就是这么漏的）
const skewedMid = bk.lsnForTime(skewed.anchors, bk.toMs('2026-10-12 10:30:00'));
ok(
  skewedMid.practicalUpperLsn === null && skewedMid.premiseDropped === true && /前提自查否决/.test(skewedMid.note ?? ''),
  '倒挂时**区间中点**也会丢掉依赖前提的那一半，并写明「前提自查否决」',
);
ok(TL.count >= 2 && /间距/.test(TL.note), 'note 里把「锚点密度 = 精度上限」说出来');
ok(bk.assessTimeLsnAnchors({}).usable === false, '没有锚点时 usable=false，不硬凑结论');
ok(/至少要两个/.test(bk.assessTimeLsnAnchors({ archRes: { columns: ['ARCH_LSN', 'CREATE_TIME'], rows: [['1', '2026-10-10 10:00:00']] } }).note), '只有 1 个锚点时说明「至少要两个」');
// 接线：渲染层与 facts 都要真的用上
ok(/assessTimeLsnAnchors\(/.test(idxCode5c), 'backup 与 report 都真的调用 assessTimeLsnAnchors');
ok(/renderTimeLsn\(anchors\)/.test(idxCode5c), '时间↔LSN 对照被渲染进输出');
ok(/SYSDATE AS NOW/.test(fsmod.readFileSync(path.join(PKG, 'lib', 'backup.js'), 'utf8')), '当前前沿用**数据库自己的 SYSDATE**取时刻（不用本机时钟）');

// ★ 真机实测抓到的一个**假告警**：空闲库里 `V$RLOG_HISTORY` 连续多个采样点 LSN 完全不变，
//   于是「下界 === 上界」。第一版判据写的是 `<=`，把它当成「前提冲突」丢掉并印出
//   「只能给下界」—— 而那恰恰是**最好**的情况：LSN 被**精确到一个点**（宽度 0）。
//   判据必须是**严格小于**。
const flat = (t, lsn) => ({ lsn, time: t, timeMs: bk.toMs(t), source: 'RLOG 历史', tight: true });
const flatAnchors = [
  flat('2026-10-12 10:12:09', 100),
  flat('2026-10-12 10:13:09', 100),
  flat('2026-10-12 10:14:09', 100),
  flat('2026-10-12 10:15:09', 110),
];
const fb = bk.lsnForTime(flatAnchors, bk.toMs('2026-10-12 10:12:39'));
ok(
  fb.strictLowerLsn === 100 && fb.practicalUpperLsn === 100 && fb.widthLsn === 0 && fb.premiseDropped === false,
  'LSN 未推进时区间宽度 **0**（精确到一个点），**不是**「前提冲突」',
);
ok(
  bk.lsnForTime(flatAnchors, bk.toMs('2026-10-12 10:14:39')).practicalUpperLsn === 110,
  'LSN 一旦推进，上界随之收紧（不因上一段的相等而失效）',
);
ok(bk.assessTimeLsnAnchors({ rlogHistory: { columns: ['RECORD_TIME', 'CUR_LSN'], rows: [['2026-10-12 10:12:09', 100], ['2026-10-12 10:13:09', 100], ['2026-10-12 10:14:09', 110]] } }).premiseViolated === false, '整段 LSN 不推进的库上，前提自查**不报假警**');
// 真机实测：V$RLOG_HISTORY 是 (RECORD_TIME, CUR_LSN) 的时间序列，锚点标 tight
const rh = bk.assessTimeLsnAnchors({
  rlogHistory: { columns: ['RECORD_TIME', 'CUR_LSN', 'CKPT_LSN'], rows: [['2026-10-12 10:20:09.339835', 132129504, 132114852], ['2026-10-12 10:21:09.337835', 132129532, 132114852]] },
});
ok(rh.count === 2 && rh.anchors.every((a) => a.source === 'RLOG 历史' && a.tight), 'V$RLOG_HISTORY 被解析成 tight 锚点（真机实测的列名 RECORD_TIME / CUR_LSN）');
ok(rh.sourceCounts['RLOG 历史'] === 2 && /最密的一档间距/.test(rh.note), '锚点来源统计里单列 RLOG 历史，并给出最密间距');
// ★ 最密来源与「最密窗口」**必须实测**，不能把单实例量到的「V$RLOG_HISTORY 每分钟一行」写死：
//   DMDSC 节点上该视图只回来 1 行，真正密的是归档文件（真机实测）。
ok(
  rh.minGapSource === 'RLOG 历史' && rh.rlogRows === 2 && rh.minGapHours > 0 && rh.minGapHours < 1 / 60,
  '最密间距**标明来源**并如实给出间距（本夹具 = RLOG 历史，1 分钟）',
);
ok(
  rh.dense === true && rh.denseWindow?.anchorCount === 2 && /只在连续窗口/.test(rh.note),
  'dense 只在**实测到的连续窗口**内成立，并把窗口写进 note',
);
// 夹具照**DMDSC 真机形状**搭：RLOG 历史只有 1 行（且离得很远），真正密的是相邻的归档文件（1 秒）。
// ★ 同时覆盖 §35 的两条新规则：**ACTIVE 文件的「关」那一对必须跳过**、**锚点按流分组**。
const archOnly = bk.assessTimeLsnAnchors({
  archRes: {
    columns: ['PATH', 'STATUS', 'LEN', 'ARCH_LSN', 'CLSN', 'NEXT_SEQ', 'CREATE_TIME', 'CLOSE_TIME'],
    rows: [
      ['x_EP0_a.log', 'INACTIVE', '1', 100, 200, '1', '2026-10-12 12:00:00', '2026-10-12 12:00:01'],
      // ACTIVE：CLOSE_TIME 实测等于 CREATE_TIME、CLSN 是"写到哪了"的移动末端 ⇒ **关这一对要跳过**
      ['x_EP0_b.log', 'ACTIVE', '1', 201, 300, '2', '2026-10-12 12:00:02', '2026-10-12 12:00:02'],
      ['y_EP1_a.log', 'INACTIVE', '1', 150, 180, '1', '2026-10-12 12:00:00', '2026-10-12 12:00:01'],
    ],
  },
  rlogHistory: { columns: ['RECORD_TIME', 'CUR_LSN'], rows: [['2026-10-10 00:00:00', 50]] },
});
ok(
  archOnly.dense === true && archOnly.minGapSource === '归档文件(开) + 归档文件(关)' && archOnly.rlogRows === 1,
  '★ RLOG 只有 1 行时，最密来源如实写成归档文件的开/关两个锚点（第一版写死成 V$RLOG_HISTORY）',
);
ok(
  archOnly.sourceCounts['归档文件(开)'] === 3 && archOnly.sourceCounts['归档文件(关)'] === 2,
  '★ 每个**已关闭**的归档文件贡献两个锚点（开 ARCH_LSN / 关 CLSN），ACTIVE 那个只算「开」',
);
ok(
  !archOnly.anchors.some((a) => a.source === '归档文件(关)' && a.lsn === 300),
  '★ ACTIVE 文件的 `CLSN=300` **没有**被当成"关闭时刻的 LSN"（真机上它偏差 6 万多 LSN，是伪造锚点）',
);
const streamsOf = {};
for (const a of archOnly.anchors) streamsOf[a.stream] = (streamsOf[a.stream] ?? 0) + 1;
ok(
  streamsOf.EP0 === 3 && streamsOf.EP1 === 2 && streamsOf.db === 1,
  `★ 锚点带「流」标识（DSC 上每个 EP 一条归档流）：${JSON.stringify(streamsOf)}`,
);
// ★ 跨流"倒挂"不许报警（DSC 的正常形态）；同流内倒挂必须报警
const crossStream = bk.assessTimeLsnAnchors({
  archRes: {
    columns: ['PATH', 'STATUS', 'ARCH_LSN', 'CLSN', 'CREATE_TIME', 'CLOSE_TIME'],
    rows: [
      ['a_EP0_x.log', 'INACTIVE', '500', '510', '2026-10-12 10:00:00', '2026-10-12 10:10:00'],
      // 另一条流**晚得多**才开，但 LSN 小得多 —— 全局看像"LSN 倒退"，其实是两条流
      ['b_EP1_y.log', 'INACTIVE', '100', '110', '2026-10-12 10:20:00', '2026-10-12 10:30:00'],
    ],
  },
});
ok(
  crossStream.premiseViolated === false,
  '★ 跨流的"LSN 看起来倒退"**不再**触发前提自查（DMDSC 正常形态；第一版会报假矛盾并丢掉所有上界）',
);
const inStream = bk.assessTimeLsnAnchors({
  archRes: {
    columns: ['PATH', 'STATUS', 'ARCH_LSN', 'CLSN', 'CREATE_TIME', 'CLOSE_TIME'],
    rows: [
      ['a_EP0_a.log', 'INACTIVE', '100', '110', '2026-10-12 10:00:00', '2026-10-12 10:10:00'],
      // **同一条流**内后观测到的 LSN 反而更小 ⇒ 这才是真倒挂（时钟回拨），必须报警
      ['a_EP0_b.log', 'INACTIVE', '90', '95', '2026-10-12 10:20:00', '2026-10-12 10:30:00'],
    ],
  },
});
ok(inStream.premiseViolated === true, '★ **同一条流内**的 LSN 倒挂仍然报警（流内比较没有被放宽掉）');
// 闪回事务锚点：机会性来源，有行就用、0 行什么都不发生
const fbAnchors = bk.assessTimeLsnAnchors({
  rlogHistory: { columns: ['RECORD_TIME', 'CUR_LSN'], rows: [['2026-10-12 10:00:00', 100]] },
  flashbackTrx: { columns: ['COMMIT_TIMESTAMP', 'COMMIT_LSN'], rows: [['2026-10-12 10:05:00', 150], [null, 160]] },
});
ok(
  fbAnchors.flashbackCount === 1 && fbAnchors.sourceCounts['闪回事务'] === 1,
  '★ 闪回事务锚点（每事务一对 (COMMIT_TIMESTAMP, COMMIT_LSN)）被采纳；缺时间的那行跳过',
);
ok(
  bk.assessTimeLsnAnchors({
    rlogHistory: { columns: ['RECORD_TIME', 'CUR_LSN'], rows: [['2026-10-12 10:00:00', 100]] },
    flashbackTrx: { columns: ['COMMIT_TIMESTAMP', 'COMMIT_LSN'], rows: [] },
  }).flashbackCount === 0,
  '★ 没开闪回的库（该视图 0 行）不产生锚点、也不报错 —— 机会性来源',
);
ok(
  /窗口之外最大相邻间距 \*\*60\.0 小时\*\*/.test(archOnly.note),
  '窗口外的最大间距也照实说（本夹具 60 小时）—— 「窗口内很密」不等于「时间↔LSN 精确」',
);
ok(bk.fmtMs(bk.toMs('2026-10-12 10:50:00')) === '2026-10-12 10:50:00', '★ fmtMs 用**本机时区**格式化毫秒（不经 toISOString，否则 10:50 会显示成 02:50）');
ok(bk.fmtStamp(bk.toMs('2026-10-12 10:50:00')) === '2026-10-12 10:50:00', 'fmtStamp 的毫秒/Date 分支同样不再走 toISOString（早晚会用到的定时炸弹）');
ok(bk.assessTimeLsnAnchors({ rlogHistory: { columns: ['RECORD_TIME'], rows: [['2026-10-12 10:20:09']] } }).count === 0, 'RLOG 历史缺 CUR_LSN 列时跳过，不猜');

// ★ 渲染层也不许把单实例量到的数字写成普遍事实（真机 DMDSC 上这句话原是错的）
const tlText = plugin.renderTimeLsn(archOnly).join('\n');
ok(/来源：归档文件/.test(tlText), '★ 「时间↔LSN」正文里的最密来源取**实测值**（归档文件），不是写死的 V$RLOG_HISTORY');
ok(
  /只在连续窗口 2026-10-12 12:00:00 ~ 2026-10-12 12:00:02/.test(tlText) && /窗口之外最大相邻间距 \*\*60\.0 小时\*\*/.test(tlText),
  '正文写出「最密窗口」与「窗口外最大间距」两个实测值',
);
// ★ §40 去重回归：这两个数字**只许出现一次**（原来 note 与下面的说明各写一遍，同一节里说两遍）
ok(
  (tlText.match(/窗口之外最大相邻间距/g) ?? []).length === 1,
  '★ §40：同一节里「窗口外最大间距」只出现一次（去重前 note 与说明各写一遍）',
);
ok(/本次只取到 \*\*1 行\*\*/.test(tlText), '正文写出本次 `V$RLOG_HISTORY` 取到几行（DMDSC 上确实只有 1 行）');
// ★ §35：新增的两类锚点与"服务端有入口但本插件不用"都必须在正文里说清
ok(
  /每个\*\*已关闭\*\*的归档文件贡献\*\*两个\*\*锚点/.test(tlText) && /STATUS=ACTIVE.*只算「开」/.test(tlText),
  '★ 正文写明归档文件贡献「开/关」两个锚点，且 ACTIVE 只算「开」（否则读者不知道精度从哪来）',
);
ok(
  /闪回事务锚点.*本次取到 \*\*0 条\*\*/.test(tlText.replace(/\n/g, '')) && /不是"没有对应关系"/.test(tlText),
  '★ 闪回事务锚点 0 条时如实说（本库未开闪回），不静默略过',
);
ok(
  /DBMS_LOGMNR/.test(tlText) && /start_logmnr\(\).*不是 SELECT/.test(tlText.replace(/\n/g, '')),
  '★ 写明「服务端确实有换算入口（DBMS_LOGMNR），但本插件刻意不用」—— 否则「无法判定」会被误读成达梦没这能力',
);
const tlSrc = fsmod.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8');
ok(!/本环境一分钟只推进 28 个 LSN/.test(tlSrc), '★ 删掉写死的「本环境一分钟只推进 28 个 LSN」（那是单实例的实测值）');
ok(!/最密的一档是 `V\$RLOG_HISTORY`/.test(tlSrc), '★ 删掉写死的「最密的一档是 V$RLOG_HISTORY」');

console.log('\n=== 6. DMDSC 多节点模块离线检查（不连库）===');

const dsc = await import(pathToFileURL(path.join(PKG, 'lib', 'dsc.js')).href);

const tl = dsc.parseTargets('10.0.0.1:7236, 10.0.0.2:7237\n10.0.0.3');
ok(tl.length === 3 && tl[2].port === 5236, 'parseTargets 支持逗号/空格/换行且默认端口 5236');
ok(dsc.parseTargets('10.0.0.1:1,10.0.0.1:1').length === 1, 'parseTargets 去重');
ok(dsc.parseTargets('[::1]:5236')[0].host === '::1', 'parseTargets 支持 IPv6 字面量');
ok(dsc.parseTargets('').length === 0 && dsc.parseTargets(undefined).length === 0, 'parseTargets 空输入返回 []');

// 夹具按真机形状：V$DM_INI 是 PARA_NAME/PARA_VALUE 两列的结果集
const PN = ['PARA_NAME', 'PARA_VALUE'];
const mkNode = (label, inst, interval) => ({
  label,
  params: { columns: PN, rows: [['PAGE_CHECK_POLICY', 1], ['PTX_ROLLBACK', 0]] },
  archParams: { columns: PN, rows: [['ARCH_SPACE_CHECK_INTERVAL', interval]] },
  database: { columns: ['ARCH_MODE', 'DSC_NODES'], rows: [['Y', 2]] },
  instance: { columns: ['INSTANCE_NAME', 'STATUS$'], rows: [[inst, 'OPEN']] },
});
const cons = dsc.judgeConsistency([mkNode('A', 'DSC01', 600), mkNode('B', 'DSC02', 300)]);
ok(cons.labels.join() === 'A,B', 'judgeConsistency 保留节点标签');
const divNames = cons.divergent.map((d) => d.name);
ok(divNames.includes('ARCH_SPACE_CHECK_INTERVAL'), '识别出节点间不一致的参数');
// 实例名本来就该逐节点不同 —— 若把它算成「不一致」，第一次真机运行就会有假告警
ok(!divNames.includes('V$INSTANCE.INSTANCE_NAME'), 'INSTANCE_NAME 本就应不同，不计入不一致');
ok(cons.divergent.length === 1, `不一致项恰好 1 个（实得 ${cons.divergent.length}）`);
ok(cons.rows[0].name === 'ARCH_SPACE_CHECK_INTERVAL', '不一致项排在最前，便于一眼看到');

// ★ 三态：「都未取到」**不等于**「都一致」（DMDSC 真机上 ARCH_HANG_FLAG 两节点都返回空）
const mkHangNode = (label, hang) => ({
  label,
  params: { columns: PN, rows: [] },
  archParams: { columns: PN, rows: [] },
  database: { columns: ['DSC_NODES'], rows: [[2]] },
  instance: { columns: ['INSTANCE_NAME'], rows: [[label]] },
  archTargets: {
    columns: ['ARCH_NAME', 'ARCH_HANG_FLAG'],
    rows: [['ARCHIVE_LOCAL1', hang]],
  },
});
const consBoth1 = dsc.judgeConsistency([mkHangNode('A', 1), mkHangNode('B', 1)]);
ok(consBoth1.rows.find((r) => r.name.includes('ARCH_HANG_FLAG')).same === true, '两节点都取到且相同 → ✅ 一致');
const consBothNull = dsc.judgeConsistency([mkHangNode('A', null), mkHangNode('B', null)]);
const hangRow = consBothNull.rows.find((r) => r.name.includes('ARCH_HANG_FLAG'));
ok(hangRow.same === null && consBothNull.divergent.length === 0, '★ 两节点都未取到 → `same: null`（不是 true，也不算"不一致"）');
const consNullTxt = dsc.renderDsc({
  coverage: dsc.describeCoverage({ dscNodes: 2, targets: [], connected: ['A', 'B'] }),
  consistency: consBothNull,
  failed: [],
});
ok(/❔ \*\*两边都没取到，未比较\*\*/.test(consNullTxt), '★ 渲染成「❔ 两边都没取到，未比较」—— 第一版打的是 ✅');
ok(/「都未取到」不等于「都一致」/.test(consNullTxt), '并把这句纪律写进正文');
const consOneNull = dsc.judgeConsistency([mkHangNode('A', 1), mkHangNode('B', null)]);
ok(
  consOneNull.rows.find((r) => r.name.includes('ARCH_HANG_FLAG')).same === false &&
    consOneNull.divergent.length === 1,
  '一个节点有值、另一个没返回 → 仍算**不一致**（一边有保护、另一边未知，值得报）',
);

ok(
  dsc.describeCoverage({ dscNodes: 2, targets: tl.slice(0, 2), connected: ['A'] }).state === 'partial',
  '2 节点只查 1 个 → partial（并明确说「覆盖不完整」）',
);
ok(dsc.describeCoverage({ dscNodes: 1, targets: [], connected: ['A'] }).state === 'single', 'DSC_NODES=1 → single');
ok(dsc.describeCoverage({ dscNodes: 2, targets: [], connected: ['A', 'B'] }).state === 'full', '查全 2 个 → full');
ok(
  dsc.describeCoverage({ dscNodes: 2, targets: tl, connected: ['A', 'B'], failedCount: 1 }).state ===
    'full-with-failures',
  '有连接失败的目标时不再宣称「完整」',
);
// 回归：`Number(null)===0` 且 `Number.isFinite(0)===true`，
// 若不做显式排除，取不到节点数会落进 `n<=1` 分支，把 DMDSC **谎报成单实例**。
ok(dsc.describeCoverage({ dscNodes: null, connected: ['A'] }).state === 'unknown', 'DSC_NODES=null → unknown');
ok(dsc.describeCoverage({ dscNodes: '', connected: ['A'] }).state === 'unknown', 'DSC_NODES 空串 → unknown');
ok(dsc.describeCoverage({ dscNodes: 'abc', connected: ['A'] }).state === 'unknown', 'DSC_NODES 非数字 → unknown');
// 单实例上不能出现「DMDSC 节点」字样 —— 会让人以为形态判断错了
const dscSingleTxt = dsc.renderDsc({
  coverage: dsc.describeCoverage({ dscNodes: 1, targets: [], connected: ['A'] }),
  consistency: { labels: ['A'], rows: [], divergent: [] },
  failed: [],
});
ok(
  !/^## DMDSC/m.test(dscSingleTxt) && /单实例/.test(dscSingleTxt),
  '单实例不以「DMDSC 节点覆盖」为小节标题（正文可提及 DMDSC 作为将来选项）',
);
const dscMultiTxt = dsc.renderDsc({
  coverage: dsc.describeCoverage({ dscNodes: 2, targets: [], connected: ['A', 'B'] }),
  consistency: { labels: ['A', 'B'], rows: [{ name: 'X', vals: ['1', '1'], same: true, informational: false }], divergent: [] },
  failed: [],
});
ok(/DMDSC \*\*2 节点\*\*/.test(dscMultiTxt) && /节点间配置一致性/.test(dscMultiTxt), 'DMDSC 输出保留节点覆盖与一致性两节');

// GV$ERROR_PAGE 与 V$ERROR_PAGE 列完全相同（实测 8 列），没有节点列
const EP = ['TS_ID', 'FILE_ID', 'PAGE_NO', 'ERRCODE', 'RECORD_TIME', 'DB_MAGIC', 'FILE_NAME', 'LINE_NO'];
const pdf = (rows) => ({ columns: EP, rows });
const at = dsc.attributePages([
  { label: 'A', res: pdf([[4, 0, 100, 48, 't1', 1, 'main.dbf', 1], [4, 0, 200, 48, 't2', 1, 'main.dbf', 1]]) },
  { label: 'B', res: pdf([[4, 0, 100, 48, 't3', 1, 'main.dbf', 1]]) },
]);
ok(at.length === 2, 'attributePages 按页三元组归并（2 个不同页）');
ok(at[0].nodes.join() === 'A,B' && at[1].nodes.join() === 'A', 'attributePages 标出「哪些节点记录到该页」');
const atTxt = dsc.renderNodeAttribution({ attributed: at, labels: ['A', 'B'], failed: [] });
ok(/两节点都记录到/.test(atTxt) && /仅此节点记录到/.test(atTxt), 'renderNodeAttribution 区分单/双节点归属');
ok(/假阴性/.test(dsc.renderNodeAttribution({ attributed: [], labels: ['A'], failed: [] })), '无坏页时仍带假阴性免责');

console.log('\n=== 6b. 归档推荐的「节点系数」（单实例 vs DMDSC）===');
const arch = await import(pathToFileURL(path.join(PKG, 'lib', 'archive.js')).href);
const growthFix = {
  ok: true,
  avgMBPerHour: 100,
  peakMBPerHour: 200,
  peakToAvgRatio: 2,
  activeIntervalRatio: 1,
  peakIsLowerBound: '（夹具）',
};
const baseArgs = { growth: growthFix, totalMB: 81856, freeMB: 73984, retentionHours: 24 };
const recDsc2 = arch.recommendArchiveParams({ ...baseArgs, nodeFactor: 2 });
const recSingle = arch.recommendArchiveParams({ ...baseArgs, nodeFactor: 1 });
const recUnknown = arch.recommendArchiveParams({ ...baseArgs, nodeFactor: null });
// ★ 速率是「上一段采样窗口的观测」，**不能外推到未来** —— 所以任何由它算出的上限
//   都不作为推荐给出。这与「禁止安全系数」是同一条原则：不能拿不可验证的前提算出的数字
//   当推荐值，那会让人以为算过了。
ok(
  recDsc2.recommendations.ARCH_SPACE_LIMIT.value === null,
  'ARCH_SPACE_LIMIT 不给推荐值（速率不可外推）',
);
ok(
  /不构成推荐/.test(recDsc2.recommendations.ARCH_SPACE_LIMIT.why),
  '仍把假设性换算列出，但明说「不构成推荐」',
);
ok(
  /历史速率预测不了未来增长/.test(recDsc2.recommendations.ARCH_SPACE_LIMIT.why),
  'why 里写明了为什么不给数值',
);
ok(recUnknown.recommendations.ARCH_SPACE_LIMIT.value === null, '拿不到节点数时同样不给数值');
// ARCH_SPACE_LIMIT=0 在达梦里表示「不限制」，取整成 0 会把「设保护」变成「不设」
const recTiny = arch.recommendArchiveParams({
  ...baseArgs,
  retentionHours: 1,
  growth: { ...growthFix, avgMBPerHour: 0.1, peakMBPerHour: 0.1 },
  nodeFactor: 1,
});
ok(
  /最小 1 GB/.test(recTiny.recommendations.ARCH_SPACE_LIMIT.why),
  '小需求时 why 里说明已抬到最小 1 GB（0 在达梦里=不限制，取整成 0 会把「设保护」变成「不设」）',
);

// 回归：measureGrowth 的第一参数必须是**采样序列数组**。
// 传两个样本对象进去会静默失败（Array.isArray 为 false → 永远报「至少需要两次采样」），
// 这正是先前真机上 capacity **从来没有测出过速率**的原因。
const mkFiles = (paths) => ({
  columns: ['PATH', 'STATUS', 'LEN', 'ARCH_LSN', 'CLSN', 'NEXT_SEQ', 'CREATE_TIME'],
  rows: paths.map((p) => [p, 'ACTIVE', 134217728, 1, 1, 1, '2026-10-10 10:00:00']),
});
const gOk = arch.measureGrowth(
  [
    { files: mkFiles(['/a/arch1.log']) },
    { files: mkFiles(['/a/arch1.log', '/a/arch2.log']), hours: 1 },
  ],
  { fileSizeMB: 128 },
);
ok(
  gOk.ok === true && Math.abs(gOk.avgMBPerHour - 128) < 0.001,
  `measureGrowth 用采样数组算出 128 MB/h（实得 ${gOk.ok ? gOk.avgMBPerHour : gOk.reason}）`,
);
const gBad = arch.measureGrowth(
  { files: mkFiles(['/a/1']) },
  { files: mkFiles(['/a/1', '/a/2']) },
  { hours: 1 },
);
ok(
  gBad.ok === false && /两次采样/.test(gBad.reason ?? ''),
  '旧写法（两个对象当位置参数）会失败 —— 锁住这个回归',
);

console.log('\n=== 7. 坏页路径夹具（两个环境的 V$ERROR_PAGE 都是 0 行，此处把形状冻结下来）===');
/**
 * 为什么要有这一节：DMDSC 与单实例的 `V$ERROR_PAGE` **都是 0 行**，
 * 也就是本插件存在的理由那条路径（列出坏页 → 分诊到具体对象）**从未被真实数据走过**。
 * 而且 DMDSC 环境已下线，无法再回去复验。所以把「当时跑出来的形状」固化成断言 ——
 * 这比依赖环境长期在线可靠，也是 DESIGN §13.7 记下的那条教训。
 *
 * 夹具列名全部取自实测：V$ERROR_PAGE 8 列、V$REPAIRED_PAGE 5 列（后者没有 ERRCODE/FILE_NAME）。
 */
const an = await import(pathToFileURL(path.join(PKG, 'lib', 'analyze.js')).href);
const EP8 = ['TS_ID', 'FILE_ID', 'PAGE_NO', 'ERRCODE', 'RECORD_TIME', 'DB_MAGIC', 'FILE_NAME', 'LINE_NO'];
const RP5 = ['TS_ID', 'FILE_ID', 'PAGE_NO', 'RECORD_TIME', 'DB_MAGIC'];
const fx = an.buildPageList({
  errorPage: {
    columns: EP8,
    rows: [
      [4, 0, 50448, 48, '2026-10-10 10:00:00', 1, 'MAIN.DBF', 1],
      [4, 0, 50450, 48, '2026-10-10 10:05:00', 1, 'MAIN.DBF', 1],
      [4, 0, 50452, 48, '2026-10-10 10:10:00', 1, 'MAIN.DBF', 1],
      [4, 0, 50452, 48, '2026-10-10 12:00:00', 1, 'MAIN.DBF', 1],
    ],
  },
  repairedPage: {
    columns: RP5,
    rows: [
      [4, 0, 50448, '2026-10-10 11:00:00', 1],
      [4, 0, 50452, '2026-10-10 10:30:00', 1],
    ],
  },
  // GV$ 与 V$ 的列结构完全相同（实测），DMDSC 上会把同一页再给一遍 —— 必须去重
  gvErrorPage: { columns: EP8, rows: [[4, 0, 50448, 48, '2026-10-10 10:00:00', 1, 'MAIN.DBF', 1]] },
  gvRepairedPage: { columns: RP5, rows: [[4, 0, 50448, '2026-10-10 11:00:00', 1]] },
  skipCpage: {
    columns: ['SESS_ID', 'STMT_ID', 'EXEC_ID', 'NODE_SEQ', 'INDEX_ID', 'N_TOTAL', 'SEQ_NO', 'GROUP_ID', 'FILE_ID', 'PAGE_NO'],
    rows: [[1, 1, 1, 0, -1, 3, 2, 4, 0, 50450]],
  },
});
const statusOf = (p) => fx.entries.find((e) => e.pageNo === p)?.status;
ok(fx.counts.distinctPages === 3, `4 条错误行 + GV$ 重复行去重成 3 页（实得 ${fx.counts.distinctPages}）`);
ok(statusOf(50448) === 'repaired', '坏→修 判为 repaired');
ok(statusOf(50450) === 'never-repaired', '只坏没修 判为 never-repaired');
ok(statusOf(50452) === 're-corrupted', '坏→修→**又坏** 判为 re-corrupted');
ok(fx.needAttention.length === 2, `needAttention 恰为 2（repaired 不该进；实得 ${fx.needAttention.length}）`);
const rcN = Array.isArray(fx.reCorrupted) ? fx.reCorrupted.length : fx.reCorrupted;
ok(rcN === 1, `reCorrupted 单独列出且恰好 1 页（实得 ${rcN}）`);
ok(Boolean(fx.disclaimer), '假阴性免责随数据一起返回，不只在渲染层');

const tsMapFx = an.tablespaceMap({ columns: ['ID', 'NAME'], rows: [[4, 'MAIN']] });
const tg = fx.entries.filter((e) => e.status === 'never-repaired' || e.status === 're-corrupted');
const lk = an.buildReverseLookups(tg, tsMapFx);
ok(
  lk.length === 2 && lk.every((l) => /BLOCK_ID <= \d+ AND BLOCK_ID \+ BLOCKS > \d+/.test(l.sql)),
  '反查 SQL 用实测的半开区间写法（首页与末页都命中、越界 0 行，两环境已各验一次）',
);
const extRes = {
  columns: ['OWNER', 'SEGMENT_NAME', 'SEGMENT_TYPE', 'PARTITION_NAME', 'TABLESPACE_NAME', 'FILE_ID', 'BLOCK_ID', 'BLOCKS', 'BYTES'],
  rows: [['AWR1', 'INDEX33570166', 'INDEX', '', 'MAIN', 0, 50448, 8, 262144]],
};
const en = an.attachObjects(tg, lk, lk.map(() => extRes));
ok(en.length === 2 && en.every((e) => e.object?.segmentName === 'INDEX33570166'), 'attachObjects 把坏页定位到具体对象');
ok(en.every((e) => e.object?.matchCount === 1), 'matchCount 记录命中条数（可用于发现区间重叠异常）');

// 逐节点核对归档目标：`V$DM_ARCH_INI` 是节点级的，两节点 ARCH_HANG_FLAG 不同
// 就意味着只有一个节点受保护 —— 这是单节点视角绝对看不出来的。
const archRow = (limit, hang) => ({
  columns: [
    'ARCH_NAME', 'ARCH_TYPE', 'ARCH_DEST', 'ARCH_IS_VALID',
    'ARCH_FILE_SIZE', 'ARCH_SPACE_LIMIT', 'ARCH_HANG_FLAG',
  ],
  rows: [['ARCHIVE_LOCAL1', 'LOCAL', '/x/arch', 'Y', 1024, limit, hang]],
});
const cHang = dsc.judgeConsistency([
  { ...mkNode('A', 'DSC01', 600), archTargets: archRow(2048, 1) },
  { ...mkNode('B', 'DSC02', 600), archTargets: archRow(2048, 0) },
]);
ok(cHang.divergent.some((r) => /ARCH_HANG_FLAG/.test(r.name)), '识别出两节点 ARCH_HANG_FLAG 不一致');
const cLimit = dsc.judgeConsistency([
  { ...mkNode('A', 'DSC01', 600), archTargets: archRow(2048, 1) },
  { ...mkNode('B', 'DSC02', 600), archTargets: archRow(1024, 1) },
]);
ok(cLimit.divergent.some((r) => /ARCH_SPACE_LIMIT/.test(r.name)), '识别出两节点 ARCH_SPACE_LIMIT 不一致');
// ARCH_DEST 本来就该逐节点不同（各节点自己的归档目录 / 对端节点名），比进来只会是假告警
ok(
  !cHang.rows.some((r) => /ARCH_DEST/.test(r.name)),
  'ARCH_DEST 不参与比较（本就应逐节点不同，避免假告警）',
);
const cSame = dsc.judgeConsistency([
  { ...mkNode('A', 'DSC01', 600), archTargets: archRow(2048, 1) },
  { ...mkNode('B', 'DSC02', 600), archTargets: archRow(2048, 1) },
]);
ok(cSame.divergent.length === 0, `归档目标完全一致时无假告警（实得 ${cSame.divergent.length} 项）`);

console.log('\n=== 8. 恢复场景引擎（16 场景 × 分支）===');
const sc = await import(pathToFileURL(path.join(PKG, 'lib', 'scenarios.js')).href);

// 一份「什么都不缺」的地基，再逐项拆掉来验分支
const good = {
  archOn: true, enableFlashback: '1', undoRetention: 90,
  ctlBakPath: '/x/ctl_bak', ctlBakNum: 10, bakPath: '+G/bak',
  hasStandby: true, hasBadPages: true, backupsCount: 2, backupVerified: true,
  archiveTargets: 2, archiveChainOk: true, earliestArchLsn: 100, backupBeginLsn: 200,
  dscNodes: 2, checkedNodes: 2, rlogMirrored: true, recyclebinEnabled: true,
  offsiteCopy: true, tsStatus: 'ONLINE',
};
const capAt = (f, id) => sc.assessScenarios({ ...good, ...f }).find((s) => s.id === id);
const gs = sc.assessScenarios(good);

ok(gs.length === 16, `场景清单共 16 个（实得 ${gs.length}）`);
ok(gs.every((s) => s.cap === 'ok' || s.cap === 'partial'), '地基齐全时没有「不可恢复」或「无法判定」');
ok(
  gs.filter((s) => s.cap === 'partial').map((s) => s.id).join() === 'A4,A5',
  '只有 A4/A5 因「无逻辑导出副本」保持粗粒度（其余都能救）',
);

// ★ 最重要的一条：信息不足必须判 unknown，**绝不能**默认成 ok
const bs = sc.assessScenarios({});
ok(!bs.some((s) => s.cap === 'ok'), '全部事实未知时**没有任何场景**被判为 ok（不留白成安全）');
ok(bs.filter((s) => s.cap === 'unknown').length >= 4, `未知事实时多个场景为 unknown（实得 ${bs.filter((s) => s.cap === 'unknown').length}）`);

// A1 / A2：闪回是最高频场景的关键
ok(capAt({ enableFlashback: '1' }, 'A1').cap === 'ok', 'A1 闪回开启 => 可恢复');
ok(capAt({ enableFlashback: '0' }, 'A1').cap === 'partial', 'A1 闪回关闭但有时间点恢复 => 仅粗粒度');
ok(capAt({ enableFlashback: '0', archOn: false }, 'A1').cap === 'none', 'A1 闪回关闭且归档未开 => 不可恢复');
ok(/ENABLE_FLASHBACK 未开启/.test(capAt({ enableFlashback: '0' }, 'A1').gap ?? ''), 'A1 明确指出缺口是 ENABLE_FLASHBACK');
ok(capAt({ enableFlashback: '0', recyclebinEnabled: true }, 'A2').cap === 'ok', 'A2 回收站有内容可顶替闪回');
ok(capAt({ enableFlashback: '0', recyclebinEnabled: null }, 'A2').cap === 'partial', 'A2 回收站未确认时不冒充可恢复');

// B1 备库 / B3 控制文件备份 / B4 日志镜像 / B5 归档冗余
ok(capAt({ hasStandby: true }, 'B1').cap === 'ok' && capAt({ hasStandby: false }, 'B1').cap === 'partial', 'B1 有备库可在线修，无备库只能粗粒度');
ok(capAt({ ctlBakNum: 0 }, 'B3').cap === 'none', 'B3 无控制文件备份 => 不可恢复');
ok(capAt({ ctlBakNum: '10', ctlBakPath: '/x' }, 'B3').cap === 'ok', 'B3 有控制文件备份 => 可恢复');
ok(capAt({ rlogMirrored: false, archOn: false }, 'B4').cap === 'none', 'B4 无镜像且无法重建 => 不可恢复');
ok(capAt({ archiveTargets: 1 }, 'B5').cap === 'partial' && capAt({ archiveTargets: 2 }, 'B5').cap === 'ok', 'B5 归档目标数决定有无冗余');

// B6：本场景假设「备份损坏」，所以只有一份就是没有后备
ok(sc.assessScenarios({ ...good, backupsCount: 1 }).find((s) => s.id === 'B6').cap === 'none', 'B6 只有 1 份备份 => 不可恢复（它正是被假设损坏的那份）');
ok(capAt({ backupVerified: false }, 'B6').cap === 'partial', 'B6 多份但未 dmrman 校验 => 仅粗粒度');
ok(sc.assessScenarios({}).find((s) => s.id === 'B6').cap === 'unknown', 'B6 份数未取到 => unknown');

// ============ §46.5「账本为空」不等于「确定没有备份」============
// 真机实测触发的场景：还原之后控制文件回退到备份开始那一刻 ⇒ 账本空、磁盘上备份都在。
// 那时旧逻辑把 12 个场景判成"当前救不回来"，而同一份报告里还写着"账本为空不等于没有备份"。
{
  const emptyUncertain = { ...good, backupsCount: 0, backupsUncertain: true, backupFilesFound: 3 };
  const emptyAbsent = { ...good, backupsCount: 0, backupsUncertain: false, backupFilesFound: 0 };
  // ⚠️ 用 A4/A5 验：它们**直接**依赖 `timePoint`；A1/A2/A3 在 `good` 夹具里会被闪回/回收站满足，验不到这条路径
  const a4u = sc.assessScenarios(emptyUncertain).find((s) => s.id === 'A4');
  const a4a = sc.assessScenarios(emptyAbsent).find((s) => s.id === 'A4');
  ok(a4u.cap === 'unknown', '★ §46.5：账本空 + 磁盘上找到备份文件 ⇒ 场景判 **unknown**（不是 none）');
  ok(
    /账本为空不等于没有备份/.test(a4u.how) && /3/.test(a4u.how),
    '★ §46.5：理由里点明"账本为空不等于没有备份"，并报出磁盘上找到了几个',
  );
  ok(a4a.cap === 'none', '★ §46.5：账本空 **且** 文件系统也确认没找到 ⇒ 才允许判 none');
  ok(sc.assessScenarios(emptyUncertain).find((s) => s.id === 'A5').cap === 'unknown', '★ §46.5：A5 同理（原来也落到 none）');
  ok(
    sc.assessScenarios({ ...emptyUncertain, hasStandby: false }).find((s) => s.id === 'B1').cap === 'unknown',
    '★ §46.5：B1 同理（**无备库**时它才依赖时间点恢复；`good` 夹具里 hasStandby=true 会先走备库分支）',
  );
  ok(sc.assessScenarios(emptyUncertain).find((s) => s.id === 'B6').cap === 'unknown', '★ §46.5：B6 同样（账本空但未确认 ⇒ unknown）');
  ok(sc.assessScenarios(emptyAbsent).find((s) => s.id === 'B6').cap === 'none', '★ §46.5：B6 确认没有备份 ⇒ none');
  // 三态判定函数本身
  ok(sc.backupPresence({ backupsCount: 2 }) === true, '`backupPresence`：有备份 ⇒ true');
  ok(sc.backupPresence({ backupsCount: 0, backupsUncertain: true }) === 'unknown', '`backupPresence`：账本空且未确认 ⇒ unknown');
  ok(sc.backupPresence({ backupsCount: 0, backupsUncertain: false }) === false, '`backupPresence`：账本空且已确认没有 ⇒ false');
  // 条件表必须同源：不确定时画 ❔，不许画 ❌
  const cA4 = sc.assessConditions(sc.assessScenarios(emptyUncertain), emptyUncertain).find((s) => s.id === 'A4');
  const archCond = cA4.conds.find((c) => c.key === 'ARCH_ON');
  ok(
    archCond && archCond.state === 'unknown',
    '★ §46.5：条件表里的「可重建」同源画 **unknown**（旧写法无条件画 ❌，与判定打架）',
  );
}

// B7 / C3：异地副本，只做单向推断
ok(capAt({ offsiteCopy: false }, 'B7').cap === 'none' && capAt({ offsiteCopy: false }, 'C3').cap === 'none', '确认与数据同存储 => B7/C3 不可恢复');
ok(capAt({ offsiteCopy: null }, 'B7').cap === 'unknown' && capAt({ offsiteCopy: null }, 'C3').cap === 'unknown', '无法判定同存储 => unknown（不猜）');

// 分级依据是场景，不是参数
const gNone = sc.gradeScenarios(sc.assessScenarios({ ...good, offsiteCopy: false }));
ok(gNone.some((x) => x.level === 'crit' && /救不回来/.test(x.title)), '有不可恢复场景时给出严重级');
// gs 里有 A4/A5 两个 partial（无逻辑导出副本），所以**应当**出 1 条警告、0 条严重
const gGood = sc.gradeScenarios(gs);
ok(gGood.length === 1 && gGood[0].level === 'warn', `仅剩粗粒度场景时只给警告（实得 ${gGood.length} 项）`);
ok(!gGood.some((x) => x.level === 'crit'), '没有不可恢复场景时**不给**严重级');

const md = sc.renderScenarioMatrix(gs);
ok(['A1', 'A5', 'B1', 'B8', 'C3'].every((id) => md.includes(`| ${id} |`)), '场景矩阵包含全部场景行');
ok(/不可恢复 \d+ 项/.test(md), '矩阵给出合计');
ok(sc.renderScenarioEvidence(gs).includes('ENABLE_FLASHBACK'), '证据表摊开了场景依赖的实测值');

console.log('\n=== 8a-2. 条件表：四态 + 与判定同源（真机报告两个硬缺陷的回归）===');
/**
 * 真机报告（`.dm-home/dm-recovery-reports/dm-recovery-DAMENG-20261012-092343.html`）抓到的两个硬缺陷：
 *
 *   ① **C1 自相矛盾**：条件表里 `DSC_NODES > 1 ❌`，紧接着却打印
 *      「✅ 该场景所需条件**全部满足**」—— 因为旧代码的判据是 `advice.length === 0`
 *      而 `DSC` 在 ADVICE 表里没有条目，于是被滤空、走进了"全部满足"分支。
 *   ② **A4/A5/B2/B8 的条件表是空的**（渲染成「（本节尚未结构化）」），
 *      而 B2/B8 恰是判定为「可恢复」的场景 —— 读者无从核对那个 ✅ 靠什么成立。
 *
 * 下面这些断言就是这两个缺陷的回归。
 */
const richFx = (facts) => sc.assessConditions(sc.assessScenarios(facts), facts);

// 与那份真机报告同一形状的夹具（单实例、归档开、1 份备份、无备库、无异地副本）
const realShape = {
  archOn: true, enableFlashback: '0', undoRetention: 90,
  ctlBakPath: '/home/dmdba/dmdbms/data/DAMENG/ctl_bak', ctlBakNum: 10,
  bakPath: '/home/dmdba/dmdbms/data/DAMENG/bak',
  hasStandby: false, hasBadPages: false, backupsCount: 1, backupVerified: true,
  archiveTargets: 1, archiveChainOk: true, earliestArchLsn: 132032628, backupBeginLsn: 132032738,
  dscNodes: 1, checkedNodes: 1, rlogMirrored: true, recyclebinEnabled: false,
  offsiteCopy: false, tsStatus: null,
};
const rich = richFx(realShape);
const blockOf = (id) => {
  const txt = sc.renderScenarioBlocks(rich);
  const seg = txt.split(/^#### /m).find((x) => x.startsWith(id));
  return seg ? '#### ' + seg.split(/^#### /m)[0] : '';
};

// ① C1：不适用，且**不再**说「全部满足」
const c1 = rich.find((s) => s.id === 'C1');
ok(c1.naConds.length === 1 && c1.unmet.length === 0, 'C1 在单实例上判为「不适用」而不是「未满足」或「满足」');
const c1Block = blockOf('C1');
ok(!/全部满足/.test(c1Block), '**C1 不再出现「全部满足」**（这正是真机报告里的自相矛盾）');
ok(/不适用/.test(c1Block) && /—/.test(c1Block), 'C1 明说「本库不适用」，条件标记是「—」');
// 通用不变量：任何有未满足项的场景都不许说「全部满足」
const anyContradiction = rich
  .filter((s) => s.unmet.length > 0)
  .filter((s) => /全部满足/.test(blockOf(s.id)));
ok(anyContradiction.length === 0, `有未满足项的场景一律不说「全部满足」（实得 ${anyContradiction.length} 个违规）`);
// 未满足但无建议时，必须显式报出来（C1 的通用修法；换个场景没 ADVICE 也不会再谎报）。
// 直接喂渲染器一个「有未满足项、但 ADVICE 表里没有它」的假场景 —— 目前 16 个真实场景
// 都取不到这个形状（唯一没建议的 DSC 在单实例上已是「不适用」），所以只能这样测。
const fakeUnmet = {
  id: 'X', group: 'G. 夹具', name: '没有建议的未满足项', cap: 'none', how: '夹具', gap: null,
  conds: [{ key: 'NO_SUCH_KEY', name: '没有建议的条件', require: 'R', actual: 'A', state: 'unmet', met: false }],
  unmet: [{ key: 'NO_SUCH_KEY', name: '没有建议的条件', require: 'R' }],
  unknowns: [], naConds: [],
  unmetNoAdvice: [{ key: 'NO_SUCH_KEY', name: '没有建议的条件', require: 'R' }],
  advice: [],
};
const fakeTxt = sc.renderScenarioBlocks([fakeUnmet]);
ok(/没有对应的可执行建议/.test(fakeTxt), '未满足但无建议的项被**显式列出**（"没有建议"不等于"满足"）');
ok(!/全部满足/.test(fakeTxt), '该情形下**不**输出「全部满足」（这就是 C1 那个矛盾的通用成因）');

// ② 四个场景的条件表必须有内容（不能再是「（本节尚未结构化）」）
for (const id of ['A4', 'A5', 'B2', 'B8']) {
  const s = rich.find((x) => x.id === id);
  ok(s.conds.length > 0, `${id} 有了结构化条件表（旧版渲染成「本节尚未结构化」）`);
}
ok(!/尚未结构化/.test(sc.renderScenarioBlocks(rich)), '整份正文里不再出现「（本节尚未结构化）」');
// B2/B8 是「可恢复」场景 —— 现在能看见它靠什么成立
ok(blockOf('B2').includes('归档已开') && /✅/.test(blockOf('B2')), 'B2「可恢复」这个结论现在有可核对的条件行');
ok(blockOf('B8').includes('时间点恢复'), 'B8 同样摊开了「时间点恢复」条件');

// ③ 四态语义：未取到／不适用都**不能**画成 ❌
ok(sc.COND_MARK.unknown === '❔' && sc.COND_MARK.na === '—' && sc.COND_MARK.unmet === '❌', '四态各有各的标记（未取到 ≠ 不满足）');
const a4 = rich.find((s) => s.id === 'A4');
ok(a4.unknowns.length === 1 && /逻辑导出/.test(a4.unknowns[0].name), 'A4「逻辑导出副本」标为**未取到**（库内无登记入口，不敢画 ❌ 也不敢画 ✅）');
ok(/未取到不等于满足/.test(blockOf('A4')), 'A4 明说「未取到不等于满足」');
ok(!/缺口：无逻辑导出副本/.test(blockOf('A4')), 'A4 的「缺口」措辞与条件表一致（不再断言「确认了没有」）');

// ④ 与判定同源：归档链连续性未判定时，条件表必须是「❔」而不是 ❌ 或 ✅
const tpUnknown = richFx({ ...realShape, archiveChainOk: null }).find((s) => s.id === 'A1');
ok(
  tpUnknown.conds.find((c) => c.key === 'ARCH_ON').state === sc.COND.UNKNOWN,
  '归档链连续性未判定时，条件表标「未取到」—— 条件表与 timePoint() 同源（先前 A2/A3 手抄漏了 archiveChainOk）',
);
const tpMissing = richFx({ ...realShape, archOn: false }).find((s) => s.id === 'A1');
ok(tpMissing.conds.find((c) => c.key === 'ARCH_ON').state === sc.COND.UNMET, '归档未开时条件表标「未满足」（真的缺口）');

// ⑤ 跨夹具不变量：换几套差异很大的事实，条件表都必须**结构自洽**。
//    单点断言只能挡住已发现的形状；这一条挡住"换个环境又冒出一个自相矛盾"。
const shapes = {
  真机单实例: realShape,
  什么都齐全: { ...realShape, enableFlashback: '1', backupsCount: 2, archiveTargets: 2, dscNodes: 2, checkedNodes: 2, recyclebinEnabled: true, offsiteCopy: true, hasStandby: true, hasBadPages: true },
  什么都未知: {},
  归档链未判定: { ...realShape, archiveChainOk: null },
};
for (const [label, shape] of Object.entries(shapes)) {
  const r = richFx(shape);
  const txt = sc.renderScenarioBlocks(r);
  const blocks = txt.split(/^#### /m).slice(1);
  const contradictory = r.filter((s) => {
    const seg = blocks.find((b) => b.startsWith(s.id)) ?? '';
    return (s.unmet.length > 0 && /全部满足/.test(seg)) || (s.unmet.length === 0 && /❌/.test(seg.split('- 靠什么救')[0]));
  });
  ok(contradictory.length === 0, `[${label}] 16 个场景块无自相矛盾（实得 ${contradictory.length} 个）`);
  ok(r.every((s) => s.conds.length > 0), `[${label}] 每个场景都有结构化条件表（不再是「尚未结构化」）`);
  ok(
    r.every((s) => s.conds.every((c) => ['✅', '❌', '❔', '—'].includes(sc.COND_MARK[c.state]))),
    `[${label}] 条件标记只可能是已满足/未满足/未取到/不适用四种之一`,
  );
}

console.log('\n=== 8b. OS 访问层的安全边界（信任边界改变，必须锁死）===');
const osshMod = await import(pathToFileURL(path.join(PKG, 'lib', 'ossh.js')).href);

// safeArg：只放行路径真正会用到的字符集
for (const okPath of ['+DMDATA/data/dameng/bak/DB_x', '/home/dmdba/dmdbms/log', 'C:/dm/data', 'a.b-c_d/e+f']) {
  let threw = false;
  try { osshMod.safeArg(okPath); } catch { threw = true; }
  ok(!threw, `safeArg 放行正常路径：${okPath}`);
}
// 注入所需的一切都必须在外面
for (const bad of ["/a'; rm -rf /", "/a; rm -rf /", "/a|cat /etc/passwd", "/a&x", "/a$x", "/a`x`", "/a b", "/a\nb", "/a(x)", "/a>x", "/a<x", ""]) {
  let threw = false;
  try { osshMod.safeArg(bad); } catch { threw = true; }
  ok(threw, `safeArg 拒绝 ${JSON.stringify(bad).slice(0, 26)}`);
}

// 三个构造函数产出的命令形状固定
ok(
  osshMod.buildCheckBackupset('+DMDATA/data/dameng/bak/DB_x') ===
    `dmrman CTLSTMT="CHECK BACKUPSET '+DMDATA/data/dameng/bak/DB_x'"`,
  'buildCheckBackupset 产出精确形态',
);
let inj = false;
try { osshMod.buildCheckBackupset(`/a'; rm -rf /; echo '`); } catch { inj = true; }
ok(inj, '备份路径带引号时**构造阶段**就抛错（不给拼接留机会）');
ok(/^ls -la /.test(osshMod.buildFindBackups('/home/dmdba/dmdbak')), 'buildFindBackups 只产出 ls/find 形态');

// runRemote：非白名单命令一律拒绝（在 spawn 之前）
// ★ §42：执行器已改成 `async`（多节点要并发），所以"抛错"表现为**拒绝的 Promise** ——
//   断言也要跟着用 `assert.rejects`：`try { await ... } catch` 对 async 函数**同样成立**
//   （同步注入的 `run` 依旧照旧），这点很重要，否则这里会变成假通过。
for (const evil of ["rm -rf /", "dmrman", "sh /a.sh /b; id", "cat /etc/shadow", "ls -la /x"]) {
  let threw = false;
  try {
    await osshMod.runRemote({ command: evil, host: 'h', user: 'u', password: 'p' });
  } catch {
    threw = true;
  }
  ok(threw, `runRemote 拒绝非白名单命令：${JSON.stringify(evil)}`);
}
// 白名单命令能通过校验（不真的连网：给一个必然失败的主机名，只看不抛白名单错）
let reachedSpawn = false;
try {
  await osshMod.runRemote({ command: osshMod.buildCheckBackupset('/x/bak'), host: '127.0.0.1', port: 1, user: 'u', password: 'p', timeoutMs: 3000 });
  reachedSpawn = true;
} catch (e) {
  reachedSpawn = !/非白名单/.test(String(e.message));
}
ok(reachedSpawn, '白名单命令能通过校验进入执行阶段（失败在连接，不是白名单）');

// 判定必须保守：看不懂 => unknown，绝不等于 ok
ok(osshMod.judgeCheckBackupset(null).state === 'unknown', 'judgeCheckBackupset 未执行 => unknown');
ok(osshMod.judgeCheckBackupset({ status: 0, stdout: '', stderr: '' }).state === 'unknown', '无任何输出 => unknown');
ok(
  osshMod.judgeCheckBackupset({ status: 0, stdout: 'check backupset successfully', stderr: '' }).state === 'ok',
  '明确成功标志 => ok',
);
ok(
  osshMod.judgeCheckBackupset({ status: 1, stdout: 'error: backup set corrupted', stderr: '' }).state === 'bad',
  '有错误字样 => bad',
);
ok(
  osshMod.judgeCheckBackupset({ status: 0, stdout: '一些看不懂的输出', stderr: '' }).state === 'unknown',
  '**看不懂 => unknown**（不把没看懂当通过）',
);

// 「全库逐页裁决」解析
const clean = osshMod.parseCorruptionVerdict('  page check : 0 corrupted pages during backup');
ok(clean.state === 'clean' && clean.count === 0, '0 corrupted pages => clean（全库裁决：干净）');
const bad2 = osshMod.parseCorruptionVerdict('0 corrupted pages during backup\n3 corrupted pages during backup');
ok(bad2.state === 'corrupt' && bad2.count === 3, '取最坏的一次 => corrupt(3)');
ok(osshMod.parseCorruptionVerdict('啥也没有').state === 'unknown', '解析不到 => unknown');

console.log('\n=== 8c. §19.2 三项接线（ossh → action / 文档）===');
/**
 * 为什么要有这一节：`lib/ossh.js` 写完之后**长期没有任何 action 调用它**（DESIGN §19.2 记的就是这件事）。
 * 「模块写好了」与「被接线了」是两回事，而后者**离线看不出来** —— 只能靠形状断言锁住。
 * 同时把「全库逐页裁决」的解析用**真机输出**冻结成夹具（DESIGN §11.7 那次真实全备的脚本输出）。
 */
const idxSrc = fsmod.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8');
ok(/import \{[^}]*scanBackupLogViaSsh[^}]*\} from '\.\/ossh\.js'/.test(idxSrc), 'index.js 引入了 scanBackupLogViaSsh');
ok(/import \{[^}]*findBackupsViaSsh[^}]*\} from '\.\/ossh\.js'/.test(idxSrc), 'index.js 引入了 findBackupsViaSsh');
// ① 日志扫描必须真的被调用，且结论必须进 report
ok(
  /scanBackupLogViaSsh\(\{\s*logDir: node\.logDir,\s*scriptPath,\s*ssh: sshForNode\(ssh, node\)\s*\}\)/.test(idxSrc),
  'runBackupLogScan 真的调用 scanBackupLogViaSsh（§38：逐节点，用该节点的日志目录与 SSH 参数）',
);
ok(/runBackupLogScan\(\{\s*args,\s*cfg\s*\}\)/.test(idxSrc), 'backup / report 里真的调用 runBackupLogScan');
ok(/renderOsLogScan\(osLogScan/.test(idxSrc), '「全库逐页裁决」被渲染进输出（backup 与 report 各一次）');
// ② 文件系统查备份：必须被调用，且**只在非 ASM 时**才走
ok(
  /findBackupsViaSsh\(\{\s*backupDir: dir,\s*ssh: sshForNode\(ssh, node\)\s*\}\)/.test(idxSrc),
  'runFindBackupsOnDisk 真的调用 findBackupsViaSsh（§38：逐节点）',
);
ok(/pickFindDir\(\[/.test(idxSrc), 'find 之前先用 pickFindDir 选目录：**非 ASM 才跑**（ASM 上 find 只会给出反向假结论）');
// ③ 文档：README / 全部 lib 源码里「没有 SSH / 无 SSH」的过时说法必须已被改掉
//    （不只是 README —— `scenarios.js` 的**渲染文字**里也有一句，它会长在报告正文里）
const readmeSrc = fsmod.readFileSync(path.join(PKG, 'README.md'), 'utf8');
const libDir = path.join(PKG, 'lib');
const libSrcAll = fsmod
  .readdirSync(libDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => fsmod.readFileSync(path.join(libDir, f), 'utf8'))
  .join('\n');
ok(!/没有 SSH/.test(readmeSrc), 'README 里不再有「没有 SSH」这种过时说法');
ok(!/没有 SSH|无 SSH/.test(libSrcAll), 'lib/*.js 里不再有「没有 SSH / 无 SSH」这种过时说法（报告正文会用它）');
ok(/OS 访问（可选）/.test(readmeSrc), 'README 增加了「OS 访问（可选）：三条只读命令」一节');
ok(/sshLogDir/.test(readmeSrc) && /sshScriptPath/.test(readmeSrc), 'README 列出了新增的 OS 访问参数');
// ④ 自相矛盾回归：`hasBadPages` 必须把「日志裁决」也并进来。
//    否则 `V$ERROR_PAGE` 为空而全备日志说有损坏页时，同一份报告里会出现
//    「六、全库页完整性裁决：有损坏页」与「场景矩阵：没有坏页」直接打架。
//    §38 之后它读的是**合并结果**（`osAgg.anyCorrupt`：任一节点报损坏即算），
//    所以这里同时锁住"必须是 anyCorrupt（不是某个节点的状态）"。
ok(
  /hasBadPages:[^\n]*osAgg\.anyCorrupt/.test(idxSrc) && /anyCorrupt: corruptNodes\.length > 0/.test(idxSrc),
  'hasBadPages 取 V$ERROR_PAGE 与日志裁决的**并集**（多节点时 = 任一节点报损坏；防同一份报告自相矛盾）',
);
// ★ §38：多节点上"全备裁决"只在**发起全备的那个节点**的日志里 —— 合并口径必须是
//   "任一节点给出 clean 就算 clean"，否则会把已经拿到的正面结论拖成"无法判定"（真机逼出来的）
ok(
  /logScan: corruptNodes\.length > 0 \? 'corrupt' : cleanNodes\.length > 0 \? 'clean'/.test(idxSrc) &&
    /logScanNoRecord: noRecordNodes/.test(idxSrc),
  '★ 多节点日志裁决的合并口径：任一节点给出裁决即可下结论，**并披露谁给的、谁没有记录**',
);
ok(
  /「没有记录」不等于「没有坏页」/.test(idxSrc),
  '★ 正文里同时说清"没有记录 ≠ 没有坏页"，不把披露省掉',
);
// 正文小节必须**连续编号**：三个 OS 小节各取决于不同参数，只跑到一条时不能留下空缺
// （「五、…」后面直接跳到「七、…」会让读的人以为漏了一节）。
const fixed4 = [
  { title: 'A', body: 'a' },
  { title: 'B', body: 'b' },
  { title: 'C', body: 'c' },
  { title: 'D', body: 'd' },
];
const secNone = plugin.composeSections(fixed4, []);
const secLog = plugin.composeSections(fixed4, [{ title: '日志扫描', body: 'x' }]);
const secAll = plugin.composeSections(fixed4, [
  { title: '备份校验', body: 'x' },
  { title: '日志扫描', body: 'y' },
  { title: '文件系统查找', body: 'z' },
]);
const prefixes = (arr) => arr.map((s) => s.title.split('、')[0]).join('');
ok(prefixes(secNone) === '一二三四', '三个 OS 小节都没跑时正文恰好四节（一~四）');
ok(prefixes(secLog) === '一二三四五', '只跑到日志扫描时编号连续到「五」（不出现空号）');
ok(prefixes(secAll) === '一二三四五六七', '三条都跑到时编号连续到「七」');
ok(secAll.some((s) => /六、.*日志扫描/.test(s.title)), '「全库页完整性裁决」按实际顺序落位（不被写死成第六节）');

// 真机输出夹具：DESIGN §11.7 里那次真实全备的 scan-backup-log.sh 输出
const REAL_SCAN_OUT = [
  'TID0117906217',
  '  start      : backup database;',
  '  dbf reads  : 10',
  '  page check : 0 corrupted pages during backup',
  '  result     : CMD END.CODE:[0], COST:[00:00:31]',
].join('\n');
const fakeSsh = { host: 'h', user: 'u', password: 'p' };
let ranScan = null;
const scanOut = await osshMod.scanBackupLogViaSsh({
  logDir: '/home/dmdba/dmdbms/log',
  scriptPath: '/home/dmdba/scan-backup-log.sh',
  ssh: fakeSsh,
  run: ({ command }) => {
    ranScan = command;
    return { ok: true, status: 0, stdout: REAL_SCAN_OUT, stderr: '' };
  },
});
ok(
  ranScan === 'sh /home/dmdba/scan-backup-log.sh /home/dmdba/dmdbms/log',
  'scanBackupLogViaSsh 产出并执行精确的命令形态',
);
ok(scanOut.verdict.state === 'clean' && scanOut.verdict.count === 0, '真机扫描输出解析为 clean(0) —— 全库无损坏页');

const findOut = await osshMod.findBackupsViaSsh({
  backupDir: '/home/dmdba/dmbak',
  ssh: fakeSsh,
  run: () => ({
    ok: true,
    status: 0,
    stdout: [
      'total 4',
      'drwxr-xr-x 2 dmdba dmdba 4096 Oct 10 15:02 DB_dameng_FULL_20261010_150250_003731',
      '/home/dmdba/dmbak/DB_dameng_FULL_20261010_150250_003731/system.dbf.bak',
      '/home/dmdba/dmbak/DB_dameng_FULL_20261010_150250_003731/main.dbf.bak',
    ].join('\n'),
    stderr: '',
  }),
});
ok(findOut.verdict.state === 'found' && findOut.verdict.files.length === 2, 'ls/find 输出里只挑出真正的备份文件路径（ls 长格式行被排除）');
ok(
  !findOut.verdict.files.some((f) => /^drwx/.test(f) || /^total/.test(f)),
  '`total` / 权限位行不会被当成文件路径',
);
// ★ ASM 路径必须**根本不执行** find：ASM 不是文件系统，找不到文件是预期行为，
//   拿它去回答「备份是不是丢了」会得到一个反向的假结论。
let ranFind = false;
const asmFind = await osshMod.findBackupsViaSsh({
  backupDir: '+DMDATA/data/dameng/bak',
  ssh: fakeSsh,
  run: () => {
    ranFind = true;
    return { ok: true, status: 0, stdout: '', stderr: '' };
  },
});
ok(!ranFind && asmFind.command === null, '**ASM 路径下根本不执行** find（不给出反向假结论）');
ok(asmFind.verdict.state === 'not-applicable' && /ASM/.test(asmFind.verdict.detail), '并明确说明「这一步不适用」而不是「没找到」');
ok(osshMod.isAsmPath('+DMDATA/x') === true && osshMod.isAsmPath('/home/x') === false, 'isAsmPath 按 + 前缀判定');
// 「该去 find 哪个目录」：备份集本身是**目录**，只有明显是文件的候选才退到它的父目录；
// ASM 一律跳过；全是 ASM 时返回 null（= 这一步不做）。
ok(
  osshMod.pickFindDir(['/home/dmdba/dmbak']) === '/home/dmdba/dmbak',
  'pickFindDir 把备份目录原样用作搜索目录',
);
ok(
  osshMod.pickFindDir(['/home/dmdba/dmbak/DB_x/system.dbf.bak']) === '/home/dmdba/dmbak/DB_x',
  'pickFindDir 对「文件」候选退到它所在目录',
);
ok(
  osshMod.pickFindDir(['+DMDATA/data/dameng/bak', '/home/dmdba/dmbak']) === '/home/dmdba/dmbak',
  'pickFindDir 跳过 ASM 候选，取第一个文件系统路径',
);
ok(osshMod.pickFindDir(['+DMDATA/data/dameng/bak']) === null, '候选全是 ASM => null（这一步不做）');
ok(osshMod.pickFindDir([]) === null && osshMod.pickFindDir(undefined) === null, '没有候选 => null');
ok(osshMod.parseFindBackups('').state === 'unknown', 'find 无输出 => unknown（不等于「没有备份」）');

/**
 * ★ 真机实测（2026-10-12，`10.127.11.40:22`）：口令错 / 主机密钥未缓存时，
 *   plink 把原因写在 **stderr**、**stdout 为空**、几十毫秒就退出（实测 51~64ms）。
 *   而解析层只看 stdout，于是会把「**根本没连上**」谎报成「脚本无输出」/「目录可能不存在」——
 *   读的人会跑去查脚本路径和备份目录，而真正的原因（主机密钥未缓存）就在 stderr 里躺着。
 *   下面用**真机 stderr 原文**把修复锁住。
 */
const REAL_SSH_FAIL = [
  'The host key is not cached for this server:',
  '  10.127.11.40 (port 22)',
  'You have no guarantee that the server is the computer you',
  'think it is.',
  "The server's ssh-ed25519 key fingerprint is:",
  '  ssh-ed25519 255 SHA256:n3iSwSaxwXlcjESK46b2S+0BKqwwDgWjisbvL/HKGHs',
  'Connection abandoned.',
  'FATAL ERROR: Cannot open connection',
].join('\n');
const failRes = { ok: false, status: 1, stdout: '', stderr: REAL_SSH_FAIL };
const trouble = osshMod.sshTroubleNote(failRes) ?? '';
ok(/SSH 层失败/.test(trouble), 'sshTroubleNote 认出真机 plink 的主机密钥报错');
ok(/sshHostKey/.test(trouble), '并给出**可执行的解法**（用 sshHostKey 传指纹，或先手工接受一次）');
ok(osshMod.sshTroubleNote({ ok: true, status: 0, stdout: 'x', stderr: '' }) === null, '正常执行时不给传输层结论（不误报）');
ok(osshMod.sshTroubleNote(null) === null, '未执行时不给传输层结论');
const scanFail = await osshMod.scanBackupLogViaSsh({ logDir: '/l', scriptPath: '/s.sh', ssh: fakeSsh, run: () => failRes });
ok(
  scanFail.verdict.state === 'unknown' && /SSH 层失败/.test(scanFail.verdict.detail) && !/脚本无输出/.test(scanFail.verdict.detail),
  '日志扫描：连不上时报「SSH 层失败」，**不能**报成「脚本无输出」',
);
const findFail = await osshMod.findBackupsViaSsh({ backupDir: '/b', ssh: fakeSsh, run: () => failRes });
ok(
  findFail.verdict.state === 'unknown' && /SSH 层失败/.test(findFail.verdict.detail) && !/可能不存在/.test(findFail.verdict.detail),
  '文件查找：连不上时报「SSH 层失败」，**不能**报成「目录可能不存在」',
);
const checkFail = osshMod.judgeCheckBackupset(failRes);
ok(checkFail.state === 'unknown' && /SSH 层失败/.test(checkFail.detail), '备份集校验：连不上时是 unknown，且指明是 SSH 层');
ok(!/备份.{0,4}损坏/.test(checkFail.detail), '并且**不**能被读成「备份损坏」');

console.log('\n=== 9b. 输出格式规范：四层骨架 + 唯一词表（DESIGN §24）===');
const fmt = await import(pathToFileURL(path.join(PKG, 'lib', 'format.js')).href);
const voc = await import(pathToFileURL(path.join(PKG, 'lib', 'vocab.js')).href);

const skel = fmt.renderResult({
  action: 'backup',
  level: 'warn',
  conclusion: '一句话结论',
  meta: ['目标：h:5236'],
  points: [fmt.point('warn', '要点一'), fmt.point(null, '要点二')],
  sections: [{ title: '小节甲', body: '正文甲' }],
  boundaries: ['边界甲'],
});
const layers = ['## 结论', '## 要点', '## 依据', '## 边界与免责'];
ok(layers.every((l) => skel.includes(l)), '骨架四层齐全（结论 / 要点 / 依据 / 边界与免责）');
ok(
  layers.map((l) => skel.indexOf(l)).every((p, i, a) => i === 0 || p > a[i - 1]),
  '四层的**顺序固定**（结论→要点→依据→边界与免责）',
);
ok(/^达梦数据库可恢复能力评估 · 备份可用性（backup）/.test(skel), '标题用唯一工具名 + 动作中文名（vocab 的 ACTION_LABEL）');
ok(/\[🟠 警告\]/.test(skel), '结论行带统一记号与词（levelTag）');
ok(/^目标：h:5236$/m.test(skel) && !/^- 目标：h:5236$/m.test(skel), '结论的补充行**不用项目符号**（避免与「要点」混淆 —— 真机首版踩过）');
ok(/^- \[🟠 警告\] 要点一$/m.test(skel), '要点行形如 `- [记号 词] 文本`');
ok(/### 1\. 小节甲/.test(skel), '依据层小节自动编号（### N. 标题）');
ok(!/## 要点/.test(fmt.renderResult({ action: 'list', conclusion: 'x', sections: [{ title: 'a', body: 'b' }] })), '没有要点时不输出空的「## 要点」层');
ok(!/## 依据/.test(fmt.renderResult({ action: 'list', conclusion: 'x' })), '没有依据时不输出空的「## 依据」层');

// ★ 顶层只允许出现四个层名。小节正文里自带的 `## ` 若没走拆分，就会漏成一个顶层层
//   —— 真机复跑时 readiness 多出一个 `## 部署形态` 正是这个原因。
const topLayers = (md) => (md.match(/^## .+$/gm) ?? []).map((s) => s.slice(3).trim());
ok(
  topLayers(skel).every((n) => ['结论', '要点', '依据', '边界与免责'].includes(n)),
  '顶层小节只可能是四层名（不含小节正文里漏上来的 `##`）',
);
const leaky = fmt.renderResult({
  action: 'readiness',
  conclusion: 'x',
  sections: [...fmt.splitH2Sections('## 部署形态\n正文甲\n## 节点间配置一致性\n正文乙')],
});
ok(
  topLayers(leaky).every((n) => ['结论', '要点', '依据', '边界与免责'].includes(n)) && /### 1\. 部署形态/.test(leaky),
  '小节正文里自带的 `##` 被拆成 `### N.`（不漏成顶层）',
);
ok(fmt.stripManualNumber('一、最要紧的几件事') === '最要紧的几件事', 'stripManualNumber 抹掉手写中文序号（避免 `### 1. 一、…`）');
ok(fmt.stripManualNumber('附录 A · 备份可用性') === '附录 A · 备份可用性', 'stripManualNumber 保留「附录 A ·」这类分类前缀');

// 引用块分流：三种形状各按各的规矩（规则是**真机跑出来**才定下来的）
const b3 = fmt.renderResult({
  action: 'list',
  conclusion: 'x',
  sections: [
    {
      title: 't',
      body: '正文\n> 整句上半；\n> 整句下半。\n\n正文2\n> **父条目**：\n> · 子项一\n> · 子项二\n> ⚠️ 提醒\n\n正文3\n> · 甲\n> · 乙',
    },
  ],
});
ok(/\n- 整句上半；\n  整句下半。\n/.test(b3), '整句被逐行 push 的引用 → **合并成一条**（不拆成两条项目符号）');
ok(/\n- \*\*父条目\*\*：\n  - 子项一\n  - 子项二\n  - ⚠️ 提醒\n/.test(b3), '父条目 + 子项 → **嵌套**，且保留 emoji 标记');
ok(/\n- 甲\n- 乙\n/.test(b3), '整块都是条目 → **每条一项**');
ok(!/^> /m.test(b3), '正文里不再残留 `>` 引用块（全部归入「边界与免责」层）');
ok(
  /一个句子\n  另一段/.test(fmt.renderResult({ action: 'list', conclusion: 'x', sections: [{ title: 't', body: '> 一个句子\n>\n> 另一段' }] })),
  '引用块内的空行不结束该块（仍合并为一条）',
);

// 唯一词表：定义处只有 `vocab.js`
const vocSrc = fsmod.readFileSync(path.join(PKG, 'lib', 'vocab.js'), 'utf8');
ok(
  /export const LEVEL_LABEL/.test(vocSrc) && /export const CAP_LABEL/.test(vocSrc) && /export const COND_MARK/.test(vocSrc),
  'vocab.js 是分级/能力/条件三套词的唯一定义处',
);
const scSrcFmt = fsmod.readFileSync(path.join(PKG, 'lib', 'scenarios.js'), 'utf8');
ok(!/^export const (CAP|COND|COND_MARK|COND_LABEL) = \{/m.test(scSrcFmt), 'scenarios.js 不再**重复定义**词表（改为从 vocab 重新导出）');
ok(/from '\.\/vocab\.js'/.test(scSrcFmt), 'scenarios.js 从 vocab.js 取词');
ok(voc.LEVEL_MARK.crit === '🔴' && voc.CAP_MARK.ok === '✅' && voc.COND_MARK.unknown === '❔', '三套词的记号互不混用（分级 🔴／能力 ✅／条件 ❔）');
ok(/维度/.test(voc.renderVocabTable()), 'renderVocabTable 渲染出对照表');
ok(voc.levelTag('nonsense') === 'nonsense', '不认识的等级值**原样输出**（不硬塞进某个档位）');
// 词表是**对象不是函数** —— 真机上把它当函数调过（`CAP_LABEL_FOR(k)`），离线测不到，这里锁住用法
ok(
  typeof voc.CAP_LABEL === 'object' && typeof voc.LEVEL_LABEL === 'object' && typeof voc.COND_LABEL === 'object',
  '词表导出的是**对象**（取词用 `LABEL[key]`，不是 `LABEL(key)`）',
);

// 六个 action 都要走 `renderResult`（离线能查的只有源码形状）
const idxFmt = fsmod.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
const actionReturns = (idxFmt.match(/text: renderResult\(/g) ?? []).length;
ok(actionReturns >= 6, `六个 action 的正文都经 renderResult 组装（实得 ${actionReturns} 处）`);
ok(/renderVocabTable\(\)/.test(idxFmt), '报告里附上词表对照（附录 F）');
for (const t of ['达梦备份可用性 —— 体检', '达梦数据库可恢复能力评估 —— 处置能力体检', '达梦归档空间参数 —— 检查']) {
  ok(!idxFmt.includes(t), `渲染器不再自带标题（否则会出现两层标题）：${t}`);
}
ok(!/L\.push\('❗ ' \+ list\.disclaimer\)/.test(idxFmt), '明细渲染器不再内联免责（避免同一段话说两遍 —— 真机首版踩过）');

console.log('\n=== 9c. 结果信封与稳定 ID（DESIGN §25）===');
const res = await import(pathToFileURL(path.join(PKG, 'lib', 'result.js')).href);

const sFind = [
  res.finding(res.ID.backup('redundancy'), 'warn', '标题', '细节', ['证据1']),
  res.finding(res.ID.backup('chain'), null, '纯陈述', '细节', []),
];
const envSample = res.buildResult({
  action: 'backup',
  generatedAt: '2026-10-12 10:00:00',
  conclusion: '一句话',
  summary: { backups: 1 },
  findings: sFind,
  result: { a: 1 },
  meta: { host: 'h' },
  disclaimer: '免责',
  text: '正文',
  reportPath: '/x.html',
  findingsPath: '/x.findings.json',
  legacy: { verdict: '旧结论', distinctPages: 3, needAttention: 1 },
});
for (const k of [
  'tool', 'resultVersion', 'action', 'generatedAt', 'generatedAtSource', 'level', 'conclusion',
  'summary', 'findings', 'result', 'meta', 'disclaimer', 'text', 'reportPath', 'findingsPath',
  'verdict', 'distinctPages', 'needAttention',
]) {
  ok(k in envSample, `信封含契约字段 ${k}`);
}
ok(envSample.tool === 'dm_recovery_readiness' && envSample.resultVersion === 1, 'tool / resultVersion 固定');
ok(
  envSample.verdict === '旧结论' && envSample.distinctPages === 3 && envSample.needAttention === 1,
  '兼容旧字段**原样透传**（不重算 —— 否则老字段说一套、新字段说另一套）',
);

// 等级：**单一来源**（由结论项派生）
ok(res.topLevelOf([{ level: 'info' }, { level: 'warn' }, { level: 'crit' }]) === 'crit', 'topLevelOf 取最高档（crit 优先）');
ok(res.topLevelOf([{ level: 'info' }, { level: 'unknown' }]) === 'unknown', 'warn 之后是 unknown');
ok(res.topLevelOf([{ level: null }]) === 'info', '只有 null 级陈述时给 info（有结论，不构成问题）');
ok(res.topLevelOf([]) === null, '完全没有结论项才返回 null（= 无权威分级）');
ok(envSample.level === res.topLevelOf(sFind), 'buildResult 的 level 由 findings 派生（不手写）');
ok(
  res.summarizeFindings(sFind).byLevel.warn === 1 && res.summarizeFindings(sFind).total === 2,
  'summarizeFindings：byLevel 只统计有级别的，total 含纯陈述',
);
ok(
  envSample.summary.scenarios === null && envSample.summary.pages === null && envSample.summary.archiveContinuous === null,
  'summary 里不适用的项**显式为 null**（缺键会被消费者当成 0）',
);

// 稳定 ID：语义 slug + 命名空间白名单
const allIds = [
  res.ID.scenario('A1'), res.ID.condition('A1', 3), res.ID.readiness('online-repair'),
  res.ID.page(4, 0, 50448), res.ID.pages('none-found'), res.ID.backup('chain'),
  res.ID.archive('params'), res.ID.form('coverage'), res.ID.grade('crit'),
];
ok(allIds.every((x) => res.ID_NAMESPACES.includes(String(x).split('.')[0])), '所有 ID 都落在已发布命名空间里');
ok(res.ID.condition('A1', 3) === 'condition.A1.03', '条件 ID 序号补零（排序稳定）');
ok(res.ID.page(4, 0, 50448) === 'page.4.0.50448', '坏页 ID 是可寻址的三元组');
const slugOf = (x) => String(x).split('.').slice(1).join('.');
ok(res.ID_SLUGS.readiness.includes(slugOf(res.ID.readiness('restore'))), 'readiness.* 的 slug 在白名单内');
ok(res.ID_SLUGS.backup.includes(slugOf(res.ID.backup('time-lsn'))), 'backup.* 的 slug 在白名单内');
ok(res.ID_SLUGS.grade.includes(slugOf(res.ID.grade('warn'))), 'grade.<level> 的 level 在白名单内');
// ★★ 静态检查：**源码里所有 `ID.<ns>('<slug>')` 字面量都必须在白名单内**。
//   上面几条只验"我列出来的 ID 合不合规"，查不出"代码在用一个没登记的 slug" ——
//   真机回归脚本第一次跑就抓到 `ID.backup('coverage')` 越界（DESIGN §37.3）。
const idLiterals = [
  ...fsmod.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8').matchAll(/ID\.([a-zA-Z]+)\('([^']+)'\)/g),
].map((m) => [m[1], m[2]]);
const idOut = idLiterals.filter(([ns, slug]) => Array.isArray(res.ID_SLUGS[ns]) && !res.ID_SLUGS[ns].includes(slug));
ok(
  // ⚠️ 这个下限只用来保证"正则真的扫到了东西"，**不是**功能指标 ——
  //    需求整项移除后字面量从 20+ 掉到 17，原来写死的 `> 20` 就假失败了。
  //    别把它调成"恰好等于本次数量"：那样每次增删功能都要来改一次。
  idLiterals.length >= 10 && idOut.length === 0,
  `★ 源码里 ${idLiterals.length} 个 ID 字面量全部在白名单内${
    idOut.length ? `（越界：${idOut.map(([n, s]) => `${n}.${s}`).join(', ')}）` : ''
  }`,
);
ok(
  sFind[0].id === 'backup.redundancy' && Array.isArray(sFind[0].evidence) && !('advice' in sFind[0]),
  'finding 形状：id/level/title/detail/evidence（无建议时不给 advice 键）',);
ok(sFind[1].level === null, '纯陈述项的 level 是 null（不参与分级计数）');

// 落盘 JSON：**去掉正文**
const jp = JSON.parse(res.resultJson(envSample));
ok(!('text' in jp) && /同名 \.html/.test(jp.textOmitted), 'resultJson 省略 text 并说明原因');
ok(jp.findings.length === 2 && jp.reportPath === '/x.html', 'resultJson 保留结论项与路径');

// ★ 契约一致性：信封里的每个键都必须已在 OUTPUT_SCHEMA 声明（否则真实运行时会因 additionalProperties:false 被拒）
const declared = Object.keys(registered.output?.schema?.properties ?? {});
const missing = Object.keys(envSample).filter((k) => !declared.includes(k));
ok(missing.length === 0, `信封字段全部已在 OUTPUT_SCHEMA 声明（缺：${missing.join(', ') || '无'}）`);
ok(
  registered.output?.schema?.properties?.summary?.additionalProperties === true,
  '嵌套对象声明为开放式（形状随 action/库而变，逐字段声明跟不上）',
);
const idxRes = fsmod.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
ok((idxRes.match(/return buildResult\(/g) ?? []).length >= 6, '六个 action 都经 buildResult 返回');
ok(!/const topLevel = \[/.test(idxRes) && !/const bkLevel = bkFindings\.some/.test(idxRes), '等级不再由各处手写三元式推导（收敛到 topLevelOf）');
ok(/topLevelOf\(/.test(idxRes), 'index.js 用 topLevelOf 派生等级');
ok(/ID\.pages\('none-found'\)/.test(idxRes) && !/ID\.page\('none', 'found', 0\)/.test(idxRes), '"无坏页"用 pages.none-found，而不是 page.none.found.0 哨兵');
ok(/fs\.writeFileSync\(findingsFile, resultJson\(env\)/.test(idxRes), 'report 落 findings.json');
// 假告警回归：「跳过损坏页」在任何库上恒为 high-risk、「主动扫描不可用」是工具边界 —— 都不该给级别
ok(
  /if \(p\.id === 'skip-page'\) return null/.test(idxRes) && /if \(p\.id === 'active-scan'\) return null/.test(idxRes),
  '高风险路径警示与工具边界不给级别（否则每次运行都是永久假告警）',
);

console.log('\n=== 9d. §26 三项收尾：留痕 / 表空间状态 / C1 档位 / 建议去重 / dmrman 噪声 ===');

// ① 留痕（provenance）：默认走库内只读查询，非默认的必须显式标
ok(sFind[0].provenance?.executedByTool === true && sFind[0].provenance?.source === 'plugin-jdbc', 'finding 默认留痕 = 库内只读查询');
ok(
  res.PROV.toolOs('dmrman CHECK BACKUPSET x').executedByTool === true && /OS 只读命令/.test(res.PROV.toolOs('x').via),
  'PROV.toolOs：OS 只读命令也算"工具执行"，且写明命令',
);
ok(
  res.PROV.userDeclared('调用参数').declaredByUser === true && res.PROV.userDeclared('x').verified === false,
  'PROV.userDeclared：调用方声明的东西 **verified=false**（没人验过）',
);
ok(res.PROV.derived('场景引擎').executedByTool === false && /推导/.test(res.PROV.derived('x').via), 'PROV.derived：推导出来的汇总不冒充实测');
const idxProv = fsmod.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
ok((idxProv.match(/PROV\.toolOs\(/g) ?? []).length >= 3, '三条 OS 级实测结论都标了 toolOs 留痕');
ok(/PROV\.derived\('场景引擎/.test(idxProv), '分级项标了 derived 留痕（分级是推导，不是实测值）');
ok(/inputsDeclaredByUser/.test(idxProv) && /PROV\.userDeclared\('调用参数'\)/.test(idxProv), '调用方声明的输入单列（backupPath/targets/retentionHours/sshHost，口令不列）');

// ② 表空间状态：主口径用自描述的 DBA_TABLESPACES.STATUS；数值口径**不解释**
const an2 = await import(pathToFileURL(path.join(PKG, 'lib', 'analyze.js')).href);
const tsOk = an2.assessTablespaceStatus(
  { columns: ['TABLESPACE_NAME', 'STATUS', 'CONTENTS'], rows: [['SYSTEM', 'ONLINE', 'PERMANENT'], ['MAIN', 'ONLINE', 'PERMANENT']] },
  null,
);
ok(tsOk.source === 'DBA_TABLESPACES.STATUS' && /全部 ONLINE/.test(tsOk.label), '表空间状态主口径 = 自描述 STATUS（ONLINE）');
const tsOff = an2.assessTablespaceStatus(
  { columns: ['TABLESPACE_NAME', 'STATUS'], rows: [['MAIN', 'ONLINE'], ['APP', 'OFFLINE']] },
  null,
);
ok(tsOff.offline.length === 1 && /APP=OFFLINE/.test(tsOff.label), '有非 ONLINE 表空间时点名列出');
const tsRaw = an2.assessTablespaceStatus(null, { columns: ['ID', 'NAME', 'STATUS$'], rows: [[0, 'SYSTEM', 0], [4, 'MAIN', 0]] });
ok(tsRaw.source === 'V$TABLESPACE.STATUS$' && /数值含义未核实/.test(tsRaw.label), '退回数值口径时**如实标注"数值含义未核实"**（不替它编语义）');
ok(an2.assessTablespaceStatus(null, null).label === null, '两个口径都取不到 → label=null（不猜）');
ok(/tsStatus: tsStat\.label/.test(idxProv) && !/tsStatus: null/.test(idxProv), 'facts.tsStatus 不再恒为 null（B8 的证据行不再永远显示「未取到」）');

// ③ dmrman 输出：进度条必须先抠掉（真机原文）
const osshMod2 = await import(pathToFileURL(path.join(PKG, 'lib', 'ossh.js')).href);
const REAL_NOISY =
  '                                                                                     [Percent:0.00%][Speed:0.00M/s][Cost:00:00:00][Remaining:00:00:00]                                                                                     [Percent:100.00%][Speed:5541.41M/s][Cost:00:00:00][Remaining:00:00:00]\ncheck backupset successfully.\ntime used: 732.826(ms)';
ok(!/Percent|Speed|Remaining/.test(osshMod2.meaningfulLines(REAL_NOISY, 4).join(' ')), 'meaningfulLines 抠掉进度条');
const jc = osshMod2.judgeCheckBackupset({ status: 0, stdout: REAL_NOISY, stderr: '' });
ok(jc.state === 'ok' && /check backupset successfully/.test(jc.detail) && !/Percent/.test(jc.detail), '结论依据里只剩真信息（真机原文验证）');

// ④ C1：单实例是「不适用」，不是「无法判定」；且不进分级
const sc2 = await import(pathToFileURL(path.join(PKG, 'lib', 'scenarios.js')).href);
const fSingle = {
  archOn: true, enableFlashback: '0', backupsCount: 1, backupVerified: true, archiveChainOk: true,
  dscNodes: 1, checkedNodes: 1, hasStandby: false, hasBadPages: false, archiveTargets: 1,
  ctlBakPath: '/x', ctlBakNum: 10, rlogMirrored: true, recyclebinEnabled: false, offsiteCopy: false,
  bakPath: '/b', earliestArchLsn: 1, backupBeginLsn: 2,
};
const scSingle = sc2.assessScenarios(fSingle);
ok(scSingle.find((s) => s.id === 'C1').cap === sc2.CAP.na, '单实例上 C1 = na（不适用）');
ok(scSingle.find((s) => s.id === 'C1').cap !== sc2.CAP.unknown, '**不再**归进「无法判定」');
ok(
  !sc2.gradeScenarios(scSingle).some((g) => g.level === 'unknown'),
  '「不适用」不进分级 —— 以前它会造出一条「1 个场景无法从库内判定」的**假陈述**',
);
ok(/不适用 1 项/.test(sc2.renderScenarioMatrix(scSingle)), '矩阵合计单列「不适用」');
ok(sc2.assessScenarios({ ...fSingle, dscNodes: null }).find((s) => s.id === 'C1').cap === sc2.CAP.unknown, '节点数取不到时仍判 unknown（那时确实判不了）');
ok(sc2.CAP_MARK.na === '—' && /不适用/.test(sc2.CAP_LABEL.na), 'na 有独立记号与词（与未知态区分开）');

// ⑤ 建议去重：一件事只说一次，场景块里只给指针
const rich26 = sc2.assessConditions(scSingle, fSingle);
const plan26 = sc2.advicePlan(rich26);
const advCount = rich26.reduce((n, s) => n + (s.advice?.length ?? 0), 0);
ok(plan26.items.length < advCount, `去重后 ${plan26.items.length} 件事 < 场景里出现的 ${advCount} 条建议（真的合并了）`);
ok(plan26.items.find((i) => i.key === 'FLASHBACK')?.scenarios.join() === 'A1,A2,A3', '同一件事列出它影响的全部场景（闪回 → A1/A2/A3）');
ok(plan26.items.find((i) => i.key === 'OFFSITE')?.scenarios.length === 3, '异地副本合并 B7/C2/C3 三个场景');
const blocks26 = sc2.renderScenarioBlocks(rich26);
ok(!/能买到什么/.test(blocks26), '场景块里**不再**重复「能买到什么 / 代价」');
ok(/→ 建议：/.test(blocks26), '场景块改为指向建议编号');
const advTxt26 = sc2.renderAdviceList(rich26);
ok((advTxt26.match(/能买到什么/g) ?? []).length === plan26.items.length, '建议表里每件事只出现一次「能买到什么」');
ok(/#### ①/.test(advTxt26) && /#### ②/.test(advTxt26), '建议按圈码编号');
// 编号必须**跨两处一致**（两处各自调用纯函数，这是它们不靠共享状态的代价，必须断言）
const m1 = blocks26.match(/→ 建议：\*\*(.)\*\*/);
ok(!m1 || advTxt26.includes(`#### ${m1[1]}`), '场景块里的编号在建议表里能找到同号条目（两处编号一致）');
ok(/同一件事只说一次|该改的 N 件事/.test(sc2.renderTopActions(rich26, 3)), '「最要紧的几件事」不再重复建议正文，改为指向下一节');

console.log('\n=== 9e. 连接/桥层失败的兜底信封（DESIGN §28）===');
const br2 = await import(pathToFileURL(path.join(PKG, 'lib', 'bridge.js')).href);
// 用**本会话真机见到的原文**做夹具（这两句都是真报错，不是编的）
const locked = br2.classifyDbError('JDBC 桥致命错误: dm.jdbc.driver.DMException: 登录失败次数超过限制');
ok(locked.kind === 'auth-locked' && locked.level === 'crit', '「登录失败次数超过限制」→ auth-locked，且**级别 crit**（已影响可用性）');
ok(/继续重试不会解锁/.test(locked.hint) && /ACCOUNT UNLOCK/.test(locked.hint), '锁号提示写明「继续重试不会解锁」+ 解锁动作（本项目踩过这个事故）');
const badPw = br2.classifyDbError('JDBC 桥致命错误: dm.jdbc.driver.DMException: 用户名或密码错误');
ok(badPw.kind === 'auth-failed' && /不要反复重试/.test(badPw.hint), '「用户名或密码错误」→ 提示先核对**账号**（默认 SYSDBA 常常不是可用账号），并警告别反复试');
ok(/DmJdbcDriver/.test(br2.classifyDbError('未找到达梦 JDBC 驱动。达梦驱动是商业组件').hint), '驱动缺失 → 指到 drivers/ 目录');
ok(/7236\/7237/.test(br2.classifyDbError('java.sql.SQLException: Connection refused').hint), '连不上 → 提示核对端口（DMDSC 7236/7237，单实例 5236）');
// ★ 真机原文：连不上端口时**达梦说的是「网络通信异常」**，不是英文 refused/unreachable。
//   第一版只匹配英文词，于是把它归成 other —— 这条断言锁住"别猜厂商措辞"。
ok(
  br2.classifyDbError('JDBC 桥致命错误: dm.jdbc.driver.DMException: 网络通信异常').kind === 'unreachable',
  '达梦原文「网络通信异常」→ unreachable（真机见到的原话）',
);
ok(br2.classifyDbError('完全看不懂的错').kind === 'other', '认不出的错归 other（不硬塞进已知类别）');
// ★ §39：本机写权限失败**不许**被说成"连不上数据库"（真机上就是这么被误导过一次）
const epermReal =
  "EPERM: operation not permitted, open 'C:\\Users\\shiyu\\.dsh\\dm-recovery-readiness\\runtime\\req-15172-1791796040217-cj01kw.sql'";
ok(br2.classifyDbError(epermReal).kind === 'local-io', '★ 真机原文 EPERM → local-io（不是 unreachable）');
ok(
  !/连不上数据库/.test(br2.classifyDbError(epermReal).title) && /不是数据库的问题/.test(br2.classifyDbError(epermReal).title),
  '★ 标题明说「不是数据库的问题」——读者才会去看路径而不是查网络',
);
ok(
  /不需要|不必/.test(br2.classifyDbError(epermReal).hint) === false || /工作目录/.test(br2.classifyDbError(epermReal).hint),
  '提示指向**工作目录可写性**（而不是网络/端口/实例状态）',
);
// 三条失败路径的措辞必须由**分类结果**派生（以前两条路径各写死一句「所有目标节点均无法连接」）
const headLocal = plugin.collectionFailureHeadline([{ label: 'a', error: epermReal }]);
const headNet = plugin.collectionFailureHeadline([{ label: 'a', error: 'java.sql.SQLException: 网络通信异常' }]);
const headAuth = plugin.collectionFailureHeadline([{ label: 'a', error: '用户名或密码错误' }]);
const headMixed = plugin.collectionFailureHeadline([
  { label: 'a', error: epermReal },
  { label: 'b', error: '网络通信异常' },
]);
ok(headLocal.kind === 'local-io' && !/无法连接/.test(headLocal.title), '★ 全是本机写目录失败 → 标题不含「无法连接」');
ok(/尚未连到数据库/.test(headLocal.title), '★ 并明说「尚未连到数据库」（不能让人以为连过了）');
ok(headNet.kind === 'unreachable' && /所有目标节点均无法连接/.test(headNet.title), '真的连不上时仍保留原措辞（不改动既有语义）');
ok(
  headLocal.advice.every((a) => !/锁定账号/.test(a)) && headAuth.advice.some((a) => /锁定账号/.test(a)),
  '★ 「不要反复重试，会锁账号」**只**贴在账号类错误上（以前 report 路径无条件贴 —— 那是错的）',
);
ok(headLocal.advice.some((a) => /dm_recovery_readiness_HOME/.test(a)), '本机写目录失败时给出可执行的下一步（指到可写目录）');
ok(/本机写目录失败 1 个 \/ 其它 1 个/.test(headMixed.title), '★ 混合原因**分别计数**，不合并成一句');
// 兜底信封：形状必须与正常结果一致（失败也走 §25 的信封，而不是抛栈）
const failEnv = plugin.connectionFailureEnvelope({
  action: 'readiness',
  args: { host: 'h', port: 5236, user: 'u' },
  error: new Error('JDBC 桥致命错误: dm.jdbc.driver.DMException: 登录失败次数超过限制'),
});
ok(failEnv.tool === 'dm_recovery_readiness' && failEnv.action === 'readiness', '兜底信封也带 tool/action');
ok(
  ['level', 'conclusion', 'summary', 'findings', 'result', 'meta', 'disclaimer', 'text'].every((k) => k in failEnv),
  '兜底信封字段与正常结果一致（失败不破坏契约）',
);
ok(failEnv.level === 'crit' && failEnv.findings[0].id === 'form.connection', '兜底信封给出 form.connection 结论项与等级');
ok(!/\n\s+at .*\.js:\d+/.test(failEnv.text), '正文里**没有 JS 栈**（以前会把栈直接抛给用户）');
ok(/不要反复重试/.test(failEnv.text), '正文里带「不要反复重试」');
const idxCatch = fsmod.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
ok(/connectionFailureEnvelope\(\{ action: args\.action, args, error: e \}\)/.test(idxCatch), 'execute 的 catch 调用兜底信封（不是重新抛出）');
ok(
  (idxCatch.match(/collectionFailureHeadline\(failed\)/g) ?? []).length === 2,
  '★ 两条"一个目标都没采到"的失败路径共用同一个措辞判定（report + readiness）',
);
ok(!/legacy: \{ verdict: '所有目标节点均无法连接'/.test(idxCatch), '不再有写死的 verdict 文案（改由分类结果派生）');
// ★ §40：报告里的"指路话"不许指错方向 —— OS 那两节在**正文、附录之前**
ok(!/本节之后/.test(idxCatch), '★ §40：源码里不再有「见本节之后的小节」这类反向指路话');
ok(/紧随其后\*\*的「时间 ↔ LSN 对应/.test(idxCatch), '★ §40：归档链那节的精度指向**紧随其后**的夹逼表（原来写「上一节」）');

console.log('\n=== 9f. 「恢复需求达成度」已整项移除 + 与之无关的接线回归（DESIGN §29.10）===');
// ★ 2026-10-13：参数、命名空间、模块、结论项、以及与它绑定的「先决条件行」**全部**移除。
//   这一组现在验的是"删干净了"，而不是"它还能用" —— **删一半比不删更坏**：
//   留着参数就还会有人传，留着白名单就还有人以为这功能在。
const idxReq = fsmod.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
const resSrc = fsmod.readFileSync(path.join(PKG, 'lib', 'result.js'), 'utf8');
// ⚠️ `vocSrc` 在 §9b 已经声明过了（同一份 `lib/vocab.js`）—— 顶层 `const` 重复声明是 SyntaxError，
//    会让整个自检**连跑都跑不起来**（第一版就是这么挂的）。所以这里直接用 §9b 那份。
const scSrc = fsmod.readFileSync(path.join(PKG, 'lib', 'scenarios.js'), 'utf8');
/**
 * 剥掉注释再断言。
 *
 * ★ 这一条是踩出来的：上面三个文件里都留了「**已整项移除**」的说明注释，
 * 而注释里必然会写出被删掉的名字（`REQ_MARK` / `TARGET_REACH` …）——
 * 不剥注释的话，"这东西没了吗"的断言会被**自己的留痕**判成失败。
 * 反过来也不能因为怕失败就把留痕删掉：**留痕的价值大于这点麻烦**。
 */
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const paramNames = Object.keys(p?.properties ?? {});
ok(
  ['rpoMinutes', 'targetTime', 'targetWindow', 'rtoMinutes', 'drillRtoMinutes', 'drillAt'].every(
    (k) => !paramNames.includes(k),
  ),
  '★ 编译后的 parameters 里**一个需求参数都没有**（RPO / 目标时刻 / RTO 三批共 6 个）',
);
ok(
  !fsmod.existsSync(path.join(PKG, 'lib', 'requirements.js')),
  '★ `lib/requirements.js` **文件已删除**（不是留着不用 —— 死代码会被下一个人当活的读）',
);
ok(!/assessRequirements|renderRequirements|REQ_TARGET_IDS/.test(idxReq), '★ 入口里不再有需求判定 / 渲染 / 目标 ID 的引用');
ok(!/ID\.req\(/.test(idxReq), '★ 源码里不再构造任何 `req.*` ID');
ok(
  !/req: \(slug\)/.test(resSrc) && !/ID_NAMESPACES = \[[^\]]*'req'/.test(resSrc) && !/^\s*req: \['/m.test(resSrc),
  '★ `result.js` 的 `req` 命名空间与白名单项都删了（命名空间是契约的一部分）',
);
ok(!/REQ_MARK|REQ_LABEL|需求达成/.test(codeOnly(vocSrc)), '★ 词表里不再有「需求达成」这一维（词表是**唯一**词表）');
ok(!/TARGET_REACH|targetCond|targetRequirement/.test(codeOnly(scSrc)), '★ 场景条件表不再挂「先决条件」行（§32 的输出随之消失）');
ok(
  !/summary: \{[^}]*requirements|^.*requirements: requirements/m.test(idxReq),
  '★ `summary` / `result` 里不再有 `requirements` 字段（消费者不会拿到一个永远是 null 的键）',
);
ok(
  plugin.ignoredParamNotes({ action: 'report', backupPath: 'x' }).length === 0 &&
    plugin.ignoredParamNotes({ action: 'capacity', backupPath: 'x' }).length === 1,
  '「没用上的参数」提示仍然工作（report 认 backupPath、capacity 不认）',
);
ok(
  plugin.ignoredParamNotes({ action: 'list' }).length === 0 &&
    plugin.ignoredParamNotes({ action: 'list', retentionHours: 0 }).length === 1,
  '没给参数时不提示；**`0` 也算"给了"**（0 是合法取值，不能当没给）',
);

// ↓↓↓ 以下断言**与需求无关**，原来混在 9f 里 —— 删功能时最容易连带删掉，所以显式留在这里 ↓↓↓

// 兜底：report 的"所有目标都连不上"这条**并行失败路径**也必须走信封（§28 漏过一条）
// 注：`idxReq` 已剥掉整行注释，所以这里只能看"这个分支接下来的代码里有没有 buildResult"。
const zeroSites = [...idxReq.matchAll(/if \(perNode\.length === 0\) \{/g)].map((m) =>
  idxReq.slice(m.index, m.index + 1600),
);
ok(
  zeroSites.length >= 2 && zeroSites.every((s) => /buildResult\(/.test(s)),
  `每个「perNode.length===0」早退分支都返回信封（实得 ${zeroSites.length} 处）`,
);
ok(!/return \{\r?\n\s*action: 'report',/.test(idxReq), 'report 里不再有裸对象早退（第一版"全目标连不上"就是这么返回的）');
// 空括号回归：`level` 为 null 的纯陈述项不许印出 `[]`
ok(
  // 用 `includes` 而不是正则：这行里有反引号 + `${`，正则字面量里全是转义地狱（第一版就是这么写错的）
  idxReq.includes("${f.level ? ` [${levelTag(f.level)}]` : ''}") && !idxReq.includes("[${levelTag(f.level)}] ${f.title}"),
  '★ 纯陈述（level=null）的结论项不印空括号 —— 真机首版印出过 `- req.rto [] RTO 需求…`',
);
// ★ §36：`host:port` 简写（每次手输，能省一个字段是一个）
ok(
  /const hostParsed = hostArg\.includes\(':\[?\\s\S\]?/.test(idxReq) || /hostArg\.includes\(':'\)/.test(idxReq),
  '★ `host` 支持 `host:port` 简写（复用 parseTargets，IPv6 字面量也走同一条路）',
);
ok(
  /port: portExplicit \?\? hostParsed\?\.port \?\? Number\(cfg\.port\)/.test(idxReq),
  '★ 端口优先级明确：显式 `port` > `host` 里带的 > 默认值（两处不一致时以 port 为准，并在边界里说明）',
);
ok(
  /argNotes\.push\(/.test(idxReq) && /const bnd = \(items = \[\]\) => \[\.\.\.items, \.\.\.ignoredParamNotes\(args\), \.\.\.argNotes\]/.test(idxReq),
  '参数层面的提醒走 `argNotes`，与「没用上的参数」一起进「边界与免责」',
);
// ★ 锚点不足的措辞也不许写死窗口长度（真机 DMDSC 上 RLOG 只有 1 行）
ok(
  !/保留窗口通常只有约 1 小时/.test(idxReq),
  '★ 锚点不足时如实报「本次锚点共 N 个」与最近的锚点，**不写死**「保留窗口约 1 小时」',
);
ok(
  /const bkAllFindings = \[\.\.\.bkFindings\]/.test(idxReq) && /const bkLevel = topLevelOf\(bkAllFindings\)/.test(idxReq),
  'backup 的结论项清单只剩场景/坏页/OS 几类，等级仍由**合并后**的结论项派生',
);
const USED_BY = plugin.USED_BY;
ok(!!USED_BY, 'USED_BY（参数 → 哪些 action 真的用）已导出，便于离线断言');
ok(
  ['backupPath', 'targets', 'retentionHours', 'sshHost', 'dmrmanDcrIni'].every((k) => Array.isArray(USED_BY[k])),
  'USED_BY 仍是**唯一**的参数→action 映射（五个参数都在）',
);
ok(
  ['rpoMinutes', 'targetTime', 'targetWindow', 'rtoMinutes', 'drillRtoMinutes', 'drillAt'].every((k) => USED_BY[k] === undefined),
  '★ `USED_BY` 里没有那六个参数（它们是**删掉的**参数，不是"无人使用"的参数）',
);
ok(
  !USED_BY.backupPath.includes('readiness') && USED_BY.backupPath.join() === 'backup,report',
  'backupPath 由 backup/report 用，readiness 不认',
);
ok(/usedBy\.includes\(args\.action\)/.test(idxReq) && /used: usedBy\.includes/.test(idxReq), 'meta.inputsDeclaredByUser 每项带 usedBy/used（机器可读地标明用没用上）');
ok(
  (idxReq.match(/boundaries: bnd\(/g) ?? []).length >= 7,
  `所有正文出口都经 bnd() 追加"没用上的参数"提示（实得 ${(idxReq.match(/boundaries: bnd\(/g) ?? []).length} 处）`,
);

// ★ 报告目录不许用 `ensureHome()`（那会把 drivers/java/runtime/classes 一起建到交付目录里）
ok(
  /fs\.mkdirSync\(dir, \{ recursive: true \}\)/.test(idxReq) && !/dir = ensureHome\(dir\)/.test(idxReq),
  '★ 报告输出目录只 mkdir，不套 ensureHome（否则交付目录里会多出四个空文件夹）',
);
ok(/const home = ensureHome\(cfg\.home\)/.test(idxReq), '插件**工作目录**仍然用 ensureHome（驱动/编译产物/临时文件要有骨架）');


console.log('\n=== 9g. 报告版式（DESIGN §33–§34：对齐安全评估报告的风格）===');
const rep = await import(pathToFileURL(path.join(PKG, 'lib', 'report.js')).href);
const H = rep.buildReportHtml({
  meta: {
    dbName: 'DAMENG',
    instance: 'DSC01',
    form: 'DMDSC 共享存储集群（2 节点）',
    version: 'DM Database Server x64 V8',
    target: '10.0.0.1:7236',
    nodes: 2,
    account: 'awr1',
    reportId: 'DM-RCV-20261012000000',
    scenarioCount: 16,
    requirementLine: '恢复需求 3 项（满足 2 ／ 无法判定 1）',
    capability: { ok: 6, partial: 7, none: 3, unknown: 0, na: 0 },
    boardFoot: '另有 <b>16</b> 个恢复场景的能力判定。',
    overview: [['评估对象', '10.0.0.1:7236'], ['数据来源', '只读 JDBC 采集']],
    versionRows: [['库名 / 实例', 'DAMENG / DSC01'], ['归档链', '序列 4 个 <span class="mk m-ok">并集无洞</span>']],
    overviewNote: '取不到的照实写「未取到」，**不推断成"正常"**。',
  },
  grades: [
    { level: 'crit', title: '严重项', detail: '细节 **加粗** 与 `代码`' },
    { level: 'info', title: '提示项', detail: '细节' },
  ],
  sections: [
    {
      // 【§29.10】夹具跟着**真实报告**走：需求达成度整项移除后，第一节是「最要紧的几件事」。
      // 夹具留在旧形态的话，版式断言会在验一个**产品里不可能出现的**报告形状。
      title: '一、最要紧的几件事',
      body:
        '**依据见下**\n\n> 引用块\n\n| 甲 | 乙 | 判定 |\n| --- | --- | --- |\n' +
        '| RPO | 10 秒 | ✅ 满足 |\n| 恢复时间点 | 2026-10-12 13:40:00 | ✅ 满足 |\n| 甲 | 乙 | — |\n\n- 一级\n  - 二级\n- 一级二\n',
    },
    { title: '二、最要紧的几件事', body: '正文' },
    { title: '附录 A · 处置能力体检', body: '附录正文' },
  ],
  disclaimer: '免责',
  generatedAt: '2026-10-12 10:00:00',
});
// ① 封面信息带（与安全评估报告同一个版式语言）
ok(
  /<header class="cover">/.test(H) && /Dameng DM8 · Recovery Readiness Assessment/.test(H),
  '★ 封面信息带：英文 kicker + 中文大标题（对齐安全评估报告）',
);
ok(
  /<div class="cover-title">达梦数据库可恢复能力评估报告<\/div>/.test(H) &&
    /<div class="cover-rule"><\/div>/.test(H),
  '封面有中文主标题与金色分隔条',
);
ok(
  /<div class="cover-facts">/.test(H) && /评估对象<b>10\.0\.0\.1:7236<\/b>/.test(H) && /报告编号<b>DM-RCV-/.test(H),
  '封面 facts 栅格：评估对象 / 数据库·实例 / 形态·版本 / 采集账号 / 生成时间 / 报告编号',
);
ok(
  /class="cover-verdict"/.test(H) && /总体：严重/.test(H),
  '★ 封面给出「总体等级」色标与一句话规模',
);
// ② 编号小节 + 目录（★ §44：目录要**在开头**、锚点要**对得上**、每节能**回去**）
ok(/<nav class="tocbox" id="toc">/.test(H), '★ 目录是独立导航块（`nav.tocbox#toc`），不是某一节的附属说明');
ok(
  H.indexOf('<nav class="tocbox"') < H.indexOf('<h2 id="s1"'),
  '★★ §44：目录出现在**第 1 节之前** —— 原来它夹在第 1 节后面，打开报告第一屏根本看不到，点第 1 条还往回跳',
);
ok(/<div class="toc-title">目录<span class="toc-hint">点条目跳转<\/span><\/div>/.test(H), '目录有明确标题与「点条目跳转」提示');
// ★ §44.6：条目**单列竖排**（原来是 4 列自适应栅格：长标题折行、横向铺开）
ok(
  /ul\.toc\{[^}]*flex-direction:column/.test(H) && !/ul\.toc\{[^}]*grid-template-columns/.test(H),
  '★★ 目录条目**单列竖排**（不再是 `repeat(auto-fit,…)` 的横向栅格）',
);
ok(
  /ul\.toc\{[^}]*column;gap:0/.test(H) && /ul\.toc li\{[^}]*line-height:1\.55/.test(H),
  '★ 竖排后**收紧行距**（15 条一行一条，靠紧凑换密度）',
);
ok(
  /ul\.toc a::after\{[^}]*border-bottom:1px dotted/.test(H),
  '★ 竖排目录带**点线引导**（否则右侧一大段空白，整块显虚）',
);
ok(/<span class="tn">1<\/span><a href="#s1">评估概况<\/a>/.test(H), '目录第一项是「评估概况」');
ok(
  /<span class="tn">3<\/span><a href="#s3">最要紧的几件事<\/a>/.test(H) &&
    /<span class="tn">A<\/span><a href="#s5">附录 A · 处置能力体检<\/a>/.test(H),
  '目录项与正文小节锚点一一对应（含附录字母）',
);
// 只统计**目录块内**的链接（每节的「返回目录」指向 #toc，不能算进来）
const tocBlock = H.slice(H.indexOf('<ul class="toc">'), H.indexOf('</ul>', H.indexOf('<ul class="toc">')));
ok(
  (tocBlock.match(/href="#s\d"/g) ?? []).length === (H.match(/<h2 id="s\d"/g) ?? []).length,
  '★ 目录链接数 = 小节数（没有死链、没有漏项）',
);
// ★★ 锚点完整性：**每个 `href="#X"` 都必须有 `id="X"`**。
//   这条比"链接数 = 小节数"更强 —— 数对了但 id 写错（比如 s3 写成 s03）时，前者照样通过，
//   而读者看到的就是"点了没反应"。§44 加目录时正是最容易出这种错。
{
  const hrefs = [...H.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  const ids = new Set([...H.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const dead = [...new Set(hrefs)].filter((h) => !ids.has(h));
  ok(dead.length === 0, `★ 所有内链都有落点（${hrefs.length} 个内链，死链 ${dead.length} 个${dead.length ? `：${dead.join(', ')}` : ''}）`);
}
// 每节末尾都能回目录
{
  const backs = (H.match(/<p class="backtoc"><a href="#toc">↑ 返回目录<\/a><\/p>/g) ?? []).length;
  const secs = (H.match(/<h2 id="s\d+"/g) ?? []).length;
  ok(backs === secs, `★ 每一节末尾都有「↑ 返回目录」（实得 ${backs} 个 / ${secs} 节）—— 15 节的报告里没有它就得一路滚回顶部`);
}
ok(!/href="#s1">↑ 返回目录/.test(H), '「返回目录」指向目录本身（`#toc`），不是第 1 节');
ok(/@media print\{[\s\S]*?\.tocbox,\.backtoc\{display:none\}/.test(H), '★ 打印时**连容器一起**隐藏目录与回程链接（只藏 ul 会留下一个写着「目录」的空框）');
ok(/scroll-margin-top:16px/.test(H), '★ 锚点落点留出上边距（否则跳过去标题顶在视口最上沿，看起来像"点了没反应"）');

// 编号徽章（这段原来跟目录断言挤在一起，被我插内容时切断过一次 —— 单独放，别再混）
ok(
  rep.buildReportHtml({ sections: [{ title: '一、甲' }, { title: '二、乙' }, { title: '附录 A · 丙' }], meta: {} }).includes(
    '<span class="hno">3</span>',
  ),
  '★ 正文小节从 3 开始自动编号（1=评估概况、2=结论摘要由渲染器固定）',
);
ok(/<span class="hno">A<\/span>/.test(H), '★ 附录用字母徽章（A/B/C…），不参与数字编号');
ok(
  /<h2 id="s3"><span class="hno">3<\/span><span class="ht">最要紧的几件事<\/span><\/h2>/.test(H),
  '★ 标题里的中文序号被拆成徽章，显示标题不带「一、」',
);
// ③ 定义式信息面板
ok(/<table class="meta">/.test(H) && /<th>评估对象<\/th>/.test(H), '★ 「评估概况」用定义式面板（table.meta，左标签右值）');
ok(/<h3>版本与实例信息<\/h3>/.test(H) && /<th>库名 \/ 实例<\/th>/.test(H), '「版本与实例信息」同为定义式面板');
// ④ 结论看板
ok(/<div class="kpis">/.test(H) && /<div class="kpi crit">/.test(H) && /<div class="kpi info">/.test(H), '★ 结论看板：分级 KPI 卡片');
ok(/<div class="kpi unknown zero">/.test(H) && /<div class="kpi warn zero">/.test(H), '★ 计数为 0 的档位加 `zero` 降噪（仍出现 —— 缺了会被读成"没查"）');
ok(/<div class="distbar">/.test(H) && /class="seg crit"/.test(H), '★ 分布条按等级占比上色');
ok(
  /<table class="matrix">/.test(H) && /<span class="badge crit">严重<\/span>/.test(H) && /判定含义/.test(H),
  '★ 「判定含义」表：等级 / 条数 / 一句话含义（数字一眼可见，含义可查）',
);
ok(/<article class="item crit">/.test(H) && /<span class="badge crit">严重<\/span>/.test(H), '分级明细用卡片（article.item，左侧色条）');
ok(
  /<h3>场景能力分布<span class="mini na">共 16 个场景<\/span><\/h3>/.test(H) &&
    /<span class="mini ok">可恢复 <b>6<\/b><\/span>/.test(H),
  '★ 场景能力分布：五档胶囊 + 分布条（与安全评估报告的 mini 胶囊同形）',
);
// ⑤ 表格与记号
ok(/<div class="tw"><table>/.test(H) && /<\/table><\/div>/.test(H), '★ 所有表格包在 `.tw` 里（宽表窄屏可横向滚动）');
ok(/<td class="ctr"><span class="mk m-ok">✅<\/span> 满足<\/td>/.test(H), '★ 判定列：记号包成胶囊 + 整列居中收窄');
ok(/<td class="ctr"><span class="mk m-na">—<\/span><\/td>/.test(H), '★ 整格 `—`（不适用）也包成胶囊 —— 否则它在视觉上"消失"');
ok((H.match(/class="mk m-/g) ?? []).length >= 3, '✅/❔/— 等在正文与表格里共用同一套胶囊');
ok(/<blockquote>/.test(H) && /<strong>加粗<\/strong>/.test(H) && /<code>代码<\/code>/.test(H), '引用/加粗/行内代码照常渲染');
ok(/<ul><li>一级<ul><li>二级<\/li><\/ul><\/li><li>一级二<\/li><\/ul>/.test(H), '★ 列表还原两级缩进');
ok(!/\*\*/.test(H.replace(/<style>[\s\S]*?<\/style>/, '')), '★ 正文里不再残留未渲染的 `**`（含 `overviewNote` —— 真机回归抓到的：它绕过了 md 管线）');
ok(!/\|\s*---/.test(H), '★ 正文里不再残留 Markdown 表格分隔行');
// ⑥ 打印 / 响应式 / 页脚
ok(/@page\{size:A4/.test(H) && /@media print/.test(H) && /break-inside:avoid/.test(H), '★ 带 A4 打印样式（表格/卡片不被切断，封面保留底色）');
ok(/viewport/.test(H) && /max-width:720px/.test(H), '带 viewport 与窄屏适配');
ok(!/prefers-color-scheme/.test(H), '★ 不做深色模式 —— 与安全评估报告保持**同一套**视觉语言（免得两份报告长得不像一家）');
// §44：回程链接从"整篇一个、指向 #s1"改成"**每节一个、指向目录本身**"（上面已按节数卡过）
ok(!/href="#s1">↑ 返回目录/.test(H), '★ 「返回目录」不再指向第 1 节（那会让读者以为目录在第 1 节里）');
ok(/<div class="rpt-foot">/.test(H) && /dsh-plugin-dm-recovery-readiness/.test(H), '页脚：插件标识 + 「全程只读」');
const cssNoVar = H.slice(H.indexOf('<style>'), H.indexOf('</style>'));
ok(/--brand:#12395c/.test(cssNoVar) && /--accent:#c8963e/.test(cssNoVar), '★ 配色沿用安全评估报告的设计 token（深蓝 #12395c + 金 #c8963e）');
ok(/\.mk\{/.test(cssNoVar) && /\.mini\{/.test(cssNoVar) && /table\.meta/.test(cssNoVar), '组件名与安全评估报告一致（mini / meta / badge）');

// ⑨ §38：OS 访问支持**多节点**（以前只有一个 sshHost，DMDSC 第二个节点永远不跑）
const cfgOne = plugin.parseSshHosts('10.0.0.1');
const cfgTwo = plugin.parseSshHosts('10.0.0.1:22, 10.0.0.2');
const cfgIpv6 = plugin.parseSshHosts('[::1]:22');
ok(
  cfgOne.length === 1 && cfgOne[0].port === null && plugin.parseSshHosts('10.0.0.1,10.0.0.2\n10.0.0.3').length === 3,
  '★ `sshHost` 支持多节点列表（逗号/空格/换行），端口省略时留空交给 `sshPort`/默认 22',
);
ok(cfgTwo[1].host === '10.0.0.2' && cfgTwo[0].port === 22, '`host:port` 与纯 host 混写都认');
ok(cfgIpv6[0].host === '::1' && cfgIpv6[0].port === 22, 'IPv6 字面量 `[::1]:22` 也认');
ok(
  plugin.parseSshHosts('10.0.0.1:22,10.0.0.1:22').length === 1,
  '重复的 SSH 节点去重（同一 host:port 只查一次）',
);
ok(/sshHostKey/.test(readmeSrc) && /多节点|逐节点/.test(readmeSrc), 'README 写明 SSH 支持多节点与逐节点值');
ok(
  /osTag = \(list\)/.test(idxProv) && /（\$\{\(list \?\? \[\]\)\.length\} 个节点）/.test(idxProv),
  '★ OS 小节标题在**多节点时写明节点数**（否则读者以为所有节点都查过了）',
);
ok(
  /nodes: nodes\.map\(\(label\) => \{/.test(idxProv) && /nodeCount: nodes\.length/.test(idxProv),
  '★ `result.os` 改为**按节点分列**（`nodes[]` + `aggregate`），单节点时长度 1',
);
ok(
  /backupVerified: osAgg\.anyOk \? true : osAgg\.anyBad \? false : null/.test(idxProv),
  '★ `backupVerified` 用「**至少一份**通过」（B6 的原话），与正文档位的"保守合并"分开',
);
// ★ §38.9：`Number(null) === 0` 这个坑本轮**第二次**踩到 —— 真机交付件里 62 那一段
//   直接印出了 `null 个损坏页`（守卫 `Number.isFinite(Number(count))` 形同虚设）。
//   所以：① 判定收进共用的 `toCount`；② 真渲染一遍，断言交付文本里不出现字面 null。
ok(an2.toCount(null) === null && an2.toCount('') === null && an2.toCount(undefined) === null, '`toCount`：没取到 → null（不是 0）');
ok(an2.toCount(0) === 0 && an2.toCount('3') === 3 && an2.toCount('x') === null, '`toCount`：0 是合法值必须留下；非数字 → null');
ok(dsc.describeCoverage({ dscNodes: null, targets: ['a'], connected: ['a'] }).state === 'unknown', '`describeCoverage` 用 `toCount` 后行为不变（取不到节点数仍判 unknown）');
const lsRenderClean = plugin.renderOsLogScan([{ label: 'n1', command: 'sh x', verdict: { state: 'clean', count: 0, occurrences: 2, detail: 'd' } }]);
const lsRenderUnknown = plugin.renderOsLogScan([{ label: 'n2', command: 'sh x', verdict: { state: 'unknown', count: null, occurrences: null, detail: 'd' } }]);
ok(/\*\*0\*\* 个损坏页/.test(lsRenderClean), '损坏页数 0 要**印出来**（0 是结论，不是"没取到"）');
ok(!/null/.test(lsRenderUnknown), '★ count 为 null 时渲染文本里**不许出现字面 null**（真机交付件里的实际缺陷）');
ok(/没有「最坏一次损坏页数」可报/.test(lsRenderUnknown) && /不等于\*\* 0 个坏页/.test(lsRenderUnknown), '★ 没取到时改为明说「没有可报的数，且不等于 0 个坏页」');

console.log('\n=== 10. 包声明 ===');
const pkg = JSON.parse((await import('node:fs')).readFileSync(path.join(PKG, 'package.json'), 'utf8'));
ok(typeof pkg.dsh?.bundle?.patch === 'string', '声明了 dsh.bundle.patch');
ok((await import('node:fs')).existsSync(path.join(PKG, pkg.dsh.bundle.patch)), 'patch 文件存在');
ok(pkg.type === 'module', 'type = module');
ok(!Object.keys(pkg.dependencies ?? {}).some((d) => d.startsWith('@deepseek-ai/')), '官方包不在 dependencies');
ok(pkg.description.includes('·'), '描述为中英双语');

// ★ 真机回归（DMDSC 实测输出）：ASM 路径下 dmrman 够不到备份集，
//   **绝不能**判成「备份损坏」—— 那会把「工具够不着」谎报成「备份坏了」。
const asmOut =
  'SBT[-127]:[错误码:-127]无效的备份集目录[+DMDATA/data/dameng/bak/DB_x]\n' +
  'MML[-10001]:设置第三方MM属性失败，错误码[-127]\n' +
  'dmrman_main end, code[-10001], return -1.';
const asmV = osshMod.judgeCheckBackupset({ status: 1, stdout: asmOut, stderr: '' });
ok(asmV.state === 'unknown', `ASM 够不到备份集 => unknown 而非 bad（实得 ${asmV.state}）`);
ok(/不是「备份损坏」的证据/.test(asmV.detail), 'unknown 里讲明「这不是备份损坏的证据」');
ok(/ASM/.test(asmV.detail), '并提示该路径是 ASM、需配置 ASM 访问');
ok(
  osshMod.judgeCheckBackupset({ status: 1, stdout: '校验失败：备份集损坏', stderr: '' }).state === 'bad',
  '真的说「备份集损坏」时仍判 bad',
);

// ★ §31：ASM 上 dmrman 需要 DCR 配置（真机实测：加 DCR_INI 后立刻 check successfully）
const DCRP = '/home/dmdba/dmdbms/data/DSC01/dmdcr.ini';
ok(
  osshMod.buildCheckBackupset('+DMDATA/x', 'dmrman') === 'dmrman CTLSTMT="CHECK BACKUPSET \'+DMDATA/x\'"',
  '不给 DCR_INI 时命令与原来逐字一致（不改动旧行为）',
);
ok(
  osshMod.buildCheckBackupset('+DMDATA/x', 'dmrman', DCRP) ===
    `dmrman DCR_INI=${DCRP} CTLSTMT="CHECK BACKUPSET '+DMDATA/x'"`,
  '★ 给 DCR_INI 时，命令里带上 `DCR_INI=<dmdcr.ini>`（ASM 上能不能校验就看这一项）',
);
let injBlocked = false;
try {
  osshMod.buildCheckBackupset('+DMDATA/x', 'dmrman', '/tmp/a; rm -rf /');
} catch {
  injBlocked = true;
}
ok(injBlocked, '★ `dmrmanDcrIni` 也走 `safeArg` —— 命令注入在构造阶段就被拦（不是静默清洗）');
ok(
  // ⚠️ 必须 `await`：§42 把执行器改成 async 之后，不 await 的话这里比的是**Promise 对象**，
  //    而 Promise 永远 `!== undefined` —— 这条断言会**假通过**。
  (await osshMod.runRemote({
    command: `dmrman DCR_INI=${DCRP} CTLSTMT="CHECK BACKUPSET '+DMDATA/x'"`,
    host: 'h',
    user: 'u',
    password: 'p',
    plinkPath: 'plink_does_not_exist',
  })) !== undefined,
  '白名单放行「带 DCR_INI 的 CHECK BACKUPSET」形态（走到执行阶段才失败，被拒就不会走到）',
);
// ★ §42：plink 不存在时**必须 resolve 一个结果对象**（而不是抛），否则并发的 `Promise.all` 会整体炸掉，
//   读者看到的会是"报告生成失败"而不是"SSH 没跑起来"。
const noPlink = await osshMod.runRemote({
  command: `dmrman DCR_INI=${DCRP} CTLSTMT="CHECK BACKUPSET '+DMDATA/x'"`,
  host: 'h',
  user: 'u',
  password: 'p',
  plinkPath: 'plink_does_not_exist',
});
ok(noPlink.ok === false && !!noPlink.error, '★ plink 不存在 → 返回 `ok:false` + error（不抛，并发下不炸整份报告）');
ok(/SSH 层无法执行/.test(osshMod.sshTroubleNote(noPlink) ?? ''), '★ 并且被 `sshTroubleNote` 认成"传输层没跑起来"');

// ============ §46 真坏页实验：页校验失败必须能被**在线**发现 ============
// 实测背景（DESIGN §46）：把一页数据清零 → 读它 → DM **直接 abort 整个实例**，
// 而 `V$ERROR_PAGE` **0 行**、全备日志也报 `0 corrupted pages during backup`。
// 唯一抓到它的是实例日志里的 `[EID:48] ... page check error! page:(4, 0, 73000)`。
const realScanOut46 = [
  'scan-backup-log  logdir=/home/dmdba/dmdbms/log',
  '=== 2. whole-database page verdict (from the backup log) ===',
  '     0 corrupted pages during backup',
  '     0 corrupted pages during backup',
  '=== 6. page check errors in the instance log (PAGE_CHECK) ===',
  '  -- /home/dmdba/dmdbms/log/dm_DMSERVER_202610.log',
  '     [EID:48]Server page check error! page:(4, 0, 73000)',
  '     SHUTDOWN ABORT',
  '     dm_sys_halt',
].join('\n');
const v46 = osshMod.parseCorruptionVerdict(realScanOut46);
ok(v46.state === 'corrupt', '★ §46：备份日志报 0、实例日志有页校验失败 ⇒ 判 **corrupt**（不是 clean）');
ok(
  (v46.pageCheckErrors ?? []).length === 1 &&
    v46.pageCheckErrors[0].tsId === 4 && v46.pageCheckErrors[0].fileId === 0 && v46.pageCheckErrors[0].pageNo === 73000,
  '★ §46：页坐标被解析出来（(4, 0, 73000)）—— 这是唯一能给出"哪一页"的在线证据',
);
ok(
  v46.abortCount >= 2 && /SHUTDOWN ABORT|dm_sys_halt/.test(v46.detail),
  '★ §46：把 `SHUTDOWN ABORT`／`dm_sys_halt` 的次数也带出来（读到坏页会打停整个实例）',
);
ok(
  /全备日志报的是 `0 corrupted pages`/.test(v46.detail) && /以实例日志为准/.test(v46.detail),
  '★ §46：正文必须点明两个来源**互相矛盾**，并说清以哪个为准（否则读者以为数据错了）',
);
ok(/dmdbchk/.test(v46.detail), '★ §46：并告诉运维**怎么判断当前状态**（停库跑 dmdbchk）');
// 只有"0 corrupted pages"、没有任何页校验失败 ⇒ clean，但**不许**说成"全库无坏页的证明"
const v46clean = osshMod.parseCorruptionVerdict('     0 corrupted pages during backup\n     0 corrupted pages during backup');
ok(v46clean.state === 'clean' && v46clean.pageCheckErrors.length === 0, '只有备份日志且报 0 ⇒ clean');
ok(
  /不是.*「全库无坏页」的证明/.test(v46clean.detail) && /dmdbchk/.test(v46clean.detail),
  '★★ §46.4-②：`clean` 的措辞**必须降级** —— 实测它对真坏页报 0，不能当"全库无坏页"的证明',
);
// 渲染层：坐标要摊开印出来
const logScanRaw46 = plugin.renderOsLogScan([
  { label: 'n1', command: 'sh scan-backup-log.sh /log', verdict: v46 },
]);
// `renderOsLogScan` 返回的是**拼好的文本**（早期版本返回数组）—— 两种都兜住，免得再踩一次
const logScanJoined46 = Array.isArray(logScanRaw46) ? logScanRaw46.join('\n') : String(logScanRaw46);
ok(
  /页校验失败记录 1 条/.test(logScanJoined46) && /\(4, 0, 73000\)/.test(logScanJoined46),
  '★ §46：正文里摊开页校验失败的**坐标**（读者要能直接拿去定位）',
);
ok(
  /dmdbchk path=/.test(logScanJoined46) && /停库/.test(logScanJoined46),
  '★ §46：正文给出"要正面结论只能停库跑 dmdbchk"的可执行命令（插件自己不停库）',
);
// 脚本本身：必须含新的第 6 节，且仍是**纯 ASCII**（它要被 scp 到各种主机上跑）
const scanSh = fsmod.readFileSync(path.join(PKG, 'assets', 'shell', 'scan-backup-log.sh'), 'utf8');
ok(/=== 6\. page check errors in the instance log/.test(scanSh), '★ §46：脚本新增第 6 节扫实例日志');
ok(
  /\[EID:48\]/.test(scanSh) && /SHUTDOWN ABORT/.test(scanSh) && /dm_sys_halt/.test(scanSh),
  '★ §46：脚本里的锚点 = `[EID:48]` / `SHUTDOWN ABORT` / `dm_sys_halt`',
);
ok(
  [...scanSh].every((ch) => ch.charCodeAt(0) < 128),
  '★ 脚本仍然是**纯 ASCII**（scp 到任意主机、任意 locale 都不会乱码 —— 这条一直有，别改坏）',
);
ok(!/\r/.test(scanSh), '★ 脚本仍是 **LF 换行**（CRLF 会让 `sh` 在 Linux 上报 `\r: not found`）');

// ★ §43：反查落空时**必须**把"文件号口径未验证"这条一起说出来
//   真机实测：这个库里同时存在三套不一致的"文件号"（DBA_EXTENTS.FILE_ID=0、DBA_DATA_FILES.RELATIVE_FNO=1、
//   V$DATAFILE.GROUP_ID=0/4/5），而 V$ERROR_PAGE 为空 ⇒ 插件那条 join 用的号是哪一套，**没验过**。
//   不说的话，读者会把"没定位到"读成"这页不属于任何对象" —— 而它可能只是口径不同。
const emptyLookupNote = an.attachObjects(
  [{ tsId: 5, fileId: 0, pageNo: 2593, key: 'k', errors: [], repairs: [], skips: [] }],
  [{ page: {}, sql: 'SELECT 1 FROM DUAL' }],
  [{ columns: [], rows: [], error: null }],
)[0].objectNote;
ok(/不属于任何对象/.test(emptyLookupNote), '反查落空时仍保留"不是「不属于任何对象」的结论"这句');
ok(
  /文件号/.test(emptyLookupNote) && /尚未在真机上验证/.test(emptyLookupNote),
  '★ §43：并明说「两边文件号口径是否同一套，尚未在真机上验证」',
);
ok(
  /每一条坏页都定位不到/.test(emptyLookupNote),
  '★ 且给出**可区分的判据**（口径问题表现为"全部定位不到"，而不是个别）',
);

// ============ §42 并发（把 OS 段从 12.8 秒压到"最慢的那条"）============
// ① 执行器必须是**异步**的：`spawnSync` 阻塞事件循环，`Promise.all` 包不出并发
ok(osshMod.runRemote.constructor.name === 'AsyncFunction', '★ `runRemote` 是 async（不是 spawnSync 的同步外壳）');
const osshSrc42 = fsmod.readFileSync(path.join(PKG, 'lib', 'ossh.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
// ⚠️ 查的是**调用**不是提及：这一节的注释里本来就要写"为什么不能用 spawnSync"，
//    拿 /spawnSync/ 去扫会把那段说明也判成违规（第一次就是这么假失败的）。
ok(!/\bspawnSync\s*\(/.test(osshSrc42), '★ `ossh.js` 里没有 `spawnSync(...)` 调用（留着它就会有人再同步执行一次）');
ok(
  ['checkBackupsetViaSsh', 'scanBackupLogViaSsh', 'findBackupsViaSsh'].every(
    (k) => osshMod[k].constructor.name === 'AsyncFunction',
  ),
  '★ 三个高层封装都是 async（`await` 对同步注入的 `run` 同样成立，两种都支持）',
);
// ② 行为级证明：两个各 sleep 300ms 的"远端命令"并发跑，总耗时应当只等于**一条**
const sleepRun = (ms) => async () => {
  await new Promise((r) => setTimeout(r, ms));
  return { ok: true, status: 0, stdout: '  page check : 0 corrupted pages during backup', stderr: '' };
};
const t0 = Date.now();
await Promise.all([
  osshMod.scanBackupLogViaSsh({ logDir: '/l', scriptPath: '/s.sh', ssh: fakeSsh, run: sleepRun(300) }),
  osshMod.checkBackupsetViaSsh({ backupPath: '/x/bak', ssh: fakeSsh, run: sleepRun(300) }),
]);
const parMs = Date.now() - t0;
ok(parMs < 550, `★ 两条 300ms 的命令并发后总耗时 ${parMs}ms（串行会是 600ms+）—— 并发真的生效了`);
// ③ 调用点：三条命令在**两个 action** 里都是 `Promise.all`
const idxSrc42 = fsmod.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
ok(
  (idxSrc42.match(/await Promise\.all\(\[\s*runBackupsetCheck\(/g) ?? []).length === 2,
  '★ `backup` 与 `report` 两个 action 都把三条 OS 命令并发发（不许只改一处）',
);
ok(
  (idxSrc42.match(/Promise\.all\(\s*ssh\.nodes\.map\(async \(node\)/g) ?? []).length === 3,
  '★ 三个 runner 内部都是"逐节点并发"（多节点不再排队）',
);
let rejNotWhitelisted = false;
try {
  await osshMod.runRemote({ command: `dmrman DCR_INI=${DCRP} ; rm -rf /`, host: 'h', user: 'u', password: 'p' });
} catch {
  rejNotWhitelisted = true;
}
ok(rejNotWhitelisted, '★ 纵深防御仍然生效：非白名单形态（带分号）在执行前被拒');
ok(
  /DCR_INI=<dmdcr\.ini>/.test(asmV.detail) && /check backupset successfully/.test(asmV.detail) && /2\.9 秒/.test(asmV.detail),
  '★ ASM 够不着时的提示给出**实测可行的那一步**（加 DCR_INI 后成功），不再只说"请配置 ASM 访问"',
);
ok(
  /dmrmanDcrIni/.test(idxProv) && /dcrIni: node\.dcrIni/.test(idxProv) && /alignList\(args\.dmrmanDcrIni/.test(idxProv),
  '★ `dmrmanDcrIni` 接到 OS 层且**逐节点**生效（§38：DMDSC 上 dmdcr.ini 本来就逐节点不同）',
);
// ★ 真机原文：dmrman 会往 stdout 写 OSC 标题（ESC ] 0 ; …），交付件里不能带控制序列
const REAL_OSC_OK =
  '\u001b]0; DMRMAN dcr_ini=/home/dmdba/dmdbms/data/DSC01/dmdcr.ini ap_port=4236 CHECK BACKUPSET \'+DMDATA/data/dameng/bak/DB_x\'\n' +
  'check backupset successfully.\ntime used: 00:00:03.185';
ok(
  !/\u001b|]0; /.test(osshMod.meaningfulLines(REAL_OSC_OK, 4).join(' ')) &&
    // ★ 不能只断言"没有转义符"——空串也满足它。必须同时确认**真信息还在**
    /check backupset successfully/.test(osshMod.meaningfulLines(REAL_OSC_OK, 4).join(' ')),
  '★ `meaningfulLines` 抠掉终端控制序列**且不吞掉后续输出**（真机 dmrman 的 OSC 标题没有终止符）',
);
const oscVerdict = osshMod.judgeCheckBackupset({ status: 0, stdout: REAL_OSC_OK, stderr: '' });
ok(
  oscVerdict.state === 'ok' && !/\u001b|]0; /.test(oscVerdict.detail) && /check backupset successfully/.test(oscVerdict.detail),
  '★ 带 OSC 的真机输出仍判 ok，且结论依据里没有控制序列（第一版交付件里混进了 ESC）',
);
// ★ OS 三项必须**两个 action 共用一个构造**，且都进信封（真机上 report 曾经只在正文里渲染）
ok(
  // 1 处定义 + 2 处调用（backup 里 `...osFindingsOf(...)`、report 里 `const osFindings = osFindingsOf(...)`）
  (idxProv.match(/osFindingsOf\(\{ osCheck, osLogScan, osFind \}\)/g) ?? []).length === 3 &&
    // 三类 kind 的字面量各只出现 1 次（都在那份共用构造里）；多节点时 ID 由 `kind` 拼出（§38）
    (idxProv.match(/'os-check'/g) ?? []).length === 1 &&
    (idxProv.match(/'os-logscan'/g) ?? []).length === 1 &&
    (idxProv.match(/'os-find'/g) ?? []).length === 1 &&
    /const osNodeSuffix = \(label\) =>/.test(idxProv),
  '★ OS 结论项只由 `osFindingsOf` 构造（1 定义 + 2 调用；多节点时 ID 追加节点后缀）',
);
ok(
  // 需求项移除后只剩两个来源（OS + 分级），断言跟着改 —— 但**要验的东西没变**：
  // findings 必须是"合并了各方"的那一份，而不是只装场景分级
  /const allFindings = \[\.\.\.osFindings, \.\.\.reportFindings\]/.test(idxProv),
  '★ report 的 findings 里含 OS 三项（第一版只在 HTML 里渲染，`findings.json` 缺这一半）',
);
ok(
  (idxProv.match(/os: osResultOf\(\{ osCheck, osLogScan, osFind \}\)/g) ?? []).length === 2,
  '`result.os` 也由共用的 `osResultOf` 产出（两个 action 形状一致）',
);

console.log(`\n=== 结果：${asserted} 项断言，${failed === 0 ? '全部通过' : failed + ' 项失败'} ===\n`);
process.exit(failed === 0 ? 0 : 1);
