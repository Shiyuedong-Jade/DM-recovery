/**
 * HTML 报告生成（对齐 `dm8-inspect` 的交付形态：落盘一个 HTML 文件 + present）。
 *
 * 设计取向与本插件其它部分一致：
 *
 * 1. **分级只依据实测事实，规则写死且可追溯。** `gradeFindings` 的每一条都能指到
 *    一个具体的实测值或一次查询失败；不做「综合评分」这类不可解释的合计。
 *
 * 2. **章节正文复用既有的 Markdown 渲染**，不另写一套。所以这里带一个**最小 Markdown → HTML**
 *    转换器（标题/表格/围栏代码/列表/引用/粗体/行内代码）。
 *    宁可转换器小一点，也不要两套渲染各说各话。
 *
 * 3. **假阴性免责必须出现在报告里**，不能只活在对话输出中。
 */

/** HTML 转义 —— 报告里会嵌用户可控的字符串（库名、路径、对象名），必须转。 */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 记号 → 图标样式（DESIGN §33）。
 *
 * 报告里到处是 ✅/❌/❔/—/⚠️/🔴… 这些**语义记号**。第一版让它们以纯文本出现，
 * 于是"四态"在视觉上几乎分不出来（尤其 ❔ 与 — 在 13px 字号下都是一个小点）。
 * 这里统一包成 `.mk` 小圆标：**颜色 + 形状 + 原字形**三重区分，正文与表格共用一套。
 */
const MK_CLASS = {
  '🔴': 'm-crit',
  '🟠': 'm-warn',
  '🔵': 'm-info',
  '⚪': 'm-unk',
  '✅': 'm-ok',
  '❌': 'm-bad',
  '❔': 'm-unk',
  '⚠️': 'm-warn',
  '⚠': 'm-warn',
  '🚨': 'm-crit',
};

/** 行内：先转义，再处理 `code`、**bold**、语义记号。 */
function inline(s) {
  let t = esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  for (const [mk, cls] of Object.entries(MK_CLASS)) {
    t = t.split(mk).join(`<span class="mk ${cls}">${mk}</span>`);
  }
  return t;
}

/** 表格里的状态列：整格是 `—` 时也包成小圆标（否则它在视觉上"消失"了）。 */
const wrapCellMark = (html, raw) => (/^—$/.test(raw.trim()) ? `<span class="mk m-na">—</span>` : html);

/** 这些表头所在的列是**状态列**：居中对齐，宽度收窄。 */
const STATUS_HEAD = /^(满足|判定|状态|一致|当前能力|能否用于「上界」)$/;

/** 有序/无序列表 → HTML（支持两级缩进；报告里的"边界"条目就是两级）。 */
function renderList(items) {
  const base = Math.min(...items.map((x) => x.indent));
  const root = [];
  let cur = null;
  for (const it of items) {
    const node = { text: it.text, children: [] };
    if (it.indent <= base || cur === null) {
      root.push(node);
      cur = node;
    } else {
      cur.children.push(node);
    }
  }
  const tree = (nodes) =>
    '<ul>' + nodes.map((n) => `<li>${inline(n.text)}${n.children.length ? tree(n.children) : ''}</li>`).join('') + '</ul>';
  return tree(root);
}

/**
 * 最小 Markdown → HTML。
 * 支持的子集正好是本插件实际会输出的那些构造；**不认识的行按段落原样输出**，
 * 不做静默丢弃（丢弃会让人以为报告里没有那块内容）。
 */
export function mdToHtml(md) {
  const lines = String(md ?? '').split(/\r?\n/);
  const out = [];
  let i = 0;
  const isTableSep = (t) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(t) && t.includes('-');

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    if (/^\s*```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lv = Math.min(6, h[1].length + 1); // 报告里 # 降一级，h1 留给报告标题
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      i++;
      continue;
    }

    // 表格：表头 + 分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const cells = (t) =>
        t
          .replace(/^\s*\|/, '')
          .replace(/\|\s*$/, '')
          .split('|')
          .map((c) => c.trim());
      const head = cells(line);
      const ctr = head.map((c) => STATUS_HEAD.test(c.replace(/[*`]/g, '')));
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        body.push(cells(lines[i++]));
      }
      out.push(
        // 宽表在窄屏上要能横向滚动，否则整页会被撑破
        '<div class="tw"><table><thead><tr>' +
          head.map((c, k) => `<th${ctr[k] ? ' class="ctr"' : ''}>${inline(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          body
            .map(
              (r) =>
                '<tr>' +
                r
                  .map((c, k) => {
                    const html = wrapCellMark(inline(c), c);
                    return `<td${ctr[k] ? ' class="ctr"' : ''}>${html}</td>`;
                  })
                  .join('') +
                '</tr>',
            )
            .join('') +
          '</tbody></table></div>',
      );
      continue;
    }

    // 分隔线
    if (/^\s*---+\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${mdToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // 列表（按缩进还原两级）
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const m = /^(\s*)[-*]\s+(.*)$/.exec(lines[i]);
        items.push({ indent: m[1].length, text: m[2] });
        i++;
      }
      out.push(renderList(items));
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    // 段落
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  return out.join('\n');
}

// ★ 分级词表统一到 `vocab.js`（DESIGN §24）：**定义处只有一处**，
//   这里取用后再导出，保证「报告的分级色块」与「正文的 `[🔴 严重]`」同词同义。
import {
  LEVEL_ORDER as LEVEL_ORDER_V,
  LEVEL_LABEL as LEVEL_LABEL_V,
  LEVEL_MARK as LEVEL_MARK_FOR,
  renderVocabTable,
} from './vocab.js';
export const LEVEL_ORDER = LEVEL_ORDER_V;
export const LEVEL_LABEL = LEVEL_LABEL_V;

/**
 * 分级。**规则写死、每条可追溯到实测值或一次查询失败。**
 * 不做「综合评分」——那会掩盖不确定性而不是暴露它。
 *
 * 入参全是简单标量/数组，避免依赖上层对象的内部形状。
 */
export function gradeFindings({
  archIni, // V$DM_INI.ARCH_INI 的字符串值
  archMode, // V$DATABASE.ARCH_MODE
  hasBadPages, // V$ERROR_PAGE 是否有行
  hasStandby, // 是否有数据守护备库
  backupsCount, // V$BACKUPSET 行数
  dests = [], // [{name,type,spaceLimit,fileSizeMB,hangFlag}]
  checkInterval, // ARCH_SPACE_CHECK_INTERVAL 值
  pageCheckPolicy, // PAGE_CHECK_POLICY 值
  archQueryFailed, // 归档相关查询是否失败
}) {
  const g = [];
  const archOn = String(archIni) === '1';
  const locals = dests.filter((d) => String(d.type ?? '').toUpperCase() === 'LOCAL');
  const limited = dests.filter((d) => Number(d.spaceLimit) > 0);

  if (!archOn && String(archMode ?? '').toUpperCase() !== 'Y') {
    g.push({
      level: 'crit',
      title: '归档未开启：没有任何时间点恢复能力',
      detail: `V$DM_INI.ARCH_INI=${archIni ?? '—'}、V$DATABASE.ARCH_MODE=${archMode ?? '—'}。坏页发生时只能恢复到最近一次全备，其后数据全部丢失。这一项比任何检测功能都更值得优先处理。`,
    });
  }

  if (hasBadPages && !hasStandby) {
    g.push({
      level: 'crit',
      title: '存在坏页，且没有可借用干净页的对端',
      detail:
        '在线页修复（SF_PRIMARY_PAGE_REPAIR）必须借备库或对端的干净页。当前无数据守护备库，' +
        '因此该路径不可用 —— 这是物理限制，不是参数问题。',
    });
  }

  if (locals.length > 0 && locals.every((d) => Number(d.hangFlag) !== 1)) {
    g.push({
      level: 'crit',
      title: '归档写入失败时可能丢失归档',
      detail:
        '所有 LOCAL 归档目标的 ARCH_HANG_FLAG 均不为 1。官方文档指出这种情况下' +
        '「写入归档失败后可能会出现归档日志缺失，进而可能产生特定情况下备份还原无法正常进行等问题」。',
    });
  }

  if (backupsCount === 0) {
    g.push({
      level: 'warn',
      title: '库的账本里没有任何备份记录',
      detail:
        'V$BACKUPSET 为空。注意这不等于是没有备份（账本只反映当前控制文件记得的备份集），' +
        '但若确实没有可用备份，则「恢复」这件事目前无从谈起。',
    });
  }

  for (const d of limited) {
    const n = d.fileSizeMB ? Math.floor(Number(d.spaceLimit) / Number(d.fileSizeMB)) : null;
    if (n !== null && n <= 3) {
      g.push({
        level: 'warn',
        title: `归档上限只够保留约 ${n} 个归档文件（${d.name}）`,
        detail:
          `ARCH_SPACE_LIMIT=${d.spaceLimit} MB ÷ ARCH_FILE_SIZE=${d.fileSizeMB} MB = ${n}。` +
          '两个数都是实测值，商不需要任何速率假设。回溯窗口会非常短。',
      });
    }
  }

  if (limited.length > 0 && Number(checkInterval) === 0) {
    g.push({
      level: 'warn',
      title: '归档上限已设，但没有空间告警',
      detail:
        'ARCH_SPACE_CHECK_INTERVAL=0。按官方文档，它与 ARCH_SPACE_FREE_THRESHOLD 的作用只是' +
        '「剩余空间低于阈值时打印警告日志」，并不控制上限是否生效。' +
        '所以这里缺的是预警 —— 磁盘写满时会直接从「没事」跳到 ARCH_HANG_FLAG 定义的行为。',
    });
  }

  if (String(pageCheckPolicy) === '1') {
    g.push({
      level: 'info',
      title: 'PAGE_CHECK_POLICY=1：读到损坏页会让数据库主动 HALT',
      detail:
        '这正是本工具**不提供**主动扫描的原因 —— 扫描本身就会打挂生产库。' +
        '想在不影响业务的前提下拿到全库页完整性裁决，只能靠全备日志里的' +
        '「N corrupted pages during backup」。',
    });
  }

  if (archQueryFailed) {
    g.push({
      level: 'unknown',
      title: '归档配置未能取到',
      detail: 'V$DM_ARCH_INI 查询失败。本报告不据此下任何结论。',
    });
  }

  g.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
  return g;
}

/**
 * 等级 → **一句话含义**（结论看板下面的"判定含义"表）。
 * 与安全评估报告同构：数字要能一眼看到，含义要能查到。
 */
const LEVEL_MEANING = {
  // ★ §29.10：原文是"有恢复场景**当前救不回来**，或你的恢复需求**确定不满足**"。
  //   需求达成度整项移除后，`crit` 只剩前一种来源 —— 表格里留着半句不存在的判据，
  //   读者会去找一份根本没有的"需求判定"。**删功能要连"解释这个功能的话"一起删。**
  crit: '有恢复场景**当前救不回来** —— 需优先处理',
  warn: '只能粗粒度恢复 / 存在明确缺口 —— 建议按计划处理',
  info: '仅陈述已具备的能力或事实，不构成问题',
  unknown: '本次**未取得数据或精度不足** —— 既不代表满足，也不代表不满足',
};

/** 中文序号 → 阿拉伯数字（报告的正文/文本层用中文序号，HTML 的编号徽章用数字，与安全评估报告一致）。 */
const CN_NO = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8,
  九: 9, 十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14,
};

/**
 * 拆出「显示标题」与「编号徽章」。
 *   · `一、最要紧的几件事…`   → 徽章 `1`（由调用顺序决定），标题 `最要紧的几件事…`
 *   · `附录 A · 处置能力体检` → 徽章 `A`，标题照旧
 */
function splitSectionTitle(title) {
  const s = String(title ?? '');
  const cn = /^([一二三四五六七八九十]+)、\s*(.*)$/.exec(s);
  if (cn) return { title: cn[2], cn: CN_NO[cn[1]] ?? null };
  const ap = /^附录\s*([A-Z])\s*[·:：]\s*(.*)$/.exec(s);
  if (ap) return { title: `附录 ${ap[1]} · ${ap[2]}`, appendix: ap[1] };
  return { title: s };
}

/**
 * 报告版式（DESIGN §33–§34）。**只负责好看与好读，不含任何判定逻辑。**
 *
 * 视觉语言**对齐同族的《达梦数据库安全评估报告》**：深蓝封面信息带 + 编号小节 +
 * 定义式信息面板（`table.meta`）+ 结论看板（KPI + 分布条 + 含义表）+ 徽章/胶囊 + A4 打印样式。
 * 配色与组件名直接沿用那一套 CSS 变量，两份报告放在一起看是**同一个产品家族**。
 */
const STYLE = `
  :root{
    --ink:#0b1f33; --ink2:#33475f; --mute:#6b7c93; --faint:#93a2b5;
    --line:#dfe6ee; --line2:#eef2f7; --bg:#eef1f5; --paper:#fff;
    --brand:#12395c; --brand2:#1f5c99; --accent:#c8963e;
    --crit:#b42318; --warn:#b54708; --ok:#067647; --info:#175cd3; --na:#5b6b7f; --unknown:#6941c6;
    --critbg:#fef3f2; --warnbg:#fffaeb; --okbg:#f0fdf4; --infobg:#eff6ff; --nabg:#f6f8fa; --unknownbg:#f7f5ff;
    --radius:8px;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Consolas,"Liberation Mono",monospace;
  }
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);
       font-size:14px;line-height:1.68;font-variant-numeric:tabular-nums}
  .sheet{max-width:1120px;margin:0 auto;background:var(--paper);
         box-shadow:0 1px 3px rgba(11,31,51,.08),0 12px 40px rgba(11,31,51,.06)}
  .wrap{padding:0 44px 56px}
  code{background:#f1f4f8;border:1px solid var(--line2);padding:0 4px;border-radius:3px;font-size:12.5px;font-family:var(--mono);
       word-break:break-word}
  b{color:#08192b}
  .muted{color:var(--mute);font-weight:400}
  a{color:var(--brand2);text-decoration:none} a:hover{text-decoration:underline}

  /* ============ 封面信息带 ============ */
  .cover{background:linear-gradient(135deg,#0d2b47 0%,#12395c 55%,#1b4b74 100%);color:#eaf1f8;padding:40px 44px 30px}
  .cover-kicker{font-size:11.5px;letter-spacing:3px;text-transform:uppercase;color:#8fb4d6}
  .cover-title{font-size:30px;font-weight:700;margin:10px 0 2px;letter-spacing:1px;color:#fff}
  .cover-sub{font-size:12.5px;letter-spacing:1.6px;color:#a9c6e0;text-transform:uppercase}
  .cover-rule{height:3px;width:64px;background:var(--accent);margin:16px 0 20px;border-radius:2px}
  .cover-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(196px,1fr));gap:12px 28px}
  .cover-facts div{font-size:12.5px;color:#9fbdd8}
  .cover-facts b{display:block;color:#fff;font-size:14.5px;font-weight:600;margin-top:2px;letter-spacing:.2px}
  .cover-verdict{margin-top:20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .cover-verdict .lv{display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.12);
       border:1px solid rgba(255,255,255,.3);border-radius:999px;padding:5px 15px;font-size:13.5px;font-weight:600;color:#fff}
  .cover-verdict .lv .dot{width:9px;height:9px;border-radius:50%}
  .cover-verdict .cm{font-size:12.5px;color:#cfe0f0}

  /* ============ 章节 ============ */
  h2{display:flex;align-items:center;gap:12px;font-size:16px;margin:42px 0 14px;letter-spacing:.4px;color:var(--brand)}
  h2 .hno{flex:0 0 auto;min-width:26px;height:26px;padding:0 6px;border-radius:6px;background:var(--brand);color:#fff;
          font-size:12.5px;font-weight:700;display:flex;align-items:center;justify-content:center;letter-spacing:0}
  h2 .ht{flex:0 0 auto}
  h2::after{content:"";flex:1 1 auto;height:1px;background:var(--line)}
  h3{font-size:14.5px;margin:26px 0 10px;color:var(--ink);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  h3 .mini{margin-left:auto}
  h4{font-size:14px;margin:22px 0 8px;color:var(--ink)}
  /* 场景 / 建议 / 需求那一层的小标题：做成卡片头，读者能一眼看出"这一段在讲哪一块" */
  h5{font-size:14px;margin:20px 0 8px;padding:8px 13px;background:#f8fafc;border:1px solid var(--line);
     border-left:5px solid var(--brand2);border-radius:6px;color:var(--brand)}
  .card{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;margin:12px 0}
  .note{font-size:12.5px;color:var(--mute);margin:8px 0 0}
  p{margin:9px 0}
  hr{border:0;border-top:1px solid var(--line);margin:22px 0}
  blockquote{margin:12px 0;padding:11px 15px;border:1px solid var(--line);border-left:3px solid var(--accent);
       border-radius:6px;background:#f8fafc;color:var(--ink2);font-size:13.2px}
  blockquote p{margin:5px 0}
  blockquote ul{margin:5px 0 5px 18px}
  ul{margin:8px 0 8px 20px;padding:0}
  li{margin:3px 0}
  pre{margin:8px 0;padding:11px 13px;background:#0f2136;color:#dbe7f3;border-radius:6px;
      font-family:var(--mono);font-size:12px;line-height:1.6;overflow:auto;white-space:pre}
  pre code{background:none;border:0;color:inherit;padding:0}

  /* ============ 目录 ============ */
  /* ★ §44：目录是**导航**，要一眼看出它是什么、条目能不能点、点了去哪。
     原来只有一片浅灰底 + 小字，读者容易当成"概况面板的附属说明"。
     ★ §44.6：条目改成**单列竖排**（原来是 4 列自适应栅格）—— 竖排读起来是一条线，
     长标题不再折行、也不再横向铺开；代价是整块变高，所以行距与字号都收紧了。 */
  .tocbox{margin:16px 0 6px;background:#f8fafc;border:1px solid var(--line);
          border-left:3px solid var(--brand);border-radius:var(--radius);padding:12px 16px 13px}
  .toc-title{font-size:13px;font-weight:600;color:var(--brand);letter-spacing:.6px;
             display:flex;align-items:baseline;gap:10px;margin-bottom:7px}
  .toc-hint{font-size:11.5px;font-weight:400;color:var(--faint);letter-spacing:0}
  /* 单列竖排：一行一条，靠行距紧凑（15 条约 270px） */
  ul.toc{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0}
  ul.toc li{font-size:12.5px;line-height:1.55;display:flex;align-items:baseline;gap:8px;
            padding:1px 6px;border-radius:3px}
  ul.toc li:hover{background:#eef3f9}
  ul.toc .tn{color:var(--faint);font-family:var(--mono);font-size:11px;min-width:1.6em;text-align:right}
  /* 点线引导：竖排到右侧有很长一段空白，没有它整块会显得"虚"；
     它也是纸质目录的通行写法，读者一眼知道"这是一份目录" */
  ul.toc a{color:var(--ink);text-decoration:none;flex:1;display:flex;align-items:baseline}
  /* 点线用 --mute 而不是 --line：后者的对比度在浅灰底上几乎看不见（真机第一版就是"有点但看不出"）。
     只加粗**点**、不加粗整行 —— 引导线是配角，抢了标题的注意力就本末倒置。
     （⚠️ 这段在 STYLE 模板字符串里，注释里**不能出现反引号** —— 我自己在同一处踩了两次。） */
  ul.toc a::after{content:"";flex:1;margin-left:8px;
                  border-bottom:1px dotted var(--mute);opacity:.45;transform:translateY(-3px)}
  ul.toc a:hover{color:var(--brand)}
  ul.toc a:hover::after{border-bottom-color:var(--brand);opacity:.9}
  /* 回程链接：15 节的报告，没有它就得一路滚回顶部 */
  .backtoc{font-size:12px;color:var(--mute);margin:14px 0 0;text-align:right}
  .backtoc a{color:var(--mute);text-decoration:none}
  .backtoc a:hover{color:var(--brand);text-decoration:underline}
  /* ★ 跳转落点留出上边距：原来 h2 会**顶在视口最上沿**，看起来像"点了没反应" */
  h2[id],h3[id],section[id]{scroll-margin-top:16px}

  /* ============ 结论看板 ============ */
  .board{margin:14px 0 6px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px}
  .kpi{border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;background:#fbfcfe}
  .kpi-n{font-size:26px;font-weight:700;line-height:1.1;letter-spacing:-.5px}
  .kpi-t{font-size:12px;color:var(--mute);margin-top:2px}
  .kpi.crit{background:var(--critbg);border-color:#f6d3d0} .kpi.crit .kpi-n{color:var(--crit)}
  .kpi.warn{background:var(--warnbg);border-color:#f3e0bd} .kpi.warn .kpi-n{color:var(--warn)}
  .kpi.info{background:var(--infobg);border-color:#cfdffb} .kpi.info .kpi-n{color:var(--info)}
  .kpi.unknown{background:var(--unknownbg);border-color:#ddd3f7} .kpi.unknown .kpi-n{color:var(--unknown)}
  .kpi.zero{background:#fbfcfe;border-style:dashed}
  .kpi.zero .kpi-n{color:var(--faint);font-weight:500}
  .distbar{display:flex;height:12px;border-radius:6px;overflow:hidden;margin:14px 0 8px;background:var(--line2)}
  .seg{display:block;height:100%}
  .seg.crit{background:var(--crit)} .seg.warn{background:var(--warn)} .seg.info{background:var(--info)}
  .seg.unknown{background:var(--unknown)} .seg.ok{background:var(--ok)} .seg.partial{background:var(--warn)}
  .seg.none{background:var(--crit)} .seg.na{background:#a9b6c6}
  .board-foot{font-size:12.5px;color:var(--mute)}
  .board-foot b{color:var(--ink)}

  /* ============ 表格 ============ */
  table{border-collapse:collapse;width:100%;font-size:13px;margin:12px 0}
  th,td{padding:8px 11px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line2);
        word-break:break-word}
  thead th{background:#f8fafc;color:var(--ink2);font-weight:600;border-bottom:1px solid var(--line);
           font-size:12.5px;letter-spacing:.2px}
  tbody tr:nth-child(even){background:#fcfdfe}
  tbody tr:hover{background:#f7fafd}
  table.meta{margin:0}
  table.meta th{width:172px;background:#f8fafc;color:var(--ink2);font-weight:600;border-bottom:1px solid var(--line2)}
  table.meta td{color:var(--ink)}
  table.matrix td.n,table.matrix th.n{width:62px;text-align:right;font-weight:600}
  table.matrix td.mean{color:var(--ink2)}
  td.ctr,th.ctr{text-align:center;white-space:nowrap;width:1%}
  .tw{overflow-x:auto;margin:12px 0}
  .tw table{margin:0;min-width:520px}
  ul.items{list-style:none;margin:8px 0 10px;padding:0 0 0 14px;border-left:2px solid var(--line)}
  ul.items li{font-size:13.5px;margin:3px 0;color:var(--ink2);position:relative;padding-left:12px}
  ul.items li::before{content:"";position:absolute;left:0;top:.62em;width:5px;height:5px;border-radius:50%;background:var(--faint)}

  /* ============ 徽章 / 记号 ============ */
  .badge{display:inline-block;font-size:11.5px;line-height:19px;padding:0 9px;border-radius:10px;color:#fff;
         font-weight:600;letter-spacing:.3px;white-space:nowrap}
  .badge.crit{background:var(--crit)} .badge.warn{background:var(--warn)} .badge.ok{background:var(--ok)}
  .badge.info{background:var(--info)} .badge.na{background:var(--na)} .badge.unknown{background:var(--unknown)}
  .mini{display:inline-block;font-size:11.5px;padding:1px 8px;border-radius:9px;font-weight:600;white-space:nowrap}
  .mini b{font-weight:700}
  .mini.crit{background:var(--critbg);color:var(--crit)} .mini.warn{background:var(--warnbg);color:var(--warn)}
  .mini.ok{background:var(--okbg);color:var(--ok)} .mini.info{background:var(--infobg);color:var(--info)}
  .mini.na{background:var(--nabg);color:var(--na)} .mini.unknown{background:var(--unknownbg);color:var(--unknown)}
  .pill{display:inline-block;font-size:11.5px;padding:1px 8px;border-radius:9px;font-weight:600;
        background:#f1f4f8;color:var(--mute);border:1px solid var(--line)}
  /* 语义记号（✅/❌/❔/—/🔴…）：与安全评估报告的 mini 胶囊同一形状，颜色随语义 */
  .mk{display:inline-block;font-size:11.5px;line-height:18px;padding:0 7px;border-radius:9px;font-weight:600;
      white-space:nowrap;background:#f1f4f8;color:var(--mute);border:1px solid var(--line)}
  .m-ok{background:var(--okbg);color:var(--ok);border-color:#c9ebd6}
  .m-bad,.m-crit{background:var(--critbg);color:var(--crit);border-color:#f6d3d0}
  .m-warn{background:var(--warnbg);color:var(--warn);border-color:#f3e0bd}
  .m-info{background:var(--infobg);color:var(--info);border-color:#cfdffb}
  .m-unk{background:var(--unknownbg);color:var(--unknown);border-color:#ddd3f7}
  .m-na{background:var(--nabg);color:var(--na)}

  /* ============ 结论项卡片 ============ */
  article.item{border:1px solid var(--line);border-left:4px solid var(--line);border-radius:var(--radius);
               padding:13px 16px;margin:10px 0;background:var(--paper)}
  article.item.crit{border-left-color:var(--crit);background:linear-gradient(90deg,var(--critbg),#fff 42%)}
  article.item.warn{border-left-color:var(--warn);background:linear-gradient(90deg,var(--warnbg),#fff 42%)}
  article.item.info{border-left-color:var(--info);background:linear-gradient(90deg,var(--infobg),#fff 42%)}
  article.item.unknown{border-left-color:var(--unknown);background:linear-gradient(90deg,var(--unknownbg),#fff 42%)}
  .item-head{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
  .item-title{font-weight:600;font-size:14px;color:#0b1f33}
  .item-body{margin:7px 0 0;font-size:13.8px;color:var(--ink2)}

  /* ============ 免责 / 页脚 ============ */
  .disc{font-size:12.5px;color:var(--ink2);background:#f8fafc;border:1px solid var(--line);
        border-left:3px solid var(--accent);border-radius:6px;padding:14px 16px;margin-top:34px}
  .disc p{margin:6px 0}
  .rpt-foot{margin-top:40px;padding-top:14px;border-top:2px solid var(--brand);
            display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--mute)}

  /* ============ 打印（A4）============ */
  @page{size:A4;margin:15mm 13mm}
  @media print{
    body{background:#fff;font-size:11.5pt}
    .sheet{max-width:none;box-shadow:none}
    .wrap{padding:0 0 8mm}
    .cover{padding:22mm 12mm 12mm;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    /* 目录与「返回目录」是**屏幕导航**：打印出来没有页码也没有链接，纯占地方。
       注意要连容器一起隐藏 —— 只藏 ul 会留下一个写着「目录」的空框。
       （⚠️ 这段在模板字符串里，注释中**不能出现反引号** —— 会把 STYLE 截断成语法错误。） */
    .tocbox,.backtoc{display:none}
    h2{break-after:avoid;margin-top:22px}
    h3{break-after:avoid}
    article.item,table,.board,.tw{break-inside:avoid}
    tbody tr:hover{background:transparent}
    a{color:inherit;text-decoration:none}
  }
  @media (max-width:720px){.wrap{padding:0 16px 36px}.cover{padding:26px 18px 22px}.cover-title{font-size:23px}}
`;

/** 定义式信息面板（`table.meta`）—— 与安全评估报告的「评估概况」同构。 */
function metaTable(rows) {
  const body = (rows ?? [])
    .filter(Boolean)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v === null || v === undefined || v === '' ? '—' : v}</td></tr>`)
    .join('');
  return `<table class="meta"><tbody>${body}</tbody></table>`;
}

/** 编号小节标题。 */
const sectionHead = (id, no, title) =>
  `<h2 id="${id}"><span class="hno">${esc(no)}</span><span class="ht">${esc(title)}</span></h2>`;

/** 每节末尾的「返回目录」—— 15 节的报告里，没有它就得一路滚回顶部。 */
const backToToc = () => '<p class="backtoc"><a href="#toc">↑ 返回目录</a></p>';

/**
 * 目录（DESIGN §44）。
 *
 * ★ 两个必须做对的点（原来都做错了）：
 *   1. **位置**：原来它夹在第 1 节「评估概况」**之后** —— 打开报告第一屏是封面+概况，
 *      根本看不到目录；更别扭的是点「1 评估概况」是**往回跳**。
 *      现在放在 `<div class="wrap">` 的第一件事：封面之后、第 1 节之前。
 *   2. **回程**：原来整篇只有最末尾一个「↑ 返回目录」，而且指向 `#s1`（第 1 节，不是目录）。
 *      现在**每节末尾**都有一个，统一指向 `#toc`。
 *
 * 用 `<nav id="toc">` 而不是 `<h2 id="toc">`：目录是**导航**不是内容小节 ——
 * 不能混进 `s1..sN` 那套编号里，否则「小节数」这个口径会被它污染
 * （§37 的真机回归正是拿「目录链接数 = 小节数」在卡这件事）。
 */
function tocBlock(items) {
  return (
    '<nav class="tocbox" id="toc">\n' +
    '<div class="toc-title">目录<span class="toc-hint">点条目跳转</span></div>\n' +
    '<ul class="toc">\n' +
    items.map((x) => `<li><span class="tn">${esc(x.no)}</span><a href="#${x.id}">${esc(x.t)}</a></li>`).join('\n') +
    '\n</ul>\n</nav>'
  );
}

/** 结论看板：KPI 卡片 + 分布条 + 判定含义表（数字一眼可见，含义可查）。 */
function dashboard(grades, boardFoot) {
  const counts = LEVEL_ORDER.map((lv) => ({ lv, n: grades.filter((x) => x.level === lv).length }));
  const total = counts.reduce((a, c) => a + c.n, 0);
  const kpi = counts
    .map(
      (c) =>
        `<div class="kpi ${c.lv}${c.n === 0 ? ' zero' : ''}"><div class="kpi-n">${c.n}</div>` +
        `<div class="kpi-t">${LEVEL_LABEL[c.lv]}</div></div>`,
    )
    .join('');
  const segs = counts
    .filter((c) => c.n > 0)
    .map(
      (c) =>
        `<span class="seg ${c.lv}" style="flex:${c.n}" title="${LEVEL_LABEL[c.lv]} ${c.n}"></span>`,
    )
    .join('');
  const rows = counts
    .map(
      (c) =>
        `<tr><td><span class="badge ${c.lv}">${LEVEL_LABEL[c.lv]}</span></td>` +
        `<td class="n">${c.n}</td><td class="mean">${inline(LEVEL_MEANING[c.lv])}</td></tr>`,
    )
    .join('');
  return (
    '<div class="board">' +
    `<div class="kpis">${kpi}</div>` +
    `<div class="distbar">${segs}</div>` +
    `<div class="board-foot">共 <b>${total}</b> 条分级结论。${boardFoot ?? ''}</div>` +
    '</div>' +
    `<table class="matrix"><thead><tr><th style="width:96px">等级</th><th class="n">条数</th><th>判定含义</th></tr></thead><tbody>${rows}</tbody></table>`
  );
}

/** 场景能力分布（五档）—— 与结论看板同一形状，但用能力档位的词表。 */
function capabilityBoard(cap) {
  if (!cap) return '';
  const keys = ['ok', 'partial', 'none', 'unknown', 'na'];
  const total = keys.reduce((a, k) => a + (cap[k] ?? 0), 0);
  const mini = keys
    .map((k) => `<span class="mini ${k}">${CAP_LABEL_HTML[k] ?? k} <b>${cap[k] ?? 0}</b></span>`)
    .join(' ');
  const segs = keys
    .filter((k) => (cap[k] ?? 0) > 0)
    .map((k) => `<span class="seg ${k}" style="flex:${cap[k]}" title="${CAP_LABEL_HTML[k] ?? k} ${cap[k]}"></span>`)
    .join('');
  return (
    '<h3>场景能力分布<span class="mini na">共 ' + total + ' 个场景</span></h3>' +
    `<div class="distbar">${segs}</div><div class="board-foot">${mini}</div>`
  );
}

/** 能力档位的中文（与 `vocab.js` 同源；这里只用于 HTML，取不到就原样显示机器值）。 */
const CAP_LABEL_HTML = { ok: '可恢复', partial: '仅能粗粒度恢复', none: '不可恢复', unknown: '无法判定', na: '不适用' };

/**
 * 拼出整份 HTML。
 *
 * @param {object} o
 * @param {object} o.meta       封面与概况用的元信息（见下）
 * @param {Array}  o.grades     分级结论（`{level,title,detail}`）
 * @param {Array}  o.sections   `{title, body}`；标题里的中文序号会被拆成**编号徽章**
 * @param {string} o.disclaimer
 * @param {string} o.generatedAt
 */
export function buildReportHtml({ meta = {}, grades = [], sections = [], disclaimer = '', generatedAt = '', driver = 'jdbc' }) {
  const parsed = sections.map((s) => ({ ...s, ...splitSectionTitle(s.title) }));
  let auto = 2; // 1=评估概况、2=结论摘要 由本函数渲染
  const noOf = (s) => {
    if (s.appendix) return s.appendix;
    auto += 1;
    return auto;
  };
  const numbered = parsed.map((s, i) => ({ id: `s${i + 3}`, no: noOf(s), ...s }));
  const overall = grades.length === 0 ? null : LEVEL_ORDER.find((lv) => grades.some((g) => g.level === lv));
  const overallLabel = overall ? LEVEL_LABEL[overall] : '无分级';
  const overallColor = { crit: '#e06c60', warn: '#e0a93f', info: '#5b9bd5', unknown: '#9d8ce0' }[overall] ?? '#a9b6c6';
  const facts = (rows) =>
    rows
      .filter(Boolean)
      .map(([k, v]) => `<div>${esc(k)}<b>${v === null || v === undefined || v === '' ? '—' : esc(v)}</b></div>`)
      .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>达梦数据库可恢复能力评估报告 · ${esc(meta.dbName ?? '')} · ${esc(generatedAt)}</title>
<style>${STYLE}</style>
</head>
<body><div class="sheet">

<header class="cover">
  <div class="cover-kicker">Dameng DM8 · Recovery Readiness Assessment</div>
  <div class="cover-title">达梦数据库可恢复能力评估报告</div>
  <div class="cover-sub">16 个恢复场景 × 实测依据 · 全程只读</div>
  <div class="cover-rule"></div>
  <div class="cover-facts">${facts([
    ['评估对象', meta.target],
    ['数据库 / 实例', `${meta.dbName ?? '—'} / ${meta.instance ?? '—'}`],
    ['形态 / 版本', `${meta.form ?? '—'}${meta.version ? ` · ${meta.version}` : ''}`],
    ['采集账号', meta.account],
    ['生成时间', generatedAt],
    ['报告编号', meta.reportId],
  ])}</div>
  <div class="cover-verdict">
    <span class="lv"><span class="dot" style="background:${overallColor}"></span>总体：${esc(overallLabel)}</span>
    <span class="cm">${grades.length} 条分级结论 · ${meta.scenarioCount ?? '—'} 个恢复场景${meta.requirementLine ? ` · ${esc(meta.requirementLine)}` : ''}</span>
  </div>
  ${driver === 'demo' ? '<div class="cover-verdict"><span class="cm">本报告使用演示数据生成，不对应任何真实数据库。</span></div>' : ''}
</header>

<div class="wrap">

${
    // ★ §44：目录放在**封面之后、第 1 节之前** —— 打开报告第一屏就是它。
    //   原来它挂在第 1 节后面（第 1 节的正文在它之前），读者看不到、点第 1 条还会往回跳。
    tocBlock(
      [{ no: '1', t: '评估概况', id: 's1' }, { no: '2', t: '结论摘要', id: 's2' }].concat(
        numbered.map((s) => ({ no: String(s.no), t: s.title, id: s.id })),
      ),
    )
  }

${sectionHead('s1', '1', '评估概况')}
<div class="card">${metaTable(meta.overview ?? [])}</div>
<h3>版本与实例信息</h3>
<div class="card">${metaTable(meta.versionRows ?? [])}</div>
${
    // ⚠️ 这里原本直接把 `overviewNote` 塞进 `<div class="note">` —— 于是调用方写在里面的
    //    `**加粗**` 会**原样露出星号**。离线夹具当年只传了一句普通文本，没抓到；
    //    真机回归脚本第一次跑就报了「正文里没有残留未渲染的 `**`」（DESIGN §37.4）。
    //    结论：**凡是人要读的文本都必须过同一条 md 管线**，不能一半走一半不走。
    meta.overviewNote ? `<div class="note">${mdToHtml(meta.overviewNote)}</div>` : ''
  }
${backToToc()}

${sectionHead('s2', '2', '结论摘要')}
${dashboard(grades, meta.boardFoot)}
<h3>分级明细</h3>
${
  grades.length === 0
    ? '<div class="card">本次未发现需要分级的问题。</div>'
    : grades
        .map(
          (x) =>
            `<article class="item ${x.level}"><div class="item-head">` +
            `<span class="badge ${x.level}">${LEVEL_LABEL[x.level]}</span>` +
            `<span class="item-title">${inline(x.title)}</span></div>` +
            `<div class="item-body">${inline(x.detail)}</div></article>`,
        )
        .join('\n')
}
${capabilityBoard(meta.capability)}
${backToToc()}

${numbered.map((s) => `${sectionHead(s.id, s.no, s.title)}\n${mdToHtml(s.body)}\n${backToToc()}`).join('\n')}

<div class="disc">${mdToHtml(disclaimer)}</div>

<div class="rpt-foot">
  <span>达梦数据库可恢复能力评估 · 插件 <code>dsh-plugin-dm-recovery-readiness</code>${meta.reportId ? ` · ${esc(meta.reportId)}` : ''}</span>
  <span>全程只读：不扫描、不修复、不改配置、不执行备份或恢复</span>
</div>

</div></div></body></html>`;
}
