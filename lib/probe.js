/**
 * 轻量 MCP 连接探测（零第三方依赖）。
 *
 * 只用 Node 内置能力完成一次最小 MCP 握手：
 *   initialize → notifications/initialized → tools/list
 *
 * - `streamable-http`：用全局 `fetch`，同时兼容 JSON 与 SSE 两种响应体。
 * - `stdio`：用 `node:child_process` 起子进程，按行读写 JSON-RPC。
 *
 * 探测是只读的：不写任何文件，进程/连接在结束时关闭。
 */

import { spawn } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 8000
const PROTOCOL_VERSION = '2025-06-18'

/**
 * 探测一台 MCP 服务器。
 *
 * @param {object} config { transport, url, headers, command, args, env, cwd }
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, toolCount?: number, serverName?: string, latencyMs: number, error?: string }>}
 */
export async function probeServer(config, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const started = Date.now()
  const finish = (result) => ({ ...result, latencyMs: Date.now() - started })
  try {
    const outcome =
      config.transport === 'stdio'
        ? await probeStdio(config, timeoutMs)
        : await probeHttp(config, timeoutMs)
    return finish(outcome)
  } catch (error) {
    return finish({ ok: false, error: describeNetworkError(error, config) })
  }
}

/** 把 fetch 的 `TypeError: fetch failed` 还原成可读根因。 */
function describeNetworkError(error, config) {
  const base = error instanceof Error ? error.message : String(error)
  if (error instanceof Error && error.name === 'AbortError') {
    return `连接超时（${config.url ?? ''}）`
  }
  if (error instanceof Error && error.cause instanceof Error) {
    const codes = [error.cause, error.cause.cause].filter(Boolean).map((item) => item.code ?? item.message)
    const detail = codes.filter((item) => typeof item === 'string').join(' / ')
    if (detail !== '') {
      const hint = detail.includes('ECONNREFUSED')
        ? '（目标端口没有在监听）'
        : detail.includes('ENOTFOUND')
          ? '（域名解析失败）'
          : ''
      return `无法连接 ${config.url ?? ''}：${detail}${hint}`
    }
  }
  return base
}

// ---------------------------------------------------------------------------
// streamable-http
// ---------------------------------------------------------------------------

async function probeHttp(config, timeoutMs) {
  if (typeof config.url !== 'string' || config.url === '') {
    return { ok: false, error: '缺少 URL' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let sessionId

  const post = async (message) => {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(config.headers ?? {}),
    }
    if (sessionId !== undefined) headers['mcp-session-id'] = sessionId
    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal: controller.signal,
    })
    const returnedSession = response.headers.get('mcp-session-id')
    if (returnedSession !== null && returnedSession !== '') sessionId = returnedSession
    if (!response.ok) {
      const text = await safeText(response)
      throw new Error(`HTTP ${response.status}${text === '' ? '' : `: ${text.slice(0, 200)}`}`)
    }
    const contentType = response.headers.get('content-type') ?? ''
    const body = await safeText(response)
    if (body.trim() === '') return undefined
    if (contentType.includes('text/event-stream')) return readSseResult(body, message.id)
    try {
      return JSON.parse(body)
    } catch {
      // 有些实现在 SSE 头缺失时仍返回事件流
      const fromSse = readSseResult(body, message.id)
      if (fromSse !== undefined) return fromSse
      throw new Error('响应不是合法 JSON')
    }
  }

  try {
    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-mcp-hub', version: '1.0.0' },
      },
    })
    assertNoError(init, 'initialize')

    await post({ jsonrpc: '2.0', method: 'notifications/initialized' })

    const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    assertNoError(listed, 'tools/list')
    const tools = listed?.result?.tools
    return {
      ok: true,
      toolCount: Array.isArray(tools) ? tools.length : 0,
      serverName: init?.result?.serverInfo?.name,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function safeText(response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/** 从 SSE 文本中取出指定 id 的 JSON-RPC 结果；无 id 时取最后一个结果。 */
function readSseResult(text, wantedId) {
  let found
  for (const chunk of text.split(/\r?\n/)) {
    const line = chunk.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    let parsed
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    if (wantedId === undefined || parsed.id === wantedId) found = parsed
  }
  return found
}

function assertNoError(message, phase) {
  if (message !== undefined && message !== null && message.error !== undefined) {
    const detail = message.error.message ?? JSON.stringify(message.error)
    throw new Error(`${phase} 失败：${detail}`)
  }
}

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

async function probeStdio(config, timeoutMs) {
  if (typeof config.command !== 'string' || config.command.trim() === '') {
    return { ok: false, error: '缺少 command' }
  }
  const env = { ...process.env, ...(config.env ?? {}) }
  const args = Array.isArray(config.args) ? config.args : []

  /**
   * Windows 上 `npx` 实际是 `npx.cmd`，而 Node 从 v18.20 / v20.12 起
   * **拒绝**直接 spawn `.cmd` / `.bat`（CVE-2024-27980 的修复），会抛
   * `EINVAL`。必须显式走 `cmd.exe /c`。
   *
   * 只在 Windows 且命令确实是批处理脚本时才加这一层，其余情况保持
   * 直接 spawn —— 少一层 shell 就少一次引号解析问题。
   */
  const isWindows = process.platform === 'win32'
  const needsShell = isWindows && /\.(cmd|bat)$/i.test(config.command.trim())

  const child = needsShell
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', config.command, ...args], {
        env,
        cwd: typeof config.cwd === 'string' && config.cwd !== '' ? config.cwd : undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsVerbatimArguments: true,
      })
    : spawn(config.command, args, {
        env,
        cwd: typeof config.cwd === 'string' && config.cwd !== '' ? config.cwd : undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Windows 上不要弹出控制台窗口
        windowsHide: true,
      })

  let stderrTail = ''
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-500)
  })

  const pending = new Map()
  let buffer = ''
  let exited = false

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line !== '') {
        try {
          const message = JSON.parse(line)
          if (message.id !== undefined && pending.has(message.id)) {
            const settle = pending.get(message.id)
            pending.delete(message.id)
            settle(message)
          }
        } catch {
          // 忽略非 JSON 输出（子进程可能有日志噪音）
        }
      }
      index = buffer.indexOf('\n')
    }
  })

  const exitPromise = new Promise((resolve) => {
    child.once('error', (error) => {
      exited = true
      resolve({ error })
    })
    child.once('exit', (code, signal) => {
      exited = true
      resolve({ code, signal })
    })
  })

  // 进程起不来或提前退出时，立刻结束在途请求，而不是干等到超时
  const failPending = (reason) => {
    for (const [id, settle] of pending) {
      pending.delete(id)
      settle({ __failure: reason })
    }
  }
  child.once('error', (error) => {
    failPending(`无法启动命令：${error.code === 'ENOENT' ? '找不到可执行文件' : error.message}`)
  })
  child.once('exit', (code, signal) => {
    if (pending.size === 0) return
    const detail = signal !== null && signal !== undefined ? `信号 ${signal}` : `退出码 ${code}`
    failPending(`子进程提前退出（${detail}）${stderrTail.trim() === '' ? '' : `；输出：${stderrTail.trim().slice(0, 200)}`}`)
  })

  const request = (message) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(message.id)
        reject(new Error(`等待 ${message.method} 响应超时`))
      }, timeoutMs)
      pending.set(message.id, (response) => {
        clearTimeout(timer)
        if (response !== undefined && response.__failure !== undefined) reject(new Error(response.__failure))
        else resolve(response)
      })
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`)
      } catch (error) {
        clearTimeout(timer)
        reject(error)
      }
    })

  try {
    const init = await request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-mcp-hub', version: '1.0.0' },
      },
    })
    assertNoError(init, 'initialize')

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

    const listed = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    assertNoError(listed, 'tools/list')
    const tools = listed?.result?.tools
    return {
      ok: true,
      toolCount: Array.isArray(tools) ? tools.length : 0,
      serverName: init?.result?.serverInfo?.name,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (exited && stderrTail.trim() !== '') {
      return { ok: false, error: `${reason}；进程输出：${stderrTail.trim().slice(0, 200)}` }
    }
    return { ok: false, error: reason }
  } finally {
    for (const settle of pending.values()) settle(undefined)
    pending.clear()
    try {
      child.kill('SIGTERM')
    } catch {
      // 进程可能已经退出
    }
    // 给子进程一点退出时间，避免留下僵尸进程
    await Promise.race([exitPromise, delay(500)])
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
