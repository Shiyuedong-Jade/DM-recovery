/**
 * 恢复场景引擎 —— **报告的真正主干**。
 *
 * 取向：一份「恢复能力评估」必须**先确定数据库在什么场景下需要恢复**，
 * 再逐场景回答「能不能救、靠什么救、缺口在哪」。按「插件能查到什么」分章是错的。
 *
 * 三条硬规则：
 *
 * 1. **能力判定只依据实测事实。** `facts` 里的每一项都对应一个查得到或由运维提供的值；
 *    查不到的写 `null`，判定就是 `unknown` —— **不猜**。
 * 2. **区分「能不能救」与「救得多贵」。** 非归档库也能救（回到上次全备），
 *    代价是丢掉事故之后的全部数据。所以 `partial` 不等于 `ok`。
 * 3. **场景清单是数据，不是代码分支。** 每条场景自带 `need`（需要什么）与 `rule`（判定），
 *    这样「缺了什么」是**从需求反推**出来的，而不是散落在 if 里。
 */

/** 能力档位：ok=有手段且代价可接受 / partial=有手段但代价高 / none=无手段 / unknown=信息不足。 */
// ★ 词表统一到 `vocab.js`（DESIGN §24）：这里**重新导出**，一是保持既有引用可用
//   （`smoke.mjs` 直接用 `sc.COND` / `sc.COND_MARK` / `sc.CAP`），二是让「定义处只有一处」成立。
export { CAP, CAP_LABEL, CAP_MARK, COND, COND_LABEL, COND_MARK } from './vocab.js';
import { CAP, CAP_LABEL, COND, COND_MARK } from './vocab.js';

// 严重度排序：数字越小越严重。`na`（不适用）与 `ok` 同列 —— 它**不是问题**。
const RANK = { none: 0, partial: 1, unknown: 2, ok: 3, na: 3 };

/** 三档「地基」：时间点恢复能力，被很多场景共用。 */
function timePoint(f) {
  const hasBak = backupPresence(f);
  // ★ §46.5：归档没开 ⇒ 时间点恢复这条路**根本不存在**，与备份无关 ⇒ `none` 是准确的
  if (!f.archOn) return CAP.none;
  // ★ §46.5：账本为空、又无法确认"确实没有备份" ⇒ **不判定**（不是 none）
  //   实测触发：还原把控制文件回退到备份开始那一刻，那份备份自己还没进账本 ——
  //   实例健康、磁盘上备份都在、账本是空的。此时判 none 就是"拿没查到当没有"。
  if (hasBak === 'unknown') return CAP.unknown;
  // 归档开 + 有备份 + 归档链覆盖到备份起点 => 时间点恢复可行
  if (hasBak === true && f.archiveChainOk === true) return CAP.ok;
  if (hasBak === true && f.archiveChainOk === null) return CAP.unknown;
  return CAP.none;
}

/**
 * 「有没有备份」的三态 —— `true` / `false` / `'unknown'`（DESIGN §46.5）。
 *
 * 为什么不能只有布尔：**账本为空不等于没有备份**（插件自己在报告里就是这么写的），
 * 而场景引擎原来把 `backupsCount === 0` 直接当成"确定没有备份"，
 * 于是同一个环境下一边写着"账本为空不等于没有备份"、一边把 12 个场景判成"当前救不回来"。
 *
 * `f.backupsUncertain` 由入口按**两个来源**算出来（账本 + 文件系统的 `find` 结果）：
 * 账本为空，且（磁盘上找到了疑似备份文件 ／ 没配 OS 访问 ／ 备份在 ASM 上 `find` 够不到）。
 * 只有"文件系统真的找过、且一个都没找到"才算**确定没有**。
 */
export function backupPresence(f) {
  if (Number(f.backupsCount) > 0) return true;
  if (f.backupsUncertain) return 'unknown';
  return false;
}

/** 「账本为空」这类不确认为什么不能判 none —— 统一的说法。 */
const noBackupNote = (f) =>
  `账本里没有备份记录，但**账本为空不等于没有备份**` +
  (f.backupFilesFound
    ? `：磁盘上找到 **${f.backupFilesFound}** 个疑似备份文件，需先 ` + '`dmrman CHECK BACKUPSET`' + ` 确认它们能不能用`
    : `：本次也没能确认磁盘上到底有没有备份文件（未配 OS 访问，或备份在 ASM 上 \`find\` 够不到）`);

/** 「归档已开 + 有备份」这条退路条件 —— **三态**（§46.5：账本为空时不许直接画 ❌）。 */
function archOnCond(f, name = '可重建') {
  const has = backupPresence(f);
  const c = cond(
    'ARCH_ON',
    name,
    '归档已开 + 有备份',
    `归档${f.archOn ? '已开' : '未开'} ／ ${f.backupsCount ?? '—'} 份备份`,
    has === 'unknown' ? COND.UNKNOWN : Boolean(f.archOn && has === true),
  );
  return c;
}

/**
 * 归档链的**实测摘要**（有逐段核对结果时用它，否则退回旧措辞）。
 *
 * 为什么要这样：判定用的是 `f.archiveChainOk`，而它现在取自**逐段核对**
 * （见 `backup.js` 的 `assessArchiveChain`）。既然判据升级了，**说法也得跟着升级** ——
 * 否则「靠什么救」那句还写着「最早归档 LSN 早于备份起点」（那只是必要条件），
 * 与判定同源的原则就又破了。
 */
function chainNote(f) {
  const ch = f.archiveChain;
  if (!ch || ch.verdict === 'unknown' || !ch.series?.length) return null;
  const tail =
    ch.unarchivedLsn !== null && ch.unarchivedLsn > 0
      ? `，未归档尾部 ${ch.unarchivedLsn}（还在联机日志里）`
      : '';
  if (ch.verdict === 'gap') {
    return `⚠️ 归档并集里有 ${ch.holes.length} 处**洞**（恢复到那里会断）`;
  }
  const seg = `${ch.series.length} 个序列逐段连续，并集覆盖 LSN ${ch.coveredFrom}–${ch.coveredTo}${tail}`;
  return ch.singleSeriesBreakIsDefect ? `归档链${seg}` : `归档链${seg}（${ch.series.length} 个序列，判定看并集）`;
}

const tpReason = (f) => {
  const ch = f.archiveChain;
  if (!f.archOn) return '归档未开，没有时间点恢复能力';
  if (backupPresence(f) === 'unknown') return `归档已开，但${noBackupNote(f)} —— **本次不判定**`;
  const hasBak = backupPresence(f);
  if (hasBak === false) return '归档已开但库的账本里没有备份，且文件系统上也确实没找到';
  const base = `归档已开、备份存在（${f.backupsCount} 份）`;
  if (f.archiveChainOk === true) {
    return `${base}，且 ${chainNote(f) ?? `最早归档 LSN ${f.earliestArchLsn ?? '—'} 早于备份起点 ${f.backupBeginLsn ?? '—'}`}`;
  }
  if (f.archiveChainOk === false) {
    // 说清**是哪一种不成立**：有洞 / 归档起点晚于备份起点 / 其它
    if (ch && ch.verdict === 'gap') return `${base}，但 ${chainNote(f)}`;
    if (ch && ch.coveredFrom !== null && f.backupBeginLsn !== null && ch.coveredFrom > f.backupBeginLsn) {
      return `${base}，但归档起点（LSN ${ch.coveredFrom}）**晚于备份起点**（LSN ${f.backupBeginLsn}）—— 这份备份配不上归档，只能恢复到备份结束点`;
    }
    return `${base}，但归档链**覆盖不到备份起点**`;
  }
  return '归档链连续性未能判定';
};

// ---------------------------------------------------------------------------
// 条件的**四态** —— 修掉真机报告里 C1「表里 ❌、下面却说全部满足」那类自相矛盾
// ---------------------------------------------------------------------------

/**
 * `met` / `unmet` / `unknown` / `na`。
 *
 * 为什么不能只有 ✅/❌（真机报告 2026-10-12 09:23 暴露的两个硬缺陷都源于此）：
 *
 * · **未取到 ≠ 不满足**（本项目的既有纪律）。把「没观测到」画成 ❌ 就是凭猜测报缺口；
 * · **不适用 ≠ 不满足**。单实例上「DMDSC 单节点故障」这个灾种**根本不存在**，
 *   既不该标 ❌（它没有缺口），也不该被算进「全部满足」（它没被满足）。
 *   旧代码把这种情形渲染成「✅ 该场景所需条件**全部满足**」，
 *   而同一张表里明明写着 ❌ —— 一份报告自己打自己。
 *
 * ⚠️ `COND` / `COND_MARK` / `COND_LABEL` 的**定义已移到 `vocab.js`**（DESIGN §24），
 *    本文件只在顶部重新导出；这里保留说明是因为「四态」的**语义由来**属于判定层。
 */

/**
 * 造一个条件。`state` 收 `COND.*` 字符串，也收布尔（兼容旧写法：true→已满足、false→未满足）。
 */
function cond(key, name, require, actual, state) {
  const st = state === true ? COND.MET : state === false ? COND.UNMET : state;
  return { key, name, require, actual, state: st, met: st === COND.MET };
}

/** 旧写法（只有 `met` 布尔）在求值阶段统一补上 `state`，免得两种形状在下游各判一次。 */
const withState = (c) => (c.state ? c : { ...c, state: c.met ? COND.MET : COND.UNMET });

/**
 * 「时间点恢复」条件 —— **与 `timePoint(f)` 同源**。
 *
 * 这一条是防自相矛盾的关键：条件表里的 ✅ 必须**恰好等于**判定所依据的那件事。
 * 先前 A1/A2/A3 各自手抄了一遍 `f.archOn && f.backupsCount > 0 && …`（且抄得不一致：
 * A2/A3 漏了 `archiveChainOk === true`），于是「归档链连续性未能判定」时，
 * 判定说「无法判定」而条件表却画 ✅ —— 干净的例子说明为什么会有人不信这张表。
 */
export function tpCond(f, name = '时间点恢复', require = '归档已开 + 有备份 + 归档覆盖备份起点') {
  const tp = timePoint(f);
  const state = tp === CAP.ok ? COND.MET : tp === CAP.unknown ? COND.UNKNOWN : COND.UNMET;
  const coverage = f.archiveChainOk === true ? '是' : f.archiveChainOk === false ? '否' : '未判定';
  return cond(
    'ARCH_ON',
    name,
    require,
    `归档${f.archOn ? '已开' : '未开'} ／ ${f.backupsCount ?? '—'} 份备份 ／ 覆盖${coverage}`,
    state,
  );
}

/**
 * 「逻辑导出副本」条件 —— 单点回捞的另一条路（A4 / A5）。
 *
 * 取值只能是**未取到**：`dexp` 是库外工具，达梦库内**没有登记入口**，
 * 插件的 JDBC 只读通道问不出「这台机器上有没有做过逻辑导出」。
 * 所以既不能画 ✅（没证据）也不能画 ❌（那是在报一个没观测过的缺口）。
 */
const logicalDumpCond = () =>
  cond(
    'LOGICAL_DUMP',
    '逻辑导出副本',
    '存在 dexp 逻辑导出副本（可做单点回捞，不必整库回退）',
    '库内**无登记入口** —— 本插件无法从库内判断是否做过 dexp',
    COND.UNKNOWN,
  );

/**
 * 场景清单。`need` 用于反推缺口，`assess` 给能力判定。
 * 顺序即报告顺序：先高频逻辑损坏，再物理损坏，最后集群/容灾。
 */
export const SCENARIOS = [
  {
    id: 'A1',
    group: 'A. 逻辑损坏（数据还在，内容错了）',
    name: '单条 / 少量记录被误删或误改',
    need: ['ENABLE_FLASHBACK=1（闪回查询 / 闪回表）', '或：归档已开 + 备份存在（退化为整库时间点恢复）'],
    assess: (f) =>
      f.enableFlashback === '1'
        ? { cap: CAP.ok, how: '闪回查询 / 闪回表，秒级定位并还原少量行，不影响其他数据' }
        : timePoint(f) === CAP.ok
          ? { cap: CAP.partial, how: `无闪回。只能整库时间点恢复：${tpReason(f)}`, gap: 'ENABLE_FLASHBACK 未开启' }
          // ★ §46.5：`timePoint` 的三态要传下来 —— 原来 unknown 也落到 none，
          //   于是"账本为空、无法确认有没有备份"被说成"救不回来"
          : timePoint(f) === CAP.unknown
            ? { cap: CAP.unknown, how: `无闪回；时间点恢复能力**未判定**：${tpReason(f)}`, gap: 'ENABLE_FLASHBACK 未开启，且备份是否存在未确认' }
            : { cap: CAP.none, how: `既无闪回、也无时间点恢复：${tpReason(f)}`, gap: 'ENABLE_FLASHBACK 未开启，且时间点恢复能力不成立' },
    evidence: (f) => [`ENABLE_FLASHBACK=${f.enableFlashback ?? '未取到'}`, `UNDO_RETENTION=${f.undoRetention ?? '未取到'}`],
  },
  {
    id: 'A2',
    group: 'A. 逻辑损坏（数据还在，内容错了）',
    name: '整张表被误 DROP / TRUNCATE',
    need: ['闪回表 / 回收站', '或：时间点恢复'],
    assess: (f) =>
      f.enableFlashback === '1'
        ? { cap: CAP.ok, how: '闪回表（FLASHBACK TABLE）直接还原该表' }
        : f.recyclebinEnabled === true
          ? { cap: CAP.ok, how: '从回收站还原', gap: null }
          : timePoint(f) === CAP.ok
            ? { cap: CAP.partial, how: `无闪回 / 回收站。只能整库时间点恢复：${tpReason(f)}`, gap: 'ENABLE_FLASHBACK 未开启' }
            // ★ §46.5：同上 —— unknown 要传下来
            : timePoint(f) === CAP.unknown
              ? { cap: CAP.unknown, how: `无闪回 / 回收站；时间点恢复能力**未判定**：${tpReason(f)}`, gap: '缺少闪回 / 回收站，且备份是否存在未确认' }
              : { cap: CAP.none, how: `无闪回、无回收站、也无时间点恢复：${tpReason(f)}`, gap: '缺少闪回 / 回收站 / 时间点恢复' },
    evidence: (f) => [
      `ENABLE_FLASHBACK=${f.enableFlashback ?? '未取到'}`,
      `回收站=${f.recyclebinEnabled === true ? '已启用' : f.recyclebinEnabled === false ? '**已关闭**' : '未确认'}`,
    ],
  },
  {
    id: 'A3',
    group: 'A. 逻辑损坏（数据还在，内容错了）',
    name: '整表数据被批量误 UPDATE',
    need: ['闪回查询（对比出事前后）', '或：时间点恢复'],
    assess: (f) =>
      f.enableFlashback === '1'
        ? { cap: CAP.ok, how: '闪回查询取出事前镜像，反向修复' }
        : timePoint(f) === CAP.ok
          ? { cap: CAP.partial, how: `无闪回。只能整库时间点恢复：${tpReason(f)}`, gap: 'ENABLE_FLASHBACK 未开启' }
          // ★ §46.5：同上
          : timePoint(f) === CAP.unknown
            ? { cap: CAP.unknown, how: `无闪回；时间点恢复能力**未判定**：${tpReason(f)}`, gap: 'ENABLE_FLASHBACK 未开启，且备份是否存在未确认' }
            : { cap: CAP.none, how: `无闪回，也无法时间点恢复：${tpReason(f)}`, gap: 'ENABLE_FLASHBACK 未开启' },
    evidence: (f) => [`ENABLE_FLASHBACK=${f.enableFlashback ?? '未取到'}`],
  },
  {
    id: 'A4',
    group: 'A. 逻辑损坏（数据还在，内容错了）',
    name: '整个 schema / 用户被 DROP',
    need: ['时间点恢复（归档 + 备份）', '或：逻辑导出（dexp）副本'],
    assess: (f) => {
      const tp = timePoint(f);
      return tp === CAP.ok
        ? {
            cap: CAP.partial,
            how: '只能整库时间点恢复 —— 事故之后的**全部**改动都会丢',
            // 措辞与条件表**同源**：缺口是「库内没有登记入口，所以确认不了」，
            // 不是「确认了没有」。先前写成「无逻辑导出副本」，与条件表里的 ❔ 打脸。
            gap: '库内无逻辑导出副本的登记 —— 是否做过 dexp 无法从库内确认',
          }
        : { cap: tp === CAP.unknown ? CAP.unknown : CAP.none, how: `时间点恢复不成立：${tpReason(f)}`, gap: '缺少归档 / 备份' };
    },
    evidence: (f) => [`归档=${f.archOn ? '开' : '关'}`, `备份份数=${f.backupsCount}`],
  },
  {
    id: 'A5',
    group: 'A. 逻辑损坏（数据还在，内容错了）',
    name: '表结构被误改（DROP COLUMN / 改类型）',
    need: ['时间点恢复', '或：逻辑导出重建'],
    assess: (f) => {
      const tp = timePoint(f);
      return tp === CAP.ok
        ? {
            cap: CAP.partial,
            how: '整库时间点恢复到改结构之前，再补数据',
            gap: '库内无逻辑导出副本的登记 —— 是否做过 dexp 无法从库内确认',
          }
        : { cap: tp === CAP.unknown ? CAP.unknown : CAP.none, how: `时间点恢复不成立：${tpReason(f)}`, gap: '缺少归档 / 备份' };
    },
    evidence: (f) => [`归档=${f.archOn ? '开' : '关'}`],
  },

  {
    id: 'B1',
    group: 'B. 物理损坏 / 介质故障',
    name: '单个数据页损坏（校验失败）',
    need: ['数据守护备库（借干净页）', '或：从备份还原 + 归档恢复到一致点'],
    assess: (f) =>
      f.hasStandby
        ? { cap: CAP.ok, how: '在线页修复：向备库借干净页覆盖' }
        : timePoint(f) === CAP.ok
          ? {
              cap: CAP.partial,
              how:
                '无备库，**不能在线修**。只能从备份还原 + 归档恢复到一致点（需停机或表空间 offline）。' +
                (f.dscNodes > 1 ? 'DMDSC 是共享存储、只有一份数据，同样借不到干净的对端页。' : ''),
              gap: '无数据守护备库',
            }
          : timePoint(f) === CAP.unknown
            ? { cap: CAP.unknown, how: `无备库；能否从备份 + 归档恢复**未判定**：${tpReason(f)}`, gap: '无数据守护备库，且备份是否存在未确认' }
            : { cap: CAP.none, how: '无备库，且时间点恢复能力不成立，坏页无法修复', gap: '无备库 + 无归档/备份' },
    evidence: (f) => [`存在坏页=${f.hasBadPages ? '是' : '否'}`, `备库=${f.hasStandby ? '有' : '无'}`],
  },
  {
    id: 'B2',
    group: 'B. 物理损坏 / 介质故障',
    name: '单个数据文件损坏（坏道 / 被删 / 被截断）',
    need: ['全备 + 归档连续（可只还原该文件）'],
    assess: (f) => {
      const tp = timePoint(f);
      return tp === CAP.ok
        ? { cap: CAP.ok, how: `从备份还原该数据文件 + 归档恢复到一致点（${tpReason(f)}）` }
        : { cap: tp === CAP.unknown ? CAP.unknown : CAP.none, how: `无法还原：${tpReason(f)}`, gap: '缺少备份或归档不连续' };
    },
    evidence: (f) => [`备份份数=${f.backupsCount}`, `归档链=${f.archiveChainOk === true ? '连续' : f.archiveChainOk === null ? '未判定' : '不连续'}`],
  },
  {
    id: 'B3',
    group: 'B. 物理损坏 / 介质故障',
    name: '控制文件损坏 / 丢失',
    need: ['CTL_BAK_PATH 已配 + CTL_BAK_NUM > 0（控制文件自动备份）'],
    assess: (f) =>
      Number(f.ctlBakNum) > 0 && f.ctlBakPath
        ? { cap: CAP.ok, how: `用自动控制文件备份恢复（保留 ${f.ctlBakNum} 份，路径 ${f.ctlBakPath}）` }
        : { cap: CAP.none, how: '没有可用的控制文件自动备份', gap: 'CTL_BAK_PATH / CTL_BAK_NUM 未配置' },
    evidence: (f) => [`CTL_BAK_PATH=${f.ctlBakPath ?? '未配置'}`, `CTL_BAK_NUM=${f.ctlBakNum ?? '未配置'}`],
  },
  {
    id: 'B4',
    group: 'B. 物理损坏 / 介质故障',
    name: '联机 REDO 日志损坏',
    need: ['日志镜像（同组多成员）', '或：归档 + 备份重建'],
    assess: (f) => {
      if (f.rlogMirrored === true) return { cap: CAP.ok, how: '同组有镜像成员，可顶替损坏的那一份' };
      const tp = timePoint(f);
      return tp === CAP.ok
        ? { cap: CAP.partial, how: '无日志镜像，需用归档 + 备份重建', gap: '联机日志未做镜像' }
        : { cap: tp === CAP.unknown ? CAP.unknown : CAP.none, how: '无镜像且无法重建', gap: '无日志镜像 + 无归档/备份' };
    },
    evidence: (f) => [`日志镜像=${f.rlogMirrored === true ? '有' : f.rlogMirrored === false ? '无' : '未判定'}`],
  },
  {
    id: 'B5',
    group: 'B. 物理损坏 / 介质故障',
    name: '归档日志损坏 / 缺失',
    need: ['归档目标之间有冗余（LOCAL + REMOTE 各存一份）'],
    assess: (f) =>
      f.archiveTargets >= 2
        ? { cap: CAP.ok, how: `有 ${f.archiveTargets} 个归档目标，互为冗余` }
        : f.archiveTargets === 1
          ? { cap: CAP.partial, how: '只有 1 个归档目标，该目标损坏即归档链断裂', gap: '归档目标没有冗余' }
          : { cap: CAP.unknown, how: '归档目标数未取到', gap: '归档未配置' },
    evidence: (f) => [`归档目标数=${f.archiveTargets ?? '未取到'}`],
  },
  {
    id: 'B6',
    group: 'B. 物理损坏 / 介质故障',
    name: '备份集本身损坏 / 不可读',
    need: ['存在多份备份', '且每份都经 dmrman CHECK BACKUPSET 校验过'],
    assess: (f) => {
      const hasBakB6 = backupPresence(f);
      // ★ §46.5：账本为空但无法确认"确实没有备份" ⇒ 不判定（原来直接判 none，与"账本为空不等于没有备份"打架）
      if (hasBakB6 === 'unknown')
        return { cap: CAP.unknown, how: `${noBackupNote(f)} —— 本场景**不判定**`, gap: '备份是否存在未确认' };
      // ⚠️ 「份数**未取到**」必须排在"确定没有（false）"**之前** —— 否则 `undefined` 会被当 0 判成 none
      //    （离线自检当场抓到过：`B6 份数未取到 => unknown` 那一条）
      if (!Number.isFinite(Number(f.backupsCount))) return { cap: CAP.unknown, how: '备份份数未取到，不判定', gap: '未知' };
      if (hasBakB6 === false) return { cap: CAP.none, how: '库的账本里没有备份记录，文件系统上也确实没找到', gap: '无备份' };
      // 这个场景**假设的正是"备份损坏"**。只有一份时，坏的若是它就没有后备 —— 所以是 none 而不是 partial。
      if (f.backupsCount === 1)
        return {
          cap: CAP.none,
          how: '**只有 1 份备份** —— 本场景假设的正是「备份损坏」，而它没有任何后备',
          gap: '备份没有冗余',
          external: true,
        };
      return {
        cap: f.backupVerified === true ? CAP.ok : CAP.partial,
        how:
          `有 ${f.backupsCount} 份备份可互为后备。备份是否可读**必须**由 dmrman CHECK BACKUPSET 校验 —— ` +
          `未配 OS 访问时插件替做不了（配了 sshHost 等参数后它会自己做，且只执行只读命令）。`,
        gap: f.backupVerified === true ? null : '未提供 dmrman 校验结果',
        external: true,
      };
    },
    evidence: (f) => [`备份份数=${f.backupsCount}`, `已校验=${f.backupVerified === true ? '是' : '否/未提供'}`],
  },
  {
    id: 'B7',
    group: 'B. 物理损坏 / 介质故障',
    name: '整机 / 存储损坏（火灾、掉电、勒索）',
    need: ['备份与归档位于**不同存储**（异机副本）'],
    assess: (f) =>
      f.offsiteCopy === true
        ? { cap: CAP.ok, how: '存在异地 / 异存储副本' }
        : f.offsiteCopy === false
          ? {
              cap: CAP.none,
              how:
                '**备份与归档和数据库在同一存储上**，存储整体损坏时它们一起消失 —— ' +
                '这不是参数问题，补不上，只能靠加一份异机副本。',
              gap: '无异地 / 异存储副本',
            }
          : { cap: CAP.unknown, how: '无法从库内判定备份与归档是否在同一存储，需运维确认', gap: '未知' },
    evidence: (f) => [`BAK_PATH=${f.bakPath ?? '未取到'}`, `异地副本=${f.offsiteCopy === null ? '未提供' : f.offsiteCopy}`],
  },
  {
    id: 'B8',
    group: 'B. 物理损坏 / 介质故障',
    name: '表空间被误删 / 数据文件被误 offline',
    need: ['时间点恢复'],
    assess: (f) => {
      const tp = timePoint(f);
      return tp === CAP.ok
        ? { cap: CAP.ok, how: `从备份还原 + 归档恢复到一致点（${tpReason(f)}）` }
        : { cap: tp === CAP.unknown ? CAP.unknown : CAP.none, how: `无法恢复：${tpReason(f)}`, gap: '缺少备份 / 归档' };
    },
    evidence: (f) => [`表空间状态=${f.tsStatus ?? '未取到'}`],
  },

  {
    id: 'C1',
    group: 'C. 集群 / 容灾',
    name: 'DMDSC 单个节点故障',
    need: ['多节点均正常，其余节点可接管'],
    /**
     * ★ 三态之外还要有「**不适用**」：单实例上这个灾种**根本不存在**。
     *
     * 以前这里返回 `CAP.unknown`，于是它被归进「N 个场景无法从库内判定」——
     * 那句话是**错的**：不是"工具没查到"，而是"这事跟你无关"。
     * 分级依据是"哪个场景救不了"，所以 `na` **不进分级桶**。
     * `DSC_NODES` 取不到时仍给 `unknown`（那时确实判不了）。
     */
    assess: (f) => {
      if (f.dscNodes > 1) return { cap: CAP.ok, how: `${f.dscNodes} 个节点，单节点故障由其余节点接管`, gap: null };
      const n = Number(f.dscNodes);
      if (Number.isFinite(n) && n === 1) {
        return { cap: CAP.na, how: '本库是单实例，不存在「DMDSC 单节点故障」这个灾种 —— 本场景**不适用**', gap: null };
      }
      return { cap: CAP.unknown, how: '取不到节点数，无法判断本场景是否适用' };
    },
    evidence: (f) => [`DSC_NODES=${f.dscNodes ?? '未取到'}`, `节点检查数=${f.checkedNodes ?? '—'}`],
  },
  {
    id: 'C2',
    group: 'C. 集群 / 容灾',
    name: 'DMDSC 全集群故障',
    need: ['备份 + 归档（且不在同一存储）'],
    assess: (f) => {
      const tp = timePoint(f);
      if (tp !== CAP.ok) return { cap: tp === CAP.unknown ? CAP.unknown : CAP.none, how: `无法重建：${tpReason(f)}`, gap: '缺少备份 / 归档' };
      return f.offsiteCopy === false
        ? { cap: CAP.partial, how: '能重建，但备份与归档同存储 —— 存储本身坏了就一起没了', gap: '无异地副本' }
        : { cap: CAP.ok, how: '用备份 + 归档重建' };
    },
    evidence: (f) => [`归档=${f.archOn ? '开' : '关'}`, `备份份数=${f.backupsCount}`],
  },
  {
    id: 'C3',
    group: 'C. 集群 / 容灾',
    name: '站点级灾难（异地容灾）',
    need: ['异地备份或异地备库'],
    assess: (f) =>
      f.offsiteCopy === true
        ? { cap: CAP.ok, how: '有异地副本 / 备库' }
        : f.offsiteCopy === false
          ? { cap: CAP.none, how: '无异地副本，站点级灾难无法恢复', gap: '无异地备份 / 异地备库' }
          : { cap: CAP.unknown, how: '异地副本情况需运维确认', gap: '未知' },
    evidence: (f) => [`备库=${f.hasStandby ? '有' : '无'}`, `异地副本=${f.offsiteCopy === null ? '未提供' : f.offsiteCopy}`],
  },
];

/** 逐场景评估。 */
export function assessScenarios(facts) {
  const f = facts ?? {};
  return SCENARIOS.map((s) => {
    const r = s.assess(f) ?? { cap: CAP.unknown, how: '未判定' };
    return {
      id: s.id,
      group: s.group,
      name: s.name,
      need: s.need,
      cap: r.cap,
      how: r.how,
      gap: r.gap ?? null,
      external: Boolean(r.external),
      evidence: (s.evidence ? s.evidence(f) : []).filter(Boolean),
    };
  });
}

/**
 * 由场景结果生成分级。
 *
 * **分级的依据是「哪个场景救不了」，不是「哪个参数没设」。** 这是本次重构的要点：
 * 参数齐全但救不了，仍然是严重问题。
 */
export function gradeScenarios(scenarios) {
  const g = [];
  const worst = scenarios.filter((s) => s.cap === CAP.none);
  const partial = scenarios.filter((s) => s.cap === CAP.partial);
  const unknown = scenarios.filter((s) => s.cap === CAP.unknown);

  if (worst.length > 0) {
    g.push({
      level: 'crit',
      title: `${worst.length} 个恢复场景**当前救不回来**`,
      detail:
        worst.map((s) => `${s.id} ${s.name}`).join('；') +
        '。这不是"参数没调好"，而是在这些故障真实发生时没有可用手段 —— 请优先处理。',
    });
  }
  // 最高频的一类单独点出来（损失最小、代价却最大，通常是最划算的改进）
  const a1 = scenarios.find((s) => s.id === 'A1');
  if (a1 && a1.cap === CAP.none) {
    g.push({
      level: 'crit',
      title: '最高频的误删 / 误改场景没有快速恢复手段',
      detail:
        '单条记录误删是最常见的事故，而当前既无闪回、也无法时间点恢复。' +
        '开启 ENABLE_FLASHBACK 通常不需要额外硬件，是性价比最高的一项改进。',
    });
  }
  if (partial.length > 0) {
    g.push({
      level: 'warn',
      title: `${partial.length} 个场景**只能粗粒度恢复**`,
      detail:
        partial.map((s) => `${s.id} ${s.name}`).join('；') +
        '。能救，但代价是回退整库、丢掉事故之后的全部改动 —— 请评估业务能否承受。',
    });
  }
  if (unknown.length > 0) {
    g.push({
      level: 'unknown',
      title: `${unknown.length} 个场景**无法从库内判定**`,
      detail:
        unknown.map((s) => `${s.id} ${s.name}`).join('；') +
        '。这些场景缺少库内可得的判据，需要运维确认（报告中已标出所需命令/信息）；' +
        '其中与备份/日志有关的两项，配了 OS 访问参数后插件可以自己取回实测结论。',
    });
  }
  return g;
}

/** 渲染场景矩阵（Markdown）。这是新版报告的主干。 */
export function renderScenarioMatrix(scenarios) {
  const L = [];
  const groups = [...new Set(scenarios.map((s) => s.group))];
  for (const grp of groups) {
    L.push(`### ${grp}`);
    L.push('');
    L.push('| # | 恢复场景 | 当前能力 | 靠什么救 / 为什么救不了 | 缺口 |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const s of scenarios.filter((x) => x.group === grp)) {
      L.push(`| ${s.id} | ${s.name} | **${CAP_LABEL[s.cap]}** | ${s.how} | ${s.gap ?? '—'} |`);
    }
    L.push('');
  }
  const c = (k) => scenarios.filter((s) => s.cap === k).length;
  L.push(
    `**合计**：可恢复 ${c(CAP.ok)} 项、仅能粗粒度恢复 ${c(CAP.partial)} 项、` +
      `**不可恢复 ${c(CAP.none)} 项**、无法判定 ${c(CAP.unknown)} 项` +
      // 「不适用」单列：它是"本库不存在这个灾种"，**既不是问题也不是判定失败**
      (c(CAP.na) > 0 ? `、不适用 ${c(CAP.na)} 项` : '') +
      `，共 ${scenarios.length} 个场景。`,
  );
  L.push('');
  L.push('> 判定只依据实测事实。「无法判定」一律不写成「没问题」——留白会被读成安全。');
  if (c(CAP.na) > 0) {
    L.push(
      '> 「**不适用**」是第三类：本库不存在那个灾种（例如单实例上谈不上「DMDSC 单节点故障」）——' +
        '它既不是问题，也不是「没查到」，因此**不进分级**。',
    );
  }
  return L.join('\n');
}

/** 渲染证据明细（把每个场景依赖的实测值摊开）。 */
export function renderScenarioEvidence(scenarios) {
  const L = [];
  L.push('| # | 场景 | 依赖的实测值 |');
  L.push('| --- | --- | --- |');
  for (const s of scenarios) {
    L.push(`| ${s.id} | ${s.name} | ${s.evidence.length ? s.evidence.join('；') : '—'} |`);
  }
  return L.join('\n');
}

/** 排序辅助：把最严重的场景排前面（报告需要）。 */
export function sortBySeverity(scenarios) {
  return [...scenarios].sort((a, b) => RANK[a.cap] - RANK[b.cap] || a.id.localeCompare(b.id));
}

// ===========================================================================
// 结构化条件 + 可执行建议（DESIGN §20）
//
// 为什么建议单独放一张表：A1/A2/A3 都需要「开闪回」这条建议。
// 若把建议文本写在每个场景里，一处改了别处不改 —— 这个项目已经吃过好几次这种亏
// （`need` 与 `gap` 就是两处独立维护的文本）。所以**建议按"要改的东西"索引，不按场景**。
//
// ★ 三条纪律（否则"推荐调整建议"极易变成拍脑袋）：
//   1. `param` 只写**本项目实测确认存在**的参数名。已栽过两次：`PAGE_CHECK` 不在
//      `V$DM_INI` 里、`BAK_SAFE_CHECK` 列不存在。推荐一个不存在的参数比不推荐更糟。
//   2. `cost` 必须写。有些建议有反作用 —— 最典型是 `ARCH_HANG_FLAG=1`：
//      它保证不丢归档，但归档写入失败时**数据库会挂起**。
//   3. 没核实的就写"未核实"，不要顺手补一句听起来专业的解释。
// ===========================================================================

export const ADVICE = {
  FLASHBACK: {
    param: 'ENABLE_FLASHBACK',
    how: '在 dm.ini 设 `ENABLE_FLASHBACK = 1`，**需重启实例**。',
    buys: 'A1/A2/A3 三类**最高频**事故（误删记录、误 DROP 表、批量误 UPDATE）从「整库回退、丢掉事故后全部改动」变成「一条 SQL 定位并还原」。',
    cost: '需要 undo 空间；可闪回的时间窗受 undo 保留限制。本库 `UNDO_RETENTION` 的**单位与语义本项目未核实**，不据此下结论。',
    verified: true,
  },
  RECYCLEBIN: {
    param: 'RECYCLEBIN',
    how: '在 dm.ini 设 `RECYCLEBIN = 1`（实测该参数存在，本库为 0）。',
    buys: '误 DROP / TRUNCATE 的表可以先从回收站捞回来，再考虑整库回退。',
    cost: '回收站占用字典与存储空间；保留策略需另行确认。',
    verified: true,
  },
  ARCH_ON: {
    param: 'ARCH_INI',
    how: '配置 dmarch.ini 的 LOCAL 归档并设 `ARCH_INI = 1`。',
    buys: '得到**时间点恢复**能力 —— 本项目里**优先级最高**的一项，比任何检测功能都更救命。',
    cost: '需要额外的归档磁盘空间与备份窗口；归档写入失败时的行为由 `ARCH_HANG_FLAG` 决定（见下）。',
    verified: true,
  },
  /**
   * （原 `TARGET_REACH`「你要的那个点/段够不到」——**已随「恢复需求达成度」整项移除**，
   *  2026-10-13，DESIGN §29.10。那条建议服务的是"恢复到**你要的**那个点"，需求整项移除后
   *  没有"你要的点"可言，条件表里也就不再挂这一行。）
   */
  ARCH_STANDBY: {
    param: '（需搭建数据守护，不是单个参数）',
    how: '搭建数据守护备库（dmwatcher / dmmal / dmarch 一整套），使 `V$RAPPLY_SYS` / `V$ARCH_SEND_INFO` 有记录。',
    buys: '① 单页损坏可**在线修复**（向备库借干净页）；② 主库故障可切换。',
    cost: '需要第二套实例与网络。DMDSC 是共享存储、**借不到干净对端页**，此项对它无效。',
    verified: true,
  },
  CTL_BAK: {
    param: 'CTL_BAK_PATH / CTL_BAK_NUM',
    how: '在 dm.ini 设 `CTL_BAK_PATH` 与 `CTL_BAK_NUM > 0`。',
    buys: '控制文件损坏时可自动找回，不需要从备份整库还原。',
    cost: '占用少量磁盘；数量按恢复窗口需要设置。',
    verified: true,
  },
  ARCH_HANG_FLAG: {
    param: 'ARCH_HANG_FLAG',
    how: '在每个 LOCAL 归档目标（dmarch.ini）上设 `ARCH_HANG_FLAG = 1`。',
    buys: '归档写入失败后**挂起并反复重试**，不会静默丢归档。',
    cost: '⚠️ **代价是数据库会挂起** —— 归档盘满时实例会卡住，需要人工介入。这是「不丢数据」换「可用性」。',
    verified: true,
  },
  ARCH_REDUNDANCY: {
    param: '（需增加归档目标）',
    how: '增加第二个归档目标（LOCAL + REMOTE，或写到不同存储）。',
    buys: '单个归档目录损坏时，还有另一份可继续恢复。',
    cost: '归档 IO 与空间翻倍。',
    verified: true,
  },
  BACKUP_REDUNDANCY: {
    param: '（需调整备份策略，不是单个参数）',
    how: '保留多份全备（例如全备 + 定期增量），并定期 `dmrman CHECK BACKUPSET` 校验 —— **只备份不校验等于没备**。',
    buys: '一份备份损坏时还有后备；校验过才知道它真能读出来。',
    cost: '需要额外存储与校验窗口（实测单次校验约 2 秒，代价很低）。',
    verified: true,
  },
  BACKUP_VERIFY: {
    param: 'dmrman CHECK BACKUPSET',
    how: '在数据库主机上跑 `dmrman CTLSTMT="CHECK BACKUPSET \'<备份集路径>\'"`。',
    buys: '把「库认为备份存在」变成「备份确实可读」—— 前者只是控制文件里的账本，后者才是能不能恢复。',
    cost: '实测单次约 2 秒的只读校验。注意：**备份在 ASM 上时独立 dmrman 需要先配好 ASM 访问**，否则会报「无效的备份集目录」，那不是备份损坏。',
    verified: true,
  },
  OFFSITE: {
    param: '（运维流程，不是数据库参数）',
    how: '把备份与归档再复制一份到**不同存储 / 不同机器**。',
    buys: '整机、存储、站点级故障时仍有可用副本。',
    cost: '需要异机存储与传输通道。',
    verified: true,
  },
  RLOG_MIRROR: {
    param: '（需重建联机日志组为多成员）',
    how: '把联机日志组配置为多成员（镜像）。',
    buys: '单个日志文件损坏时可由镜像成员顶替。',
    cost: '日志写入放大；需要停机重建日志组。',
    verified: true,
  },
};

/**
 * 按场景 id 索引的结构化条件。
 *
 * **刻意与 `SCENARIOS` 分开**：SCENARIOS 是能力判定（已稳定），这里是「要求 vs 实际」的展示层。
 * 没在这里出现的场景会自动退回旧样式 —— 所以可以**一条一条慢慢转**，不必一次性全改。
 */
export const COND_SPECS = {
  A1: (f) => [
    { key: 'FLASHBACK', name: '闪回', require: 'ENABLE_FLASHBACK = 1', actual: `ENABLE_FLASHBACK = ${f.enableFlashback ?? '未取到'}`, met: f.enableFlashback === '1' },
    tpCond(f),
  ],
  A2: (f) => [
    { key: 'FLASHBACK', name: '闪回表', require: 'ENABLE_FLASHBACK = 1', actual: `ENABLE_FLASHBACK = ${f.enableFlashback ?? '未取到'}`, met: f.enableFlashback === '1' },
    { key: 'RECYCLEBIN', name: '回收站', require: 'RECYCLEBIN = 1', actual: `RECYCLEBIN = ${f.recyclebinEnabled === true ? '1' : f.recyclebinEnabled === false ? '0' : '未取到'}`, met: f.recyclebinEnabled === true },
    tpCond(f),
  ],
  A3: (f) => [
    { key: 'FLASHBACK', name: '闪回查询', require: 'ENABLE_FLASHBACK = 1', actual: `ENABLE_FLASHBACK = ${f.enableFlashback ?? '未取到'}`, met: f.enableFlashback === '1' },
    tpCond(f),
  ],
  // ★ A4/A5 原先**没有**结构化的条件表（渲染成「（本节尚未结构化）」）——
  //   而它们恰是判定为「仅能粗粒度恢复」的场景，读者看不到"到底缺什么"。
  A4: (f) => [tpCond(f, '时间点恢复（整库回退）'), logicalDumpCond()],
  A5: (f) => [tpCond(f, '时间点恢复（回退到改结构之前）'), logicalDumpCond()],
  B1: (f) => [
    { key: 'ARCH_STANDBY', name: '数据守护备库', require: '存在备库（可借干净页）', actual: `备库 = ${f.hasStandby ? '有' : '无'}`, met: Boolean(f.hasStandby) },
    archOnCond(f, '退路：时间点恢复'),
  ],
  // ★ B2 也是「可恢复」的场景，同样缺条件表 —— 读者无法核对那个 ✅ 靠什么成立。
  B2: (f) => [tpCond(f, '时间点恢复（可只还原该文件）', '全备 + 归档连续（可只还原该文件）')],
  B3: (f) => [
    { key: 'CTL_BAK', name: '控制文件自动备份', require: 'CTL_BAK_PATH 已配 且 CTL_BAK_NUM > 0', actual: `CTL_BAK_PATH=${f.ctlBakPath ?? '未配置'} ／ CTL_BAK_NUM=${f.ctlBakNum ?? '未配置'}`, met: Boolean(f.ctlBakPath) && Number(f.ctlBakNum) > 0 },
  ],
  B4: (f) => [
    { key: 'RLOG_MIRROR', name: '联机日志镜像', require: '同一日志组有多个成员', actual: `镜像 = ${f.rlogMirrored === true ? '有' : f.rlogMirrored === false ? '无' : '未判定'}`, met: f.rlogMirrored === true },
    archOnCond(f, '退路：可重建'),
  ],
  B5: (f) => [
    { key: 'ARCH_REDUNDANCY', name: '归档冗余', require: '归档目标 ≥ 2（互为冗余）', actual: `归档目标数 = ${f.archiveTargets ?? '未取到'}`, met: Number(f.archiveTargets) >= 2 },
  ],
  B6: (f) => [
    { key: 'BACKUP_REDUNDANCY', name: '备份冗余', require: '备份份数 ≥ 2（本场景假设「备份损坏」，需要有后备）', actual: `备份份数 = ${f.backupsCount ?? '未取到'}`, met: Number(f.backupsCount) >= 2 },
    { key: 'BACKUP_VERIFY', name: '备份已校验', require: '至少一份经 dmrman CHECK BACKUPSET 校验通过', actual: `已校验 = ${f.backupVerified === true ? '是' : f.backupVerified === false ? '**校验失败**' : '未校验 / 无法判定'}`, met: f.backupVerified === true },
  ],
  B7: (f) => [
    { key: 'OFFSITE', name: '异地 / 异存储副本', require: '备份与归档不与数据同存储', actual: `备份路径 = ${f.bakPath ?? '未取到'} ／ 异地副本 = ${f.offsiteCopy === true ? '有' : f.offsiteCopy === false ? '**无（同存储）**' : '未判定'}`, met: f.offsiteCopy === true },
  ],
  // ★ B8 同样缺条件表。
  B8: (f) => [tpCond(f, '时间点恢复', '时间点恢复')],
  // ★ C1：「本库不是多节点」是**不适用**，不是「未满足」——
  //   旧代码把它渲染成「✅ 该场景所需条件全部满足」，与同一张表里的 ❌ 直接打架。
  C1: (f) => {
    const n = Number(f.dscNodes);
    const state = Number.isFinite(n) && n > 1 ? COND.MET : n === 1 ? COND.NA : COND.UNKNOWN;
    return [
      cond(
        'DSC',
        '多节点集群',
        'DSC_NODES > 1 且各节点均正常',
        `DSC_NODES = ${f.dscNodes ?? '未取到'}，本次检查 ${f.checkedNodes ?? '—'} 个节点`,
        state,
      ),
    ];
  },
  C2: (f) => [
    archOnCond(f, '可重建'),
    { key: 'OFFSITE', name: '异地副本', require: '备份不在与数据同一存储上', actual: `异地副本 = ${f.offsiteCopy === true ? '有' : f.offsiteCopy === false ? '**无（同存储）**' : '未判定'}`, met: f.offsiteCopy === true },
  ],
  C3: (f) => [
    { key: 'OFFSITE', name: '异地副本 / 异地备库', require: '存在异地备份或异地备库', actual: `备库 = ${f.hasStandby ? '有' : '无'} ／ 异地副本 = ${f.offsiteCopy === true ? '有' : f.offsiteCopy === false ? '**无**' : '未判定'}`, met: f.offsiteCopy === true },
  ],
};

/**
 * （原 `targetCond(f)`「恢复到**你要的**那个点/段」先决条件行 —— 已随「恢复需求达成度」
 *  **整项移除**，2026-10-13，DESIGN §29.10。`facts.targetRequirement` 不再产生，
 *  条件表里也就不再挂这一行；条件表只回答"这套库有没有这条路"，
 *  不再回答"这条路通不通到某个具体的点"。）
 */

/** 求值条件规格，并把未满足项映射到建议。 */
export function assessConditions(scenarios, facts) {
  const f = facts ?? {};
  return scenarios.map((s) => {
    const spec = COND_SPECS[s.id];
    const conds = (spec ? spec(f) : []).map(withState);
    const unmet = conds.filter((c) => c.state === COND.UNMET);
    // 「未取到」与「不适用」各自成集合 —— 它们**不是缺口**，也**不是满足**。
    const unknowns = conds.filter((c) => c.state === COND.UNKNOWN);
    const naConds = conds.filter((c) => c.state === COND.NA);
    return {
      ...s,
      conds,
      unmet,
      unknowns,
      naConds,
      // 未满足项里**拿不到可执行建议**的那些：必须显式说出来，
      // 否则下游会因为它"没有建议"而误判成"没有缺口"（C1 那个矛盾的成因）。
      unmetNoAdvice: unmet.filter((c) => !(ADVICE[c.key] ?? {}).how),
      advice: unmet.map((c) => ({ key: c.key, name: c.name, ...(ADVICE[c.key] ?? {}) })).filter((a) => a.how),
    };
  });
}

/**
 * 逐场景渲染成块：**条件表（要求 vs 实际 vs 满足）+ 仅针对未满足项的调整建议**。
 * 这是报告的主干形态（DESIGN §20）。未结构化的场景退回旧样式，不丢信息。
 */
export function renderScenarioBlocks(list) {
  const L = [];
  const groups = [...new Set(list.map((s) => s.group))];
  for (const grp of groups) {
    L.push(`### ${grp}`);
    L.push('');
    for (const s of list.filter((x) => x.group === grp)) {
      L.push(`#### ${s.id}　${s.name}`);
      L.push('');
      L.push(`**当前能力：${CAP_LABEL[s.cap]}**`);
      L.push('');
      L.push('| 条件 | 要求 | 本库实际 | 满足 |');
      L.push('| --- | --- | --- | --- |');
      if (s.conds && s.conds.length > 0) {
        for (const c of s.conds) L.push(`| ${c.name} | ${c.require} | ${c.actual} | ${COND_MARK[c.state]} |`);
        if (s.conds.length < (s.need?.length ?? 0)) {
          // 条件表比场景声明的需求项少：把没结构化的那些**照旧列出来**，不静默少一行。
          for (const n of s.need.slice(s.conds.length)) L.push(`| — | ${n} | （本节尚未结构化） | — |`);
        }
      } else {
        for (const n of s.need) L.push(`| — | ${n} | （本节尚未结构化） | — |`);
      }
      L.push('');
      L.push(`- 靠什么救：${s.how}`);
      if (s.gap) L.push(`- 缺口：${s.gap}`);
      if (s.advice && s.advice.length > 0) {
        // ★ 去重（DESIGN §26.3）：这里**只给指针**，建议正文统一放在「该改的 N 件事」一节。
        //   旧版把「能买到什么 / 代价」在每个场景里各印一遍 —— 同一条 ENABLE_FLASHBACK 建议
        //   在 A1/A2/A3 出现三次、异地副本在 B7/C2/C3 出现三次，读者把同一段话读五遍。
        const plan = advicePlan(list);
        L.push('');
        L.push(
          `- → 建议：${s.advice
            .map((a) => `**${plan.label(a.key) ?? a.name}**（${a.name}）`)
            .join('；')} —— 怎么做 / 买到什么 / 代价 见「该改的 N 件事」`,
        );
      }
      // ★ 未满足但**没有可执行建议**的项：必须显式列出。
      //   旧代码在这种情况下走到「✅ 全部满足」，而表里明明有 ❌ —— 自相矛盾。
      if (s.unmetNoAdvice && s.unmetNoAdvice.length > 0) {
        L.push('');
        L.push(
          `- ⚠️ 另有 ${s.unmetNoAdvice.length} 项**未满足，但本插件没有对应的可执行建议**` +
            '（属架构 / 环境层面，不是改个参数能补的）：',
        );
        for (const c of s.unmetNoAdvice) L.push(`  - ${c.name}（要求：${c.require}）`);
      }
      // ★ 小结只在**真的没有未满足项**时才说「满足」；「未取到」与「不适用」各有各的说法。
      if (s.unmet.length === 0) {
        L.push('');
        if (s.unknowns?.length > 0) {
          L.push(
            `- ❔ 未发现未满足项；另有 ${s.unknowns.length} 项**无法从库内观测**` +
              `（${s.unknowns.map((c) => c.name).join('、')}）—— **未取到不等于满足**，请人工确认。`,
          );
        } else if (s.naConds?.length > 0) {
          L.push(
            `- — 该场景在本库**不适用**：${s.naConds.map((c) => c.name).join('、')}` +
              ' 标「—」的条件既不算满足、也不算缺口（本库不存在这个灾种）。',
          );
        } else if (s.conds && s.conds.length > 0) {
          L.push('- ✅ 该场景所需条件**全部满足**。');
        }
      }
      L.push('');
    }
  }
  return L.join('\n');
}

/** 序号用圈码，正文里读起来比 `#1` 清楚。 */
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];

/**
 * 「该改的 N 件事」—— 把建议按**要改的东西**去重并编号（DESIGN §26.3）。
 *
 * 为什么要有它：`ADVICE` 表本来就是共享对象（一条 ENABLE_FLASHBACK 覆盖 A1/A2/A3），
 * 但**渲染层以前每个场景各印一遍** —— 数据复用了、呈现没有。真机报告里
 * 「异地副本」那条在 B7/C2/C3 各出现一次（含"买到什么/代价"整段）。
 *
 * **纯函数、可重复调用**：渲染场景块与渲染建议表各自调用它，得到的编号一定一致
 * （刻意不靠跨函数状态 —— 状态会不同步，而编号不一致比重复更糟）。
 */
export function advicePlan(rich) {
  const items = [];
  const indexOf = new Map();
  for (const s of rich ?? []) {
    for (const a of s.advice ?? []) {
      if (!a.how) continue;
      if (!indexOf.has(a.key)) {
        indexOf.set(a.key, items.length);
        items.push({ key: a.key, names: [a.name], how: a.how, buys: a.buys, cost: a.cost, scenarios: [] });
      }
      const it = items[indexOf.get(a.key)];
      if (!it.scenarios.includes(s.id)) it.scenarios.push(s.id);
      if (!it.names.includes(a.name)) it.names.push(a.name);
    }
  }
  return {
    items,
    indexOf,
    label: (key) => (indexOf.has(key) ? CIRCLED[indexOf.get(key)] ?? `#${indexOf.get(key) + 1}` : null),
  };
}

/**
 * 渲染「该改的 N 件事」：每件事**只出现一次**，并列出它影响哪些场景。
 * 这一节取代了以前散在 16 个场景块里的重复建议。
 */
export function renderAdviceList(rich) {
  const plan = advicePlan(rich);
  if (plan.items.length === 0) {
    return '本轮**没有需要改的东西** —— 没有未满足项，或未满足项都不是"改个参数/加个设备"能解决的（后者见各场景的「未满足但没有可执行建议」）。';
  }
  const L = [];
  L.push(
    `按「**要改的东西**」去重后共 **${plan.items.length}** 件事（场景共 16 个）—— ` +
      '一件事可能同时解决多个场景，所以**先看这里，再回场景表**。',
  );
  L.push('');
  plan.items.forEach((it, i) => {
    L.push(`#### ${CIRCLED[i] ?? `#${i + 1}`} ${it.names.join(' / ')}`);
    L.push('');
    L.push(`- **怎么做**：${it.how}`);
    L.push(`- **能买到什么**：${it.buys}`);
    L.push(`- **代价**：${it.cost}`);
    L.push(`- **影响的场景**：${it.scenarios.join('、')}`);
    L.push('');
  });
  return L.join('\n').trim();
}

/** 报告开头的「最要紧的几件事」——按严重度排序取前 N 条，指向建议编号。 */
export function renderTopActions(list, n = 5) {
  const plan = advicePlan(list);
  const picks = sortBySeverity(list)
    .filter((s) => s.cap === CAP.none || s.cap === CAP.partial)
    .slice(0, n);
  if (picks.length === 0) return '本轮未发现「不可恢复」或「仅能粗粒度恢复」的场景。';
  const L = [];
  for (const s of picks) {
    const refs = [...new Set((s.unmet ?? []).map((c) => plan.label(c.key)).filter(Boolean))];
    L.push(
      `- **${s.id} ${s.name}**（${CAP_LABEL[s.cap]}）` +
        (s.gap ? `｜缺口：${s.gap}` : '') +
        // 只给指针，不重复正文（正文在「该改的 N 件事」里）
        (refs.length > 0 ? `　→ 建议 ${refs.join('、')}` : ''),
    );
  }
  L.push('');
  L.push('> 每条建议的「怎么做 / 能买到什么 / 代价」见下一节「该改的 N 件事」—— 那里**同一件事只说一次**。');
  return L.join('\n');
}
