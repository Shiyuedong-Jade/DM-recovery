/**
 * 结果信封（DESIGN §25）—— 六个 action 返回**同一个形状**。
 *
 * ## 为什么要它
 *
 * 在它之前，返回是 `{action, verdict, distinctPages, needAttention, text}`，而这三个标量字段
 * **语义随 action 变**：
 *
 * | action | `needAttention` 实际含义 | `distinctPages` |
 * | --- | --- | --- |
 * | `list` / `triage` | 需关注的坏页数 | 坏页数 |
 * | `backup` | **早于最近一次备份**的坏页数 | 坏页数 |
 * | `readiness`（成功） | **节点间配置不一致项数** | 恒 0 |
 * | `readiness`（连不上） | **连接失败的目标数** | 恒 0 |
 * | `capacity` | 恒 0 | 恒 0 |
 *
 * 一个字段承担五种含义，`verdict` 还是散文句 —— 别的工具没法消费。
 * 信封把这些拆成：**结论**（`level`/`conclusion`）、**要点**（`findings[]`）、
 * **事实**（`result`）、**环境**（`meta`）、**合计**（`summary`）、**正文**（`text`）。
 *
 * ## 稳定 ID：**语义 slug，不是流水号**
 *
 * 早先的想法是 `F-001 / R-01 / B-01` 这种顺序号，**被否掉了**：
 * 顺序号会随分级项的增删/排序而变，而 ID 的全部意义就是**跨次对比同一个结论**。
 * 所以 ID 取自**结论的语义身份**：
 *
 * ```
 * scenario.A1              16 个恢复场景（`SCENARIOS[].id` 是 A1..C3）
 * condition.A1.03          场景 A1 的第 3 个条件（两处都用，便于对照）
 * readiness.online-repair  处置路径（`judgeReadiness` 的 `paths[].id`，本来就有）
 * readiness.restore / active-scan / skip-page
 * page.4.0.50448           单个坏页：page.<TS_ID>.<FILE_ID>.<PAGE_NO>
 * backup.catalog / redundancy / verify / chain / time-lsn / pages-before / os-check / os-logscan / os-find
 * archive.params / node-factor
 * form.deployment / form.consistency / form.coverage
 * grade.crit / grade.warn / grade.info / grade.unknown
 * ```
 *
 * 契约：**ID 一旦发布不再改名**；新增结论用新 ID；某次没这条结论就不出现（而不是换个号）。
 */

export const TOOL_ID = 'dm_recovery_readiness';
export const RESULT_VERSION = 1;

/** 稳定 ID 生成器。见文件头的命名表。 */
export const ID = {
  scenario: (sid) => `scenario.${sid}`,
  condition: (sid, n) => `condition.${sid}.${String(n).padStart(2, '0')}`,
  readiness: (slug) => `readiness.${slug}`,
  page: (tsId, fileId, pageNo) => `page.${tsId}.${fileId}.${pageNo}`,
  pages: (slug) => `pages.${slug}`,
  backup: (slug) => `backup.${slug}`,
  archive: (slug) => `archive.${slug}`,
  form: (slug) => `form.${slug}`,
  grade: (level) => `grade.${level}`,
  // ★ `req`（`req.rpo` / `req.target-time` / `req.target-window`）已随「恢复需求达成度」
  //   **整项移除**（2026-10-13，DESIGN §29.10）—— 命名空间、白名单项、结论项一起删干净。
  //   留着一个再也不产生的命名空间，等于对下一个读代码的人宣称这个功能还在。
};

/** 已发布的 ID 前缀（供自检断言"没有野 ID"）。 */
export const ID_NAMESPACES = ['scenario', 'condition', 'readiness', 'page', 'pages', 'backup', 'archive', 'form', 'grade'];

/** 各前缀允许的 slug（**白名单**：ID 是契约，不能随手造）。 */
export const ID_SLUGS = {
  readiness: ['online-repair', 'restore', 'active-scan', 'skip-page'],
  pages: ['none-found'],
  backup: [
    'catalog',
    'redundancy',
    'verify',
    // ★ `coverage` 是**漏登记**过的：代码里一直在用 `ID.backup('coverage')`（"最近一次备份与 redo 缺口"），
    //   而白名单里没有它 —— 离线自检查的是"我列出来的那些 ID 合不合规"，
    //   查不出"代码在用一个没登记的 slug"。真机回归脚本第一次跑就把它抓出来了（DESIGN §37.3）。
    //   现在 smoke 里加了一条**静态检查**：扫源码里所有 `ID.<ns>('<slug>')` 字面量都要在白名单内。
    'coverage',
    'chain',
    'time-lsn',
    'pages-before',
    'os-check',
    'os-logscan',
    'os-find',
  ],
  archive: ['params', 'node-factor'],
  form: ['deployment', 'consistency', 'coverage', 'credentials', 'connection'],
  grade: ['crit', 'warn', 'info', 'unknown'],
};

/**
 * 造一条结论项。
 *
 * `provenance` 是**留痕**（DESIGN §26）：这条结论是**工具验的**、还是**别人说的**？
 * 默认 `PROV.toolJdbc` —— 本插件绝大多数结论来自库内只读查询；
 * 凡不是这一类的（OS 只读命令、调用方声明、推导出来的汇总）都要**显式标明**。
 *
 * @param {string} id      稳定 ID（见命名表）
 * @param {string|null} level `crit`/`warn`/`info`/`unknown`；`null` = 纯陈述（不参与分级计数）
 */
export function finding(id, level, title, detail, evidence = [], advice = null, provenance = PROV.toolJdbc) {
  return {
    id,
    level: level ?? null,
    title: String(title ?? ''),
    detail: String(detail ?? ''),
    evidence: (evidence ?? []).map((e) => String(e)),
    provenance,
    ...(advice ? { advice } : {}),
  };
}

/**
 * 留痕语义（沿用 §4 F3.4 定的约定：`executedByTool` / `declaredByUser` / `verified`）。
 *
 * 为什么必须有：`backupVerified`（dmrman 校验结果）与 `hasStandby`（环境事实）以前混在同一个
 * `facts` 里 —— 消费方分不清「这条是工具亲手验的」还是「调用方说的、没人验过」。
 * 在"恢复能力评估"这件事上，这个区别**决定结论能不能被信任**：
 * 「你说你有备份」和「我连上去看过那个备份能读」不是一个可信度。
 */
export const PROV = {
  /** 库内只读查询（桥只放行 SELECT / WITH）。 */
  toolJdbc: {
    source: 'plugin-jdbc',
    executedByTool: true,
    declaredByUser: false,
    verified: true,
    via: '库内只读查询（桥只放行 SELECT）',
  },
  /** 插件在**数据库主机**上执行的只读命令（三条白名单命令之一）。 */
  toolOs: (command) => ({
    source: 'plugin-os-readonly',
    executedByTool: true,
    declaredByUser: false,
    verified: true,
    via: `OS 只读命令：${command}`,
  }),
  /** **调用方声明**的事实：工具没有验证过。 */
  userDeclared: (what) => ({
    source: 'user-declared',
    executedByTool: false,
    declaredByUser: true,
    verified: false,
    via: what,
  }),
  /** 由实测值**推导**出来的汇总（如分级、场景能力）。 */
  derived: (from) => ({
    source: 'derived',
    executedByTool: false,
    declaredByUser: false,
    verified: false,
    via: `由实测值推导：${from}`,
    derivedFrom: from,
  }),
};

/** 按等级合计结论项。`null` 等级的纯陈述不计入。 */
export function summarizeFindings(findings = []) {
  const byLevel = { crit: 0, warn: 0, info: 0, unknown: 0 };
  for (const f of findings) if (f.level && byLevel[f.level] !== undefined) byLevel[f.level] += 1;
  return { byLevel, total: findings.length };
}

/**
 * 总体等级 = 结论项里**最高的那一档**（严重度顺序即 `LEVEL_ORDER`）。
 *
 * 六个 action 原本各写一段三元表达式推等级 —— 六处同源判断迟早会各说各话
 * （真机验证时就出现过 readiness 报 crit 的假告警，见 §25.4）。收敛到这一处。
 *
 * 只有 `null` 级陈述时返回 `'info'`（"有结论但都不构成问题"）；
 * **完全没有结论项**才返回 `null`（= 无权威分级）。
 */
export function topLevelOf(findings = []) {
  const has = (lv) => findings.some((f) => f.level === lv);
  if (has('crit')) return 'crit';
  if (has('warn')) return 'warn';
  if (has('unknown')) return 'unknown';
  if (has('info') || findings.length > 0) return 'info';
  return null;
}

/**
 * 把值规整成**无损 JSON**（`JSON.parse(JSON.stringify(v))` 不丢东西）。
 *
 * ## 为什么要有这一层
 *
 * 宿主要求 tool 的返回值满足「无损 JSON」。而 `JSON.stringify` 对下面这些值都是**有损**的：
 *
 * | 值 | `JSON.stringify` 的行为 | 后果 |
 * | --- | --- | --- |
 * | `undefined` | 对象里**丢键**、数组里变 `null` | 往返后形状变了 → 宿主判 "value is not lossless JSON" |
 * | 函数 / symbol | 同上，直接丢 | 同上 |
 * | `NaN` / `Infinity` | 写成 `null` | 往返后数值变了 |
 * | `Date` | 写成字符串 | 往返后类型变了 |
 * | 循环引用 | **抛 TypeError** | 连序列化都做不到 |
 *
 * 被拒收的代价不是"少一个字段"，而是**整个 action 的结果作废** ——
 * 真机实测：账本为空的库上 `backup` / `report` 一律报 invalid output，
 * 而 HTML 其实已经落盘，用户看到的是"工具坏了"。
 *
 * 而库内实测值天然带这些：可空字段读出来就是 `undefined`（见 `backup.js`
 * `assessBackupCoverage` 的修复），比率类字段在分母为 0 时是 `Infinity`，
 * 时间字段有的是 `Date`。与其在六条 action 各自的构造点逐个记得处理
 * —— 那正是这次出问题的方式 —— 不如在**信封这一个出口**统一兜住。
 * 理由与 `topLevelOf` 收敛分级相同：同源判断散在多处，迟早各说各话。
 *
 * ⚠️ 这是**契约保证，不是数据修复**：`undefined` 被换成 `null` 只是让 JSON 表达得出来，
 * 「这个字段到底该不该有值」仍要在数据源修。两件事都要做，缺一不可。
 */
function toLossless(v, ancestors = new WeakSet()) {
  if (v === null) return null;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'number') return Number.isFinite(v) ? v : null;
  // undefined / function / symbol / bigint：JSON 表达不了 → null（数组元素也退成 null，不留洞）
  if (t !== 'object') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  // 只拦**祖先链**上的真环：同一对象被多处共享（DAG）是合法的，JSON 本来就会各自展开。
  if (ancestors.has(v)) return null;
  ancestors.add(v);
  const out = Array.isArray(v) ? [] : {};
  if (Array.isArray(v)) {
    for (const item of v) out.push(toLossless(item, ancestors));
  } else {
    for (const [k, val] of Object.entries(v)) out[k] = toLossless(val, ancestors);
  }
  ancestors.delete(v);
  return out;
}

/**
 * 组装信封。**六个 action 都必须经它返回**（`smoke.mjs` 有形状断言）。
 *
 * `legacy` 里放旧字段（`verdict`/`distinctPages`/`needAttention`）——
 * 保留一代做兼容：旧调用照常工作，但**新旧字段同源**（都由这里从同一批事实生成，
 * 不会出现"老字段说 A、新字段说 B"）。
 *
 * 返回值**保证是无损 JSON**（出口过一道 `toLossless`）—— 见该函数的说明。
 */
export function buildResult({
  action,
  level,
  conclusion = '',
  summary = null,
  findings = [],
  result = {},
  meta = {},
  disclaimer = '',
  text = '',
  reportPath,
  findingsPath,
  legacy = {},
  generatedAt = '',
  generatedAtSource = 'local',
}) {
  const env = {
    tool: TOOL_ID,
    resultVersion: RESULT_VERSION,
    action,
    generatedAt,
    generatedAtSource,
    // ★ 等级**由结论项派生**（`topLevelOf`）；显式传入只在极少数场合需要，且必须与 findings 一致。
    level: level ?? topLevelOf(findings),
    conclusion,
    summary: {
      ...summarizeFindings(findings),
      // 各 action 专属计数；没有的**显式给 null**（而不是缺键 —— 缺键会让消费者以为是 0）
      scenarios: summary?.scenarios ?? null,
      pages: summary?.pages ?? null,
      nodes: summary?.nodes ?? null,
      backups: summary?.backups ?? null,
      archiveContinuous: summary?.archiveContinuous ?? null,
      // ★ 这里原来还有 `requirements: summary?.requirements ?? null`（§29 的恢复需求达成度）。
      //   功能整项移除后**连这个键一起删掉**：留一个永远是 null 的键，消费者会以为
      //   "本次没给需求参数"，而事实是"这个功能不存在了" —— 两者不是同一件事（§29.10）。
    },
    findings,
    result,
    meta,
    disclaimer: disclaimer || '',
    text,
    // ---- 兼容旧契约（一代）：语义与旧版**逐字一致**，只是不再作为主渠道 ----
    verdict: legacy.verdict ?? conclusion,
    distinctPages: legacy.distinctPages ?? 0,
    needAttention: legacy.needAttention ?? 0,
  };
  if (reportPath) env.reportPath = reportPath;
  if (findingsPath) env.findingsPath = findingsPath;
  // ★ 出口即保证：返回值一定是无损 JSON（原因见 toLossless）。
  return toLossless(env);
}

/**
 * 生成**落盘用**的 JSON（`report` 动作的第二份交付物）。
 *
 * 与返回信封的差别只有一处：**去掉 `text`** —— 正文已在同名 HTML 里，
 * JSON 只承载机器可读结论（也避免同一条信息存两份、日后各说各话）。
 */
export function resultJson(env) {
  const { text, ...rest } = env;
  return JSON.stringify(
    {
      ...rest,
      textOmitted: '正文见同名 .html；本文件只承载机器可读结论',
    },
    null,
    2,
  );
}
