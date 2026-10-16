/**
 * MCP 配置导入解析器（零依赖）。
 *
 * 支持四类来源格式：
 *   1. Codex  `~/.codex/config.toml`   —— `[mcp_servers.<name>]` / `[mcp_servers.<name>.env]`
 *   2. Claude/Cursor/桌面版 JSON       —— `{ "mcpServers": { ... } }`
 *   3. VS Code `.vscode/mcp.json`      —— `{ "servers": { ... } }`
 *   4. 裸 JSON                         —— 顶层对象即 server 映射，或单个 server 对象
 *
 * 每个 server 归一化为 dsh-mcp-client 的 Config 形状：
 *   { serverName, transport: 'stdio' | 'streamable-http', command?, args?, env?, cwd?,
 *     url?, headers?, toolCallTimeoutMs?, failOnStartupError? }
 *
 * 解析器不做副作用、不读文件，输入文本 → 输出 { servers, warnings }。
 */

/** serverName 受限字符集（与 dsh-mcp-client 的 Config pattern 一致）。 */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

/** 导入时用于标记「原值被隐藏、需要用户补填」的占位符。 */
export const SECRET_PLACEHOLDER = '__DSH_MCP_HUB_SET_ME__'

/** 判断一个字符串是否是本插件写入的占位符。 */
export function isSecretPlaceholder(value) {
  return value === SECRET_PLACEHOLDER
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value) {
  return typeof value === 'string' ? value : undefined
}

function isRecordOfStrings(value) {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
}

// ---------------------------------------------------------------------------
// TOML（覆盖 Codex config.toml 所需子集）
// ---------------------------------------------------------------------------

/**
 * 极简 TOML 解析器，只覆盖 MCP 配置常见写法：
 * 段头 `[a.b]`、`key = value`、字符串（基本/字面/多行）、数字、布尔、数组、行内表。
 * 不支持日期、多文档、点号键（`a.b = 1`）等冷门特性——遇到就跳过并记 warning。
 *
 * @param {string} text 原始 TOML 文本
 * @returns {{ tables: Map<string, Map<string, unknown>>, warnings: string[] }}
 */
export function parseToml(text) {
  const tables = new Map()
  const warnings = []
  const lines = text.split(/\r?\n/)

  let current = null
  const ensure = (name) => {
    if (!tables.has(name)) tables.set(name, new Map())
    return tables.get(name)
  }

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const line = stripComment(raw).trim()
    if (line === '') continue

    // 段头
    if (line.startsWith('[')) {
      const isArrayTable = line.startsWith('[[')
      const inner = line.replace(/^\[\[?/, '').replace(/\]\]?$/, '').trim()
      if (isArrayTable) {
        warnings.push(`忽略数组表 [[${inner}]]（MCP 导入不需要）`)
        current = null
        continue
      }
      const path = parseDottedKey(inner)
      if (path === null) {
        warnings.push(`无法解析段头：${line}`)
        current = null
        continue
      }
      current = ensure(path.join('.'))
      continue
    }

    // 键值对
    const eq = findTopLevelEquals(line)
    if (eq < 0) {
      warnings.push(`跳过无法解析的行：${line}`)
      continue
    }
    const keyRaw = line.slice(0, eq).trim()
    let valueRaw = line.slice(eq + 1).trim()
    // 段头之前的顶层键（model、network_access 等）与 MCP 无关，静默忽略
    if (current === null) continue
    const key = parseKeySegment(keyRaw)
    if (key === null) {
      warnings.push(`跳过非法键：${keyRaw}`)
      continue
    }

    // 跨行值（数组 / 多行字符串）
    let consumed = i
    while (!isValueComplete(valueRaw) && consumed + 1 < lines.length) {
      consumed += 1
      valueRaw += `\n${stripComment(lines[consumed]).trim()}`
    }
    i = consumed

    const parsed = parseTomlValue(valueRaw)
    if (!parsed.ok) {
      warnings.push(`键 ${key} 的值无法解析：${parsed.error}`)
      continue
    }
    current.set(key, parsed.value)
  }

  return { tables, warnings }
}

function stripComment(line) {
  let inBasic = false
  let inLiteral = false
  let inMultiBasic = false
  let inMultiLiteral = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    const triple = line.slice(i, i + 3)
    if (inMultiBasic) {
      if (triple === '"""') {
        inMultiBasic = false
        i += 2
      } else if (ch === '\\') i += 1
      continue
    }
    if (inMultiLiteral) {
      if (triple === "'''") {
        inMultiLiteral = false
        i += 2
      }
      continue
    }
    if (inBasic) {
      if (ch === '\\') i += 1
      else if (ch === '"') inBasic = false
      continue
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false
      continue
    }
    if (triple === '"""') {
      inMultiBasic = true
      i += 2
      continue
    }
    if (triple === "'''") {
      inMultiLiteral = true
      i += 2
      continue
    }
    if (ch === '"') inBasic = true
    else if (ch === "'") inLiteral = true
    else if (ch === '#') return line.slice(0, i)
  }
  return line
}

/** 值是否在语法上已闭合（用于决定是否需要继续读取下一行）。 */
function isValueComplete(text) {
  const trimmed = text.trim()
  if (trimmed === '') return false
  if (trimmed.startsWith('"""')) return trimmed.length >= 6 && trimmed.endsWith('"""')
  if (trimmed.startsWith("'''")) return trimmed.length >= 6 && trimmed.endsWith("'''")
  if (trimmed.startsWith('[')) return bracketBalance(trimmed) <= 0
  if (trimmed.startsWith('{')) return bracketBalance(trimmed) <= 0
  return true
}

function bracketBalance(text) {
  let depth = 0
  let inBasic = false
  let inLiteral = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inBasic) {
      if (ch === '\\') i += 1
      else if (ch === '"') inBasic = false
      continue
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false
      continue
    }
    if (ch === '"') inBasic = true
    else if (ch === "'") inLiteral = true
    else if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') depth -= 1
  }
  return depth
}

/** 找到最外层（不在字符串/括号内）的 `=`。 */
function findTopLevelEquals(line) {
  let inBasic = false
  let inLiteral = false
  let depth = 0
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (inBasic) {
      if (ch === '\\') i += 1
      else if (ch === '"') inBasic = false
      continue
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false
      continue
    }
    if (ch === '"') inBasic = true
    else if (ch === "'") inLiteral = true
    else if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') depth -= 1
    else if (ch === '=' && depth === 0) return i
  }
  return -1
}

/** 解析 `a.b.c` 形式（可带引号）的键路径。 */
function parseDottedKey(text) {
  const parts = splitTopLevel(text, '.')
  const out = []
  for (const part of parts) {
    const key = parseKeySegment(part)
    if (key === null) return null
    out.push(key)
  }
  return out.length > 0 ? out : null
}

function parseKeySegment(text) {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1)
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1)
  }
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null
}

/** 按顶层分隔符切分（跳过字符串与括号内部）。 */
function splitTopLevel(text, sep) {
  const parts = []
  let buffer = ''
  let inBasic = false
  let inLiteral = false
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inBasic) {
      buffer += ch
      if (ch === '\\') {
        buffer += text[i + 1] ?? ''
        i += 1
      } else if (ch === '"') inBasic = false
      continue
    }
    if (inLiteral) {
      buffer += ch
      if (ch === "'") inLiteral = false
      continue
    }
    if (ch === '"') {
      inBasic = true
      buffer += ch
      continue
    }
    if (ch === "'") {
      inLiteral = true
      buffer += ch
      continue
    }
    if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') depth -= 1
    if (ch === sep && depth === 0) {
      parts.push(buffer)
      buffer = ''
      continue
    }
    buffer += ch
  }
  parts.push(buffer)
  return parts
}

/** 解析一个 TOML 值。 */
function parseTomlValue(text) {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, error: '空值' }

  // 多行字符串
  if (trimmed.startsWith('"""') && trimmed.endsWith('"""') && trimmed.length >= 6) {
    return { ok: true, value: unescapeBasic(trimmed.slice(3, -3)) }
  }
  if (trimmed.startsWith("'''") && trimmed.endsWith("'''") && trimmed.length >= 6) {
    return { ok: true, value: trimmed.slice(3, -3) }
  }
  // 基本字符串
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return { ok: true, value: unescapeBasic(trimmed.slice(1, -1)) }
  }
  // 字面字符串
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return { ok: true, value: trimmed.slice(1, -1) }
  }
  // 数组
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()
    if (inner === '') return { ok: true, value: [] }
    const items = splitTopLevel(inner, ',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
    const out = []
    for (const item of items) {
      const parsed = parseTomlValue(item)
      if (!parsed.ok) return parsed
      out.push(parsed.value)
    }
    return { ok: true, value: out }
  }
  // 行内表
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1).trim()
    const out = {}
    if (inner === '') return { ok: true, value: out }
    for (const pair of splitTopLevel(inner, ',')) {
      const eq = findTopLevelEquals(pair)
      if (eq < 0) continue
      const key = parseKeySegment(pair.slice(0, eq))
      if (key === null) continue
      const parsed = parseTomlValue(pair.slice(eq + 1))
      if (!parsed.ok) return parsed
      out[key] = parsed.value
    }
    return { ok: true, value: out }
  }
  // 布尔
  if (trimmed === 'true') return { ok: true, value: true }
  if (trimmed === 'false') return { ok: true, value: false }
  // 数字
  if (/^[+-]?\d+$/.test(trimmed)) return { ok: true, value: Number(trimmed) }
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(trimmed)) return { ok: true, value: Number(trimmed) }

  return { ok: false, error: trimmed.slice(0, 40) }
}

function unescapeBasic(text) {
  return text.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (match, esc) => {
    switch (esc[0]) {
      case 'n': return '\n'
      case 't': return '\t'
      case 'r': return '\r'
      case '"': return '"'
      case '\\': return '\\'
      case 'b': return '\b'
      case 'f': return '\f'
      case 'u':
      case 'U': {
        const code = Number.parseInt(esc.slice(1), 16)
        return Number.isFinite(code) ? String.fromCodePoint(code) : match
      }
      default: return esc
    }
  })
}

/**
 * 从 Codex TOML 中提取 `mcp_servers` 下的服务器定义。
 * @param {string} text TOML 文本
 * @returns {{ servers: object[], warnings: string[] }}
 */
export function parseCodexToml(text) {
  const { tables, warnings } = parseToml(text)
  const found = []
  const names = new Set()

  for (const tableName of tables.keys()) {
    const parts = tableName.split('.')
    if (parts[0] !== 'mcp_servers' || parts.length < 2) continue
    names.add(parts[1])
  }

  for (const name of names) {
    const base = tables.get(`mcp_servers.${name}`) ?? new Map()
    const env = tables.get(`mcp_servers.${name}.env`) ?? new Map()
    const headers = tables.get(`mcp_servers.${name}.headers`) ?? new Map()

    const raw = {}
    for (const [key, value] of base) raw[key] = value
    if (env.size > 0) raw.env = Object.fromEntries(env)
    if (headers.size > 0) raw.headers = Object.fromEntries(headers)
    found.push({ name, raw })
  }

  if (found.length === 0) {
    warnings.push('未在 TOML 中找到 [mcp_servers.<name>] 段')
  }
  return { servers: found, warnings }
}

// ---------------------------------------------------------------------------
// JSON（各客户端变体）
// ---------------------------------------------------------------------------

const SERVER_MAP_KEYS = ['mcpServers', 'servers', 'mcp', 'mcp_servers']

/**
 * 从 JSON 文本中提取服务器定义，兼容多种包裹形式。
 * @param {string} text JSON 文本
 * @returns {{ servers: object[], warnings: string[] }}
 */
export function parseJsonConfig(text) {
  let data
  try {
    data = JSON.parse(stripJsonComments(text))
  } catch (error) {
    // VS Code 的 mcp.json 允许注释与尾逗号，先做一次宽松修复
    try {
      data = JSON.parse(relaxJson(text))
    } catch {
      throw new Error(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return extractFromJson(data)
}

function extractFromJson(data) {
  const warnings = []
  const collected = []

  const pushMap = (map, label) => {
    for (const [name, value] of Object.entries(map)) collected.push({ name, raw: value, label })
  }

  if (Array.isArray(data)) {
    // 数组：元素可以是单个 server 或 {name, ...}
    data.forEach((item, index) => {
      if (!isRecord(item)) return
      const name = asString(item.name) ?? asString(item.serverName) ?? `server-${index + 1}`
      collected.push({ name, raw: item, label: 'array' })
    })
  } else if (isRecord(data)) {
    let matched = false
    for (const key of SERVER_MAP_KEYS) {
      const value = data[key]
      if (isRecord(value) && looksLikeServerMap(value)) {
        pushMap(value, key)
        matched = true
        break
      }
      // { "mcp": { "servers": {...} } }
      if (key === 'mcp' && isRecord(value) && isRecord(value.servers)) {
        pushMap(value.servers, 'mcp.servers')
        matched = true
        break
      }
    }
    if (!matched) {
      if (looksLikeSingleServer(data)) {
        const name = asString(data.name) ?? asString(data.serverName) ?? 'imported'
        collected.push({ name, raw: data, label: 'single' })
      } else if (looksLikeUnambiguousServerMap(data)) {
        // 裸映射（没有 mcpServers 外层键）。用严格版判定：每一项都得像服务器，
        // 否则会把 settings 文件里的 env / theme 当成服务器导进来。
        pushMap(data, 'top-level')
      } else {
        warnings.push('JSON 中未找到 MCP 服务器定义（期望 mcpServers / servers，或顶层为服务器映射）')
      }
    }
    // ~/.claude.json 的项目级服务器在 projects["<路径>"].mcpServers 里，
    // 顶层那个 mcpServers 只管用户级。两者都要取，否则会漏掉项目配置。
    collected.push(...extractProjectServers(data))
  } else {
    warnings.push('JSON 顶层必须是对象或数组')
  }

  return { servers: collected, warnings }
}

/** 值看起来像「一个 server 配置」而不是「name → server 的映射」。 */
function looksLikeSingleServer(value) {
  return hasServerMarker(value)
}

function looksLikeServerMap(value) {
  const entries = Object.entries(value)
  if (entries.length === 0) return true
  return entries.some(([, item]) => isRecord(item) && hasServerMarker(item))
}

/**
 * 抽取 `~/.claude.json` 里**按项目分组**的服务器。
 *
 * 这个文件有两层 mcpServers：
 *   - 顶层的 `mcpServers` —— 用户级服务器（Claude 面板里叫 "User MCPs"）；
 *   - `projects["<路径>"].mcpServers` —— 该目录下的项目级服务器
 *     （面板里叫 "Project MCPs"）。
 *
 * 只取顶层会漏掉项目级那些。这里把它们一并取出，并用 `项目名/服务器名`
 * 作为 label，这样面板上能看出它来自哪个项目；同名服务器仍按正常规则
 * 走重名检测，不会被静默合并。
 */
function extractProjectServers(data) {
  const collected = []
  const projects = data?.projects
  if (!isRecord(projects)) return collected
  for (const [projectPath, projectValue] of Object.entries(projects)) {
    if (!isRecord(projectValue)) continue
    const map = projectValue.mcpServers
    if (!isRecord(map)) continue
    for (const [name, raw] of Object.entries(map)) {
      if (!isRecord(raw)) continue
      // 只用目录名做 label，完整路径太长会把行撑爆
      const short = String(projectPath).split(/[\\/]/).filter(Boolean).pop() ?? projectPath
      collected.push({ name, raw, label: `项目 ${short}` })
    }
  }
  return collected
}

/**
 * 只把已知的 MCP 传输名当作服务器标志。
 *
 * 不能简单地「有 type 就算」：Claude 的 settings.json 里有
 * `statusLine: { type: "command", command: "~/.claude/statusline.sh" }`，
 * 它的 type 是 "command"（不是任何 MCP 传输），却因为带 type 和 command
 * 被误判成一台 stdio 服务器。注意 `command` 本身仍是有效标志 —— 不带显式
 * type 的 stdio 配置（`{"command":"npx","args":[...]}`）必须继续被接受。
 */
const KNOWN_TYPE_ALIASES = new Set([
  'http',
  'remote',
  'streamable-http',
  'streamablehttp',
  'stream',
  'sse',
  'stdio',
  'local',
  'process',
])

function hasServerMarker(record) {
  if (!isRecord(record)) return false
  const nonEmpty = (v) => typeof v === 'string' && v.trim() !== ''
  return (
    nonEmpty(record.url) ||
    nonEmpty(record.serverUrl) ||
    nonEmpty(record.command) ||
    nonEmpty(record.cmd) ||
    (typeof record.type === 'string' && KNOWN_TYPE_ALIASES.has(record.type.trim().toLowerCase()))
  )
}

/**
 * 顶层裸映射（`{"idea":{"url":...}}` 这种没有 mcpServers 外层键的写法）。
 *
 * 这里必须比 `looksLikeServerMap` 严格：**每一项**都得是像服务器的对象。
 * 否则 `.claude/settings.json`（`{env, statusLine, modelSettings, theme}`）
 * 会被整体当成服务器映射，导出 `env`、`theme` 这些假服务器。
 * 真正的裸映射里不会混进字符串或设置对象，所以「全部项都像服务器」这个
 * 条件既安全又足以排除设置文件。
 */
function looksLikeUnambiguousServerMap(value) {
  const entries = Object.entries(value)
  if (entries.length === 0) return false
  return entries.every(([, item]) => isRecord(item) && hasServerMarker(item))
}

function stripJsonComments(text) {
  // 只在明显含注释时走修复路径；其余交给 JSON.parse 给出精确错误
  return text
}

function relaxJson(text) {
  const withoutBlock = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const lines = withoutBlock.split(/\r?\n/).map((line) => {
    let inString = false
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]
      if (inString) {
        if (ch === '\\') i += 1
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '/' && line[i + 1] === '/') return line.slice(0, i)
    }
    return line
  })
  return lines.join('\n').replace(/,\s*([}\]])/g, '$1')
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

/** 各种客户端里表示「远程」的类型别名。 */
const HTTP_TYPE_ALIASES = new Set(['http', 'remote', 'streamable-http', 'streamablehttp', 'stream'])
const STDIO_TYPE_ALIASES = new Set(['stdio', 'local', 'process'])

/**
 * 把任意来源的 server 原始对象归一化为 dsh-mcp-client 的 config。
 *
 * @param {string} name 导入名（作为 serverName 的来源）
 * @param {unknown} raw 原始配置对象
 * @param {{ maskSecrets?: boolean }} options maskSecrets 为真时隐藏敏感值
 * @returns {{ config?: object, error?: string, maskedKeys?: string[] }}
 */
export function normalizeServer(name, raw, options = {}) {
  const maskSecrets = options.maskSecrets !== false
  if (!isRecord(raw)) return { error: '配置不是对象' }

  const typeRaw = (asString(raw.type) ?? asString(raw.transport) ?? '').toLowerCase()
  const url =
    asString(raw.url) ??
    asString(raw.serverUrl) ??
    asString(raw.endpoint) ??
    asString(raw.httpUrl)
  const command = asString(raw.command) ?? asString(raw.cmd)
  const args = toStringArray(raw.args ?? raw.arguments)
  const cwd = asString(raw.cwd) ?? asString(raw.workingDirectory)
  const env = toEnvRecord(raw.env ?? raw.environment)
  const headers = toStringRecord(raw.headers ?? raw.httpHeaders)
  // startup_timeout_sec 以秒计，dsh-mcp-client 的 toolCallTimeoutMs 以毫秒计
  const timeoutMs = toPositiveNumber(raw.toolCallTimeoutMs ?? raw.tool_call_timeout_ms)
  const timeoutSec = toPositiveNumber(raw.startup_timeout_sec ?? raw.startupTimeoutSec)
  const timeout = timeoutMs ?? (timeoutSec !== undefined ? timeoutSec * 1000 : undefined)
  const failOnStartupError = typeof raw.failOnStartupError === 'boolean' ? raw.failOnStartupError : undefined
  const disabled = raw.disabled === true || raw.enabled === false

  let transport
  if (STDIO_TYPE_ALIASES.has(typeRaw)) transport = 'stdio'
  else if (HTTP_TYPE_ALIASES.has(typeRaw)) transport = 'streamable-http'
  else if (command !== undefined) transport = 'stdio'
  else if (url !== undefined) transport = 'streamable-http'
  else return { error: '既没有 command 也没有 url，无法判定传输方式' }

  if (transport === 'stdio' && (command === undefined || command.trim() === '')) {
    return { error: 'stdio 传输缺少 command' }
  }
  if (transport === 'streamable-http' && (url === undefined || !/^https?:\/\//.test(url))) {
    return { error: '远程传输缺少合法的 http(s) URL' }
  }

  const maskedKeys = []
  const maskRecord = (record) => {
    if (record === undefined) return undefined
    const out = {}
    for (const [key, value] of Object.entries(record)) {
      if (maskSecrets && isSensitiveKey(key)) {
        out[key] = SECRET_PLACEHOLDER
        maskedKeys.push(key)
      } else out[key] = value
    }
    return out
  }

  const config = {
    serverName: sanitizeServerName(name),
    transport,
  }
  const warnings = []
  if (transport === 'stdio') {
    config.command = command
    if (args !== undefined && args.length > 0) config.args = args
    const maskedEnv = maskRecord(env)
    if (maskedEnv !== undefined && Object.keys(maskedEnv).length > 0) config.env = maskedEnv
    if (cwd !== undefined && cwd !== '') config.cwd = cwd
    if (headers !== undefined && Object.keys(headers).length > 0) {
      // dsh-mcp-client 的 stdio 分支只读 command/args/env/cwd，headers 无处安放。
      warnings.push(`${name}：stdio 传输不支持 headers，已忽略（如需鉴权请改写成环境变量）`)
    }
  } else {
    config.url = url
    const maskedHeaders = maskRecord(headers)
    if (maskedHeaders !== undefined && Object.keys(maskedHeaders).length > 0) config.headers = maskedHeaders
    if (env !== undefined && Object.keys(env).length > 0) {
      // dsh-mcp-client 的 streamable-http 分支只读 url/headers，没有 env 字段。
      // 静默丢弃会让用户误以为密码已经带过去，这里必须显式告知。
      const names = Object.keys(env)
      for (const key of names) {
        if (isSensitiveKey(key)) maskedKeys.push(key)
      }
      warnings.push(
        `${name}：远程传输（streamable-http）不支持 env，已忽略这些键：${names.join('、')}；` +
          `如需鉴权请改写成 HTTP headers（例如 Authorization）`
      )
    }
  }
  if (timeout !== undefined) config.toolCallTimeoutMs = timeout
  if (failOnStartupError !== undefined) config.failOnStartupError = failOnStartupError

  return { config, maskedKeys, disabled, warnings }
}

/** 敏感键判定：只按名字，不看值（导入时无需理解值的语义）。 */
function isSensitiveKey(key) {
  return /pass|secret|token|key|credential|auth|apikey|api_key/i.test(key)
}

function toStringArray(value) {
  if (!Array.isArray(value)) return undefined
  const out = value.map((item) => (typeof item === 'string' ? item : String(item)))
  return out
}

function toEnvRecord(value) {
  if (!isRecord(value)) return undefined
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item
    else if (typeof item === 'number' || typeof item === 'boolean') out[key] = String(item)
  }
  return out
}

function toStringRecord(value) {
  if (!isRecord(value)) return undefined
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item
  }
  return out
}

function toPositiveNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value)
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}

/** 把任意名字清洗成 serverName 允许的字符集。 */
export function sanitizeServerName(name) {
  const cleaned = String(name ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return SERVER_NAME_RE.test(cleaned) ? cleaned : 'server'
}

/**
 * 统一入口：按内容自动判定格式并解析。
 *
 * @param {string} text 文本内容
 * @param {{ format?: string, sourceName?: string, maskSecrets?: boolean }} options
 * @returns {{ items: object[], warnings: string[], format: string }}
 */
export function parseImportText(text, options = {}) {
  const trimmed = text.trim()
  if (trimmed === '') return { items: [], warnings: ['内容为空'], format: 'empty' }

  const format =
    typeof options.format === 'string' && options.format !== '' && options.format !== 'auto'
      ? options.format
      : detectFormat(trimmed, options.sourceName)
  let parsed
  if (format === 'toml') parsed = parseCodexToml(text)
  else parsed = parseJsonConfig(text)

  const items = []
  const warnings = [...parsed.warnings]
  const seen = new Set()

  for (const entry of parsed.servers) {
    const normalized = normalizeServer(entry.name, entry.raw, { maskSecrets: options.maskSecrets })
    if (normalized.error !== undefined) {
      warnings.push(`跳过 ${entry.name}：${normalized.error}`)
      continue
    }
    // 逐条服务器的告警（例如远程传输不支持 env）也要冒泡给用户，
    // 否则「被忽略的字段」就是静默丢失。
    for (const warning of normalized.warnings ?? []) warnings.push(warning)
    let name = normalized.config.serverName
    if (seen.has(name)) {
      warnings.push(`名称重复，已重命名：${entry.name}`)
      let index = 2
      while (seen.has(`${name}-${index}`)) index += 1
      name = sanitizeServerName(`${name}-${index}`)
      normalized.config.serverName = name
    }
    seen.add(name)
    items.push({
      sourceName: entry.name,
      label: entry.label,
      config: normalized.config,
      maskedKeys: normalized.maskedKeys ?? [],
      disabled: normalized.disabled === true,
    })
  }

  return { items, warnings, format }
}

/** 依据文件名与内容特征判定格式。 */
export function detectFormat(text, sourceName) {
  const lower = String(sourceName ?? '').toLowerCase()
  if (lower.endsWith('.toml')) return 'toml'
  if (lower.endsWith('.json') || lower.endsWith('.jsonc')) return 'json'

  const trimmed = text.trim()

  // TOML 的段头 `[name]` / `[a.b]` / `[[a]]` 也以 `[` 开头，必须先于 JSON 判定。
  // 判据：方括号内是「键路径」而非 JSON 数组的起始。
  if (/^\[\s*[A-Za-z0-9_.'"-]+\s*\]/.test(trimmed)) return 'toml'
  if (/^\[\[/.test(trimmed)) return 'toml'
  if (/^\s*\[mcp_servers/m.test(text)) return 'toml'

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'

  // 形如 `key = value` 的散键 + 段头 → TOML
  if (/^\s*[A-Za-z0-9_.-]+\s*=/m.test(text)) return 'toml'
  return 'json'
}
