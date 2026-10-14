/**
 * 达梦备份可用性 —— 「有哪些备份 / 能恢复到哪一点 / 备份本身可不可信」。
 *
 * 三条硬边界（都源于实测，不是设计偏好）：
 *
 * 1. 本模块自己**只通过 JDBC 读库**（见 bridge.js：只 spawn java），
 *    所以它读不到服务器上的 `dm_BAKRES_*.log`，也跑不了 `dmrman`。
 *    这两件事要么输出「请运维执行 X」的确定命令（**默认路径**），
 *    要么由 `ossh.js` 那层**可选的** OS 访问去做（`CHECK BACKUPSET` / 日志扫描 / `find`，
 *    三条全是只读命令）—— 但**判定的依据永远来自实测值，绝不假装查到了**。
 *    （原文断言「插件够不到主机」，DESIGN §20.2 第 3 项已改正：那只是**默认**不启用。）
 *
 * 2. 不做任何乘数/经验值假设。每个数字要么来自实测（LSN、时间、字节），
 *    要么来自调用方显式输入。
 *
 * 3. `V$BACKUPSET` 是**库自己的账本**，只能证明「库认为这个备份集存在」，
 *    **不能证明备份文件可读、完好**。真正的校验只有 `dmrman CHECK BACKUPSET`。
 *    实测已确认：库里**没有**任何备份集校验入口（`%BACKUPSET%` / `SF_*BAK*` /
 *    `%CHECK_BAK%` 在 DBA_OBJECTS 里全为 0 行），校验只能靠外部工具。
 *
 * 实测依据（DESIGN.md §11）：一次真实的 `backup database;` 在
 * `dm_BAKRES_202610.log` 里留下的结构化痕迹 ——
 *   [CMD] database ... backup database;                      ← 用户原样语句
 *   [CMD] database ... BACKUP DATABASE [dameng]
 *   searching in these directories: [+DMDATA/data/dameng/bak/DB_dameng_FULL_...]
 *   send CMD [BACKUP_DBF] for DBF [+DMDATA/data/dameng/system.dbf]
 *   END_LSN:42251246
 *   **0 corrupted pages during backup**                      ← 全库逐页裁决
 *   [CMD] ... CMD END.CODE:[0], COST:[00:00:31]
 * 并且这些行的线程号是 **非零** 的 `TID0117906217`，
 * 而例行的 `COLLECT BACKUPSET FROM DISK` / `RESTORE_METAS` 全是 `TID0000000000`。
 * 这就是把「用户操作」和「系统内部例行」分开的可靠依据 —— 不要用子串匹配。
 */

/** V$BACKUPSET 的实际列名由 JDBC 元数据给出（34 列，实测无 BAK_SAFE_CHECK）。 */
export const BACKUP_QUERIES = [
  { key: 'backupset', sql: `SELECT * FROM V$BACKUPSET`, optional: true },
  { key: 'backupRlog', sql: `SELECT CUR_LSN, FILE_LSN, CKPT_LSN, NEXT_SEQ FROM V$RLOG`, optional: true },
  // 数据库**自己的**时钟：做「时间 ↔ LSN」夹逼时当前前沿那一帧必须用它的时间，
  // 不能用插件所在机器的时钟（两台机器可能有时差，差多少都不知道）。
  { key: 'backupDbTime', sql: `SELECT SYSDATE AS NOW FROM DUAL`, optional: true },
  /**
   * ★ 真机实测（2026-10-12，单实例 10.127.11.40）：**这个视图存在，而且正是「时间 ↔ LSN」要的东西**。
   *
   * `V$RLOG_HISTORY` = `(RECORD_TIME, CUR_LSN, …)` 的**时间序列**，实测约**每分钟一行**：
   *   RECORD_TIME=2026-10-12 10:20:09.339835  CUR_LSN=132129504
   *   RECORD_TIME=2026-10-12 10:21:09.337835  CUR_LSN=132129532   ← 一分钟推进 28 个 LSN
   *
   * 对比之下：归档文件那个锚点源在本库横跨 **41 小时**（低负载库，一个文件写很久才切）。
   * 所以有了它，时间↔LSN 从「夹逼成 96k 宽的区间」变成**近似精确对应**。
   * 存在性**只在本环境实测过**，故标 `optional` —— 取不到就退回归档/备份/当前前沿三个源。
   */
  { key: 'backupRlogHistory', sql: `SELECT RECORD_TIME, CUR_LSN FROM V$RLOG_HISTORY`, optional: true },
  /**
   * ★ 真机实测（2026-10-12，DMDSC `10.127.11.61:7236`）：`V$FLASHBACK_TRX_INFO` 有
   * **`(COMMIT_TIMESTAMP, COMMIT_LSN)`** —— 那是**每个已提交事务**一对「时刻 ↔ LSN」，
   * 比归档文件锚点密得多，而且**是纯 SELECT**（在既不调包、也不开 logmnr 会话的前提下拿到）。
   *
   * ⚠️ 两个必须说清的边界：
   *   ① **只在开了闪回时才有行** —— 本库 `ENABLE_FLASHBACK=0`，实测 **0 行**；
   *      所以它是**机会性**锚点源：有就用，没有就什么都不发生（不许当成"没有对应关系"）。
   *   ② `COMMIT_LSN` 可能为空（未提交/回滚段已回收），故查询里滤掉 —— 拿不到就不硬凑。
   *   `ROWNUM` 上限是**防呆**（繁忙库这张表可能很长）；真被截断时结论里会说明。
   */
  {
    key: 'flashbackTrx',
    sql: `SELECT * FROM (SELECT COMMIT_TIMESTAMP, COMMIT_LSN FROM V$FLASHBACK_TRX_INFO WHERE COMMIT_LSN IS NOT NULL ORDER BY COMMIT_LSN DESC) WHERE ROWNUM <= 1000`,
    optional: true,
  },
];

/** 闪回事务锚点的取数上限（超过它就会在结论里注明"被截断"，而不是假装取全了）。 */
export const FLASHBACK_TRX_CAP = 1000;

/** 实测：`backup database;`（非增量）→ 名称含 FULL、TYPE=0、LEVEL=0、CUMULATIVE=0。
 *  其它取值未验证，一律按原始数字展示，**不编语义**。 */
const TYPE_FULL = 0;

const cols = (res) => res?.columns ?? [];
const rows = (res) => res?.rows ?? [];

function field(row, columns, ...frags) {
  for (const f of frags) {
    const i = columns.findIndex((c) => new RegExp(f, 'i').test(String(c)));
    if (i >= 0) return row[i];
  }
  return null;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function toMs(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v.replace(' ', 'T'));
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * 时间戳格式化。
 *
 * **故意不做 Date 往返转换**：`V$BACKUPSET.BACKUP_TIME` 经 JDBC 回来是字符串
 * （如 `2026-10-10 15:03:21.084961`）。若先 `new Date()` 再 `toISOString()`，
 * 会被按本地时区解释后又转成 UTC，把 15:03 显示成 07:03 —— 时区偏移看起来像备份时间错了。
 * 所以字符串形态直接截取前 19 个字符，原样输出。
 */
const TS_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/;

/**
 * 分钟数 → 人读的时长文本（**全插件唯一一份** —— 原来 `requirements.js` 也用它，
 * 那个模块已随「恢复需求达成度」整项移除，本函数现在只服务归档/锚点相关的渲染）。
 *
 * 为什么需要：锚点间距在真机上是**秒级**（DMDSC 上两个归档文件相隔 2 秒），
 * 一律写成 `0.0 分钟` 等于把有用的信息抹掉。
 */
export function fmtMinutes(min) {
  if (min === null || min === undefined || !Number.isFinite(min)) return '—';
  if (Math.abs(min) < 1) return `${(min * 60).toFixed(0)} 秒`;
  if (Math.abs(min) < 120) return `${min.toFixed(1)} 分钟`;
  return `${(min / 60).toFixed(1)} 小时`;
}

/**
 * 时刻（毫秒）→ `YYYY-MM-DD HH:MM:SS`（**本机时区**）。
 *
 * ⚠️ 这里**不能用 `toISOString()`**：它按本地时区解释再转 UTC，在 UTC+8 的机器上
 * 会把 10:50 显示成 02:50（本项目 §11.9 / §23 已记过同一类缺陷）。
 * 用一个函数收口，任何需要 ms → 文本的地方都走它。
 */
export function fmtMs(ms) {
  const n = toMs(ms);
  if (n === null) return '—';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtStamp(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string') {
    const m = TS_RE.exec(v);
    return m ? `${m[1]} ${m[2]}` : '—';
  }
  // Date / 毫秒：走 `fmtMs` 的本地格式化，**不走 `toISOString()`**（时区会偏）
  return fmtMs(v);
}

/** 取单行结果里的一个标量（如 V$RLOG.CUR_LSN）。 */
export function scalarOf(res, frag) {
  const c = cols(res);
  const r = rows(res)[0];
  if (!r) return null;
  const v = field(r, c, frag);
  const n = num(v);
  return n !== null ? n : v;
}

/** 行数组 → 大写列名为键的对象数组（坏页记录要按 RECORD_TIME 参与时间比较）。 */
export function rowsAsObjects(res) {
  const c = cols(res);
  return rows(res).map((r) => Object.fromEntries(c.map((k, i) => [String(k).toUpperCase(), r[i]])));
}

/** 把 V$BACKUPSET 结果规范化并**按时间倒序**（[0] 即最近一次）。 */
export function parseBackupSets(res) {
  const c = cols(res);
  const out = [];
  for (const r of rows(res)) {
    const type = num(field(r, c, '^TYPE$'));
    const level = num(field(r, c, '^LEVEL$'));
    const name = String(field(r, c, '^BACKUP_NAME$') ?? '');
    out.push({
      id: num(field(r, c, '^BACKUP_ID$')),
      name,
      path: String(field(r, c, '^BACKUP_PATH$') ?? ''),
      type,
      level,
      cumulative: num(field(r, c, '^CUMULATIVE$')),
      time: field(r, c, '^BACKUP_TIME$'),
      beginLsn: num(field(r, c, '^BEGIN_LSN$')),
      endLsn: num(field(r, c, '^END_LSN$')),
      device: String(field(r, c, '^DEVICE_TYPE$') ?? ''),
      withoutLog: num(field(r, c, '^WITHOUT_LOG$')),
      dbfNum: num(field(r, c, '^DBF_NUM$')),
      bkpNum: num(field(r, c, '^BKP_NUM$')),
      pkgSize: num(field(r, c, '^PKG_SIZE$')),
      version: String(field(r, c, '^VERSION$') ?? ''),
      objectName: String(field(r, c, '^OBJECT_NAME$') ?? ''),
      /** 名称里的类型词只是**旁证**，不作判定依据。 */
      nameHint: /_FULL_/i.test(name) ? 'FULL' : /_(INCR|DIFF)_/i.test(name) ? 'INCR/DIFF' : null,
      isFull: type === TYPE_FULL && level === 0,
    });
  }
  out.sort((a, b) => (toMs(b.time) ?? 0) - (toMs(a.time) ?? 0));
  return out;
}

/**
 * 归档日志覆盖范围。
 * **故意不用 `V$ARCH_FILE.FREE`**：实测它在归档推进过程中是**增大**的，
 * 语义未验证，拿它当「剩余空间/进度」会得到反向结论。
 */
export function archiveSpan(archRes) {
  const c = cols(archRes);
  const lsns = [];
  const clsns = [];
  let n = 0;
  for (const r of rows(archRes)) {
    n += 1;
    const a = num(field(r, c, '^ARCH_LSN$'));
    const cl = num(field(r, c, '^CLSN$'));
    if (a !== null && a > 0) lsns.push(a);
    if (cl !== null && cl > 0) clsns.push(cl);
  }
  return {
    count: n,
    oldestArchLsn: lsns.length ? Math.min(...lsns) : null,
    latestClsn: clsns.length ? Math.max(...clsns) : null,
  };
}

/** 区间合并（用于「多个归档序列的并集覆盖到哪」）。输入 [{from,to}]，输出按起点排序的不相交区间。 */
function mergeIntervals(list) {
  const iv = list
    .filter((x) => Number.isFinite(x.from) && Number.isFinite(x.to) && x.to >= x.from)
    .sort((a, b) => a.from - b.from);
  const out = [];
  for (const cur of iv) {
    const last = out[out.length - 1];
    if (last && cur.from <= last.to + 1) last.to = Math.max(last.to, cur.to);
    else out.push({ ...cur });
  }
  return out;
}

/**
 * 归档链的**逐段连续性** —— 把「最早归档早于备份起点」这个**必要条件**升级为真检查。
 *
 * 为什么必须升级：`archiveSpan()` 只取 min `ARCH_LSN` / max `CLSN` 两端 ——
 * **两端对得上、中间断了它看不出来**，而「能不能恢复到某个点」恰恰取决于中间有没有洞。
 *
 * ★ 三条来自真机夹具的硬约束（不是推理，是在真数据里看到的）：
 *
 * 1. **必须按序列分别判定，不能全局按 LSN 排序。** DMDSC 交叉配置下同一个归档目录里
 *    混着 `ARCHIVE_LOCAL1_*`（本节点）与 `ARCH_REMOTE1_*`（对端投递）两个序列：
 *    真机夹具 DSC01 的 LOCAL 序列是 `42255125 → 42255179`，中间 53 个 LSN 由 REMOTE
 *    文件（`42255130`）与对端目录占着。全局相邻会报出一处**假断档**。
 *    序列键 = `(目录, 归档目标名, 节点号)`，从 `PATH` 的文件名解析：
 *    `ARCHIVE_LOCAL1_0x5397A3BF_EP0_2026-10-10_14-29-12.log`。
 *
 * 2. **相邻判据是 `next.ARCH_LSN === prev.CLSN + 1`，不是 `NEXT_SEQ` 递增。**
 *    真机单实例：文件1 `CLSN=132032738`、文件2 `ARCH_LSN=132032739` → 连续（+1）；
 *    而同两个文件的 `NEXT_SEQ` 是 `136616 → 136641`（一个归档文件内含多个 redo 序列号），
 *    **拿 NEXT_SEQ 判档会误报**。所以本函数**根本不读** `NEXT_SEQ`。
 *
 * 3. **判定要用「所有序列的区间并集」**：DMDSC 上某个序列的洞**可能被另一个序列补上**
 *    （真机夹具正是如此）。序列内部断档照样报出来（那是单个归档目录的缺陷），
 *    但「可恢复到哪」由并集决定。
 *
 * 本函数只回答三件事，每件都有实测依据：序列内断档、并集覆盖区间（有无洞）、
 * **未归档尾部**（`CUR_LSN − 并集末端`，即还在联机日志里、尚未进归档的那段）。
 *
 * ⚠️ **不下「能否恢复到当前」这个结论**：恢复「到当前」本来就要用联机日志，
 * 归档末端落后于 `CUR_LSN` 是常态；未归档尾部影响的是「联机日志坏了 / 要异机恢复」时的缺口。
 */
export function assessArchiveChain(archRes, { curLsn = null, needFrom = null } = {}) {
  const c = cols(archRes);
  const files = [];
  for (const r of rows(archRes)) {
    const path = String(field(r, c, '^PATH$') ?? '');
    const base = path.split(/[\\/]/).pop() ?? '';
    const m = /^(.*?)_0x[0-9A-Fa-f]+(?:_EP(\d+))?_/.exec(base);
    const archLsn = num(field(r, c, '^ARCH_LSN$'));
    const clsn = num(field(r, c, '^CLSN$'));
    // 缺 LSN 的行无法参与判定 —— 跳过而不是当成 0（当成 0 会伪造出巨大的区间）
    if (archLsn === null || clsn === null) continue;
    files.push({
      path,
      dir: path.replace(/[\\/][^\\/]+$/, ''),
      target: m ? m[1] : base || '（未识别）',
      node: m && m[2] !== undefined ? `EP${m[2]}` : '—',
      status: String(field(r, c, '^STATUS$') ?? ''),
      archLsn,
      clsn,
      createTime: field(r, c, '^CREATE_TIME$'),
      createMs: toMs(field(r, c, '^CREATE_TIME$')),
    });
  }
  if (files.length === 0) {
    return {
      series: [],
      breaks: [],
      intervals: [],
      holes: [],
      continuous: null,
      coveredFrom: null,
      coveredTo: null,
      unarchivedLsn: null,
      coversNeedFrom: null,
      needFrom,
      curLsn,
      oldestCreateTime: null,
      verdict: 'unknown',
      note: 'V$ARCH_FILE 没有可用行（或缺少 ARCH_LSN / CLSN 列）—— 归档链连续性**未判定**，不猜',
    };
  }

  const keyOf = (f) => `${f.dir}|${f.target}|${f.node}`;
  const series = [...new Set(files.map(keyOf))].map((k) => {
    const fs = files.filter((f) => keyOf(f) === k).sort((a, b) => a.archLsn - b.archLsn);
    const breaks = [];
    for (let i = 1; i < fs.length; i += 1) {
      const prev = fs[i - 1];
      const cur = fs[i];
      if (cur.archLsn !== prev.clsn + 1) {
        breaks.push({
          dir: fs[0].dir,
          target: fs[0].target,
          node: fs[0].node,
          fromLsn: prev.clsn,
          toLsn: cur.archLsn,
          gap: cur.archLsn - prev.clsn - 1,
        });
      }
    }
    return {
      dir: fs[0].dir,
      target: fs[0].target,
      node: fs[0].node,
      count: fs.length,
      fromLsn: fs[0].archLsn,
      toLsn: fs[fs.length - 1].clsn,
      breaks,
      continuous: breaks.length === 0,
    };
  });

  const intervals = mergeIntervals(files.map((f) => ({ from: f.archLsn, to: f.clsn })));
  const coveredFrom = intervals.length > 0 ? intervals[0].from : null;
  const coveredTo = intervals.length > 0 ? intervals[intervals.length - 1].to : null;
  const holes = [];
  for (let i = 1; i < intervals.length; i += 1) {
    holes.push({
      fromLsn: intervals[i - 1].to,
      toLsn: intervals[i].from,
      gap: intervals[i].from - intervals[i - 1].to - 1,
    });
  }

  /**
   * 单目录自足性 —— 只保留**某一个归档目录**时还缺多少。
   *
   * ★ 这一维是 DMDSC 上真正有用的那个：真机夹具里 DSC01 的目录单独**不足以**恢复
   * （LOCAL 段 + 收到的 REMOTE 段拼起来仍有 3 处洞），DSC02 的目录同样。
   * 两者**一起**才是完整的 —— 这是交叉配置的正常形态，不是缺陷。
   * 但它直接决定运维策略：**少保留任何一个节点的归档目录，就会缺一段**。
   */
  const byDir = [...new Set(files.map((f) => f.dir))].map((dir) => {
    const inDir = files.filter((f) => f.dir === dir);
    const iv = mergeIntervals(inDir.map((f) => ({ from: f.archLsn, to: f.clsn })));
    const dHoles = [];
    for (let i = 1; i < iv.length; i += 1) {
      dHoles.push({ fromLsn: iv[i - 1].to, toLsn: iv[i].from, gap: iv[i].from - iv[i - 1].to - 1 });
    }
    return {
      dir,
      seriesCount: new Set(inDir.map((f) => `${f.target}|${f.node}`)).size,
      intervals: iv,
      holes: dHoles,
      selfSufficient: dHoles.length === 0,
      targets: [...new Set(inDir.map((f) => f.target))],
    };
  });

  // 未归档尾部：还在联机日志里、尚未进归档的那一段（LSN 单位）
  const unarchivedLsn = curLsn !== null && coveredTo !== null ? curLsn - coveredTo : null;

  // 备份起点是否落在**连续可用**的区间里：起点被覆盖，且它之后到末端没有洞。
  // （只在「起点被覆盖」时才谈得上；洞若全在起点之前，与恢复无关）
  let coversNeedFrom = null;
  if (needFrom !== null && coveredFrom !== null) {
    const host = intervals.find((iv) => iv.from <= needFrom && needFrom <= iv.to);
    coversNeedFrom = Boolean(host) && !holes.some((h) => h.fromLsn >= needFrom);
  }

  const times = files.map((f) => f.createMs).filter((x) => x !== null);
  const oldestCreateTime = times.length > 0 ? files.find((f) => f.createMs === Math.min(...times))?.createTime ?? null : null;
  const breaks = series.flatMap((s) => s.breaks);

  /**
   * ★ 序列内断档的**定性取决于环境**，不能一律说成缺陷：
   *   · **单序列**（单实例 / 单一归档目标）：序列内有洞 = **真断档**，恢复会在那里断；
   *   · **多序列**（DMDSC 交叉配置 / 多归档目标）：每节点只归档自己那段 redo，
   *     序列内有洞是**正常形态**（真机夹具里两个 LOCAL 序列各有 2 处），判定看**并集**。
   */
  const multiSeries = series.length > 1;
  const note =
    holes.length > 0
      ? `归档并集里有 ${holes.length} 处**洞**：恢复会在这里断`
      : multiSeries
        ? `${series.length} 个归档序列、${files.length} 个文件；并集覆盖 LSN ${coveredFrom}–${coveredTo} **无洞**` +
          (breaks.length > 0
            ? `（${breaks.length} 处序列内断档在**多序列环境下属正常**：各序列只含一部分 LSN 区间，判定看并集）`
            : '')
        : `${series.length} 个归档序列、${files.length} 个文件，**逐段连续**，覆盖 LSN ${coveredFrom}–${coveredTo}`;

  return {
    series,
    breaks,
    /** 单序列环境（单实例/单目标）下，序列内断档才是真断档。 */
    singleSeriesBreakIsDefect: !multiSeries,
    intervals,
    holes,
    byDir,
    continuous: holes.length === 0,
    coveredFrom,
    coveredTo,
    unarchivedLsn,
    coversNeedFrom,
    needFrom,
    curLsn,
    oldestCreateTime,
    fileCount: files.length,
    verdict: holes.length === 0 ? 'continuous' : 'gap',
    note,
  };
}


/**
 * ## 时间 ↔ LSN 锚点与**夹逼**（DESIGN §23）
 *
 * 用户问「能不能把恢复到的 LSN 与时间点对应起来」。达梦**服务端**本来就有这张映射
 * （它支持 `RECOVER DATABASE ... UNTIL TIME '<时间>'` 与 `UNTIL LSN <n>`），
 * 但**有没有暴露给 SQL** 未核实（S4 探测项）。在没有那个入口之前，能做到的是**夹逼**：
 *
 * ### 只用一条不等式，且它不需要任何假设
 *
 * 每个锚点都是一对 `(S, A)`：在**时刻 S 观测到** LSN A 已经存在。于是必然有
 * **`t(A) ≤ S`**（LSN 先被生成、后才可能被观测到；归档/备份/查询都是"之后"）。
 * 由 LSN 单调递增，就能给出**严格**结论：
 *
 * | 方向 | 严格结论 | 依据 |
 * | --- | --- | --- |
 * | 时刻 T → LSN | `L(T) > max{ A : S < T }` | 那些 A 都在 T 之前生成 ⇒ T 时刻的 LSN 必然更大 |
 * | LSN L → 时刻 | `t(L) ≤ min{ S : A ≥ L }` | `L ≤ A ⇒ t(L) ≤ t(A) ≤ S` |
 *
 * ### 另一半（上界 / 下界）**依赖一个前提，所以单独标出**
 *
 * `min{ A : S > T }` 是「T 时刻 LSN 的上界」——它要求**观测时刻基本等于 LSN 生成时刻**
 * （即 `t(A) ≈ S` 而不是 `t(A) ≪ S`）。**这个前提不是对每个来源都成立**：
 *
 * | 来源 | 滞后量级 | 能否用于「上界」 |
 * | --- | --- | --- |
 * | 归档文件 `CREATE_TIME` | 归档延迟（很小） | ✅ `tight: true` |
 * | 当前前沿 `CUR_LSN` + `SYSDATE` | 定义上就是当时的最大 LSN | ✅ `tight: true` |
 * | 备份 `BACKUP_TIME` | **备份耗时**（实测 31 秒；夹具里约 1.5 分钟） | ❌ `tight: false` —— 只用它做**严格下界** |
 *
 * **这是实测抓出来的**：把备份锚点也用于上界时，会算出「下界 132032739 > 上界 132032738」
 * 这种**宽度为负**的自相矛盾 —— 因为 `BACKUP_TIME` 是备份**完成**时刻，
 * 而 `BEGIN_LSN` 早在备份开始时就生成了。
 *
 * 所以本模块**自查**：一旦 `practicalUpper ≤ strictLower`（或时间方向同理），就判定该前提
 * 在本库不成立，**丢掉那一半**并如实说明，只给严格结论。
 * 如果哪天有服务端换算入口，这整层删掉即可。
 */
export function assessTimeLsnAnchors({
  archRes = null,
  backups = [],
  curLsn = null,
  nowTime = null,
  rlogHistory = null,
  flashbackTrx = null,
} = {}) {
  const anchors = [];
  const ac = cols(archRes);
  /**
   * ① 归档文件 —— **每个文件贡献两个锚点**（DESIGN §35）：
   *    · `(CREATE_TIME, ARCH_LSN)`：开始往这个文件归档的时刻 ↔ 该文件的第一个 LSN
   *    · `(CLOSE_TIME, CLSN)`：该文件写完并关闭的时刻 ↔ 该文件的最后一个 LSN
   *
   *    ★ `CLOSE_TIME` 是**本轮探测新发现**的（`V$ARCH_FILE` 的真实列，手册没强调）：
   *      真机上每个文件都成对给出，例如
   *      `ARCH_LSN=42231283 @ 2026-10-10 14:29:12.901120` 与 `CLSN=42254846 @ 2026-10-10 16:07:29.561967`。
   *      两个都是**同步观测**（文件开/关的那一刻就是这个 LSN 在推进的那一刻）⇒ 都 `tight: true`。
   *      于是归档锚点数**直接翻倍**，夹逼区间随之收窄 —— 这是本轮最实在的精度提升。
   *
   *    `V$ARCHIVED_LOG`（Oracle 兼容视图）里有对应的 `FIRST_TIME/FIRST_CHANGE#` 与
   *    `NEXT_TIME/NEXT_CHANGE#`，与上面两对是同一份事实 —— **只用一处**，不重复计数。
   *
   *    ⚠️⚠️ **`STATUS = 'ACTIVE'` 的文件不取「关」这一对**（真机抓出来的**伪造锚点**）：
   *      正在写的那个文件 `CLOSE_TIME` 实测**等于 `CREATE_TIME`**（还没关闭），而 `CLSN` 是
   *      「**已经写到哪了**」的移动末端 —— 把这两者配成一对，等于宣称
   *      「末端 LSN 是在文件创建那一刻生成的」。真机上这一条偏差 **6 万多** LSN，
   *      直接把前提自查打爆（触发「下界 > 上界」）。**宁少一个锚点，不要一个假锚点。**
   */
  for (const r of rows(archRes)) {
    const path = String(field(r, ac, '^PATH$') ?? '');
    const status = String(field(r, ac, '^STATUS$') ?? '').toUpperCase();
    const stream = (/^.*?_EP(\d+)_/.exec(path) ?? [])[1] ?? null;
    const pairs = [
      { lsn: num(field(r, ac, '^ARCH_LSN$')), t: field(r, ac, '^CREATE_TIME$'), source: '归档文件(开)', when: 'CREATE_TIME' },
      { lsn: num(field(r, ac, '^CLSN$')), t: field(r, ac, '^CLOSE_TIME$'), source: '归档文件(关)', when: 'CLOSE_TIME', skipActive: true },
    ];
    for (const p of pairs) {
      if (p.skipActive && status === 'ACTIVE') continue;
      const ms = toMs(p.t);
      if (p.lsn === null || ms === null) continue; // 取不到就不凑（旧版本可能没有 CLOSE_TIME）
      anchors.push({
        lsn: p.lsn,
        time: String(p.t),
        timeMs: ms,
        source: p.source,
        // ★ 流标识（DESIGN §35）：DMDSC 上**每个 EP 一条自己的归档流**，跨流比较时间↔LSN 会造出假矛盾。
        //   单实例上全部落进 `db` 一组，行为与以前完全一致。
        stream: stream === null ? 'db' : `EP${stream}`,
        tight: true,
        detail: `${path} ${p.when}`,
      });
    }
  }
  /**
   * ② ★ RLOG 历史（**真机实测存在**）：`(RECORD_TIME, CUR_LSN)`。
   *    **有行时**它通常是最密的锚点源（单实例实测约每分钟一行，把时间↔LSN 拉到分钟级）。
   *    ⚠️ 但**不能假定它一定有行、也不能假定它最密**：DMDSC 节点上实测只回来 **1 行**
   *    （该视图是观测历史、有保留窗口，刚起来的实例很短），那时最密的其实是**归档文件**。
   *    `tight: true`：记录时刻就是观测到该 LSN 的时刻（与"当前前沿"同一性质）。
   */
  const hc = cols(rlogHistory);
  for (const r of rows(rlogHistory)) {
    const lsn = num(field(r, hc, '^CUR_LSN$'));
    const t = field(r, hc, '^RECORD_TIME$');
    const ms = toMs(t);
    if (lsn === null || ms === null) continue;
    anchors.push({ lsn, time: String(t), timeMs: ms, source: 'RLOG 历史', tight: true, stream: 'db', detail: 'V$RLOG_HISTORY' });
  }
  /**
   * ②b ★ 闪回事务（机会性锚点源，DESIGN §35）：`(COMMIT_TIMESTAMP, COMMIT_LSN)`。
   *
   * 真机实测该视图/列名存在，但**本库 `ENABLE_FLASHBACK=0` ⇒ 0 行**。
   * 也就是说：开了闪回的库上它是**事务级**密锚点（比归档文件密得多），没开就一条都没有。
   * 两种情形都不影响其它来源 —— 所以它是"有则更好"，**不许**把"0 行"读成"没有对应关系"。
   */
  const fc = cols(flashbackTrx);
  const fbRows = rows(flashbackTrx);
  for (const r of fbRows) {
    const lsn = num(field(r, fc, '^COMMIT_LSN$'));
    const t = field(r, fc, '^COMMIT_TIMESTAMP$');
    const ms = toMs(t);
    if (lsn === null || ms === null) continue;
    anchors.push({ lsn, time: String(t), timeMs: ms, source: '闪回事务', tight: true, stream: 'db', detail: 'V$FLASHBACK_TRX_INFO' });
  }
  const flashbackCount = anchors.filter((a) => a.source === '闪回事务').length;
  const flashbackCapped = fbRows.length >= FLASHBACK_TRX_CAP;
  // ② 备份：BACKUP_TIME 是**完成**时间，BEGIN/END_LSN 都在它之前 ⇒ 只做严格下界（tight: false）
  for (const b of backups) {
    const ms = toMs(b.time);
    if (ms === null) continue;
    if (b.beginLsn !== null && b.beginLsn !== undefined) {
      anchors.push({ lsn: b.beginLsn, time: String(b.time), timeMs: ms, source: '备份 BEGIN_LSN', tight: false, stream: 'db', detail: b.name });
    }
    if (b.endLsn !== null && b.endLsn !== undefined) {
      anchors.push({ lsn: b.endLsn, time: String(b.time), timeMs: ms, source: '备份 END_LSN', tight: false, stream: 'db', detail: b.name });
    }
  }
  // ③ 当前前沿：CUR_LSN 是当时已分配的最大 LSN ⇒ 滞后～0（tight: true），用数据库自己的 SYSDATE
  const nowMs = toMs(nowTime);
  if (curLsn !== null && nowMs !== null) {
    anchors.push({ lsn: curLsn, time: String(nowTime), timeMs: nowMs, source: '当前前沿', tight: true, stream: 'db', detail: 'V$RLOG.CUR_LSN + SYSDATE' });
  }
  anchors.sort((a, b) => a.lsn - b.lsn || a.timeMs - b.timeMs);

  if (anchors.length < 2) {
    return {
      anchors,
      count: anchors.length,
      maxGapHours: null,
      minGapHours: null,
      minGapSource: null,
      dense: false,
      denseWindow: null,
      rlogRows: anchors.filter((a) => a.source === 'RLOG 历史').length,
      // ★ 形状必须与「可用」那条路径**一致**：缺键会让消费者看到 `undefined`，
      //   而 `undefined` 在断言/条件里都当假值用 —— 等于埋一个静默的分支（本项目的老毛病）。
      flashbackCount: anchors.filter((a) => a.source === '闪回事务').length,
      flashbackRows: 0,
      flashbackCapped: false,
      sourceCounts: anchors.reduce((m, a) => ({ ...m, [a.source]: (m[a.source] ?? 0) + 1 }), {}),
      usable: false,
      note:
        anchors.length === 0
          ? '没有可用锚点（归档为空、无备份、且取不到当前 LSN/SYSDATE）—— **无法做时间↔LSN 对应**'
          : '只有 1 个锚点，无法夹逼 —— 至少要两个（例如一次备份 + 当前前沿）',
    };
  }
  const times = [...new Set(anchors.map((a) => a.timeMs))].sort((a, b) => a - b);
  if (times.length < 2) {
    // 极端情形：锚点都在**同一时刻**（例如只有一次采样、多个视图给了同一个 SYSDATE）
    return {
      anchors,
      count: anchors.length,
      tightCount: anchors.filter((a) => a.tight).length,
      maxGapHours: null,
      minGapHours: null,
      minGapSource: null,
      dense: false,
      denseWindow: null,
      rlogRows: anchors.filter((a) => a.source === 'RLOG 历史').length,
      flashbackCount: anchors.filter((a) => a.source === '闪回事务').length,
      flashbackRows: 0,
      flashbackCapped: false,
      sourceCounts: anchors.reduce((m, a) => ({ ...m, [a.source]: (m[a.source] ?? 0) + 1 }), {}),
      usable: false,
      note: '所有锚点落在**同一时刻**，无法夹逼 —— 至少要两个**不同时刻**的观测',
    };
  }
  const gapsH = times.slice(1).map((t, i) => (t - times[i]) / 3600000);
  const tightCount = anchors.filter((a) => a.tight).length;
  const maxGapHours = gapsH.length > 0 ? Math.max(...gapsH) : null;
  const minGapHours = gapsH.length > 0 ? Math.min(...gapsH) : null;
  /**
   * ★ 最密的那一对锚点**是哪个来源**、以及**最密的一段连续窗口有多大**。
   *
   * 为什么必须实测而不是写死：第一版把「最密一档 = `V$RLOG_HISTORY`（约每分钟一行）」
   * 写进了文案 —— 那是在**单实例**上量到的。DMDSC 节点上该视图只回来 **1 行**
   * （历史保留窗口内没有更多采样），真正密的是**归档文件**（两个文件相隔 2 秒）。
   * 写死就会指错来源、并顺带把"精度"说成比实际好。
   */
  const pairOf = (msA, msB) => ({
    from: anchors.find((a) => a.timeMs === msA)?.source ?? null,
    to: anchors.find((a) => a.timeMs === msB)?.source ?? null,
  });
  let minGapSource = null;
  let minGapFrom = null;
  let minGapTo = null;
  for (let i = 1; i < times.length; i += 1) {
    const g = (times[i] - times[i - 1]) / 3600000;
    if (minGapHours !== null && g <= minGapHours + 1e-12) {
      const p = pairOf(times[i - 1], times[i]);
      minGapFrom = fmtMs(times[i - 1]);
      minGapTo = fmtMs(times[i]);
      minGapSource = p.from && p.to ? (p.from === p.to ? p.from : `${p.from} + ${p.to}`) : null;
      break; // gapsH 从左到右扫，第一个等于最小值的即最密的一对
    }
  }
  /**
   * 「最密的一段连续窗口」：相邻间距都 ≤ 5 分钟的最长连续段。
   * **精度只在窗口内有意义** —— 窗口外那个最大间距（可能几十小时）才是任意时刻的精度上限。
   */
  const DENSE_MIN_H = 5 / 60;
  let bestRun = null;
  let run = null;
  for (let i = 0; i < times.length; i += 1) {
    if (run === null) {
      run = { from: times[i], to: times[i], n: 1 };
    } else {
      const g = (times[i] - times[i - 1]) / 3600000;
      if (g <= DENSE_MIN_H) {
        run.to = times[i];
        run.n += 1;
      } else {
        if (bestRun === null || run.n > bestRun.n) bestRun = run;
        run = { from: times[i], to: times[i], n: 1 };
      }
    }
  }
  if (bestRun === null || (run && run.n > bestRun.n)) bestRun = run;
  const denseWindow =
    bestRun && bestRun.n > 1
      ? {
          from: fmtMs(bestRun.from),
          to: fmtMs(bestRun.to),
          anchorCount: bestRun.n,
          spanHours: (bestRun.to - bestRun.from) / 3600000,
        }
      : null;
  const dense = denseWindow !== null;
  const rlogRows = anchors.filter((a) => a.source === 'RLOG 历史').length;
  // 前提自查：严格下界的最大值 与 前提上界的最小值 是否冲突
  const premiseViolated = detectPremiseViolation(anchors);
  return {
    anchors,
    count: anchors.length,
    tightCount,
    timeBreaks: times,
    maxGapHours,
    minGapHours,
    minGapSource,
    minGapFrom,
    minGapTo,
    dense,
    denseWindow,
    rlogRows,
    // 机会性锚点源的实测计数（0 行 = 该库没开闪回，**不是**"没有对应关系"）
    flashbackCount,
    flashbackCapped,
    flashbackRows: fbRows.length,
    sourceCounts: anchors.reduce((m, a) => ({ ...m, [a.source]: (m[a.source] ?? 0) + 1 }), {}),
    usable: true,
    premiseViolated,
    // 文案**全部由本次实测值拼出来**，不写死任何环境相关的数字
    note:
      `锚点 ${anchors.length} 个（其中 ${tightCount} 个可用于「上界」，其余只做严格下界）；` +
      (dense
        ? `最密的一档间距 **${fmtMinutes(minGapHours * 60)}**（来源：${minGapSource ?? '未取到'}），` +
          `但**只在连续窗口 ${denseWindow.from} ~ ${denseWindow.to}（${denseWindow.anchorCount} 个锚点）内**才这么密；` +
          `窗口之外最大相邻间距 **${fmtMinutes((maxGapHours ?? 0) * 60)}** —— 窗口外的时间点只能按这个间距夹逼`
        : `最大相邻时间间距 **${fmtMinutes((maxGapHours ?? 0) * 60)}** —— **间距就是精度上限**（间距越大，能把目标时刻定位到的 LSN 区间越宽）`) +
      (flashbackCapped
        ? `；⚠️ 闪回事务锚点**已达取数上限 ${FLASHBACK_TRX_CAP} 条**（更早的没取），所以该来源只是"最近一段"`
        : ''),
  };
}

/**
 * 前提自查：是否**在任何一段区间内**，依赖前提的上界会跌到严格下界之下。
 *
 * ⚠️ 必须**逐段**取样，不能只在锚点时刻取：
 * 时钟倒挂（后观测到的 LSN 反而更小）时，冲突恰好出现在**两个锚点之间**——
 * 第一版只在锚点时刻取样，于是这种倒挂**漏检**了（`smoke` 里的时钟倒挂用例抓到的）。
 *
 * 真机上它还会揭示另一件事：备份的 `BACKUP_TIME` 是**完成**时刻，
 * 而 `BEGIN_LSN` 早在备份开始时就生成了 —— 所以按来源区分（`tight`）不是洁癖。
 *
 * ★★ **必须按「流」分组比较**（DESIGN §35，DMDSC 真机抓出来的）：
 * DMDSC 上**每个 EP 有自己的归档流**，而不同流的文件在**全局 LSN 坐标上是交错的**
 * —— 实测 EP0 的文件覆盖 `[42255064, 42255125]`，EP1 的下一个文件从 `42255126` 开始，
 * 但 EP0 那个文件**关闭得更晚**。于是把两条流的锚点混在一起做"后观测的 LSN 是否更小"，
 * 会**造出假矛盾**（真机上一次性报了 6 处），并因此丢掉所有上界 —— 精度反而更差。
 * 所以：**只在自己的流内比较**；跨流不下任何"倒挂"结论。
 *
 * 单实例上所有锚点都落进同一组（`stream: 'db'`），行为与分组前**逐字一致**。
 */
function detectPremiseViolation(anchors) {
  const list = anchors ?? [];
  if (list.length < 2) return false;
  const groups = new Map();
  for (const a of list) {
    const k = a.stream ?? 'db';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  for (const g of groups.values()) {
    if (violatesWithinStream(g)) return true;
  }
  return false;
}

/** 单条流内部的自查（逻辑与第一版逐字一致，只是作用域收窄到一条流）。 */
function violatesWithinStream(list) {
  if (list.length < 2) return false;
  const times = [...new Set(list.map((a) => a.timeMs))].sort((a, b) => a - b);
  for (let i = 0; i < times.length; i += 1) {
    const from = times[i];
    const to = i + 1 < times.length ? times[i + 1] : null;
    const probeT = to !== null ? from + (to - from) / 2 : from;
    const before = list.filter((a) => a.timeMs < probeT).map((a) => a.lsn);
    const afterTight = list.filter((a) => a.timeMs > probeT && a.tight).map((a) => a.lsn);
    // 严格小于才算冲突（`upper === lower` = 两侧界重合 = 精确到一个点，不是冲突）
    if (before.length > 0 && afterTight.length > 0 && Math.min(...afterTight) < Math.max(...before)) return true;
  }
  return false;
}

/**
 * 时刻 → LSN 区间。
 * `strictLowerLsn` 是**逻辑结论**；`practicalUpperLsn` 依赖「观测时刻 ≈ LSN 生成时刻」这个前提
 * （只用 `tight` 锚点算），且**被前提自查否决时为 `null`**。
 */
export function lsnForTime(anchors, tMs, { raw = false } = {}) {
  const list = anchors ?? [];
  if (list.length === 0 || tMs === null) {
    return { strictLowerLsn: null, practicalUpperLsn: null, widthLsn: null, note: '没有锚点，无法对应' };
  }
  const before = list.filter((a) => a.timeMs < tMs).map((a) => a.lsn);
  const afterTight = list.filter((a) => a.timeMs > tMs && a.tight).map((a) => a.lsn);
  const strictLowerLsn = before.length > 0 ? Math.max(...before) : null;
  let practicalUpperLsn = afterTight.length > 0 ? Math.min(...afterTight) : null;
  let premiseDropped = false;
  // ★ 判据是**严格小于**：`upper === lower` 不是冲突，而是**最好**的情况 ——
  //   两个独立的界重合，说明该时刻的 LSN 能被**定到一个点**（宽度 0）。
  //   （真机实测抓到：空闲库里 `V$RLOG_HISTORY` 连续多个采样点 LSN 完全不变，
  //    第一版用 `<=` 就把它误判成「前提冲突」并丢掉了这个精确结论 —— 假告警。）
  if (practicalUpperLsn !== null && strictLowerLsn !== null && practicalUpperLsn < strictLowerLsn) {
    practicalUpperLsn = null;
    premiseDropped = true;
  }
  const widthLsn =
    strictLowerLsn !== null && practicalUpperLsn !== null ? practicalUpperLsn - strictLowerLsn : null;
  if (raw) return { strictLowerLsn, practicalUpperLsn, widthLsn, premiseDropped };
  const notes = [];
  if (strictLowerLsn === null) {
    notes.push('该时刻**早于所有锚点** —— 若它早于最早可用备份/最早归档，则可**确定**无法恢复到该时刻');
  } else if (practicalUpperLsn === null) {
    notes.push(
      premiseDropped
        ? '上界**被前提自查否决**（本库的观测滞后与「跟得上生成」不符）—— 只给严格下界，不给区间'
        : '该时刻之后没有可用于上界的紧锚点 —— 只能给下界',
    );
  }
  return { strictLowerLsn, practicalUpperLsn, widthLsn, premiseDropped, note: notes.length > 0 ? notes.join('；') : null };
}

/**
 * LSN → 时刻区间。`strictUpperTime` 是**逻辑结论**（`t(L) ≤ 它`）；
 * `practicalLowerTime` 同样依赖上面那个前提、同样受前提自查约束。
 */
export function timeForLsn(anchors, lsn) {
  const list = anchors ?? [];
  if (list.length === 0 || lsn === null) {
    return { strictUpperTime: null, practicalLowerTime: null, note: '没有锚点，无法对应' };
  }
  const atOrAfter = list.filter((a) => a.lsn >= lsn);
  const atOrBeforeTight = list.filter((a) => a.lsn <= lsn && a.tight);
  const upperAnchor = atOrAfter.length > 0 ? atOrAfter.reduce((m, a) => (a.timeMs < m.timeMs ? a : m)) : null;
  let lowerAnchor = atOrBeforeTight.length > 0 ? atOrBeforeTight.reduce((m, a) => (a.timeMs > m.timeMs ? a : m)) : null;
  let premiseDropped = false;
  if (lowerAnchor !== null && upperAnchor !== null && lowerAnchor.timeMs > upperAnchor.timeMs) {
    lowerAnchor = null;
    premiseDropped = true;
  }
  return {
    strictUpperTime: upperAnchor?.time ?? null,
    strictUpperAnchor: upperAnchor,
    practicalLowerTime: lowerAnchor?.time ?? null,
    practicalLowerAnchor: lowerAnchor,
    premiseDropped,
    note: atOrAfter.length === 0 ? '该 LSN 比所有锚点都新（还没被任何观测覆盖）' : null,
  };
}

/**
 * 分段夹逼表：以锚点的**不同时刻**为断点，给出每一段内「任意时刻对应哪个 LSN 区间」。
 *
 * 为什么按时刻分段而不是按 LSN 排序做成"映射曲线"：`S` 只是 `t(A)` 的**上界**，
 * 而不同来源的滞后各不相同，所以「LSN 大的锚点其观测时刻不一定更晚」——
 * 按 LSN 排序拼曲线会得到自相矛盾的图。按时刻分段则**由构造保证**自洽
 * （每一段内上/下界都是对相应集合取 max/min，不做任何排序假设）。
 */
export function bracketTable(anchors) {
  const list = anchors ?? [];
  if (list.length < 2) return [];
  const times = [...new Set(list.map((a) => a.timeMs))].sort((a, b) => a - b);
  const rows = [];
  for (let i = 0; i < times.length; i += 1) {
    const from = times[i];
    const to = i + 1 < times.length ? times[i + 1] : null;
    // 段内取一个代表时刻：左闭右开 [from, to)
    const probeT = to !== null ? from + (to - from) / 2 : from;
    const b = lsnForTime(list, probeT);
    rows.push({
      fromTime: list.find((a) => a.timeMs === from)?.time ?? null,
      toTime: to !== null ? list.find((a) => a.timeMs === to)?.time ?? null : null,
      strictLowerLsn: b.strictLowerLsn,
      practicalUpperLsn: b.practicalUpperLsn,
      widthLsn: b.widthLsn,
    });
  }
  return rows;
}

/**
 * 备份覆盖度：从最近一次备份能恢复到哪一点，缺多少 redo。
 *
 * ⚠️ 这里的 `covered` 是**两端的必要条件**（最早归档 ≤ 备份起点、最晚归档 ≥ 当前 LSN）——
 * **两端对齐不代表中间无洞**。中间有没有洞由 `assessArchiveChain()` 逐段核对给出，
 * 两者是「弱判据 / 强判据」的关系，报告里必须一起看，不能用这个替代那个。
 */
export function assessBackupCoverage({ backups, curLsn, archRes }) {
  const newest = backups[0] ?? null;
  /**
   * ★ 账本为空**不能提前 return**：两个分支必须返回**同一组键**。
   *
   * 原来这里写的是 `if (!newest) return { newest: null, state: 'none-all' };`，
   * 于是空账本时 `redoGap` / `covered` / `span` 三个键**根本不存在**（读出来是 `undefined`）。
   * 后果不止是字段缺失：
   *   · `index.js` 把 `coverage` 原样放进 tool 返回值，而 `undefined` **不是无损 JSON**
   *     （`JSON.parse(JSON.stringify(x))` 会把它丢掉），宿主据此拒收整个 action 的结果 ——
   *     真机实测：账本为空的库上 `backup` / `report` 一律报 invalid output，
   *     而 HTML 其实已经落盘，看起来像"插件坏了"，实际是返回值这一层过不去；
   *   · `cov.redoGap !== null` 这类判断会**走错分支**（`undefined !== null` 成立），
   *     把「未取到」渲染成 `undefined`。
   * 空账本不是异常路径，而是**最常见的一种状态**（没配备份策略的库、重建后还没备份的库），
   * 它必须和正常路径同形 —— 所以这里统一走一条出口，只用 `newest` 区分 `state`。
   */
  const needFrom = newest?.endLsn ?? null;
  const needTo = curLsn ?? null;
  const redoGap = needFrom !== null && needTo !== null ? needTo - needFrom : null;
  const span = archiveSpan(archRes);
  let covered = null;
  if (needFrom !== null && needTo !== null && span.oldestArchLsn !== null && span.latestClsn !== null) {
    covered = span.oldestArchLsn <= needFrom && span.latestClsn >= needTo;
  }
  return {
    newest,
    state: newest ? 'ok' : 'none-all',
    needFrom,
    needTo,
    redoGap,
    span,
    covered,
    fulls: backups.filter((b) => b.isFull),
    increments: backups.filter((b) => !b.isFull),
  };
}

/** 路径形态：ASM（`+`开头）还是文件系统。决定「文件系统上找不到」是不是异常。 */
export function classifyPath(p) {
  const s = String(p ?? '').trim().replace(/^["']|["']$/g, '');
  if (s.startsWith('+')) return 'asm';
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/')) return 'filesystem';
  return 'unknown';
}

export function normalizePath(s) {
  return String(s ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/[\\/]+$/, '');
}

/**
 * 用户自行提供的备份位置 —— 先在库的账本里核对。
 *
 * 注意这里能给的结论**上限**：`inCatalog=true` 只说明「库的账本里有这条记录」，
 * **不等于备份文件可读**。真正的可用性校验必须 `dmrman CHECK BACKUPSET`。
 */
export function verifySuppliedPath(input, backups) {
  const norm = normalizePath(input);
  const kind = classifyPath(norm);
  const low = norm.toLowerCase();
  const matches = [];
  for (const b of backups) {
    const p = String(b.path ?? '');
    const n = String(b.name ?? '');
    const pl = p.toLowerCase();
    const nl = n.toLowerCase();
    let how = null;
    if (!norm) continue;
    if (low === pl) how = 'path 与账本记录完全相同';
    else if (low === nl) how = 'name 与账本记录完全相同';
    else if (pl && (pl.startsWith(low + '/') || low.startsWith(pl + '/'))) how = 'path 与账本记录存在包含关系';
    if (how) matches.push({ backup: b, how });
  }
  // 账本里的备份都在 ASM，而用户给的是文件系统路径 —— 这是**预期行为**，不是备份丢了
  const asmCatalog = backups.some((b) => classifyPath(b.path) === 'asm');
  const kindMismatch = asmCatalog && kind === 'filesystem';
  return { raw: input, normalized: norm, kind, matches, inCatalog: matches.length > 0, kindMismatch };
}

/** 唯一能真正校验备份集的命令。实测确认库内无此能力，只能外部执行。 */
export function dmrmanCheckCommand(p) {
  return `dmrman CTLSTMT="CHECK BACKUPSET '${normalizePath(p)}'"`;
}

/**
 * 坏页与备份的时间关系。
 *
 * 能下的结论只有一条，且是**逻辑结论**而不是猜测：
 *   坏页记录时间 **晚于** 最近一次全备 → 这次全备**不含**该页损坏。
 * 反方向（坏页早于全备）**不能**推出「备份里有坏页」——
 * 因为 RECORD_TIME 是「被发现」的时间，不是「变坏」的时间。
 */
export function relatePagesToBackups(pages, backups) {
  const newestFull = backups.filter((b) => b.isFull)[0] ?? null;
  const bt = newestFull ? toMs(newestFull.time) : null;
  return pages.map((p) => {
    const raw = p.RECORD_TIME ?? p.recordTime ?? null;
    const t = toMs(raw);
    let rel = 'unknown';
    if (t !== null && bt !== null) rel = t > bt ? 'after-backup' : 'before-backup';
    return { page: p, rel, pageTimeMs: t, pageTime: raw, backupTimeMs: bt };
  });
}
