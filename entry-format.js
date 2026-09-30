/**
 * dsh-cross-memory · 结构化写入原语（纯函数层）
 *
 * 本模块**不 import 任何 fs** —— 插件侧用 `ctx.fs` 外壳、影子验证脚本用 `node:fs` 外壳，
 * 两侧共用同一份拼装与校验逻辑（交办件 §6「校验器可被工具与脚本共用」）。
 *
 * 契约来源：全部实读 `@a9i5k4/dsh-auto-memory` 3.2.5（行号为本机当场 grep 取得）
 *  - 锚点行是**唯一**条目分隔符：`lib/rules-layer.js:78`
 *      MEM_ANCHOR_LINE_RE = /^<!--\s*memory:(mem_[0-9a-f]{32})\s*-->$/
 *    首个锚点之前的内容被直接丢弃（`lib/rules-layer.js:153-174`）。
 *  - 严格写盘形态 `<!-- memory:mem_<32hex> -->`（一个空格）：
 *      `lib/memory-anchor.js:28` MARKER_RE（写死空格，白板/账本路径用它）。
 *    紧凑形态 `<!--memory:` 是**豁免**形态，不算 marker、也不算保留语法。
 *  - 注入面每条只取「首条实质行前 200 字符」：`lib/rules-layer.js:289` ruleSummaryPre(max = 200)。
 *  - 只有含约束语汇的条目才进规则段，否则判 `reference`：`lib/rules-layer.js:177-195`。
 *  - ★ **尾随空锚点会被判 orphan-anchor**：`lib/memory-anchor.js:137-149` finalizeAnchored()
 *    在该锚点之后到下一锚点之间找不到任何非空行（first === -1）即 push `orphan-anchor`，
 *    而 `lib/memory-writer.js` 五处 + `lib/storage-manage.js:183` 一律 `status !== 'clean'` ⇒ 整篇拒绝。
 *    本机探针实测坐实：文件末尾一个无内容锚点 ⇒ `status=conflict, conflicts=[orphan-anchor@N]`。
 *    ⇒ 本模块**一律不生成尾随空锚点**。
 *  - 正文里出现 `<!-- memory:`（带空格）会让该文件此后**永久拒写**：`lib/index.js:12066-12075`。
 */

import { randomUUID } from 'node:crypto'

/** 索引行上限（注入面 ruleSummaryPre 的硬编码 max）。 */
export const INDEX_MAX_CHARS = 200

/** 条目标题上限（防标题吃掉整行预算，非上游契约，本插件自设）。 */
export const TITLE_MAX_CHARS = 120

/** 严格锚点行（写盘用；`MARKER_RE` 同口径，一个空格）。 */
export const ANCHOR_LINE_STRICT_RE = /^<!-- memory:(mem_[0-9a-f]{32}) -->$/

/** 宽松锚点扫描（解析侧口径，带 `\s*`；仅用于识别既有锚点，不用于写盘）。 */
const ANCHOR_LINE_LOOSE_RE = /^<!--\s*memory:(mem_[0-9a-f]{32})\s*-->$/

/** memoryId 形态。 */
export const MEMORY_ID_RE = /^mem_[0-9a-f]{32}$/

/** 保留语法开标记（与 `lib/memory-anchor.js:34` 逐字相同）。 */
export const RESERVED_MARKER_OPEN = '<!-- memory:'

/** 约束语汇表（与 `lib/rules-layer.js:64-66` 逐字相同）。 */
export const CONSTRAINT_WORDS = Object.freeze([
  '严禁', '绝不', '必须', '不得', '禁止', '务必', '一律', '永远不', '不要再', '不准',
])

/** 日期小节标题（结构违规判据，与 `lib/rules-layer.js:86` 同口径）。 */
export const DATE_SECTION_RE = /^##\s*\d{4}-\d{2}-\d{2}\s*$/

/** 由 memoryId 生成严格形态锚点行。 */
export function anchorLineOf(memoryId) {
  if (!MEMORY_ID_RE.test(String(memoryId || ''))) {
    throw new Error('bad-memory-id: ' + memoryId)
  }
  return '<!-- memory:' + memoryId + ' -->'
}

/** 分配新 memoryId（随机 UUID 去连字符，与上游 `newMemoryId` 同源；禁止由内容派生）。 */
export function newAnchorId(randomHex32) {
  if (typeof randomHex32 === 'string' && /^[0-9a-f]{32}$/.test(randomHex32)) {
    return 'mem_' + randomHex32
  }
  return 'mem_' + randomUUID().replace(/-/g, '')
}

/** 列出文件里既有的全部锚点 id（宽松口径，与解析侧一致）。 */
export function listAnchorIds(fileText) {
  const ids = []
  for (const line of String(fileText || '').split(/\r?\n/)) {
    const m = ANCHOR_LINE_LOOSE_RE.exec(line.trim())
    if (m) ids.push(m[1])
  }
  return ids
}

/**
 * 扫描「保留语法」污染：带空格形态 `<!-- memory:` 出现在非合法锚点行上即命中。
 * 命中会让文件永久拒写，因此写入前必须 fail-closed。
 */
export function scanReservedSyntax(text) {
  const hits = []
  const lines = String(text == null ? '' : text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw.includes(RESERVED_MARKER_OPEN)) continue
    if (ANCHOR_LINE_LOOSE_RE.test(raw.trim())) continue
    hits.push({ line: i + 1, excerpt: raw.trim().slice(0, 60) })
  }
  return hits
}

/**
 * 校验索引行（条目首行）。判据全部来自注入面契约。
 * @returns {{ok:boolean, chars:number, reasons:string[], warnings:string[]}}
 */
export function validateIndexLine(indexLine, opts = {}) {
  const requireConstraint = opts.requireConstraint === true
  const line = String(indexLine == null ? '' : indexLine)
  const reasons = []
  const warnings = []

  if (!line.trim()) reasons.push('empty-index-line')
  if (/[\r\n]/.test(line)) reasons.push('index-line-has-newline')
  if (line.length > INDEX_MAX_CHARS) {
    reasons.push('index-line-too-long:' + line.length + '>' + INDEX_MAX_CHARS)
  }
  if (line.includes(RESERVED_MARKER_OPEN)) reasons.push('index-line-has-reserved-syntax')

  const hitWords = CONSTRAINT_WORDS.filter((w) => line.includes(w))
  if (!hitWords.length) {
    if (requireConstraint) reasons.push('no-constraint-word')
    else warnings.push('no-constraint-word(将判 reference，仅进 Tier-0 目录)')
  }
  return { ok: reasons.length === 0, chars: line.length, hitWords, reasons, warnings }
}

/** 校验条目标题。 */
export function validateTitle(title) {
  const text = String(title == null ? '' : title).trim()
  const reasons = []
  if (!text) reasons.push('empty-title')
  if (/[\r\n]/.test(String(title == null ? '' : title))) reasons.push('title-has-newline')
  if (text.length > TITLE_MAX_CHARS) reasons.push('title-too-long:' + text.length + '>' + TITLE_MAX_CHARS)
  if (text.includes(RESERVED_MARKER_OPEN)) reasons.push('title-has-reserved-syntax')
  return { ok: reasons.length === 0, reasons }
}

/** 渲染一条条目（锚点行 + 标题 + 索引行）。**不生成尾随空锚点。** */
export function renderEntry({ memoryId, title, indexLine }) {
  return anchorLineOf(memoryId) + '\n## ' + String(title).trim() + '\n- ' + String(indexLine).trim() + '\n'
}

/** 渲染要追加到 `handoff\archive-*.md` 的档案块（档案是普通 Markdown，不带锚点）。 */
export function renderArchiveAppend({ title, body }) {
  const text = String(body == null ? '' : body).replace(/\r\n/g, '\n').trim()
  if (!text) return ''
  return '\n### ' + String(title).trim() + '\n\n' + text + '\n'
}

/**
 * 拼装一次「追加结构化条目」的完整结果（纯函数，不落盘）。
 *
 * @param {object} input
 * @param {string} input.fileText        目标 `MEMORY.md` 现有全文
 * @param {string} input.title           条目标题
 * @param {string} input.indexLine       条目首行（≤200 字符；正文外移时须含档案指针）
 * @param {string} [input.bodyText]      超长正文（外移到档案；留空则本条目为纯索引行）
 * @param {string} [input.archiveRelPath] 档案短路径（如 `handoff/archive-回流-20261001.md`）
 * @param {boolean} [input.requireConstraint] 是否强制约束语汇
 * @param {string} [input.idFactory]     测试注入的 32 位 hex
 * @returns {{ok:true, noteText:string, archiveAppend:string, memoryId:string, anchorLine:string, warnings:string[]}
 *          |{ok:false, reasons:string[]}}
 */
export function composeAppendEntry(input) {
  const reasons = []
  const warnings = []

  const fileText = String(input?.fileText == null ? '' : input.fileText)
  const title = input?.title
  const indexLine = input?.indexLine
  const bodyText = String(input?.bodyText == null ? '' : input.bodyText).trim()
  const archiveRelPath = String(input?.archiveRelPath == null ? '' : input.archiveRelPath).trim()

  const titleCheck = validateTitle(title)
  if (!titleCheck.ok) reasons.push(...titleCheck.reasons)

  const indexCheck = validateIndexLine(indexLine, { requireConstraint: input?.requireConstraint === true })
  if (!indexCheck.ok) reasons.push(...indexCheck.reasons)
  warnings.push(...indexCheck.warnings)

  // 正文外移时，档案短路径必须落在索引行里 —— 注入面只取首行，路径不在这行等于读不到。
  if (bodyText && !archiveRelPath) reasons.push('body-text-needs-archive-path')
  if (bodyText && archiveRelPath && !String(indexLine).includes(archiveRelPath)) {
    reasons.push('archive-path-not-in-index-line')
  }

  // 既有文件若含保留语法污染，任何写入都会失败 ⇒ 先拦。
  const reservedHits = scanReservedSyntax(fileText)
  if (reservedHits.length) {
    reasons.push('file-has-reserved-syntax@line' + reservedHits.map((h) => h.line).join(','))
  }

  // 既有锚点必须唯一（重复 id 会让写入侧判 duplicate ⇒ 整篇拒写）。
  const existingIds = listAnchorIds(fileText)
  const dupIds = existingIds.filter((id, i) => existingIds.indexOf(id) !== i)
  if (dupIds.length) reasons.push('file-has-duplicate-anchor:' + [...new Set(dupIds)].join(','))

  const memoryId = newAnchorId(input?.idFactory)
  if (existingIds.includes(memoryId)) reasons.push('anchor-id-collision:' + memoryId)

  if (reasons.length) return { ok: false, reasons }

  // 末尾补一个换行后追加，保证与上一条目之间有空行边界。
  const head = fileText.replace(/\s*$/, '')
  const entryText = renderEntry({ memoryId, title, indexLine })
  const noteText = (head ? head + '\n\n' : '') + entryText
  const archiveAppend = bodyText ? renderArchiveAppend({ title, body: bodyText }) : ''

  return {
    ok: true,
    noteText,
    archiveAppend,
    memoryId,
    anchorLine: anchorLineOf(memoryId),
    warnings,
  }
}

/** 结构体检：给文件做一次只读指标统计（供校验器与报告共用）。 */
export function inspectNoteFile(fileText) {
  const text = String(fileText == null ? '' : fileText)
  const lines = text.split(/\r?\n/)
  const ids = listAnchorIds(text)
  const dateSections = lines.filter((l) => DATE_SECTION_RE.test(l.trim())).length
  return {
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: lines.length,
    anchors: ids.length,
    uniqueAnchors: new Set(ids).size,
    duplicateAnchors: ids.length - new Set(ids).size,
    dateSections,
    reservedSyntaxHits: scanReservedSyntax(text).length,
    hasCRLF: /\r\n/.test(text),
    hasBOM: text.charCodeAt(0) === 0xfeff,
  }
}
