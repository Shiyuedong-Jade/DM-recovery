# dsh-plugin-dm-recovery-readiness

达梦 DM8 数据库可恢复能力评估插件。按 16 个恢复场景逐项对照「要求 vs 本库实际」，回答能恢复到哪一点、要丢什么，生成 HTML 报告。

单实例与共享存储集群（DMDSC 两节点）都已完成真机验证；文档里的地址与账号均做过替换，非真实环境。

## 目录

- [功能](#功能)
- [环境要求](#环境要求)
- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [报告](#报告)
- [OS 访问（可选）](#os-访问可选三条只读命令)
- [注意事项](#注意事项)
- [卸载](#卸载)
- [目录结构](#目录结构)
- [开发](#开发)
- [许可证](#许可证)

## 功能

- 16 个恢复场景，分三组覆盖：逻辑损坏 5 项（单条记录误删误改、整表误 DROP / TRUNCATE、整表批量误 UPDATE、schema 被 DROP、表结构误改）、物理损坏 8 项（单数据页、单数据文件、控制文件、联机日志、归档日志、备份集、整机与存储、表空间）、集群容灾 3 项（DMDSC 单节点故障、全集群故障、站点级灾难）
- 每个场景给出五档能力判定：可恢复 / 仅能粗粒度恢复 / 不可恢复 / 无法判定 / 不适用，并附一张「要求 vs 本库实际」条件表，只对未满足的条件给建议
- 回答「能恢复到哪一点」：归档链**逐段核对**（逐段验 `next.ARCH_LSN === prev.CLSN + 1`，再看并集有无洞）、未归档尾部、可回溯窗口的时间起点、时间 ↔ LSN 双向夹逼
- 备份可用性核对：库里有哪些备份集、能恢复到哪一点、备份本身可不可信，并核对调用方自行提供的备份位置
- 支持 DMDSC 逐节点核对：节点间参数配置差异、坏页归属、归档目录自足性（实测交叉配置下两个归档目录各自都不自足）
- 可选的主机侧只读核验（SSH）：`dmrman CHECK BACKUPSET`、备份日志的全库逐页裁决、备份文件查找
- 输出单文件 HTML 报告，同目录另存一份内容相同的 `findings.json`
- 库内 SQL 均为查询语句，主机侧只执行 3 类只读命令。不扫描、不修复、不改配置

分级的依据是「哪个场景救不了」，不是「哪个参数没设」—— 参数齐全但救不了，仍然是严重问题。

## 环境要求

| 项 | 要求 |
|---|---|
| Node.js | ≥ 20 |
| Java | 8 及以上（JDK 或 JRE）。桥接器以源码方式运行，首次运行编译一次，结果缓存在工作目录 |
| 达梦 JDBC 驱动 | `DmJdbcDriver18.jar` 或 `DmJdbcDriver8.jar`，需自行提供，见[安装](#安装)第 2 步 |
| DeepSeek Harness | 0.1.x |
| plink | 仅主机侧核验需要，在 PATH 中即可，或用 `plinkPath` 指定 |

## 安装

### 1. 安装插件

```sh
dsh plugin --profile web add github:Shiyuedong-Jade/DM-recovery
```

从本地目录安装：

```sh
dsh plugin --profile web add file:/path/to/dsh-plugin-dm-recovery-readiness
```

`file:` 安装时绝对路径不能含空格：`dsh plugin` 会转发给 pnpm，参数在空格处断开。

### 2. 放置达梦 JDBC 驱动

驱动 jar 是达梦的商业组件，不随插件分发。把达梦安装目录下的
`dmdbms/drivers/jdbc/DmJdbcDriver18.jar` 复制到工作目录的 `drivers/` 下：

| 平台 | 路径 |
|---|---|
| Windows | `%USERPROFILE%\.dsh\dm-recovery-readiness\drivers\` |
| Linux | `~/.dsh/dm-recovery-readiness/drivers/` |

插件加载时会自动建好工作目录（`drivers/`、`java/`、`runtime/`）。工作目录可用插件配置 `home` 修改，见[配置](#配置)。

### 3. 重启

首次安装后重启 `dsh web`，并刷新已打开的页面。

## 使用

在会话里调用 `dm_recovery_readiness`。目标、账号、口令都能在设置卡片里预先填好，也可以每次调用时填。

工具有一个必填参数 `action`，共六个动作：

| action | 说明 |
|---|---|
| `report` | 汇总成一份 HTML 报告与一份 `findings.json` 落盘（本插件的主产出） |
| `readiness` | 处置能力体检：能否在线修、能恢复到什么程度、能否主动扫描 |
| `list` | 坏页清单：按时间判断是否需再次修复、反复损坏检测、跳页证据 |
| `triage` | 逐页分诊：把坏页定位到具体对象，给出处置路径 |
| `backup` | 备份可用性：账本里有什么、能恢复到哪一点、备份可不可信、调用方给的备份位置核对 |
| `capacity` | 归档空间参数检查 |

工具返回分级结论（严重 / 警告 / 提示 / 未取到）、稳定 ID 的结论项与报告路径。同一个结论跨次运行 ID 不变，可直接做对比。

### 调用参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `action` | string | 必填 | `list` / `readiness` / `triage` / `capacity` / `backup` / `report` |
| `host` | string | — | 数据库服务器 IP 或主机名，支持 `host:port` 简写（如 `10.0.0.61:7236`）。不给则用插件配置里的默认目标 |
| `port` | integer | `5236` | 数据库端口（DMDSC 常见 `7236` / `7237`）。写了它即压过 `host` 里带的端口 |
| `user` | string | `SYSDBA` | 数据库账号 |
| `password` | string | — | 数据库口令。会写入会话日志，建议改用设置卡片或 `credentialRef` |
| `targets` | string | — | DMDSC 各节点，`host:port` 以逗号、空格或换行分隔。实测 `V$DSC_EP_INFO` 没有地址列，插件无法自动发现对端节点，必须由调用方给；不给也能用，但会明确告知「本库是 N 节点、只检查了 1 个」 |
| `outDir` | string | `<插件工作目录>/dm-recovery-reports` | `report` 的报告目录，可用 `~` 开头 |
| `retentionHours` | integer | `24` | `capacity` 的回溯窗口假设（小时）。这是业务决策：出事后需要能恢复到多久之前 |
| `backupPath` | string | — | `backup`：调用方自行提供的备份位置（备份集路径或备份名，ASM 路径以 `+` 开头同样可以）。插件拿它去 `V$BACKUPSET` 核对，并给出唯一能真正校验备份集的 `dmrman` 命令 |
| `sampleSec` | integer | — | 已废弃、不再使用，保留仅为兼容旧调用 |
| `sshHost` | string | — | 主机侧核验的数据库主机。不给则不做任何 OS 级检查，插件保持纯 JDBC 只读 |
| `sshPort` | integer | `22` | SSH 端口 |
| `sshUser` | string | — | SSH 账号（通常 `dmdba` 或 `root`） |
| `sshPassword` | string | — | SSH 口令。会写入会话日志，建议改用凭据库 |
| `sshHostKey` | string | — | 主机密钥指纹（形如 `ssh-ed25519 255 SHA256:...`）。plink 在 `-batch` 模式下要求密钥已知，不给会在确认处中止 |
| `plinkPath` | string | `plink` | plink 可执行文件路径 |
| `dmrmanPath` | string | `dmrman` | 主机上 dmrman 的路径，默认走 PATH |
| `dmrmanDcrIni` | string | — | 主机上 `dmdcr.ini` 的路径（DMDSC 上必需）。备份集在 ASM 上时不加它，`CHECK BACKUPSET` 会报「无效的备份集目录」—— 那不是备份坏了，是 dmrman 够不到 ASM |
| `sshLogDir` | string | — | 主机上 DM 日志目录。给了它插件才会跑日志扫描，取回「全库逐页裁决」 |
| `sshScriptPath` | string | `<sshLogDir>/scan-backup-log.sh` | `scan-backup-log.sh` 在数据库主机上的路径。插件没有上传通道，需先手工拷过去 |
| `sshBackupDir` | string | — | 在主机文件系统上找备份文件的目录。只在备份路径不是 ASM 时才有意义（ASM 不是文件系统，`find` 本来就看不到） |

取值优先级：本次调用参数 > 插件配置。

## 配置

写在 profile 的 `cordis.patch.yml` 中该插件那一行上，也可以在设置界面里修改：

```yaml
- insert:
    - id: dm-recovery-readiness
      name: 'dsh-plugin-dm-recovery-readiness'
      config:
        host: '10.0.0.61'                  # 默认目标；多节点用调用参数 targets
        port: 7236
        user: 'SYSDBA'
        home: 'D:\dm-recovery-home'        # 工作目录，默认 ~/.dsh/dm-recovery-readiness
        credentialRef: 'DM_RECOVERY_PASSWORD'
        driverJar: ''                      # 直接指定驱动 jar 时填
        javaHome: ''                       # 需要 javac 编译桥时填
        timeoutSec: 120
        sshUser: 'dmdba'                   # 以下全部为空时不做任何主机侧命令
        plinkPath: 'plink'
        dmrmanPath: 'dmrman'
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `home` | `~/.dsh/dm-recovery-readiness` | 工作目录，其下有 `drivers/`、`java/`、`runtime/` |
| `host` / `port` / `user` | — / `5236` / `SYSDBA` | 默认目标与账号 |
| `password` | — | 数据库口令。会进入会话日志，不推荐写在配置里 |
| `credentialRef` | — | 数据库口令的凭据名；`password` 为空时才会去凭据库取 |
| `driverJar` | — | 直接指定 JDBC 驱动 jar 的路径 |
| `javaHome` | — | JDK 路径（需要 `javac` 编译桥时） |
| `timeoutSec` | `120` | 单次采集超时（秒） |
| `sshHost` / `sshPort` / `sshUser` / `sshPassword` / `sshHostKey` / `plinkPath` / `dmrmanPath` | — | 主机侧核验的默认值。全部为空时插件保持纯 JDBC 只读，不执行任何主机命令 |

### 口令的另外两种来源

本项目的约定是**每次运行在设置卡片里手输、用完即弃** —— 插件不保存、不写配置文件。要用凭据库则设置 `credentialRef`：

```sh
export DM_RECOVERY_PASSWORD='数据库口令'
```

或写入 `~/.dsh/.credentials.yaml` 的 `refs`，键名与 `credentialRef` 一致。

取值顺序：调用参数 `password` > 配置里的 `password` > `credentialRef` 指向的凭据库。

## 报告

`report` 动作落两份同名不同后缀的文件：

```
dm-recovery-<库名>-<时间戳>.html            ← 给人看：正文按恢复场景组织
dm-recovery-<库名>-<时间戳>.findings.json   ← 给机器用：信封去掉正文
```

报告按「恢复场景」组织，而不是按「插件能查到什么」分章：

1. 封面信息带：评估对象、数据库与实例、形态与版本、采集账号、生成时间、报告编号与总体等级色标
2. 目录：封面之后、第 1 节之前。点条目跳到对应章节，每节末尾可跳回目录；打印时隐藏
3. 评估概况：定义式面板，以及版本与实例信息（库与实例、服务版本、形态与节点、归档模式、归档链、未归档尾部、可回溯起点、备份账本、坏页记录、时间 ↔ LSN 精度、OS 级实测）
4. 结论摘要：KPI、分布条、「等级 / 条数 / 判定含义」表、分级明细、场景能力分布
5. 最要紧的几件事：按严重度排序，指向下方建议编号
6. 该改的 N 件事：建议按要改的东西去重，每件事只说一次，并列出它影响哪些场景
7. 逐场景条件对照：16 个场景 ×「要求 vs 本库实际」，建议只给指针
8. 场景能力汇总、场景判定的实测依据
9. OS 级实测：按本次实际跑到的条数连续编号
10. 附录 A~F：处置能力体检、坏页清单、归档空间、备份可用性、部署与节点核对、输出词表

版式与同族的《达梦数据库安全评估报告》一致：深蓝封面信息带、编号小节徽章、定义式信息面板、结论看板；计数为 0 的档位照常显示、只是变淡；带 A4 打印样式，导出 PDF 时表格与卡片不被切断。

DMDSC 多节点时报告里会多出节点核对的内容；报告默认输出到插件工作目录下的 `dm-recovery-reports`，不是 dsh 进程的启动目录。

README 与插件市场里展示的报告截图（`assets/screenshot-*.png`）由 `node tools/shots.mjs` 从一份**真实报告**生成：**先脱敏、再出图**；脱敏后若还残留真实 IP、账号或内部文档引用，工具会**拒绝出图**。截图清单见 `screenshots.json`。

## OS 访问（可选）：三条只读命令

不给 `sshHost` 时插件是纯 JDBC 只读的，一次主机命令都不执行。给了之后，它会在数据库主机上执行**三条固定形态的只读命令**，把库内查不到的东西取回来：

| 命令 | 取回什么 |
|---|---|
| `dmrman CTLSTMT="CHECK BACKUPSET '<备份集>'"` | 备份集**到底能不能读**。备份集在 ASM 上时需另给 `dmrmanDcrIni`，否则报「无效的备份集目录」—— 那不是备份坏了，是 dmrman 够不到 ASM；加上 `DCR_INI` 后同一条命令返回 `check backupset successfully` |
| `sh scan-backup-log.sh '<日志目录>'` | 备份日志里的**全库逐页裁决**（`N corrupted pages during backup`）与实例日志里的页校验失败、实例中止事件 —— 这是 `V$ERROR_PAGE` 永远给不了的东西 |
| `find` / `ls` | 文件系统上实际存在的备份文件。只在备份路径不是 ASM 时才有意义（ASM 不是文件系统，`find` 本来就看不到） |

边界写死在代码里，不靠自觉：

- 命令**只能由 `lib/ossh.js` 的三个构造函数产生**，没有任何接受任意命令字符串的入口。
- 路径参数走 `safeArg` **逐字符校验**，允许的字符集故意很窄；引号、分号、管道、重定向、`$`、反引号、空格、换行、括号一律抛错。所以「把用户输入拼进命令」这条路在类型上就不存在。
- 三条命令全是只读，**没有** `RESTORE` / `RECOVER` / 任何写命令，也不进 `dmrman` 交互模式（一律用 `CTLSTMT=` 一次性执行）。

`scan-backup-log.sh` 要**先手工拷到数据库主机**（插件没有上传通道），路径由 `sshScriptPath` 指定，默认 `<sshLogDir>/scan-backup-log.sh`。

## 注意事项

- 所有库内 SQL 都是查询语句，主机侧只执行 3 类只读命令（`dmrman CHECK BACKUPSET`、`sh scan-backup-log.sh`、`find` 找备份文件），不修改数据库与主机配置。
- **不主动扫描坏页，这是配置语义决定的**：达梦 `PAGE_CHECK_POLICY=1` 下读到坏页会让实例 HALT。想发现未被碰到的坏页就得去读那些页，读到坏页库就 HALT —— 所以「扫描去发现坏页」在 `PAGE_CHECK_POLICY=1` 的环境上不该存在，本插件在实现层面就不提供。
- **不执行修复**：`SF_PRIMARY_PAGE_REPAIR` 是拿备库的干净页覆盖主库坏页。备库不同步时，覆盖上去的可能是旧页 —— 把「一个坏页」换成「一个陈旧但校验通过」的页，更隐蔽。
- `V$ERROR_PAGE` 只记录**被访问到**的坏页，「未发现」不等于「没有坏页」。真机模拟实验（2026-10-13）实测：零化一页后读取，实例报 `page check error` 与 `SYSTEM SHUTDOWN ABORT`，而 `V$ERROR_PAGE` **始终 0 行**；全备照样成功、日志里写 `0 corrupted pages during backup`。真正抓到它的是 `dmdbchk`。
- 对象定位依赖 `DBA_EXTENTS`。同一次实验里它在该页上**返回 0 行**（该页 `DBA_EXTENTS` 只报 1 个区 / 5 块，`DBA_SEGMENTS` 是 197 区 / 3152 块），所以定位结果一律按「可能没定位到」看待。
- 备份历史来自 `V$BACKUPSET`，只反映当前控制文件记得的备份集。**账本为空不等于没有备份** —— 这一态判「无法判定」，不判「没有备份」。
- 「时间点 → LSN」的映射只能借归档文件的 `CREATE_TIME`，精度等于一个归档文件的跨度（低负载库一个文件能横跨几十小时），因此**不承诺精确到秒的 PITR**。夹逼区间跨过判定线时结论是「无法判定」，不猜一个。
- **没有 RTO 判定**：恢复耗时取决于磁盘吞吐、并行度、是否异机，库内查不出来。插件不会拿假设的吞吐量估一个「预计分钟数」。
- 主机侧核验需要先把 `assets/shell/scan-backup-log.sh` 手工拷到数据库主机上；插件没有上传通道。
- 非交互地向 plink 传口令时，口令会出现在 **plink 的进程参数**里 —— 这是已知弱点。要规避就改用密钥登录（`ssh -i`），那样插件配置里根本不需要 SSH 口令。
- 数据守护（主备）形态尚未在真机验证。
- 以下环境未验证：DM9、Windows 上的达梦、ARM 架构（鲲鹏 / 飞腾）。
- 报告包含主机名、账号、目录路径与实测发现，不要提交到公开仓库或公共渠道。
- 口令在调用卡片中填写，插件不保存、不落盘；宿主的会话日志会记录调用参数，这一点插件无法避免。
- 开发时注意：宿主加载的是 profile 目录下的副本，改完代码要同步源码、部署副本与 profile 副本三处，再重启 `dsh web`。
- Java 8 下首次运行会编译桥接器，产物在 `home/runtime/classes`；删除 `home/runtime/` 可清空，下次运行自动重建。

## 卸载

```sh
dsh plugin --profile web remove dsh-plugin-dm-recovery-readiness
```

再删除工作目录（其中包含驱动 jar）：

| 平台 | 命令 |
|---|---|
| Windows | `Remove-Item "$env:USERPROFILE\.dsh\dm-recovery-readiness" -Recurse -Force` |
| Linux | `rm -rf ~/.dsh/dm-recovery-readiness` |

## 目录结构

```
├── package.json              插件清单
├── cordis.patch.yml          作为 bundle 的插入清单
├── screenshots.json          报告截图清单（插件市场详情页用）
├── lib/
│   ├── index.js              插件入口：注册 dm_recovery_readiness 工具、解析参数与口令
│   ├── bridge.js             Node 与 Java 之间的只读桥
│   ├── queries.js            全部只读 SQL，跨版本差异都带降级链
│   ├── analyze.js            判定逻辑（纯函数，可离线单测）
│   ├── archive.js            归档空间参数检查
│   ├── backup.js             备份可用性：账本解析、覆盖度、归档链逐段核对、时间 ↔ LSN 夹逼
│   ├── dsc.js                DMDSC 多节点：目标解析、节点一致性、覆盖度、坏页归属
│   ├── scenarios.js          恢复场景引擎：16 个场景判定、条件表、建议
│   ├── vocab.js              唯一词表：分级、场景能力、条件满足
│   ├── format.js             四层输出骨架
│   ├── result.js             结果信封与稳定 ID
│   ├── report.js             HTML 报告渲染
│   └── ossh.js               可选的主机侧只读采集，命令只能由本模块的构造函数产生
├── assets/
│   ├── java/DmQuery.java     只读查询桥源码
│   ├── screenshot-*.png      报告截图，由 tools/shots.mjs 生成
│   └── shell/
│       ├── scan-backup-log.sh  日志扫描：备份证据与全库逐页裁决（插件会调用）
│       └── find-dm-logs.sh     日志发现（人工执行；插件当前不用它）
├── .github/workflows/
│   ├── ci.yml                离线自检（不连库、不装依赖）
│   └── peer-range.yml        每周核对 peer 范围是否落后于 registry（需联网）
└── tools/                    开发与自检脚本
```

## 开发

```sh
node tools/smoke.mjs                  # 离线自检：契约形状、安全边界、报告版式；不连库、不需要驱动（条数自己打印）
node tools/triage.mjs selftest        # 判定逻辑自检（含时间比对、反复损坏检测）
node tools/peer-range.mjs             # 核对 peer 范围是否还覆盖 registry 上已发布的版本（需联网）
node tools/check-backup.mjs           # 连真实库跑一次 backup 动作
node tools/run-action.mjs             # 任意 action 的真机运行器，支持 --out-dir、--dmrman-dcr-ini
node tools/live-check.mjs report      # 连真实库打印信封本体与正文
node tools/live-smoke.mjs             # 真机回归：六个 action × 信封不变量 × 交付物形状 × 口令不落盘
node tools/page-chain-check.mjs       # 坏页链路真机半验证，18 项断言（注入页 × 真机数据）
node tools/shots.mjs                  # 从 reports/ 下的报告生成 assets/screenshot-*.png（本机需 Edge / Chrome）
```

真机脚本的口令只从环境变量读，不进命令行：`DM_HOST`、`DM_USER`、`DM_PASSWORD`，DMDSC 另给 `DM_TARGETS`；主机侧核验另给 `SSH_HOST`、`SSH_USER`、`SSH_PASSWORD`、`SSH_HOST_KEY`、`DMRMAN_DCR_INI`、`SSH_LOG_DIR`。`live-smoke.mjs` 的退出码：0 通过、1 断言失败、2 环境不可用。

改 `peerDependencies` 时留意 `@deepseek-ai/*` 的预发布版本：node-semver 只在范围里存在**与该版本同元组、且自身带预发布标签**的比较符时才放行，写得太宽或太窄都会静默漏掉版本，用户装的时候才会看到 peer 告警。范围里是一条条枚举（覆盖 0.1.0~0.1.7 每个元组），**宿主发新元组就会静默失效** —— 所以改完跑一次 `node tools/peer-range.mjs`（它把 registry 上已发布的版本逐个比一遍）；`.github/workflows/peer-range.yml` 每周也会自动跑一次。

## 许可证

[MIT](LICENSE)
