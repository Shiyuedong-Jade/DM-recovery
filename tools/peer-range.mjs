/**
 * peer 范围自检：把本包声明的 `@deepseek-ai/*` peer 范围，拿去和 npm 上**实际已发布**的版本逐个比。
 *
 * ## 为什么需要它
 *
 * node-semver 有一条不显眼的规则：**带预发布标签的版本，只有当范围里存在「与它 major.minor.patch
 * 完全一致、且那个比较符自己也带预发布标签」的比较符时才放行。**
 *
 * 于是「看起来覆盖很宽」的范围会**静默排除**预发布版本：
 *   · `*`                      —— 一个预发布都不匹配；
 *   · `>=0.1.0-0 <0.2.0-0`     —— 只匹配 0.1.0 这一个元组，够不到 0.1.5；
 *   · `^0.1.5-rc.2`            —— 只认 0.1.5 元组，够不到 0.1.0-rc.x。
 * 而宿主发的**几乎全是预发布版本**（`@deepseek-ai/dsh-tools` 的 0.1 线上没有一个稳定版）。
 * 想覆盖整条 0.1 线，只能把该线**每个元组都显式列出来**。
 *
 * 既然是枚举，就会随宿主发新元组而**悄悄失效** —— 失效时没有任何报错，
 * 只在用户 `npm install` 时冒出 peer 告警。所以本工具的作用不是「当年写对了」，
 * 而是「**今天还对不对**」：拉一次 registry，逐个版本比，漏了就非零退出。
 *
 * ## 为什么自己实现 semver 子集而不是引 `semver`
 *
 * 本包零依赖（CI 不装任何包）。代价是得先把实现自证一遍，
 * 所以下面有 `SEMVER_CASES`：进网络之前先把语义断言跑掉，断言同时进 `tools/smoke.mjs`（离线）。
 *
 * 用法：
 *   node tools/peer-range.mjs            检查并打印覆盖情况
 *   node tools/peer-range.mjs --quiet    只打印结论
 *
 * 需要出网访问 registry.npmjs.org，因此**不进 CI 的常规作业**（正常 CI 保持离线，见 .github/workflows/）。
 * 注册源可用 `PEER_RANGE_REGISTRY` 覆盖 —— 那是给"把出网失败那条分支也真跑一遍"用的
 * （`PEER_RANGE_REGISTRY=http://127.0.0.1:1 node tools/peer-range.mjs` 应给出可读的一句话并退出 2）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const QUIET = process.argv.includes('--quiet');
const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

/**
 * 每个 peer 声明支持的**线**（major.minor）。这些线里的**每个已发布版本都必须被范围覆盖**；
 * 其它线的版本只作为信息打印。
 *
 * 逐包声明而不是一条全局：本包支持的是 README 里写的「DeepSeek Harness 0.1.x」，
 * 而 cordis 走的是自己的 4.0 线，两者上界不同。
 */
const SUPPORTED_LINES = {
  '@deepseek-ai/dsh-tools': ['0.1'],
  '@deepseek-ai/cordis': ['4.0'],
};

// ─────────────────────────────────────── semver 子集

/** 解析 `1.2.3-rc.4` → {major, minor, patch, pre: ['rc','4']}。只认规范形态。 */
function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

const cmpNum = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

/** 预发布标识符比较：纯数字按数值、数字小于字母、字母按 ASCII、字段少者更小。 */
function cmpPre(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (+x !== +y) return +x < +y ? -1 : 1;
    } else if (xn) return -1;
    else if (yn) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 版本先后：先比三段数字，再比预发布（有预发布的小于同版本的正式版）。 */
export function compare(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    const c = cmpNum(a[k], b[k]);
    if (c) return c;
  }
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  return cmpPre(a.pre, b.pre);
}

/** 把 `^` / `~` 展开成一对比较符；其余原样。 */
function expand(op, ver) {
  const v = parse(ver);
  if (!v) return null;
  if (op === '^') {
    const upper = v.major > 0 ? `${v.major + 1}.0.0` : v.minor > 0 ? `0.${v.minor + 1}.0` : `0.0.${v.patch + 1}`;
    return [{ op: '>=', v }, { op: '<', v: parse(upper) }];
  }
  if (op === '~') return [{ op: '>=', v }, { op: '<', v: parse(`${v.major}.${v.minor + 1}.0`) }];
  return [{ op, v }];
}

function testComparator(c, v) {
  const r = compare(v, c.v);
  switch (c.op) {
    case '>=': return r >= 0;
    case '>': return r > 0;
    case '<=': return r <= 0;
    case '<': return r < 0;
    default: return r === 0;
  }
}

/** `satisfies(v, range)`：`||` 分支任一成立即可；分支内全部比较符成立**且**满足预发布规则。 */
export function satisfies(version, range) {
  const v = parse(version);
  if (!v) return false;
  return String(range)
    .split('||')
    .some((branch) => {
      const text = branch.trim();
      const comps = [];
      if (text === '' || text === '*' || text === 'x') comps.push({ op: '>=', v: parse('0.0.0') });
      else {
        for (const token of text.split(/\s+/).filter(Boolean)) {
          const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token);
          const part = expand(m[1] ?? '=', m[2]);
          if (!part) return false;
          comps.push(...part);
        }
      }
      if (!comps.every((c) => testComparator(c, v))) return false;
      if (v.pre.length === 0) return true;
      // ★ 就是开头说的那条规则：分支里必须有一个「同元组且自身带预发布标签」的比较符
      return comps.some((c) => c.v.pre.length > 0 && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch);
    });
}

/**
 * 实现的语义断言。这些期望值是拿**真实 `semver`**（7.7.4，随 npm 装在
 * `…/hermes/node/node_modules/npm/node_modules/semver`）逐条跑出来的，不是手推的：
 * 写在这里是为了以后有人重写这个子集时，语义错了会当场红，而不是把一个错实现拿去查 registry。
 * 同时这些用例也跑在 `tools/smoke.mjs` 里（离线），所以本模块被 import 时**不能联网**。
 */
export const SEMVER_CASES = [
  // 预发布规则（本工具存在的理由）
  ['0.1.0-rc.6', '>=0.1.0-0 <0.2.0-0', true, '同元组预发布放行'],
  ['0.1.5-rc.2', '>=0.1.5-0 <0.2.0-0', true, '同上'],
  ['0.1.7-rc.2', '>=0.1.7-0 <0.2.0-0', true, '同上'],
  ['0.1.5-alpha.1', '>=0.1.5-0 <0.2.0-0', true, '`-0` 下限能放行 alpha'],
  ['0.1.5-alpha.1', '>=0.1.5-rc.1 <0.2.0-0', false, '`-rc.1` 下限放行不了 alpha（alpha < rc）'],
  ['0.1.7-rc.2', '>=0.1.0-0 <0.2.0-0', false, '只落在 0.1.0 元组上，够不到 0.1.7'],
  ['0.1.0-rc.6', '>=0.0.1-rc.1 <0.2.0', false, '没有任何比较符落在 0.1.0 元组上'],
  ['0.1.0-rc.6', '>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0', true, 'contributing.md 那条示例范围放行 0.1.0-rc'],
  ['0.1.5-rc.2', '>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0', false, '★ 但同一条范围**放行不了** 0.1.5-rc.2（示例范围不够宽）'],
  ['0.1.5-rc.2', '^0.1.5-rc.2', true, '脱字符在 0.1.5 元组上带标签，所以放行自身'],
  ['0.1.0-rc.6', '^0.1.5-rc.2', false, '但够不到 0.1.0 元组'],
  ['0.1.5', '*', true, '稳定版匹配 `*`'],
  ['0.1.5-rc.2', '*', false, '`*` 一个预发布都不匹配'],
  ['0.1.5-rc.3', '>=0.1.5-rc.2 <0.2.0', true, '同元组更高的预发布'],
  // 本包实际声明的范围（枚举式）
  ['0.1.0-rc.2', '>=0.1.0-0 <0.2.0-0 || >=0.1.5-0 <0.2.0-0', true, '枚举中的第一段'],
  ['0.1.5-rc.2', '>=0.1.0-0 <0.2.0-0 || >=0.1.5-0 <0.2.0-0', true, '枚举中的第二段'],
  ['0.1.4-alpha.1', '>=0.1.0-0 <0.2.0-0 || >=0.1.5-0 <0.2.0-0', false, '没列 0.1.4 就够不到它（这正是枚举的缺口）'],
  ['0.1.8-rc.1', '>=0.1.0-0 <0.2.0-0 || >=0.1.5-0 <0.2.0-0', false, '枚举之外的新元组也够不到'],
  ['0.2.0-rc.1', '>=0.1.0-0 <0.2.0-0 || >=0.1.5-0 <0.2.0-0', false, '越过 0.2 上界'],
  // cordis 那条（4.0 线）
  ['4.0.1-rc.1', '>=4.0.1-0 <4.1.0-0 || >=4.0.5-0 <4.1.0-0', true, '枚举后能放行最早那个预发布'],
  ['4.0.5-alpha.1', '>=4.0.1-0 <4.1.0-0 || >=4.0.5-0 <4.1.0-0', true, '也能放行新元组的预发布'],
  ['4.1.0-rc.1', '>=4.0.1-0 <4.1.0-0 || >=4.0.5-0 <4.1.0-0', false, '越过 4.1 上界'],
  ['4.0.2', '^4.0.1', true, '脱字符：稳定版'],
  ['4.0.1-rc.1', '^4.0.1', false, '脱字符不带预发布标签，放行不了同元组预发布'],
  ['5.0.0', '^4.0.1', false, '越过脱字符上界'],
];

/** 跑一遍语义断言；返回是否全部符合期望。 */
export function selfTest(quiet = QUIET) {
  const bad = SEMVER_CASES.filter(([v, r, want]) => satisfies(v, r) !== want);
  if (bad.length) {
    console.error('semver 子集语义断言失败，先修实现：');
    for (const [v, r, want] of bad) console.error(`  ${v} 对 ${r} 应为 ${want}，实际 ${satisfies(v, r)}`);
    return false;
  }
  if (!quiet) console.log(`语义自证：${SEMVER_CASES.length} 条用例通过（含预发布规则的 9 条反例）`);
  return true;
}

// ─────────────────────────────────────── 查 registry

/** 拉精简 packument（install-v1 比全量小很多）；网络抖动重试。 */
async function versionsOf(name) {
  const url = `${process.env.PEER_RANGE_REGISTRY ?? 'https://registry.npmjs.org'}/${name.replace('/', '%2F')}`;
  for (let i = 1; i <= 6; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/vnd.npm.install-v1+json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return Object.keys(j.versions ?? {});
    } catch (e) {
      if (i === 6) throw new Error(`取 ${name} 版本列表失败：${e.message}`);
      await new Promise((s) => setTimeout(s, 1500));
    }
  }
}

// 被 import 时只提供 satisfies / compare / SEMVER_CASES（离线自检要用来断言）；
// 联网查 registry 只在本文件直接运行时发生。
if (IS_MAIN) {
  if (!selfTest()) process.exit(2);

  const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  const peers = Object.entries(pkg.peerDependencies ?? {}).filter(([n]) => n.startsWith('@deepseek-ai/'));
  if (!peers.length) {
    console.error('package.json 里没有 @deepseek-ai/* 的 peerDependencies。');
    process.exit(2);
  }

  let failed = 0;
  for (const [name, range] of peers) {
    const lines = SUPPORTED_LINES[name] ?? [];
    // 出网失败要给一句能读懂的话，而不是甩一个裸栈：本工具本来就不进常规 CI（见文件头），
    // 在无外网的环境里跑到这里**是预期内的**，说清楚就行。
    let all;
    try {
      all = await versionsOf(name);
    } catch (e) {
      console.error(`\n${e.message}`);
      console.error('本工具需要访问 registry.npmjs.org；无外网时跑不了 —— 这也是它不进常规 CI 的原因。');
      process.exit(2);
    }
    const sorted = all.slice().sort((a, b) => compare(parse(a), parse(b)));
    // ★ 空响应必须当**失败**：registry 什么都没返回时，下面所有统计都会「空对空」地通过 ——
    //   那是「没查到」，不是「全部覆盖」。这两件事在本插件里从来不许混为一谈。
    //   （2026-10-13 补：第一次手动跑 peer-range 作业后才发现，exit 0 分不出这两种情况。）
    if (!sorted.length) {
      failed++;
      console.log(`  ❌ registry 没返回任何版本 —— 这是「没查到」，不是「覆盖完整」。`);
      continue;
    }
    const covered = sorted.filter((v) => satisfies(v, range));
    const own = [...new Set(sorted.map((v) => `${parse(v).major}.${parse(v).minor}`))];
    const gaps = lines.flatMap((l) => sorted.filter((v) => `${parse(v).major}.${parse(v).minor}` === l && !satisfies(v, range)));

    console.log(`\n${name}`);
    console.log(`  声明范围：${range}`);
    console.log(`  已发布 ${sorted.length} 个，覆盖 ${covered.length} 个；首尾：${sorted[0]} … ${sorted[sorted.length - 1]}`);
    for (const l of own) {
      const group = sorted.filter((v) => `${parse(v).major}.${parse(v).minor}` === l);
      const hit = group.filter((v) => satisfies(v, range));
      const mark = lines.includes(l) ? (hit.length === group.length ? '全中' : '有漏') : '线外（仅信息）';
      console.log(`    ${l}.x  ${String(hit.length).padStart(2)}/${String(group.length).padEnd(2)} ${mark}${hit.length ? `  最新覆盖 ${hit[hit.length - 1]}` : ''}`);
    }
    if (gaps.length) {
      failed++;
      console.log(`  ❌ 声明支持的线（${lines.join('、')}）里有 ${gaps.length} 个版本没被覆盖：${gaps.join(' ')}`);
      console.log(`     修法：给这些元组各加一条 \`>=<元组>-0 <上界>\` 分支；下限用 \`-0\`，不要用 \`-rc.1\`（alpha < rc）。`);
    } else if (lines.length) {
      console.log(`  ✅ 声明支持的线（${lines.join('、')}）全部覆盖。`);
    }
  }

  if (failed) {
    console.error('\npeer 范围已落后于 registry，需要补分支。');
    process.exit(1);
  }
  console.log('\npeer 范围与 registry 一致。');
}
