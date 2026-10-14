# 变更记录

版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## 0.2.0 — 2026-10-14

### 修复

- **账本为空时的返回值不是无损 JSON**：`assessBackupCoverage` 对空账本提前返回 `{ newest, state }`，漏掉 `redoGap` / `covered` / `span` 三个键，`coverage` 于是带着 `undefined` 进 tool 返回值。`undefined` 不是无损 JSON（`JSON.stringify` 会把对象里的 undefined 键直接丢掉），宿主据此**整条拒收** `backup` / `report` 的结果。真机表现是报 `value is not lossless JSON`，而 HTML 其实已经落盘，看起来像插件坏了。现在两个分支返回同一组键。
- **账本为空时跳过 `dmrman CHECK BACKUPSET`**：`runBackupsetCheck` 原先在 `backups` 为空时直接返回 `null`，而账本为空恰恰是最需要校验的场景（磁盘上躺着备份集、库却不认它）。真机那份报告把 10 个场景标成「需先 CHECK BACKUPSET 确认」，却从没执行过。新增 `resolveCheckTarget()` 三档兜底：账本、磁盘上 `find` 找到的备份集、调用方 `backupPath`，三者都没有才跳过。为此校验改到磁盘查找之后执行，日志扫描仍与 find 并发。
- **归档参数解读张冠李戴**：解读段的主语写的是 `ARCH_SPACE_LIMIT`，讲的却是 `ARCH_HANG_FLAG` 的 0/1/2 取值，还写着「值为 0 时归档会静默缺失」。而 `ARCH_SPACE_LIMIT` 单位是 MB，取 0 在达梦里表示**不限制**（同一份输出里生成推荐值时就是这么处理的，属自相矛盾）。真机两个归档目标的上限恰好都是 0，照旧文案读会得出假结论。现在主语改为 `ARCH_HANG_FLAG`，并显式写清 0 的含义。
- **REMOTE 归档目标没被解读**：旧实现只取 LOCAL，但 dmarch.ini 里 REMOTE 同样有这个参数，而集群上 REMOTE 投递正是「归档日志损坏」场景所依赖的**冗余**。真机 `ARCH_REMOTE1` 取 0，含义是对端不可达时**静默放弃投递**，配置里那两个目标看着仍成立、冗余却已经不在了。现在 LOCAL 与 REMOTE 一并解读，并为 REMOTE 取 0 单独给出警示。
- **集群上「本节点没有全备页计数行」被判成警告**：`N corrupted pages during backup` 是**备份事件的属性**，全备只写在发起节点的 `dm_BAKRES_*.log` 里。真机 dsc01 判 clean(0)、dsc02 根本没有这条记录，旧实现把 dsc02 判成警告，读起来像那台有问题。现在别的节点已给出裁决时降为提示并说明原因。

### 变更

- 信封出口加 `toLossless()`：返回值一律规整成无损 JSON（undefined / 函数 / symbol 归 null，NaN / Infinity 归 null，Date 归 ISO，真循环引用归 null）。这是**契约保证**，字段该不该缺仍在数据源修。
- 配了 OS 访问却没有可校验目标时，不再静默省略「备份可用性」整节，改为如实出一条 `unknown`，说清三个来源为何都取不到。**没配 SSH** 时仍然静默跳过。
- 新增 `ossh.deriveBackupSets()`：从 `find` 结果按**父目录**反推备份集目录。刻意不用「目录名是文件名前缀」这种更聪明的判据，两处真机的备份集内部命名并不一致（DMDSC 上是 `system.dbf.bak`，单实例上是 `DB_DAMENG_FULL_*.bak`），前缀判据会把前者直接漏掉。
- 报告与 `result.os` 写明「校验对象」及其来源。人工命名的备份集名字里没有时间戳，返回顺序只保证确定、不保证按时间，这一点也写进了说明。
- `sshUser` / `sshPassword` 支持逐节点（逗号分隔、与 targets 同序，只给一个值时全员共用；口令**不按空格拆分**，口令里可以有空格）。

### 文档

- README 的「开发时注意」由原来那句「同步源码、部署副本与 profile 副本三处」改成可执行的流程（推送、`dsh plugin --profile web update`、重启），并指向 DESIGN §48。
- DESIGN 新增 §48，记宿主加载与重载边界，以及本轮真机结论。

## 0.1.0 — 初始提交

首个版本：16 个恢复场景、五档能力判定、归档链逐段核对、未归档尾部、可回溯起点、时间 ↔ LSN 夹逼、备份可用性核对与 OS 级三项实测，生成 HTML 报告与 findings.json。只读设计：不扫描、不修复、不改配置。
