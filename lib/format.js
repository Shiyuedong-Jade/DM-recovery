/**
 * 结果**骨架** —— 六个 action 的正文一律按同一四层渲染（DESIGN §24）。
 *
 * 在它之前，每个 action 的正文形态都是各写各的：
 * `backup` 用「一、二、三…」中文序号，`readiness` 没有编号，`list`/`triage` 又是另一套；
 * 而且**「结论 / 依据 / 边界说明 / 免责」四种东西混在同一层** ——
 * 那些很长的 `>` 引用块会把结论淹掉（真机输出里 `backup` 的结论在第 60 行之后才出现）。
 *
 * 规范后的骨架（层名固定，层内可有小节）：
 *
 * ```
 * 达梦数据库可恢复能力评估 · <动作名>（<action>）
 *
 * ## 结论
 * [🔴 严重] 一句话
 *
 * ## 要点
 * - [🔴 严重] …
 *
 * ## 依据
 * ### 1. <小节>
 *
 * ## 边界与免责
 * - …
 * ```
 *
 * 两条实现约定：
 * 1. **`>` 引用块一律归入「边界与免责」**（`extractBoundaries`）——
 *    它们在原渲染器里是紧贴表格的注解，集中之后正文只剩结论与数据，扫码式阅读才成立。
 *    小节内若仍需一句提示，用 `注：…`（普通段落），不要再用引用块。
 * 2. **层名固定但不强制非空**：没有要点就不输出「## 要点」这一层，
 *    而不是输出一个空标题（空标题会让人以为漏了内容）。
 */

import { ACTION_LABEL, TOOL_TITLE, levelTag } from './vocab.js';

/**
 * 抹掉标题里**手写的序号**：`一、xxx` / `1. xxx` / `1、xxx` → `xxx`。
 *
 * 为什么：骨架自己会编号（`### N. 标题`）。报告那边的 section 标题本来就带
 * `一、二、…`（它是 HTML 里的 h2 序号），直接透传就会变成
 * `### 1. 一、最要紧的几件事` —— 真机首版正是这样。
 * **保留** `附录 A · …` 这类前缀（它不是序号，是分类）。
 */
export function stripManualNumber(title) {
  return String(title ?? '')
    .replace(/^[一二三四五六七八九十]+、\s*/, '')
    .replace(/^\d+\s*[.、)]\s*/, '')
    .trim();
}

/** 第 N 层的小节标题：`### 1. xxx`。 */
export function sectionTitle(n, title) {
  return `### ${n}. ${stripManualNumber(title)}`;
}

/** 列表记号（会被剥掉）：`· `、`- `、`* `、`1. `。 */
const MARK_LIST = /^([·•*\-]\s+|\d+[.)]\s+)/;
/** 「像一个条目」（含 emoji 标记）—— 用来判断一整块引用是不是条目列表。 */
const MARK_ANY = /^(?:[·•*\-]\s+|\d+[.)]\s+|(?:⚠️|❗|ℹ️|🔴|🟠|🔵|⚪|✅|❌|❔))/;

/**
 * 从一段行数组里**分出引用块**：`> …` 归入 boundaries，其余归 content。
 *
 * 三条来自真机验证的修正（第一版在这里踩了坑）：
 * 1. **连续的 `>` 行要合并成一条**。渲染器是把一段话**逐行** push 的
 *    （`L.push('> 上半句')` / `L.push('> 下半句')`），若每行各成一条，
 *    输出的项目符号会把一个句子拆成两条，读起来像断句。
 * 2. **引用块内的 `·` / `-` 要保留层级**（转成嵌套子项），不能拉平成同级。
 * 3. **空行不结束引用块**（渲染器常在块内插空行），只有**正文行**才结束它。
 */
export function extractBoundaries(lines) {
  const content = [];
  const blocks = [];
  let cur = null;
  for (const raw of lines) {
    const line = String(raw);
    if (/^\s*>\s?/.test(line)) {
      const text = line.replace(/^\s*>\s?/, '').trim();
      if (cur === null) {
        cur = [];
        blocks.push(cur);
      }
      if (text !== '') cur.push(text);
      continue;
    }
    if (line.trim() === '') {
      content.push(''); // 空行保留（它仍是段落分隔），但**不**结束引用块
      continue;
    }
    cur = null; // 真·正文行 → 结束当前引用块
    content.push(line);
  }
  const boundaries = blocks.flatMap((b) => {
    if (b.length === 0) return [];
    const firstMarked = MARK_ANY.test(b[0]);
    const restMarked = b.slice(1).filter((t) => MARK_ANY.test(t)).length;
    // 情形 A：**整块都是条目** → 每条一项（只剥列表记号，**保留 emoji 标记**）
    if (firstMarked && restMarked >= b.length - 1) {
      return b.map((t) => t.replace(MARK_LIST, '').trim()).filter(Boolean);
    }
    // 情形 B：**首行是父条目、其余是 `·` 子条目** → 做成一条 + 嵌套子项
    if (!firstMarked && restMarked >= 1 && restMarked >= b.length - 2) {
      const [head, ...tail] = b;
      const subs = tail.map((t) => `  - ${t.replace(MARK_LIST, '').trim()}`);
      return [[head, ...subs].join('\n')];
    }
    // 情形 C：**一段话被逐行 push** → 合并为一项，续行缩进
    const [head, ...tail] = b;
    const rest = tail.map((t) => (/^[·•*\-]\s+/.test(t) ? `  - ${t.replace(/^[·•*\-]\s+/, '')}` : `  ${t}`));
    return [[head, ...rest].join('\n')];
  });
  // 收敛连续空行，并去掉首尾空行（否则正文里会堆出一串空行）
  const tidy = [];
  for (const l of content) {
    if (l.trim() === '' && (tidy.length === 0 || tidy[tidy.length - 1].trim() === '')) continue;
    tidy.push(l);
  }
  while (tidy.length > 0 && tidy[tidy.length - 1].trim() === '') tidy.pop();
  const seenBlock = new Set();
  const uniq = boundaries.filter((b) => (seenBlock.has(b) ? false : (seenBlock.add(b), true)));
  return { content: tidy, boundaries: uniq };
}

/** 把一个要点渲染成一行：`- [🔴 严重] 文本`。 */
export function point(level, text) {
  const tag = levelTag(level);
  return `- ${tag ? `[${tag}] ` : ''}${text}`;
}

/**
 * 把已有的 Markdown 按它自己的 `## ` 标题**拆成小节**，并剥掉中文序号。
 *
 * 为什么需要它：`renderBackup` 内部已经写好「## 一、库的账本里有什么」这类小节，
 * 而新骨架要求这些变成「### 1. 库的账本里有什么」的一层。
 * 与其把那个两百行的渲染器按新签名重写一遍（风险大），不如**按标题拆分**——
 * 一处实现，六个渲染器都规范掉了。
 *
 * 没有 `## ` 标题的正文（如 `renderList`）整体作为一节，标题由调用方给。
 */
export function splitH2Sections(md, fallbackTitle = '明细') {
  const text = String(md ?? '');
  const parts = text.split(/^## /m).map((s) => s.trim()).filter((s) => s !== '');
  if (parts.length === 0) return [];
  const hasH2 = /^## /m.test(text);
  if (!hasH2) return [{ title: fallbackTitle, body: text }];
  return parts.map((p) => {
    const [first, ...rest] = p.split('\n');
    return { title: stripManualNumber(first), body: rest.join('\n') };
  });
}

/**
 * 组装规范正文。
 *
 * @param {object} o
 * @param {string} o.action       六个 action 之一（用于标题里的动作名）
 * @param {string} [o.level]      总体等级（`crit/warn/info/unknown`）；没有权威分级时**不要编**
 * @param {string} [o.conclusion] 一句话结论
 * @param {string[]} [o.meta]     「结论」层里的补充行（目标实例、时间等）
 * @param {string[]} [o.points]   要点（用 `point()` 造，已带记号）
 * @param {Array<{title:string, body:string}>} [o.sections] 「依据」层的小节
 * @param {string[]} [o.boundaries] 额外的边界/免责条目（与从 sections 里抽出的合并、去重）
 */
export function renderResult({ action, level, conclusion, meta = [], points = [], sections = [], boundaries = [] }) {
  const L = [];
  L.push(`${TOOL_TITLE} · ${ACTION_LABEL[action] ?? action}（${action}）`);
  L.push('');

  // ---- 结论 ----
  L.push('## 结论');
  L.push('');
  if (conclusion) {
    const tag = levelTag(level);
    L.push(`${tag ? `**[${tag}]** ` : ''}${conclusion}`);
  } else {
    L.push('（本次没有可下的一句话结论）');
  }
  // 补充信息**不用项目符号**：项目符号留给「要点」层。
  // （第一版用了 `- `，结果读者分不清哪条是结论的补充、哪条是要点。）
  if (meta.length > 0) {
    L.push('');
    L.push(meta.join(' ｜ '));
  }
  L.push('');

  // ---- 要点 ----
  if (points.length > 0) {
    L.push('## 要点');
    L.push('');
    for (const p of points) L.push(p);
    L.push('');
  }

  // ---- 依据 ----
  const cleanSections = (sections ?? []).filter((s) => s && String(s.body ?? '').trim() !== '');
  const collected = [...boundaries];
  if (cleanSections.length > 0) {
    L.push('## 依据');
    L.push('');
    cleanSections.forEach((s, i) => {
      const { content, boundaries: b } = extractBoundaries(String(s.body).split('\n'));
      collected.push(...b);
      L.push(s.title ? sectionTitle(i + 1, s.title) : sectionTitle(i + 1, '明细'));
      L.push('');
      // 去掉小节首尾的空行，避免堆积
      while (content.length > 0 && content[0].trim() === '') content.shift();
      while (content.length > 0 && content[content.length - 1].trim() === '') content.pop();
      L.push(content.join('\n'));
      L.push('');
    });
  }

  // ---- 边界与免责 ----
  const seen = new Set();
  const bs = collected
    .map((b) => String(b).replace(/\s+$/, ''))
    .filter((b) => b !== '' && !seen.has(b) && (seen.add(b), true));
  if (bs.length > 0) {
    L.push('## 边界与免责');
    L.push('');
    for (const b of bs) {
      // 多行条目（引用块合并来的）缩进成同一条目的续行，避免被当成并列要点
      const [head, ...rest] = b.split('\n');
      L.push(`- ${head}`);
      for (const r of rest) L.push(r);
    }
    L.push('');
  }
  return L.join('\n');
}
