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
import {
  composeAppendEntry,
  inspectNoteFile,
  composeFixPlan,
  diagnoseBareEntries,
  countPendingNominations,
} from './entry-format.js'

export const name = 'dsh-cross-memory'
export const inject = ['systemPrompt', 'tools']

/** 规则文件路径。刻意硬编码为共享位置——全部实例看同一份，这正是本插件的目的。 */
const RULES_PATH = join(homedir(), '.dsh', 'memory', 'cross', 'RULES.md')

/**
 * 用户级笔记路径（`scope='user'` 的落点）。同样硬编码 —— 本插件**不新增配置键**。
 * 用户级**没有** `handoff/` 落地目录，所以该落点下正文外移被 fail-closed 拒绝（见 entry-format.js）。
 */
const USER_MEMORY_PATH = join(homedir(), '.dsh', 'memory', 'MEMORY.md')
/**
 * 用户级规则**提名区**路径（与 `RULES.md` 同目录）。本插件只**读**它，用于回答
 * `cross_memory_status` 的 `nominationsPending` —— 不写、不改、不注入（改判依据见 H20261002-13）。
 */
const NOMINATIONS_PATH = join(homedir(), '.dsh', 'memory', 'cross', 'NOMINATIONS.md')

const BEGIN = '<!-- cross:begin -->'
const END = '<!-- cross:end -->'

/** 紧接 dsh-auto-memory 的注入段（SECTION_ORDER = 10000）之后。 */
const SECTION_ORDER = 10001

/** mtime 缓存。`items` 存在即视为有效快照。 */
let cache = { mtimeMs: null }
/** NOMINATIONS.md 的 mtime 缓存。`pending` 为数字即视为有效快照。 */
let nomCache = { mtimeMs: null }

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

/**
 * 读取提名区并数「待议」提名片数。与 loadRules 同样按 mtimeMs 缓存、绝不抛错。
 * 解析失败返回 `{ ok:false, reason }` —— 调用方以 `null` 透出，**不伪装成 0**。
 */
function loadNominations() {
  let st
  try {
    st = statSync(NOMINATIONS_PATH)
  } catch {
    return { ok: false, reason: 'nominations-not-found' }
  }

  if (nomCache.mtimeMs === st.mtimeMs && typeof nomCache.pending === 'number') return nomCache

  let text
  try {
    text = readFileSync(NOMINATIONS_PATH, 'utf8')
  } catch (e) {
    return { ok: false, reason: 'read-failed: ' + (e && e.message ? e.message : String(e)) }
  }

  const r = countPendingNominations(text)
  if (!r.ok) return r

  nomCache = { ok: true, mtimeMs: st.mtimeMs, pending: r.pending }
  return nomCache
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

/**
 * 结构化写入工具：把一条条目按「锚点 + ≤200 索引行 + 正文外移档案」写进工作区笔记。
 * 拼装与校验全部走 `entry-format.js` 的纯函数（与影子验证脚本同一份逻辑）。
 */
function buildWriteEntryToolDef(fsCtx) {
  return {
    name: 'cross_memory_write_entry',
    description:
      '把一条结构化条目写进记忆笔记：自动分配锚点行、校验索引行 ≤200 字符、把超长正文外移到 handoff 档案并在索引行里留短路径指针。' +
      'scope=workspace（缺省）写工作区笔记（memoryFile 必填）；scope=user 写用户级 ~/.dsh/memory/MEMORY.md（该落点无 handoff 目录 ⇒ 禁止 body/archivePath）。' +
      '默认预演（apply=false）只回改前/改后结构指标；apply=true 才落盘，落盘前强制生成 .pre-write-* 基线。' +
      '写入前会 fail-closed 拒绝：锚点重复、保留语法污染（带空格的 <!-- memory:）、索引行超长、正文外移但指针不在索引行内、user 落点带正文外移。' +
      '本工具不生成尾随空锚点 —— 那会被 auto-memory 的 parseAnchors 判 orphan-anchor 致整篇拒写。',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['workspace', 'user'],
          description: "落点：'workspace'（缺省）工作区笔记；'user' 用户级 ~/.dsh/memory/MEMORY.md",
        },
        memoryFile: { type: 'string', description: "目标工作区 MEMORY.md 的绝对路径；scope='user' 时忽略" },
        title: { type: 'string', description: '条目标题（不带 # 前缀）' },
        indexLine: { type: 'string', description: '条目索引行；注入面只取它的前 200 字符，须自包含结论' },
        body: { type: 'string', description: '超长正文；给了就会外移到档案，此时 indexLine 内必须含该档案的短路径指针' },
        archivePath: { type: 'string', description: '档案绝对路径；body 非空时必填' },
        apply: { type: 'boolean', description: 'false（缺省）= 只预演；true = 真正落盘' },
      },
      required: ['title', 'indexLine'],
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      },
    },
    async execute(args) {
      const scope = args?.scope === 'user' ? 'user' : 'workspace'
      const memoryFile = scope === 'user' ? USER_MEMORY_PATH : String(args?.memoryFile || '')
      if (!memoryFile) return JSON.stringify({ ok: false, reason: 'memory-file-required' }, null, 2)

      let currentText
      try {
        currentText = readFileSync(memoryFile, 'utf8')
      } catch (e) {
        return JSON.stringify({ ok: false, reason: 'read-failed: ' + (e && e.message ? e.message : String(e)) }, null, 2)
      }

      const archivePath = args?.archivePath ? String(args.archivePath) : ''
      const composed = composeAppendEntry({
        fileText: currentText,
        title: args?.title,
        indexLine: args?.indexLine,
        bodyText: args?.body,
        archiveRelPath: archivePath ? 'handoff/' + archivePath.split(/[\\/]/).pop() : '',
        scope,
      })
      if (!composed.ok) {
        return JSON.stringify({ ok: false, blocked: true, scope, targetPath: memoryFile, reasons: composed.reasons }, null, 2)
      }

      const report = {
        scope,
        targetPath: memoryFile,
        memoryId: composed.memoryId,
        warnings: composed.warnings,
        before: inspectNoteFile(currentText),
        after: inspectNoteFile(composed.noteText),
      }

      if (args?.apply !== true) {
        return JSON.stringify({ ok: true, dryRun: true, ...report }, null, 2)
      }

      const stampText = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
      const baselinePath = memoryFile + '.pre-write-' + stampText
      try {
        await fsCtx.fs.writeText(await fsCtx.fs.resolve(baselinePath), currentText)
        if (composed.archiveAppend && archivePath) {
          let existing = ''
          try {
            existing = readFileSync(archivePath, 'utf8')
          } catch {
            existing = ''
          }
          await fsCtx.fs.writeText(await fsCtx.fs.resolve(archivePath), existing + composed.archiveAppend)
        }
        await fsCtx.fs.writeText(await fsCtx.fs.resolve(memoryFile), composed.noteText)
      } catch (e) {
        return JSON.stringify(
          { ok: false, reason: 'write-failed: ' + (e && e.message ? e.message : String(e)), ...report },
          null,
          2
        )
      }

      return JSON.stringify(
        { ok: true, applied: true, baselinePath, archivePath: archivePath || null, ...report },
        null,
        2
      )
    },
  }
}

/** 裸条修复工具（第 3 个工具）：检出并修复 A 类（无锚点裸条）与 B 类（空锚点）病灶。 */
function buildFixBareEntriesToolDef(fsCtx) {
  return {
    name: 'cross_memory_fix_bare_entries',
    description:
      '检出并修复记忆笔记里的「裸条」：A 类＝无锚点裸条（append 通路产出 ⇒ 零注入贡献却实占容量）、B 类＝空锚点（orphan-anchor ⇒ 致整篇拒写）。' +
      'scope=workspace（缺省）针对工作区笔记（memoryFile 必填）；scope=user 针对用户级 ~/.dsh/memory/MEMORY.md。' +
      '默认预演（apply=false）只报病灶清单（类型/行号/拟插锚点 id/拟插位置）与改前改后结构指标，不落盘。' +
      'apply=true 时逐条**只插入新行**（绝不改动既有行）→ 先留 .pre-write-* 基线 → 写后自检，仍有 A/B 病灶即从基线回滚。' +
      'C 类（重复锚点）只检出、不自动改（留哪个 id 属语义判断）。' +
      'A 类锚点 id 用确定性派生（scope + 文件名 + 首行前 60 字符）⇒ 同一裸条反复扫描得同一 id，幂等可核。',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['workspace', 'user'],
          description: "落点：'workspace'（缺省）工作区笔记；'user' 用户级 ~/.dsh/memory/MEMORY.md",
        },
        memoryFile: { type: 'string', description: "目标工作区 MEMORY.md 的绝对路径；scope='user' 时忽略" },
        apply: { type: 'boolean', description: 'false（缺省）= 只报方案；true = 真正落盘（写前留基线、写后自检）' },
      },
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      },
    },
    async execute(args) {
      const scope = args?.scope === 'user' ? 'user' : 'workspace'
      const memoryFile = scope === 'user' ? USER_MEMORY_PATH : String(args?.memoryFile || '')
      if (!memoryFile) return JSON.stringify({ ok: false, reason: 'memory-file-required' }, null, 2)

      let currentText
      try {
        currentText = readFileSync(memoryFile, 'utf8')
      } catch (e) {
        return JSON.stringify({ ok: false, reason: 'read-failed: ' + (e && e.message ? e.message : String(e)) }, null, 2)
      }

      const fileBasename = memoryFile.split(/[\\/]/).pop()
      const plan = composeFixPlan({ fileText: currentText, scope, fileBasename })
      if (!plan.ok) {
        return JSON.stringify({ ok: false, blocked: true, scope, targetPath: memoryFile, reasons: plan.reasons }, null, 2)
      }

      const report = {
        scope,
        targetPath: memoryFile,
        changed: plan.changed,
        diagnostics: plan.diagnostics,
        plan: plan.plan,
        warnings: plan.warnings,
        before: plan.before,
        after: plan.after,
      }

      if (args?.apply !== true || !plan.changed) {
        return JSON.stringify({ ok: true, dryRun: args?.apply !== true, ...report }, null, 2)
      }

      const stampText = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
      const baselinePath = memoryFile + '.pre-write-' + stampText
      try {
        await fsCtx.fs.writeText(await fsCtx.fs.resolve(baselinePath), currentText)
        await fsCtx.fs.writeText(await fsCtx.fs.resolve(memoryFile), plan.noteText)

        // 写后自检：A/B 病灶必须清零，否则从基线回滚（红线：不 clean 即回滚）。
        const recheck = diagnoseBareEntries(readFileSync(memoryFile, 'utf8'))
        if (recheck.bareA.length || recheck.orphan.length) {
          await fsCtx.fs.writeText(await fsCtx.fs.resolve(memoryFile), currentText)
          return JSON.stringify(
            { ok: false, reason: 'post-write-check-failed', rolledBack: true, recheck, baselinePath },
            null,
            2
          )
        }
      } catch (e) {
        return JSON.stringify(
          { ok: false, reason: 'write-failed: ' + (e && e.message ? e.message : String(e)), ...report },
          null,
          2
        )
      }

      return JSON.stringify({ ok: true, applied: true, baselinePath, ...report }, null, 2)
    },
  }
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
        const nom = loadNominations()
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
            nominationsPending: nom.ok ? nom.pending : null,
          },
          null,
          2
        )
      },
    })
  )

  // 结构化写入与裸条修复：可选依赖 —— 宿主没挂 fs 后端时不注册这两个工具，本插件其余功能照常。
  ctx.inject(['fs'], (fsCtx) => {
    disposers.push(fsCtx.tools.register(buildWriteEntryToolDef(fsCtx)))
    disposers.push(fsCtx.tools.register(buildFixBareEntriesToolDef(fsCtx)))
  })

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
