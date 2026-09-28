# dsh-cross-memory

> **这是 [`@a9i5k4/dsh-auto-memory`](https://github.com/Aik358/dsh-auto-memory) 的增量插件（add-on）**，不是替代品。
> 它不改动 auto-memory 的任何代码或数据，只是在旁边追加一条「跨实例规则」注入通道。

把**跨实例硬约束**注入每一轮上下文：一份规则文件（`cross/RULES.md`），全部实例共同遵守。

## 它解决什么

多个 DSH 实例各自有独立记忆时，「哪些约束是**所有实例都必须遵守**的」没有统一来源。本插件从固定路径读取一份共享规则文件，把其中的条目注入每轮上下文——**改一处，全部实例生效**。

**这个缺口是 auto-memory 自身的隔离设计带来的**：auto-memory 的用户级记忆按实例隔离（`userMemoryDir` 指向各自 `DSH_HOME`），所以子实例看不到主实例积累的规则。本插件用**固定绝对路径**（不受 `wsKey` 与 `userMemoryDir` 影响）绕开这一点。

## 不用它行不行

行，但有代价。把同样的条目写进各实例自己的用户级 `MEMORY.md` 时（以下数字按本机当前的 22 条实测）：

| 承载方式 | 每轮成本 | 错解否定 |
|---|---|---|
| **本插件全文注入** | **3786 字符** | ✅ 完整保留 |
| 各实例写进 `MEMORY.md` | 4444 字符（22 条 × 202） | ❌ 被 200 字符渲染截断砍掉 |
| `SKILL.md` 按需加载 | 0 | ✅ 完整，但**不带「必读」属性** |

> 规则段每条只渲染「首条实质行前 200 字符 + `…`」（auto-memory 的 `rules-layer.js`），所以**长条目写进 `MEMORY.md` 注定被砍**。要完整保留错解否定，只能走插件注入。比值约 **0.85×**。

## 规则文件格式

路径固定为 `~/.dsh/memory/cross/RULES.md`（**故意硬编码为共享位置**）：

```markdown
# …头部说明（不注入）…

<!-- cross:begin -->
- 【必须遵守】第一条……
- 【禁止】第二条……
<!-- cross:end -->
```

| 约定 | 规则 |
|---|---|
| 生效区间 | **仅 `cross:begin` 与 `cross:end` 之间**；头部说明不注入 |
| 行格式 | 以 `- ` 开头即一条；**不设标记词白名单**（白名单只会成为静默丢弃的来源） |
| 单条长度 | **≤260 字符**（含 `- ` 前缀）**全文注入、不截断**。本机仅第 9 条为 265 字符——因须保留完整报错串作错解否定，是规则文件头部明确记载的唯一例外 |
| 编码 | UTF-8 无 BOM、LF |

## 安装

```powershell
# 从 GitHub（推荐，锁定 commit 可复现）
dsh plugin --profile web add github:ShukebtAb/Dsh-Cross-Memory#<commit>

# 本地开发期
dsh plugin --profile web add file:D:\Study\Product\dsh-cross-memory
```

> 安装后须确认两处：`dependencies` 里出现该包、**`dsh.profile.bundles` 里也列出它**。少了后一步不会生效。

## ⚠ `inject` 开关：每个实例必须显式声明

**插件不会猜自己是不是主实例**。内容指纹去重已实测不可行——`RULES.md` 是**重写版**而非摘抄版（措辞、语序、markdown 标记都动过），条目里最多只有少数能与用户级 `MEMORY.md` 的前 60 字符对上（实测：原方案 0/21，剥前缀后最好 5/21）；按路径判断又会随迁移失效。

所以在该实例 profile 的 `cordis.patch.yml` 里显式声明：

```yaml
- id: cross-memory
  name: 'dsh-cross-memory'
  config:
    inject: true          # 子实例：注入全部跨实例规则
```

| 实例角色 | 配置 | 效果 |
|---|---|---|
| **主实例**（规则段本就是真源） | `inject: false`（缺省） | 不注入；仅获得 `cross_memory_status` 工具 |
| **特化子实例** | `inject: true` | 注入全部条目 |

**为什么主实例也建议装**：为了 `cross_memory_status` 工具——见下节。

## 工具：`cross_memory_status`

输出 JSON（示例为某次实跑结果）：

```json
{
  "rulesPath": "C:\\Users\\Administrator\\.dsh\\memory\\cross\\RULES.md",
  "ok": true,
  "sha256": "5fe49f620d644261dc699f3512f0cb37c49d89d2641e4dea2980e2b9f24529d2",
  "bytes": 8967,
  "mtimeMs": 1758…,
  "itemsParsed": 22,
  "injectEnabled": false,
  "itemsInjected": 0
}
```

**用途**：`RULES.md` 目前**没有任何写保护**（`IsReadOnly = False`，DSH 本体的 `write`/`edit`/`pwsh` 都能直接覆写，唯一护栏是「不在工作区内」的路径隔离）。主实例可定期比对该 `sha256`，发现被误写即告警——这是「位置隔离 + SHA256 校验」加固方案中**校验那一半**的落地手段。

## 行为细节

- **注入通道**：`systemPrompt.context()`（user-role，追加在历史尾部）——**不击穿 DeepSeek 前缀缓存**；`section()` 只用于字节级稳定的静态内容，本插件不用。
- **与 auto-memory 的注入顺序**：本插件 `order: 10001`，auto-memory 用 `SECTION_ORDER = 10000` ⇒ 本插件的段落排在其后。
- **缓存**：按 `mtimeMs` 缓存，文件未变不重复读盘。
- **失败姿态**：文件缺失、读失败、锚点缺失一律**静默返回空串**（不注入、不报错、不影响会话）。
- **不截断**：注入正文原样输出，`RULES.md` 的错解否定是刻意保留的设计。
- **锚点匹配用完整注释串**：以 `indexOf('<!-- cross:begin -->')` 定位，而非裸的 `cross:begin`——因为头部说明的正文里会**字面出现** `cross:begin` / `cross:end` 这两个词，裸串匹配会误报。

## 致谢 / 相关项目

本插件是 **[`@a9i5k4/dsh-auto-memory`](https://github.com/Aik358/dsh-auto-memory)** 的增量插件。

| 项 | 值 |
|---|---|
| 名称 | `@a9i5k4/dsh-auto-memory` |
| 仓库 | **https://github.com/Aik358/dsh-auto-memory** |
| 参考版本 | 3.1.7 |
| 许可 | BSD-3-Clause |
| 简介（原文） | Proactive associative memory for DSH: zero-prompt recall injected before the model speaks, three-layer auto-consolidation, skill crystallization, and Astra-style context management - handoff ledgers, PLAN whiteboard, water-level sensing. Local-first, model-agnostic, zero deps. 主动联想记忆+Astra 式上下文管理:自动唤回/自动沉淀/技能固化/交接账本与白板跨窗口续命/水位感知。 |

**两者关系说明**：

- **它做什么**：DSH 的记忆系统本体——主动联想记忆、三层自动沉淀、技能固化、交接账本与 PLAN 白板、水位感知。
- **本插件补什么**：它按实例隔离用户级记忆（`userMemoryDir`），因而「所有实例都必须遵守的约束」缺少统一来源；本插件用固定共享路径 + 独立注入通道补上这一点。
- **互不调用**：本插件**不 import 它的代码、不读写它的数据文件、不依赖它的运行状态**；auto-memory 未安装时本插件照常工作（只是不再有那个缺口需要补）。
- **契约借用**：本插件沿用了它的两条工程约定作为设计参考——「注入走 `systemPrompt.context()` 而非 `section()`」，以及「注入段用 `order` 排序」。这些是 DSH 平台的机制，非 auto-memory 私有 API。

## 许可

MIT
