/**
 * Node ↔ Java 桥。
 *
 * Node 侧没有达梦驱动，本插件又要求零依赖、免构建，所以用一个单文件 Java 程序
 * 做桥：**SQL 文件进，JSON 文件出**。
 *
 * 两个刻意的选择：
 *   1. **不用 stdio 传数据**：Windows 下 Java 的 stdin/stdout 编码容易出错，
 *      而中文对象名很常见。改成文件可以把编码钉死在 UTF-8，出问题还能直接看中间产物。
 *   2. **stdio: 'ignore'**：不捕获子进程输出，也就不会去开管道。
 *      在受限沙箱下用管道捕获子进程输出会 EPERM；而我们本来也不需要——
 *      Java 把错误写进 JSON 的 `fatal` 字段，stdout 无内容。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

/** 工作目录：放驱动、编译产物与临时文件。 */
export function defaultHome() {
  return process.env.dm_recovery_readiness_HOME || path.join(os.homedir(), '.dsh', 'dm-recovery-readiness');
}

export function ensureHome(home) {
  for (const sub of ['drivers', 'java', 'runtime', 'classes']) {
    fs.mkdirSync(path.join(home, sub), { recursive: true });
  }
  return home;
}

/**
 * 把达梦/连接类报错**归类**，并给出**可执行的一句话**（DESIGN §28）。
 *
 * 为什么值得单独做：以前连接失败会把桥的异常直接抛到调用方 —— 用户看到的是一段栈，
 * 而且**看不出"该做什么"**。更要紧的是本项目踩过一次真实事故：拿默认账号反复试口令，
 * 把账号试到 `登录失败次数超过限制`（**连续失败会锁账号**）。
 * 所以措辞里必须有两件事：**是什么错** + **别再重复试**。
 *
 * 纯函数（只吃一段文本），便于离线断言。
 */
export function classifyDbError(message) {
  const t = String(message ?? '');
  if (/登录失败次数超过限制|超限|account.*lock|LOCKED/i.test(t)) {
    return {
      kind: 'auth-locked',
      title: '数据库账号已被锁定（连续登录失败触发）',
      hint:
        '**继续重试不会解锁**，只会延长锁定。需要具备权限的账号执行 `ALTER USER <账号> ACCOUNT UNLOCK;`，解锁后再调用本工具。' +
        '（本项目单实例环境就发生过一次：拿默认账号反复试口令把 `awr1` 试锁了。）',
      level: 'crit',
    };
  }
  if (/用户名或密码错误|invalid.*(user|password)|authentication fail/i.test(t)) {
    return {
      kind: 'auth-failed',
      title: '数据库账号或口令不对',
      hint:
        '核对**账号**与口令：本插件的 `user` 默认是 `SYSDBA`，而有些环境（例如本项目单实例）实际可用账号是 `awr1` —— ' +
        '账号填错时口令再对也连不上。**不要反复重试**：达梦连续登录失败会**锁定账号**，解锁要 DBA 介入。',
      level: 'unknown',
    };
  }
  if (/未找到达梦 JDBC 驱动|DmJdbcDriver/i.test(t)) {
    return {
      kind: 'driver-missing',
      title: '没找到达梦 JDBC 驱动',
      hint: '把 `DmJdbcDriver8.jar`（或 `DmJdbcDriver18.jar`）放到插件工作目录的 `drivers/` 下（默认 `~/.dsh/dm-recovery-readiness/drivers`）。',
      level: 'unknown',
    };
  }
  if (/没有产出结果文件|javac|java 退出码/i.test(t)) {
    return {
      kind: 'runtime',
      title: 'JVM / 桥运行环境有问题',
      hint: '常见原因：`java`/`javac` 不在 PATH、JDK 与驱动 jar 版本不匹配。本插件需要 JDK（要 `javac` 编译只读桥）。',
      level: 'unknown',
    };
  }
  // ★ 本机文件系统问题 —— **必须排在网络分支之前**，措辞里绝不能说"连不上数据库"。
  //   实测原文：`EPERM: operation not permitted, open 'C:\Users\…\.dsh\dm-recovery-readiness\runtime\req-…sql'`。
  //   踩过的坑：插件把每次查询的 SQL 落到工作目录的 `runtime/` 下；工作目录在工作区之外、
  //   而宿主沙箱只允许写工作区时，这一步就 EPERM。**数据库其实是好的**（同机三个端口全通），
  //   结论却被打成「所有目标节点均无法连接」—— 读者会去查网络，查一辈子也查不到。
  //   这正是本项目最忌讳的一类错误：**结论把人指向错误的方向**。
  if (/EPERM|EACCES|operation not permitted|permission denied|拒绝访问|无权|只读文件系统|EROFS|ENOSPC|磁盘空间不足/i.test(t)) {
    return {
      kind: 'local-io',
      title: '本机读写插件工作目录失败（**不是数据库的问题**）',
      hint:
        '插件要在**工作目录**（默认 `~/.dsh/dm-recovery-readiness`，下有 `drivers/` `classes/` `runtime/`）里写 SQL 与结果文件，' +
        '当前这一步失败了：**数据库还没被连上**，所以本次没有任何结论。\n' +
        '处理：用 `dm_recovery_readiness_HOME=<可写目录>`（或插件配置的 `home`）把它指到一个**可写**位置，' +
        '并确认该目录下有 `drivers/DmJdbcDriver8.jar`。**不必去查数据库或网络** —— 原始错误里写了哪个路径打不开，就看那个路径。',
      level: 'unknown',
    };
  }
  // ★ 真机原文：连不上端口时达梦报的是 **`网络通信异常`**（不是英文的 refused/unreachable）——
  //   第一版分类器只匹配英文词，于是把它归成了 `other`。厂商措辞不能猜（本项目的老教训）。
  if (/网络通信异常|通信异常|连接失败|refused|unreachable|timeout|timed out|连接超时|无法连接|No route|UnknownHost|SocketTimeout/i.test(t)) {
    return {
      kind: 'unreachable',
      title: '连不上数据库（网络 / 端口 / 实例未启动）',
      hint: '核对主机、端口与实例状态；DMDSC 常见端口 7236/7237，单实例 5236。达梦在这种情况下的原文常是「网络通信异常」。',
      level: 'unknown',
    };
  }
  return { kind: 'other', title: '执行失败', hint: '原始错误见下；本插件**未做任何判断**。', level: 'unknown' };
}

/**
 * 找 JDBC 驱动 jar。
 * 达梦驱动是商业组件，不随插件分发，必须由用户放置——所以失败时要给出可执行的下一步。
 */
export function findDriverJar(home, explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  const dir = path.join(home, 'drivers');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (/^DmJdbcDriver\d*\.jar$/i.test(f)) candidates.push(path.join(dir, f));
    }
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

export function findJava(explicit) {
  const home = explicit || process.env.JAVA_HOME;
  return home ? path.join(home, 'bin', 'java') : 'java';
}

/** javac 路径：JAVA_HOME 优先，否则交给 PATH。 */
function findJavac(javaHome) {
  return javaHome ? path.join(javaHome, 'bin', 'javac') : 'javac';
}

let compiledCache = null;

/** 编译桥（一次即可，结果缓存在工作目录）。 */
export function ensureBridgeCompiled(home, driverJar, javaHome) {
  const src = path.join(PKG, 'assets', 'java', 'DmQuery.java');
  const classesDir = path.join(home, 'classes');
  const classFile = path.join(classesDir, 'DmQuery.class');
  const srcStat = fs.statSync(src);
  if (compiledCache && compiledCache.classFile === classFile && compiledCache.mtime === srcStat.mtimeMs && fs.existsSync(classFile)) {
    return { classesDir, classFile };
  }
  if (fs.existsSync(classFile) && fs.statSync(classFile).mtimeMs >= srcStat.mtimeMs) {
    compiledCache = { classFile, mtime: srcStat.mtimeMs };
    return { classesDir, classFile };
  }
  const javac = findJavac(javaHome);
  const args = ['-encoding', 'UTF-8', '-cp', driverJar, '-d', classesDir, src];
  const errFile = path.join(home, 'runtime', 'javac.err.txt');
  const r = runCapturingStderrToFile(javac, args, 120000, errFile);
  if (r.status !== 0) {
    const detail = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8').trim() : '(无 stderr)';
    throw new Error(
      `编译 JDBC 桥失败（javac 退出码 ${r.status}）。\n` +
        `请确认已安装 JDK（不只是 JRE），且 JAVA_HOME 指向它。\n` +
        `命令: ${javac} ${args.join(' ')}\n` +
        `javac 输出:\n${detail}`,
    );
  }
  compiledCache = { classFile, mtime: srcStat.mtimeMs };
  return { classesDir, classFile };
}

/**
 * 同步 spawn。**一律不开管道**——受限沙箱下用管道捕获子进程输出会 EPERM。
 * 需要看 stderr 时重定向到**文件**（打开文件不是开管道，因此被允许），
 * 这样既守住沙箱约束，又不用像最初那样把诊断信息全丢掉
 * （丢掉 stderr 曾让一个 javac 受检异常错误多查了两轮）。
 */
function runIgnoringStdio(cmd, args, timeoutMs) {
  return spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true, timeout: timeoutMs });
}

function runCapturingStderrToFile(cmd, args, timeoutMs, errFile) {
  fs.mkdirSync(path.dirname(errFile), { recursive: true });
  const fd = fs.openSync(errFile, 'w');
  try {
    return spawnSync(cmd, args, { stdio: ['ignore', 'ignore', fd], windowsHide: true, timeout: timeoutMs });
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 执行一批 SQL，返回逐条结果。
 *
 * @param {object} opts
 * @param {string} opts.home        工作目录
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {string} opts.user
 * @param {string} opts.password
 * @param {string} opts.sqlText     多条语句（分号分隔）
 * @param {string} [opts.driverJar]
 * @param {string} [opts.javaHome]
 * @param {number} [opts.maxRows]
 * @param {number} [opts.timeoutSec]
 * @returns {Promise<{statements:Array,fatal:string|null,executed:number,rejected:number,failed:number}>}
 */
export async function runSql(opts) {
  const home = ensureHome(opts.home || defaultHome());
  const driverJar = findDriverJar(home, opts.driverJar);
  if (!driverJar) {
    throw new Error(
      '未找到达梦 JDBC 驱动。达梦驱动是商业组件、不随插件分发，需要你手动放置：\n' +
        `  把达梦安装目录下的 dmdbms/drivers/jdbc/DmJdbcDriver8.jar（或 DmJdbcDriver18.jar）\n` +
        `  复制到 ${path.join(home, 'drivers')}\\ 下即可。`,
    );
  }
  const { classesDir } = ensureBridgeCompiled(home, driverJar, opts.javaHome);

  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sqlFile = path.join(home, 'runtime', `req-${stamp}.sql`);
  const outFile = path.join(home, 'runtime', `res-${stamp}.json`);
  fs.writeFileSync(sqlFile, opts.sqlText, 'utf8');

  const java = findJava(opts.javaHome);
  const cp = `${classesDir}${path.delimiter}${driverJar}`;
  const args = [
    '-Dfile.encoding=UTF-8',
    '-cp',
    cp,
    'DmQuery',
    String(opts.host),
    String(opts.port),
    String(opts.user),
    String(opts.password),
    sqlFile,
    outFile,
    String(opts.maxRows ?? 500),
    String(opts.timeoutSec ?? 120),
  ];

  try {
    const r = runIgnoringStdio(java, args, (opts.timeoutSec ?? 120) * 1000 + 30000);
    if (!fs.existsSync(outFile)) {
      throw new Error(
        `JDBC 桥没有产出结果文件（java 退出码 ${r.status}）。` +
          `常见原因：java 不在 PATH、驱动 jar 与 JDK 版本不匹配、或连接被拒绝。\n` +
          `命令: ${java} ${args.join(' ')}`,
      );
    }
    return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } finally {
    // 临时文件留在 runtime/ 下便于排查；超过 50 个就清理最旧的
    try {
      const runtime = path.join(home, 'runtime');
      const files = fs.readdirSync(runtime).map((f) => path.join(runtime, f));
      if (files.length > 50) {
        files
          .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
          .sort((a, b) => a.t - b.t)
          .slice(0, files.length - 50)
          .forEach(({ f }) => fs.rmSync(f, { force: true }));
      }
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}

/**
 * 带 fallback 的批量执行。
 *
 * 为什么要「批量 + 按需重试」而不是逐条跑：每次调用都要起一个 JVM（约 1 秒），
 * 逐条跑会让一次体检慢上十几倍。所以：
 *   第 1 轮：所有查询的首选语句一次跑完；
 *   第 2..n 轮：只把报「无效的列名/表名」的那些换成备选，再批量跑一次。
 *
 * @returns {Promise<Record<string, {columns,rows,error,sqlUsed}>>}
 */
export async function runQueries(opts, queries) {
  const out = {};
  const needsRetry = [];

  const batch = async (list) => {
    if (list.length === 0) return [];
    const sqlText = list.map((q) => `${q.sql};`).join('\n') + '\n';
    const res = await runSql({ ...opts, sqlText });
    if (res.fatal) throw new Error(`JDBC 桥致命错误: ${res.fatal}`);
    return res.statements ?? [];
  };

  // 第 1 轮
  const first = await batch(queries.map((q) => ({ sql: q.sql })));
  queries.forEach((q, i) => {
    const r = first[i] ?? { columns: null, rows: [], error: 'NO_RESULT' };
    if (r.error && (q.fallbacks?.length ?? 0) > 0 && isNameError(r.error)) {
      needsRetry.push({ key: q.key, idx: i, fallbacks: q.fallbacks });
    }
    out[q.key] = { columns: r.columns ?? null, rows: r.rows ?? [], error: r.error ?? null, sqlUsed: q.sql };
  });

  // 第 2..n 轮：逐层降级
  let depth = 0;
  while (needsRetry.length > 0 && depth < 5) {
    const list = needsRetry.map((n) => ({ sql: n.fallbacks[depth] })).filter((x) => x.sql);
    if (list.length === 0) break;
    const got = await batch(list);
    const still = [];
    let k = 0;
    for (const n of needsRetry) {
      if (!n.fallbacks[depth]) continue;
      const r = got[k++] ?? { columns: null, rows: [], error: 'NO_RESULT' };
      if (!r.error) {
        out[n.key] = { columns: r.columns ?? null, rows: r.rows ?? [], error: null, sqlUsed: n.fallbacks[depth] };
      } else if (depth + 1 < n.fallbacks.length && isNameError(r.error)) {
        still.push(n);
      } else {
        out[n.key] = { columns: r.columns ?? null, rows: r.rows ?? [], error: r.error ?? null, sqlUsed: n.fallbacks[depth] };
      }
    }
    needsRetry.length = 0;
    needsRetry.push(...still);
    depth++;
  }

  return out;
}

/** 只有「名字不对」才值得换一条 SQL；权限/连接类错误换语句也没用。 */
function isNameError(msg) {
  return /无效的列名|无效的表或视图名|无效的表名|invalid column|invalid identifier|does not exist/i.test(String(msg));
}

