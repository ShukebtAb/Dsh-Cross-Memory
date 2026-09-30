#!/usr/bin/env node
/**
 * 影子验证 —— 用与插件**完全相同**的纯函数层（`entry-format.js`）对真实记忆笔记做一次
 * 「追加结构化条目」，并给出改前/改后结构指标对比。
 *
 * 默认 **dry-run**（只算不写）；只有显式 `--apply` 才落盘，且落盘前强制留 `.pre-write-*` 基线。
 *
 * 用法：
 *   node tools/shadow-verify.mjs <目标 MEMORY.md 绝对路径> --title "..." --index "..." [选项]
 *
 * 选项：
 *   --index <文本>      条目索引行（≤200 字符；正文外移时须含档案短路径）
 *   --body <文本>       超长正文（外移到档案）
 *   --archive <路径>    档案绝对路径（不给则由目标目录 handoff/ 自动命名）
 *   --apply             真正落盘（缺省只预演）
 *   --pkg <插件根>      @a9i5k4/dsh-auto-memory 插件根目录；给了就用它的 parseAnchors 交叉验证
 *   --seed <32位hex>    固定锚点 id（便于复现）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { composeAppendEntry, inspectNoteFile } from '../entry-format.js'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--apply') out.apply = true
    else if (token.startsWith('--')) { out[token.slice(2)] = argv[i + 1]; i++ }
    else out._.push(token)
  }
  return out
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function metricRow(label, before, after, verdict) {
  return `| ${label} | ${before} | ${after} | ${verdict} |`
}

const args = parseArgs(process.argv.slice(2))
const targetPath = args._[0]
if (!targetPath) {
  console.error('用法: node tools/shadow-verify.mjs <目标 MEMORY.md 绝对路径> --title "..." --index "..." [--body ...] [--archive ...] [--apply] [--pkg ...] [--seed ...]')
  process.exit(2)
}
if (!existsSync(targetPath)) {
  console.error('目标文件不存在: ' + targetPath)
  process.exit(2)
}

const noteText = readFileSync(targetPath, 'utf8')
const targetDir = dirname(targetPath)
const archivePath = args.archive || join(targetDir, 'handoff', `archive-交付验证-${stamp().slice(0, 8)}.md`)
// 索引行里要出现的是**短路径指针**（注入面只取首行，绝对路径太长会挤爆 200 字符预算）。
const archivePointer = 'handoff/' + archivePath.split(/[\\/]/).pop()

const composed = composeAppendEntry({
  fileText: noteText,
  title: args.title,
  indexLine: args.index,
  bodyText: args.body,
  archiveRelPath: args.body ? archivePointer : '',
  requireConstraint: args['require-constraint'] === 'true',
  idFactory: args.seed,
})

console.log('=== 影子验证（' + (args.apply ? 'APPLY' : 'DRY-RUN') + '） ===')
console.log('目标: ' + targetPath)
if (args.body) console.log('档案: ' + archivePath)

if (!composed.ok) {
  console.log('结果: 被拒（fail-closed）')
  for (const reason of composed.reasons) console.log('  - ' + reason)
  process.exit(1)
}
if (composed.warnings.length) {
  console.log('警告:')
  for (const warning of composed.warnings) console.log('  - ' + warning)
}
console.log('新锚点: ' + composed.memoryId)

const before = inspectNoteFile(noteText)
const after = inspectNoteFile(composed.noteText)

let oracle = 'skipped'
if (args.pkg) {
  const anchorModule = 'file:///' + join(args.pkg, 'lib', 'memory-anchor.js').replace(/\\/g, '/')
  const { parseAnchors } = await import(anchorModule)
  const parsed = parseAnchors(Buffer.from(composed.noteText, 'utf8'))
  oracle = parsed.status + ' conflicts=' + JSON.stringify(parsed.conflicts.map((c) => c.type + '@' + c.line))
}
console.log('parseAnchors oracle: ' + oracle)

console.log('\n### 改前 / 改后结构指标')
console.log('| 指标 | 改前 | 改后 | 判据 |')
console.log('|---|---|---|---|')
console.log(metricRow('字符数', before.chars, after.chars, '记录即可'))
console.log(metricRow('锚点数', before.anchors, after.anchors, '应 +1'))
console.log(metricRow('锚点唯一数', before.uniqueAnchors + '/' + before.anchors, after.uniqueAnchors + '/' + after.anchors, '必须相等'))
console.log(metricRow('## 日期段数', before.dateSections, after.dateSections, '不得增加'))
console.log(metricRow('保留语法命中', before.reservedSyntaxHits, after.reservedSyntaxHits, '必须 0'))
console.log(metricRow('CRLF', before.hasCRLF, after.hasCRLF, '必须 false'))
console.log(metricRow('BOM', before.hasBOM, after.hasBOM, '必须 false'))

const baseline = join(targetDir, 'MEMORY.md.pre-write-' + stamp())
if (!args.apply) {
  console.log('\n未落盘（dry-run）。加 --apply 才写入；落盘前会生成基线 ' + baseline)
  process.exit(0)
}

copyFileSync(targetPath, baseline)
if (composed.archiveAppend) {
  mkdirSync(dirname(archivePath), { recursive: true })
  const existing = existsSync(archivePath) ? readFileSync(archivePath, 'utf8') : ''
  writeFileSync(archivePath, existing + composed.archiveAppend, { encoding: 'utf8' })
}
writeFileSync(targetPath, composed.noteText, { encoding: 'utf8' })

console.log('\n已落盘：')
console.log('  基线 ' + baseline + ' (' + statSync(baseline).size + ' B)')
if (composed.archiveAppend) console.log('  档案 ' + archivePath + ' (' + statSync(archivePath).size + ' B)')
console.log('  笔记 ' + targetPath + ' (' + statSync(targetPath).size + ' B)')
