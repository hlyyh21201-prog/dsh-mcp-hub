/**
 * 跨平台（macOS / Windows / Linux）与配置发现（Gemini / Antigravity）测试。
 *
 * 覆盖两类真实问题：
 *
 * 1. **找不到设置文件**：`~/.gemini/config/mcp_config.json` 是 Gemini CLI 与
 *    Antigravity 实际使用的 MCP 配置（`~/.gemini/config/` 目录里带 `.migrated`
 *    标记，是从旧位置迁过来的；旧位置 `~/.gemini/settings.json` 的 mcpServers
 *    通常已空）。只扫旧位置就永远发现不了这份配置。
 *
 * 2. **把设置文件误当 MCP 配置**：`.claude/settings.json` 里有
 *    `statusLine: { type: "command", command: "~/.claude/statusline.sh" }`，
 *    它带 type 又带 command，长得像一台 stdio 服务器；`type` 是 `"command"`
 *    而不是任何 MCP 传输名，且顶层还有 env/theme 这些非服务器键。
 *    早期实现会把它导成一台叫 statusLine 的假服务器。
 *
 * 3. **平台差异**：Windows 上 npx 是 `npx.cmd`，Node 从 v18.20/v20.12 起拒绝
 *    直接 spawn `.cmd`（CVE-2024-27980），必须走 `cmd.exe /c`；
 *    Windows 路径全是反斜杠，写进 YAML 必须能原样读回。
 *
 * 运行：node lib/platform.test.mjs
 */

import { readFileSync } from 'node:fs'

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

const { parseImportText } = await import('./parsers.js')
const { parseEntryList, dumpEntryList } = await import('./yaml.js')

const indexSource = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
const probeSource = readFileSync(new URL('./probe.js', import.meta.url), 'utf8')
const parsersSource = readFileSync(new URL('./parsers.js', import.meta.url), 'utf8')

console.log('== Gemini / Antigravity 配置发现 ==')

check(
  '扫描列表包含 ~/.gemini/config/mcp_config.json（Gemini/Antigravity 真实位置）',
  /'\.gemini',\s*'config',\s*'mcp_config\.json'/.test(indexSource),
  '未包含新位置'
)
check(
  '扫描列表保留旧的 ~/.gemini/settings.json',
  /'\.gemini',\s*'settings\.json'/.test(indexSource),
  '删掉了旧位置，可能漏掉仍在用旧路径的用户'
)
check(
  '扫描列表包含 Antigravity 的候选路径',
  /antigravity/i.test(indexSource),
  '未提到 antigravity'
)
check(
  '扫描结果跳过「存在但没有 MCP 条目」的文件',
  /if \(servers <= 0\) continue/.test(indexSource),
  'settings.json / config.json 这类文件会被列成 0 服务器'
)
check(
  '扫描按平台区分 Claude Desktop 位置（darwin / win32）',
  /process\.platform === 'win32'/.test(indexSource) && /process\.platform === 'darwin'/.test(indexSource),
  '未按平台分叉'
)
check(
  'Windows 用 %APPDATA% 而不是手拼 AppData\\Roaming',
  /process\.env\.APPDATA/.test(indexSource),
  '未读 APPDATA 环境变量'
)
check(
  '扫描结果去重（同一路径可能被两条定义指到）',
  /const seen = new Set\(\)/.test(indexSource),
  '未去重'
)

console.log('\n== 该文件真的能被解析 ==')

// 用一条与真实文件同形的 fixture，而不是依赖本机某个文件存在
const geminiFixture = JSON.stringify({
  mcpServers: {
    'mysql-dev': { command: 'npx', args: ['-y', 'mysql-mcp-server'], env: { MYSQL_PASSWORD: 'p@ss' } },
    idea: { serverUrl: 'http://127.0.0.1:64342/stream' },
    WebStorm: { serverUrl: 'http://127.0.0.1:64542/stream' },
  },
})
const gemini = parseImportText(geminiFixture, { format: 'json', maskSecrets: true })
check('解析出 3 台', gemini.items.length === 3, String(gemini.items.length))
check(
  'serverUrl 被识别为 streamable-http',
  gemini.items.filter((i) => i.config.transport === 'streamable-http').length === 2,
  JSON.stringify(gemini.items.map((i) => [i.sourceName, i.config.transport]))
)
check(
  'serverUrl 的值进入 url 字段',
  gemini.items.find((i) => i.sourceName === 'idea')?.config.url === 'http://127.0.0.1:64342/stream',
  JSON.stringify(gemini.items.find((i) => i.sourceName === 'idea')?.config)
)
check(
  '密码被打码',
  gemini.items[0].config.env.MYSQL_PASSWORD === '__DSH_MCP_HUB_SET_ME__' &&
    gemini.items[0].maskedKeys.includes('MYSQL_PASSWORD'),
  JSON.stringify(gemini.items[0])
)

console.log('\n== 设置文件不应被误判成 MCP 配置 ==')

const claudeSettings = JSON.stringify({
  env: { ANTHROPIC_AUTH_TOKEN: 'sk-x' },
  statusLine: { type: 'command', command: '~/.claude/statusline.sh' },
  modelSettings: 'deepseek-v4-flash',
  theme: 'dark',
})
const claudeParsed = parseImportText(claudeSettings, { format: 'json', maskSecrets: true })
check(
  'statusLine 不再被当成服务器',
  !claudeParsed.items.some((i) => i.sourceName === 'statusLine'),
  JSON.stringify(claudeParsed.items.map((i) => i.sourceName))
)
check(
  'env / theme 也不再被当成服务器',
  claudeParsed.items.length === 0,
  JSON.stringify(claudeParsed.items.map((i) => i.sourceName))
)
check('给出「未找到」提示', claudeParsed.warnings.length > 0, JSON.stringify(claudeParsed.warnings))

check(
  'type 不是已知传输名的对象不算服务器（type:"command"）',
  !/'type'/.test(parsersSource) || /KNOWN_TYPE_ALIASES/.test(parsersSource),
  'hasServerMarker 未限制 type'
)

// 反例保护：这些**必须**继续被识别，否则会把正常配置拒之门外
const stillValid = [
  ['无 type 的 stdio（只有 command）', JSON.stringify({ mcpServers: { s: { command: 'npx', args: ['-y', 'x'] } } })],
  ['显式 stdio type', JSON.stringify({ mcpServers: { s: { type: 'stdio', command: 'npx' } } })],
  ['裸映射（无 mcpServers 外层键）', JSON.stringify({ idea: { url: 'http://127.0.0.1:64342/stream', type: 'http' } })],
  ['single 形态（顶层就是一台）', JSON.stringify({ command: 'npx', args: ['-y', 'x'] })],
  ['cmd 别名', JSON.stringify({ mcpServers: { s: { cmd: 'npx' } } })],
  ['sse 传输', JSON.stringify({ mcpServers: { s: { type: 'sse', url: 'http://x/sse' } } })],
]
for (const [label, text] of stillValid) {
  const parsed = parseImportText(text, { format: 'json', maskSecrets: true })
  check(`仍能识别：${label}`, parsed.items.length >= 1, JSON.stringify(parsed.warnings))
}

console.log('\n== Windows 兼容 ==')

check(
  'probe 对 .cmd/.bat 走 cmd.exe（CVE-2024-27980 之后 Node 拒绝直接 spawn）',
  /cmd\|bat/i.test(probeSource) && /ComSpec/.test(probeSource),
  '未处理 .cmd'
)
check(
  '只在 win32 且命令是批处理时才加 shell 层',
  /process\.platform === 'win32'/.test(probeSource),
  '未按平台判断'
)
check('spawn 带 windowsHide（不弹控制台）', /windowsHide: true/.test(probeSource), '未设置 windowsHide')
check(
  '锁回收只在 ESRCH（进程确实不存在）时进行',
  /probeError\?\.code === 'ESRCH'/.test(indexSource),
  'Windows 上 EPERM 会被误当死锁回收，导致两个进程同时持锁'
)

// Windows 路径往返：反斜杠在 YAML 里必须原样保留
const winPaths = {
  command: 'C:\\Program Files\\nodejs\\npx.cmd',
  cwd: 'D:\\工作\\项目',
  envPath: 'C:\\Windows;C:\\tools',
}
const dumped = dumpEntryList([
  {
    id: 'mcp-win',
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'win',
      transport: 'stdio',
      command: winPaths.command,
      args: ['-y', 'pkg'],
      cwd: winPaths.cwd,
      env: { PATH: winPaths.envPath, NORMAL: 'plain' },
    },
  },
])
const roundTripped = parseEntryList(dumped)[0].config
check('Windows command 路径往返一致', roundTripped.command === winPaths.command, JSON.stringify(roundTripped.command))
check('Windows cwd（含中文）往返一致', roundTripped.cwd === winPaths.cwd, JSON.stringify(roundTripped.cwd))
check('Windows PATH 值往返一致', roundTripped.env.PATH === winPaths.envPath, JSON.stringify(roundTripped.env.PATH))
check('普通值不被引号污染', roundTripped.env.NORMAL === 'plain', JSON.stringify(roundTripped.env.NORMAL))

// CRLF：Windows 上编辑过的文件行尾是 \r\n，行级编辑器必须容错
const { scanInsertRows, removeInsertRows } = await import('./patchfile.js')
const crlfText = [
  '- insert:',
  '    - id: mcp-a',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: a',
  '',
  '- id: keep-me',
  '',
].join('\r\n')
const crlfScan = scanInsertRows(crlfText)
check('CRLF 文件能扫出 insert 行', crlfScan.blocks.length === 1 && crlfScan.blocks[0].rows.length === 1, JSON.stringify(crlfScan.blocks.length))
check('CRLF 行号/id 解析正确', crlfScan.blocks[0]?.rows[0]?.id === 'mcp-a', JSON.stringify(crlfScan.blocks[0]?.rows[0]))
const removed = removeInsertRows(crlfText, ['mcp-a'], () => true)
check('CRLF 文件能摘除目标行', removed.removed.includes('mcp-a') && !removed.text.includes('mcp-a'), JSON.stringify(removed.removed))
check('CRLF 摘除后不误伤其它行', removed.text.includes('keep-me'), removed.text)

console.log(`\n${checks - failures}/${checks} 通过`)
if (failures > 0) process.exitCode = 1
