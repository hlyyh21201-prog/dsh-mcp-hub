/**
 * patch 文件的行级手术工具。
 *
 * 背景：用户的 MCP 行可能住在别人的 loader patch 文件里
 * （例如 `$DSH_PROFILE_DIR/cordis.patch.yml`），形如
 *
 *     # 顶部注释，必须保留
 *     - insert:
 *         - id: mcp-idea
 *           name: '@deepseek-ai/dsh-mcp-client'
 *           config:
 *             serverName: idea
 *             ...
 *         - id: mcp-webstorm
 *           ...
 *     - id: agy-link
 *       disabled: true
 *
 * 「接管」这些行需要把它们从 patch 文件里摘掉。**不能用 YAML 解析后重新 dump**：
 * 那会重写整个文件、丢掉注释与原有排版，等于批量改动用户的配置。所以这里只做
 * 行级定位与删除，除被删的那几行外，文件其余部分逐字节不变。
 *
 * 删除范围：从 `    - id: <id>` 起，到下一个缩进 ≤ 4 的非空行为止。块内配置
 * （indent 6/8/10，例如 `args:` 的 `- '-y'`）缩进都 > 4，因此不会被误切。
 * 若某个 `- insert:` 里的行被删空，连 `- insert:` 一起删掉，避免留下空的 insert。
 */

/** patch 文件里一条可摘除的 insert 行（行尾允许 \r，兼容 CRLF）。 */
const INSERT_ROW_RE = /^ {4}- id:[ \t]*(\S+?)[ \t]*\r?$/
/** 顶层 patch 条目，例如 `- insert:` 或 `- id: xxx`。 */
const TOP_LEVEL_RE = /^-/
/** insert 块头（行尾允许 \r）。 */
const INSERT_HEAD_RE = /^- insert:[ \t]*\r?$/

/** 缩进宽度（空格数）；tab 按 8 计。 */
function indentOf(line) {
  let width = 0
  for (const char of line) {
    if (char === ' ') width += 1
    else if (char === '\t') width += 8
    else break
  }
  return width
}

/**
 * 扫描文本里所有 `- insert:` 下的 `- id:` 行。
 *
 * @param text - patch 文件全文。
 * @returns 每个 insert 行的位置信息，按出现顺序。
 */
export function scanInsertRows(text) {
  const lines = String(text).split('\n')
  const found = []
  /** 当前正在处理的 `- insert:` 块；null 表示不在块内。 */
  let current = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const indent = indentOf(line)
    const trimmed = line.trim()

    if (indent === 0 && trimmed !== '') {
      if (INSERT_HEAD_RE.test(line)) {
        current = { headIndex: index, rows: [] }
        continue
      }
      // 其它顶层条目标志着上一个 insert 块结束
      if (TOP_LEVEL_RE.test(line)) {
        if (current !== null) found.push(current)
        current = null
        continue
      }
    }

    if (current !== null && indent === 4) {
      const match = INSERT_ROW_RE.exec(line)
      if (match !== null) {
        if (current.rows.length > 0) {
          current.rows[current.rows.length - 1].end = index
        }
        current.rows.push({ id: match[1], start: index, end: lines.length })
      }
    }
  }

  if (current !== null) found.push(current)

  // 收尾：每个 insert 行只延伸到「下一个缩进 <= 4 的非空行」，之后再按块边界夹紧。
  // 关键：不能简单取 lines.length，否则最后一行会吞掉后面的顶层条目。
  for (let index = 0; index < found.length; index += 1) {
    const block = found[index]
    const nextHead = index + 1 < found.length ? found[index + 1].headIndex : lines.length
    block.end = nextHead
    for (let r = 0; r < block.rows.length; r += 1) {
      const row = block.rows[r]
      if (r + 1 < block.rows.length) {
        row.end = block.rows[r + 1].start
        continue
      }
      // 最后一行：找到块边界内第一个缩进 <= 4 的非空行
      let stop = nextHead
      for (let k = row.start + 1; k < nextHead; k += 1) {
        const text = lines[k]
        if (text.trim() !== '' && indentOf(text) <= 4) {
          stop = k
          break
        }
      }
      row.end = stop
    }
  }

  return { lines, blocks: found }
}

/**
 * 从 patch 文件文本中摘除指定 id 的行。
 *
 * @param text - patch 文件全文。
 * @param ids - 要摘除的 id 集合。
 * @param isOurRow - 可选校验：给定 id 与行文本，返回是否允许删除。
 *   「谁的 id 谁负责」——避免误删同名的非 MCP 行。
 * @returns 新文本与删除结果。
 */
export function removeInsertRows(text, ids, isOurRow) {
  const wanted = new Set(ids)
  if (wanted.size === 0) return { text, removed: [], skipped: [] }

  const { lines, blocks } = scanInsertRows(text)
  const removed = []
  const skipped = []
  /** 待删除的行下标（最后一次性重建文本）。 */
  const kill = new Set()
  /** 需要一并删除的 `- insert:` 头下标。 */
  const killHeads = new Set()

  for (const block of blocks) {
    let remainingInBlock = 0
    for (const row of block.rows) {
      if (!wanted.has(row.id)) {
        remainingInBlock += 1
        continue
      }
      const rowText = lines.slice(row.start, row.end).join('\n')
      if (isOurRow !== undefined && !isOurRow(row.id, rowText)) {
        skipped.push(row.id)
        remainingInBlock += 1
        continue
      }
      for (let index = row.start; index < row.end; index += 1) kill.add(index)
      removed.push(row.id)
    }
    if (remainingInBlock === 0 && removed.length > 0) killHeads.add(block.headIndex)
  }

  if (removed.length === 0) return { text, removed: [], skipped }

  for (const index of killHeads) kill.add(index)

  // 删除行后可能留下连续空行，压缩为单个空行，保持文件整洁
  const kept = []
  for (let index = 0; index < lines.length; index += 1) {
    if (kill.has(index)) continue
    const isBlank = lines[index].trim() === ''
    if (isBlank && kept.length > 0 && kept[kept.length - 1].trim() === '') {
      // 已有一个空行，跳过这一个
      continue
    }
    kept.push(lines[index])
  }

  let next = kept.join('\n')
  if (!next.endsWith('\n')) next += '\n'
  return { text: next, removed, skipped }
}

/** 该行文本看起来是不是一行 MCP client 条目（用于删除前校验）。 */
export function looksLikeMcpClientRow(rowText) {
  return rowText.includes('@deepseek-ai/dsh-mcp-client')
}
