/**
 * 真机跑插件的 `backup` 动作（只读，走插件自己的 execute，包含渲染）。
 *
 * 用法：
 *   node tools/check-backup.mjs --host 10.127.11.61 --port 7236 --user sysdba \
 *        --password *** [--path +DMDATA/data/dameng/bak]
 *
 * 之所以用插件的 execute 而不是直接调 lib/backup.js：这样**渲染层也被真数据走一遍**，
 * 能发现「离线夹具通过但真机格式不同」的问题。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const plugin = await import(pathToFileURL(path.join(PKG, 'lib', 'index.js')).href);

let tool = null;
const ctx = {
  tools: { register: (t) => { tool = t; return () => {}; } },
  get: () => undefined,
};
plugin.apply(ctx, {});

if (!tool) {
  console.error('FATAL: apply() 没有注册工具');
  process.exit(1);
}

const out = await tool.execute({
  action: 'backup',
  host: flag('host'),
  port: Number(flag('port') ?? 5236),
  user: flag('user') ?? 'SYSDBA',
  password: flag('password'),
  backupPath: flag('path'),
});

console.log(out.text);
console.log('');
console.log('--- 结构化字段（输出 schema 要求）---');
console.log('action        = ' + out.action);
console.log('verdict       = ' + out.verdict);
console.log('distinctPages = ' + out.distinctPages);
console.log('needAttention = ' + out.needAttention);
