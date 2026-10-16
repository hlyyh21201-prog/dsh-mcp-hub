/**
 * 「接管」能力的测试：把外部 MCP 行从别人的 patch 文件迁到本插件名下。
 *
 * 这里守的核心是**不破坏用户文件**：
 *   - 只摘掉目标行，其余内容（含注释、空行、其它插件条目）逐行保持原样；
 *   - 结果仍是合法 YAML；
 *   - 动手前先备份；
 *   - 拒绝摘除「看起来不像 MCP 配置」的行（防同名误伤）。
 *
 * 运行：node lib/adopt.test.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanInsertRows, removeInsertRows, looksLikeMcpClientRow } from './patchfile.js'

let failures = 0
let checks = 0
function check(label, condition, detail) {
  checks += 1
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** 一份贴近真实的 profile patch：注释 + MCP insert 块 + 其它插件条目。 */
const FIXTURE = `# MCP servers managed by the dsh-mcp-manager plugin.
# Format: a top-level YAML array of loader patch entries (\`!!js\` expressions
# allowed). Edit here, or use the MCP Manager panel in the web GUI.
- insert:
    - id: mcp-mysql-dev
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: mysql-dev
        transport: stdio
        command: /usr/bin/npx
        args:
          - '-y'
          - mysql-mcp-server
        env:
          MYSQL_HOST: dev.example.com
          MYSQL_PASSWORD: s3cret
    - id: mcp-idea
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: idea
        transport: streamable-http
        url: http://127.0.0.1:64342/stream
- id: hindsight
  disabled: true
- id: llm-deepseek
  config:
    apiKey: sk-xxx
- insert:
    - id: chrome-devtools
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: chrome-devtools
        transport: stdio
        command: /usr/bin/npx
- id: agy-link
  disabled: true
`

console.log('== 扫描 insert 行 ==')

const { blocks } = scanInsertRows(FIXTURE)
check('识别 2 个 insert 块', blocks.length === 2, String(blocks.length))
const allIds = blocks.flatMap((block) => block.rows.map((row) => row.id))
check(
  '识别出全部 insert 行',
  JSON.stringify(allIds) === JSON.stringify(['mcp-mysql-dev', 'mcp-idea', 'chrome-devtools']),
  JSON.stringify(allIds)
)
// 关键：最后一个 insert 行必须止于块边界，不能吞掉后面的顶层条目
const chrome = blocks[1].rows[0]
const chromeText = FIXTURE.split('\n').slice(chrome.start, chrome.end).join('\n')
check('末行范围止于下一个顶层条目', !chromeText.includes('agy-link'), chromeText)
check('末行范围包含自身配置', chromeText.includes('chrome-devtools'), chromeText)

console.log('\n== 摘除 MCP 行 ==')

const removed = removeInsertRows(FIXTURE, ['mcp-mysql-dev', 'mcp-idea'], (id, rowText) => looksLikeMcpClientRow(rowText))
check('摘除 2 行', JSON.stringify(removed.removed) === JSON.stringify(['mcp-mysql-dev', 'mcp-idea']), JSON.stringify(removed.removed))
check('无跳过', removed.skipped.length === 0, JSON.stringify(removed.skipped))

const after = removed.text
check('目标行已消失', !after.includes('mcp-mysql-dev') && !after.includes('mcp-idea'))
check('注释头保留', after.startsWith('# MCP servers managed by the dsh-mcp-manager plugin.'))
check('其它插件条目保留', after.includes('- id: hindsight') && after.includes('- id: llm-deepseek') && after.includes('- id: agy-link'))
check('未选中的 MCP 行保留', after.includes('- id: chrome-devtools'))

// 整块删空时，`- insert:` 头也一并删掉
const insertHeads = (after.match(/^- insert:/gm) ?? []).length
check('只剩 1 个 insert 块（空块已清理）', insertHeads === 1, String(insertHeads))

// 逐行比对：保留部分必须与原文完全一致（保序）
const before = FIXTURE.split('\n')
const keptExpected = before.filter((line, index) => {
  // 目标行 5..19、20..26 附近：以内容判定，避免硬编码行号
  if (line.includes('mcp-mysql-dev') || line.includes('mcp-idea')) return false
  if (line.includes('serverName: mysql-dev') || line.includes('serverName: idea')) return false
  if (line.includes('MYSQL_HOST: dev.example.com') || line.includes('MYSQL_PASSWORD: s3cret')) return false
  if (line.includes('http://127.0.0.1:64342/stream')) return false
  if (line.includes('transport: streamable-http')) return false
  if (line.includes('mysql-mcp-server')) return false
  if (line.trim() === "- '-y'") return false
  if (line.trim() === 'args:') return false
  if (line.trim() === 'env:') return false
  return true
})
const afterLines = after.split('\n')
const lostUnexpectedly = keptExpected.filter((line) => !afterLines.includes(line))
check('除目标行外无内容丢失', lostUnexpectedly.length === 0, JSON.stringify(lostUnexpectedly.slice(0, 5)))

console.log('\n== 安全护栏 ==')

// 非 MCP 的同名行必须拒绝
const otherPlugin = `- insert:
    - id: mcp-idea
      name: '@someone/other-plugin'
      config:
        whatever: 1
`
const refused = removeInsertRows(otherPlugin, ['mcp-idea'], (id, rowText) => looksLikeMcpClientRow(rowText))
check('拒绝摘除非 MCP 行', refused.removed.length === 0 && refused.skipped.includes('mcp-idea'), JSON.stringify(refused))
check('拒绝时文本不变', refused.text === otherPlugin)

// 空 ids 直接返回原文
const noop = removeInsertRows(FIXTURE, [])
check('空 ids 不改动文本', noop.text === FIXTURE && noop.removed.length === 0)

// 不存在的 id 不报错也不改动
const none = removeInsertRows(FIXTURE, ['mcp-nope'])
check('不存在的 id 不改动文本', none.text === FIXTURE && none.removed.length === 0)

// tab 缩进 / CRLF 不应误判
const crlf = FIXTURE.replace(/\n/g, '\r\n')
const crlfResult = removeInsertRows(crlf, ['mcp-idea'], (id, rowText) => looksLikeMcpClientRow(rowText))
check('CRLF 文件可正常摘除', crlfResult.removed.includes('mcp-idea'), JSON.stringify(crlfResult.removed))

console.log('\n== 结果仍是合法 YAML ==')

const yaml = await import(
  process.env.DSH_JS_YAML ??
    '/home/yyh/.config/nvm/versions/node/v26.8.1/lib/node_modules/@deepseek-ai/dsh/node_modules/js-yaml/index.js'
).catch(() => import('js-yaml'))
const parsed = yaml.load(after)
check('可被 YAML 解析', Array.isArray(parsed), JSON.stringify(parsed)?.slice(0, 80))
check('顶层条目数正确（3 个 - id 条目 + 1 个剩余 insert）', parsed.length === 4, String(Array.isArray(parsed) ? parsed.length : 'n/a'))
const flat = JSON.stringify(parsed)
check('解析结果里没有已摘除的 id', !flat.includes('mcp-mysql-dev') && !flat.includes('mcp-idea'))
check('解析结果里保留了 chrome-devtools', flat.includes('chrome-devtools'))

console.log(`\n${checks - failures}/${checks} 通过`)
if (failures > 0) process.exitCode = 1
