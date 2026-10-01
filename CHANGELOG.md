# 变更日志

本文件记录 `dsh-cross-memory` 的版本变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-10-01

### 公开能力收敛（本版的主题）

本插件是 auto-memory 的**增量插件**，因此只公开**本体没有的**能力。本版据此重新划定了公开边界：

| 公开能力 | 为什么它是互补的 |
|---|---|
| **跨实例硬约束注入** | auto-memory 的用户级记忆**按实例隔离**（`userMemoryDir` 指向各自 `DSH_HOME`）⇒「所有实例都必须遵守的约束」在它那里没有统一来源 |
| **锚点结构修复 `cross_memory_fix_bare_entries`** | auto-memory **没有**任何锚点结构修复通路；且其中的**空锚点 orphan** 与**重复锚点**两类病灶与任何配置开关无关（手工编辑、跨会话并发写入、历史遗留都会产生） |
| `cross_memory_status` | 报告 `cross/RULES.md` 的状态（路径/SHA256/字节/条目数/本实例注入状态）；`memory_status` 报的是记忆库自身，**不含该文件** |

### 新增

- 将 **`cross_memory_fix_bare_entries`** 确立为公开能力，并在 README 中独立成章（三类病灶对照表、为什么 B/C 两类长期有用、参数、两条硬保证、用法与幂等性）：
  - **A 无锚点裸条** ⇒ 在 `## ` 行**之前**插锚点行
  - **B 空锚点 orphan**（致该文件**整篇 fail-closed 拒写**）⇒ 在锚点行**之后**补一行中性占位
  - **C 重复锚点** ⇒ **只报不改**（删哪个 id 属语义判断）
  - **只插入新行、绝不改动既有行**；`apply=true` 时先留 `.pre-write-*` 基线、写后自检、不干净即整份回滚

### 调整

- **README 收敛**：只描述与本体互补的能力。此前版本中围绕「结构化写入」的整章（参数表、三条硬契约、预演→落盘流程、与本体原生写入的分工）**已整体移除**——该工具建立在一条**未采用**的实现路径之上（其立身理由只在 `memoryAnchorEnabled=false` 时成立，而该键为 `true` 时本体原生写入自带锚点），不构成公开能力。
- `package.json` 的 `description` 同步收敛为两项公开能力。

### 说明

- **代码零改动**：`index.js` / `entry-format.js` 逐字节未变。本版是**文档与定位的收敛**，不改变任何运行时行为。
- **版本号不做连续性声明**：`0.2.0` 与 `0.3.0` 两个版本围绕上述那条未采用的路径，其 GitHub Release 与 tag **已下架**，本文件不再收录其条目。需要回溯代码时请用 commit（`64d78be` / `89c34b2`）——git 历史完整保留。
- `files` 白名单未变（`index.js` + `entry-format.js` + `cordis.patch.yml` + `README.md` + `LICENSE`）；开发／验证工具 `tools\` 仍不入包。

## [0.1.0] - 2026-09-28

### 新增

- 首个版本：把跨实例硬约束从固定路径 `~/.dsh/memory/cross/RULES.md` 注入每一轮上下文。
- 生效区间 `<!-- cross:begin -->` / `<!-- cross:end -->`，以 `- ` 开头即一条，**全文注入不截断**。
- `inject` 开关由各实例 profile 的 `cordis.patch.yml` 显式声明 —— 插件不猜自己是不是主实例。
- 工具 `cross_memory_status`：输出规则文件路径、SHA256、字节数、mtime、解析出的条目数与本实例注入状态。
- 注入通道为 `systemPrompt.context()`（`order: 10001`，排在 auto-memory 的 `SECTION_ORDER = 10000` 之后），不击穿 DeepSeek 前缀缓存。

[0.4.0]: https://github.com/ShukebtAb/Dsh-Cross-Memory/releases/tag/v0.4.0
[0.1.0]: https://github.com/ShukebtAb/Dsh-Cross-Memory/commit/9c71de0
