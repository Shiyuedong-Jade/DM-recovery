/**
 * 生成 README / 插件市场用的报告截图（开发者工具，不连库、不需要 DSH）。
 *
 * ## 两道闸：先脱敏，再**拒绝**未脱敏的图
 *
 * 素材来自**真机报告**，里面有真实 IP、账号与主机路径。所以：
 *   1. 按 `SANITIZE` 脱敏；
 *   2. 脱敏后再扫一遍 `FORBIDDEN`，**命中就拒绝出图并非零退出**。
 *
 * 「忘了替换」在这里必须是一次**失败**，而不是一张悄悄带着真实 IP 的图 —— 手工作坊式截图
 * 最容易出的就是这种事故，而且没人会发现。
 *
 * `SANITIZE` 里还有一类是**内部设计文档引用**（`DESIGN §xx`）：设计文档不随仓库发布，
 * 出现在给外部看的报告里就是一个点不开的引用。`lib/` 那边已经改掉了这些字面量，
 * 这里对**旧报告**做同样的替换 —— 所以下面的替换目标与 `lib/index.js` 的当前写法是**对齐的**，
 * 改文案时两处要一起改（文件末尾 `SELF_CHECK` 会盯着这件事）。
 *
 * ## 为什么不「打开报告再滚到某一节」
 *
 * 无头模式下带 `#s5` 锚点不会滚动；用脚本滚又会撞上两条坑：报告里 `scroll-behavior:smooth`
 * 让滚动变成动画（截到一半），改瞬时滚动又可能合成器还没出帧（整页空白）。
 * 所以这里干脆不滚：把目标章节从报告里**切出来**单独成页，章节自然在页首。
 *
 * ## 用法
 *
 *   node tools/shots.mjs                        用 reports/ 下最新的报告
 *   node tools/shots.mjs --report <报告.html>    指定报告
 *   node tools/shots.mjs --browser <浏览器路径>   指定 Chromium 内核浏览器
 *   node tools/shots.mjs --only 2-summary       只出一张（调版式时用）
 *
 * 环境变量 `EDGE_PATH` / `CHROME_PATH` 与 `--browser` 等价。
 * 无头浏览器在受限沙箱下会因命名管道被拒而失败，必要时放宽权限再跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const REPORTS = path.join(PKG, 'reports');
const TMP = path.join(REPORTS, '.shots');
const ASSETS = path.join(PKG, 'assets');

/**
 * 要截的图。`title` 为 null 表示整页（封面 + 目录）；否则按目录里的**标题**找章节 id，
 * 找不到就报错 —— 用标题而不是写死 `s5`，是因为章节编号会随报告形态变（附录条数、OS 条数都不固定）。
 */
const SHOTS = [
  { name: '1-cover', title: null, w: 1200, h: 900 },
  { name: '2-summary', title: '结论摘要', w: 1200, h: 880 },
  { name: '3-scenarios', title: '逐场景条件对照', w: 1200, h: 1100 },
  { name: '4-advice', title: '该改的', w: 1200, h: 900 },
];

/** 脱敏替换表。顺序有意义：先具体后笼统。 */
const SANITIZE = [
  // 真实环境地址 → 文档占位（与 README / 参数示例里的 10.0.0.x 一致）
  [/\b10\.127\.11\.61\b/g, '10.0.0.1'],
  [/\b10\.127\.11\.62\b/g, '10.0.0.2'],
  [/\b10\.127\.11\.(\d+)\b/g, '10.0.0.$1'],
  // 采集账号
  [/\bawr1\b/g, 'appuser'],
  [/\bAWR1\b/g, 'APPUSER'],
  // 内部设计文档引用 → 与 lib/ 当前文案一致的对外说法
  [/（DESIGN §46，实测）/g, '（真机实测）'],
  [/（DESIGN §46）/g, '（真机实测）'],
  [/实测（DESIGN §46）/g, '真机实测'],
  [/（DESIGN §35\.4）/g, ''],
  [/（DESIGN §25\.2）/g, ''],
  [/（DESIGN §25\.3）/g, ''],
  [/（DESIGN §36）/g, ''],
  [/判定规则见 DESIGN §[\d–\-—~]+/g, '判定规则见本报告第 5~7 节'],
];

/** 脱敏后**必须为空**的清单。命中即拒绝出图。 */
const FORBIDDEN = [
  [/10\.127\.11\./, '真实 IP 段'],
  [/\bawr1\b/i, '真实采集账号'],
  [/DM250718/, '口令片段'],
  [/EXP_BADPAGE/i, '真机实验对象名'],
  [/DESIGN §/, '内部设计文档引用'],
];

/**
 * 这份替换表针对的**当前**文案。改 `lib/` 里那几处文案时，这里要一起改 ——
 * 否则新报告里的写法会漏过 `SANITIZE`，被 `FORBIDDEN` 拦下（这是**故意**的：宁可失败也不要出脏图）。
 */
const SELF_CHECK = [
  ['（真机实测）', 'lib/index.js 里「两个来源都不能给出全库无坏页的正面结论」那句'],
  ['判定规则见本报告第 5~7 节', 'lib/index.js 里「评估概况」的判定规则说明'],
];

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};

/** 找一个可用的 Chromium 内核浏览器；找不到返回 null，由调用方给出可操作的提示。 */
function findBrowser() {
  const explicit = flag('--browser') ?? process.env.EDGE_PATH ?? process.env.CHROME_PATH;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA ?? '';
  const cands = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return cands.find((p) => p && fs.existsSync(p)) ?? null;
}

/** 默认素材：`reports/` 下最新的报告。 */
function latestReport() {
  if (!fs.existsSync(REPORTS)) return null;
  const files = fs.readdirSync(REPORTS).filter((f) => f.endsWith('.html'));
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(path.join(REPORTS, b)).mtimeMs - fs.statSync(path.join(REPORTS, a)).mtimeMs);
  return path.join(REPORTS, files[0]);
}

/** 脱敏 + 守卫。返回脱敏后的 HTML；有残留就抛错（不返回半成品）。 */
function sanitize(html) {
  let out = html;
  const applied = [];
  for (const [re, to] of SANITIZE) {
    const n = (out.match(re) ?? []).length;
    if (n) {
      applied.push(`${re.source} → «${to}» ×${n}`);
      out = out.replace(re, to);
    }
  }
  const leftovers = FORBIDDEN.filter(([re]) => re.test(out)).map(([, why]) => why);
  if (leftovers.length) {
    throw new Error(`脱敏不干净，拒绝出图：${leftovers.join('、')}\n  补齐 SANITIZE 里对应的替换规则（见文件开头说明）。`);
  }
  const missing = SELF_CHECK.filter(([needle]) => !out.includes(needle)).map(([, why]) => why);
  if (missing.length) {
    console.log(`  [提示] 脱敏后没出现这些当前文案，可能素材是旧报告：\n    ${missing.join('\n    ')}`);
  }
  if (applied.length) console.log('  脱敏：\n    ' + applied.join('\n    '));
  return out;
}

/** 从目录里取「标题 → 章节 id」。用标题找，避免写死 sN。 */
function tocMap(html) {
  const map = new Map();
  for (const m of html.matchAll(/<span class="tn">([^<]*)<\/span><a href="#([^"]+)">([^<]+)<\/a>/g)) {
    map.set(m[3], m[2]);
  }
  return map;
}

/**
 * 只保留目标章节：头部样式原样保留，正文换成 `.wrap` 下的那一个章节。
 * 章节之间是平级节点，所以按相邻两个 `<h2 id="` 切片得到的 HTML 是配平的。
 */
function sliceSection(html, id) {
  const bodyAt = html.indexOf('<body');
  if (bodyAt < 0) throw new Error('报告里找不到 <body>');
  const head = html.slice(0, html.indexOf('>', bodyAt) + 1);
  const start = html.indexOf(`<h2 id="${id}"`);
  if (start < 0) throw new Error(`报告里找不到章节 #${id}`);
  const bodyEnd = html.lastIndexOf('</body>');
  const next = html.indexOf('<h2 id="', start + 1);
  const end = next >= 0 && next < bodyEnd ? next : html.lastIndexOf('</div>', bodyEnd);
  if (end <= start) throw new Error(`章节 #${id} 的结束位置没找到`);
  return `${head}\n<div class="sheet"><div class="wrap">\n${html.slice(start, end)}\n</div></div></body></html>`;
}

function shoot(browser, url, out, w, h) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${w},${h}`,
    `--user-data-dir=${path.join(TMP, 'profile')}`,
    `--screenshot=${out}`,
    url,
  ];
  const r = spawnSync(browser, args, { stdio: 'ignore' });
  return r.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 20_000;
}

const browser = findBrowser();
if (!browser) {
  console.error('没找到 Chromium 内核浏览器。用 --browser <路径> 或环境变量 EDGE_PATH / CHROME_PATH 指定。');
  process.exit(2);
}

const src = flag('--report') ? path.resolve(flag('--report')) : latestReport();
if (!src || !fs.existsSync(src)) {
  console.error(
    '没找到素材报告。把一份报告放到 reports/ 下，或用 --report <报告.html> 指定。\n' +
      '报告来自 `node tools/run-action.mjs --action report --out-dir reports`（需真实达梦环境）。',
  );
  process.exit(2);
}

console.log(`\n浏览器：${browser}\n素材：${src}\n`);
let full;
try {
  full = sanitize(fs.readFileSync(src, 'utf8'));
} catch (e) {
  console.error('\n' + e.message);
  process.exit(1);
}

const toc = tocMap(full);
const only = flag('--only');
const targets = only ? SHOTS.filter((s) => s.name === only) : SHOTS;
if (only && !targets.length) {
  console.error(`--only ${only} 没匹配到任何图；可选：${SHOTS.map((s) => s.name).join(' / ')}`);
  process.exit(2);
}

fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(ASSETS, { recursive: true });

let failed = 0;
const written = [];
for (const s of targets) {
  let html = full;
  let where = '整页';
  if (s.title) {
    const id = [...toc.keys()].find((t) => t.includes(s.title));
    if (!id) {
      console.log(`  ${s.name}  跳过：目录里没有含「${s.title}」的章节`);
      failed++;
      continue;
    }
    html = sliceSection(full, toc.get(id));
    where = `#${toc.get(id)} · ${id}`;
  }
  const tmpHtml = path.join(TMP, `${s.name}.html`);
  fs.writeFileSync(tmpHtml, html, 'utf8');
  const out = path.join(ASSETS, `screenshot-${s.name}.png`);
  const url = `file:///${tmpHtml.replace(/\\/g, '/')}`;
  if (shoot(browser, url, out, s.w, s.h)) {
    const kb = (fs.statSync(out).size / 1024).toFixed(0);
    console.log(`  ${path.relative(PKG, out)}  ${kb} KB  (${s.w}x${s.h} · ${where})`);
    written.push(`assets/screenshot-${s.name}.png`);
  } else {
    console.log(`  ${s.name}  截图失败`);
    failed++;
  }
}
fs.rmSync(TMP, { recursive: true, force: true });

if (failed) {
  console.error(`\n有 ${failed} 张没出图。`);
  process.exit(1);
}
console.log(`\n${written.length} 张图已写入 assets/。请确认 screenshots.json 列出的是这些：\n  ${written.join('\n  ')}`);
