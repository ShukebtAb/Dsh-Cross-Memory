/**
 * dsh-cross-memory — 把跨实例硬约束（`~/.dsh/memory/cross/RULES.md`）注入每轮上下文。
 *
 * 设计约束（都有实测依据）：
 *  - **注入开关走插件 config**（`inject: false` 缺省）。插件**不判断**自己是否主实例——
 *    内容指纹去重已实测不可行（RULES.md 是重写版，21 条里最多只有 5 条能与用户级
 *    MEMORY.md 前 60 字符对上），路径判断会随迁移失效。⇒ 由操作者按实例显式声明。
 *  - **走 `systemPrompt.context()`**（user-role，追加在历史尾部，**不击穿前缀缓存**）；
 *    `section()` 只承载字节级稳定的静态内容，不用于本插件的动态读取结果。
 *  - **按 mtime 缓存**：文件未变不重复读盘。
 *  - **读盘失败静默跳过**：任何异常都不得影响会话。
 *  - 注入文本**不截断**——RULES.md 的错解否定是刻意保留的（单条最长 265 字符）。
 */
import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-cross-memory'
export const inject = ['systemPrompt', 'tools']

/** 规则文件路径。刻意硬编码为共享位置——全部实例看同一份，这正是本插件的目的。 */
const RULES_PATH = join(homedir(), '.dsh', 'memory', 'cross', 'RULES.md')

const BEGIN = '<!-- cross:begin -->'
const END = '<!-- cross:end -->'

/** 紧接 dsh-auto-memory 的注入段（SECTION_ORDER = 10000）之后。 */
const SECTION_ORDER = 10001

/** mtime 缓存。`items` 存在即视为有效快照。 */
let cache = { mtimeMs: null }

/**
 * 读取并解析规则文件。返回 `{ ok, reason }` 或
 * `{ ok: true, mtimeMs, bytes, sha256, items }`。绝不抛错。
 */
function loadRules() {
  let st
  try {
    st = statSync(RULES_PATH)
  } catch {
    return { ok: false, reason: 'rules-not-found' }
  }

  if (cache.mtimeMs === st.mtimeMs && Array.isArray(cache.items)) return cache

  let text
  try {
    text = readFileSync(RULES_PATH, 'utf8')
  } catch (e) {
    return { ok: false, reason: 'read-failed: ' + (e && e.message ? e.message : String(e)) }
  }

  const b = text.indexOf(BEGIN)
  const e = text.indexOf(END)
  const seg = b >= 0 && e > b ? text.slice(b + BEGIN.length, e) : ''
  const items = seg
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.trim())

  cache = {
    ok: true,
    mtimeMs: st.mtimeMs,
    bytes: st.size,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    items,
  }
  return cache
}

/** 渲染注入正文；无内容时返回空串（DSH 侧据此判定不注入）。 */
function renderBody(r) {
  if (!r.ok || !r.items || r.items.length === 0) return ''
  return (
    '[跨实例硬约束 · cross/RULES.md]\n' +
    `以下 ${r.items.length} 条由主实例的统一规则文件下发，适用于全部实例：\n\n` +
    r.items.join('\n')
  )
}

export function apply(ctx, config) {
  const enabled = config?.inject === true
  const disposers = []

  if (enabled) {
    disposers.push(
      ctx.systemPrompt.context({
        name: 'dsh:cross-memory-pre',
        order: SECTION_ORDER,
        text: () => {
          try {
            return renderBody(loadRules())
          } catch {
            return ''
          }
        },
      })
    )
  }

  disposers.push(
    ctx.tools.register({
      name: 'cross_memory_status',
      description:
        '报告跨实例规则文件 cross/RULES.md 的状态：绝对路径、SHA256、字节数、mtime、解析出的条目数、本实例是否开启注入。' +
        '主实例可用输出的 SHA256 与本机留档比对，检测该文件是否被误写（它目前没有只读保护，DSH 的 write/edit/pwsh 都能直接覆写）。',
      parameters: { type: 'object', properties: {}, required: [] },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: String(value) }]
        },
      },
      async execute() {
        const r = loadRules()
        if (!r.ok) {
          return JSON.stringify({ rulesPath: RULES_PATH, ok: false, reason: r.reason }, null, 2)
        }
        return JSON.stringify(
          {
            rulesPath: RULES_PATH,
            ok: true,
            sha256: r.sha256,
            bytes: r.bytes,
            mtimeMs: r.mtimeMs,
            itemsParsed: r.items.length,
            injectEnabled: enabled,
            itemsInjected: enabled ? r.items.length : 0,
          },
          null,
          2
        )
      },
    })
  )

  return () => {
    for (const d of disposers) {
      try {
        if (typeof d === 'function') d()
      } catch {
        /* dispose 失败不影响卸载 */
      }
    }
  }
}
