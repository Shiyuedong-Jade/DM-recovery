/**
 * 达梦数据库可恢复能力评估 —— 查询定义。
 *
 * ⚠️ 所有对象名与列名都经过真机核实（见 DESIGN.md §10、§14）。跨版本可能变化的地方
 *    保留 fallback，但**只保留有依据的**：
 *      · 实测差异 —— 如 `V$DATAFILE.TABLESPACE_NAME` 不存在，要用 `GROUP_ID` 关联；
 *      · 凭文档猜的备选语句**一律删除** —— 曾有的 `V$DM_ARCH_INI` 短列名备选已删，
 *        因为链尾的 `SELECT *` 本就能覆盖任何列名形态，猜的语句只增加风险不增加能力。
 *
 * 每条查询：
 *   key       结果里引用它的名字
 *   sql       首选语句
 *   fallbacks 备选语句（首选报「无效的列名/表名」时依次重试）
 *   optional  true 表示失败不致命（例如单实例上查 GV$ 视图）
 */

/** 形态识别：决定后续所有分支。 */
export const FORM_QUERIES = [
  { key: 'instance', sql: `SELECT INSTANCE_NAME, HOST_NAME, STATUS$, MODE$, SVR_VERSION FROM V$INSTANCE` },
  { key: 'database', sql: `SELECT NAME, DSC_NODES, ARCH_MODE, ROLE$, STATUS$ FROM V$DATABASE` },
  { key: 'dwApply', sql: `SELECT COUNT(*) AS CNT FROM V$RAPPLY_SYS` },
  { key: 'dwSend', sql: `SELECT COUNT(*) AS CNT FROM V$ARCH_SEND_INFO` },
  { key: 'dscEp', sql: `SELECT EP_NAME, EP_MODE, EP_STATUS FROM V$DSC_EP_INFO`, optional: true },
];

/** 处置能力体检。 */
export const READINESS_QUERIES = [
  {
    key: 'params',
    sql:
      `SELECT PARA_NAME, PARA_VALUE FROM V$DM_INI WHERE PARA_NAME IN ` +
      `('PTX_ROLLBACK','PAGE_CHECK_POLICY','PAGE_CHECK','FIL_CHECK_MODE','FIL_CHECK_INTERVAL','GLOBAL_PAGE_SIZE')`,
  },
  { key: 'pageSize', sql: `SELECT SF_GET_PAGE_SIZE() AS PAGE_SIZE FROM DUAL` },
  {
    key: 'arch',
    sql: `SELECT ARCH_NAME, ARCH_TYPE, ARCH_DEST, ARCH_IS_VALID, ARCH_WAIT_APPLY FROM V$DM_ARCH_INI`,
    // 原先这里还有一条「短列名」备选（`TYPE/DEST/IS_VALID/WAIT_APPLY`），已删除。
    // 理由：**它严格无用**。三个独立来源（DMDSC、单实例、以及 `desc V$DM_ARCH_INI` 的
    // 30 列清单）全部确认是 `ARCH_` 前缀长名；而即便某版本真用短名，
    // 链尾的 `SELECT *` 一样能取到数据（分析层是按列名取数的）。
    // 留着它只会多一条「猜出来的」语句，不增加任何能力。
    fallbacks: [`SELECT * FROM V$DM_ARCH_INI`],
    optional: true,
  },
  {
    key: 'repairFn',
    sql:
      `SELECT COUNT(*) AS CNT FROM DBA_OBJECTS ` +
      `WHERE OBJECT_NAME IN ('SF_PRIMARY_PAGE_REPAIR','SF_STANDBY_PAGE_REPAIR')`,
    optional: true,
  },
  {
    key: 'standby',
    sql: `SELECT * FROM V$ARCH_SEND_INFO`,
    optional: true,
  },
];

/** 坏页清单。 */
export const LIST_QUERIES = [
  { key: 'errorPage', sql: `SELECT * FROM V$ERROR_PAGE` },
  { key: 'repairedPage', sql: `SELECT * FROM V$REPAIRED_PAGE` },
  // DMDSC 上 V$ 只反映当前节点，GV$ 才是全集群——两边都取，分析时区分来源。
  { key: 'gvErrorPage', sql: `SELECT * FROM GV$ERROR_PAGE`, optional: true },
  { key: 'gvRepairedPage', sql: `SELECT * FROM GV$REPAIRED_PAGE`, optional: true },
  { key: 'skipCpage', sql: `SELECT * FROM V$SQL_SKIP_CPAGE`, optional: true },
];

/** 对象反查（拿到坏页三元组后再生成，见 buildReverseLookupSql）。 */
export function buildReverseLookupSql(page, tsName) {
  const ts = String(tsName).replace(/'/g, "''");
  const fileId = Number(page.FILE_ID ?? 0);
  const pageNo = Number(page.PAGE_NO ?? 0);
  return (
    `SELECT OWNER, SEGMENT_NAME, SEGMENT_TYPE, PARTITION_NAME, TABLESPACE_NAME, FILE_ID, BLOCK_ID, BLOCKS, BYTES ` +
    `FROM DBA_EXTENTS WHERE TABLESPACE_NAME = '${ts}' AND FILE_ID = ${fileId} ` +
    `AND BLOCK_ID <= ${pageNo} AND BLOCK_ID + BLOCKS > ${pageNo}`
  );
}

/** 表空间 ID ↔ 名称映射（坏页只给 TS_ID，反查要名称）。 */
export const TABLESPACE_QUERY = {
  key: 'tablespaces',
  sql: `SELECT ID, NAME FROM V$TABLESPACE`,
};

/**
 * 归档容量相关的查询。
 *
 * 注意 `ARCH_SPACE_LIMIT` **故意不在 dm.ini 的参数查询里**——它不是 dm.ini 参数，
 * 而是 dmarch.ini 的每个归档目标级配置，只能从 `V$DM_ARCH_INI` 观察。
 */
export const ARCHIVE_QUERIES = [
  {
    key: 'archParams',
    sql:
      `SELECT PARA_NAME, PARA_VALUE, FILE_VALUE, MIN_VALUE, MAX_VALUE, DEFAULT_VALUE, DESCRIPTION FROM V$DM_INI ` +
      `WHERE PARA_NAME IN ('ARCH_INI','ARCH_SPACE_CHECK_INTERVAL','ARCH_SPACE_FREE_THRESHOLD')`,
  },
  {
    key: 'archTargets',
    sql:
      `SELECT ARCH_NAME, ARCH_TYPE, ARCH_DEST, ARCH_IS_VALID, ARCH_FILE_SIZE, ARCH_SPACE_LIMIT, ` +
      `ARCH_DEST_IP, ARCH_DEST_PORT, ARCH_HANG_FLAG, ARCH_RESERVE_TIME ` +
      `FROM V$DM_ARCH_INI`,
    // 后四列来自实测 `desc V$DM_ARCH_INI`（30 列，全部 ARCH_ 前缀）；
    // 若某版本没有它们，退回到此前已验证可用的 6 列形态，再退回 `SELECT *`。
    fallbacks: [
      `SELECT ARCH_NAME, ARCH_TYPE, ARCH_DEST, ARCH_IS_VALID, ARCH_FILE_SIZE, ARCH_SPACE_LIMIT FROM V$DM_ARCH_INI`,
      `SELECT * FROM V$DM_ARCH_INI`,
    ],
    optional: true,
  },
  {
    key: 'archFiles',
    /**
     * ★ `CLOSE_TIME`（DESIGN §35）：真机 `desc V$ARCH_FILE` 实测有这一列，
     *   与 `CLSN` 配对成**每个归档文件的第二个时间锚点**（文件关闭那一刻 ↔ 该文件最后一个 LSN）。
     *   手册没强调它，但它是白拿的精度：归档锚点数直接翻倍，时间↔LSN 的夹逼区间随之收窄。
     *
     * ⚠️ 老版本可能没有这一列 —— 所以带 fallback 退回原来的 7 列形态；
     *    `assessTimeLsnAnchors` 里对取不到的 `CLOSE_TIME` 是**跳过**而不是补 0（不猜）。
     */
    sql: `SELECT PATH, STATUS, LEN, ARCH_LSN, CLSN, NEXT_SEQ, CREATE_TIME, CLOSE_TIME FROM V$ARCH_FILE`,
    fallbacks: [`SELECT PATH, STATUS, LEN, ARCH_LSN, CLSN, NEXT_SEQ, CREATE_TIME FROM V$ARCH_FILE`],
    optional: true,
  },
  {
    key: 'rlog',
    sql: `SELECT CUR_LSN, FILE_LSN, CKPT_LSN, NEXT_SEQ, FREE_SPACE, TOTAL_SPACE FROM V$RLOG`,
    optional: true,
  },
  {
    key: 'asm',
    sql: `SELECT GROUP_ID, GROUP_NAME, TOTAL_MB, FREE_MB FROM V$ASMGROUP ORDER BY GROUP_ID`,
    optional: true,
  },
];

/** 全部语句拼成一个 .sql 文件内容（桥按分号切分）。 */
export function toSqlFile(queries) {
  const lines = [];
  for (const q of queries) {
    lines.push(`-- key: ${q.key}`);
    lines.push(`${q.sql};`);
  }
  return lines.join('\n') + '\n';
}

/**
 * 带 fallback 的执行：先跑首选，报「无效的列名/表名」时依次重试备选。
 * 返回 { [key]: { columns, rows, error, sqlUsed } }
 */
export async function runWithFallback(run, queries) {
  const out = {};
  for (const q of queries) {
    const candidates = [q.sql, ...(q.fallbacks ?? [])];
    let last = null;
    let done = null;
    for (const sql of candidates) {
      const r = await run(sql);
      last = r;
      if (!r.error) {
        done = { ...r, sqlUsed: sql };
        break;
      }
      // 只有「名字不对」才值得换一条；其它错误（权限、连接）换语句也没用
      if (!/无效的列名|无效的表或视图名|无效的表名|invalid column|invalid identifier/i.test(r.error)) break;
    }
    if (done === null) {
      out[q.key] = { columns: last?.columns ?? null, rows: [], error: last?.error ?? 'UNKNOWN', sqlUsed: last?.sql ?? null };
    } else {
      out[q.key] = done;
    }
  }
  return out;
}
