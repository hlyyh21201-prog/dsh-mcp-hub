/**
 * MCP Hub —— Host 侧。
 *
 * 职责：
 *   - 维护一个**本插件独占**的持久化文件（默认 `~/.dsh/mcp-hub.yml`），
 *     不碰已有 `dsh-mcp-manager` 使用的 `profiles/web/cordis.patch.yml`，
 *     避免两个插件互相覆盖。
 *   - 通过一个 `cordis:include` 行把该文件挂进 Loader，从而获得完整的
 *     启停 / 热加载语义（include 的 `refresh()` 会重读文件并增量 reconcile）。
 *   - 向 Client 暴露 `/mcp-hub` RPC 通道（列表、启停、增删改、导入、探测）。
 *
 * 依赖：只依赖 Node 内置模块 + 宿主提供的 `loader` / `connection` 服务。
 * YAML 写入由本文件自带的极简序列化器完成（见 `yaml.js`），因此本插件在
 * profile 中无需安装任何第三方依赖。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseImportText, sanitizeServerName, isSecretPlaceholder, SECRET_PLACEHOLDER } from './parsers.js'
import { parseEntryList, dumpEntryList } from './yaml.js'
import { scanInsertRows, removeInsertRows, looksLikeMcpClientRow } from './patchfile.js'
import { probeServer } from './probe.js'

/** 提供 MCP 工具桥的包名（每个 MCP server 一行）。 */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'
/** Client ↔ Host 的 RPC 通道。 */
export const RPC_CHANNEL = '/mcp-hub'

/** 本插件在 loader 树中的行 id；也是持久化文件里 include 行的 id。 */
const HUB_ROW_ID = 'mcp-hub'

/** dsh loader 的嵌套 entry id 分隔符。 */
const ENTRY_SEP = ':'

const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
const ENTRY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** loader fiber 状态 → 可读阶段。 */
const FIBER_PHASE = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
}

/**
 * 定位「当前 profile 的 patch 文件」—— adopt 唯一允许改写的目标。
 *
 * 只认宿主运行时的事实来源，**绝不读环境变量**：`DSH_PROFILE_DIR` 会被子进程继承，
 * 曾因此把真实 profile 的 MCP 行摘掉（已从备份恢复）。
 *
 * 依次尝试：
 *   1. `ctx.get('profileContext').patchPath` —— 宿主 `dsh-config-editor` 自己用的那个；
 *   2. `profileContext.dir` + `cordis.patch.yml`；
 *   3. 从 loader 树里找承载 profile 根的 include，用它的 `baseUrl`（profile 目录）推导。
 * 全都不成立时返回 `undefined`，让 adopt 直接拒绝执行 —— 宁可不动，也不猜。
 */
function resolveProfilePatchPath(ctx) {
  const FILENAME = 'cordis.patch.yml'
  const usable = (value) => typeof value === 'string' && value.trim() !== ''

  // 1) / 2) 宿主登记的 profile 事实
  try {
    const profile = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined
    if (profile !== undefined && profile !== null) {
      if (usable(profile.patchPath)) return profile.patchPath
      if (usable(profile.dir)) {
        const candidate = join(profile.dir, FILENAME)
        if (existsSync(candidate)) return candidate
      }
    }
  } catch {
    // 服务不可用就继续往下试
  }

  // 3) 从 include 树推导：profile 根配置所在目录 + cordis.patch.yml
  try {
    for (const entry of ctx.loader.entries()) {
      const baseUrl = entry.subtree?.ctx?.baseUrl ?? entry.parent?.tree?.ctx?.baseUrl
      if (!usable(baseUrl)) continue
      const dir = baseUrl.startsWith('file:') ? fileURLToPath(baseUrl) : baseUrl
      const candidate = join(dir, FILENAME)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // 推导失败就放弃
  }

  return undefined
}

/** 备份文件后缀用的时间戳：2026-10-16T15-43-12。 */
function stamp() {
  return new Date().toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-')
}

/**
 * 与宿主 `@deepseek-ai/dsh-atomic-write` 兼容的排他锁。
 *
 * 宿主用 `<file>.lock` + `wx` 独占创建来互斥，锁内写 PID、结束时删除。
 * profile 的 `cordis.patch.yml` 同时会被 `dsh-config-editor`（模型 / 插件设置）
 * 以同样方式加锁写入，所以这里必须用**完全相同的约定**才能与它真正互斥：否则
 * 两边的「读-改-写」会交错，后写的一方按旧快照覆盖先写的一方 —— 表现为
 * 「刚接管的行又回来了」或用户其它配置丢失。
 *
 * 本插件零依赖（工作区解析不到宿主的包），所以这里自己实现一份等价实现。
 */
const LOCK_WAIT_MS = 10_000
const LOCK_RETRY_MIN_MS = 20
const LOCK_RETRY_MAX_MS = 250

async function withExclusiveLock(filename, operation) {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + LOCK_WAIT_MS
  let delay = LOCK_RETRY_MIN_MS

  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // 持有者已退出（PID 不存在）时回收这把锁
      try {
        const holder = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
        if (Number.isInteger(holder) && holder > 0) {
          try {
            process.kill(holder, 0)
          } catch (probeError) {
            // 只在「进程确实不存在」时回收。Windows 上对存在但没有权限的进程会抛
            // EPERM（进程活着，只是我们动不了它）；若把它当死锁回收，就会出现
            // 两个进程同时认为持有锁 —— 那正是这把锁要防的事。
            if (probeError?.code === 'ESRCH') {
              rmSync(lockPath, { force: true })
              continue
            }
          }
        }
      } catch {
        // 读不到就按普通竞争处理
      }
    }
    if (Date.now() >= deadline) throw new Error(`mcp-hub: 等待写入锁超时（${lockPath}）`)
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }

  try {
    return await operation()
  } finally {
    rmSync(lockPath, { force: true })
  }
}

/**
 * 原子写：先写同目录临时文件再 rename。
 * 临时名带随机后缀，避免与其它写入方或本插件的并发调用撞名。
 */
function writeFileAtomicSync(filename, content) {
  const temp = `${filename}.${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    writeFileSync(temp, content, { mode: 0o600, flag: 'wx' })
    renameSync(temp, filename)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveDshHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return join(homedir(), '.dsh')
}

/**
 * 解析持久化文件路径。
 *
 * @param configured - 行配置里的 `dataFile`（显式指定时优先）。
 * @param profileDir - 当前 profile 目录（`profileContext.dir`）。
 *
 * 为什么默认放在 **profile 目录**里而不是 `<DSH_HOME>/`：数据文件持有
 * `@deepseek-ai/dsh-mcp-client` 行，而 dsh 启动时的兼容性预检会**从声明该行的
 * 文件自身**向上解析这个裸包名（`createRequire(pathToFileURL(<include 文件>))`）。
 * 文件放在 `<DSH_HOME>/` 下会一路向上找到 `<DSH_HOME>` 的父目录 `node_modules`
 * —— 那里若残留一份旧 dsh 安装，就命中旧版 `dsh-mcp-client`，peer 校验失败后
 * dsh 会**整体禁用这个 include**：
 *
 *     disabling profile plugin row "mcp-hub-servers": its included file
 *     <...>/mcp-hub.yml reaches an incompatible plugin, and that file is never rewritten
 *
 * 放进 profile 目录后，向上命中 `<DSH_HOME>/profiles/node_modules` 与 dsh 自身
 * 安装，版本与运行时一致。位置也必须与 bundle 里 include 行的 `./mcp-hub.yml`
 * 对齐，否则面板写的文件不是 Loader 挂载的那个。
 */
export function resolveDataFile(configured, profileDir) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  if (typeof profileDir === 'string' && profileDir.trim() !== '') {
    return join(profileDir.trim(), 'mcp-hub.yml')
  }
  return join(resolveDshHome(), 'mcp-hub.yml')
}

// ---------------------------------------------------------------------------
// 持久化文件读写
// ---------------------------------------------------------------------------

/** 读取持久化文件中的服务器行列表。 */
export function readRows(file) {
  if (!existsSync(file)) return []
  const content = readFileSync(file, 'utf8')
  if (content.trim() === '') return []
  const parsed = parseEntryList(content)
  if (parsed === null || parsed === undefined) return []
  if (!Array.isArray(parsed)) throw new Error(`配置文件 ${file} 的顶层必须是数组`)
  return parsed
}

/**
 * 原子写入持久化文件（先写临时文件再改名，保留一份 .bak）。
 *
 * 临时文件名必须**唯一**：Cordis Loader 的 Include 在同一目录下用
 * `<file>.tmp` 写同一个文件（子条目配置更新时它会回写整棵树）。若这里也占用
 * `<file>.tmp`，两边的 rename 会互相抢走对方的临时文件，结果是
 * `ENOENT: rename '<file>.tmp' -> '<file>'`，而文件本身可能已经消失。
 * 因此这里带上 pid 与自增序号。
 */
export function writeRows(file, rows, header) {
  mkdirSync(dirname(file), { recursive: true })
  const body = dumpEntryList(rows)
  const text = `${header}${body}`
  if (existsSync(file)) {
    try {
      copyFileSync(file, `${file}.bak`)
    } catch {
      // 备份失败不应阻断主流程
    }
  }
  const tmp = `${file}.${process.pid}.${(tmpCounter += 1)}.tmp`
  try {
    // 该文件可能包含 env / headers 中的密钥，收紧权限（0600）
    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 清理失败不影响主错误
    }
    throw error
  }
  try {
    chmodSync(file, 0o600)
  } catch {
    // 某些文件系统不支持，忽略
  }
}

let tmpCounter = 0

const FILE_HEADER = `# MCP servers managed by the dsh-mcp-hub plugin.
#
# This file is owned by dsh-mcp-hub and is NOT read by other MCP manager
# plugins. It is mounted into the Cordis Loader through a "cordis:include"
# row in the profile patch, so edits here hot-apply to the running Harness.
#
# Prefer the "MCP Hub" panel in the Web GUI (Settings → MCP Hub).
# Format: a top-level YAML array of Loader entries; \`!!js\` expressions allowed.
`

/** 把一个 MCP server 配置包成 loader 行。 */
function toLoaderRow(id, config, disabled = false) {
  const row = { id, name: MCP_CLIENT_PACKAGE, config }
  if (disabled) row.disabled = true
  return row
}

/** 在行列表中按 id 定位（只处理扁平行列表）。 */
function locateRow(rows, id) {
  return rows.findIndex((row) => isRecord(row) && row.id === id)
}

/** 从行列表中提取 server 配置。 */
function rowToConfig(row) {
  const raw = isRecord(row.config) ? row.config : {}
  return {
    serverName: typeof raw.serverName === 'string' ? raw.serverName : '',
    transport: raw.transport === 'stdio' ? 'stdio' : 'streamable-http',
    url: typeof raw.url === 'string' ? raw.url : undefined,
    command: typeof raw.command === 'string' ? raw.command : undefined,
    args: Array.isArray(raw.args) ? raw.args.map(String) : undefined,
    env: isRecord(raw.env) ? raw.env : undefined,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    headers: isRecord(raw.headers) ? raw.headers : undefined,
    toolCallTimeoutMs: typeof raw.toolCallTimeoutMs === 'number' ? raw.toolCallTimeoutMs : undefined,
    failOnStartupError: typeof raw.failOnStartupError === 'boolean' ? raw.failOnStartupError : undefined,
  }
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/** 校验一份 server 配置；返回 field → message 的错误映射（空对象表示通过）。 */
export function validateConfig(id, config) {
  const errors = {}
  if (typeof id !== 'string' || !ENTRY_ID_RE.test(id)) {
    errors.id = '条目 ID 需匹配 [A-Za-z0-9_-]{1,64}'
  }
  if (typeof config.serverName !== 'string' || !SERVER_NAME_RE.test(config.serverName)) {
    errors.serverName = 'serverName 需匹配 [A-Za-z0-9_-]{1,32}'
  }
  if (config.transport === 'stdio') {
    if (typeof config.command !== 'string' || config.command.trim() === '') {
      errors.command = 'stdio 传输必须填写命令'
    }
    if (config.args !== undefined && !Array.isArray(config.args)) {
      errors.args = 'args 必须是字符串数组'
    }
  } else if (typeof config.url !== 'string' || !/^https?:\/\/.+/.test(config.url)) {
    errors.url = '远程传输必须填写合法的 http(s) URL'
  }
  if (config.env !== undefined && !isStringRecord(config.env)) {
    errors.env = 'env 必须是 键 → 字符串 的映射'
  }
  if (config.headers !== undefined && !isStringRecord(config.headers)) {
    errors.headers = 'headers 必须是 键 → 字符串 的映射'
  }
  return errors
}

function isStringRecord(value) {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
}

/** 去掉占位符以外的空值，保持写入文件干净。 */
function cleanConfig(config) {
  const out = { serverName: config.serverName, transport: config.transport }
  if (config.transport === 'stdio') {
    out.command = config.command
    if (Array.isArray(config.args) && config.args.length > 0) out.args = config.args
    if (isRecord(config.env) && Object.keys(config.env).length > 0) out.env = config.env
    if (typeof config.cwd === 'string' && config.cwd !== '') out.cwd = config.cwd
  } else {
    out.url = config.url
    if (isRecord(config.headers) && Object.keys(config.headers).length > 0) out.headers = config.headers
  }
  if (typeof config.toolCallTimeoutMs === 'number') out.toolCallTimeoutMs = config.toolCallTimeoutMs
  if (config.failOnStartupError === true) out.failOnStartupError = true
  return out
}

// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------

// webServer 必需：connection.rpc.handle() 内部要经本插件的 ctx 注册 HTTP 路由，
// 缺少该注入时 Cordis 会在注册时报 `cannot get property "webServer" without inject`。
export const inject = ['connection', 'loader', 'webServer', 'tools']
export const name = 'mcp-hub'

export function apply(ctx, rawConfig) {
  // 数据文件默认落在当前 profile 目录里，与 bundle 中 include 行的
  // `./mcp-hub.yml` 对齐（原因见 resolveDataFile 的注释）。
  const profileDir = (() => {
    try {
      const profile = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined
      return profile === undefined || profile === null ? undefined : profile.dir
    } catch {
      return undefined
    }
  })()
  const dataFile = resolveDataFile(rawConfig?.dataFile, profileDir)
  const logger = ctx.logger('mcp-hub')
  const state = { includeRowId: undefined, mountError: undefined }

  // 定位本插件挂载 include 树的行；先同步扫一遍，之后跟随 loader 事件刷新。
  const refreshMountState = () => {
    state.includeRowId = undefined
    state.mountError = undefined
    for (const entry of ctx.loader.entries()) {
      const options = entry.options ?? {}
      if (options.name !== 'cordis:include' && options.name !== '@deepseek-ai/cordis-plugin-include') continue
      // 判据优先用 Include 自己解析出的绝对路径：bundle patch 里写的是相对路径
      // （include 行是 EntryGroup，`!!js` 不会被执行），字符串直接比对必然落空。
      const resolved = entry.subtree?.filename
      if (typeof resolved === 'string' && resolved === dataFile) {
        state.includeRowId = entry.id
        continue
      }
      // 尚未挂载（子树没起来）时退回配置值比较，两种写法都兼容。
      const configured = options.config?.path
      if (typeof configured === 'string' && configured === dataFile) state.includeRowId = entry.id
    }
  }

  /**
   * 确保数据文件存在。
   *
   * 顺带做一次**一次性迁移**：早期版本把文件放在 `<DSH_HOME>/mcp-hub.yml`，
   * 而那个位置会让 dsh 的兼容性预检解析到工作区里可能残留的旧版
   * `dsh-mcp-client`，从而整体禁用 include（详见 `resolveDataFile`）。
   * 若旧位置有内容、新位置为空，就把旧内容搬过来，避免升级时静默丢配置。
   * 旧文件随后仍保留（改名归档），不删。
   */
  const ensureDataFile = () => {
    const legacy = join(resolveDshHome(), 'mcp-hub.yml')
    const legacyHasRows = legacy !== dataFile && existsSync(legacy) && readRows(legacy).length > 0
    const currentEmpty = !existsSync(dataFile) || readRows(dataFile).length === 0

    if (legacyHasRows && currentEmpty) {
      try {
        copyFileSync(legacy, dataFile)
        chmodSync(dataFile, 0o600)
        const archived = `${legacy}.migrated-${stamp()}`
        renameSync(legacy, archived)
        logger.warn('mcp-hub: migrated %d row(s) from %s to %s (old file kept at %s)', readRows(dataFile).length, legacy, dataFile, archived)
      } catch (error) {
        logger.error('mcp-hub: 迁移旧配置文件失败：%s', error instanceof Error ? error.message : String(error))
      }
      return
    }

    if (!existsSync(dataFile)) writeRows(dataFile, [], FILE_HEADER)
  }

  ctx.effect(() => {
    ensureDataFile()
    refreshMountState()
    logger.info('mcp-hub active (data file: %s)', dataFile)
    return () => {}
  }, 'mcp-hub: init')

  // loader 树变化时重新定位 include 行
  ctx.on('internal/plugin', () => {
    try {
      refreshMountState()
    } catch {
      // 定位失败不影响读写主流程
    }
  })

  /** 找到承载本文件的 Include 树（用它的 refresh() 触发增量重载）。 */
  const findIncludeTree = () => {
    for (const entry of ctx.loader.entries()) {
      const subtree = entry.subtree
      if (subtree === undefined || typeof subtree.refresh !== 'function') continue
      if (typeof subtree.filename !== 'string') continue
      if (subtree.filename === dataFile) return subtree
    }
    return undefined
  }

  /**
   * 该 entry 是否位于本插件 include 的子树里。
   *
   * `ctx.loader.entries()` 是跨所有 include / patch 层的扁平列表，子条目的 id 形如
   * `include:<includeRowId>:<childId>`。外部行（例如 profile patch 里的 `mcp-idea`）
   * 的短 id 可能与本插件的行**同名**，所以判断归属必须看是否在本 include 子树内，
   * 不能只比归一化后的短 id —— 否则外部行会被误判成「本插件管的」，
   * 在面板上出现停用/删除按钮，一旦点击就会删掉用户的配置。
   */
  /** 该 entry 是否位于本插件 include 的子树里。 */
  const isInIncludeSubtree = (rawEntryId) => {
    const text = String(rawEntryId ?? '')
    if (!text.includes(ENTRY_SEP)) return false
    const includeRowId = normalizeEntryId(state.includeRowId ?? '')
    return includeRowId !== '' && text.startsWith(`include${ENTRY_SEP}${includeRowId}${ENTRY_SEP}`)
  }

  /**
   * 规划「接管」：把这些外部 MCP 行从它们所在的 patch 文件迁到本插件名下。
   *
   * 为什么需要它：用户的 MCP 行可能由别的插件写进 `cordis.patch.yml`。当用户
   * 决定不再用那个插件时，那些行就没人管了 —— 面板上只能显示为「外部配置」。
   * 接管把它们搬进 `mcp-hub.yml`，此后可正常编辑；原文件按行级手术摘除，
   * 注释与其余内容保持原样，并先落一份备份。
   *
   * 定位来源文件：以 `profileContext.patchPath`（宿主自己用来编辑 profile 配置的
   * 那个文件）为准，而不是 `process.env.DSH_PROFILE_DIR`。
   *
   * **为什么不能用环境变量**：`DSH_PROFILE_DIR` 是启动时注入的，子进程会继承它。
   * 曾经用它做过测试沙箱，结果沙箱进程继承了真实 profile 的环境变量，adopt 便
   * 摘掉了**真实** profile 里的 MCP 行。`profileContext` 是宿主运行时的事实来源，
   * 与进程环境无关，因此不会出现这种串台。
   */
  const planAdopt = (wanted) => {
    const missing = []
    const candidates = []
    const files = new Set()

    const serverById = new Map(listServers().map((server) => [server.id, server]))
    // 来源文件：只认运行时解析出的当前 profile patch（见 resolveProfilePatchPath）。
    const patchFiles = []
    const patchPath = resolveProfilePatchPath(ctx)
    if (patchPath !== undefined) patchFiles.push(patchPath)

    for (const id of wanted) {
      const server = serverById.get(id)
      if (server === undefined || server.managed === true) {
        if (server === undefined) missing.push(id)
        continue
      }
      let located
      for (const file of patchFiles) {
        let text
        try {
          text = readFileSync(file, 'utf8')
        } catch {
          continue
        }
        const { blocks } = scanInsertRows(text)
        for (const block of blocks) {
          for (const row of block.rows) {
            if (row.id !== id) continue
            const rowText = text.split('\n').slice(row.start, row.end).join('\n')
            if (!looksLikeMcpClientRow(rowText)) continue
            located = { file, rowText }
          }
        }
        if (located !== undefined) break
      }
      if (located === undefined) continue
      candidates.push({
        id,
        file: located.file,
        config: {
          serverName: server.serverName,
          transport: server.transport,
          url: server.url,
          command: server.command,
          args: server.args,
          env: server.env,
          headers: server.headers,
          cwd: server.cwd,
        },
        disabled: server.enabled === false,
      })
      files.add(located.file)
    }

    // allowedFiles 是「本次允许写入」的白名单：只有宿主登记的 profile patch 文件。
    // 调用方会再校验一次 plan.files ⊆ allowedFiles，防止路径被意外替换。
    return { candidates, missing, files: [...files], allowedFiles: [...patchFiles] }
  }

  /**
   * 落盘并热重载。
   *
   * 关键点：**挂载后由 Include 独占写入**。
   *
   * Include 会在子条目配置变化时（`Entry.update` → `parent.tree.write()`）用
   * 自己的定时器回写整棵树；如果本插件同时也 `writeRows` 同一个文件，两个写入方
   * 会互相踩：Loader 的 `_writeFile` 用 `<file>.tmp` 做临时文件，两次 rename 交错
   * 就会出现 `ENOENT: rename '<file>.tmp' -> '<file>'`，文件内容也会被对方的旧快照
   * 覆盖（表现为刚导入的服务器「不在配置文件中」）。
   *
   * 所以这里改为：先 `root.update(rows)` 直接在 Loader 树上做增量 reconcile
   * （新增的启动、删除的卸载、改动的重启），再让 Include 落盘，并等它真正写完。
   * 只有尚未挂载到 Loader 时才由本插件自己写文件。
   */
  const persist = async (rows) => {
    const tree = findIncludeTree()
    if (tree === undefined) {
      writeRows(dataFile, rows, FILE_HEADER)
      return { reload: 'none', warning: '配置文件尚未挂载到 Loader，重启后生效' }
    }
    await tree.root.update(rows)
    tree.write()
    await tree.flushWrite()
    // Include._writeFile 用默认权限（通常 0644）落盘，而本文件可能含 env / headers
    // 里的密钥，这里把它收回 0600。
    try {
      chmodSync(dataFile, 0o600)
    } catch {
      // 某些文件系统不支持，忽略
    }
    return { reload: 'include' }
  }

  /** 读取当前所有 MCP server 行（跨所有 include / patch 层）。 */
  const listServers = () => {
    const managed = readRowsSafe(dataFile)
    const managedIds = new Set(managed.map((row) => row.id))
    const servers = []

    for (const entry of ctx.loader.entries()) {
      const options = entry.options ?? {}
      if (options.group === true) continue
      if (options.name !== MCP_CLIENT_PACKAGE) continue
      const id = normalizeEntryId(entry.id)
      const config = rowToConfig(options)
      servers.push({
        ...config,
        id,
        enabled: !entry.disabled,
        fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state] ?? null,
        toolCount: countTools(ctx, config.serverName),
        // 「是不是本插件管的行」必须以【是否位于本插件的 include 子树内】为准，
        // 不能只比对归一化后的短 id：外部行 `mcp-idea` 与本插件行
        // `include:<includeId>:mcp-idea` 的短 id 都是 `mcp-idea`，只比 id 会把
        // 用户自己的行误判成可启停/可删除。
        managed: managedIds.has(id) && isInIncludeSubtree(entry.id),
        needsSecret: hasUnfilledSecret(config),
        mountWarning: state.mountError,
      })
    }

    // 文件里存在但尚未挂载的行（例如刚导入、等待重载）
    for (const row of managed) {
      if (!isRecord(row) || typeof row.id !== 'string') continue
      if (servers.some((server) => server.id === row.id)) continue
      const config = rowToConfig(row)
      servers.push({
        ...config,
        id: row.id,
        enabled: true,
        fiberPhase: null,
        toolCount: 0,
        managed: true,
        pending: true,
        needsSecret: hasUnfilledSecret(config),
      })
    }

    servers.sort((a, b) => a.id.localeCompare(b.id))
    return servers
  }

  /** 按 id 找出可供探测的配置：优先已挂载的 Loader 行，其次配置文件里的行。 */
  const findConfigById = (id) => {
    for (const entry of ctx.loader.entries()) {
      const options = entry.options ?? {}
      if (options.group === true) continue
      if (options.name !== MCP_CLIENT_PACKAGE) continue
      if (normalizeEntryId(entry.id) !== id) continue
      const config = rowToConfig(options)
      return {
        transport: config.transport,
        url: config.url,
        headers: config.headers,
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
      }
    }
    const row = readRowsSafe(dataFile).find((item) => isRecord(item) && item.id === id)
    if (row !== undefined) {
      const config = rowToConfig(row)
      return {
        transport: config.transport,
        url: config.url,
        headers: config.headers,
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
      }
    }
    return undefined
  }

  /**
   * 把解析结果规划成待写入的行：分配不冲突的 entry id 与 serverName。
   * `import` 的各个来源（粘贴文本 / 文件路径）共用，保证「预览看到的」就是
   * 「确认导入写下的」。
   *
   * @param parsed - `parseImportText` 的结果。
   * @param options.only - 可选的来源名白名单（`sourceName`）。用于预览里勾选：
   *   只有被勾中的条目才参与命名分配与写入，未勾中的既不写入、也不会占用
   *   serverName（否则用户不导入的那台仍会把名字占掉）。
   */
  const planImport = (parsed, options = {}) => {
    const only = options.only === undefined ? undefined : new Set(options.only.map((value) => String(value)))
    const items = only === undefined ? parsed.items : parsed.items.filter((item) => only.has(item.sourceName))
    const rows = readRowsSafe(dataFile)
    const existingIds = new Set(rows.map((row) => row.id))
    // 同时避开**外部行**已占用的 id：短 id 在面板上是标识符，
    // 与外部行同名会让「哪一行属于本插件」变得难以分辨。
    for (const server of listServers()) {
      if (typeof server.id === 'string' && server.id !== '') existingIds.add(server.id)
    }
    const existingNames = new Set(
      listServers()
        .map((server) => server.serverName)
        .filter((value) => value !== '')
    )
    const imported = []
    const conflicts = []

    for (const item of items) {
      const baseId = sanitizeEntryId(`mcp-${item.config.serverName}`)
      let id = baseId
      let index = 2
      while (existingIds.has(id)) {
        id = sanitizeEntryId(`${baseId}-${index}`)
        index += 1
      }
      existingIds.add(id)

      let serverName = item.config.serverName
      if (existingNames.has(serverName)) {
        let suffix = 2
        let candidate = sanitizeServerName(`${serverName}-${suffix}`)
        while (existingNames.has(candidate)) {
          suffix += 1
          candidate = sanitizeServerName(`${serverName}-${suffix}`)
        }
        conflicts.push({ source: item.sourceName, from: serverName, to: candidate })
        serverName = candidate
      }
      existingNames.add(serverName)

      imported.push({
        id,
        config: cleanConfig({ ...item.config, serverName }),
        sourceName: item.sourceName,
        maskedKeys: item.maskedKeys ?? [],
        disabled: item.disabled === true,
        pendingSecrets: (item.maskedKeys ?? []).length,
      })
    }

    return { imported, warnings: parsed.warnings ?? [], conflicts }
  }

  const dispatch = async (endpoint, payload) => {
    switch (endpoint) {
      case 'info':
        return ok({
          dataFile,
          mounted: state.includeRowId !== undefined,
          includeRowId: state.includeRowId,
          exists: existsSync(dataFile),
          entrySeparator: ENTRY_SEP,
        })

      case 'list':
        return ok({ servers: listServers() })

      case 'import': {
        const { text, path, format, maskSecrets, dryRun, only } = payload ?? {}
        let sourceText = typeof text === 'string' ? text : undefined
        let sourceName
        let bytes

        // 允许直接给文件路径：读取与解析都在 Host 完成，原文不回传 Client。
        if (sourceText === undefined && typeof path === 'string' && path.trim() !== '') {
          const resolved = resolveUserPath(path)
          if (!existsSync(resolved)) return fail('not-found', `文件不存在：${resolved}`)
          try {
            sourceText = readFileSync(resolved, 'utf8')
          } catch (error) {
            return fail('read-error', error instanceof Error ? error.message : String(error))
          }
          sourceName = resolved
          bytes = sourceText.length
        }

        if (typeof sourceText !== 'string') return fail('invalid-payload', '需要提供 text 或 path')

        let parsed
        try {
          parsed = parseImportText(sourceText, {
            format,
            sourceName,
            maskSecrets: maskSecrets !== false,
          })
        } catch (error) {
          return fail('parse-error', error instanceof Error ? error.message : String(error))
        }

        // 预览始终用全量规划（这样界面能看到所有解析结果与其冲突标记），
        // 但标记出每一条是否被勾选；写入时只处理勾中的那些。
        const plan = planImport(parsed)
        const selected = only === undefined ? undefined : new Set(only.map((value) => String(value)))
        const items = planImport(parsed, { only }).imported
        const chosenNames = new Set(items.map((item) => item.sourceName))
        const preview = plan.imported.map((item) => ({
          ...item,
          selected: selected === undefined ? true : chosenNames.has(item.sourceName),
        }))

        const base = {
          ...plan,
          imported: preview,
          selected: items,
          format: parsed.format,
          dataFile,
          ...(sourceName === undefined ? {} : { path: sourceName, byteLength: bytes }),
        }

        // 预览（dryRun）只做解析与命名规划，绝不写盘。
        if (dryRun === true) return ok({ ...base, dryRun: true })
        if (items.length === 0) return ok({ ...base, dryRun: false })

        const existing = readRowsSafe(dataFile)
        const next = [
          ...existing,
          ...items.map((item) => toLoaderRow(item.id, item.config, item.disabled)),
        ]
        const persistResult = await persist(next)
        return ok({
          ...base,
          reload: persistResult.reload,
          reloadWarning: persistResult.warning,
          dryRun: false,
        })
      }

      case 'add': {
        const { id, config } = payload ?? {}
        const errors = validateConfig(id, config)
        if (Object.keys(errors).length > 0) return operationError('invalid-config', '配置无效', errors)
        const rows = readRowsSafe(dataFile)
        if (locateRow(rows, id) >= 0) return fail('duplicate-id', `条目 ID "${id}" 已被占用`)
        const taken = listServers().some((server) => server.serverName === config.serverName)
        if (taken) return fail('duplicate-server-name', `serverName "${config.serverName}" 已被其他服务器使用`)
        const persistResult = await persist([...rows, toLoaderRow(id, cleanConfig(config))])
        return ok({ added: id, reload: persistResult.reload, reloadWarning: persistResult.warning })
      }

      case 'update': {
        const { id, config } = payload ?? {}
        const errors = validateConfig(id, config)
        if (Object.keys(errors).length > 0) return operationError('invalid-config', '配置无效', errors)
        const rows = readRowsSafe(dataFile)
        const index = locateRow(rows, id)
        if (index < 0) {
          return fail('not-managed', `条目 "${id}" 不在本插件的配置文件中，无法编辑`)
        }
        const taken = listServers().some(
          (server) => server.serverName === config.serverName && server.id !== id
        )
        if (taken) return fail('duplicate-server-name', `serverName "${config.serverName}" 已被其他服务器使用`)
        const disabled = rows[index].disabled === true
        const next = rows.slice()
        next[index] = toLoaderRow(id, cleanConfig(config), disabled)
        const persistResult = await persist(next)
        return ok({ updated: id, reload: persistResult.reload, reloadWarning: persistResult.warning })
      }

      case 'setEnabled': {
        const { id, enabled } = payload ?? {}
        const rows = readRowsSafe(dataFile)
        const index = locateRow(rows, id)
        if (index < 0) {
          return fail('not-managed', `条目 "${id}" 不在本插件的配置文件中，无法启停`)
        }
        const row = rows[index]
        const next = rows.slice()
        if (enabled === true) {
          const copy = { ...row }
          delete copy.disabled
          next[index] = copy
        } else {
          next[index] = { ...row, disabled: true }
        }
        const persistResult = await persist(next)
        return ok({ id, enabled: enabled === true, reload: persistResult.reload, reloadWarning: persistResult.warning })
      }

      case 'restart': {
        // 重启单个服务器：先停用再启用，逼 Loader 销毁并重建该条目的 fiber。
        //
        // 为什么需要它：条目一旦进入 failed / 未挂载 状态，面板上没有别的办法让它
        // 重连 —— 只能改配置或重启整个 dsh。接管、改 IDEA 端口、被控端重启之后
        // 都很容易留下这种「配置对但没连上」的状态。
        //
        // 用「写 disabled: true → 再写回不带 disabled」两步，是因为 Loader 对
        // 已禁用的条目会 dispose fiber，重新启用时才会重新 init，从而重新握手。
        const { id } = payload ?? {}
        const rows = readRowsSafe(dataFile)
        const index = locateRow(rows, id)
        if (index < 0) {
          return fail('not-managed', `条目 "${id}" 不在本插件的配置文件中，无法重启`)
        }
        const row = rows[index]
        const wasDisabled = row.disabled === true

        if (!wasDisabled) {
          // 第一步：停用
          const stopped = rows.slice()
          stopped[index] = { ...row, disabled: true }
          await persist(stopped)
          // 给 Loader 一点时间完成 dispose，否则紧接着的启用可能被合并掉
          await new Promise((resolve) => setTimeout(resolve, 250))
        }

        // 第二步：重新启用（去掉 disabled）
        const restarted = readRowsSafe(dataFile)
        const at = locateRow(restarted, id)
        if (at < 0) return fail('not-managed', `条目 "${id}" 在重启过程中消失`)
        const enabled = restarted.slice()
        const bare = { ...restarted[at] }
        delete bare.disabled
        enabled[at] = bare
        const persistResult = await persist(enabled)

        return ok({
          restarted: id,
          wasDisabled,
          reload: persistResult.reload,
          reloadWarning: persistResult.warning,
        })
      }

      case 'remove': {
        const { id } = payload ?? {}
        const rows = readRowsSafe(dataFile)
        const index = locateRow(rows, id)
        if (index < 0) {
          return fail('not-managed', `条目 "${id}" 不在本插件的配置文件中，无法删除`)
        }
        const next = rows.filter((_, position) => position !== index)
        const persistResult = await persist(next)
        return ok({ removed: id, reload: persistResult.reload, reloadWarning: persistResult.warning })
      }

      case 'scan': {
        const candidates = scanKnownLocations()
        return ok({ candidates })
      }

      case 'probe': {
        const { id } = payload ?? {}
        const target = findConfigById(id)
        if (target === undefined) return fail('not-found', `找不到条目：${String(id)}`)
        const result = await probeServer(target)
        return ok(result)
      }

      case 'adopt': {
        const { ids, dryRun } = payload ?? {}
        if (!Array.isArray(ids) || ids.length === 0) return fail('invalid-payload', 'ids 必须是非空数组')
        const wanted = ids.map((value) => String(value))
        const plan = planAdopt(wanted)
        if (plan.missing.length > 0) {
          return fail('not-found', `找不到这些条目：${plan.missing.join('、')}`)
        }
        if (plan.candidates.length === 0) {
          return fail('not-adoptable', '所选条目没有可接管的来源（可能已被本插件管理）')
        }
        if (dryRun === true) return ok({ ...plan, dryRun: true })

        // 硬护栏：只允许改「宿主登记的 profile patch 文件」，且必须真的存在。
        // 这是防止「写错进程的 profile」的最后一道闸 —— 一旦目标不是当前 profile
        // 的 patch 文件，直接拒绝，绝不动手。
        const allowed = new Set(plan.allowedFiles ?? [])
        for (const file of plan.files) {
          if (!allowed.has(file)) {
            return fail('adopt-refused', `拒绝改写非当前 profile 的文件：${file}`)
          }
        }
        if (plan.files.length === 0) {
          return fail('not-adoptable', '没有可改写的来源文件')
        }

        // 先备份，再动任何外部文件。
        const backups = []
        for (const file of plan.files) {
          const backup = `${file}.bak-${stamp()}`
          try {
            copyFileSync(file, backup)
            backups.push(backup)
          } catch (error) {
            return fail('backup-failed', `备份失败，未做任何修改：${error instanceof Error ? error.message : String(error)}`)
          }
        }

        // 逐个来源文件做行级摘除（保留注释与其余行的原样）。
        //
        // 必须与宿主的 profile 配置写入方（`dsh-config-editor`，它用
        // `withFileLock` + `writeFileAtomic` 做 AST 级编辑）互斥：否则两边的
        // 读-改-写会交错，先写的一方被后写的一方按旧快照覆盖，表现就是「刚接管的
        // 行又回来了」或用户的其他配置丢失。这里复用同一把锁与同一个原子写。
        for (const file of plan.files) {
          const targets = plan.candidates.filter((item) => item.file === file).map((item) => item.id)
          const outcome = await withExclusiveLock(file, async () => {
            const original = readFileSync(file, 'utf8')
            const { text, removed, skipped } = removeInsertRows(original, targets, (id, rowText) =>
              looksLikeMcpClientRow(rowText)
            )
            if (skipped.length > 0) return { skipped }
            if (removed.length > 0) writeFileAtomicSync(file, text)
            return { removed }
          })
          if (outcome.skipped !== undefined) {
            return fail('adopt-refused', `拒绝摘除（行内容不像 MCP 配置）：${outcome.skipped.join('、')}`)
          }
        }

        // 并入本插件自己的文件，此后由本插件负责它们的生命周期。
        const rows = readRowsSafe(dataFile)
        const existingIds = new Set(rows.map((row) => row.id))
        const merged = [...rows]
        for (const item of plan.candidates) {
          let id = item.id
          let index = 2
          while (existingIds.has(id)) {
            id = sanitizeEntryId(`${item.id}-${index}`)
            index += 1
          }
          existingIds.add(id)
          merged.push(toLoaderRow(id, cleanConfig(item.config), item.disabled))
        }
        const persistResult = await persist(merged)

        // 让 profile patch 热重载（app-boot 的 HMR 会 watch 这些文件）。
        try {
          ctx.emit('app-boot/config-reload')
        } catch {
          // 事件不存在时忽略；重启后同样生效
        }

        return ok({
          adopted: plan.candidates.map((item) => item.id),
          backups,
          files: plan.files,
          reload: persistResult.reload,
          reloadWarning: persistResult.warning,
          dataFile,
          restarted: false,
        })
      }

      default:
        return fail('unknown-endpoint', `未知端点：${String(endpoint)}`)
    }
  }
  ctx.effect(() => {
    const dispose = resolveRpc(ctx).handle(RPC_CHANNEL, async (endpoint, payload) => {
      try {
        return await dispatch(endpoint, payload)
      } catch (error) {
        return fail('internal', error instanceof Error ? error.message : String(error))
      }
    })
    return () => {
      Promise.resolve(dispose()).catch(() => {})
    }
  }, 'mcp-hub: rpc channel')
}

/**
 * 取 `connection.rpc`，必须逐字采用「沿原型链找访问器 + 用 Proxy 自身作 receiver」
 * 的调用方式（与 `@michengai/dsh-automation` 的 registerAutomationRpc 一致）。
 *
 * 为什么不能用 `ctx.connection.rpc`：`get rpc()` 内部会 `const owner = this.ctx`，
 * 而 `register()` 里要访问 `owner.webServer`。Cordis 的 tracker
 * （property: 'ctx', noShadow: true）会把 `owner` 换成调用方的 shadow ctx —— 也就是
 * **本插件的 ctx**。所以：
 *
 *   1. 本插件必须声明 `webServer`（shadow ctx 用本插件的 inject 视图解析它），
 *      否则报 `cannot get property "webServer" without inject`；
 *   2. 但访问方式同样关键：直接用 `connection.rpc` 时，shadow 的构造路径不同，
 *      `owner` 落在一个不带 inject 视图的 ctx 上，同样报错；用下面这种
 *      「原型访问器 + Proxy 作 receiver」的写法才稳定拿到带 inject 视图的 owner。
 */
function resolveRpc(ctx) {
  const connection = ctx.connection
  let prototype = connection
  let rpc
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'rpc')
    if (descriptor !== undefined) {
      rpc = descriptor.get === undefined ? connection.rpc : descriptor.get.call(connection)
      break
    }
    prototype = Object.getPrototypeOf(prototype)
  }
  rpc ??= connection.rpc
  return rpc
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function ok(value) {
  return { ok: true, value }
}

function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

function operationError(code, message, fields) {
  return fail(code, message, { fields })
}

function readRowsSafe(file) {
  try {
    return readRows(file)
  } catch {
    return []
  }
}

function normalizeEntryId(id) {
  const text = String(id ?? '')
  const index = text.lastIndexOf(ENTRY_SEP)
  return index >= 0 ? text.slice(index + 1) : text
}

function countTools(ctx, serverName) {
  if (!serverName) return 0
  const prefix = `mcp__${serverName}__`
  try {
    let count = 0
    for (const schema of ctx.tools?.schemas?.() ?? []) {
      if (typeof schema.name === 'string' && schema.name.startsWith(prefix)) count += 1
    }
    return count
  } catch {
    return 0
  }
}

/** 配置里是否残留未补填的占位符。 */
function hasUnfilledSecret(config) {
  if (isRecord(config.env) && Object.values(config.env).some(isSecretPlaceholder)) return true
  if (isRecord(config.headers) && Object.values(config.headers).some(isSecretPlaceholder)) return true
  return false
}

/** 把用户输入里的 `~` 展开成家目录。 */
function resolveUserPath(input) {
  const trimmed = String(input).trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
  return trimmed
}

function sanitizeEntryId(value) {
  const cleaned = String(value)
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return ENTRY_ID_RE.test(cleaned) ? cleaned : 'mcp-server'
}

/**
 * 已知的 MCP 配置文件位置（只探测存在性，不读取内容）。
 *
 * 按平台给出各自的真实位置，不做「把三个平台的路径都列一遍」那种写法 ——
 * 那样在某个平台会把不存在的位置也显示出来，用户会以为插件找错了地方。
 */
function scanKnownLocations() {
  const home = homedir()
  const isWindows = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  // Windows 上应用数据放在 %APPDATA%（Roaming），不是家目录
  const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')

  const defs = [
    { path: join(home, '.codex', 'config.toml'), label: 'Codex', format: 'toml' },
    { path: join(home, '.claude.json'), label: 'Claude Code', format: 'json' },
    // Claude 的「项目级」配置是 <项目根>/.mcp.json。家目录本身也常被当成
    // 项目根用（`cd ~` 后启动 claude），所以 ~/.mcp.json 必须扫；
    // 当前工作目录下的那一份也一起带上，因为 dsh 的 cwd 往往就是项目目录。
    { path: join(home, '.mcp.json'), label: 'Claude 项目 (.mcp.json)', format: 'json' },
    { path: join(home, '.claude', 'settings.json'), label: 'Claude Code (settings)', format: 'json' },
    { path: join(home, '.claude', 'settings.local.json'), label: 'Claude Code (local)', format: 'json' },
    { path: join(home, '.cursor', 'mcp.json'), label: 'Cursor', format: 'json' },
    { path: join(home, '.config', 'mcp', 'config.json'), label: 'MCP CLI', format: 'json' },
    // Gemini CLI / Antigravity：新位置收敛到 ~/.gemini/config/（目录里带 .migrated
    // 标记，说明是从旧位置迁过来的）；旧位置 ~/.gemini/settings.json 里的
    // mcpServers 通常已空，但仍然可能有人还在用。
    { path: join(home, '.gemini', 'config', 'mcp_config.json'), label: 'Gemini / Antigravity', format: 'json' },
    { path: join(home, '.gemini', 'settings.json'), label: 'Gemini CLI (settings)', format: 'json' },
    // Antigravity 自己的 mcp_config.json（各版本位置不同，都试一下）
    { path: join(home, '.gemini', 'antigravity', 'mcp_config.json'), label: 'Antigravity', format: 'json' },
    { path: join(home, '.gemini', 'antigravity-cli', 'mcp_config.json'), label: 'Antigravity CLI', format: 'json' },
    { path: join(home, '.antigravity', 'mcp_config.json'), label: 'Antigravity (home)', format: 'json' },
    { path: join(home, '.vscode', 'mcp.json'), label: 'VS Code', format: 'json' },
    { path: join(home, '.codeium', 'windsurf', 'mcp_config.json'), label: 'Windsurf', format: 'json' },
    { path: join(home, '.gemini', 'config', 'config.json'), label: 'Gemini (config)', format: 'json' },
  ]

  // 当前工作目录下的项目级配置（Claude 在项目根找 .mcp.json）。
  // 与上面 ~/.mcp.json 可能是同一个文件，下面的去重会处理掉。
  if (typeof process.cwd === 'function') {
    defs.push({ path: join(process.cwd(), '.mcp.json'), label: 'Claude 项目 (当前目录)', format: 'json' })
    defs.push({ path: join(process.cwd(), '.vscode', 'mcp.json'), label: 'VS Code (当前目录)', format: 'json' })
  }

  // Claude Desktop：macOS 在 Application Support，Windows 在 %APPDATA%
  if (isMac) {
    defs.push({
      path: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      label: 'Claude Desktop',
      format: 'json',
    })
  } else if (isWindows) {
    defs.push({ path: join(appData, 'Claude', 'claude_desktop_config.json'), label: 'Claude Desktop', format: 'json' })
  } else {
    defs.push({ path: join(home, '.config', 'Claude', 'claude_desktop_config.json'), label: 'Claude Desktop', format: 'json' })
  }

  // VS Code 的用户级 mcp.json 位置也按平台分叉
  if (isMac) {
    defs.push({ path: join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'), label: 'VS Code (User)', format: 'json' })
  } else if (isWindows) {
    defs.push({ path: join(appData, 'Code', 'User', 'mcp.json'), label: 'VS Code (User)', format: 'json' })
  }

  const candidates = []
  const seen = new Set()
  for (const def of defs) {
    // 同一个文件可能被两条定义指到（例如 Windows 上 %APPDATA% 恰好在家目录下）
    if (seen.has(def.path)) continue
    seen.add(def.path)
    if (!existsSync(def.path)) continue
    let servers = 0
    try {
      const text = readFileSync(def.path, 'utf8')
      const parsed = parseImportText(text, { format: def.format, maskSecrets: true })
      servers = parsed.items.length
    } catch {
      servers = -1
    }
    // 完全没有 MCP 条目的文件不列出来：Gemini 的 settings.json / config.json
    // 这类「同一个目录里的另一个 json」装的是主题、权限，不是 MCP 服务器，
    // 列出来只会让人以为插件找到了错误的东西。
    if (servers <= 0) continue
    candidates.push({ ...def, exists: true, serverCount: servers })
  }
  return candidates
}

export { SECRET_PLACEHOLDER, resolveProfilePatchPath }
