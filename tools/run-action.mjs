/**
 * 通用真机运行器：把任意 action 通过**插件自己的 execute** 跑一遍（含完整渲染）。
 *
 * 用法：
 *   node tools/run-action.mjs --action readiness --host 10.127.11.61 --port 7236 \
 *        --user sysdba --password *** [--targets "10.127.11.61:7236,10.127.11.62:7237"]
 *
 *   node tools/run-action.mjs --action capacity  ... [--retention-hours 24] [--sample-sec 60]
 *   node tools/run-action.mjs --action list      ...
 *   node tools/run-action.mjs --action backup    ... [--path '+DMDATA/data/dameng/bak']
 *
 * 带恢复需求：**没有了** —— 「恢复需求达成度」整项移除（DESIGN §29.10，2026-10-13）。
 *   原来的 `--rpo-minutes` / `--target-time` / `--target-window` 与 RTO 那三个开关都已删除。
 *
 * 交付件落哪儿：`--out-dir <目录>`（不给则 `<插件工作目录>/dm-recovery-reports`）。
 *
 * 带 OS 访问（可选，插件会在主机上执行**三条只读命令**）：
 *   node tools/run-action.mjs --action backup ... \
 *        --ssh-host 10.127.11.40 --ssh-user root --ssh-password *** \
 *        --ssh-log-dir /home/dmdba/dmdbms/log [--ssh-script-path /home/dmdba/scan-backup-log.sh] \
 *        [--ssh-backup-dir /home/dmdba/dmbak] [--dmrman-dcr-ini /home/dmdba/dmdbms/data/DSC01/dmdcr.ini]
 *
 * ⚠️ `--ssh-password` 与 `--password` 一样会进入**命令行与会话日志**，仅用于临时联调。
 *
 * 为什么不直接调 lib/*：这样渲染层也被真数据走一遍，能发现「离线夹具通过、真机格式不同」的问题。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const plugin = await import(pathToFileURL(path.join(PKG, 'lib', 'index.js')).href);
let tool = null;
plugin.apply(
  { tools: { register: (t) => { tool = t; return () => {}; } }, get: () => undefined },
  {},
);
if (!tool) {
  console.error('FATAL: apply() 没有注册工具');
  process.exit(1);
}

const num = (v) => (v === undefined ? undefined : Number(v));
// 必须剔除 undefined：DSH 的 defineTool 会校验入参是**无损 JSON 对象**，
// 带 undefined 属性会被判 INVALID_ARGS（"must be a lossless JSON object"）。
const rawArgs = {
  action: flag('action') ?? 'readiness',
  host: flag('host'),
  port: num(flag('port')),
  user: flag('user') ?? 'SYSDBA',
  password: flag('password'),
  targets: flag('targets'),
  backupPath: flag('path'),
  retentionHours: num(flag('retention-hours')),
  sampleSec: num(flag('sample-sec')),
  sshHost: flag('ssh-host'),
  sshPort: num(flag('ssh-port')),
  sshUser: flag('ssh-user'),
  sshPassword: flag('ssh-password'),
  sshHostKey: flag('ssh-host-key'),
  plinkPath: flag('plink-path'),
  dmrmanPath: flag('dmrman-path'),
  // ★ ASM 上 `CHECK BACKUPSET` 能不能读就看它；DMDSC 上逐节点不同 → 逗号列表（DESIGN §31 / §38）
  dmrmanDcrIni: flag('dmrman-dcr-ini'),
  // 本轮新增：日志扫描与文件系统查找各需一个路径（见 DESIGN §20）
  sshLogDir: flag('ssh-log-dir'),
  sshScriptPath: flag('ssh-script-path'),
  sshBackupDir: flag('ssh-backup-dir'),
  // （原恢复需求三项 `--rpo-minutes` / `--target-time` / `--target-window` 已随该功能整项删除，§29.10）
  // 交付件落哪儿（不给则 `<插件工作目录>/dm-recovery-reports`）
  outDir: flag('out-dir'),
};
const args = Object.fromEntries(Object.entries(rawArgs).filter(([, v]) => v !== undefined));

const out = await tool.execute(args);
console.log(out.text);
console.log('');
console.log('--- 结果信封（DESIGN §25）---');
console.log(`tool          = ${out.tool} ／ resultVersion ${out.resultVersion}`);
console.log(`action        = ${out.action}`);
console.log(`generatedAt   = ${out.generatedAt}（来源 ${out.generatedAtSource}）`);
console.log(`level         = ${out.level ?? '（无权威分级）'}`);
console.log(`conclusion    = ${out.conclusion}`);
console.log(`summary       = ${JSON.stringify(out.summary)}`);
console.log(`findings      = ${out.findings?.length ?? 0} 条`);
for (const f of out.findings ?? []) {
  console.log(`  · ${String(f.id).padEnd(34)} [${f.level ?? '—'}] ${f.title}`);
}
console.log(`result keys   = ${Object.keys(out.result ?? {}).join(', ')}`);
console.log(`meta          = ${JSON.stringify(out.meta)}`);
if (out.reportPath) console.log(`reportPath    = ${out.reportPath}`);
if (out.findingsPath) console.log(`findingsPath  = ${out.findingsPath}`);
console.log('');
console.log('--- 兼容旧契约（一代，已废弃）---');
console.log(`verdict       = ${out.verdict}`);
console.log(`distinctPages = ${out.distinctPages}`);
console.log(`needAttention = ${out.needAttention}`);
