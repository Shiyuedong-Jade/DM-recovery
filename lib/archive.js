/**
 * 归档空间参数：检查 + 按**实测峰值**推荐。
 *
 * 三个刻意的设计决定：
 *
 * 1. **只用语义确定的量做速率测量。**
 *    不做 LSN 解码、不依赖 `V$ARCH_FILE.FREE`——后者的含义实测被否掉过
 *    （归档在推进、FREE 却在变大，方向相反）。速率只从**归档文件的创建**推算：
 *    每新建一个文件就是一个已知大小（`ARCH_FILE_SIZE`）、已知创建时间的事件。
 *
 * 2. **定值用观测峰值，不用平均值。**
 *    业务高峰恰恰是最需要恢复能力的时候。按平均速率定 `ARCH_SPACE_LIMIT`，
 *    高峰期的回溯窗口会**静默缩短**——等于「最需要恢复能力时恢复能力最小」。
 *    `ARCH_SPACE_FREE_THRESHOLD` 同理：按平均算「还有一天缓冲」，高峰时可能一小时就吃光。
 *
 * 3. **样本不足就说不知道，不给一个拍出来的数。**
 *    并且明确承认：**观测峰值只是下界**——你只能看到采样窗口内发生的事，
 *    所以**定值时不要用固定倍率去外推**——把敏感性摆出来，让读的人自己判断。
 */

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const fmt = (v, d = 0) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));


// ------------------------------------------------------------ 参数检查

/** 三个参数各自的「该不该设」判据。 */
export function checkArchiveParams(data) {
  const ini = (name) => {
    const res = data.params;
    if (!res || res.error) return null;
    const i = (res.columns ?? []).findIndex((c) => String(c).toUpperCase() === 'PARA_NAME');
    const v = (res.columns ?? []).findIndex((c) => String(c).toUpperCase() === 'PARA_VALUE');
    if (i < 0 || v < 0) return null;
    const row = (res.rows ?? []).find((r) => String(r[i]).toUpperCase() === name);
    return row ? String(row[v]) : null;
  };

  const archIni = ini('ARCH_INI');
  const interval = ini('ARCH_SPACE_CHECK_INTERVAL');
  const threshold = ini('ARCH_SPACE_FREE_THRESHOLD');

  // ARCH_SPACE_LIMIT 不在 V$DM_INI 里——它是 dmarch.ini 的每个归档目标级参数
  const dests = (data.arch?.rows ?? []).map((r) => {
    const c = data.arch.columns ?? [];
    // ★ 必须**整列名精确匹配**，不能用子串：`ARCH_DEST` 是 `ARCH_DEST_IP` 的前缀、
    //   `ARCH_TYPE` 是 `ARCH_ASM_STRIPING` 里没有但 `ARCH_NAME` 是 `ARCH_TIMER_NAME` 的后缀……
    //   子串匹配只在当前列顺序下碰巧对，换个版本/顺序就会串列。
    //   （这与 backup.js 里 `^TYPE$` 那条是同一类教训。）
    const get = (exact) => {
      const k = c.findIndex((x) => String(x).toUpperCase() === exact);
      return k >= 0 ? r[k] : null;
    };
    return {
      name: get('ARCH_NAME'),
      type: get('ARCH_TYPE'),
      dest: get('ARCH_DEST'),
      fileSizeMB: num(get('ARCH_FILE_SIZE')),
      spaceLimit: num(get('ARCH_SPACE_LIMIT')),
      valid: get('ARCH_IS_VALID'),
      // ---- 以下三列来自实测 `desc V$DM_ARCH_INI`（30 列，全部 ARCH_ 前缀）----
      // ARCH_DEST_IP / ARCH_DEST_PORT：REMOTE 目标的**对端地址**。
      //   这条可能推翻「插件无法自动发现对端节点」的结论（原先依据是
      //   `V$DSC_EP_INFO` 无地址列）——但**尚未在真机验证**，见 DESIGN §14。
      destIp: get('ARCH_DEST_IP'),
      destPort: num(get('ARCH_DEST_PORT')),
      // ARCH_HANG_FLAG：命名直指「归档空间耗尽时挂起」这个语义，
      //   而 `ARCH_SPACE_LIMIT` 的超限语义正是本插件唯一未确认的地方。
      //   **本插件不猜它的取值含义**，只把实际值如实带出来，请对照达梦文档确认。
      hangFlag: num(get('ARCH_HANG_FLAG')),
      reserveTime: num(get('ARCH_RESERVE_TIME')),
    };
  });

  const items = [
    {
      name: 'ARCH_INI',
      where: 'dm.ini',
      value: archIni,
      set: archIni === '1',
      meaning: archIni === '1' ? '归档已开启' : '**归档未开启**——本库没有任何时间点恢复能力',
      blocking: archIni !== '1',
    },
    {
      name: 'ARCH_SPACE_CHECK_INTERVAL',
      where: 'dm.ini',
      value: interval,
      set: interval !== null && interval !== '0',
      meaning:
        interval === '0' || interval === null
          ? '**未启用**——不会有归档磁盘剩余空间的**告警日志**（注意：这两个参数是**预警**机制，不是保护机制）'
          : `每 ${interval} 秒检查一次`,
    },
    {
      name: 'ARCH_SPACE_FREE_THRESHOLD',
      where: 'dm.ini',
      value: threshold,
      set: threshold !== null && threshold !== '0',
      meaning:
        threshold === '0' || threshold === null
          ? '**未启用**——剩余空间再低也不会打印告警（最小可设 1024 MB）；这里缺的是**预警**，不是保护'
          : `剩余低于 ${threshold} MB 时告警`,
    },
  ];

  const gaps = items.filter((x) => !x.set && !x.blocking);
  const unsetLimits = dests.filter((d) => d.spaceLimit === 0);

  return {
    items,
    destinations: dests,
    gaps,
    unsetLimits,
    summary:
      archIni !== '1'
        ? '归档未开启，空间参数无从谈起。先开归档。'
        : gaps.length === 0 && unsetLimits.length === 0
          ? '三个参数都已设置。'
          : `有 ${gaps.length} 个系统级参数未设置` +
            (unsetLimits.length > 0 ? `，${unsetLimits.length} 个归档目标未设空间上限` : '') +
            '。',
  };
}

// ------------------------------------------------------------ 速率测量

/** 从 V$ARCH_FILE 结果里取文件集合。 */
function filesOf(res) {
  const c = res?.columns ?? [];
  const p = c.findIndex((x) => String(x).toUpperCase() === 'PATH');
  const t = c.findIndex((x) => String(x).toUpperCase() === 'CREATE_TIME');
  const l = c.findIndex((x) => String(x).toUpperCase() === 'LEN');
  if (p < 0) return [];
  return (res.rows ?? []).map((r) => ({
    path: String(r[p]),
    createTime: t >= 0 ? String(r[t]) : null,
    lenBytes: l >= 0 ? num(r[l]) : null,
  }));
}

/**
 * 从**多次采样**推算速率：给平均，更给**观测峰值**。
 *
 * @param {Array} series 采样序列，每项 `{ files, rlog }`（按时间先后）
 * @param {object} opts  `{ fileSizeMB, intervalHours }`
 */
export function measureGrowth(series, opts = {}) {
  if (!Array.isArray(series) || series.length < 2) {
    return { ok: false, reason: '至少需要两次采样才能测算速率' };
  }

  const sizeMBOf = (f) => {
    if (opts.fileSizeMB) return opts.fileSizeMB;
    return f.lenBytes === null ? null : f.lenBytes / 1048576;
  };

  const intervals = [];
  let totalCreated = 0;
  let totalMB = 0;

  for (let i = 1; i < series.length; i++) {
    const prev = filesOf(series[i - 1].files);
    const cur = filesOf(series[i].files);
    const seen = new Set(prev.map((f) => f.path));
    const created = cur.filter((f) => !seen.has(f.path));
    const mb = created.map(sizeMBOf).filter((x) => x !== null).reduce((s, x) => s + x, 0);
    const hours = opts.intervalHours ?? series[i].hours ?? null;

    totalCreated += created.length;
    totalMB += mb;
    if (hours && hours > 0) {
      intervals.push({ index: i, hours, createdCount: created.length, mb, mbPerHour: mb / hours });
    }
  }

  if (intervals.length === 0) return { ok: false, reason: '采样间隔无效，无法换算速率' };

  const totalHours = intervals.reduce((s, x) => s + x.hours, 0);
  const avgMBPerHour = totalHours > 0 ? totalMB / totalHours : null;
  const peak = intervals.reduce((m, x) => (x.mbPerHour > m.mbPerHour ? x : m), intervals[0]);
  const activeIntervals = intervals.filter((x) => x.mbPerHour > 0);

  if (totalCreated === 0 || totalMB === 0) {
    return {
      ok: false,
      reason:
        `采样 ${totalHours.toFixed(2)} 小时内**没有新建归档文件**，无法测算速率。` +
        `常见原因：库负载低（重做产生慢，归档文件还没写满），或采样窗口太短。` +
        `**这就是「无法估算」，不是一个速率。**请在业务高峰重采，或把采样窗口拉长。`,
      createdCount: 0,
      intervals: intervals.length,
    };
  }

  const lsnOf = (s) => {
    const c = s?.rlog?.columns ?? [];
    const i = c.findIndex((x) => String(x).toUpperCase() === 'CUR_LSN');
    return i >= 0 ? num(s.rlog.rows?.[0]?.[i]) : null;
  };
  const lsnFirst = lsnOf(series[0]);
  const lsnLast = lsnOf(series[series.length - 1]);

  return {
    ok: true,
    samples: series.length,
    intervals: intervals.length,
    totalHours,
    totalCreated,
    totalMB,
    /** 平均速率：只作对照，**不建议**用它定值 */
    avgMBPerHour,
    /** 观测峰值速率：定值以它为基础 */
    peakMBPerHour: peak.mbPerHour,
    peakIntervalIndex: peak.index,
    /** 峰值/平均比 —— 这个比值本身就是「负载波动有多大」的度量 */
    peakToAvgRatio: avgMBPerHour > 0 ? peak.mbPerHour / avgMBPerHour : null,
    /** 有归档产生的区间占比 —— 比例低说明平均被空转期严重拉低 */
    activeIntervalRatio: intervals.length > 0 ? activeIntervals.length / intervals.length : null,
    lsnDelta: lsnFirst !== null && lsnLast !== null ? lsnLast - lsnFirst : null,
    lsnNote: 'LSN 增量仅供对照；LSN 到字节的换算未核实，不参与速率计算',
    peakIsLowerBound:
      '**观测峰值只是下界**——你只能看到采样窗口内发生的事。月末结账、批量导入这类真实高峰可能不在窗口里，' +
      '所以定值时**不要用固定倍率外推**——把敏感性摆出来，由调用方判断。',
  };
}

// ------------------------------------------------------------ 回溯窗口实况

/**
 * 当前实际回溯窗口：最旧归档距今多久。
 *
 * 这个量比「剩余空间」更直接——它**就是**你现在能恢复到多久之前。
 * 而且**不依赖 ARCH_SPACE_LIMIT 的超限语义**：无论达梦是循环覆盖还是停止归档，
 * 窗口缩短都会如实反映出来。建议做成独立监控项。
 */
export function observedRetention(sample) {
  const c = sample?.files?.columns ?? [];
  const t = c.findIndex((x) => String(x).toUpperCase() === 'CREATE_TIME');
  const p = c.findIndex((x) => String(x).toUpperCase() === 'PATH');
  if (t < 0 || p < 0) return { ok: false, reason: 'V$ARCH_FILE 缺少 CREATE_TIME / PATH 列' };

  const rows = filesOf(sample.files)
    .map((r) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(r.createTime ?? '');
      return m ? { ...r, at: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) } : null;
    })
    .filter(Boolean);

  if (rows.length === 0) return { ok: false, reason: '没有归档文件' };

  const oldest = rows.reduce((m, x) => (x.at < m.at ? x : m), rows[0]);
  const newest = rows.reduce((m, x) => (x.at > m.at ? x : m), rows[0]);

  return {
    ok: true,
    fileCount: rows.length,
    oldestAt: oldest.at,
    newestAt: newest.at,
    spanHours: (newest.at - oldest.at) / 3600000,
    ageHours: (Date.now() - oldest.at.getTime()) / 3600000,
    note:
      '这是当前**文件集**里最旧归档的时间，直接反映「现在能恢复到多久之前」。' +
      '⚠️ 若发生循环覆盖，被删掉的老归档不会出现在列表里，因此**实际可恢复窗口可能比它更短**。',
  };
}

// ------------------------------------------------------------ 推荐值

/**

 *
 * ⚠️ `ARCH_SPACE_LIMIT` 的**超限语义未确认**（循环覆盖 vs 停止/挂起）。
 * 本函数照常算数值，但会给出两种解读，不假装它无条件可用。
 */
/**
 * 按实测事实推荐参数。**不做任何「安全系数」式的乘法。**
 *
 * 为什么不设安全系数：不同系统之间的峰值差异极大，任何固定倍率都是拍出来的，
 * 而且它**掩盖不确定性而不是暴露它**——看起来像「算过了」，实际是工具替所有系统
 * 做了一个没有依据的决定。所以这里的每个数字都必须能追溯到两者之一：
 *
 *   · **实测事实**（磁盘容量、观测到的归档速率）
 *   · **调用方明确给出的输入**（要求的回溯窗口）
 *
 * 处理「峰值可能变化」的正确手段不是猜一个倍率，而是：
 *   1. 把敏感性**摆出来**（速率变成 1×/2×/5×/10× 时回滚窗口各是多少），让读的人自己判断；
 *   2. 主推荐**持续监控实际回溯窗口**——峰值不可预测，但可以被发现。
 */
/**
 * **不依赖速率的**建议 —— 无论速率能否测算都必须给出。
 *
 * 为什么单独抽出来：`recommendArchiveParams` 原先在测不出速率时**整体短路**，
 * 于是阈值与检查间隔也一起丢了。这个门禁是**反的** ——
 * 恰恰在测不出速率的系统上（见下），运维最需要的就是这两条。
 *
 * 它只用到 `totalMB` / `freeMB` 两个实测值，**不含任何速率假设**：
 *   · `ARCH_SPACE_FREE_THRESHOLD` 按**磁盘容量**的 15% 定 —— 阈值是告警线，
 *     职责是「留出反应时间」，而「反应时间够不够」取决于未来速率（不可知）。
 *     按容量比例定则只用到已知量，不需要任何峰值假设。
 *   · `ARCH_SPACE_CHECK_INTERVAL` 固定 300 秒 —— 不把简单的时间间隔绑到不可预测的量上。
 */
export function predictionFreeAdvice({ totalMB, freeMB }) {
  const pct = 0.15;
  let threshold = totalMB ? Math.round((totalMB * pct) / 1024) * 1024 : null;
  if (threshold !== null) threshold = Math.max(1024, threshold);
  return {
    ARCH_SPACE_FREE_THRESHOLD: {
      value: threshold,
      why:
        `按**磁盘容量的 ${(pct * 100).toFixed(0)}%** 定：总容量 ${fmt(totalMB, 0)} MB × ${(pct * 100).toFixed(0)}% ` +
        `≈ ${fmt(threshold, 0)} MB（最小 1024）。\n` +
        `  **为什么不按速率算**：阈值是告警线，它的职责是留出反应时间，而「反应时间够不够」` +
        `取决于未来的速率——那正是不可预测的。按容量比例定只用到已知量，不需要任何峰值假设。\n` +
        `  ⚠️ 这只是**数据库自己**的告警线，是第二道防线；第一道应是外部磁盘监控。`,
    },
    ARCH_SPACE_CHECK_INTERVAL: {
      value: 300,
      why:
        `固定 **300 秒（5 分钟）**。不按速率推算——那会把一个简单的时间间隔绑到不可预测的量上。\n` +
        `  取值范围实测为 0~86400 秒；300 秒对归档这种体量的写入足够灵敏，又不会带来可感知的开销。`,
    },
    budgetMB: threshold !== null ? Math.max(0, (freeMB ?? 0) - threshold) : null,
  };
}

export function recommendArchiveParams({
  growth,
  freeMB,
  totalMB,
  retentionHours = null,
  destCount = 2, // 保留以兼容既有调用；**实际参与计算的是 nodeFactor**（destCount 从未被使用）
  nodeFactor = null, // 实测 `V$DATABASE.DSC_NODES`：每个归档目录要容纳几个节点的归档
}) {
  const notes = [];
  // ★ 先把**不依赖速率**的部分算出来 —— 无论速率能否测算都要给（这是本次修的"门禁反了"）。
  const free = predictionFreeAdvice({ totalMB, freeMB });
  const out = {
    ARCH_SPACE_FREE_THRESHOLD: free.ARCH_SPACE_FREE_THRESHOLD,
    ARCH_SPACE_CHECK_INTERVAL: free.ARCH_SPACE_CHECK_INTERVAL,
  };

  if (!growth?.ok) {
    out.ARCH_SPACE_LIMIT = {
      value: null,
      perDestination: true,
      why:
        '**速率测不出来，因此不给这个数值。** 上限 =（单节点速率 × 节点数 × 回溯窗口），' +
        '而速率必须实测 —— 拿一个默认速率去算上限，比不算更危险：它会让人以为算过了。\n' +
        '  ⚠️ 即便测得出速率，本插件也**不把它作为推荐值**：历史速率预测不了未来增长。',
    };
    return {
      ok: false,
      rateUnavailable: true,
      reason: growth?.reason ?? '没有可用的速率',
      recommendations: out, // ← 仍然给出不依赖速率的那两条
      budgetMB: free.budgetMB,
      notes: [
        '**速率测不出来。** 但这不影响上面两项 —— 它们只用到磁盘容量，**不需要任何速率假设**。',
        '为什么不用一个默认速率去算上限：那比不算更危险，它会让人以为算过了。',
      ],
    };
  }

  const avg = growth.avgMBPerHour;
  const peak = growth.peakMBPerHour;
  // `out` 已在函数开头初始化，并已含两条**不依赖速率**的建议。
  // 这里**不再重复一份文本**（与 predictionFreeAdvice 同源）——两处文本迟早会各说各话。
  const threshold = free.ARCH_SPACE_FREE_THRESHOLD.value;

  // ---- ARCH_SPACE_LIMIT：由「要求的回溯窗口」反推，用实测速率换算 ----
  const budgetMB = threshold !== null ? Math.max(0, (freeMB ?? 0) - threshold) : null;

  // ★ 每个归档目录要容纳**几个节点**的归档 —— 必须是实测值，不是经验倍率。
  //
  // 依据（实测）：本 DMDSC 环境两节点的归档目标是
  //   dsc01: LOCAL → +DMDATA/DSC01/arch ，REMOTE → DSC02
  //   dsc02: LOCAL → +DMDATA/DSC02/arch ，REMOTE → DSC01
  // 即 LOCAL 与 REMOTE 互相投递，**每个归档目录都会收到所有节点的归档**。
  // 所以按「单节点实测速率」给每目标上限，会少算 (N-1)/N。
  //
  // 这个 N 就是 `V$DATABASE.DSC_NODES`：DMDSC 上 = 节点数，单实例上 = 1（只有 LOCAL）。
  // 先前这里硬编码 2（注释写作「交叉配置下每个目录存两份」）：
  // 在 2 节点 DMDSC 上碰巧对，但**单实例上会多算一倍**。
  const perHourTotal = Number.isFinite(nodeFactor) && nodeFactor >= 1 ? nodeFactor : null;

  // 回溯窗口 = 可用预算 ÷ (速率 × 节点数)
  const retentionAt = (mbPerHour) =>
    budgetMB !== null && perHourTotal !== null && mbPerHour > 0
      ? budgetMB / (mbPerHour * perHourTotal)
      : null;

  const table = peak
    ? [1, 2, 5, 10].map((k) => ({
        factor: k,
        mbPerHour: peak * k,
        hours: retentionAt(peak * k),
      }))
    : [];

  if (perHourTotal === null) {
    // 拿不到节点数时**不给数值**，且刻意不默认成 2。
    // 方向性理由：上限给小了会让归档更早触顶，而达梦在归档空间耗尽时**会挂起数据库**；
    // 换句话说「猜小了」的代价远大于「猜大了」。宁可让运维显式给，也不替他们拍一个。
    out.ARCH_SPACE_LIMIT = {
      value: null,
      perDestination: true,
      why:
        '**未取得节点数，因此不给数值。**\n' +
        '  归档目录的空间需求 =（单节点速率 × **节点数** × 回溯窗口）。\n' +
        '  DMDSC 采用交叉配置（每节点 LOCAL + REMOTE 互相投递），' +
        '**每个归档目录都会收到所有节点的归档**；单实例则只有 LOCAL。' +
        '所以「节点数」这一项必须是实测值（查询 `V$DATABASE.DSC_NODES`）。\n' +
        '  **这里刻意不默认成 2**：把上限猜小，会让归档更早触顶，' +
        '而达梦在归档空间耗尽时**会挂起数据库** —— 猜错的方向代价太大，应由运维显式确认。',
    };
  } else if (retentionHours === null) {
    out.ARCH_SPACE_LIMIT = {
      value: null,
      perDestination: true,
      why:
        '**未给出要求的回溯窗口，因此不给数值。**\n' +
        `  上限 = 速率 × 要求的回溯窗口 × ${perHourTotal}（节点数，实测 \`V$DATABASE.DSC_NODES\`）。` +
        `「要求的回溯窗口」是**业务输入**，不是工具能替你决定的——它取决于你们能接受多大范围的数据丢失。\n` +
        `  传入 retentionHours 后本工具会按**实测速率**换算出具体数值。`,
      sensitivity: table,
      sensitivityNote:
        '下表是**不同速率假设下的实际回溯窗口**（用当前磁盘预算算出）。倍率选哪个由你判断，工具不替你选：',
    };
  } else {
    const needMB = peak * retentionHours * perHourTotal;
    let limit = budgetMB === null ? null : Math.round(Math.min(needMB, budgetMB) / 1024) * 1024;
    // ⚠️ 取整到 GB 会把很小的需求 round 成 0，而在达梦里 **`ARCH_SPACE_LIMIT=0` 表示「不限制」**
    //    （本环境实测两节点该值就是 0，即「无归档空间保护」）。
    //    也就是说 round 成 0 会**正好把想设的保护变成不设**，方向完全反了。
    //    所以只要需求非零，至少给 1 GB。
    let flooredFromZero = false;
    if (limit === 0 && needMB > 0) {
      limit = 1024;
      flooredFromZero = true;
    }
    out.ARCH_SPACE_LIMIT = {
      // ★ **不给数值**。理由见 why 首段：速率是**上一段采样窗口的观测**，不能外推到未来。
      //   任何由它算出的上限都是"对未来的假设"而不是可验证的结论 —— 与"禁止安全系数"是同一条原则：
      //   不能拿一个不可验证的前提算出数字，然后把它当推荐值交给用户。
      value: null,
      perDestination: true,
      why:
        `**本插件不给这个数值作为推荐。** 下面的换算是把**上一段采样窗口观测到的速率**当成了未来速率，\n` +
        `  而真实环境中日志增长速度随业务而变 —— **历史速率预测不了未来增长**。把这个前提算出来的数字\n` +
        `  当"推荐值"，会让人以为算过了。所以下面只作为**假设性换算**列出，**不构成推荐**：\n` +
        `  按你给出的回溯窗口 **${retentionHours} 小时**、以**观测峰值** ${fmt(peak, 1)} MB/h（<= 仅代表上一段窗口）换算：\n` +
        `  ${fmt(peak, 1)} MB/h × ${retentionHours}h × ${perHourTotal}` +
        `（节点数，实测 \`V$DATABASE.DSC_NODES\`）= ${fmt(needMB, 0)} MB；` +
        `磁盘侧预算 = 剩余 ${fmt(freeMB, 0)} − 阈值 ${fmt(threshold, 0)} = ${fmt(budgetMB, 0)} MB；` +
        `取较小者并取整到 GB → **每目标 ${fmt(limit, 0)} MB**。\n` +
        (flooredFromZero
          ? `  ⚠️ 原始换算值不足 1 GB，取整后会变成 0；而**达梦里 \`ARCH_SPACE_LIMIT=0\` 表示「不限制」**，` +
            `那会把本意「设保护」变成「不设保护」，所以这里已抬到最小 1 GB。\n`
          : '') +
        `  ⚠️ 该值**只覆盖「实测峰值」这一速率**。速率若更高，实际回溯窗口会短于 ${retentionHours} 小时——` +
        `见下表。`,
      sensitivity: table,
      sensitivityNote: '速率变化时的实际回溯窗口（倍率由你判断）：',
      caveat:
        '⚠️ **这个上限意味着什么，取决于 `ARCH_HANG_FLAG`（本地归档写入失败时的行为）—— 这一项现在可以判定，不再是未知量。**\n' +
        '  · `ARCH_HANG_FLAG = 2`（先删最老的归档再重试）→ **循环覆盖语义**：上限**直接等于回溯窗口**，超过它就丢早期恢复能力。\n' +
        '  · `ARCH_HANG_FLAG = 1`（挂起后反复重试，缺省）→ 上限只是把「磁盘满挂起」提前，**并未解决问题**；此时不该依赖它。\n' +
        '  · `ARCH_HANG_FLAG = 0`（报错返回、不再写入）→ 归档会**静默缺失**，比上面两种都危险。\n' +
        '  **本库的实际取值与解读见上面的「ARCH_HANG_FLAG 解读」一节**\n' +
        '  （依据达梦官方文档《配置文件说明》5.3 dmarch.ini）。',
    };
  }

  // ---- 观测到的事实：只陈述，不加倍率 ----
  if (growth.peakToAvgRatio !== null && growth.peakToAvgRatio > 2) {
    notes.push(
      `观测到负载波动：采样期内峰值是平均值的 **${growth.peakToAvgRatio.toFixed(1)} 倍**` +
        (growth.activeIntervalRatio !== null
          ? `（只有 ${(growth.activeIntervalRatio * 100).toFixed(0)}% 的采样区间有归档产生）`
          : '') +
        `。**工具不对这个波动做任何外推**——见下面的敏感性表，由你判断该按几倍预留。`,
    );
  }
  if (avg !== null && peak !== null && avg > 0) {
    notes.push(
      `速率口径提醒：平均 ${fmt(avg, 1)} MB/h、观测峰值 ${fmt(peak, 1)} MB/h。` +
        `**上面所有数值都基于实测口径**；两者差距本身就是你判断该看哪个的依据。`,
    );
  }
  notes.push(growth.peakIsLowerBound);

  // ---- 主推荐：监控，不是参数 ----
  notes.push(
    `### 主推荐：监控「最旧归档距今多久」，而不是靠参数覆盖峰值\n` +
      `  峰值无法预测，但**可以被发现**。` +
      `用 \`V$ARCH_FILE\` 的 \`CREATE_TIME\` 取最小值，得到的就是**当前实际回溯窗口**。\n` +
      `  · 它**不依赖 ARCH_SPACE_LIMIT 的超限语义**——无论达梦是循环覆盖还是停止归档，窗口缩短都会如实反映；\n` +
      `  · 它**不需要任何峰值假设**——你不需要猜高峰多高，只需要在窗口掉到业务底线以下时收到告警；\n` +
      `  · 建议阈值就用业务要求的回溯窗口（即上面那个 retentionHours）。\n` +
      `  **这比把参数调大更能回答「峰值忽然变化怎么办」。**`,
  );

  return {
    ok: true,
    growth,
    basis: {
      peakMBPerHour: peak,
      avgMBPerHour: avg,
      retentionHours,
      note: '基础一律是实测值或调用方输入，无任何安全系数',
    },
    recommendations: out,
    retention: {
      budgetMB,
      atObservedPeakHours: retentionAt(peak),
      sensitivity: table,
    },
    notes,
  };
}

