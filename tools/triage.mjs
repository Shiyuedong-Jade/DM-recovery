/**
 * 达梦数据库可恢复能力评估 CLI（S1：list / readiness）
 *
 * 用法：
 *   node tools/triage.mjs readiness --host 10.127.11.61 --port 7236 --user sysdba --password ***
 *   node tools/triage.mjs list      --host ... [--triage]
 *   node tools/triage.mjs selftest                      # 离线单测判定逻辑，不连库
 *
 * 只读。桥只会放行 SELECT / WITH。
 */

import { runQueries, defaultHome, ensureHome } from '../lib/bridge.js';
import { FORM_QUERIES, READINESS_QUERIES, LIST_QUERIES, TABLESPACE_QUERY, ARCHIVE_QUERIES } from '../lib/queries.js';
import { checkArchiveParams, measureGrowth, recommendArchiveParams, observedRetention } from '../lib/archive.js';
import { judgeReadiness, buildPageList, judgeForm, buildReverseLookups, attachObjects, tablespaceMap } from '../lib/analyze.js';

const args = process.argv.slice(2);
const action = args.find((a) => !a.startsWith('--')) ?? 'help';
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * 连接参数**惰性构建**：selftest 与 help 完全不碰数据库，也不该去建目录。
 * （先前把它放在顶层，导致离线自检因为建工作目录失败而挂掉。）
 */
function buildConn() {
  return {
    home: ensureHome(flag('home') || defaultHome()),
    host: flag('host') ?? '127.0.0.1',
    port: Number(flag('port') ?? 5236),
    user: flag('user') ?? 'SYSDBA',
    password: flag('password') ?? '',
    driverJar: flag('driver-jar'),
    javaHome: flag('java-home'),
    maxRows: Number(flag('max-rows') ?? 500),
    timeoutSec: Number(flag('timeout') ?? 120),
  };
}

const f = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

function head(t) {
  console.log('\n' + '='.repeat(78));
  console.log(t);
  console.log('='.repeat(78));
}

// ------------------------------------------------------------------ readiness

async function cmdReadiness() {
  const conn = buildConn();
  const data = { ...(await runQueries(conn, [...FORM_QUERIES, ...READINESS_QUERIES])) };
  const r = judgeReadiness(data);
  const form = r.form;

  head('达梦数据库可恢复能力评估 —— 处置能力体检');
  console.log(`目标      ${conn.host}:${conn.port}   用户 ${conn.user}`);
  console.log(`实例      ${f(form.instanceName)} @ ${f(form.hostName)}   ${f(form.version)}`);
  console.log(`形态      ${form.label}${form.dscNodes ? `  （${form.dscNodes} 节点）` : ''}`);
  if (form.dscEps.length > 0) {
    for (const e of form.dscEps) console.log(`          ${f(e.name)}  ${f(e.mode)}  ${f(e.status)}`);
  }
  console.log(`页大小    ${f(r.pageSize)} 字节`);
  console.log('');

  console.log('处置路径判定');
  console.log('-'.repeat(78));
  const mark = { yes: '✅ 可用', no: '❌ 不可用', limited: '⚠️ 受限', 'high-risk': '🔴 高风险（不推荐）' };
  for (const p of r.paths) {
    console.log(`${mark[p.available] ?? p.available}  ${p.name}`);
    console.log(`    ${p.reason}`);
    for (const e of p.evidence ?? []) console.log(`    依据: ${e}`);
    console.log('');
  }

  console.log('结论');
  console.log('-'.repeat(78));
  console.log(`  ${r.verdict}`);
  console.log('');
  if (r.warnings.length > 0) {
    for (const w of r.warnings) console.log(`  ${w}`);
    console.log('');
  }

  console.log('参数现状');
  console.log('-'.repeat(78));
  console.log(`  PAGE_CHECK_POLICY = ${f(r.policy)}      PTX_ROLLBACK = ${f(r.ptxRollback)}`);
  console.log(`  SF_*_PAGE_REPAIR 在 DBA_OBJECTS 中命中 ${f(r.repairFnObjectCount)} 个对象`);
  console.log('');
  console.log('⚠️ 本工具不做主动扫描、不执行修复。所有结论均来自只读查询。');
}

// ----------------------------------------------------------------------- list

async function cmdList() {
  const conn = buildConn();
  const data = await runQueries(conn, LIST_QUERIES);
  const list = buildPageList(data);

  head('达梦数据库可恢复能力评估 —— 坏页清单');
  console.log(`目标 ${conn.host}:${conn.port}`);
  console.log(
    `V$ERROR_PAGE ${list.counts.errorRows} 行 / V$REPAIRED_PAGE ${list.counts.repairedRows} 行 / ` +
      `GV$ ${list.counts.gvErrorRows}+${list.counts.gvRepairedRows} / V$SQL_SKIP_CPAGE ${list.counts.skipRows} 行`,
  );

  for (const key of ['errorPage', 'repairedPage', 'gvErrorPage', 'gvRepairedPage', 'skipCpage']) {
    const r = data[key];
    if (r?.error) console.log(`  （${key} 查询失败：${String(r.error).split('\n')[0]}）`);
  }
  console.log('');

  if (list.entries.length === 0) {
    console.log('未发现坏页记录。');
    console.log('');
    console.log('❗ ' + list.disclaimer);
    return;
  }

  console.log(`共 ${list.counts.distinctPages} 个不同的损坏页，其中需要关注 ${list.needAttention.length} 个：`);
  console.log('');
  console.log('| 页 (TS,FILE,PAGE) | 文件 | 状态 | 最近报错时间 | 最近修复时间 | 报错次数 | 修复次数 | 错误码 |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const e of list.entries) {
    console.log(
      `| ${e.page} | ${f(e.fileName)} | ${e.statusText} | ${f(e.lastError?.toISOString?.().slice(0, 19).replace('T', ' '))} | ` +
        `${f(e.lastRepair?.toISOString?.().slice(0, 19).replace('T', ' '))} | ${e.errorCount} | ${e.repairCount} | ${e.errcodes.join(',') || '—'} |`,
    );
  }
  console.log('');

  if (list.reCorrupted.length > 0) {
    console.log('⚠️ 修复后再次损坏的页：');
    for (const e of list.reCorrupted) {
      console.log(`   ${e.page}（${f(e.fileName)}）—— **反复损坏同一位置是存储问题的信号，不是偶发事故**，`);
      console.log(`      处置方向应是查盘 / RAID 卡 / HBA，而不是反复修数据。`);
    }
    console.log('');
  }
  if (list.hotFiles.length > 0) {
    console.log('按文件聚合（次数 > 1 的文件）：');
    for (const h of list.hotFiles) console.log(`   (TS,FILE)=${h.key}  出现 ${h.count} 次`);
    console.log('');
  }

  const withSkips = list.entries.filter((e) => e.skips.length > 0);
  if (withSkips.length > 0) {
    console.log('V$SQL_SKIP_CPAGE 记录的受影响语句：');
    for (const e of withSkips) {
      for (const s of e.skips) {
        console.log(`   ${e.page}  ← 会话 ${f(s.sessId)} / 语句 ${f(s.stmtId)} / 第 ${f(s.execId)} 次执行 / 共跳 ${f(s.nTotal)} 页`);
      }
    }
    console.log('');
  }

  console.log('❗ ' + list.disclaimer);
  console.log('');
  console.log('ℹ️ 处置能力（能否在线修、能否时间点恢复）请另跑 `readiness`。');
}

// --------------------------------------------------------------------- triage

/**
 * 单个坏页的完整分诊：定位到对象 + 影响面 + 处置路径。
 * 对象反查走 DBA_EXTENTS 的**区间匹配**（字典查询），绝不扫用户表。
 */
async function cmdTriage() {
  const conn = buildConn();
  const base = await runQueries(conn, [...FORM_QUERIES, ...READINESS_QUERIES, ...LIST_QUERIES, TABLESPACE_QUERY]);
  const r = judgeReadiness(base);
  const list = buildPageList(base);
  const tsMap = tablespaceMap(base.tablespaces);

  head('达梦数据库可恢复能力评估 —— 逐页处置');
  console.log(`目标 ${conn.host}:${conn.port}   形态 ${r.form.label}`);
  console.log(`结论 ${r.verdict}`);
  console.log('');

  if (list.entries.length === 0) {
    console.log('未发现坏页记录，无需逐页分诊。');
    console.log('');
    console.log('❗ ' + list.disclaimer);
    return;
  }

  // 只对需要关注的页做反查（已修复且未再坏的不占查询预算）
  const targets = list.entries.filter((e) => e.status === 'never-repaired' || e.status === 're-corrupted');
  const lookups = buildReverseLookups(targets, tsMap);
  const sqls = lookups.filter((l) => l.sql);
  const results = sqls.length
    ? await (async () => {
        const res = await runQueries(conn, sqls.map((l, i) => ({ key: `lk${i}`, sql: l.sql })));
        return sqls.map((_, i) => res[`lk${i}`]);
      })()
    : [];
  const enriched = attachObjects(targets, lookups, results);

  for (const e of enriched) {
    console.log('─'.repeat(78));
    console.log(`页 ${e.page}   ${e.statusText}`);
    console.log(`  文件      ${f(e.fileName)}`);
    console.log(`  表空间    ${f(tsMap[String(e.tsId)])} (TS_ID=${f(e.tsId)})`);
    console.log(`  时间线    最近报错 ${fmtT(e.lastError)} / 最近修复 ${fmtT(e.lastRepair)}（报错 ${e.errorCount} 次，修复 ${e.repairCount} 次）`);
    if (e.errcodes.length) console.log(`  错误码    ${e.errcodes.join(', ')}`);
    if (e.object) {
      const o = e.object;
      console.log(`  所属对象  ${f(o.owner)}.${f(o.segmentName)}`);
      console.log(`  对象类型  ${f(o.segmentType)}${o.partition ? `  分区 ${o.partition}` : ''}`);
      console.log(`  区位置    BLOCK_ID=${f(o.blockId)}  BLOCKS=${f(o.blocks)}  BYTES=${f(o.bytes)}`);
      console.log('');
      console.log(`  → 影响面：该页属于上面这个段。**是否可重建取决于对象类型**——`);
      console.log(`     索引可重建；表要按业务容忍度决定（重建/导出导入/恢复到新实例）。`);
    } else {
      console.log(`  所属对象  未定位（${f(e.objectNote)}）`);
    }
    if (e.skips.length > 0) {
      console.log(`  受影响语句  ${e.skips.length} 条记录：`);
      for (const s of e.skips) console.log(`     会话 ${f(s.sessId)} / 语句 ${f(s.stmtId)} / 第 ${f(s.execId)} 次执行 / 共跳 ${f(s.nTotal)} 页`);
    }
    // 处置路径：按 readiness 的判定给唯一推荐
    const online = r.paths.find((p) => p.id === 'online-repair');
    const restore = r.paths.find((p) => p.id === 'restore');
    console.log('');
    console.log('  处置路径');
    if (online.available === 'yes') {
      console.log(`    · 可尝试在线页修复（需确认备库为实时/即时/同步且同步正常）`);
    } else {
      console.log(`    · ❌ 在线修复不可用：${online.reason}`);
    }
    if (restore.available === 'yes') {
      console.log(`    · ✅ 备份还原：归档已开，可时间点恢复。**但需确认备份早于损坏时间**（${fmtT(e.lastError)} 之前）。`);
    } else {
      console.log(`    · ⚠️ 备份还原受限：${restore.reason}`);
    }
    console.log(`    · 🔴 跳过损坏页：**不推荐**。它会让查询静默返回不完整数据。`);
    console.log('');
  }

  console.log('❗ ' + list.disclaimer);
}

const fmtT = (d) => (d instanceof Date ? d.toISOString().slice(0, 19).replace('T', ' ') : '—');

// ------------------------------------------------------------------- capacity

/**
 * 归档空间参数：检查 + 按实测速率推荐。
 *
 * 速率用「两次采样之间新建了哪些归档文件」来算——每个新文件大小精确已知，
 * 不依赖任何未核实的列语义。样本不足时**如实返回无法估算**。
 */
async function cmdCapacity() {
  const conn = buildConn();
  const sampleSec = Number(flag('sample-sec') ?? 60);
  const retentionHours = Number(flag('retention-hours') ?? 24);

  const first = await runQueries(conn, [...FORM_QUERIES, ...READINESS_QUERIES, ...ARCHIVE_QUERIES]);
  const chk = checkArchiveParams({ params: first.archParams, arch: first.archTargets });

  head('达梦归档空间参数 —— 检查与推荐');
  console.log(`目标 ${conn.host}:${conn.port}`);
  console.log('');

  console.log('## 一、参数检查');
  console.log('');
  console.log('| 参数 | 位置 | 当前值 | 状态 | 含义 |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const it of chk.items) {
    console.log(`| \`${it.name}\` | ${it.where} | ${f(it.value)} | ${it.set ? '✅ 已设' : '❌ 未设'} | ${it.meaning} |`);
  }
  console.log('');
  console.log('归档目标的空间上限（**这个参数在 dmarch.ini，不在 dm.ini**）：');
  console.log('');
  console.log('| 归档目标 | 类型 | 目的地 | 单文件(MB) | 空间上限(MB) | 有效 |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const d of chk.destinations) {
    console.log(
      `| ${f(d.name)} | ${f(d.type)} | ${f(d.dest)} | ${f(d.fileSizeMB)} | ` +
        `${d.spaceLimit === 0 ? '**0（不限制）**' : f(d.spaceLimit)} | ${f(d.valid)} |`,
    );
  }
  console.log('');
  console.log(`**${chk.summary}**`);
  console.log('');

  if (chk.items[0].blocking) {
    console.log('归档未开启，空间参数无从谈起——先完成开归档，再回来做容量规划。');
    return;
  }

  // ---- 二、速率采样（多次，才能测出峰值）----
  const rounds = Math.max(2, Number(flag('samples') ?? 3));
  console.log('## 二、重做/归档增长速率');
  console.log('');
  console.log(`采样 ${rounds} 轮、每轮间隔 ${sampleSec} 秒——**多次采样是为了测出峰值，而不只是平均**。`);
  const series = [{ files: first.archFiles, rlog: first.rlog }];
  for (let i = 1; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, sampleSec * 1000));
    const s = await runQueries(conn, ARCHIVE_QUERIES);
    series.push({ files: s.archFiles, rlog: s.rlog });
    console.log(`  第 ${i + 1}/${rounds} 轮完成`);
  }
  console.log('');

  const fileSizeMB = chk.destinations.find((d) => d.fileSizeMB)?.fileSizeMB ?? null;
  const growth = measureGrowth(series, { intervalHours: sampleSec / 3600, fileSizeMB });

  const ret = observedRetention({ files: first.archFiles });
  if (ret.ok) {
    console.log(`当前实际回溯窗口：最旧归档距今 **${ret.ageHours.toFixed(1)} 小时**（共 ${ret.fileCount} 个归档文件）`);
    console.log(`  ${ret.note}`);
    console.log('');
  }

  if (!growth.ok) {
    console.log(`❌ ${growth.reason}`);
    console.log('');
    console.log('这不影响第一部分的参数检查结论。');
    return;
  }
  console.log(`采样窗口 ${growth.totalHours.toFixed(2)} 小时，新建归档文件 ${growth.totalCreated} 个，合计 ${fmt(growth.totalMB, 0)} MB`);
  console.log(`- **平均速率 ≈ ${growth.avgMBPerHour.toFixed(1)} MB/小时**（只作对照，不建议用它定值）`);
  console.log(`- **观测峰值 ≈ ${growth.peakMBPerHour.toFixed(1)} MB/小时**（定值以此为基础）`);
  if (growth.peakToAvgRatio !== null) console.log(`- 峰值/平均 = ${growth.peakToAvgRatio.toFixed(1)} 倍`);
  if (growth.activeIntervalRatio !== null)
    console.log(`- 有归档产生的采样区间占比 ${(growth.activeIntervalRatio * 100).toFixed(0)}%`);
  if (growth.lsnDelta !== null) console.log(`  （${growth.lsnNote}：CUR_LSN 增量 ${growth.lsnDelta}）`);
  console.log('');

  // ---- 三、推荐 ----
  const asmRow = (first.asm?.rows ?? []).find((r) => {
    const c = first.asm.columns ?? [];
    const n = c.findIndex((x) => String(x).toUpperCase() === 'GROUP_NAME');
    return n >= 0 && String(r[n]).toUpperCase().includes('DMDATA');
  });
  const ac = first.asm?.columns ?? [];
  const totalMB = asmRow ? Number(asmRow[ac.findIndex((x) => /TOTAL_MB/i.test(x))]) : null;
  const freeMB = asmRow ? Number(asmRow[ac.findIndex((x) => /FREE_MB/i.test(x))]) : null;

  const rec = recommendArchiveParams({
    growth,
    totalMB,
    freeMB,
    retentionHours,
    destCount: chk.destinations.length || 2,
  });

  console.log('## 三、推荐值');
  console.log('');
  if (!rec.ok) {
    console.log(`❌ ${rec.reason}`);
    for (const n of rec.notes) console.log(`- ${n}`);
    return;
  }
  console.log(`磁盘：DMDATA 总 ${fmt(totalMB, 0)} MB / 剩余 ${fmt(freeMB, 0)} MB；回溯窗口假设 ${retentionHours} 小时`);
  console.log('');
  for (const [name, r] of Object.entries(rec.recommendations)) {
    console.log(`### \`${name}\` = **${r.value}**${r.perDestination ? '（每个归档目标）' : ''}`);
    console.log(`  ${r.why}`);
    if (r.caveat) console.log(`  ${r.caveat}`);
    console.log('');
  }
  for (const n of rec.notes) console.log(`- ${n}`);
}

// ------------------------------------------------------------------ selftest

async function cmdSelftest() {
  // 离线验证判定逻辑，不连库。
  const { judgeForm: jf, judgeReadiness: jr, buildPageList: bl } = await import('../lib/analyze.js');
  let fail = 0;
  const ok = (c, m) => {
    console.log((c ? '  [通过] ' : '  [失败] ') + m);
    if (!c) fail++;
  };

  head('离线自检（不连库）');

  const dscData = {
    instance: { columns: ['INSTANCE_NAME', 'HOST_NAME'], rows: [['DSC01', 'dsc01']] },
    database: { columns: ['NAME', 'ARCH_MODE'], rows: [['dameng', 'N']] },
    dwApply: { columns: ['CNT'], rows: [['0']] },
    dwSend: { columns: ['CNT'], rows: [['0']] },
    dscEp: { columns: ['EP_NAME', 'EP_MODE', 'EP_STATUS'], rows: [['DSC01', 'Control Node', 'OK'], ['DSC02', 'Normal Node', 'OK']] },
    params: { columns: ['PARA_NAME', 'PARA_VALUE'], rows: [['PAGE_CHECK_POLICY', '1'], ['PTX_ROLLBACK', '0']] },
    pageSize: { columns: ['PAGE_SIZE'], rows: [['32768']] },
    repairFn: { columns: ['CNT'], rows: [['0']] },
    arch: { columns: ['ARCH_NAME'], rows: [] },
  };
  const form = jf(dscData);
  ok(form.form === 'dsc', `形态判定 = ${form.form}（期望 dsc）`);
  const r = jr(dscData);
  const online = r.paths.find((p) => p.id === 'online-repair');
  ok(online.available === 'no', 'DMDSC 无守护 → 在线修复判为不可用');
  const restore = r.paths.find((p) => p.id === 'restore');
  ok(restore.available === 'limited', '非归档 → 备份还原判为受限');
  const scan = r.paths.find((p) => p.id === 'active-scan');
  ok(scan.available === 'no', 'PAGE_CHECK_POLICY=1 → 主动扫描判为不可用');
  ok(r.warnings.length >= 2, `产出 ${r.warnings.length} 条警示`);
  ok(r.verdict.includes('不具备在线页修复条件'), '结论含「不具备在线修复条件」');

  // 时间比对：修复后又坏
  const t = (s) => s;
  const pageData = {
    errorPage: {
      columns: ['TS_ID', 'FILE_ID', 'PAGE_NO', 'ERRCODE', 'RECORD_TIME', 'FILE_NAME'],
      rows: [
        ['4', '0', '100', '-2501', '2026-10-01 10:00:00.000000', 'main.dbf'],
        ['4', '0', '100', '-2501', '2026-10-05 10:00:00.000000', 'main.dbf'],
        ['4', '0', '200', '-2501', '2026-10-02 10:00:00.000000', 'main.dbf'],
      ],
    },
    repairedPage: { columns: ['TS_ID', 'FILE_ID', 'PAGE_NO', 'RECORD_TIME'], rows: [['4', '0', '100', '2026-10-03 10:00:00.000000']] },
    skipCpage: { columns: ['SESS_ID', 'STMT_ID', 'N_TOTAL', 'GROUP_ID', 'FILE_ID', 'PAGE_NO'], rows: [['55', '7', '1', '4', '0', '100']] },
    gvErrorPage: { columns: [], rows: [] },
    gvRepairedPage: { columns: [], rows: [] },
  };
  const l = bl(pageData);
  ok(l.counts.distinctPages === 2, `识别 ${l.counts.distinctPages} 个不同损坏页（期望 2）`);
  const p100 = l.entries.find((e) => e.pageNo === '100');
  const p200 = l.entries.find((e) => e.pageNo === '200');
  ok(p100.status === 're-corrupted', `页 100 判为「修复后再次损坏」（实际 ${p100.status}）`);
  ok(p200.status === 'never-repaired', `页 200 判为「从未修复」（实际 ${p200.status}）`);
  ok(p100.skips.length === 1, '跳页记录挂到了对应页上');
  ok(l.reCorrupted.length === 1, '反复损坏清单含 1 项');
  ok(l.disclaimer.includes('只代表'), '假阴性免责存在');

  // 对象反查：只生成字典区间查询，绝不生成扫表语句
  const tsMap = { '4': 'MAIN' };
  const lookups = buildReverseLookups(
    [{ tsId: '4', fileId: '0', pageNo: '100' }],
    tsMap,
  );
  ok(lookups.length === 1 && lookups[0].sql !== null, '生成了反查语句');
  ok(/DBA_EXTENTS/.test(lookups[0].sql), '反查走 DBA_EXTENTS（区字典）');
  ok(/BLOCK_ID\s*<=\s*100\s+AND\s+BLOCK_ID\s*\+\s*BLOCKS\s*>\s*100/.test(lookups[0].sql), '区间匹配条件正确');
  ok(!/\bFROM\s+(?!DBA_EXTENTS)\w/i.test(lookups[0].sql), '反查语句里没有扫用户表');

  const attached = attachObjects(
    [{ page: '(4,0,100)', tsId: '4', fileId: '0', pageNo: '100' }],
    lookups,
    [{ columns: ['OWNER', 'SEGMENT_NAME', 'SEGMENT_TYPE', 'BLOCK_ID', 'BLOCKS'], rows: [['AWR1', 'T_ORDER', 'TABLE', '99', '8']] }],
  );
  ok(attached[0].object?.segmentName === 'T_ORDER', '反查结果挂到了页上');
  const noMatch = attachObjects([{ page: 'x', tsId: '4', fileId: '0', pageNo: '9' }], lookups, [{ columns: [], rows: [] }]);
  ok(/不是「这一页不属于任何对象」的结论/.test(noMatch[0].objectNote ?? ''), '未匹配时给出「不等于无对象」的措辞');

  void t;

  console.log('');
  console.log(fail === 0 ? '全部通过' : `${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------- main

try {
  if (action === 'readiness') await cmdReadiness();
  else if (action === 'list') await cmdList();
  else if (action === 'triage') await cmdTriage();
  else if (action === 'capacity') await cmdCapacity();
  else if (action === 'selftest') await cmdSelftest();
  else {
    console.log('用法：');
    console.log('  node tools/triage.mjs readiness --host <ip> --port <port> --user <u> --password <p>');
    console.log('  node tools/triage.mjs list      --host <ip> --port <port> --user <u> --password <p>');
    console.log('  node tools/triage.mjs triage    --host <ip> --port <port> --user <u> --password <p>   # 逐页定位到对象');
    console.log('  node tools/triage.mjs selftest       # 离线自检，不连库');
    process.exit(2);
  }
} catch (e) {
  console.error('\n执行失败：' + e.message);
  process.exit(1);
}
