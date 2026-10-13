/**
 * OS 访问层 —— 在数据库主机上执行**极少数**只读命令。
 *
 * ## 这会改变插件的信任边界，所以边界写死在代码里，不靠自觉
 *
 * 加这一层之前，插件只经 JDBC 读库，连一次写操作都不可能发生。
 * 加之后它能**在数据库主机上执行命令**了。因此：
 *
 * 1. **命令只能由本模块的三个构造函数产生**，没有任何接受"任意命令字符串"的入口。
 * 2. **参数逐字符校验**（`safeArg`）：只放行路径里真正会用到的字符集，
 *    引号、分号、管道、重定向、`$`、反引号、空格、换行、括号一律**抛错**。
 *    所以「把用户输入拼进命令」这条路在类型上就不存在。
 * 3. **三条命令全是只读**：
 *      · `dmrman CTLSTMT="CHECK BACKUPSET '<path>'"` —— 校验备份集，不改任何东西；
 *      · `sh <随插件提供的 scan-backup-log.sh> '<logdir>'` —— 只读扫描日志；
 *      · `find/ls` —— 只在文件系统上找备份文件。
 *    **没有** `RESTORE` / `RECOVER` / `dmrman` 交互模式，也没有任何写命令。
 * 4. 不进入 `dmrman` 交互模式（实测 `dmrman help` 只会吐提示符），一律用 `CTLSTMT=` 一次性执行。
 *
 * ## 为什么 stdout/stderr 走文件而不是管道
 *
 * 实测教训：受限沙箱下用管道捕获子进程输出会 EPERM。本项目一律
 * `stdio: ['ignore', <outFile fd>, <errFile fd>]`，再从文件读。plink 的提示也会进 stderr 文件。
 *
 * ## plink 还是 ssh
 *
 * 非交互地传口令，Windows 上只能靠 plink（OpenSSH 不收非交互口令）。
 * 代价：口令会出现在 plink 的进程参数里 —— 这是**已知弱点**，README 里写明。
 * 更稳的做法是换成密钥（`ssh -i`），那样插件配置里根本不需要口令。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// 只用 `spawn`（异步）：多节点要并发，而 `spawnSync` **阻塞事件循环**、`Promise.all` 包不住它
import { spawn } from 'node:child_process';

/** 路径参数允许的字符集。**故意很窄** —— 常见路径足够用，而注入所需的一切都在外面。 */
const SAFE_ARG = /^[A-Za-z0-9._\-/+=:@%~]+$/;

/**
 * 校验一个将用于 shell 的路径参数。
 * 不合法就**抛错**（不是静默清洗）—— 静默清洗会让人以为命令按他给的原样执行了。
 */
export function safeArg(v, what = '参数') {
  const s = String(v ?? '');
  if (s === '') throw new Error(`${what}为空`);
  if (!SAFE_ARG.test(s)) {
    const bad = [...new Set(s.split('').filter((c) => !SAFE_ARG.test(c)))].join('');
    throw new Error(`${what}含不允许的字符 «${bad}»：${s}`);
  }
  return s;
}

/** 校验整数端口/超时。 */
export function safeInt(v, what, { min = 1, max = 65535 } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${what} 非法：${v}`);
  return n;
}

// ---------------------------------------------------------------------------
// 三个命令构造函数 —— 本模块**唯一**能产出命令的地方
// ---------------------------------------------------------------------------

/**
 * 唯一权威的备份集校验命令。`<path>` 只能来自 `V$BACKUPSET` 或调用方显式给出。
 *
 * ★ `dcrIni`（DESIGN §31）：备份集在 **ASM** 上时必须给，否则 dmrman 够不到它。
 *
 * 真机实测（DMDSC，2026-10-12，备份路径 `+DMDATA/data/dameng/bak/DB_dameng_FULL_…`）：
 *
 * | 命令 | 结果 |
 * | --- | --- |
 * | `dmrman CTLSTMT="CHECK BACKUPSET '+DMDATA/…'"` | `SBT[-127] 无效的备份集目录` + `MML[-10001] 设置第三方MM属性失败` |
 * | 同上，**以 dmdba 身份**跑 | **一样失败** —— 所以这不是"用户权限"问题 |
 * | `dmrman DCR_INI=<dmdcr.ini> CTLSTMT=…` | ✅ `check backupset successfully.`（2.9 秒） |
 * | `dmrman USE_AP=1 AP_PORT=4236 DCR_INI=… CTLSTMT=…` | ✅ 同样成功（`USE_AP`/`AP_PORT` 并非必需） |
 *
 * 也就是说：**缺的只是 DCR 配置**（`dmdcr.ini` 里 `DMDCR_MAL_PATH` 指向 `dmasvrmal.ini`，
 * dmrman 靠它找到 ASM 集群）。加上它，"备份可不可读"就从**未知**变成**确定** ——
 * 而这正是 B6「备份集本身损坏 / 不可读」唯一要问的问题。
 *
 * `dmdcr.ini` 的路径**由调用方给**（不做自动发现）：它逐节点不同
 * （`…/data/DSC01/dmdcr.ini` vs `…/data/DSC02/dmdcr.ini`），且"猜配置文件位置"不该由工具来做。
 * 拿不准就先 `ps -ef | grep dmserver`，看 `dcr_ini=` 后面是什么。
 */
export function buildCheckBackupset(backupPath, dmrmanPath = 'dmrman', dcrIni = null) {
  const dcr = dcrIni ? ` DCR_INI=${safeArg(dcrIni, 'dmdcr.ini 路径')}` : '';
  return `${safeArg(dmrmanPath, 'dmrman 路径')}${dcr} CTLSTMT="CHECK BACKUPSET '${safeArg(backupPath, '备份集路径')}'"`;
}

/** 只读扫描 DM 日志（随插件提供的脚本，纯 ASCII + LF，真机验证过）。 */
export function buildScanLog(logDir, scriptPath) {
  return `sh ${safeArg(scriptPath, '脚本路径')} ${safeArg(logDir, '日志目录')}`;
}

/**
 * 在文件系统上找备份文件。**只在备份路径不是 ASM（不以 `+` 开头）时才有意义** ——
 * ASM 不是文件系统，`find` 看不到。调用方要先判断路径形态。
 */
/** 通配符匹配式的字符集 —— 比路径**更窄**，只多一个 `*`（`find -name` 需要它）。 */
const SAFE_GLOB = /^[A-Za-z0-9.*_-]+$/;
export function safeGlob(v, what = '匹配式') {
  const s = String(v ?? '');
  if (s === '' || !SAFE_GLOB.test(s)) throw new Error(`${what}非法：${v}`);
  return s;
}

export function buildFindBackups(backupDir, patterns = ['*.bak', '*.bkp', '*.meta']) {
  const d = safeArg(backupDir, '备份目录');
  // ★ 匹配式**不走 safeArg**：它是插件常量、不是用户输入，而 `*` 恰恰是 `find -name` 要用的。
  //   但仍过一道**更窄**的 glob 校验 —— 防止将来有人把外部输入接到这个参数上。
  const p = patterns.map((x) => safeGlob(x));
  return `ls -la ${d} 2>/dev/null; find ${d} -maxdepth 2 -type f \\( ${p.map((x) => `-name '${x}'`).join(' -o ')} \\) 2>/dev/null | head -200`;
}

// ---------------------------------------------------------------------------

function readQuiet(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 执行一条**由上面三个构造函数产出**的命令。
 *
 * 仍然在这里再校验一次"命令是不是我们认可的形态" —— 纵深防御：
 * 即使将来有人新增了调用路径，也过不了这一关。
 *
 * ★ 为什么是 `async`（DESIGN §42）：原来用 `spawnSync`，**阻塞事件循环** ——
 * 于是"多节点 × 三条命令"只能一条一条排队。实测那份报告里 OS 段独占 **12.8 秒 / 18 秒（71%）**，
 * 而它本质上只是 6 条互不依赖的远端命令。
 * ⚠️ 但**不能**简单地把 `spawnSync` 包进 `Promise.all` —— `spawnSync` 是同步的，
 * `Promise.all` 拿到的只是"已经跑完的结果"，一点都不会并发。所以这里换成 `spawn` + Promise。
 * 仍然**不开管道**：输出重定向到文件（沙箱下开管道会 EPERM），`stdio: ['ignore', outFd, errFd]`。
 *
 * 刻意**只保留这一个执行器**（不另加一个 `runRemoteAsync`）：同一语义两份实现，
 * 迟早只有一份是对的（§39.2 刚吃过这个亏）。
 */
export async function runRemote({
  command,
  host,
  port = 22,
  user,
  password,
  hostKey,
  plinkPath = 'plink',
  timeoutMs = 120000,
}) {
  const cmd = String(command ?? '');
  const allowed =
    /^[A-Za-z0-9._\-/+=:@%~]+( DCR_INI=[A-Za-z0-9._\-/+=:@%~]+)? CTLSTMT="CHECK BACKUPSET '[^']*'"$/.test(cmd) ||
    /^sh [A-Za-z0-9._\-/+=:@%~]+ [A-Za-z0-9._\-/+=:@%~]+$/.test(cmd) ||
    /^ls -la [A-Za-z0-9._\-/+=:@%~]+ 2>\/dev\/null; find [A-Za-z0-9._\-/+=:@%~]+ -maxdepth 2 -type f \\\( .* \\\) 2>\/dev\/null \| head -200$/.test(
      cmd,
    );
  if (!allowed) throw new Error(`拒绝执行非白名单形态的命令：${cmd.slice(0, 120)}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-ossh-'));
  const outFile = path.join(tmp, 'out.txt');
  const errFile = path.join(tmp, 'err.txt');
  const args = ['-ssh', '-batch', '-P', String(safeInt(port, 'SSH 端口')), `${user}@${host}`, '-pw', String(password)];
  if (hostKey) args.push('-hostkey', String(hostKey));
  args.push(cmd);

  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let res;
  try {
    res = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      let child;
      try {
        child = spawn(plinkPath, args, {
          stdio: ['ignore', outFd, errFd], // ← 不走管道（沙箱下 EPERM）
          windowsHide: true,
        });
      } catch (e) {
        done({ status: -1, signal: null, error: e });
        return;
      }
      // 超时自己收（`spawn` 没有 `timeout` 选项）：先 kill，再按超时记账。
      // `settled` 守卫保证后到的 `close` 不会把结论改回去。
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 已经退了就算了 */
        }
        done({ status: -1, signal: 'timeout', error: new Error(`执行超时（${timeoutMs} ms）`) });
      }, timeoutMs);
      child.on('error', (e) => done({ status: -1, signal: null, error: e }));
      child.on('close', (code, signal) => done({ status: code ?? -1, signal, error: null }));
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }

  const stdout = readQuiet(outFile);
  const stderr = readQuiet(errFile);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结果 */
  }

  const status = res?.status ?? -1;
  return {
    ok: status === 0,
    status,
    stdout,
    stderr,
    signal: res?.signal ?? null,
    error: res?.error ? String(res.error.message ?? res.error) : null,
  };
}

/**
 * 去掉终端控制序列。
 *
 * 真机实测（DMDSC，`dmrman CHECK BACKUPSET`）：dmrman 会往 stdout 写一个 **OSC 标题序列**
 * 来设置窗口标题 —— 于是报告里的「结论依据」第一行变成
 * `\u001b]0; DMRMAN dcr_ini=… ap_port=4236 CHECK BACKUPSET '…'`，
 * 一个不可见的 ESC 混在交付件里（JSON 里是 `\u001b`，HTML 里是一段乱码前缀）。
 *
 * 两种形态都要处理：
 *   · 完整序列 `ESC ] 0 ; <标题> BEL|ST`（`ANSI_OSC`）；
 *   · CSI 序列 `ESC [ … 字母`（`ANSI_CSI`，进度条/颜色用它）；
 *   · 兜底：剩下孤立的 `ESC` 一律删掉。
 *
 * ⚠️ `ANSI_OSC` 里**必须排除换行**：真机上 dmrman 那个标题序列**没有终止符**
 * （既无 BEL 也无 ST），若允许 `[^…]*` 吃掉换行，它会把**后面所有输出**一起吞掉 ——
 * 自检里那条"带 OSC 仍判 ok"的断言就是这么抓到的（detail 被清成空串）。
 */
const ANSI_OSC = /\u001b\][^\u0007\u001b\r\n]*(?:\u0007|\u001b\\)?/g;
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export function stripAnsi(v) {
  return String(v ?? '')
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(/\u001b/g, '');
}

/**
 * 从 dmrman 输出里挑出**有信息量的行**。
 *
 * 为什么需要：实测 `CHECK BACKUPSET` 的 stdout 前段全是进度条刷新
 * （`[Percent:0.00%][Speed:0.00M/s][Cost:00:00:00][Remaining:00:00:00]` 反复重绘，
 * 还夹着大段空白填充）。早先直接取 `text.slice(-4)`，于是报告里的「结论依据」
 * 真机原文长这样：
 *
 * ```
 * [Percent:0.00%][Speed:0.00M/s]…[Percent:100.00%][Speed:5541.41M/s]… / check backupset successfully. / time used: 732.826(ms)
 * ```
 *
 * 真信息只有最后两段，却被进度条挤在同一行里。这里先把进度条**抠掉**再取最后 n 行。
 * 还顺手 `stripAnsi` 掉终端控制序列（见上）。
 */
export function meaningfulLines(text, n = 4) {
  return stripAnsi(text)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    // 行内可能混着进度条 + 真信息：抠掉进度条片段，再收敛空白
    .map((l) => l.replace(/\[(?:Percent|Speed|Cost|Remaining):[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '')
    .slice(-n);
}

/**
 * 从 `dmrman CHECK BACKUPSET` 的输出里判断结论。
 *
 * **保守**：只有明确看到成功标志才算通过；有错字样直接判失败；
 * 两者都没有则 `unknown` —— **绝不把"没看懂"当成"通过"**。
 */
export function judgeCheckBackupset(res) {
  if (!res) return { state: 'unknown', detail: '未执行' };
  if (res.error) return { state: 'unknown', detail: `无法执行：${res.error}` };
  const text = `${res.stdout}\n${res.stderr}`;
  if (!text.trim()) return { state: 'unknown', detail: '命令无任何输出（检查 plink 路径、主机可达性与主机密钥）' };
  // plink 自身的失败（口令错、主机密钥未确认）会出现在 stderr。
  // ★ 先用**特征明确**的判定（`sshTroubleNote` 会带上「怎么修」的提示）；
  //   下面那条宽泛的旧判据保留作兜底 —— 两者都会落到 `unknown`，不会当成通过、也不会当成损坏。
  const trouble = sshTroubleNote(res);
  if (trouble) return { state: 'unknown', detail: trouble };
  if (/Access denied|password|Unable to open connection|host key|Host key|refused/i.test(text) && res.status !== 0) {
    return { state: 'unknown', detail: `SSH 层失败：${text.trim().split('\n').slice(0, 3).join(' / ')}` };
  }
  const okHit = /check backupset success|successfully|校验成功/i.test(text);
  // ★ 必须先区分「备份集本身有问题」与「dmrman 根本没够到备份集」。
  //   实测（DMDSC，2026-10-10）：`CHECK BACKUPSET '+DMDATA/...'`（ASM 路径）报
  //     SBT[-127] 无效的备份集目录[...]
  //     MML[-10001] 设置第三方MM属性失败，错误码[-127]
  //   —— 这是 **dmrman 未配置 ASM / 第三方 MML 访问**，**不能据此说备份损坏**。
  //   早先把这类输出判成 `bad`，等于把「工具够不着」谎报成「备份坏了」。
  const accessTrouble = /无效的备份集目录|第三方\s*MM|MML\[|SBT\[|dmasm|Cannot open|无法连接/i.test(text);
  const corrupt = /备份集[^。\n]{0,12}(损坏|不完整|corrupt)|corrupted backup|checksum[^。\n]{0,12}(fail|error|错误)/i.test(text);
  if (corrupt) return { state: 'bad', detail: meaningfulLines(text, 4).join(' / ') };
  if (accessTrouble) {
    return {
      state: 'unknown',
      detail:
        '**dmrman 未能访问到备份集，这不是「备份损坏」的证据。** 原始输出：' +
        meaningfulLines(text, 4).join(' / ') +
        (/\+\w/.test(text)
          ? '　提示：该备份路径是 ASM（以 `+` 开头）。**真机实测（DMDSC，2026-10-12）**：' +
            '缺的只是 DCR 配置 —— 加上 `DCR_INI=<dmdcr.ini>` 后同一条命令立刻变成 ' +
            '`check backupset successfully.`（2.9 秒）；换用户（root/dmdba）都不管用，' +
            '`USE_AP=1 AP_PORT=…` 也不是必需。所以请用 `dmrmanDcrIni` 参数把 `dmdcr.ini` 的路径给上，' +
            '路径可从 `ps -ef | grep dmserver` 的 `dcr_ini=` 里看到。'
          : ''),
    };
  }
  // SSH 层压根没连上时，别让它掉进下面那句「有错误字样 => bad」
  const trouble2 = sshTroubleNote(res);
  if (trouble2) return { state: 'unknown', detail: trouble2 };
  const badHit = /error|fail|无效|失败|损坏|corrupt/i.test(text);
  if (badHit && !okHit) return { state: 'bad', detail: meaningfulLines(text, 4).join(' / ') };
  if (okHit) return { state: 'ok', detail: meaningfulLines(text, 3).join(' / ') };
  return { state: 'unknown', detail: `输出无法判定（退出码 ${res.status}）：${meaningfulLines(text, 3).join(' / ')}` };
}

/**
 * 路径是不是 ASM。
 *
 * **只有文件系统路径才谈得上「在磁盘上找备份」** —— ASM 不是文件系统，
 * `find`/`ls` 本来就看不到那些文件（§11、README 里都写过这一条）。
 * 所以调用方必须先判断形态，再决定要不要跑 `buildFindBackups`。
 */
export function isAsmPath(p) {
  return String(p ?? '').trim().startsWith('+');
}

const trimSlash = (p) => String(p ?? '').replace(/\/+$/, '');
const dirnameOf = (p) => {
  const s = trimSlash(p);
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i) : s;
};

/**
 * 从若干个候选路径里挑出「该去 `find` 哪个目录」。
 *
 * 规则（**每一条都有理由，猜错就会指错目录**）：
 *   · 一个 DM 备份集本身是**目录**（形如 `.../DB_dameng_FULL_20261010_150250_003731`），
 *     所以默认按目录用；只有明显是文件（带 1~6 位扩展名）的候选才退到它所在目录；
 *   · **跳过所有 ASM 路径**（`+` 开头）—— ASM 不是文件系统；
 *   · 一个都没有（例如账本里全是 ASM）→ 返回 `null`，调用方就**不做这一步**。
 */
export function pickFindDir(candidates) {
  const asDir = (p) => {
    const s = trimSlash(p);
    return /\.[A-Za-z0-9]{1,6}$/.test(s) ? dirnameOf(s) : s;
  };
  return (candidates ?? []).filter(Boolean).map(asDir).find((d) => !isAsmPath(d)) ?? null;
}

/**
 * **SSH 层自己失败**的判定 —— 真机实测（2026-10-12，`10.127.11.40:22`）暴露的缺陷：
 *
 * 用错口令 / 主机密钥未缓存时，plink 会在 **stderr** 里写清原因并**立刻退出**（实测 60ms），
 * **stdout 为空**。而 `parseCorruptionVerdict` / `parseFindBackups` 只看 stdout，
 * 于是它们会报「脚本无输出」「目录可能不存在」—— **把「根本没连上」谎报成「命令跑了但没结果」**，
 * 让人跑去查脚本路径或备份目录，而真正的原因在 stderr 里躺着。
 *
 * 所以：解析 stdout 之前先问一句「传输层是不是就失败了」。
 * 判据只认 plink 自己那几句**特征明确**的报错（远端 dmrman/脚本不会这么写），
 * 外加 spawn 本身的 error（plink 不在 PATH 等）。
 */
export function sshTroubleNote(res) {
  if (!res) return null;
  if (res.error) return `**SSH 层无法执行**（连 plink 都没跑起来）：${res.error}`;
  if (res.ok) return null;
  const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
  const plinkTrouble =
    /host key is not cached|host key does not match|Connection abandoned|Unable to open connection|Access denied|Server refused|FATAL ERROR: Cannot|Network error/i;
  if (!plinkTrouble.test(text)) return null;
  const hint = /host key/i.test(text)
    ? '\n> **plink 在 `-batch` 模式下要求主机密钥已知**：用 `sshHostKey` 传指纹' +
      '（形如 `ssh-ed25519 255 SHA256:...`），或先手工接受一次。'
    : '';
  return (
    '**SSH 层失败 —— 命令根本没跑起来，所以这个「无法判定」与脚本路径、备份目录都无关。**\n> 原始输出：' +
    text.split('\n').slice(0, 3).join(' / ') +
    hint
  );
}

/**
 * 从 `scan-backup-log.sh` 的输出里取「页完整性证据」。
 *
 * ## 两个来源，**不是**同一件事（DESIGN §46 实测）
 *
 * | 来源 | 是什么 | 实测局限 |
 * | --- | --- | --- |
 * | ② 备份日志 `N corrupted pages during backup` | 全备自己的页计数器 | **会漏**：本次把一页数据清零后做全备，它照样报 `0 corrupted pages`，而读那一页直接把实例打停 |
 * | ⑥ 实例日志 `[EID:48] Server page check error! page:(ts,file,page)` + `SHUTDOWN ABORT` | DM 真的读到坏页时的崩溃证据 | 只在**有人碰到过**时才有；`dm_DMSERVER_*.log` 会滚动 |
 *
 * 所以**任一条成立就算有坏页证据**，且必须在正文里说清是哪一条给出的 ——
 * 只报"② 说 0"就会得到"这个库没有坏页"这个**假结论**（真机上就是这么发生的）。
 * 权威手段仍是离线 `dmdbchk`（插件不能停库，只能建议）。
 */
export function parseCorruptionVerdict(stdout) {
  const t = String(stdout ?? '');
  if (!t.trim()) return { state: 'unknown', count: null, detail: '脚本无输出' };

  // ---- 来源⑥：实例日志里的页校验失败（在线唯一可靠证据）
  const pageCheckErrors = [
    ...t.matchAll(/page check error!\s*page:\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g),
  ].map((m) => ({ tsId: Number(m[1]), fileId: Number(m[2]), pageNo: Number(m[3]) }));
  const abortCount = (t.match(/SHUTDOWN ABORT|dm_sys_halt/g) ?? []).length;

  // ---- 来源②：备份日志的页计数器
  const hits = [...t.matchAll(/(\d+)\s+corrupted pages during backup/g)];
  const nums = hits.map((m) => Number(m[1]));
  const worst = nums.length ? Math.max(...nums) : null;

  const pgTxt = pageCheckErrors.length
    ? pageCheckErrors
        .slice(0, 5)
        .map((e) => `(${e.tsId}, ${e.fileId}, ${e.pageNo})`)
        .join('、') + (pageCheckErrors.length > 5 ? ` 等 ${pageCheckErrors.length} 处` : '')
    : null;

  if (pageCheckErrors.length > 0) {
    return {
      state: 'corrupt',
      count: worst,
      occurrences: nums.length,
      pageCheckErrors,
      abortCount,
      detail:
        `**实例日志里记录过页校验失败**：${pgTxt}` +
        (abortCount ? `，并伴随 **${abortCount}** 次 \`SHUTDOWN ABORT\`／\`dm_sys_halt\`（读到坏页会把整个实例打停）` : '') +
        '。\n' +
        (worst === 0
          ? '⚠️ **同一时间窗内，全备日志报的是 `0 corrupted pages`** —— 两者不矛盾：实测证明**全备页计数器抓不到这类坏页**（DESIGN §46）。**以实例日志为准。**\n'
          : worst !== null
            ? `全备日志同时报告最多 **${worst}** 个损坏页。\n`
            : '本次没取到全备日志的页计数行。\n') +
        '这些是**日志里的历史事件**：页可能已被修复或已通过还原回滚 —— ' +
        '要判断**当前**还有没有坏页，只能停库跑 DM 自带的 `dmdbchk`（离线，见报告里的建议命令）。',
    };
  }

  if (nums.length === 0) {
    return {
      state: 'unknown',
      count: null,
      pageCheckErrors: [],
      abortCount,
      detail:
        '既没有 `N corrupted pages during backup`，实例日志里也没有页校验失败记录 —— ' +
        '可能从未做过全备、日志已滚掉，或确实还没人碰到坏页。**这不能当成「没有坏页」**',
    };
  }
  return {
    state: worst === 0 ? 'clean' : 'corrupt',
    count: worst,
    occurrences: nums.length,
    pageCheckErrors: [],
    abortCount,
    detail:
      worst === 0
        ? `最近 ${nums.length} 次全备均报告 **0 corrupted pages**，且实例日志里**没有**页校验失败记录。\n` +
          '⚠️ 但这两条都**不是**「全库无坏页」的证明：全备计数器会漏（§46 实测），实例日志只覆盖"有人碰到过"的情形。' +
          '要正面结论请用离线 `dmdbchk`。'
        : `全备日志报告最多 **${worst}** 个损坏页（共 ${nums.length} 次记录）`,
  };
}

/**
 * 从 `buildFindBackups` 的输出里取出「磁盘上到底有哪些备份文件」。
 *
 * 命令输出 = `ls -la <目录>`（可能有 `total N` 与权限位行）+ `find ... -name ...`（纯路径行）。
 * 所以判据是：**带空格的行视为 `ls` 长格式**，其余含 `/` 的行视为 `find` 给出的路径。
 * 文件名里含空格的会被漏掉 —— 这是**已知取舍**（宁可少列，也不把 `ls` 的列错当成路径）。
 *
 * ⚠️ 它只回答「**文件在不在**」，**不回答「备份能不能用」** —— 后者只有 `CHECK BACKUPSET` 能给。
 */
export function parseFindBackups(stdout) {
  const t = String(stdout ?? '');
  const lines = t.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '');
  if (lines.length === 0) {
    return {
      state: 'unknown',
      files: [],
      paths: [],
      detail: '命令无输出（目录可能不存在，或 `ls`/`find` 都够不到它）—— **不能**据此说「没有备份」',
    };
  }
  const isListing = (l) => /^total\b/i.test(l) || /^[-dlbcps][rwxStTs-]{9}[.@+]?\s/.test(l);
  const paths = lines.filter((l) => !isListing(l) && !/\s/.test(l) && l.includes('/'));
  const BK = /\.(bak|bkp|meta|dbf)$/i;
  const files = paths.filter((p) => BK.test(p));
  return {
    state: files.length > 0 ? 'found' : 'none',
    files: files.slice(0, 50),
    paths: paths.slice(0, 50),
    detail:
      files.length > 0
        ? `找到 ${files.length} 个疑似备份文件（下面最多列 50 个）`
        : `输出有 ${lines.length} 行，但**没有**匹配到 *.bak / *.bkp / *.meta / *.dbf`,
  };
}

/**
 * 高层封装：跑一次 `CHECK BACKUPSET` 并给出**保守**结论。
 * `ssh` = `{host, port, user, password, hostKey, plinkPath}`（与 `runRemote` 同名）。
 *
 * `run` 可注入（默认 `runRemote`）—— 只为**离线自检**能锁住解析逻辑，
 * 生产路径永远用默认值，**没有任何接受任意命令字符串的入口**。
 */
export async function checkBackupsetViaSsh({ backupPath, dmrmanPath = 'dmrman', dcrIni = null, ssh, run = runRemote }) {
  const command = buildCheckBackupset(backupPath, dmrmanPath, dcrIni);
  // `await` 对**同步**注入的 `run`（自检里就是同步函数）同样成立 —— 两种都支持，不必各写一份
  const res = await run({ command, ...ssh });
  return { command, res, verdict: judgeCheckBackupset(res) };
}

/**
 * 高层封装：跑一次日志扫描，取「全库逐页裁决」。
 *
 * ⚠️ 脚本本身**必须先存在于数据库主机上**（随插件放在 `assets/shell/scan-backup-log.sh`，
 * 由运维 scp 过去）。插件没有上传通道 —— 所以路径由调用方给，
 * 且失败信息里会把**实际执行的命令**摊开，方便排查。
 */
export async function scanBackupLogViaSsh({ logDir, scriptPath, ssh, run = runRemote }) {
  const command = buildScanLog(logDir, scriptPath);
  const res = await run({ command, ...ssh });
  // ★ 先判传输层：没连上时 `parseCorruptionVerdict` 只会看到空 stdout，
  //   会报成「脚本无输出」—— 那是在**谎报原因**（真机实测踩到过，见 `sshTroubleNote`）。
  const trouble = sshTroubleNote(res);
  return {
    command,
    res,
    verdict: trouble ? { state: 'unknown', count: null, detail: trouble } : parseCorruptionVerdict(res.stdout),
  };
}

/**
 * 高层封装：在文件系统上找备份文件。
 * **调用方必须先确认该目录不是 ASM**（`isAsmPath`）—— 见 `buildFindBackups` 的说明。
 * 这里**再拦一次**：将来若有人把 ASM 路径接到这里，会得到一个反向的假结论
 * （「文件系统上找不到」= 「备份丢了」），所以宁可不执行。
 */
export async function findBackupsViaSsh({ backupDir, patterns, ssh, run = runRemote }) {
  if (isAsmPath(backupDir)) {
    return {
      command: null,
      res: null,
      verdict: {
        state: 'not-applicable',
        files: [],
        paths: [],
        detail:
          '该路径是 ASM（以 `+` 开头），而 ASM 不是文件系统 —— `find`/`ls` **本来就看不到**那些文件，' +
          '所以这一步不适用，也**不能**据此说备份丢了。',
      },
    };
  }
  const command = buildFindBackups(backupDir, patterns);
  const res = await run({ command, ...ssh });
  // 同 `scanBackupLogViaSsh`：没连上时不能报成「目录里没找到」。
  const trouble = sshTroubleNote(res);
  return {
    command,
    res,
    verdict: trouble
      ? { state: 'unknown', files: [], paths: [], detail: trouble }
      : parseFindBackups(res.stdout),
  };
}
