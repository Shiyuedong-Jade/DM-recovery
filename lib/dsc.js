/**
 * DMDSC 多节点支持。
 *
 * ## 为什么必须有这个模块（三条都是实测结论）
 *
 * 1. **`V$DSC_EP_INFO` 没有地址列。**
 *    实测其只有 6 列：`EP_NAME, EP_SEQNO, EP_GUID, EP_TIMESTAMP, EP_MODE, EP_STATUS`，
 *    值为 `DSC01 / 0 / Control Node / OK`、`DSC02 / 1 / Normal Node / OK`。
 *    归档 REMOTE 目标的 `ARCH_DEST` 也只写节点名（`DSC02`），不是地址。
 *    → **插件无法自动发现对端节点**，只能由调用方给出 `host:port`。
 *
 * 2. **`GV$ERROR_PAGE` 会合并节点，但丢失节点归属。**
 *    实测它与 `V$ERROR_PAGE` 的列**完全相同**（8 列：
 *    `TS_ID, FILE_ID, PAGE_NO, ERRCODE, RECORD_TIME, DB_MAGIC, FILE_NAME, LINE_NO`），
 *    **没有节点列**。所以「这个坏页是哪个节点先撞到的」只能逐节点查 `V$ERROR_PAGE` 才知道。
 *
 * 3. **配置是节点级的。**
 *    实测两节点的归档目标不同：
 *      dsc01: `ARCHIVE_LOCAL1 LOCAL +DMDATA/DSC01/arch`、`ARCH_REMOTE1 REMOTE DSC02`
 *      dsc02: `ARCHIVE_LOCAL1 LOCAL +DMDATA/DSC02/arch`、`ARCH_REMOTE1 REMOTE DSC01`
 *    只连一个节点，无法发现对端参数写错或漏配。
 *
 * ## 设计取向
 *
 * 多节点是**可选增强**，不是必需项：不传 `targets` 时插件仍按单节点工作，
 * 但会把「本库是 N 节点、而只检查了 1 个」明确说出来 —— 不假装检查过。
 */

// 「取到的数」还是「没取到」—— 共用判定（含 `Number(null) === 0` 那个陷阱，见 analyze.js 的注释）
import { toCount } from './analyze.js';

const DEFAULT_PORT = 5236;

/**
 * 解析调用方给出的目标列表。
 *
 * 接受逗号 / 空格 / 换行分隔，每项形如 `host` 或 `host:port`。
 * 之所以用字符串而不是嵌套数组参数：DSH 工具的嵌套 object 参数需要在 DSL 里显式声明
 * `additionalProperties`，用字符串既够用又少一层出错机会。
 */
export function parseTargets(raw) {
  if (raw === null || raw === undefined) return [];
  const out = [];
  const seen = new Set();
  for (const piece of String(raw).split(/[\s,;]+/)) {
    const t = piece.trim();
    if (!t) continue;
    // 支持 IPv6 字面量 [::1]:5236
    const m = /^\[(.+)\]:(\d+)$/.exec(t) ?? /^([^:]+):(\d+)$/.exec(t);
    const host = m ? m[1] : t;
    const port = m ? Number(m[2]) : DEFAULT_PORT;
    if (!host || !Number.isFinite(port)) continue;
    const key = `${host}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host, port, label: key });
  }
  return out;
}

function cols(res) {
  return res?.columns ?? [];
}
function rows(res) {
  return res?.rows ?? [];
}

/** 把「PARA_NAME / PARA_VALUE」形状的结果摊平成 { 参数名: 值 }。 */
export function kvFrom(res, nameFrag = '^PARA_NAME$', valFrag = '^PARA_VALUE$') {
  const c = cols(res);
  const ni = c.findIndex((x) => new RegExp(nameFrag, 'i').test(String(x)));
  const vi = c.findIndex((x) => new RegExp(valFrag, 'i').test(String(x)));
  const out = {};
  if (ni < 0 || vi < 0) return out;
  for (const r of rows(res)) out[String(r[ni])] = r[vi];
  return out;
}

/** 单行结果按列名取若干个字段。 */
export function singleRowFields(res, names) {
  const c = cols(res);
  const r = rows(res)[0];
  const out = {};
  if (!r) return out;
  for (const nm of names) {
    const i = c.findIndex((x) => String(x).toUpperCase() === nm);
    if (i >= 0) out[nm] = r[i];
  }
  return out;
}

const show = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
/** 某节点**根本没返回**这个参数时的占位（与"返回了空值"区分开）。 */
const MISSING = '（该节点未返回此参数）';

/**
 * 逐节点一致性判断。
 *
 * `perNode`: [{ label, instance, database, params, archParams }]
 * 返回 `{ labels, rows, divergent }`；`rows[i].same === false` 即为**节点间不一致**。
 *
 * 这是本模块最实际的用途：DMDSC 上很多参数是**节点级**的，
 * 只配了一个节点、另一个忘了配，单节点视角完全看不出来，
 * 而这类漏配恰恰会让「归档空间保护」之类的机制只在半个集群上生效。
 */
export function judgeConsistency(perNode) {
  const labels = perNode.map((n) => n.label);
  const acc = new Map();

  const put = (name, label, value) => {
    if (!acc.has(name)) acc.set(name, { name, values: {}, remarks: {} });
    acc.get(name).values[label] = show(value);
  };

  for (const n of perNode) {
    for (const [k, v] of Object.entries(kvFrom(n.params))) put(k, n.label, v);
    for (const [k, v] of Object.entries(kvFrom(n.archParams))) put(k, n.label, v);
    for (const [k, v] of Object.entries(
      singleRowFields(n.database, ['ARCH_MODE', 'DSC_NODES', 'STATUS$', 'ROLE$']),
    )) {
      put(`V$DATABASE.${k}`, n.label, v);
    }
    for (const [k, v] of Object.entries(singleRowFields(n.instance, ['INSTANCE_NAME', 'STATUS$', 'MODE$']))) {
      put(`V$INSTANCE.${k}`, n.label, v);
    }

    // ★ `V$DM_ARCH_INI` 是**逐节点**的（实测：dsc01 的 LOCAL 指向 `+DMDATA/DSC01/arch`、REMOTE 指向
    //   `DSC02`，dsc02 对称）。而 `ARCH_HANG_FLAG` / `ARCH_SPACE_LIMIT` 决定
    //   「**归档写入失败时会怎样**」——两节点取值不同，就意味着只有一个节点受保护、另一个先出事。
    //   这正是只连一个节点**绝对看不出来**的东西，也是 `targets` 多节点核对最该抓的。
    //
    //   注意：**故意不比较 `ARCH_DEST`** —— 它本来就该逐节点不同（各节点自己的归档目录；
    //   REMOTE 的 dest 是对端节点名），比进来只会制造假告警，
    //   而假告警会让真告警被忽略（与 `INSTANCE_NAME` 同一个教训）。
    const ac2 = n.archTargets?.columns ?? [];
    for (const r of n.archTargets?.rows ?? []) {
      const g = (exact) => {
        const k = ac2.findIndex((x) => String(x).toUpperCase() === exact);
        return k >= 0 ? r[k] : null;
      };
      const nm = g('ARCH_NAME');
      if (!nm) continue;
      // 只比「行为性」字段：类型、有效性、额度、失败时的行为、文件大小。
      for (const col of ['ARCH_TYPE', 'ARCH_IS_VALID', 'ARCH_SPACE_LIMIT', 'ARCH_HANG_FLAG', 'ARCH_FILE_SIZE']) {
        put(`V$DM_ARCH_INI[${nm}].${col}`, n.label, g(col));
      }
    }
  }

  const out = [];
  for (const { name, values } of acc.values()) {
    const vals = labels.map((l) => values[l] ?? MISSING);
    /**
     * ★ 三态，不是两态：`true`（两边一致）/ `false`（**真的不一致**）/ `null`（**没法比**）。
     *
     * 为什么必须分出 `null`：DMDSC 真机上 `V$DM_ARCH_INI[ARCH_REMOTE1].ARCH_HANG_FLAG` 两个节点
     * 都返回空 —— 第一版把「两边都是 `—`」判成 `same: true`，于是表格里出现
     * 「✅ 一致」，而实际上**这项参数一个节点都没取到**。这正是本项目的核心纪律：
     * **「都未取到」不等于「都一致」** —— 它俩对读者的含义完全相反（后者是"看过了，放心"）。
     */
    const allMissing = vals.every((v) => v === MISSING || v === '—');
    const same = allMissing ? null : vals.every((v) => v === vals[0]);
    out.push({ name, values, vals, same, allMissing });
  }

  // 有些字段**本来就该逐节点不同**（实例名），不能当「不一致」报出来。
  // 否则第一次真机运行就会冒出一个假告警 —— 而假告警会让真告警被忽略。
  const EXPECTED_DIFFER = new Set(['V$INSTANCE.INSTANCE_NAME']);
  const all = out.map((r) => ({ ...r, informational: EXPECTED_DIFFER.has(r.name) }));
  // 排序：真不一致 → 没法比 → 一致（真问题排最前）
  const rank = (r) => (r.same === false && !r.informational ? 0 : r.same === null ? 1 : 2);
  all.sort((a, b) => {
    const ka = rank(a);
    const kb = rank(b);
    return ka === kb ? a.name.localeCompare(b.name) : ka - kb;
  });

  return { labels, rows: all, divergent: all.filter((r) => r.same === false && !r.informational) };
}

/**
 * 节点覆盖度：说清「本库有几个节点 / 这次检查了几个」。
 *
 * 刻意把「没检查全」当成**结论的一部分**输出，而不是留白 ——
 * 留白会被读成「没问题」。
 */
export function describeCoverage({ dscNodes, targets, connected, failedCount = 0 }) {
  // ⚠️ 必须显式排除 null：`Number(null) === 0` 且 `Number.isFinite(0) === true`，
  //    所以直接 `Number.isFinite(Number(dscNodes))` 会把「取不到节点数」当成 **0 节点**，
  //    进而落进 `n <= 1` 分支，把 DMDSC **谎报成单实例** —— 这是最坏的一类错误。
  //    该陷阱在 OS 日志裁决那处又犯了一次（报告里印出 `null 个损坏页`），
  //    所以判定收进 `toCount`（DESIGN §38.9），两处共用同一份，不再各写一遍。
  const n = toCount(dscNodes);
  const checked = Array.isArray(connected) ? connected.length : 0;
  const asked = Array.isArray(targets) ? targets.length : 0;

  if (n === null || n < 1) {
    return {
      state: 'unknown',
      dscNodes: null,
      checked,
      asked,
      verdict: '节点数未知（`V$DATABASE.DSC_NODES` 未取到或非法）——**无法判断是否检查全了**。',
    };
  }
  if (n <= 1) {
    return {
      state: 'single',
      dscNodes: n,
      checked,
      asked,
      verdict: `本库是单实例（DSC_NODES=${n}），单连接即可覆盖全库。`,
    };
  }
  if (checked >= n) {
    // 有目标连不上时，不能只说「覆盖完整」—— 那会和紧随其后的失败清单一句话打脸。
    // 插件无法知道失败的地址到底是不是本集群节点（`V$DSC_EP_INFO` 没有地址列），
    // 所以把判断权交回给读的人，而不是替他们宣布「完整」。
    const caveat =
      failedCount > 0
        ? `\n  ⚠️ 但你列出的目标中有 **${failedCount} 个连接失败**（见下）。` +
          `插件无法判断失败地址是否属于本集群（\`V$DSC_EP_INFO\` 没有地址列），` +
          `**若其中含本集群节点，则上面的「覆盖完整」不成立** —— 请人工确认。`
        : '';
    return {
      state: failedCount > 0 ? 'full-with-failures' : 'full',
      dscNodes: n,
      checked,
      asked,
      verdict: `本库是 DMDSC **${n} 节点**，本次已检查 ${checked} 个节点 —— 覆盖完整。${caveat}`,
    };
  }
  return {
    state: 'partial',
    dscNodes: n,
    checked,
    asked,
    verdict:
      `⚠️ **本库是 DMDSC ${n} 节点，但本次只检查了 ${checked} 个节点，覆盖不完整。**\n` +
      `  对端节点的**参数配置**与**节点本地坏页记录（\`V$ERROR_PAGE\`）尚未检查**。\n` +
      `  \`V$DSC_EP_INFO\` 只有 6 列、**没有地址列**（实测），插件无法自动发现对端，` +
      `请用 \`targets\` 参数把各节点 \`host:port\` 显式列出。`,
  };
}

/**
 * 渲染 DMDSC 覆盖度 + 节点一致性。
 * 放在本模块（而不是 index.js）是为了能离线单测 —— index.js 依赖 `@deepseek-ai/dsh-tools`，
 * 在独立 node 进程里跑不了。
 */
export function renderDsc({ coverage, consistency, failed }) {
  // 单实例上**不能**出现「DMDSC 节点覆盖」这类字样 —— 那会让人怀疑形态是不是判断错了。
  // 实测：单实例 `V$DSC_EP_INFO` 存在但 0 行、`DSC_NODES=1`，本节本就没有内容可讲。
  if (coverage?.state === 'single') {
    return [
      '## 部署形态',
      '',
      coverage.verdict,
      '',
      '> 若日后部署为 DMDSC，用 `targets` 参数列出各节点 `host:port` 即可启用节点间配置比对',
      '> （`V$DSC_EP_INFO` 无地址列；`ARCH_DEST_IP` 有可能可用但**未经验证**，故目前仍需显式给 `targets`）。',
    ].join('\n');
  }

  const L = [];
  L.push('## DMDSC 节点覆盖');
  L.push('');
  L.push(coverage?.verdict ?? '（未取得覆盖度信息）');

  if (failed && failed.length > 0) {
    L.push('');
    L.push('以下节点**连接失败**，其配置**未参与**本轮核对：');
    for (const f of failed) L.push(`- ${f.label}：${f.error}`);
  }

  L.push('');
  L.push('## 节点间配置一致性');
  L.push('');

  if (!consistency || consistency.labels.length < 2) {
    L.push('本次只检查了 1 个节点，**无法比较节点间是否一致**。');
    L.push('用 `targets` 参数列出各节点的 `host:port` 后即可比对。');
    return L.join('\n');
  }

  L.push('DMDSC 上很多参数是**节点级**的：只配了一个节点、另一个漏配，从单节点视角完全看不出来。');
  L.push('');
  L.push(`| 参数 | ${consistency.labels.join(' | ')} | 一致 |`);
  L.push(`| --- |${consistency.labels.map(() => ' --- |').join('')} --- |`);
  for (const r of consistency.rows) {
    // 三态：真正的「一致」才打勾；**两边都没取到**必须是 ❔（不等于一致）
    const mark =
      r.same === true
        ? '✅'
        : r.same === null
          ? '❔ **两边都没取到，未比较**'
          : r.informational
            ? '—（本就应不同）'
            : '❌ **不一致**';
    L.push(`| ${r.name} | ${r.vals.join(' | ')} | ${mark} |`);
  }
  L.push('');

  if (consistency.divergent.length === 0) {
    L.push('✅ **未发现节点间配置不一致。**');
  } else {
    L.push(`❌ **发现 ${consistency.divergent.length} 项节点间不一致**，需要逐项处理：`);
    L.push('');
    for (const r of consistency.divergent) {
      L.push(`- **${r.name}**：${consistency.labels.map((l, i) => `${l}=${r.vals[i]}`).join('，')}`);
    }
    L.push('');
    L.push('> 归档相关参数不一致尤其要紧：实测达梦在**归档空间耗尽时会挂起数据库**，');
    L.push('> 若只有一个节点设了保护，另一个节点就会成为先出事的那个。');
  }
  const uncomparable = consistency.rows.filter((r) => r.same === null);
  if (uncomparable.length > 0) {
    L.push('');
    L.push(
      `❔ 另有 **${uncomparable.length}** 项**两边都没取到**、因此**没有比较**：` +
        `${uncomparable.map((r) => `\`${r.name}\``).join('、')}。` +
        '**「都未取到」不等于「都一致」** —— 要确认它们，得先让这些参数能查出来（列名跨版本可能不同）。',
    );
  }
  return L.join('\n');
}

/**
 * 逐节点的 `V$ERROR_PAGE` → 按页归并，并标出**哪些节点记录到了它**。
 *
 * 为什么需要它（实测）：`GV$ERROR_PAGE` 与 `V$ERROR_PAGE` 的列**完全相同**（8 列），
 * **没有节点列**。所以用 `GV$` 一次查完虽然省事，却丢掉了「哪个节点先撞到」。
 * 这在 DMDSC 上恰恰有用：同一个坏页只有一个节点记录到，说明另一个节点还没读到过它；
 * 两个节点都记录到，说明共享存储上的同一份数据两边都踩过。
 *
 * `perNodeErrorPage`: `[{ label, res }]`，res 为 `V$ERROR_PAGE` 的查询结果。
 */
export function attributePages(perNodeErrorPage) {
  const map = new Map();
  for (const { label, res } of perNodeErrorPage ?? []) {
    const c = cols(res);
    const idx = (frag) => c.findIndex((x) => new RegExp(frag, 'i').test(String(x)));
    const iTs = idx('^TS_ID$');
    const iF = idx('^FILE_ID$');
    const iP = idx('^PAGE_NO$');
    if (iTs < 0 || iF < 0 || iP < 0) continue;
    for (const r of rows(res)) {
      const key = `${r[iTs]}|${r[iF]}|${r[iP]}`;
      if (!map.has(key)) {
        map.set(key, { tsId: r[iTs], fileId: r[iF], pageNo: r[iP], nodes: [] });
      }
      const e = map.get(key);
      if (!e.nodes.includes(label)) e.nodes.push(label);
    }
  }
  const out = [...map.values()];
  out.sort(
    (a, b) =>
      Number(a.tsId) - Number(b.tsId) || Number(a.fileId) - Number(b.fileId) || Number(a.pageNo) - Number(b.pageNo),
  );
  return out;
}

/** 渲染坏页的节点归属。 */
export function renderNodeAttribution({ attributed, labels, failed }) {
  const L = [];
  L.push('## 坏页的节点归属（逐节点查 `V$ERROR_PAGE`）');
  L.push('');

  if (failed && failed.length > 0) {
    L.push('以下节点连接失败，**其坏页未被检查**：');
    for (const f of failed) L.push(`- ${f.label}：${f.error}`);
    L.push('');
  }

  if (!attributed || attributed.length === 0) {
    L.push(`已检查节点（${(labels ?? []).join('、') || '—'}）的 \`V$ERROR_PAGE\` **均为空** —— 没有坏页记录。`);
    L.push('');
    L.push('⚠️ 重申假阴性：该视图只记录**被访问到**的页。节点全空只说明「还没人碰到过」，');
    L.push('想拿到全库裁决，要看全备日志里的 `N corrupted pages during backup`（见 `backup` 动作）。');
    return L.join('\n');
  }

  L.push('`V$` 是**节点本地**的；`GV$` 会合并但**没有节点列**、丢掉归属，所以这里逐节点查后归并：');
  L.push('');
  L.push('| 表空间 | 文件 | 页 | 记录到的节点 | 覆盖 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const a of attributed) {
    const hint = a.nodes.length >= 2 ? '**两节点都记录到**' : '仅此节点记录到';
    L.push(`| ${a.tsId} | ${a.fileId} | ${a.pageNo} | ${a.nodes.join('、')}（${hint}） | ${a.nodes.length}/${(labels ?? []).length} |`);
  }
  L.push('');
  L.push('> 「仅一个节点记录到」= 另一个节点**还没读到过**这个页，不代表它没问题；');
  L.push('> 「两节点都记录到」= 两边都踩过 —— 损坏在共享存储的同一份数据上，不是节点本地问题。');
  return L.join('\n');
}
