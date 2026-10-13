# 达梦数据库可恢复能力评估

> 包名 `dsh-plugin-dm-recovery-readiness` ｜ 工具名 `dm_recovery_readiness`
> （**标识符未随之改名** —— 改了会断开既有安装与工具卡片；正式名称见 `DESIGN.md §2`）

达梦数据库**可恢复能力评估**。它回答三个问题，按价值排序：

| # | 问题 | 为什么值钱 |
|---|---|---|
| 1 | **这套库现在能恢复到哪一点？丢多少？** | 出事之前先算清楚，比出事之后再问有用得多 |
| 2 | **我这份备份，是在坏页出现之前做的吗？** | 坏页场景里唯一决定结局的硬指标 |
| 3 | **在你这套架构下，这个坏页能在线修吗？** | 答案对很多人是「不能」——这个「不能」本身就是结论 |

> **它不是修复工具，也不只是坏页工具。** 评估对象是**整个库的恢复能力**（16 个恢复场景：逻辑损坏、
> 物理损坏、集群/容灾），坏页只是其中一类触发场景。本插件**不扫描、不修复、不改配置**。

> 📄 **关于本文里的 `DESIGN §xx` 引用**：那是本项目的设计依据与真机实测记录（`DESIGN.md`，4400+ 行），
> **不随本仓库发布**。引用刻意保留 —— 它让每条结论都能回溯到当时那次实测（哪台机器、哪个版本、
> 量到了什么值），而不是为了让读者去点一个点不开的链接。

## 为什么不做主动扫描（这不是保守，是配置语义）

达梦 `PAGE_CHECK_POLICY`：`0：忽略失败；1：系统主动 HALT`。

> 想发现未被碰到的坏页，就得去读那些页；读到坏页，库就 HALT。

**这是个悖论，不是工程问题。** 社区里有真实案例：坏页后想删表空间 → 删用户触发 page check error **宕机** → drop table 又**宕机**。所以「扫描去发现坏页」这个功能在 `PAGE_CHECK_POLICY=1` 的环境上**不该存在**，本插件在实现层面就不提供。

同理，**修复也不该由工具执行**：`SF_PRIMARY_PAGE_REPAIR` 是「借备库的干净页覆盖主库坏页」，一旦备库不同步，覆盖上去的可能是旧页——把「一个坏页」换成「一个陈旧但校验通过」的页，更隐蔽。

## 六个 action

| action | 作用 |
|---|---|
| **`report`** | **汇总成一份 HTML 报告 + 一份 `findings.json` 落盘**（本插件的主产出）—— 回答"这套库能恢复到哪一点、哪些场景救不回来" |
| `readiness` | 处置能力体检：能否在线修、能恢复到什么程度、能否主动扫描 |
| `list` | 坏页清单（时间比对 + 反复损坏检测 + 跳页证据） |
| `triage` | 逐页定位到具体对象，给唯一推荐处置路径 |
| `backup` | 备份可用性：库里有哪些备份、能恢复到哪一点、备份本身可不可信 |
| `capacity` | 归档空间参数检查（**不给速率推导的推荐值** —— 理由见下） |

> 六个 action 共用同一张参数表，但**每个 action 只认其中一部分**。给了它不认的参数（例如给 `readiness` 传 `backupPath`），
> 它**不会静默丢掉**：正文「边界与免责」里会明说"本次没有据此做任何判定、能用的是哪些 action"，
> `meta.inputsDeclaredByUser[].used / usedBy` 里也机器可读地标出来。

## 返回结构：统一结果信封

六个 action 返回**同一个形状**（`lib/result.js`，`resultVersion: 1`）：

```
tool / resultVersion / action / generatedAt / generatedAtSource
level            总体等级（由结论项派生）        conclusion   一句话结论
summary          { byLevel, total, scenarios, pages, nodes, backups, archiveContinuous }
findings[]       { id, level, title, detail, evidence[], advice? }   ← 结论项，ID 稳定
result{}         action 专属的**完整事实**（不只是"需要关注的"）
meta{}           host/port/user/db/instance/version/form/nodes/startedAt/finishedAt/durationMs/osAccess
disclaimer / text / reportPath? / findingsPath?
```

**ID 是语义 slug，不是流水号** —— 同一个结论跨次运行 ID 不变，可直接做对比与趋势：

```
scenario.A1            16 个恢复场景          condition.A1.03      场景 A1 的第 3 个条件
readiness.online-repair 处置路径               page.4.0.50448       单个坏页（表空间/文件/页号）
backup.redundancy      备份检查项              archive.params       归档参数检查项
grade.crit             分级结论项              pages.none-found     本轮没有坏页记录
（`req.*` 需求结论项已随该功能整项移除）
```

三条硬约定：

1. **`findings` 放「要看的事」，`result` 放「完整记录」** —— 例如 readiness 的四条路径全在 `result.paths`，只有不可用/受限的进 `findings`。
2. **`summary` 里不适用的项显式为 `null`**（缺键会被消费者当成 0）。
3. **ID 一旦发布不改名**；某次没这条结论就**不出现**，而不是换个号。

> 旧字段 `verdict` / `distinctPages` / `needAttention` **保留一代**并原样透传（不重算 —— 重算会让新旧字段各说一套）。它们的语义随 action 变，已在 schema 里标【已废弃】。

### 留痕：这条结论是谁说的、验过没有

每条结论项带 `provenance` —— 「你说你有备份」和「我连上去看过那个备份能读」不是一个可信度：

| `source` | 含义 | executedByTool | declaredByUser | verified |
|---|---|---|---|---|
| `plugin-jdbc` | 库内只读查询（默认） | ✅ | ❌ | ✅ |
| `plugin-os-readonly` | 三条 OS 只读命令之一（并记下具体命令） | ✅ | ❌ | ✅ |
| `user-declared` | 调用方声明的输入（`backupPath` / `targets` / `retentionHours` / …） | ❌ | ✅ | ❌ |
| `derived` | 由实测值推导的汇总（分级、场景能力） | ❌ | ❌ | ❌ |

调用方声明、而工具没验过的输入还会单列在 `meta.inputsDeclaredByUser`（口令等敏感项不列）。

### `report` —— HTML 报告 + `findings.json`（本插件的主产出）

一次运行落**两份**同名不同后缀的文件：

```
dm-recovery-<库名>-<时间戳>.html            ← 给人看：正文按恢复场景组织
dm-recovery-<库名>-<时间戳>.findings.json   ← 给机器用：信封去掉 text（正文在 HTML 里）
```

报告**按「恢复场景」组织**，而不是按「插件能查到什么」分章：

```
封面信息带（评估对象 / 数据库·实例 / 形态·版本 / 采集账号 / 生成时间 / 报告编号 + 总体等级色标）
目录              ← 封面之后、第 1 节之前；**点条目跳转到对应章节**，每节末尾都有「↑ 返回目录」
1  评估概况        ← 定义式面板（评估对象、判定基准、检查面）
   版本与实例信息  ← 库·实例 / 服务版本 / 形态·节点 / 归档模式 / 归档链 / 未归档尾部 /
                    可回溯起点 / 备份账本 / 坏页记录 / 时间↔LSN 精度 / OS 级实测
2  结论摘要        ← KPI + 分布条 + 「等级 / 条数 / 判定含义」表 + 分级明细 + 场景能力分布
3  最要紧的几件事  ← 按严重度排序，指向下方建议编号
4  该改的 N 件事   ← 建议**按要改的东西去重**：每件事只说一次，并列它影响哪些场景
5  逐场景条件对照  ← 16 个场景 × 「要求 vs 本库实际」，建议只给指针
6  场景能力汇总
7  场景判定的实测依据
8,9,…             ← OS 级实测（按实际跑到的条数**连续编号**）
附录 A…F          ← 处置能力体检 / 坏页清单 / 归档空间 / 备份可用性 / 部署与节点核对 / 输出词表
```

> ★ **目录是可点的**（`DESIGN §44`）：它是一块独立的导航（`nav.tocbox#toc`），
> 列出全部小节与附录，点条目即跳到对应章节；每个章节末尾都有「↑ 返回目录」。
> 跳转落点留了 16px 上边距，标题不会顶在视口最上沿（否则看起来像"点了没反应"）。
> 打印时目录与回程链接会**整块隐藏** —— 纸面上没有页码的超链接只是占地方。
A~F                ← 附录：处置能力体检 / 坏页清单 / 归档空间 / 备份可用性 / 节点核对 / 输出词表
```

**版式与同族的《达梦数据库安全评估报告》保持一致**（同一套配色与组件）：
深蓝封面信息带 + 编号小节徽章（附录用字母）+ 定义式信息面板 + 结论看板（KPI/分布条/含义表）+
徽章与胶囊；语义记号（✅/❌/❔/—/🔴）渲染成同形胶囊；宽表可横向滚动、状态列居中；
带 **A4 打印样式**（导出 PDF 时表格与卡片不被切断、封面保留底色）。
**计数为 0 的档位照常显示**、只是变淡 —— 不显示会被读成"没查"。

#### 「恢复需求达成度」已整项移除（2026-10-13）

这一节原来讲的是：填上你的 RPO / 恢复时间点，报告就回答「**这套库够不够**」。
**现在没有了** —— 按用户决定**整项删除**（`DESIGN §29.10`），连带删掉的有：

| 删掉的东西 | 说明 |
| --- | --- |
| 参数 `rpoMinutes` / `targetTime` / `targetWindow` | 卡片上不再有这三个字段 |
| 报告第 3 节「恢复需求达成度」 | 报告只回答「这套库能做什么、恢复到哪一点」 |
| `req.*` 结论项与命名空间 | `findings.json` 里不再有 `req.rpo` / `req.target-time` 这类 ID |
| `summary.requirements` / `result.requirements` | 消费者不会拿到一个永远是 null 的键 |
| 场景条件表里的**先决条件行** | 「恢复到你要的时间点/段（先决条件）」不再挂到任何场景上 |
| `lib/requirements.js` | 整个模块文件删除 |

**没有变的**：报告仍然给出「**能恢复到哪一点**」的客观事实 —— 归档链逐段核对、
时间 ↔ LSN 夹逼、备份账本与覆盖度，全部照旧（它们不依赖调用方填什么需求值）。
变的只是：**不再替调用方回答"这个够不够"**。

场景能力有**五档**（第五档是"不适用"）：可恢复 / 仅能粗粒度恢复 / 不可恢复 / 无法判定 / **不适用**。
「不适用」= 本库不存在那个灾种（例如单实例上谈不上「DMDSC 单节点故障」）——**既不是问题，也不是"没查到"，因此不进分级**。

场景覆盖三组共 16 项：

- **逻辑损坏**：单条记录误删误改 / 整表误 DROP·TRUNCATE / 整表批量误 UPDATE / schema 被 DROP / 表结构误改
- **物理损坏**：单数据页 / 单数据文件 / 控制文件 / 联机日志 / 归档日志 / 备份集 / 整机·存储 / 表空间
- **集群容灾**：DMDSC 单节点故障 / 全集群故障 / 站点级灾难

**分级的依据是「哪个场景救不了」，不是「哪个参数没设」** —— 参数齐全但救不了，仍然是严重问题。

### 输出格式：六个 action 一套骨架

每个 action 的正文都按**同一四层**渲染（`lib/format.js`）：

```
达梦数据库可恢复能力评估 · <动作中文名>（<action>）

## 结论          ← 一句话 + 统一记号等级 + 补充信息
## 要点          ← 聚合性结论（不复述「依据」里的明细）
## 依据          ← ### 1. 小节 …（小节自动编号）
## 边界与免责    ← 所有注意事项集中在这里，不混进结论
```

**三套词表只有一份定义**（`lib/vocab.js`），报告「附录 F · 输出词表」直接渲染它：

| 维度 | 中文 | 记号 | 回答什么问题 |
|---|---|---|---|
| 分级 | 严重/警告/提示/未取到 | 🔴/🟠/🔵/⚪ | 这件事有多急 |
| 场景能力 | 可恢复/仅能粗粒度恢复/不可恢复/无法判定 | ✅/⚠️/❌/❔ | 这个恢复场景救得回来吗 |
| 条件满足 | 已满足/未满足/未取到/不适用 | ✅/❌/❔/— | 该场景要求的这一条，本库满足了吗 |

> 分级的 🔴/🟠/🔵/⚪ **单独一族**，不与其余两张表混用；能力 / 条件两张表共用
> ✅/❌/❔/— 这一族，靠**中文词**区分维度（同一个 `✅` 在条件表里读「已满足」，在能力表里读「可恢复」）。
> 不认识的取值一律原样输出，不硬塞进某个档位。
> （原来还有第四张「需求达成」表，已随该功能整项移除，见上。）

| 参数 | 说明 |
|---|---|
| `outDir` | 报告输出目录，默认 `<插件工作目录>/dm-recovery-reports`；可用 `~` 开头 |
| `targets` | DMDSC 多节点，逗号/空格/换行的 `host:port` 列表 |

报告里标注**需运维执行**的步骤（`dmrman CHECK BACKUPSET`、日志扫描）默认确实要人工做 ——
插件默认只经 JDBC 读库。**配了 `ssh*` 参数之后，这三步它会自己做**（只读命令，见
[「OS 访问（可选）」](#os-访问可选三条只读命令)）。

### `backup` —— 备份可用性（含调用方自带备份位置核对）

分五节回答：① 账本里有什么 ② 能恢复到哪一点 ③ **备份本身可不可信** ④ 已知坏页与备份的时间关系 ⑤ 你提供的备份位置核对。

第二节里有一项**逐段核对**（`assessArchiveChain`）值得单独说 —— 它把「归档够不够恢复」从**必要条件**升级成**强判据**：

```
两端对齐（弱）：最早 ARCH_LSN ≤ 备份起点、最晚 CLSN ≥ 当前 LSN   ← 中间断了它看不出来
逐段核对（强）：按「目录 + 归档目标名 + 节点」拆序列，
                逐段验 next.ARCH_LSN === prev.CLSN + 1，再看**并集**有没有洞
```

三个来自真机夹具的要点：

- **判据不是 `NEXT_SEQ` 递增**：真机单实例上它从 136616 跳到 136641（一个归档文件内含多个 redo 序列号），拿它判档会**误报**；真正的判据是 `next.ARCH_LSN === prev.CLSN + 1`（真机实测 `132032738 → 132032739`）。
- **多序列环境下「序列内有洞」属正常**：DMDSC 交叉配置下每个序列只含一部分 LSN 区间（真机两个 LOCAL 序列各有 2 处），判定必须看**并集**；单实例（单序列）上有洞才是**真断档**。
- **单目录自足性**：真机 DMDSC 上两个归档目录**各自都不自足**（DSC01 缺 3 段、DSC02 缺 2 段）—— 这是交叉配置的正常形态，但结论是可执行的：**少保留任何一个节点的归档目录，就会缺一段。**

还会给出**未归档尾部**（`CUR_LSN − 并集末端`，还在联机日志里、尚未进归档的那段）与**可回溯窗口的时间起点**（最早归档文件的 `CREATE_TIME`）。

同一节还有一张**时间 ↔ LSN 对照**（`assessTimeLsnAnchors`）：把「在某时刻观测到某 LSN 已存在」的锚点收起来做**双向夹逼**。锚点有四个来源，**最密的是 `V$RLOG_HISTORY`**：

| 锚点来源 | 取法 | 实测密度 |
|---|---|---|
| **`V$RLOG_HISTORY`** | `(RECORD_TIME, CUR_LSN)` | ✅ **约每分钟一行**（保留窗口实测 ≈ **1 小时**） |
| 归档文件 | `(CREATE_TIME, ARCH_LSN)` | 本库有个文件横跨 **41 小时** |
| 备份 | `(BACKUP_TIME, BEGIN/END_LSN)` | 每次备份 1~2 个锚点 |
| 当前前沿 | `(SYSDATE, V$RLOG.CUR_LSN)` | 每次运行 1 个 |

真机输出（单实例 `10.127.11.40`，2026-10-12）：

```
锚点 77 个（其中 75 个可用于「上界」）；最密一档间距 0.3 分钟 —— 时间↔LSN 已可当精确对应用

| 时刻区间                             | 对应 LSN 区间          | 宽度 |
| [10:23:09.332835 , 10:24:09.338835) | 132129650 → 132129688 |  38 |
| [10:24:09.338835 , 10:25:09.333835) | 132129688 → 132129688 |   0 |  ← 精确到一个点
| [10:25:09.333835 , 10:26:09.335835) | 132129688 → 132129699 |  11 |
```

三点必须说清：

- **两端不是同一性质**。`t(LSN) ≤ 观测时刻` 是逻辑结论（LSN 先被生成、后才可能被观测到），**不需要任何假设**；另一半要求「观测时刻 ≈ LSN 生成时刻」，而**这个前提因来源而异** —— RLOG 历史、归档文件、当前前沿几乎即时，**备份的 `BACKUP_TIME` 是完成时刻**（实测那次备份跑了 31 秒；把备份锚点用于上界会算出「宽度为负」的区间），所以备份锚点只做严格下界。插件会**自查**该前提（判据是**严格小于** —— `下界 === 上界` 是**最好**的情况：精确到一个点）。
- **精度由锚点密度决定**：`V$RLOG_HISTORY` 的窗口内是**分钟级**（本环境一分钟只推进 28 个 LSN）；**超出那约 1 小时的窗口**就只剩归档文件锚点，区间会宽到几万 LSN。想覆盖更早的时间点：调小 `ARCH_FILE_SIZE`，或让插件**定期跑**（每次采一帧并留存，补出自己的一段锚点历史）。
- **不做 LSN↔时间插值**。线性插值需要「redo 生成速率恒定」这个不可验证的前提，与「禁止安全系数」是同一条纪律 —— 只给区间，并把**宽度**写出来让业务判断够不够。

> 达梦**服务端**本来就有这张映射（支持 `RECOVER ... UNTIL TIME` / `UNTIL LSN`）。
> 真机实测过：**没有** `SF_*_LSN_BY_TIME` 这类现成函数（5 个候选名全部「无法解析的成员访问表达式」），
> 但 `V$RLOG_HISTORY` 比一个函数更好用 —— 它带**历史**。
> 完整探测结论见 `probe-lsn-time.sql`（已跑过，结论写在每节末尾）。

> 达梦**服务端**本来就有这张映射（支持 `RECOVER ... UNTIL TIME` / `UNTIL LSN`），
> 只是**有没有暴露给 SQL 未核实** —— 那是 `probe-lsn-time.sql` 要回答的。
> 若真有直接入口，上面这套夹逼就退化为**事前评估**用，精确换算交给服务端。

**最重要的一条结论：全备本身就是一次全库页校验。**

全量备份会读取每个数据文件的**每一页**，所以备份日志里那一行

```
0 corrupted pages during backup      ← 或 N corrupted pages during backup
```

是**对整个库所有数据页的完整性裁决**。这正是 `V$ERROR_PAGE` 永远给不了的东西 ——
后者只记录「被访问到」的坏页，库没被人读到的坏页它一条都不会有。

> **所以：定期做全备。它既产出备份，又免费充当一次全库页校验。**

**能力边界 —— 默认只经 JDBC 读库；配了 `ssh*` 参数后其中两项可自动做（只读）：**

| 层 | 默认 | 启用 OS 访问后 | 手段 |
|---|---|---|---|
| 有哪些备份、覆盖到什么 LSN | ✅ 自动 | ✅ 自动 | `V$BACKUPSET` + `V$RLOG` + `V$ARCH_FILE` |
| 备份文件是否可读、完好 | ❌ 需运维执行 | ✅ **自动**（ASM 上要加 `dmrmanDcrIni`） | `dmrman [DCR_INI=<dmdcr.ini>] CTLSTMT="CHECK BACKUPSET '<路径>'"` |
| 全库页完整性裁决 | ❌ 需运维执行 | ✅ **自动** | 随插件提供的 `scan-backup-log.sh`（扫 `N corrupted pages during backup`） |
| 磁盘上到底有哪些备份文件 | ❌ 需运维执行 | ✅ **自动**（**仅文件系统路径**） | `ls` + `find`；ASM 上 `find` 本来就看不见 |

插件**不会假装查到了**它查不到的东西：没配 OS 访问时，上述几步会以「请运维在数据库主机上执行」+ 确切命令的形式给出；
配了之后，输出里会**摊开实际执行的命令**与实测结论（无法判定时一律说「无法判定」，**不等于通过**）。

**`backupPath` 参数**：基于现有信息没发现备份时，用这个参数把位置告诉插件。
它会拿这个位置去 `V$BACKUPSET` 里核对，并区分几种情况 ——
其中一条特别有用：**若本库备份在 ASM（路径以 `+` 开头），而给的是文件系统路径，
插件会明确告诉你「在操作系统上 `find`/`ls` 本来就看不到这些文件，这是预期行为，不代表备份丢了」。**

> 账本核对**不能**替代可用性校验。命中只说明「库认为这个备份集存在」，
> 真正的可用性结论只能由 `dmrman CHECK BACKUPSET` 给出。

## OS 访问（可选）：三条只读命令

**默认不启用。** 不配 `ssh*` 参数时，插件只经 JDBC 读库，连一次写操作都不可能发生。
启用后它会在数据库主机上执行命令 —— 这是**信任边界的改变**，所以边界写死在 `lib/ossh.js` 里：

1. **命令只能由该模块的三个构造函数产生**，没有任何接受「任意命令字符串」的入口；
2. **参数逐字符校验**：只放行路径真正会用到的字符集，引号、分号、管道、重定向、`$`、反引号、空格、换行、括号一律**抛错**；
3. **三条命令全是只读**，且 `runRemote` 在执行前再按白名单形态校验一次（纵深防御）：

| # | 用途 | 命令 |
|---|---|---|
| ① | 备份集可不可读 | `dmrman [DCR_INI=<dmdcr.ini>] CTLSTMT="CHECK BACKUPSET '<备份集路径>'"` |
| ② | **全库逐页裁决** | `sh <scan-backup-log.sh 在主机上的路径> '<日志目录>'` |
| ③ | 磁盘上有哪些备份文件 | `ls -la <目录>; find <目录> -maxdepth 2 -type f \( -name '*.bak' … \)` |

**没有** `RESTORE` / `RECOVER` / `dmrman` 交互模式，也没有任何写命令。

> ★ **ASM 上必须给 `DCR_INI`**（真机实测，DMDSC）：备份集在 ASM 上时，
> `dmrman CTLSTMT="CHECK BACKUPSET '+DMDATA/…'"` 只会报
> `SBT[-127] 无效的备份集目录` + `MML[-10001] 设置第三方MM属性失败` ——
> **那不是备份坏了，是 dmrman 够不到 ASM**（换 root/dmdba 都一样，`USE_AP`/`AP_PORT` 也不是必需）。
> 加上 `DCR_INI=<dmdcr.ini>` 后同一条命令立刻变成 `check backupset successfully.`（实测 2.9~3.3 秒）。
> 路径从 `ps -ef | grep dmserver` 的 `dcr_ini=` 里看，DMDSC 上逐节点不同（`…/data/DSC01/dmdcr.ini`）。
> 不给的话结论会是「未取到」，**不会**被当成通过。

### 参数

| 参数 | 说明 |
|---|---|
| `sshHost` / `sshPort` / `sshUser` / `sshPassword` | 主机、端口（默认 22）、账号、口令。**任一为空即视为「没配 OS 访问」** |
| `sshHostKey` | 主机密钥指纹。**plink 在 `-batch` 模式下要求密钥已知**，不给会在确认处中止 —— 要么填这里，要么先手工接受一次 |
| `plinkPath` / `dmrmanPath` | `plink` 与 `dmrman` 的路径，默认走 PATH |
| `dmrmanDcrIni` | **`dmdcr.ini` 在主机上的路径**。备份在 ASM 上时给上（否则①只能给「未取到」） |
| `sshLogDir` | 数据库主机上的 DM 日志目录。**给了它才会跑②** |
| `sshScriptPath` | `scan-backup-log.sh` **在主机上**的路径；不给则默认 `<sshLogDir>/scan-backup-log.sh` |
| `sshBackupDir` | 在主机文件系统上找备份的目录；不给则自动取「调用方给的备份位置 / 账本里的备份路径 / `BAK_PATH`」所在目录 |

#### ★ 多节点（DMDSC / 数据守护）：每个节点各查一遍

`sshHost` 可以是**列表**（逗号 / 空格 / 换行分隔，支持 `host`、`host:port`、`[::1]:22`）：

```
sshHost        = 10.127.11.61,10.127.11.62
sshHostKey     = ssh-ed25519 255 SHA256:AAA…,ssh-ed25519 255 SHA256:BBB…
dmrmanDcrIni   = /home/dmdba/dmdbms/data/DSC01/dmdcr.ini,/home/dmdba/dmdbms/data/DSC02/dmdcr.ini
sshLogDir      = /home/dmdba/dmdbms/log          ← 各节点相同，给一个值即可（广播到所有节点）
```

对齐规则：**1 个值 → 全员共用**；**个数与节点数相等 → 按序一一对应**；**既不是 1 也不相等 →
全部用第一个值**，并在报告的「边界与免责」里明说「无法按序对齐」（不猜、也不静默降级）。

> ⚠️ 逐节点不同**这项只按逗号切**，不按空格切 —— 主机密钥本身就含空格
> （`ssh-ed25519 255 SHA256:…`），按空格切会被切碎。
> ⚠️ `sshHost` **不给端口时默认 22**（不是数据库端口的 5236）。
> ⚠️ 逐节点不同的 `dmrmanDcrIni` 在 DMDSC 上是**必须**的：`DSC01` 与 `DSC02` 是两份不同的文件。

结果里每个节点各有一条结论项：单节点时 ID 仍是 `backup.os-check`（契约不变），
多节点时变成 `backup.os-check.<节点>`，标题带 `（节点）`。
合并层会把裁决**归属**一起写出来，例如「裁决由 `…61` 给出；`…62` 的日志里没有这条记录」——
**「没有记录」不等于「没有坏页」，也不等于「查不出来」**。

> ⚠️ **脚本要人工拷到每一个节点**：插件没有上传通道。把 `assets/shell/scan-backup-log.sh`
> （纯 ASCII + LF，真机验证过）scp 到**每一个**数据库主机上，再用 `sshScriptPath` 告诉插件它在哪。
> 只拷一个节点的话，其余节点②会判「未取到」——报告会显示「N 个节点」，看起来像都查过了。
> 实测放在 `/home/dmdba/dmdbms/log/`（5662 字节、md5 `27740866b8c9748b59c6db7a531fda92`）；
> **不需要可执行位**（插件用 `sh <路径>` 调用，`-rw-r--r--` 照样跑通）。
> DMDSC 上实例日志与 ASM 日志同在 `/home/dmdba/dmdbms/log`（含 `dm_DSC01_202610.log`、`dm_BAKRES_202610.log`）。

> ⚠️ **口令会出现在 plink 的进程参数里**（非交互传口令在 Windows 上只能靠 plink）。
> 这是**已知弱点**；更稳的做法是换成密钥。与数据库口令一样，优先走凭据库（`credentialRef`），
> 不要写明文 —— 明文会进入会话日志。

**③ 只在路径不是 ASM 时才跑**（`+` 开头即 ASM）。ASM 不是文件系统，`find`/`ls` 本来就看不到那些文件，
拿它去回答「备份是不是丢了」会得到反向的假结论 —— 这正是 `backup` 动作要澄清的那件事。

### `capacity` —— 归档空间参数检查与推荐

**检查**三个参数是否设置（注意它们**不在同一个文件里**）：

| 参数 | 位置 |
|---|---|
| `ARCH_INI` / `ARCH_SPACE_CHECK_INTERVAL` / `ARCH_SPACE_FREE_THRESHOLD` | **dm.ini** |
| `ARCH_SPACE_LIMIT` | **dmarch.ini**（每个归档目标各自设，从 `V$DM_ARCH_INI` 观察） |

**推荐**分两类给出 —— **只有不依赖速率的那几条才是推荐值**：

```
ARCH_SPACE_FREE_THRESHOLD ← 按磁盘容量定
ARCH_SPACE_CHECK_INTERVAL ← 固定 300s
监控「最旧归档的 CREATE_TIME」← 不需要任何预测
ARCH_SPACE_LIMIT(每目标)  ← 只给**假设性换算**，并明说「不构成推荐」（见下）
```

> ⚠️ **`ARCH_SPACE_LIMIT` 不给推荐值（恒为 `null`）。** 速率是「上一段采样窗口的观测」，
> 把它当成未来速率是一个**不可验证的前提**；由它算出的上限只是「看起来算过了」。
> 这与本项目早已确立的「禁止安全系数」是同一条原则。所以输出里只有一段**假设性换算**，
> 且首段就写明「不构成推荐」。

> ⚠️ **`ARCH_SPACE_LIMIT` 的语义已确认**（官方《配置文件说明》5.3 + `ARCH_HANG_FLAG` 实测值）：
> `0`=写入失败后不挂起、直接报错（**归档静默缺失**，最危险）；`1`=挂起并反复重试（上限只是把
> 「磁盘满挂起」**提前**，不换来回溯能力）；`2`=先删最老的归档再重试（**上限直接等于回溯窗口**）。

**不再做速率采样。** 早先的实现靠「等一个新归档文件出现」测速率，而归档文件可能几十分钟才新建一个 ——
工具要么久等、要么永远测不出来；且该速率既**不外推**、也**不参与任何推荐**。所以整段采样已删除，
`sampleSec` 参数标为废弃（保留仅为兼容旧调用）。

> ⚠️ 另一条设计纪律：`V$ARCH_FILE.FREE` 我原本以为是「文件剩余可写空间」，实测被否掉（归档在推进、FREE 却在变大）。
> 同理实测 `V$ARCH_FILE.LEN` 是**分配大小**而非已写入量（`LEN=1073741824` 与 `ARCH_FILE_SIZE=1024MB` 完全吻合），
> 所以也无法靠读单个文件推速率。这些列**不参与任何计算**，LSN 增量只打印作对照。

> 还有一条**预警 ≠ 保护**：`ARCH_SPACE_CHECK_INTERVAL` / `ARCH_SPACE_FREE_THRESHOLD`
> 按官方文档只负责「剩余空间低于阈值时打印警告日志」，**并不控制上限是否生效**。
> 两者是**完全独立**的机制 —— 缺的是预警，不是保护。

### `readiness` —— 处置能力体检

按形态分支判定四条路径，每条都给**依据**：

```
【DMDSC，无数据守护】共享存储只有一份数据 → 借不到干净对端页 → 无在线修复路径
【单实例 / 主备】先判特殊页（0/6/7 号页、非 system 表空间 0 号文件的 1~5 号页）
                  → 再判备库类型（异步/订阅备库不支持）
【备份还原】      非归档模式 → 只能恢复到最近一次全备，其后数据全丢
【主动扫描】      PAGE_CHECK_POLICY=1 → 禁用
【跳过损坏页】    高风险：把「读报错」换成「静默返回不完整数据」。只警示，不推荐
```

### `list` —— 坏页清单

按 `(TS_ID, FILE_ID, PAGE_NO)` 聚合，用**时间**判断（达梦文档明确：修复后可能再次损坏，必须带时间比对，不能只做差集）：

- **从未修复**
- **⚠️ 修复后再次损坏** —— 反复损坏同一位置是**存储问题信号**，处置方向应是查盘 / RAID 卡 / HBA，而不是反复修数据
- 已修复

还会把 `V$SQL_SKIP_CPAGE` 的记录挂到对应页上——那是**证据级信息**：哪个会话、哪条语句、第几次执行、跳了哪些页。

### `triage` —— 逐页定位到对象

对「从未修复」与「修复后再次损坏」的页，反查到**具体是哪个段**：

```
页 (4, 0, 2817)
  表空间 MAIN（TS_ID=4）  文件 main.dbf
  所属对象 AWR1.T_ORDER（TABLE）
  区位置 BLOCK_ID=2816 BLOCKS=8
```

反查走 `DBA_EXTENTS` 的**区间匹配**（`BLOCK_ID <= PAGE_NO AND BLOCK_ID + BLOCKS > PAGE_NO`），是**字典查询**。

> ⚠️ 这里有一条硬约束：**绝不能用「对每张表扫 `PHYROWID` 去匹配」** —— 那等于全表扫描，会去读数据页，而 `PAGE_CHECK_POLICY=1` 时读到坏页即 HALT。那样工具自己就成了风险源。`tools/smoke.mjs` 会断言反查语句里只有 `DBA_EXTENTS`。

## DMDSC 多节点（`targets` 参数）

DMDSC 上坏页记录与参数配置都是**节点级**的，而插件默认只连一个节点。用 `targets` 把各节点列出：

```
targets = 10.127.11.61:7236, 10.127.11.62:7237
```

给了之后：

- **`readiness`** 逐节点核对参数配置，并报告**节点间差异**（归档参数、`PAGE_CHECK_POLICY` 等）。
  比对是**三态**的：`✅ 一致` / `❌ 不一致` / `❔ 两边都没取到，未比较` ——
  「都未取到」**不等于**「都一致」（真机上 `ARCH_HANG_FLAG` 两节点就都返回空）。实测本环境 17 项全部一致。
- **`list`** 逐节点查 `V$ERROR_PAGE`，给出**坏页的节点归属**。
- **`report` / `backup`** 的归档链核对按「目录 + 归档目标名 + 节点」拆成多个序列：
  集群上**每个 EP 只归档自己产生的 LSN 区间**，所以"序列内断档"是正常形态，判定看**并集**；
  实测本环境 4 个序列、并集无洞，但**两个目录各自都不自足**（恢复时要用各节点目录**一起**）。

> ⚠️ 集群上 `V$RLOG_HISTORY` 可能几乎没行（实例刚起来，该视图是观测历史）。
> 那时**最密的时间锚点会变成归档文件**，报告的「时间 ↔ LSN」一节会如实写明**本次**的最密来源、
> 最密窗口与窗口外的最大间距 —— 这三项都是**本次实测值**，不是写死的经验值。

**为什么地址必须由你给**：`V$DSC_EP_INFO` 只有 6 列
（`EP_NAME, EP_SEQNO, EP_GUID, EP_TIMESTAMP, EP_MODE, EP_STATUS`）、**没有地址列**。
所以**插件目前没有实现自动发现**，`targets` 必须由你显式给出。

> 注：`V$DM_ARCH_INI` 里另有 `ARCH_DEST_IP` / `ARCH_DEST_PORT`（REMOTE 归档目标的对端地址），
> 理论上可用来推导节点地址 —— 但**尚未在任何环境验证过**，所以插件**没有**基于它做自动发现。

不给 `targets` 也能用，但插件会明确输出「本库是 N 节点、只检查了 1 个 —— **覆盖不完整**」，
而不是留白。留白会被读成「没问题」。

**为什么 `GV$` 不够**：实测 `GV$ERROR_PAGE` 与 `V$ERROR_PAGE` 的列**完全相同（8 列）、没有节点列**。
它虽能一次查完两个节点，却**丢掉了「哪个节点先记录到」**。所以要看归属就得逐节点查。

### 归档空间推荐里的「节点系数」

`capacity` 在算「每个归档目标该设多大」时，乘的是**实测的 `V$DATABASE.DSC_NODES`**。

DMDSC 采用交叉配置（每节点 LOCAL + REMOTE 互相投递）。实测本环境：
`dsc01: LOCAL → +DMDATA/DSC01/arch`、`REMOTE → DSC02`，`dsc02` 对称 ——
**每个归档目录都会收到所有节点的归档**，所以按单节点速率算会少算 (N-1)/N。
单实例上 `DSC_NODES=1`（只有 LOCAL），系数为 1。

> 取不到 `DSC_NODES` 时插件**不给这个数值**，并且**刻意不默认成 2**：
> 上限猜小会让归档更早触顶，而实测达梦在**归档空间耗尽时会挂起数据库** —— 猜错的方向代价太大。

## ❗ 最重要的一条免责

`V$ERROR_PAGE` 只记录**被访问到**的损坏页。本工具输出「未发现坏页」时，**只代表「还没有人碰到过」**，不代表库中没有坏页。这句话写死在分析层，任何「未发现」的结论旁边都会出现。

## 安装

> 本机已按下面的步骤装好并端到端验证过（`DESIGN.md §27`）：插件在
> `D:\dsh-plugins\dsh-plugin-dm-recovery-readiness`，profile 的 `dsh.profile.bundles` 里已登记，
> 驱动在 `~/.dsh/dm-recovery-readiness/drivers/`。**连接信息每次在卡片里手输**（见第 4 步）。

### 1. 放到无空格路径

`dsh plugin` 会把参数转发给 pnpm，**路径里有空格会在空格处断开设**。
复制时**只带 `files` 清单**（lib/assets/tools/cordis.patch.yml/README/LICENSE），**不要带 `node_modules`**：

```powershell
$src = '<本目录>'; $dst = 'D:\dsh-plugins\dsh-plugin-dm-recovery-readiness'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
foreach ($i in @('lib','assets','tools','package.json','cordis.patch.yml','README.md','LICENSE')) { Copy-Item (Join-Path $src $i) $dst -Recurse -Force }
```

### 2. 准备 JDBC 驱动

达梦 JDBC 驱动是商业组件、不随插件分发。把 `DmJdbcDriver8.jar`（或 `DmJdbcDriver18.jar`）放到：

```
<home>/drivers/
```
`<home>` 默认 `~/.dsh/dm-recovery-readiness`（可用配置 `home` 改）。

### 3. 安装

**先复制、后安装** —— pnpm 的 `file:` 依赖指向一个必须已存在的目录，
顺序反了会报 `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`。

```sh
dsh plugin --profile web add file:D:/dsh-plugins/dsh-plugin-dm-recovery-readiness
```

装完 profile 的 `package.json` 会自动多两处：`dependencies` 里一条 `file:` 依赖，
以及 `dsh.profile.bundles` 里追加的包名（bundle 机制会自动带 `cordis.patch.yml` 那行 insert）。

> ⚠️ 不要在**源目录**里跑 `node tools/run-action.mjs` —— 那里没有 `node_modules`，会 `ERR_MODULE_NOT_FOUND`。
> 可运行的副本在 `~/.dsh/profiles/web/node_modules/<包名>/`（host 从那里加载）。

### 4. 口令来源：**每次运行在卡片里手输，不保存**

本项目约定 **不用凭据库**：每次运行在工具卡片里直接填连接信息，用完即弃，插件**不保存**。

插件对这条约定给出的保证（**已实测**，不是口头承诺）：

| 保证 | 实测依据（2026-10-12） |
|---|---|
| 口令**不落盘** | `<工作目录>/runtime/` 79 个文件（`req-*.sql` / `res-*.json`）扫过 —— **0 命中**；那里只有 SQL 文本与查询结果 JSON |
| 口令**不进交付物** | 报告 HTML 与 `findings.json` 扫过 —— **0 命中** |
| 口令**不读凭据库** | 未配置 `credentialRef` 时，只认卡片里传进来的 `password`；没有就返回 `level=unknown` + 一条 `form.credentials` 结论项，明说「未取得口令、未做任何判断」，**不假装成功** |

> ⚠️ **非交互传口令的固有限制**：口令会进入本次**会话日志**与子进程命令行（`java` / `plink` 的 argv）。
> 这一点无法在不引入凭据库的前提下消除 —— 所以它写在参数说明里，而不是藏起来。

#### 每次运行怎么填（最小组合）

| 想做什么 | 卡片里填 |
|---|---|
| 只做**能力评估**（单实例 / 单节点） | `action=report`、`host`、`user`、`password` |
| ↑ 同上，但想少填一个字段 | `host` 支持 **`host:port` 简写**：`host=10.127.11.61:7236`（同时给了 `port` 则以 `port` 为准） |
| ~~带恢复需求判定~~ | **已整项移除**（2026-10-13，`DESIGN §29.10`）：`rpoMinutes` / `targetTime` / `targetWindow` 与 RTO 那三个参数都不再存在 |
| DMDSC **全节点覆盖** | 再加 `targets=10.127.11.61:7236,10.127.11.62:7237` —— **必须手填**：实测 `V$DSC_EP_INFO` 没有地址列，`V$DM_ARCH_INI.ARCH_DEST_IP/PORT` 存在但**全为 NULL**，靠库内信息**无法**自动发现对端 |
| 带 **OS 级实测**（三条只读命令） | 再加 `sshHost`、`sshUser`、`sshPassword`、`sshHostKey`、`sshLogDir`、`sshScriptPath`、`dmrmanPath`、`dmrmanDcrIni` |
| DMDSC 上**每个节点都要 OS 实测** | `sshHost=IP1,IP2`；逐节点不同的项（`sshHostKey` / `dmrmanDcrIni` / `sshLogDir` / `sshScriptPath`）给**同序逗号列表**。⚠️ 扫描脚本也**每个节点**都要放一份 |

## CLI（不装插件也能用）

```sh
node tools/triage.mjs selftest                       # 离线自检，不连库
node tools/triage.mjs readiness --host <ip> --port <port> --user <u> --password <p> [--home <dir>] [--driver-jar <jar>]
node tools/triage.mjs list      --host <ip> --port <port> --user <u> --password <p>
node tools/check-backup.mjs --host <ip> --port <port> --user <u> --password <p> [--path <备份位置>]
```

## 安全设计

| 层 | 措施 |
|---|---|
| 连接 | `setReadOnly(true)` |
| SQL 白名单 | Java 桥只放行 `SELECT` / `WITH`，其余**拒绝并记录**（`REJECTED_NOT_SELECT`） |
| 实现层面 | 代码里**没有任何**写语句、没有 `SF_*_PAGE_REPAIR` 调用、没有改参数 |
| 沙箱子进程 | 一律 `stdio: 'ignore'`，不开管道（受限沙箱下管道捕获会 EPERM）；需要看 stderr 时重定向到**文件** |
| 自检 | `tools/smoke.mjs` 会断言上述边界确实存在 |

## 自检

```sh
node tools/smoke.mjs     # 离线：契约形状 + 安全边界 + 备份/归档链/时间↔LSN/报告版式（575 项，秒级）
node tools/triage.mjs selftest   # 判定逻辑（含时间比对、反复损坏检测）
```

真机直连（口令只从环境变量来，**不进文件、不进 shell 历史**）：

```sh
# PowerShell —— 单次看信封本体
$env:DM_HOST='10.127.11.40'; $env:DM_USER='awr1'; $env:DM_PASSWORD='…'
node tools/live-check.mjs report

# 真机回归：六个 action × 信封不变量 × 交付物形状 × 口令不落盘（约 90 秒）
$env:DM_HOST='10.127.11.61:7236'          # 支持 host:port 简写
$env:DM_TARGETS='10.127.11.61:7236,10.127.11.62:7237'
# （RPO_MINUTES / TARGET_WINDOW / RTO_MINUTES 三个变量已随「恢复需求达成度」整项移除，见上文）
# 可选：OS 三项，★多节点就是给列表
$env:SSH_HOST='10.127.11.61,10.127.11.62'; $env:SSH_USER='root'; $env:SSH_PASSWORD='…'
$env:SSH_HOST_KEY='<61 的键>,<62 的键>'
$env:DMRMAN_DCR_INI='/home/dmdba/dmdbms/data/DSC01/dmdcr.ini,/home/dmdba/dmdbms/data/DSC02/dmdcr.ini'
$env:SSH_LOG_DIR='/home/dmdba/dmdbms/log'
node tools/live-smoke.mjs                 # 退出码：0 通过 / 1 断言失败 / 2 环境不可用
```

> **退出码 2 有两层含义**：连不上库；**或者**插件工作目录不可写 / 找不到 JDBC 驱动。
> 后者是实测踩过的坑：本脚本常在有沙箱的环境里跑，而插件默认工作目录（`~/.dsh/dm-recovery-readiness`）
> 在**工作区之外**时写不了 `runtime/*.sql`，六个 action 会**全部**失败 —— 看起来像库挂了，其实是本地写权限。
> 所以脚本在没显式给 `dm_recovery_readiness_HOME` 时，
> **自己**把工作目录指到仓库内的 `.live-home/plugin-home` 并把驱动搬过去（显式给了就照给的跑）。
>
> 插件侧也从这一课改了措辞（`DESIGN §39`）：这类失败现在说的是
> 「本机读写插件工作目录失败 —— **尚未连到数据库**」，而**不是**「所有目标节点均无法连接」——
> 后者会把人指向网络，而库其实是好的。

> `live-smoke.mjs` 断言：信封字段齐全、**`level` 由结论项派生**、ID 落在白名单、
> DSC 节点覆盖数、OS 三项（**逐节点各一条** + 合并裁决的归属）、报告落盘与版式结构
> （封面 / 编号徽章 / 目录锚点 / 无控制序列 / 无残留 `**` / **无字面 `null`** / **不重复说了两遍**）、
> 以及**口令不落盘**。报告写进临时目录、跑完自动删；`SSH_HOST` 等变量给了才会跑 OS 那组。

**坏页链路的真机半验证**（需要库里有 `DBA_EXTENTS` 数据；只读）：

```sh
$env:DM_HOST='10.127.11.61:7236'; $env:DM_USER='awr1'; $env:DM_PASSWORD='…'
node tools/page-chain-check.mjs   # 18 项断言：区间匹配 / 对象定位 / 坏页 vs 备份的时间关系
```

> 它把**触发条件**（页记录）换成注入的，其余全用真机数据（页坐标取自 `DBA_EXTENTS`、
> 反查 SQL 真的在库上跑、备份账本是真的）。所以它验的是**链路**，
> **不能**验"真坏页会不会被 `V$ERROR_PAGE` 记下来"—— 那需要一台可丢弃实例（`DESIGN §43.4`）。
> 详见 `DESIGN §43`，含一条由此挖出的**文件号口径**风险（`§43.3`）。

## 目录

```
dsh-plugin-dm-recovery-readiness/
├─ lib/
│  ├─ index.js       插件入口（注册 dm_recovery_readiness 工具）
│  ├─ bridge.js      Node ↔ Java 桥
│  ├─ queries.js     全部 SQL（每处跨版本差异都带 fallback）
│  ├─ analyze.js     判定逻辑（纯函数，可离线单测）
│  ├─ archive.js     归档空间参数检查与推荐（节点系数来自实测 DSC_NODES；不给速率推导的推荐值）
│  ├─ backup.js      备份可用性（账本解析 / 覆盖度 / 路径核对 / 归档链逐段核对 / 时间↔LSN 夹逼）
│  │  （原 requirements.js 恢复需求达成度 —— **已整项移除**，2026-10-13）
│  ├─ dsc.js         DMDSC 多节点（目标解析 / 节点一致性 / 覆盖度 / 坏页归属）
│  ├─ scenarios.js   恢复场景引擎（16 场景判定 + 结构化条件 + 建议 + 渲染）
│  ├─ vocab.js       **唯一**词表（分级 / 场景能力 / 条件满足）
│  ├─ format.js      四层输出骨架
│  ├─ result.js      结果信封 + 稳定 ID + 留痕
│  ├─ report.js      HTML 报告（最小 Markdown→HTML + 分级规则）
│  └─ ossh.js        **可选的 OS 访问层**：三条只读命令（命令只能由本模块的构造函数产生）
├─ assets/
│  ├─ java/DmQuery.java          只读查询桥（SQL 文件进 / JSON 出）
│  └─ shell/scan-backup-log.sh   日志扫描：从 DM 日志提取备份证据与「全库逐页裁决」
├─ tools/
│  ├─ triage.mjs       CLI
│  ├─ run-action.mjs   任意 action 的真机运行器（支持 --out-dir / --dmrman-dcr-ini）
│  ├─ check-backup.mjs 真机跑 backup 动作
│  ├─ live-check.mjs   真机直连（口令走环境变量；打印信封本体 + 正文）
│  ├─ live-smoke.mjs   **真机回归**：六 action × 信封不变量 × 交付物形状 × 口令不落盘 × 多节点 OS
│  ├─ page-chain-check.mjs **坏页链路真机半验证**（注入页 × 真机数据；见 DESIGN §43）
│  └─ smoke.mjs        装配自检（离线，575 项；自己打印实际条数）
└─ cordis.patch.yml
```

## 已知限制

- **列名跨版本差异真实存在**。实测同一个视图在不同环境上列名不同（如 `V$DM_ARCH_INI` 的 `TYPE` vs `ARCH_TYPE`），`V$DATAFILE.TABLESPACE_NAME` 在某些版本不存在。所有查询都带 fallback 并会记录用了哪条。
- **对象定位依赖 `DBA_EXTENTS`**。它给出 `FILE_ID / BLOCK_ID / BLOCKS`，可做 `(表空间, 文件, 页号) → 段` 的反查。若某版本没有该字典，定位会降级；而 2026-10-13 的真坏页实验里它**有字典也没定位到**（见下条与 `DESIGN §46`）。
- **备份历史来自 `V$BACKUPSET`**（实测可靠：执行 `backup database;` 后立刻出现 1 行）。它只反映**当前控制文件记得**的备份集 —— 账本为空**不等于**没有备份。
- **归档链已做「逐段核对」**（`assessArchiveChain`）：按「目录 + 归档目标名 + 节点」拆序列，逐段验 `next.ARCH_LSN === prev.CLSN + 1`，再看**并集**有无洞。
  ⚠️ 两个仍然存在的边界：①「时间点 → LSN」的映射只能借归档文件的 `CREATE_TIME`，**精度 = 一个归档文件的跨度**（低负载库一个文件能横跨几十小时），所以**不承诺精确到秒的 PITR**；② 达梦是否有 `time↔LSN` 换算入口**未核实**（见 DESIGN §22.5 的探测项）。
- **真实坏页已实测**（2026-10-13，单实例 `10.127.11.40`，见 `DESIGN §46`）：零化 `MAIN.DBF` 第 73000 页（表 `AWR1.EXP_BADPAGE`）并读取后，实例报
  `[EID:48] Server page check error! page:(4, 0, 73000)`、`[EID:316] SYSTEM SHUTDOWN ABORT`、`dm_sys_halt` —— 而 `V$ERROR_PAGE` **始终 0 行**：
  「库崩了」与「坏页清单里有记录」是两件事。同一次实验还实测：全备**照样成功**且日志写 `0 corrupted pages during backup`；
  `dmdbchk` 能定位（`page(4, 0, 73000) is broken`、`table_name=EXP_BADPAGE`）；本插件的 `DBA_EXTENTS` 反查**没查到对象**；
  恢复序列 `RESTORE 10.2 s → RECOVER 3.3 s → EID:299 → RECOVER … UPDATE DB_MAGIC 1.28 s → 启动正常`，事后 `dmdbchk` 0 损坏 / 0 失效。
- **OS 访问默认关闭**，且**脚本需人工拷到数据库主机**（插件没有上传通道）。
  **2026-10-12 已在 DMDSC 上真机跑通三项**：`CHECK BACKUPSET` 加 `DCR_INI` 后 = `check backupset successfully`（3.2 秒）、
  全库逐页裁决 = `0 corrupted pages`（最近两次全备）、文件系统查找在 ASM 上按设计跳过。详见 DESIGN §31。
- **DMDSC 集群侧已真机复验**（2026-10-12，两节点 `10.127.11.61:7236` + `.62:7237`）：四个归档序列、并集无洞、单目录各自不自足（要用各节点目录**一起**恢复）、`C1 单节点故障`从`不适用`变成`可恢复`、17 项节点级参数逐项比对一致。细节见 DESIGN §30。
- **没有 RTO 判定**：恢复耗时取决于磁盘吞吐、并行度、是否异机，库内查不出来；本插件**不会**拿假设吞吐估算一个"预计分钟数"，也不再输出一条"无法判定 RTO"（那需要一次演练，而演练不在本插件的范围内）。
- **RPO 与"恢复到哪一刻"的判定精度 = 时间↔LSN 的夹逼宽度**。⚠️ 精度**每次运行都重新实测**，报告里写的是本次值：最密的来源可能是 `V$RLOG_HISTORY`（观测历史，单实例见过约每分钟一行），也可能是**归档文件**（DMDSC 节点上该视图只有 1 行，实测两个归档文件相隔 2 秒）；而且「窗口内很密」不等于「时间↔LSN 精确」—— 窗口之外的最大间距可能几十小时。夹逼区间跨过判定线时，结论是「**无法判定**」而不是猜一个。

## 许可

MIT
