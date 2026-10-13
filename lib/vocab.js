/**
 * 输出词表 —— **全插件唯一一份**（DESIGN §24）。
 *
 * 为什么要单独一个模块：在它之前，同一份报告里并存**三套词表**，读者得自己映射：
 *   ① 分级：`crit/warn/info/unknown` → 严重/警告/提示/未取到
 *   ② 场景能力：`ok/partial/none/unknown` → 可恢复/仅能粗粒度恢复/不可恢复/无法判定
 *   ③ 条件满足：`met/unmet/unknown/na` → ✅/❌/❔/—
 * 三套都**保留**（它们各自回答不同的问题，合成一套反而会丢信息），
 * 但从此**只有一个定义处、一张对照表**，渲染层一律从这里取词。
 *
 * ⚠️ 纪律：**不认识的值一律原样输出**，不映射成"看起来对"的词。
 *    （把没见过的取值硬塞进某个档位，就是凭空造结论。）
 *
 * 记号分两族：**分级**独占 🔴/🟠/🔵/⚪；能力 / 条件 / 需求共用 ✅/❌(🚨)/❔/—，
 * 靠中文词区分维度（同一个 ✅ 在条件表里读「已满足」、在需求表里读「满足」）。
 */

// ---------------------------------------------------------------------------
// ① 分级（用于「结论/要点」的严重度）
// ---------------------------------------------------------------------------

/** 顺序即排序优先级。 */
export const LEVEL_ORDER = ['crit', 'warn', 'info', 'unknown'];

export const LEVEL_LABEL = { crit: '严重', warn: '警告', info: '提示', unknown: '未取到' };

/** 记号：一档一个，且与中文词一一对应（同一个记号不再兼表两种意思）。 */
export const LEVEL_MARK = { crit: '🔴', warn: '🟠', info: '🔵', unknown: '⚪' };

/** 渲染一个分级标签，如 `🔴 严重`。不认识的值原样返回。 */
export function levelTag(lv) {
  if (!lv) return '';
  const label = LEVEL_LABEL[lv];
  return label ? `${LEVEL_MARK[lv]} ${label}` : String(lv);
}

// ---------------------------------------------------------------------------
// ② 场景能力档位（16 个恢复场景的判定结果）
// ---------------------------------------------------------------------------

export const CAP = { ok: 'ok', partial: 'partial', none: 'none', unknown: 'unknown', na: 'na' };

export const CAP_LABEL = {
  ok: '可恢复',
  partial: '仅能粗粒度恢复',
  none: '不可恢复',
  unknown: '无法判定',
  na: '不适用（本库不存在该灾种）',
};

/**
 * 能力档位记号：**故意与分级记号不同族**（能力用 ✅/⚠️/❌，分级用 🔴/🟠/🔵/⚪）。
 *
 * `na`（不适用）是**真机验证后补的第五态**：单实例上「DMDSC 单节点故障」这个灾种
 * 根本不存在 —— 判成 `unknown`（无法判定）会让人以为"工具没查到"，
 * 而事实是"这事跟你无关"。分级的依据是"哪个场景救不了"，所以 `na` **不进分级**。
 */
export const CAP_MARK = { ok: '✅', partial: '⚠️', none: '❌', unknown: '❔', na: '—' };

// ---------------------------------------------------------------------------
// ③ 条件满足四态（「要求 vs 本库实际」表里那一列）
// ---------------------------------------------------------------------------

export const COND = { MET: 'met', UNMET: 'unmet', UNKNOWN: 'unknown', NA: 'na' };

export const COND_LABEL = { met: '已满足', unmet: '未满足', unknown: '未取到', na: '不适用' };

/**
 * 条件列的标记。**四态各有各的记号** —— 尤其「未取到」不能长得像「未满足」：
 * 前者是没观测到，后者是真的缺口，混起来就是凭猜测报缺口。
 */
export const COND_MARK = { met: '✅', unmet: '❌', unknown: '❔', na: '—' };

// ---------------------------------------------------------------------------
// （原 ④「恢复需求达成度」词表 —— `REQ` / `REQ_LABEL` / `REQ_MARK` ——
//  已随该功能**整项移除**，2026-10-13，DESIGN §29.10。
//  词表是"唯一词表"：留着不再产生的词条，就等于在词表里宣称这个功能还在。）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ⑤ 结果骨架的四层（DESIGN §24）
// ---------------------------------------------------------------------------

/** 六个 action 的中文名（用于「结论」标题与报告小节）。 */
export const ACTION_LABEL = {
  readiness: '处置能力体检',
  list: '坏页清单',
  triage: '逐页分诊',
  capacity: '归档空间参数',
  backup: '备份可用性',
  report: '评估报告',
};

/** 工具正式名称 —— 只在**一个**地方写死。 */
export const TOOL_TITLE = '达梦数据库可恢复能力评估';

/**
 * 词表对照表（Markdown）。报告、README、DESIGN 共用一份，避免三处各写各的。
 */
export const VOCAB_TABLE = [
  ['维度', '机器值', '中文', '记号', '回答什么问题'],
  ['—', '—', '—', '—', '—'],
  ['分级', 'crit', LEVEL_LABEL.crit, LEVEL_MARK.crit, '这件事有多急'],
  ['分级', 'warn', LEVEL_LABEL.warn, LEVEL_MARK.warn, ''],
  ['分级', 'info', LEVEL_LABEL.info, LEVEL_MARK.info, ''],
  ['分级', 'unknown', LEVEL_LABEL.unknown, LEVEL_MARK.unknown, '没查到，不等于没问题'],
  ['场景能力', 'ok', CAP_LABEL.ok, CAP_MARK.ok, '这个恢复场景救得回来吗'],
  ['场景能力', 'partial', CAP_LABEL.partial, CAP_MARK.partial, ''],
  ['场景能力', 'none', CAP_LABEL.none, CAP_MARK.none, ''],
  ['场景能力', 'unknown', CAP_LABEL.unknown, CAP_MARK.unknown, ''],
  ['条件满足', 'met', COND_LABEL.met, COND_MARK.met, '该场景要求的这一条，本库满足了吗'],
  ['条件满足', 'unmet', COND_LABEL.unmet, COND_MARK.unmet, ''],
  ['条件满足', 'unknown', COND_LABEL.unknown, COND_MARK.unknown, ''],
  ['条件满足', 'na', COND_LABEL.na, COND_MARK.na, '本库不存在这个灾种（既非满足也非缺口）'],
];

/** 把词表渲染成 Markdown 表格。 */
export function renderVocabTable() {
  const [head, ...rows] = VOCAB_TABLE;
  const L = [];
  L.push(`| ${head.join(' | ')} |`);
  L.push(`| ${head.map(() => '---').join(' | ')} |`);
  for (const r of rows) L.push(`| ${r.join(' | ')} |`);
  return L.join('\n');
}
