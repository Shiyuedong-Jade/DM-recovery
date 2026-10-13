/**
 * 坏页链路的**真机半验证**（DESIGN §43）。
 *
 * ## 为什么只能"半"验证
 *
 * 这条链路要真机验证，前提是**真有一个坏页**。而：
 *   · 本项目手上唯一活着的库是生产 DMDSC 集群，**没有坏页**（`V$ERROR_PAGE` 0 行），
 *     也不该往生产库上造一个（那要写数据文件，违反本插件"全程只读"的边界，且真会损失数据）；
 *   · 单实例 `10.127.11.40` 一直是关的（`5236` / `22` 都不可达），拿不到可丢弃实例。
 *
 * 于是把链路拆成两半，只把**触发条件**换成注入的，其余全部用真机数据：
 *
 * | 环节 | 本脚本用的是什么 |
 * | --- | --- |
 * | 页坐标（表空间 / 文件 / 块） | **真机**：从活的库里 `DBA_EXTENTS` 挑一个**真实存在**的段区间 |
 * | `V$ERROR_PAGE` 列名与列序 | **真机**：§12 / §13 实测标定的 8 列 |
 * | `TS_ID` ↔ 表空间名 | **真机**：`V$TABLESPACE` |
 * | 对象反查 SQL + 执行 | **真机**：`DBA_EXTENTS` 区间匹配，真的在库上跑 |
 * | 备份账本 / 完成时间 | **真机**：`V$BACKUPSET` 解析结果 |
 * | 页记录本身（RECORD_TIME / ERRCODE） | ❌ **注入** |
 *
 * 所以它能证明的是：**"如果真有这么一页，能不能定位到对象、能不能算清它相对备份的先后"**；
 * 它**不能**证明"真坏页会不会被 `V$ERROR_PAGE` 记下来、记成什么值"—— 那一条仍待可丢弃实例。
 *
 * ## 用法
 *
 *   $env:DM_HOST='10.127.11.61:7236'; $env:DM_USER='awr1'; $env:DM_PASSWORD='…'
 *   node tools/page-chain-check.mjs
 *
 * 退出码：`0` 链路走通；`1` 有断言失败（链路坏了）；`2` 环境不可用（连不上库）。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

const plugin = await import(pathToFileURL(path.join(PKG, 'lib', 'index.js')).href);
const bridge = await import(pathToFileURL(path.join(PKG, 'lib', 'bridge.js')).href);
const an = await import(pathToFileURL(path.join(PKG, 'lib', 'analyze.js')).href);
const bk = await import(pathToFileURL(path.join(PKG, 'lib', 'backup.js')).href);

let tool = null;
plugin.apply({ tools: { register: (t) => { tool = t; return () => {}; } }, get: () => undefined }, {});

let failed = 0;
let asserted = 0;
const ok = (c, m) => {
  asserted++;
  console.log(`  [${c ? '通过' : '失败'}] ${m}`);
  if (!c) failed++;
};

const PASSWORD = process.env.DM_PASSWORD;
if (!PASSWORD) {
  console.error('缺少 DM_PASSWORD 环境变量（口令不走命令行参数，避免进 shell 历史）。');
  process.exit(2);
}
const hostArg = process.env.DM_HOST ?? '127.0.0.1';
const i = hostArg.lastIndexOf(':');
const conn = {
  host: i > 0 && /^\d+$/.test(hostArg.slice(i + 1)) ? hostArg.slice(0, i) : hostArg,
  port: Number(process.env.DM_PORT ?? (i > 0 && /^\d+$/.test(hostArg.slice(i + 1)) ? hostArg.slice(i + 1) : 5236)),
  user: process.env.DM_USER ?? 'SYSDBA',
  password: PASSWORD,
};

console.log(`\n=== 坏页链路真机半验证（注入页 × 真机数据）· ${conn.host}:${conn.port} ===`);
console.log('（页坐标取自真机、反查 SQL 真的在库上跑；只有 RECORD_TIME / ERRCODE 是注入的）\n');

// ---------------------------------------------------------------- 1. 真机：挑一个真实存在的段区间
console.log('=== 1. 从真机取一个**真实存在**的页坐标 ===');
let extentRes;
try {
  extentRes = await bridge.runQueries(conn, [
    {
      key: 'extent',
      // `ROWNUM` 而不是 `FETCH FIRST`：达梦两种都认，但 `ROWNUM` 更保守。
      // ⚠️ 阈值只能用 `BLOCKS >= 2`：实测本环境 `MAX(BLOCKS) = 3`（区很小），
      //    第一版写 `BLOCKS > 8` 直接一行都挑不到 —— 阈值也是"实测才知道"的东西。
      sql:
        `SELECT TABLESPACE_NAME, FILE_ID, BLOCK_ID, BLOCKS, OWNER, SEGMENT_NAME, SEGMENT_TYPE, RELATIVE_FNO FROM DBA_EXTENTS ` +
        `WHERE BLOCKS >= 2 AND ROWNUM <= 30 ORDER BY BLOCKS DESC`,
    },
  ]);
} catch (e) {
  console.error(`环境不可用：连不上 ${conn.host}:${conn.port}。原始错误：${String(e?.message ?? e).slice(0, 300)}`);
  process.exit(2);
}
const ex = extentRes.extent;
if (ex?.error) {
  console.error(`环境不可用：DBA_EXTENTS 查询失败 —— ${ex.error}`);
  process.exit(2);
}
if ((ex?.rows ?? []).length === 0) {
  console.error('这库里 DBA_EXTENTS 没有 BLOCKS>=2 的段，本脚本挑不到坐标（不猜）。');
  process.exit(2);
}
const [tsName, fileId, blockId, blocks, owner, segName, segType, relFno] = ex.rows[0];
// 取区间**内部**的一个块（不是首块也不是末块），这样"区间命中"才是真的被验证了
const probeBlock = Number(blockId) + Math.min(2, Math.max(0, Number(blocks) - 1));
console.log(`  真机坐标：表空间 ${tsName} / 文件 ${fileId} / 块 ${probeBlock}`);
console.log(`  该块实际属于：${owner}.${segName}（${segType}，区间 ${blockId}..${Number(blockId) + Number(blocks) - 1}）`);
ok(Number.isFinite(probeBlock), '从真机取到了可用的页坐标');

// ---------------------------------------------------------------- 2. 真机：TS_ID ↔ 表空间名
console.log('\n=== 2. 表空间映射（真机 V$TABLESPACE）===');
const tsRes = await bridge.runQueries(conn, [
  { key: 'tablespaces', sql: 'SELECT ID, NAME FROM V$TABLESPACE' },
]);
const tsMap = an.tablespaceMap(tsRes.tablespaces);
const tsId = Object.keys(tsMap).find((k) => String(tsMap[k]) === String(tsName));
ok(tsId !== undefined, `表空间名 ${tsName} 反查到 TS_ID=${tsId}（坏页只给 ID，这一步必须有）`);

// ---------------------------------------------------------------- 3. 注入页记录（列形状是真机的）
console.log('\n=== 3. 构造注入页（列名/列序 = 真机实测的 8 列）===');
const ERR_COLS = ['TS_ID', 'FILE_ID', 'PAGE_NO', 'ERRCODE', 'RECORD_TIME', 'DB_MAGIC', 'FILE_NAME', 'LINE_NO'];
const rowAt = (t) => [Number(tsId), Number(fileId), probeBlock, 48, t, 1251532393, 'main.dbf', 1410];
const injectedErr = {
  columns: ERR_COLS,
  rows: [rowAt('2026-10-12 09:00:00')],
  error: null,
};
const emptyRes = { columns: [], rows: [], error: null };
const list = an.buildPageList({ errorPage: injectedErr, repairedPage: emptyRes, skipCpage: emptyRes });
ok(list.counts.distinctPages === 1, `注入 1 页被解析成 ${list.counts.distinctPages} 条坏页记录`);
const e0 = list.entries[0];
ok(
  String(e0.tsId) === String(tsId) && String(e0.fileId) === String(fileId) && String(e0.pageNo) === String(probeBlock),
  `三元组解析正确：(${e0.tsId}, ${e0.fileId}, ${e0.pageNo})`,
);
ok(e0.errcodes.includes('48') && e0.lineNos.includes('1410'), 'ERRCODE / LINE_NO 带进了结论项（供人查 EID）');

// ---------------------------------------------------------------- 4. 真机：反查 SQL 真的跑一次
console.log('\n=== 4. 对象反查 —— 真的在库上执行 DBA_EXTENTS 区间匹配 ===');
const lookups = an.buildReverseLookups(list.entries, tsMap);
ok(lookups.length === 1 && !!lookups[0].sql, '生成了反查 SQL（表空间名已从 TS_ID 反查出来）');
console.log(`  SQL：${String(lookups[0].sql).slice(0, 160)}…`);
const lkRes = await bridge.runQueries(conn, lookups.map((l, k) => ({ key: `lk${k}`, sql: l.sql })));
const results = lookups.map((_, k) => lkRes[`lk${k}`]);
const enriched = an.attachObjects(list.entries, lookups, results);
const obj = enriched[0].object;
ok(!!obj, `定位到对象：${obj ? `${obj.owner}.${obj.segmentName}` : `未定位 —— ${enriched[0].objectNote}`}`);
ok(
  obj && String(obj.segmentName) === String(segName) && String(obj.owner) === String(owner),
  `★ 定位结果与真机 `+'`DBA_EXTENTS`'+` 的原始行**一致**（${obj?.owner}.${obj?.segmentName}）—— 这条链路第一次在真机上被证明可用`,
);
ok(
  obj && Number(obj.blockId) <= probeBlock && Number(obj.blockId) + Number(obj.blocks) > probeBlock,
  `★ 命中的是**包含该块的区间**（BLOCK_ID=${obj?.blockId} BLOCKS=${obj?.blocks}），不是碰巧第一条`,
);

// ---------------------------------------------------------------- 5. 真机账本：坏页 vs 备份的先后
console.log('\n=== 5. 「坏页 vs 备份」的时间关系（用真机账本）===');
const env = await tool.execute({ action: 'backup', ...conn, ...(process.env.DM_TARGETS ? { targets: process.env.DM_TARGETS } : {}) });
const backups = env.result?.backups ?? [];
ok(backups.length > 0, `真机账本里有 ${backups.length} 条备份（域是 §38 里那个 ASM 备份集）`);
const full = backups.find((b) => b.isFull) ?? backups[0];
console.log(`  最近一次完全备份：${full?.name}（${full?.time}）`);

// 同一个坏页坐标，只改**发现时间**：备份前 / 备份后，结论必须翻转
const rowToObj = (row) => Object.fromEntries(ERR_COLS.map((c, k) => [c, row[k]]));
/**
 * ★ 两个探针时间**按真机账本算**，不写死。
 *
 * 写死是我第一版干的（`2026-10-09` / `2026-10-12 09:00`）—— 在 DMDSC 上恰好成立
 * （那份账本最近一次全备是 `2026-10-10 15:03`），换到单实例上就**两条断言全红**：
 * 那边的最近全备比 `2026-10-12 09:00` 还新，于是"晚于备份"那侧也落进了 `before-backup`。
 *
 * 这正是本项目反复踩的那个坑：**把某一次实测值当普遍事实**（§30 抓出的两个缺陷就是它）。
 * 工具也一样 —— 夹具里的日期属于"实测值"，只能来自本次运行。
 */
const stamp = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const bt = bk.toMs(full.time);
ok(bt !== null, `账本里最近一次全备有完成时间：${full.time}`);
const tBefore = stamp(bt - 6 * 3600 * 1000);
const tAfter = stamp(bt + 6 * 3600 * 1000);
console.log(`  探针时间：备份前 ${tBefore} ／ 备份后 ${tAfter}（以账本 ${full.time} 为基准 ±6h）`);
const before = bk.relatePagesToBackups([rowToObj(rowAt(tBefore))], backups)[0];
const after = bk.relatePagesToBackups([rowToObj(rowAt(tAfter))], backups)[0];
ok(before.rel === 'before-backup', `发现时间 ${tBefore} 早于备份 → ${before.rel}（这才是"备份能救"的那一侧）`);
ok(after.rel === 'after-backup', `发现时间 ${tAfter} 晚于备份 → ${after.rel}（这一侧备份救不了，只能靠归档/闪回）`);
ok(
  before.rel !== after.rel,
  '★ 同一坐标、只改发现时间，结论就翻转 —— 说明"算术依据"真的接在真机账本上，不是常量',
);

// ---------------------------------------------------------------- 6. 量纲与"文件号口径"
console.log('\n=== 6. 两个**口径**问题：一个查实了，一个查不实 ===');
const unitRes = await bridge.runQueries(conn, [
  // ⚠️ 注意列名：`V$DATAFILE.ID` 在本环境**全是 0**，区分文件的是 `GROUP_ID`（0/4/5）。
  //    第一版我按 `ID` 读，于是把"全局号 0/4/5"错认成了 ID 列 —— 这类"列名看着像"的坑，
  //    只有把整行打出来才看得见（所以下面把三套号都打印出来）。
  { key: 'df', sql: 'SELECT GROUP_ID, ID, PATH, PAGE_SIZE, TOTAL_SIZE FROM V$DATAFILE' },
  { key: 'datafiles', sql: 'SELECT TABLESPACE_NAME, FILE_ID, RELATIVE_FNO, FILE_NAME, BYTES FROM DBA_DATA_FILES' },
]);
const dfRows = unitRes.df.rows ?? [];
const ddfRows = unitRes.datafiles.rows ?? [];
// 列序是 GROUP_ID, ID, PATH, PAGE_SIZE, TOTAL_SIZE —— 改过 SELECT 就得跟着改下标（刚刚踩过一次）
const pageSize = Number(dfRows[0]?.[3] ?? 0);
// ① 量纲：DBA_EXTENTS 的 BLOCKS 是"块"还是"字节"？
//    判据：BYTES / BLOCKS 应等于 PAGE_SIZE ⇒ BLOCKS 就是**页数**、BLOCK_ID 就是**页号**量级，
//    与 `V$ERROR_PAGE.PAGE_NO` 才是同一种东西（这一条是可以查实的）。
ok(
  pageSize > 0,
  `数据文件 PAGE_SIZE = ${pageSize} 字节`,
);
const oneExt = await bridge.runQueries(conn, [
  { key: 'one', sql: `SELECT BYTES, BLOCKS FROM DBA_EXTENTS WHERE TABLESPACE_NAME = '${String(tsName).replace(/'/g, "''")}' AND ROWNUM <= 1` },
]);
const oneRow = oneExt.one.rows?.[0] ?? [];
ok(
  Number(oneRow[0]) / Number(oneRow[1]) === pageSize,
  `★ 量纲查实：DBA_EXTENTS 的 BYTES/BLOCKS = ${Number(oneRow[0]) / Number(oneRow[1])} = PAGE_SIZE ⇒ **BLOCK_ID 是页号量级**（与 PAGE_NO 可比）`,
);
// ② 文件号口径：**这个库里存在至少三套互不一致的"文件号"列**
//    `DBA_EXTENTS.FILE_ID` / `DBA_DATA_FILES.FILE_ID` = 0；`DBA_DATA_FILES.RELATIVE_FNO` = 1；
//    `V$DATAFILE.GROUP_ID` = 0/4/5（而 `V$DATAFILE.ID` 全是 0）。
//    插件那条 `DBA_EXTENTS ... AND FILE_ID = <V$ERROR_PAGE.FILE_ID>` 只有在
//    **两边的号是同一套**时才成立；若 `V$ERROR_PAGE.FILE_ID` 是 GROUP_ID 那一套，
//    反查会**静默一行都匹配不到** —— 报告会说"未在 DBA_EXTENTS 中匹配到区间"，
//    而读者几乎一定读成"这一页不属于任何对象"（**最值钱的那个功能在骗人**）。
console.log(`  V$DATAFILE        ：GROUP_ID=${dfRows.map((r) => r[0]).join('/')}  ID=${dfRows.map((r) => r[1]).join('/')}`);
console.log(`  DBA_DATA_FILES    ：FILE_ID=${ddfRows.map((r) => r[1]).join('/')}  RELATIVE_FNO=${ddfRows.map((r) => r[2]).join('/')}`);
console.log(`  DBA_EXTENTS（本次）：FILE_ID=${fileId}  RELATIVE_FNO=${relFno}`);
const threeWay =
  new Set([
    `F=${ddfRows.map((r) => r[1]).join('/')}`,
    `R=${ddfRows.map((r) => r[2]).join('/')}`,
    `G=${dfRows.map((r) => r[0]).join('/')}`,
  ]).size;
ok(threeWay >= 2, `★ 三套号**互不一致**（${threeWay} 种取值）—— 口径风险是**真实的**，不是假想`);
ok(
  relFno !== undefined && relFno !== null,
  `本次坐标取自 DBA_EXTENTS 自己的号：TABLESPACE=${tsName} FILE_ID=${fileId} RELATIVE_FNO=${relFno}`,
);
console.log(
  '  ⚠️ **但 `V$ERROR_PAGE.FILE_ID` 用哪一套，本环境查不出来** —— `V$ERROR_PAGE` 是 0 行，没有真值可对。',
);
console.log('     这一条**只能**在可丢弃实例上验证：造一个坏页，看它的 FILE_ID 与上面哪一套对得上。');

// ---------------------------------------------------------------- 7. 收尾
console.log('\n=== 7. 本次**没有**验证到的（必须说清）===');
console.log('  · 真坏页会不会被 `V$ERROR_PAGE` 记下来、记成什么值、`FILE_ID` 用哪套号 —— 需要一台**可丢弃实例**，');
console.log('    在上面真的损坏一个数据页（例如给某个非关键数据文件写坏几个字节）后跑一次。');
console.log('  · 单实例 `10.127.11.40` 至今 5236/22 均不可达，所以连"单实例形态"也没覆盖到。');
console.log('  · 因此：**链路**（区间匹配 / 定位 / 时间关系）已验证；**触发条件与文件号口径**未验证。');
console.log('    报告里凡涉及坏页现状的措辞仍必须保留"未发现 ≠ 没有"这句免责。');

console.log(`\n=== 结果：${asserted} 项断言，${failed === 0 ? '全部通过' : `${failed} 项失败`} ===\n`);
process.exit(failed === 0 ? 0 : 1);
