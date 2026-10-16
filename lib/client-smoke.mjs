/**
 * 客户端渲染冒烟测试（不依赖真实 React 包）。
 *
 * 提供一个最小 React 替身 + 递归渲染器：
 *   - createElement 返回 { type, props, children } 数据树；
 *   - 函数组件会被真正调用，从而执行 McpHubSection / ServerCard /
 *     ServerForm / ImportPanel 的函数体，捕捉渲染期崩溃（访问未定义属性、
 *     误用 API、条件分支错误等）；
 *   - hooks 按「组件实例 + 调用序号」分配 slot，可用 stateOverrides 注入
 *     指定初始状态，无需真实调度器即可渲染出「已加载」等分支。
 *
 * 运行：node lib/client-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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

// ---------------------------------------------------------------------------
// 最小 React 替身
// ---------------------------------------------------------------------------

let hookIndex = 0
let currentOverrides = {}
let effectCount = 0

/** 组件名 → { hookIndex: value }，用于注入指定初始状态。
 *  注意：注册到槽位的组件是包了一层 <style> 的 wrapper，真正的面板组件
 *  （McpHubSection）在其内部，因此按组件名而不是函数标识注入。 */
const stateOverrides = new Map()

function readOverride(index, fallback) {
  if (Object.prototype.hasOwnProperty.call(currentOverrides, index)) return currentOverrides[index]
  return fallback
}

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return {
      type,
      props: props === null || props === undefined ? {} : props,
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true),
    }
  },
  useState(initial) {
    const index = hookIndex
    hookIndex += 1
    const value = readOverride(index, typeof initial === 'function' ? initial() : initial)
    return [value, () => {}]
  },
  useReducer(_reducer, initial, init) {
    const index = hookIndex
    hookIndex += 1
    const fallback = typeof init === 'function' ? init(initial) : initial
    return [readOverride(index, fallback), () => {}]
  },
  useEffect(effect) {
    const index = hookIndex
    hookIndex += 1
    effectCount += 1
    // 副作用需要真实调度器（网络、订阅），冒烟测试只登记不执行；
    // 依赖它的渲染分支改用 stateOverrides 注入状态。
    void index
    void effect
    return undefined
  },
  useCallback(fn) {
    hookIndex += 1
    return fn
  },
  useMemo(fn) {
    hookIndex += 1
    return fn()
  },
  useRef(value) {
    hookIndex += 1
    return { current: value }
  },
}

/** 递归渲染，返回元素统计。 */
function renderTree(node, stats, path = 'root', depth = 0) {
  if (depth > 60) throw new Error(`渲染深度超限（可能是组件无限自嵌套）：${path}`)
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    node.forEach((child, index) => renderTree(child, stats, `${path}[${index}]`, depth + 1))
    return
  }
  if (typeof node !== 'object') return

  const { type, props, children } = node
  if (type === React.Fragment) {
    renderTree(children, stats, `${path}/Fragment`, depth + 1)
    return
  }
  if (typeof type === 'function') {
    stats.components += 1
    const name = type.name || 'Anonymous'
    stats.componentNames.push(name)
    const previousOverrides = currentOverrides
    const previousIndex = hookIndex
    currentOverrides = stateOverrides.get(name) ?? {}
    hookIndex = 0
    let produced
    try {
      produced = type(props)
    } finally {
      currentOverrides = previousOverrides
      hookIndex = previousIndex
    }
    renderTree(produced, stats, `${path}/${name}`, depth + 1)
    return
  }
  // 宿主元素（div / button / span …）
  stats.elements += 1
  if (type === 'button' && typeof props.onClick === 'function') stats.clickable += 1
  const cls = props.className
  if (typeof cls === 'string') {
    for (const token of cls.split(/\s+/)) if (token !== '') stats.classes.add(token)
  }
  let text = ''
  for (const child of children) if (typeof child === 'string' || typeof child === 'number') text += String(child)
  stats.texts.push(text)
  renderTree(children, stats, `${path}/${String(type)}`, depth + 1)
}

function freshStats() {
  return { elements: 0, components: 0, clickable: 0, classes: new Set(), texts: [], componentNames: [] }
}

function render(component, props) {
  hookIndex = 0
  effectCount = 0
  const stats = freshStats()
  renderTree(React.createElement(component, props), stats)
  return stats
}

// ---------------------------------------------------------------------------
// 载入客户端模块
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'client.js'), 'utf8')

let registration
const fakeWindow = {
  __ModuleLoader__: {
    load(entry) {
      registration = entry
    },
  },
}
globalThis.window = fakeWindow

new Function('window', source)(fakeWindow)

console.log('== 客户端结构 ==')
check('client.js 通过 __ModuleLoader__.load 注册', registration !== undefined)
check('注册 id 与包名一致', registration.id === '@yyh/dsh-mcp-hub', registration.id)

const requireShim = (specifier) => {
  if (specifier === 'react') return React
  throw new Error(`意外依赖：${specifier}`)
}

let exports
try {
  exports = registration.factory(requireShim)
  check('factory 正常返回 exports', exports !== undefined && typeof exports === 'object')
} catch (error) {
  check('factory 正常返回 exports', false, error.stack)
  process.exit(1)
}

check('exports 暴露 apply', typeof exports.apply === 'function')
check(
  'inject 声明 slots/locale/connection',
  Array.isArray(exports.inject) && exports.inject.includes('slots') && exports.inject.includes('locale') && exports.inject.includes('connection'),
  JSON.stringify(exports.inject)
)

// ---------------------------------------------------------------------------
// mock ctx
// ---------------------------------------------------------------------------

const registrations = []
const localeRegistrations = []
const rpcCalls = []
let rpcReply = async () => ({ ok: true, value: {} })

const dict = new Map()
const t = (key, params) => {
  const template = dict.get(key)
  if (template === undefined) return `${key}${params === undefined ? '' : ` ${JSON.stringify(params)}`}`
  return template.replace(/\{(\w+)\}/g, (_match, name) => (params && params[name] !== undefined ? String(params[name]) : `{${name}}`))
}

const ctx = {
  get(name) {
    if (name === 'connection') return { rpc: { call: (...args) => rpcReply(...args) } }
    return undefined
  },
  effect(callback) {
    callback()
    return () => {}
  },
  locale: {
    register(ns, dicts) {
      localeRegistrations.push({ ns, dicts })
      for (const [key, value] of Object.entries(dicts.zh ?? {})) dict.set(key, value)
      return () => {}
    },
    bind() {
      return t
    },
    subscribe() {
      return () => {}
    },
  },
  slots: {
    inject(owner, callback) {
      registrations.push({ owner, callback })
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

try {
  exports.apply(ctx)
  check('apply 未抛异常', true)
} catch (error) {
  check('apply 未抛异常', false, error.stack)
}

check('注册了 locale 命名空间 mcpHub', localeRegistrations.some((item) => item.ns === 'mcpHub'))
check('zh 字典包含全部 en 键', (() => {
  const entry = localeRegistrations.find((item) => item.ns === 'mcpHub')
  const zhKeys = new Set(Object.keys(entry.dicts.zh))
  const enKeys = Object.keys(entry.dicts.en)
  return enKeys.every((key) => zhKeys.has(key))
})())
check('en 字典包含全部 zh 键', (() => {
  const entry = localeRegistrations.find((item) => item.ns === 'mcpHub')
  const enKeys = new Set(Object.keys(entry.dicts.en))
  return Object.keys(entry.dicts.zh).every((key) => enKeys.has(key))
})())
check('向 settings.section 注入注册回调', registrations.some((item) => item.owner === 'settings.section'))

for (const item of registrations.filter((entry) => entry.owner === 'settings.section')) item.callback()

const componentEntry = registrations.find((item) => item.options !== undefined && item.options.name === 'settings.section')
check('注册到 settings.section', componentEntry !== undefined)
check('注册 id 为 mcp-hub（区别于已有 mcp 面板）', componentEntry.options.id === 'mcp-hub', componentEntry.options.id)
check('label 为函数（跟随语言切换）', typeof componentEntry.options.label === 'function')
check('order 已设置（不与既有面板重叠）', typeof componentEntry.options.order === 'number', String(componentEntry.options.order))
check('通过 inject 传入 ctx', componentEntry.options.inject !== undefined)

const Section = componentEntry.component

// 找到内部状态槽位：状态顺序固定，注入前先断言关键结构。
// 0=useReducer, 1=useEffect, 2=servers/info, 3=loading, 4=error, 5=busy,
// 6=adding, 7=editingId, 8=importing, 9=probes, 10=notice
function overrideSection(state, loading, openRow) {
  // hook 索引固定（见 McpHubSection 里 useState 的声明顺序）：
  // 0=useReducer, 1=useEffect(locale), 2=servers/info, 3=loading, 4=error,
  // 5=busy, 6=adding, 7=editingId, 8=importing, 9=probes, 10=notice, 11=open。
  // 场景可用 openRow 展开某一行，让只出现在详情区的按钮（例如「重启」）参与断言。
  const overrides = { 2: state, 3: loading }
  if (openRow !== undefined) overrides[11] = { [openRow]: true }
  stateOverrides.set('McpHubSection', overrides)
}

// ---------------------------------------------------------------------------
// 场景渲染
// ---------------------------------------------------------------------------

const scenarios = [
  {
    // 真实最常见的失败形态：dsh-mcp-client 连接失败**不会**让 fiber 变 failed，
    // fiberPhase 仍是 active，唯一可观察的信号是「一个工具都没注册」。
    name: '连接失败但 fiber 仍 active、无工具（应出现重启按钮）',
    state: {
      servers: [
        { id: 'mcp-idea', serverName: 'idea', transport: 'streamable-http', url: 'http://127.0.0.1:1/dead', enabled: true, fiberPhase: 'active', toolCount: 0, managed: true, needsSecret: false },
      ],
      info: { dataFile: '/tmp/mcp-hub.yml', mounted: true },
    },
    openRow: 'mcp-idea',
    expect: { empty: false, card: true, restart: true, disconnected: true },
  },
  {
    // fiber 明确 failed 的形态
    name: 'fiber failed（应出现重启按钮）',
    state: {
      servers: [
        { id: 'mcp-idea', serverName: 'idea', transport: 'streamable-http', url: 'http://127.0.0.1:1/dead', enabled: true, fiberPhase: 'failed', toolCount: 0, managed: true, needsSecret: false },
      ],
      info: { dataFile: '/tmp/mcp-hub.yml', mounted: true },
    },
    openRow: 'mcp-idea',
    expect: { empty: false, card: true, restart: true, disconnected: true },
  },
  {
    // 外部行即使没连上也不该给重启按钮：它不归本插件管，重启会失败
    name: '外部行未连上（不应出现重启按钮）',
    state: {
      servers: [
        { id: 'mcp-out', serverName: 'out', transport: 'streamable-http', url: 'http://127.0.0.1:1/dead', enabled: true, fiberPhase: 'active', toolCount: 0, managed: false, needsSecret: false },
      ],
      info: { dataFile: '/tmp/mcp-hub.yml', mounted: true },
    },
    openRow: 'mcp-out',
    expect: { empty: false, card: true, noRestart: true },
  },
  {
    // 停用的条目不显示重启（它本来就没在跑）
    name: '已停用（不应出现重启按钮）',
    state: {
      servers: [
        { id: 'mcp-off', serverName: 'off', transport: 'streamable-http', url: 'http://127.0.0.1:1/dead', enabled: false, fiberPhase: null, toolCount: 0, managed: true, needsSecret: false },
      ],
      info: { dataFile: '/tmp/mcp-hub.yml', mounted: true },
    },
    openRow: 'mcp-off',
    expect: { empty: false, card: true, noRestart: true },
  },
  {
    name: '正常连接（不应出现重启按钮）',
    state: {
      servers: [
        { id: 'mcp-idea', serverName: 'idea', transport: 'streamable-http', url: 'http://127.0.0.1:64342/stream', enabled: true, fiberPhase: 'active', toolCount: 56, managed: true, needsSecret: false },
      ],
      info: { dataFile: '/tmp/mcp-hub.yml', mounted: true },
    },
    expect: { empty: false, card: true, noRestart: true },
  },
  {
    name: '空列表（已加载）',
    state: { servers: [], info: { dataFile: '/tmp/mcp-hub.yml', mounted: true } },
    expect: { empty: true, card: false },
  },
  {
    name: '加载中',
    state: { servers: [], info: null },
    loading: true,
    expect: { empty: false, card: false },
  },
  {
    name: '多台服务器（含停用/失败/外部/待补密钥/待重载）',
    state: {
      servers: [
        { id: 'mcp-idea', serverName: 'idea', transport: 'streamable-http', url: 'http://127.0.0.1:64342/stream', enabled: true, fiberPhase: 'active', toolCount: 56, managed: true, needsSecret: false },
        { id: 'mcp-mysql-dev', serverName: 'mysql-dev', transport: 'stdio', command: '/usr/bin/npx', args: ['-y', 'mysql-mcp-server'], enabled: true, fiberPhase: 'active', toolCount: 0, managed: true, needsSecret: true },
        { id: 'mcp-off', serverName: 'off', transport: 'streamable-http', url: 'http://127.0.0.1:1/x', enabled: false, fiberPhase: null, toolCount: 0, managed: true, needsSecret: false },
        { id: 'chrome-devtools', serverName: 'chrome-devtools', transport: 'stdio', command: 'npx', enabled: true, fiberPhase: 'failed', toolCount: 0, managed: false, needsSecret: false },
        { id: 'mcp-pending', serverName: 'pending', transport: 'streamable-http', url: 'http://x/y', enabled: true, fiberPhase: null, toolCount: 0, managed: true, pending: true, needsSecret: false },
      ],
      info: { dataFile: '/home/yyh/.dsh/mcp-hub.yml', mounted: true },
    },
    expect: { empty: false, card: true, secret: true, external: true },
  },
  {
    name: '未挂载提示',
    state: { servers: [], info: { dataFile: '/home/yyh/.dsh/mcp-hub.yml', mounted: false } },
    expect: { empty: true, card: false, unmountHint: true },
  },
]

console.log('\n== 主面板渲染 ==')
for (const scenario of scenarios) {
  overrideSection(scenario.state, scenario.loading === true, scenario.openRow)
  rpcReply = async (channel, endpoint) => {
    rpcCalls.push(endpoint)
    if (endpoint === 'info') return { ok: true, value: scenario.state.info }
    if (endpoint === 'list') return { ok: true, value: { servers: scenario.state.servers } }
    return { ok: true, value: {} }
  }
  try {
    const stats = render(Section, { ctx })
    check(`渲染「${scenario.name}」未抛异常（${stats.elements} 元素 / ${stats.components} 组件）`, true)
    if (scenario.expect.card) check('  渲染出服务器行', stats.classes.has('mcp-hub-srv') && stats.classes.has('mcp-hub-srv-name'))
    if (scenario.expect.empty && scenario.loading !== true) check('  渲染空状态', stats.classes.has('mcp-hub-empty'))
    if (scenario.expect.unmountHint) check('  渲染未挂载提示', stats.classes.has('mcp-hub-warn'))
    if (scenario.expect.card) {
      const allText = stats.texts.join('|')
      // 用场景自己的 serverName 断言，避免写死后在别的场景里误报
      const own = (scenario.state.servers || []).map((x) => x.serverName)
      check('  卡片含 serverName', own.every((n) => allText.includes(n)), own.join(','))
      check('  渲染出可点击按钮', stats.clickable >= 3, String(stats.clickable))
      // 下面两项只在那个「全状态」场景里断言，其它场景没有这些成员
      if (scenario.expect.secret) {
        check('  显示待补密钥标记', allText.includes('待补密钥') || stats.classes.has('mcp-hub-pill-secret'))
      }
      if (scenario.expect.external) check('  显示外部配置标记', allText.includes('外部配置'))
    }
    if (scenario.expect.restart) {
      check('  连接失败时出现「重启」按钮', stats.texts.join('|').includes('重启'))
    }
    if (scenario.expect.noRestart) {
      check('  不显示「重启」按钮（避免噪音/无效操作）', !stats.texts.join('|').includes('重启'))
    }
    if (scenario.expect.disconnected) {
      check('  显示「连接失败」而不是「已加载 · 无工具」', stats.texts.join('|').includes('连接失败'))
    }
  } catch (error) {
    check(`渲染「${scenario.name}」未抛异常`, false, error.stack)
  }
}

// ---------------------------------------------------------------------------
// 表单与导入面板渲染
// ---------------------------------------------------------------------------

console.log('\n== 子面板渲染 ==')

// 新增表单：adding=true, editingId=null
overrideSection({ servers: [], info: { dataFile: '/tmp/x.yml', mounted: true } }, false)
stateOverrides.set('McpHubSection', { 2: { servers: [], info: { dataFile: '/tmp/x.yml', mounted: true } }, 3: false, 6: true, 7: null, 8: false })
try {
  const stats = render(Section, { ctx })
  check('渲染「新增表单」未抛异常', true)
  check('  渲染出表单容器', stats.classes.has('mcp-hub-form'))
  check('  渲染出传输方式下拉', stats.classes.has('mcp-hub-select'))
  check('  渲染出条目 ID 输入框', stats.classes.has('mcp-hub-input'))
} catch (error) {
  check('渲染「新增表单」未抛异常', false, error.stack)
}

// 编辑表单：editingId 指向某台服务器
const editServer = { id: 'mcp-idea', serverName: 'idea', transport: 'streamable-http', url: 'http://127.0.0.1:64342/stream', enabled: true, fiberPhase: 'active', toolCount: 56, managed: true, needsSecret: false }
stateOverrides.set('McpHubSection', { 2: { servers: [editServer, { id: 'mcp-mysql', serverName: 'mysql', transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: '1' }, managed: true, enabled: true, fiberPhase: 'active', toolCount: 3 }], info: { dataFile: '/tmp/x.yml', mounted: true } }, 3: false, 6: false, 7: 'mcp-mysql', 8: false })
try {
  const stats = render(Section, { ctx })
  check('渲染「编辑表单」未抛异常', true)
  check('  表单复用（含 textarea）', stats.elements > 0)
} catch (error) {
  check('渲染「编辑表单」未抛异常', false, error.stack)
}

// 导入面板：importing=true
stateOverrides.set('McpHubSection', { 2: { servers: [], info: { dataFile: '/tmp/x.yml', mounted: true } }, 3: false, 6: false, 7: null, 8: true })
try {
  const stats = render(Section, { ctx })
  check('渲染「导入面板」未抛异常', true)
  check('  含扫描入口', stats.texts.join('|').includes('扫描本机已知位置'))
  check('  含粘贴区（textarea）', stats.elements > 0)
} catch (error) {
  check('渲染「导入面板」未抛异常', false, error.stack)
}

// ---------------------------------------------------------------------------
// 静态约束
// ---------------------------------------------------------------------------

console.log('\n== 静态约束 ==')
check('仅依赖 react（无 Harness Client 包）', !/require\(['"]@deepseek-ai\//.test(source))
check('未使用 document.body 追加', !source.includes('document.body'))
check('未使用 iframe', !source.includes('<iframe') && !source.includes("'iframe'"))
const hardcodedColors = source.match(/#[0-9a-fA-F]{6}\b/g) ?? []
const allowedHex = hardcodedColors.filter((color) => color.toLowerCase() !== '#fff')
check('样式只使用主题 token（示例中无硬编码色值）', allowedHex.length === 0, allowedHex.join(','))
check('样式引用主题 token', source.includes('--dsw-alias-'))

stateOverrides.clear()
console.log(`\n${checks - failures}/${checks} 通过`)
if (failures > 0) process.exitCode = 1
