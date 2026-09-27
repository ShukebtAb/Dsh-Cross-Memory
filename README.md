# dsh-cross-memory

把**跨实例硬约束**注入每一轮上下文：一份规则文件（`cross/RULES.md`），全部实例共同遵守。

## 它解决什么

多个 DSH 实例各自有独立记忆时，「哪些约束是**所有实例都必须遵守**的」没有统一来源。本插件从固定路径读取一份共享规则文件，把其中的条目注入每轮上下文——**改一处，全部实例生效**。

## 不用它行不行

行，但有代价。把同样的 21 条写进各实例自己的用户级 `MEMORY.md` 时：

| 承载方式 | 每轮成本 | 错解否定 |
|---|---|---|
| **本插件全文注入** | **3529 字符** | ✅ 完整保留 |
| 各实例写进 `MEMORY.md` | 4242 字符（21 条 × 202） | ❌ 被 200 字符渲染截断砍掉 |
| `SKILL.md` 按需加载 | 0 | ✅ 完整，但**不带「必读」属性** |

> 规则段每条只渲染「首条实质行前 200 字符 + `…`」（`rules-layer.js`），所以**长条目写进 `MEMORY.md` 注定被砍**。要完整保留错解否定，只能走插件注入。

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
| 单条长度 | ≤260 字符**全文注入、不截断** |
| 编码 | UTF-8 无 BOM、LF |

## 安装

```powershell
# 从 GitHub（推荐，锁定 commit 可复现）
dsh plugin --profile web add github:<owner>/dsh-cross-memory#<commit>

# 本地开发期
dsh plugin --profile web add file:D:\Study\Product\dsh-cross-memory
```

## ⚠ `inject` 开关：每个实例必须显式声明

**插件不会猜自己是不是主实例**。内容指纹去重已实测不可行——`RULES.md` 是**重写版**而非摘抄版（措辞、语序、markdown 标记都动过），21 条里最多只有 5 条能与用户级 `MEMORY.md` 的前 60 字符对上；按路径判断又会随迁移失效。

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

输出 JSON：

```json
{
  "rulesPath": "C:\\Users\\Administrator\\.dsh\\memory\\cross\\RULES.md",
  "ok": true,
  "sha256": "…",
  "bytes": 8379,
  "mtimeMs": 1758…,
  "itemsParsed": 21,
  "injectEnabled": false,
  "itemsInjected": 0
}
```

**用途**：`RULES.md` 目前**没有任何写保护**（`IsReadOnly = False`，DSH 本体的 `write`/`edit`/`pwsh` 都能直接覆写，唯一护栏是「不在工作区内」的路径隔离）。主实例可定期比对该 `sha256`，发现被误写即告警——这是「位置隔离 + SHA256 校验」加固方案中校验那一半的落地手段。

## 行为细节

- **注入通道**：`systemPrompt.context()`（user-role，追加在历史尾部）——**不击穿 DeepSeek 前缀缓存**；`section()` 只用于字节级稳定的静态内容，本插件不用。
- **缓存**：按 `mtimeMs` 缓存，文件未变不重复读盘。
- **失败姿态**：文件缺失、读失败、锚点缺失一律**静默返回空串**（不注入、不报错、不影响会话）。
- **不截断**：注入正文原样输出，`RULES.md` 的错解否定是刻意保留的设计。

## 许可

MIT
