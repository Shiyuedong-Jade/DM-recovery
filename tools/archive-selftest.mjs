/** 归档逻辑离线自检（不连库）。 */
import { checkArchiveParams, measureGrowth, recommendArchiveParams, observedRetention } from '../lib/archive.js';

let fail = 0;
const ok = (c, m) => {
  console.log((c ? '  [通过] ' : '  [失败] ') + m);
  if (!c) fail++;
};

const filesRes = (list) => ({
  columns: ['PATH', 'CREATE_TIME', 'LEN'],
  rows: list.map((f) => [f.path, f.time, '134217728']),
});

// 构造：4 个采样点，每段新建 1 / 1 / 4 个文件 → 峰值出现在第 3 段
const mk = (n) => {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push({ path: `+DMDATA/DSC01/arch/f${i}`, time: '2026-10-10 10:00:00' });
  return filesRes(arr);
};
const series = [mk(2), mk(3), mk(4), mk(8)].map((files) => ({ files }));
const g = measureGrowth(series, { intervalHours: 0.25, fileSizeMB: 128 });

ok(g.ok === true, '速率测量成功');
ok(g.totalCreated === 6, `识别出 6 个新建文件（实际 ${g.totalCreated}）`);
ok(g.peakMBPerHour === (4 * 128) / 0.25, `峰值取最大区间：4×128MB/0.25h = ${g.peakMBPerHour} MB/h`);
ok(g.avgMBPerHour === (6 * 128) / 0.75, `平均 = 6×128MB / 0.75h = \$\{g.avgMBPerHour\} MB/h`);
ok(g.peakToAvgRatio !== null && g.peakToAvgRatio > 1, `给出峰值/平均比 = ${g.peakToAvgRatio}`);
ok(typeof g.peakIsLowerBound === 'string' && g.peakIsLowerBound.includes('下界'), '明确声明观测峰值是下界');
ok(!/安全系数/.test(g.peakIsLowerBound), 'peakIsLowerBound 不再提安全系数');

// 没有新文件 → 必须拒答
const g0 = measureGrowth([mk(2), mk(2)].map((files) => ({ files })), { intervalHours: 1, fileSizeMB: 128 });
ok(g0.ok === false && /无法估算/.test(g0.reason), '无新文件时如实拒答');

// 推荐：不给 retentionHours 就不给数值
const rec = recommendArchiveParams({ growth: g, totalMB: 81856, freeMB: 73984, retentionHours: null });
ok(rec.ok === true, '给出推荐结构');
ok(rec.recommendations.ARCH_SPACE_LIMIT.value === null, '未给回溯窗口 → ARCH_SPACE_LIMIT 不给数值');
ok(Array.isArray(rec.recommendations.ARCH_SPACE_LIMIT.sensitivity) && rec.recommendations.ARCH_SPACE_LIMIT.sensitivity.length === 4,
  '给出 4 档敏感性表（1×/2×/5×/10×）');
ok(typeof rec.recommendations.ARCH_SPACE_FREE_THRESHOLD.value === 'number', 'FREQ_THRESHOLD 按容量比例给出数值');
ok(rec.recommendations.ARCH_SPACE_FREE_THRESHOLD.why.includes('容量的 15%'), '说明阈值按容量比例而非速率');
ok(!('peakSafetyFactor' in (rec.basis ?? {})) && !JSON.stringify(rec).includes('peakSafetyFactor'), '推荐结果里没有安全系数这一乘法因子（解释性文字可提及）');
ok(rec.notes.some((n) => n.includes('最旧归档距今')), '**主推荐是监控回溯窗口**');

// 给了 retentionHours → 给出数值，且仍附敏感性表
const rec2 = recommendArchiveParams({ growth: g, totalMB: 81856, freeMB: 73984, retentionHours: 24 });
ok(typeof rec2.recommendations.ARCH_SPACE_LIMIT.value === 'number', '给回溯窗口后 ARCH_SPACE_LIMIT 有数值');
ok(rec2.recommendations.ARCH_SPACE_LIMIT.sensitivity.length === 4, '仍附敏感性表');
ok(/只覆盖/.test(rec2.recommendations.ARCH_SPACE_LIMIT.why), '明确说明该值只覆盖实测峰值速率');

// 参数检查
const chk = checkArchiveParams({
  params: { columns: ['PARA_NAME', 'PARA_VALUE'], rows: [['ARCH_INI', '1'], ['ARCH_SPACE_CHECK_INTERVAL', '0'], ['ARCH_SPACE_FREE_THRESHOLD', '0']] },
  arch: { columns: ['ARCH_NAME', 'ARCH_TYPE', 'ARCH_DEST', 'ARCH_FILE_SIZE', 'ARCH_SPACE_LIMIT', 'ARCH_IS_VALID'], rows: [['A1', 'LOCAL', '+DMDATA/x', '128', '0', 'Y']] },
});
ok(chk.items[0].set === true, 'ARCH_INI 判定为已设');
ok(chk.gaps.length === 2, `识别出 2 个未设的系统级参数（实际 ${chk.gaps.length}）`);
ok(chk.unsetLimits.length === 1, '识别出未设上限的归档目标');

// 回溯窗口
const ret = observedRetention({ files: filesRes([{ path: 'a', time: '2026-10-01 00:00:00' }, { path: 'b', time: '2026-10-10 00:00:00' }]) });
ok(ret.ok === true && ret.ageHours > 0, `算出回溯窗口 ${ret.ageHours.toFixed(1)} 小时`);

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
process.exit(fail === 0 ? 0 : 1);
