/**
 * 真机验证脚本：**直接调插件的 execute**，不经过 GUI。
 *
 * 为什么留着它：GUI 里点一次卡片只能看到渲染后的正文，看不到信封本体
 * （`findings` / `summary` / `result`）。排查"信封字段对不对"时，这个脚本比 GUI 直接。
 *
 * 用法（口令只从环境变量来，**不写进文件**）：
 *   $env:DM_HOST='10.127.11.40'; $env:DM_PORT='5236'; $env:DM_USER='awr1'; $env:DM_PASSWORD='…'
 *   $env:dm_recovery_readiness_HOME='<一个可写的插件工作目录>'
 *   node tools/live-check.mjs report
 *
 * 参数用 `k=v` 形式传（避免 PowerShell 里 JSON 的引号地狱）；纯数字自动转 Number。
 * ⚠️ 口令**不要**当命令行参数传（会进 shell 历史与会话日志）。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const plugin = await import(pathToFileURL(path.join(PKG, 'lib', 'index.js')).href);

let registered = null;
plugin.apply(
  {
    tools: {
      register: (t) => {
        registered = t;
        return () => {};
      },
    },
    get: () => undefined,
  },
  {},
);

const action = process.argv[2] ?? 'report';
const extra = {};
for (const a of process.argv.slice(3)) {
  const i = a.indexOf('=');
  if (i < 0) continue;
  const k = a.slice(0, i);
  const v = a.slice(i + 1);
  extra[k] = /^\d+(\.\d+)?$/.test(v) ? Number(v) : v;
}

const password = process.env.DM_PASSWORD;
if (!password) {
  console.error('缺少 DM_PASSWORD 环境变量（口令不走命令行参数，避免进 shell 历史）。');
  process.exit(2);
}

const args = {
  action,
  host: process.env.DM_HOST ?? '127.0.0.1',
  port: Number(process.env.DM_PORT ?? 5236),
  user: process.env.DM_USER ?? 'SYSDBA',
  password,
  ...extra,
};
const env = await registered.execute(args, {});

// 只打印**排除正文**的结构化部分 —— 正文单独打印在下面，便于各自阅读
const { text, ...rest } = env;
console.log(JSON.stringify(rest, null, 2));
console.log('\n================ 正文（text） ================\n');
console.log(text);
