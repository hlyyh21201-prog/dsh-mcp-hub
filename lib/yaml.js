/**
 * 极简 YAML 读写，专供本插件的 loader 条目列表使用（零依赖）。
 *
 * 支持 Cordis 条目列表所需的子集：
 *   - 顶层数组
 *   - 映射 / 嵌套映射 / 字符串数组
 *   - 字符串（按需加引号）、数字、布尔、null
 *   - `!!js` 表达式标量（写成 `!!js <expr>`，读回为 { __jsExpr: expr }）
 *   - 注释与空行（读取时跳过）
 *
 * 不支持锚点、多行块标量、流式集合等——本插件的配置文件不需要。
 */

/** 把 JS 值序列化为 YAML 文本。 */
export function dumpEntryList(rows) {
  if (!Array.isArray(rows)) throw new Error('dumpEntryList 需要数组')
  if (rows.length === 0) return '[]\n'
  const lines = []
  for (const row of rows) {
    lines.push('- ' + dumpMap(row, 0, true))
  }
  return lines.join('\n') + '\n'
}

function dumpMap(value, indent, inline) {
  const keys = Object.keys(value)
  if (keys.length === 0) return '{}'
  const pad = ' '.repeat(indent + 2)
  const parts = []
  for (const key of keys) {
    const item = value[key]
    const rendered = dumpValue(item, indent + 2)
    parts.push(`${key}: ${rendered}`)
  }
  if (inline) return parts.join('\n' + pad)
  return parts.join('\n' + pad)
}

function dumpValue(value, indent) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return dumpScalar(value)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return dumpSequence(value, indent)
  if (typeof value === 'object') {
    if (typeof value.__jsExpr === 'string') return `!!js ${value.__jsExpr}`
    const keys = Object.keys(value)
    if (keys.length === 0) return '{}'
    const pad = ' '.repeat(indent + 2)
    const body = keys
      .map((key) => `${key}: ${dumpValue(value[key], indent + 2)}`)
      .join('\n' + pad)
    return '\n' + pad + body
  }
  return dumpScalar(String(value))
}

function dumpSequence(items, indent) {
  if (items.length === 0) return '[]'
  const pad = ' '.repeat(indent + 2)
  const body = items
    .map((item) => {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        return dumpMap(item, indent + 2, true)
      }
      return dumpValue(item, indent + 2)
    })
    .join('\n' + pad + '- ')
  return '\n' + pad + '- ' + body
}

/** 按需给字符串加引号，保证 round-trip 安全。 */
function dumpScalar(value) {
  if (value === '') return "''"
  // 需要引号的情形：看起来像数字/布尔/null、含特殊字符、首尾空格、以特殊记号开头
  const needsQuote =
    /^[\s]|[\s]$/.test(value) ||
    /[:#\-?,[\]{}&*!|>'"%@`]/.test(value) ||
    /^(true|false|null|~|yes|no|on|off)$/i.test(value) ||
    /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)
  if (!needsQuote) return value
  return `'${value.replace(/'/g, "''")}'`
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/** 解析条目列表 YAML 文本。 */
export function parseEntryList(text) {
  const lines = text.split(/\r?\n/)
  const { value } = parseNode(lines, 0, 0, true)
  return value
}

function skipIgnorable(lines, index) {
  let i = index
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i += 1
      continue
    }
    break
  }
  return i
}

function indentOf(line) {
  const match = /^(\s*)/.exec(line)
  return match === null ? 0 : match[1].length
}

/**
 * 解析一个节点（序列或映射），返回 { value, next }。
 * @param {boolean} topLevel 是否顶层（顶层必须是序列）
 */
function parseNode(lines, index, indent, topLevel) {
  const start = skipIgnorable(lines, index)
  if (start >= lines.length) return { value: topLevel ? [] : null, next: start }
  const line = lines[start]
  const trimmed = line.trim()

  if (trimmed === '[]') return { value: [], next: start + 1 }
  if (trimmed === '{}') return { value: {}, next: start + 1 }

  if (trimmed.startsWith('- ') || trimmed === '-') {
    return parseSequence(lines, start, indentOf(line))
  }
  if (topLevel) {
    // 顶层不是序列：交给调用方报错
    return { value: null, next: start + 1 }
  }
  return parseMapping(lines, start, indent)
}

function parseSequence(lines, index, indent) {
  const out = []
  let i = index
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i += 1
      continue
    }
    const lineIndent = indentOf(line)
    if (lineIndent < indent) break
    if (lineIndent > indent) break
    const trimmed = line.trim()
    if (!trimmed.startsWith('- ') && trimmed !== '-') break

    const rest = trimmed === '-' ? '' : trimmed.slice(2)
    if (rest === '') {
      const nested = parseNode(lines, i + 1, indent + 2, false)
      out.push(nested.value)
      i = nested.next
      continue
    }
    // 行内起始的映射：`- id: foo`
    if (looksLikeMappingEntry(rest)) {
      const rewritten = rewriteInlineMapping(lines, i, indent)
      const nested = parseMapping(rewritten.lines, rewritten.index, indent + 2)
      out.push(nested.value)
      i = nested.next
      continue
    }
    out.push(parseScalar(rest))
    i += 1
  }
  return { value: out, next: i }
}

function looksLikeMappingEntry(text) {
  return /^[A-Za-z0-9_.$@'"][^:]*:(\s|$)/.test(text) || /^!!js\s/.test(text) === false && /^[^:]+:\s/.test(text)
}

/**
 * 把 `- key: value` 展开成两行虚拟文本，让映射解析器统一处理。
 * 后续同缩进层级的行原样保留。
 */
function rewriteInlineMapping(lines, index, indent) {
  const original = lines[index]
  const trimmed = original.trim()
  const rest = trimmed.slice(2)
  const cloned = lines.slice()
  cloned[index] = ' '.repeat(indent + 2) + rest
  return { lines: cloned, index }
}

function parseMapping(lines, index, indent) {
  const out = {}
  let i = index
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i += 1
      continue
    }
    const lineIndent = indentOf(line)
    if (lineIndent < indent) break
    if (lineIndent > indent) {
      i += 1
      continue
    }
    const trimmed = line.trim()
    if (trimmed.startsWith('- ')) break

    const colon = findKeyColon(trimmed)
    if (colon < 0) {
      i += 1
      continue
    }
    const key = unquote(trimmed.slice(0, colon).trim())
    const rest = trimmed.slice(colon + 1).trim()

    if (rest === '') {
      const nested = parseNode(lines, i + 1, indent + 2, false)
      if (nested.value === null && i + 1 < lines.length) {
        out[key] = null
        i += 1
        continue
      }
      out[key] = nested.value
      i = nested.next
      continue
    }
    out[key] = parseScalar(rest)
    i += 1
  }
  return { value: out, next: i }
}

/** 找到键值分隔冒号（跳过引号内与 URL 中的冒号）。 */
function findKeyColon(text) {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inSingle) {
      if (ch === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (ch === '\\') i += 1
      else if (ch === '"') inDouble = false
      continue
    }
    if (ch === "'") inSingle = true
    else if (ch === '"') inDouble = true
    else if (ch === ':' && (i + 1 >= text.length || text[i + 1] === ' ' || text[i + 1] === '\t')) return i
  }
  return -1
}

/** 解析标量：`!!js expr`、引号字符串、数字、布尔、null。 */
function parseScalar(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('!!js ')) return { __jsExpr: trimmed.slice(5).trim() }
  if (trimmed === '!!js') return { __jsExpr: '' }
  if (trimmed === 'null' || trimmed === '~' || trimmed === '') return null
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === '[]') return []
  if (trimmed === '{}') return {}
  if (/^[+-]?\d+$/.test(trimmed)) return Number(trimmed)
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed)
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function unquote(text) {
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text)
    } catch {
      return text.slice(1, -1)
    }
  }
  return text
}
