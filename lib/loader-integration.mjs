/**
 * 真实 Loader 集成测试。
 *
 * 用真实的 `@deepseek-ai/cordis-plugin-loader` + app-boot 的 `cordis:include`
 * 建树，复刻真实启动顺序（先 mountRootInclude 挂根 include，再由 patch 插入
 * 本插件的行），验证四件事：
 *
 *   1. include 行的 config.path 以 profile 根配置所在目录为基准解析；
 *   2. `!!js` 在 include 行上不会被求值（EntryGroup 会跳过 interpolate），
 *      因此必须写相对路径；
 *   3. 通过 include.refresh() 能做到「改文件 → 条目热启停」；
 *   4. 插件在真实 loader 上能激活，且能找到自己挂载的那棵树。
 *
 * 运行：node lib/loader-integration.mjs
 * 全程在临时目录里进行，不碰真实 profile。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DSH = '/home/yyh/.config/nvm/versions/node/v26.8.1/lib/node_modules/@deepseek-ai/dsh'

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

const { Context } = await import(`${DSH}/node_modules/@deepseek-ai/cordis/lib/index.js`)
const Loader = (await import(`${DSH}/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js`)).default
const { mountRootInclude } = await import(`${DSH}/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`)
const { dshHomePath } = await import(`${DSH}/node_modules/@deepseek-ai/dsh-home-paths/lib/index.js`)

// 复刻真实布局：<home>/profiles/web/cordis.yml + <home>/mcp-hub.yml
const home = mkdtempSync(join(tmpdir(), 'mcp-hub-boot-'))
const profileDir = join(home, 'profiles', 'web')
mkdirSync(profileDir, { recursive: true })
const rootConfig = join(profileDir, 'cordis.yml')
writeFileSync(rootConfig, '[]\n')
const serversFile = join(home, 'mcp-hub.yml')
writeFileSync(serversFile, '[]\n')

console.log('== include 行 config.path 解析基准 ==')
console.log(`  home        = ${home}`)
console.log(`  profileDir  = ${profileDir}`)
console.log(`  serversFile = ${serversFile}`)

/** 每种候选写法起一个全新 Context，避免互相污染。 */
async function probePath(candidateValue) {
  const local = new Context()
  local.baseUrl = pathToFileURL(rootConfig).href
  local.provide('dshHomePath', dshHomePath)
  await local.plugin(Loader, {})
  await mountRootInclude(
    local,
    rootConfig,
    [{ insert: [{ id: 'servers', name: 'cordis:include', config: { path: candidateValue, initial: [] } }] }],
    undefined,
    'test'
  )
  await local.loader.await()
  let landed
  for (const entry of local.loader.entries()) {
    if (entry.id !== 'include:servers') continue
    landed = entry.subtree?.filename
  }
  return landed
}

const relative = await probePath('../../mcp-hub.yml')
check(
  '相对路径 ../../mcp-hub.yml 解析到 <DSH_HOME>/mcp-hub.yml',
  relative === serversFile,
  String(relative)
)

const jsExpr = await probePath({ __jsExpr: "dshHomePath('mcp-hub.yml')" })
check(
  '!!js 在 include 行上确实不被求值（故不能使用）',
  jsExpr !== serversFile,
  `解析结果 = ${String(jsExpr)}（说明 EntryGroup 跳过 interpolate）`
)

// ---------------------------------------------------------------------------
// 端到端：include.refresh() 热启停
// ---------------------------------------------------------------------------

console.log('\n== 通过 include.refresh() 热启停 ==')

const live = new Context()
// 捕获被 loader 吞掉的初始化错误（Entry._init 里 catch 后只 logger.error）
live.logger.exporter({
  levels: { default: 3 },
  export: ({ name, type, args }) => {
    if (type === 'error' || type === 'warn') console.log(`  [logger ${type}] ${name}:`, ...args.map((a) => (a instanceof Error ? a.message : String(a))))
  },
})
live.baseUrl = pathToFileURL(rootConfig).href
live.provide('dshHomePath', dshHomePath)
await live.plugin(Loader, {})
await mountRootInclude(
  live,
  rootConfig,
  [{ insert: [{ id: 'servers', name: 'cordis:include', config: { path: '../../mcp-hub.yml', initial: [] } }] }],
  undefined,
  'test'
)
await live.loader.await()

let tree
for (const entry of live.loader.entries()) if (entry.id === 'include:servers') tree = entry.subtree
check('找到 include 子树', tree !== undefined)
check('子树指向 <DSH_HOME>/mcp-hub.yml', tree?.filename === serversFile, String(tree?.filename))

const writeServers = (rows) => writeFileSync(serversFile, JSON.stringify(rows, null, 2))
const childIds = () =>
  [...live.loader.entries()].filter((entry) => entry.id.startsWith('include:servers')).map((entry) => entry.id)
// 用真实插件行测启停：group 行按设计忽略 disabled（Entry.disabled 直接 return false），
// 而本插件管理的是普通行。stub 放在 include 文件同目录（home）——include 树里行的
// 模块说明符以「该 include 文件所在目录」为基准解析。
writeFileSync(join(home, 'stub.mjs'), 'export function apply() {}\n')

// 让 include 树能按裸包名解析 dsh 自带的插件（真实 profile 里由 profile 的
// node_modules + dsh 安装共同提供）。
mkdirSync(join(home, 'node_modules', '@deepseek-ai'), { recursive: true })
for (const pkg of ['dsh-mcp-client', 'cordis-plugin-loader']) {
  const from = `${DSH}/node_modules/@deepseek-ai/${pkg}`
  const to = join(home, 'node_modules', '@deepseek-ai', pkg)
  try {
    symlinkSync(from, to, 'dir')
  } catch {
    // 已存在
  }
}

const groupRow = (id, extra = {}) => ({ id, name: './stub.mjs', ...extra })

writeServers([])
await tree.refresh()
await live.loader.await()
const baseline = childIds().length

writeServers([groupRow('child-a')])
await tree.refresh()
await live.loader.await()
check('新增行后条目出现', childIds().includes('include:servers:child-a'), JSON.stringify(childIds()))

writeServers([groupRow('child-a', { disabled: true })])
await tree.refresh()
await live.loader.await()
const disabledEntry = [...live.loader.entries()].find((entry) => entry.id === 'include:servers:child-a')
check('disabled 行仍留在树上（可再启用）', disabledEntry !== undefined)
// 卸载后的 fiber 对象仍在，但 uid 被置空、state 落到 4（unloading/disposed）。
// 用 uid === null 判定「已停用」，比 fiber === undefined 准确。
check(
  'disabled 行 fiber 已卸载（uid 置空）',
  disabledEntry?.fiber === undefined || disabledEntry.fiber.uid === null,
  `uid=${String(disabledEntry?.fiber?.uid)} state=${String(disabledEntry?.fiber?.state)}`
)

writeServers([groupRow('child-a')])
await tree.refresh()
await live.loader.await()
const reenabled = [...live.loader.entries()].find((entry) => entry.id === 'include:servers:child-a')
check(
  '重新启用后 fiber 挂回并生效（uid 重新分配、state=2）',
  reenabled?.fiber !== undefined && reenabled.fiber.uid !== null && reenabled.fiber.state === 2,
  `uid=${String(reenabled?.fiber?.uid)} state=${String(reenabled?.fiber?.state)}`
)

writeServers([])
await tree.refresh()
await live.loader.await()
check('删除行后条目消失', childIds().length === baseline, JSON.stringify(childIds()))

// 损坏文件必须保留最后一次可用树，不能把运行中的进程带崩
writeServers([groupRow('child-b')])
await tree.refresh()
await live.loader.await()
const beforeBroken = childIds().length
writeFileSync(serversFile, '{{{ broken')
await tree.refresh()
await live.loader.await()
check('文件损坏时保留运行中的树', childIds().length === beforeBroken, JSON.stringify(childIds()))

writeServers([groupRow('child-c')])
await tree.refresh()
await live.loader.await()
check('恢复写入后重新可用', childIds().includes('include:servers:child-c'), JSON.stringify(childIds()))

// ---------------------------------------------------------------------------
// 真实插件：在 loader 上挂载本插件模块，验证它能找到自己那棵树
// ---------------------------------------------------------------------------

console.log('\n== 插件在真实 loader 上激活 ==')

writeServers([])
await tree.refresh()
await live.loader.await()

// 通过 link 让 loader 能按包名解析到工作区里的插件
const linkDir = join(profileDir, 'node_modules', '@yyh')
mkdirSync(linkDir, { recursive: true })
symlinkSync('/home/yyh/yyh/dsh-mcp-hub', join(linkDir, 'dsh-mcp-hub'), 'dir')

// 本插件的 inject 是 ['connection','loader','webServer','tools']；真实进程里这些由
// dsh-web-app 提供，这里补最小替身，好让激活路径（含 RPC 注册）真正跑一遍。
const rpcRoutes = new Map()
const webRoutes = new Map()
const fakeWebServer = {
  register(route) {
    // connection.rpc.handle 最终会经由本插件的 ctx 调用 webServer.register
    webRoutes.set(`${route.kind}:${route.path}`, route)
    return () => webRoutes.delete(`${route.kind}:${route.path}`)
  },
  registerUpgrade() {
    return () => {}
  },
  registerFallback() {
    return () => {}
  },
}
const fakeConnection = {
  rpc: {
    handle(channel, handler) {
      rpcRoutes.set(channel, handler)
      // 复刻真实实现：注册即声明一条 HTTP 路由
      return fakeWebServer.register({ kind: 'prefix', path: channel, handler: async () => {} })
    },
  },
}
live.provide('webServer', fakeWebServer)
live.provide('connection', fakeConnection)
live.provide('tools', { schemas: () => [] })

// 真实的 bundle 是「一个 patch 同时插入两行」，这里照做，避免第二次
// mountRootInclude 覆盖掉上一次的组合（那会让 include 行消失）。
const pluginPatch = [
  {
    insert: [
      { id: 'mcp-hub', name: '@yyh/dsh-mcp-hub', config: { dataFile: serversFile } },
      { id: 'servers', name: 'cordis:include', config: { path: '../../mcp-hub.yml', initial: [] } },
    ],
  },
]
let pluginError
try {
  await mountRootInclude(live, rootConfig, pluginPatch, undefined, 'test')
  await live.loader.await()
} catch (error) {
  pluginError = error
}

const pluginEntry = [...live.loader.entries()].find((entry) => entry.id === 'include:mcp-hub')
check('插件行已挂载', pluginEntry !== undefined, pluginError?.message)
check(
  '插件 fiber 处于 active（未因缺注入而失败）',
  pluginEntry?.fiber?.state === 2,
  `state=${String(pluginEntry?.fiber?.state)}`
)
check('插件注册了 RPC 通道 /mcp-hub', rpcRoutes.has('/mcp-hub'), JSON.stringify([...rpcRoutes.keys()]))
check('RPC 通道被注册成 HTTP 路由（webServer 注入生效）', webRoutes.has('prefix:/mcp-hub'), JSON.stringify([...webRoutes.keys()]))

// 直接调用注册好的 handler，验证 info 端点返回真实数据
let infoResult
if (rpcRoutes.has('/mcp-hub')) {
  infoResult = await rpcRoutes.get('/mcp-hub')('info', {}, undefined, {})
}
check('info 端点可用', infoResult?.ok === true, JSON.stringify(infoResult)?.slice(0, 200))
check('info 报告的 dataFile 与 include 挂载的是同一个文件', infoResult?.value?.dataFile === serversFile, String(infoResult?.value?.dataFile))
check('info 报告 mounted=true（插件找到自己挂载的 include 树）', infoResult?.value?.mounted === true, JSON.stringify(infoResult?.value))

// ---------------------------------------------------------------------------
// 端到端：走插件自己的 RPC 做增 / 启停 / 删，验证真的作用在 Loader 上
// ---------------------------------------------------------------------------

console.log('\n== 插件 RPC → Loader 端到端 ==')

const call = (endpoint, payload) => rpcRoutes.get('/mcp-hub')(endpoint, payload, undefined, {})

const added = await call('add', {
  id: 'mcp-stub',
  config: { serverName: 'stub', transport: 'streamable-http', url: 'http://127.0.0.1:1/x' },
})
check('add 端点写入成功', added?.ok === true, JSON.stringify(added)?.slice(0, 200))
await live.loader.await()

const entryId = 'include:servers:mcp-stub'
const findEntry = () => [...live.loader.entries()].find((entry) => entry.id === entryId)
check('新条目已挂到 Loader 上', findEntry() !== undefined, JSON.stringify(childIds()))
check('新条目已激活（state=2）', findEntry()?.fiber?.state === 2, `state=${String(findEntry()?.fiber?.state)}`)

// 说明：这里 serverName='stub' 对应的 dsh-mcp-client 会连 http://127.0.0.1:1/x 并失败，
// 但条目本身仍会被创建；下面的启停断言只看条目生命周期，不看连接是否成功。

const off = await call('setEnabled', { id: 'mcp-stub', enabled: false })
check('setEnabled(false) 返回成功', off?.ok === true, JSON.stringify(off)?.slice(0, 200))
await live.loader.await()
check('停用后 fiber 卸载（uid 置空）', findEntry()?.fiber?.uid === null, `uid=${String(findEntry()?.fiber?.uid)}`)

const on = await call('setEnabled', { id: 'mcp-stub', enabled: true })
check('setEnabled(true) 返回成功', on?.ok === true, JSON.stringify(on)?.slice(0, 200))
await live.loader.await()
check('启用后 fiber 重新激活（state=2）', findEntry()?.fiber?.state === 2, `state=${String(findEntry()?.fiber?.state)}`)

// list 端点应能报出这台服务器
const listed = await call('list', {})
const listedStub = listed?.value?.servers?.find((server) => server.id === 'mcp-stub')
check('list 端点报出该服务器', listedStub !== undefined, JSON.stringify(listed?.value?.servers?.map((x) => x.id)))
check('list 标记 managed=true', listedStub?.managed === true)
check('list 报出 enabled 状态', listedStub?.enabled === true)

const removed = await call('remove', { id: 'mcp-stub' })
check('remove 端点成功', removed?.ok === true, JSON.stringify(removed)?.slice(0, 200))
await live.loader.await()
check('删除后条目从 Loader 消失', findEntry() === undefined, JSON.stringify(childIds()))
const { parseEntryList } = await import('./yaml.js')
check('删除后配置文件已清空', parseEntryList(readFileSync(serversFile, 'utf8')).length === 0)

// ---------------------------------------------------------------------------
// 手写 !!js 表达式必须能在 Include 回写后存活（否则会静默丢配置）
// ---------------------------------------------------------------------------

console.log('\n== 手写 !!js 在回写后保留 ==')

const { dumpEntryList } = await import('./yaml.js')
const withExpr = [
  {
    id: 'expr-row',
    name: './stub.mjs',
    config: { port: { __jsExpr: "Number(process.env.MCP_HUB_TEST_PORT ?? 0)" } },
  },
]
writeFileSync(serversFile, dumpEntryList(withExpr))
await tree.refresh()
await live.loader.await()
const beforeRaw = readFileSync(serversFile, 'utf8')
check('原始文件含 !!js 标记', beforeRaw.includes('!!js'), beforeRaw.split('\n').slice(0, 3).join(' / '))

// 触发一次 Include 回写（走插件的持久化路径）
await call('setEnabled', { id: 'expr-row', enabled: false })
const afterRaw = readFileSync(serversFile, 'utf8')
check('回写后 !!js 仍然存在', afterRaw.includes('!!js'), afterRaw.split('\n').slice(0, 3).join(' / '))
check('回写后表达式内容未变', afterRaw.includes('MCP_HUB_TEST_PORT'), afterRaw)

rmSync(home, { recursive: true, force: true })

console.log(`\n${checks - failures}/${checks} 通过`)
if (failures > 0) process.exitCode = 1
