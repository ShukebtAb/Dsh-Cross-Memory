# 变更日志

本文件记录 `dsh-cross-memory` 的版本变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-10-01

### 新增

- **结构化写入工具 `cross_memory_write_entry`** —— 把「手工编辑记忆条目」这件容易踩坑的事固化成一次工具调用：
  - 自动分配锚点行（`<!-- memory:mem_<32hex> -->`），不再依赖人手写对
  - 校验索引行 ≤200 字符，超长即拒并附实际长度（实测回执形如 `index-line-too-long:213>200`）
  - 索引行 200 字符的硬边界来自 auto-memory 的注入面实现：规则层每条只渲染首行前 200 字符
  - `body` 非空时把正文外移到 `handoff/archive-*.md`，并要求短路径指针落在索引行内
  - 落盘前强制生成 `.pre-write-<stamp>` 基线，写失败可逐字节回滚
  - `apply: false` 只预演（返回改前／改后结构指标），`apply: true` 才落盘
  - **一律不生成尾随空锚点** —— 那会被 auto-memory 的 `parseAnchors` 判 `orphan-anchor`，致该文件此后整篇 fail-closed 拒写
- `README.md` 新增「结构化写入」章节：六参数表、三条硬契约、预演→落盘流程
- `package.json` 的 `description` 覆盖两条能力（此前只描述跨实例注入）

### 说明

- **不改变既有行为**：`index.js` 的注入通道、`order`、缓存、失败姿态与 `cross_memory_status` 输出全部未变，本轮只新增一个工具。
- 开发／验证工具 `tools\shadow-verify.mjs` 仍不入包（`files` 白名单未变）。

## [0.1.0] - 2026-09-28

### 新增

- 首个版本：把跨实例硬约束从固定路径 `~/.dsh/memory/cross/RULES.md` 注入每一轮上下文。
- 生效区间 `<!-- cross:begin -->` / `<!-- cross:end -->`，以 `- ` 开头即一条，**全文注入不截断**。
- `inject` 开关由各实例 profile 的 `cordis.patch.yml` 显式声明 —— 插件不猜自己是不是主实例。
- 工具 `cross_memory_status`：输出规则文件路径、SHA256、字节数、mtime、解析出的条目数与本实例注入状态。
- 注入通道为 `systemPrompt.context()`（`order: 10001`，排在 auto-memory 的 `SECTION_ORDER = 10000` 之后），不击穿 DeepSeek 前缀缓存。

[0.2.0]: https://github.com/ShukebtAb/Dsh-Cross-Memory/releases/tag/v0.2.0
[0.1.0]: https://github.com/ShukebtAb/Dsh-Cross-Memory/commit/9c71de0
