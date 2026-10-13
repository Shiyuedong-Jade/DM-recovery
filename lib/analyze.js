/**
 * 达梦数据库可恢复能力评估 —— 判定逻辑（纯函数，可离线单测）。
 *
 * 设计原则（与 DESIGN.md 一致）：
 *   1. **每条结论都带证据**：来自哪条 SQL、算的是什么。
 *   2. **「未发现」必须与「未检查」分开**，且「未发现坏页」必须带假阴性免责——
 *      `V$ERROR_PAGE` 只记录**被访问到**的坏页，0 行只代表「还没人碰到过」。
 *   3. **不确定就说不确定**，不拿「看起来没事」当结论。
 */

const s = (v) => (v === null || v === undefined ? '' : String(v));

/**
 * 「取到了一个数」还是「根本没取到」—— **显式排除 `null` / `undefined` / 空串**。
 *
 * ⚠️ 这里包着一个 JS 陷阱，本项目已经**踩过两次**：
 * `Number(null) === 0` 且 `Number.isFinite(0) === true`，
 * 所以 `Number.isFinite(Number(v))` 这个看起来很稳的守卫，会把**「没取到」判成 0**。
 *
 * - 第一次（`lib/dsc.js` 的节点数）：把「取不到 DMDSC 节点数」当成 **0 节点**，
 *   进而落进 `n <= 1` 分支，**把 DMDSC 谎报成单实例** —— 最坏的一类错误。
 * - 第二次（`lib/index.js` 的 OS 日志裁决）：把「该节点日志里没有那条记录」
 *   （`count = null`）渲染成 **`null 个损坏页`**，直接印进了交付件 ——
 *   真机上就是这么被抓到的。守卫 `Number.isFinite(Number(o.verdict.count))` 写在那儿，
 *   却一次都没拦住。
 *
 * 所以收敛成**一个**共用函数，不再两处各写一份：0 是合法值（"0 个损坏页"必须印出来），
 * `null` 只代表"没有这个数"。
 */
export function toCount(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 容错时间解析。达梦的 RECORD_TIME 格式未核实，所以只要求「能比较」即可。 */
export function parseTimeTolerant(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const str = String(value).trim();
  if (str === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(str);
  if (m) {
    const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms);
  }
  const t = Date.parse(str);
  return Number.isNaN(t) ? null : new Date(t);
}

const fmt = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

/** 从结果集里按「列名包含片段」取值，避免硬编码列名。 */
export function pick(row, columns, ...fragments) {
  for (const f of fragments) {
    const idx = columns.findIndex((c) => s(c).toLowerCase().includes(f.toLowerCase()));
    if (idx >= 0) return row[idx];
  }
  return null;
}

function rowsOf(res) {
  if (!res || res.error) return [];
  return res.rows ?? [];
}

function colsOf(res) {
  if (!res || res.error) return [];
  return res.columns ?? [];
}

/** 一行两列的 key/value 结果 → 对象。 */
function kv(res) {
  const cols = colsOf(res);
  const out = {};
  for (const r of rowsOf(res)) {
    if (r.length >= 2) out[s(r[0])] = s(r[1]);
  }
  void cols;
  return out;
}

/** 取 COUNT 查询的标量值。 */
function scalar(res) {
  const rows = rowsOf(res);
  if (rows.length === 0 || rows[0].length === 0) return null;
  const n = Number(rows[0][0]);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- 形态

export function judgeForm(data) {
  const dscEps = rowsOf(data.dscEp);
  const dwApply = scalar(data.dwApply) ?? 0;
  const dwSend = scalar(data.dwSend) ?? 0;
  const inst = rowsOf(data.instance)[0] ?? null;
  const instCols = colsOf(data.instance);

  const hasStandby = dwApply > 0 || dwSend > 0;
  const isDsc = dscEps.length > 0;

  let form;
  if (isDsc && hasStandby) form = 'dsc+dw';
  else if (isDsc) form = 'dsc';
  else if (hasStandby) form = 'dw';
  else form = 'single';

  return {
    form,
    label: {
      single: '单实例',
      dw: '单实例 + 数据守护（主备）',
      dsc: 'DMDSC 共享存储集群',
      'dsc+dw': 'DMDSC + 数据守护',
    }[form],
    instanceName: inst ? pick(inst, instCols, 'INSTANCE_NAME') : null,
    hostName: inst ? pick(inst, instCols, 'HOST_NAME') : null,
    version: inst ? pick(inst, instCols, 'SVR_VERSION') : null,
    isDsc,
    hasStandby,
    dscNodes: dscEps.length,
    dscEps: dscEps.map((r) => {
      const c = colsOf(data.dscEp);
      return { name: pick(r, c, 'EP_NAME'), mode: pick(r, c, 'EP_MODE'), status: pick(r, c, 'EP_STATUS') };
    }),
    evidence: [
      `V$DSC_EP_INFO 返回 ${dscEps.length} 行 → ${isDsc ? 'DMDSC' : '非 DMDSC'}`,
      `V$RAPPLY_SYS ${dwApply} 行 / V$ARCH_SEND_INFO ${dwSend} 行 → ${hasStandby ? '有数据守护' : '无数据守护'}`,
    ],
  };
}

// ---------------------------------------------------------------- 处置能力

/**
 * 处置路径判定。
 * 每条路径给出 available: 'yes' | 'no' | 'limited' | 'high-risk'，并附**依据**。
 */
/**
 * 表空间状态（供 `report` 的 B8「表空间被误删」场景做证据）。
 *
 * ★ 实测口径选择（2026-10-12，单实例 `10.127.11.40`）：
 *   · `DBA_TABLESPACES.STATUS` → **自描述**：`ONLINE`
 *   · `V$TABLESPACE.STATUS$`   → 数值 `0`（**含义未核实**）
 * 所以**主口径用自描述的那个**；只有它取不到时才退回数值口径，
 * 并且**如实标注「数值含义未核实」**，不替它编语义（本项目纪律：列名/取值不猜）。
 */
export function assessTablespaceStatus(res, rawRes = null) {
  const c = colsOf(res);
  const nameI = c.findIndex((x) => /^TABLESPACE_NAME$|^NAME$/i.test(String(x)));
  const stI = c.findIndex((x) => /^STATUS$|^STATUS\$?$/i.test(String(x)));
  if (nameI >= 0 && stI >= 0 && rowsOf(res).length > 0) {
    const all = rowsOf(res).map((r) => ({ name: String(r[nameI]), status: String(r[stI] ?? '') }));
    const offline = all.filter((t) => !/^(ONLINE|NORMAL)$/i.test(t.status));
    return {
      source: 'DBA_TABLESPACES.STATUS',
      count: all.length,
      offline: offline.map((t) => `${t.name}=${t.status}`),
      label:
        offline.length === 0
          ? `全部 ONLINE（${all.length} 个表空间）`
          : `**${offline.length} 个非 ONLINE**：${offline.map((t) => `${t.name}=${t.status}`).join('、')}`,
    };
  }
  // 退回数值口径：只报原始值，**不解释**
  const rc = colsOf(rawRes);
  const rnI = rc.findIndex((x) => /^NAME$|^TABLESPACE_NAME$/i.test(String(x)));
  const rsI = rc.findIndex((x) => /^STATUS\$?$/i.test(String(x)));
  if (rnI >= 0 && rsI >= 0 && rowsOf(rawRes).length > 0) {
    const vals = [...new Set(rowsOf(rawRes).map((r) => String(r[rsI])))];
    return {
      source: 'V$TABLESPACE.STATUS$',
      count: rowsOf(rawRes).length,
      offline: [],
      label: `原始值 ${vals.join('/')}（${rowsOf(rawRes).length} 个表空间）—— ⚠️ **STATUS$ 数值含义未核实**，不据此判断`,
    };
  }
  return { source: null, count: null, offline: [], label: null };
}

export function judgeReadiness(data) {
  const form = judgeForm(data);
  const db = rowsOf(data.database)[0] ?? null;
  const dbCols = colsOf(data.database);
  const archMode = db ? s(pick(db, dbCols, 'ARCH_MODE')) : '';
  const archived = archMode !== '' && archMode.toUpperCase() !== 'N';

  const params = kv(data.params);
  const policy = params['PAGE_CHECK_POLICY'] ?? null;
  const ptxRollback = params['PTX_ROLLBACK'] ?? null;
  const pageSize = scalar(data.pageSize);

  const fnCount = scalar(data.repairFn);
  const archRows = rowsOf(data.arch);

  const paths = [];

  // ---- 路径一：在线页修复（借对端）----
  if (form.isDsc && !form.hasStandby) {
    paths.push({
      id: 'online-repair',
      name: '在线页修复（借对端页覆盖）',
      available: 'no',
      reason:
        'DMDSC 多个 EP 对等访问**同一份**数据文件，共享存储只有一份数据——**借不到干净的对端页**。' +
        '这不是参数限制，是物理限制。',
      evidence: [`形态=${form.label}，V$RAPPLY_SYS/V$ARCH_SEND_INFO 均 0 行`],
    });
  } else if (form.hasStandby) {
    const validStandby = archRows.filter((r) => {
      const c = colsOf(data.arch);
      const v = s(pick(r, c, 'IS_VALID')).toUpperCase();
      return v === 'Y' || v === '1' || v === 'TRUE';
    });
    paths.push({
      id: 'online-repair',
      name: '在线页修复（借对端页覆盖）',
      available: validStandby.length > 0 ? 'yes' : 'limited',
      reason:
        validStandby.length > 0
          ? `检出 ${validStandby.length} 条归档有效记录，具备主备互修前提。仍需备库为实时/即时/同步备库（异步备库无 valid 归档状态，不支持）。`
          : '有数据守护，但未检出「归档有效」的记录——在线修复前提不满足，需人工确认备库类型与同步状态。',
      evidence: [`V$DM_ARCH_INI 返回 ${archRows.length} 行，其中 IS_VALID 为真 ${validStandby.length} 行`],
    });
  } else {
    paths.push({
      id: 'online-repair',
      name: '在线页修复（借对端页覆盖）',
      available: 'no',
      reason: '无数据守护备库。`SF_PRIMARY_PAGE_REPAIR` 必须借备库的页，没有备库就没有这条路径。',
      evidence: [`V$RAPPLY_SYS / V$ARCH_SEND_INFO 均 0 行`],
    });
  }

  // ---- 路径二：备份还原 ----
  paths.push({
    id: 'restore',
    name: '备份还原',
    available: archived ? 'yes' : 'limited',
    reason: archived
      ? '归档已开启，理论上可做时间点恢复。实际能力仍取决于备份是否早于损坏（见备份覆盖度）。'
      : '**非归档模式（ARCH_MODE=N）**：无法做时间点恢复，**只能恢复到最近一次全备，其后数据全部丢失**。' +
        '这是本环境当前最大的短板，建议优先开启归档。',
    evidence: [`V$DATABASE.ARCH_MODE = ${fmt(archMode)}`],
  });

  // ---- 路径三：主动扫描发现坏页 ----
  paths.push({
    id: 'active-scan',
    name: '主动扫描发现坏页（全表扫描 / 校验数据文件）',
    available: policy === '1' ? 'no' : 'limited',
    reason:
      policy === '1'
        ? '**PAGE_CHECK_POLICY = 1（系统主动 HALT）**：访问到损坏页会让数据库主动宕机。' +
          '因此「扫描去发现坏页」这个动作本身就会打挂生产库——**本工具不提供，也不该提供**。'
        : `PAGE_CHECK_POLICY = ${fmt(policy)}。若为 0（忽略失败）则扫描不会 HALT，但那意味着**读脏数据不报错**，同样是危险配置。`,
    evidence: [`V$DM_INI.PAGE_CHECK_POLICY = ${fmt(policy)}`],
  });

  // ---- 路径四：跳过损坏页（高风险）----
  paths.push({
    id: 'skip-page',
    name: '跳过损坏页（让查询继续返回）',
    available: 'high-risk',
    reason:
      '达梦存在跳页记录视图 `V$SQL_SKIP_CPAGE`。若启用跳过，**它把「读报错」换成「静默返回不完整数据」**——' +
      '查询能跑通，但结果是错的，且不会报错。**本工具只记录与警示，不生成命令、不推荐。**',
    evidence: ['V$SQL_SKIP_CPAGE 视图存在（列：SESS_ID/STMT_ID/EXEC_ID/N_SEQ/INDEX_ID/N_TOTAL/SEQ_NO/GROUP_ID/FILE_ID/PAGE_NO）'],
  });

  // ---- 结论 ----
  const canRepairOnline = paths.find((p) => p.id === 'online-repair').available === 'yes';
  const verdictParts = [];
  if (canRepairOnline) verdictParts.push('具备在线页修复前提');
  else verdictParts.push('**不具备在线页修复条件**');
  if (archived) verdictParts.push('归档已开，可考虑时间点恢复');
  else verdictParts.push('**非归档：坏页发生时只能恢复到最近一次全备，中间数据全丢**');

  return {
    form,
    archived,
    archMode,
    policy,
    ptxRollback,
    pageSize,
    repairFnObjectCount: fnCount,
    paths,
    verdict: verdictParts.join('；'),
    warnings: [
      ...(policy === '1'
        ? ['⚠️ `PAGE_CHECK_POLICY=1`：库上存在坏页时，**任何读到该页的操作都会导致数据库主动 HALT**。本工具因此不做任何主动扫描。']
        : []),
      ...(!archived
        ? ['⚠️ 非归档模式：**没有时间点恢复能力**。建议优先开启归档——这比任何一个检测功能都更救命。']
        : []),
      ...(fnCount === 0
        ? [
            'ℹ️ `SF_PRIMARY_/STANDBY_PAGE_REPAIR` 在 `DBA_OBJECTS` 中查不到。' +
              '注意：`SF_GET_PAGE_SIZE()` 可用说明 `SF_` 内置函数**不一定注册为对象**，' +
              '所以这**不能**推出「函数不存在」。但对本环境而言，无备库已足以判定该路径不可用。',
          ]
        : []),
    ],
  };
}

// ---------------------------------------------------------------- 对象反查

/**
 * 生成对象反查语句。
 *
 * 唯一安全的做法是查**区（extent）字典**：`DBA_EXTENTS` 的
 * `FILE_ID / BLOCK_ID / BLOCKS` 能做 `(表空间, 文件, 页号) → 段` 的区间匹配。
 *
 * **绝不能用「对每张表扫 PHYROWID 去匹配」**——那等于全表扫描，会去读数据页；
 * 而本类环境 `PAGE_CHECK_POLICY=1`，读到坏页即 HALT。那样工具自己就成了风险源。
 */
export function buildReverseLookups(pages, tsMap) {
  return pages.map((p) => {
    const tsName = tsMap[String(p.tsId)];
    if (!tsName) return { page: p, sql: null, reason: `表空间 ID ${p.tsId} 未在 V$TABLESPACE 中找到` };
    const esc = String(tsName).replace(/'/g, "''");
    const fileId = Number(p.fileId ?? 0);
    const pageNo = Number(p.pageNo ?? 0);
    return {
      page: p,
      sql:
        `SELECT OWNER, SEGMENT_NAME, SEGMENT_TYPE, PARTITION_NAME, FILE_ID, BLOCK_ID, BLOCKS, BYTES ` +
        `FROM DBA_EXTENTS WHERE TABLESPACE_NAME = '${esc}' AND FILE_ID = ${fileId} ` +
        `AND BLOCK_ID <= ${pageNo} AND BLOCK_ID + BLOCKS > ${pageNo}`,
    };
  });
}

/** 把反查结果挂回页对象上。 */
export function attachObjects(pages, lookups, results) {
  return pages.map((p, i) => {
    const lk = lookups[i];
    const res = results?.[i];
    if (!lk?.sql) return { ...p, object: null, objectNote: lk?.reason ?? '未生成反查语句' };
    if (res?.error) return { ...p, object: null, objectNote: `反查失败：${String(res.error).split('\n')[0]}` };
    const cols = res.columns ?? [];
    const rows = res.rows ?? [];
    if (rows.length === 0) {
      return {
        ...p,
        object: null,
        objectNote:
          '未在 DBA_EXTENTS 中匹配到区间。可能是空闲页、段头/位图页，或该视图未覆盖此类段——' +
          '**不是「这一页不属于任何对象」的结论**。' +
          // ★ DESIGN §43：真机上查出来的一条**未验证前提**，必须写在这里。
          //   `DBA_EXTENTS.FILE_ID` 与 `V$ERROR_PAGE.FILE_ID` 是否同一套号，本插件**没验过**
          //   （活着的库里 `V$ERROR_PAGE` 是空的，没有真值可对）；而实测这个库里同时存在
          //   三套不一致的"文件号"列（DBA_EXTENTS.FILE_ID=0、DBA_DATA_FILES.RELATIVE_FNO=1、
          //   V$DATAFILE.GROUP_ID=0/4/5）。若两边口径不同，这里就会**静默全部落空** ——
          //   读的人有权知道这个可能，否则会把"没定位到"读成"这页不属于任何对象"。
          '也可能两边「文件号」口径不同（`DBA_EXTENTS.FILE_ID` 与 `V$ERROR_PAGE.FILE_ID` 是否同一套号，' +
          '**本插件尚未在真机上验证**）——这一条会表现为**每一条坏页都定位不到**，而不是个别定位不到。',
      };
    }
    return {
      ...p,
      object: {
        owner: pick(rows[0], cols, 'OWNER'),
        segmentName: pick(rows[0], cols, 'SEGMENT_NAME'),
        segmentType: pick(rows[0], cols, 'SEGMENT_TYPE'),
        partition: pick(rows[0], cols, 'PARTITION_NAME'),
        blockId: pick(rows[0], cols, 'BLOCK_ID'),
        blocks: pick(rows[0], cols, 'BLOCKS'),
        bytes: pick(rows[0], cols, 'BYTES'),
        matchCount: rows.length,
      },
      objectNote: rows.length > 1 ? `匹配到 ${rows.length} 个区间（可能存在重叠，取第一个）` : null,
    };
  });
}

/** TS_ID → 表空间名。 */
export function tablespaceMap(res) {
  const cols = colsOf(res);
  const m = {};
  for (const r of rowsOf(res)) {
    m[String(pick(r, cols, 'ID'))] = pick(r, cols, 'NAME');
  }
  return m;
}

// ---------------------------------------------------------------- 坏页清单

/**
 * 坏页清单：按 (TS_ID, FILE_ID, PAGE_NO) 聚合，用**时间**判断是否需再次修复。
 *
 * 达梦文档提醒：可能存在数据页被修复后再次损坏的情况，因此对比两个视图时必须
 * 带上时间判断，不能只做简单差集。
 */
export function buildPageList(data) {
  const errCols = colsOf(data.errorPage);
  const repCols = colsOf(data.repairedPage);
  const skipCols = colsOf(data.skipCpage);

  const map = new Map();
  const keyOf = (c, r) => `${s(pick(r, c, 'TS_ID', 'GROUP_ID'))}|${s(pick(r, c, 'FILE_ID'))}|${s(pick(r, c, 'PAGE_NO'))}`;

  for (const r of rowsOf(data.errorPage)) {
    const k = keyOf(errCols, r);
    const e = map.get(k) ?? { key: k, errors: [], repairs: [], skips: [], sample: r, errCols };
    e.errors.push({
      time: parseTimeTolerant(pick(r, errCols, 'RECORD_TIME')),
      rawTime: pick(r, errCols, 'RECORD_TIME'),
      errcode: pick(r, errCols, 'ERRCODE'),
      fileName: pick(r, errCols, 'FILE_NAME'),
      lineNo: pick(r, errCols, 'LINE_NO'),
      tsId: pick(r, errCols, 'TS_ID'),
      fileId: pick(r, errCols, 'FILE_ID'),
      pageNo: pick(r, errCols, 'PAGE_NO'),
    });
    map.set(k, e);
  }

  for (const r of rowsOf(data.repairedPage)) {
    const k = keyOf(repCols, r);
    const e = map.get(k) ?? { key: k, errors: [], repairs: [], skips: [], sample: null, errCols: [] };
    if (e.fileName === undefined) {
      e.tsId = pick(r, repCols, 'TS_ID');
      e.fileId = pick(r, repCols, 'FILE_ID');
      e.pageNo = pick(r, repCols, 'PAGE_NO');
    }
    e.repairs.push({ time: parseTimeTolerant(pick(r, repCols, 'RECORD_TIME')), rawTime: pick(r, repCols, 'RECORD_TIME') });
    map.set(k, e);
  }

  for (const r of rowsOf(data.skipCpage)) {
    const k = keyOf(skipCols, r);
    const e = map.get(k) ?? { key: k, errors: [], repairs: [], skips: [], sample: null, errCols: [] };
    e.skips.push({
      sessId: pick(r, skipCols, 'SESS_ID'),
      stmtId: pick(r, skipCols, 'STMT_ID'),
      execId: pick(r, skipCols, 'EXEC_ID'),
      nTotal: pick(r, skipCols, 'N_TOTAL'),
      seqNo: pick(r, skipCols, 'SEQ_NO'),
      indexId: pick(r, skipCols, 'INDEX_ID'),
    });
    map.set(k, e);
  }

  const maxTime = (list) => {
    const ts = list.map((x) => x.time).filter(Boolean);
    return ts.length ? new Date(Math.max(...ts.map((d) => +d))) : null;
  };

  const entries = [...map.values()].map((e) => {
    const lastError = maxTime(e.errors);
    const lastRepair = maxTime(e.repairs);
    let status;
    if (e.errors.length === 0 && e.repairs.length > 0) status = 'repaired-only';
    else if (!lastRepair) status = 'never-repaired';
    else if (lastError && lastError > lastRepair) status = 're-corrupted';
    else status = 'repaired';

    const first = e.errors[0] ?? {};
    const tsId = first.tsId ?? e.tsId ?? null;
    const fileId = first.fileId ?? e.fileId ?? null;
    const pageNo = first.pageNo ?? e.pageNo ?? null;

    return {
      tsId,
      fileId,
      pageNo,
      page: `(${fmt(tsId)}, ${fmt(fileId)}, ${fmt(pageNo)})`,
      fileName: first.fileName ?? null,
      lastError,
      lastRepair,
      errorCount: e.errors.length,
      repairCount: e.repairs.length,
      errcodes: [...new Set(e.errors.map((x) => s(x.errcode)).filter((x) => x !== ''))],
      lineNos: [...new Set(e.errors.map((x) => s(x.lineNo)).filter((x) => x !== ''))],
      skips: e.skips,
      status,
      statusText: {
        'never-repaired': '从未修复',
        're-corrupted': '⚠️ 修复后再次损坏',
        repaired: '已修复',
        'repaired-only': '仅见于修复记录',
      }[status],
    };
  });

  entries.sort((a, b) => {
    const rank = { 're-corrupted': 0, 'never-repaired': 1, repaired: 2, 'repaired-only': 3 };
    return rank[a.status] - rank[b.status];
  });

  const needAttention = entries.filter((e) => e.status === 'never-repaired' || e.status === 're-corrupted');
  const reCorrupted = entries.filter((e) => e.status === 're-corrupted');

  // 按文件聚合：同一文件反复出问题 → 存储问题信号
  const byFile = new Map();
  for (const e of entries) {
    const k = `${fmt(e.tsId)}|${fmt(e.fileId)}`;
    byFile.set(k, (byFile.get(k) ?? 0) + Math.max(e.errorCount, 1));
  }
  const hotFiles = [...byFile.entries()]
    .map(([k, n]) => ({ key: k, count: n }))
    .filter((x) => x.count > 1)
    .sort((a, b) => b.count - a.count);

  return {
    entries,
    needAttention,
    reCorrupted,
    hotFiles,
    counts: {
      errorRows: rowsOf(data.errorPage).length,
      repairedRows: rowsOf(data.repairedPage).length,
      distinctPages: entries.length,
      gvErrorRows: rowsOf(data.gvErrorPage).length,
      gvRepairedRows: rowsOf(data.gvRepairedPage).length,
      skipRows: rowsOf(data.skipCpage).length,
    },
    // ★ 假阴性免责：这句必须出现在任何「未发现坏页」的结论旁边
    disclaimer:
      '`V$ERROR_PAGE` 只记录**被访问到**的损坏页。本结果为空，**只代表「还没有人碰到过」**，' +
      '不代表库中没有坏页。主动扫描在本工具的适用环境中是禁止动作（读到坏页可能导致 HALT）——' +
      '所以「未发现坏页」**永远不等于「没有坏页」**。',
  };
}
