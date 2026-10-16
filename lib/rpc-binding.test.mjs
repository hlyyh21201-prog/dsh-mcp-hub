/**
 * 回归测试：RPC 注册的调用方式与 inject 声明。
 *
 * 背景（真实踩过的坑）：
 * `@deepseek-ai/dsh-client-connection` 的 `get rpc()` 内部是
 *
 *     get rpc() {
 *       const owner = this.ctx
 *       return { handle: (channel, handler) => this.register(owner, channel, handler) }
 *     }
 *     register(owner, channel, handler) {
 *       return owner.effect(() => owner.webServer.register(route), `... ${channel} rpc channel`)
 *     }
 *
 * 其中 `owner` 会经 Cordis 的 tracker（property: 'ctx', noShadow: true）被换成
 * **调用方（本插件）的 ctx**，所以 `owner.webServer` 用的是本插件的 inject 视图。
 * 由此得出两个必须同时满足的条件：
 *
 *   1. 本插件必须声明 `webServer`，否则报
 *      `cannot get property "webServer" without inject`；
 *   2. 访问 `rpc` 必须走「沿原型链取访问器 + 用 service 自身作 receiver」的写法，
 *      直接用 `ctx.connection.rpc` 会落在不带 inject 视图的 ctx 上，同样报错。
 *
 * 本测试用真实的 cordis 库复刻上面的结构，两个条件各断言一次，并断言
 * 插件源码里确实写着这两种写法。
 *
 * 运行：node lib/rpc-binding.test.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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

const { Context, Service } = await import(`${DSH}/node_modules/@deepseek-ai/cordis/lib/index.js`)

// --- 复刻 webServer 提供者 --------------------------------------------------
class WebServer extends Service {
  constructor(ctx) {
    super(ctx, 'webServer')
    this.routes = []
  }
  register(route) {
    this.routes.push(route)
    return () => {
      this.routes = this.routes.filter((item) => item !== route)
    }
  }
}

// --- 复刻 dsh-client-connection 的结构与访问路径 -----------------------------
class Connection extends Service {
  constructor(ctx) {
    super(ctx, 'connection')
  }
  get rpc() {
    const owner = this.ctx
    return { handle: (channel, handler) => this.register(owner, channel, handler) }
  }
  register(owner, channel) {
    // 与 dsh-client-connection 第 656 行同形
    return owner.effect(() => owner.webServer.register({ channel }), `connection: ${channel} rpc channel`)
  }
}

/** 插件里的 resolveRpc() 逐字复制。 */
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

/** 跑一次：返回是否注册成功。 */
async function attempt({ inject, how }) {
  const ctx = new Context()
  await ctx.plugin(WebServer)
  await ctx.plugin(Connection)
  let threw
  await ctx.plugin({
    inject,
    apply(readerCtx) {
      try {
        const rpc = how === 'resolveRpc' ? resolveRpc(readerCtx) : readerCtx.connection.rpc
        rpc.handle('/probe', async () => ({}))
      } catch (error) {
        threw = error.message
      }
    },
  })
  const registered = ctx.get('webServer').routes.some((route) => route.channel === '/probe')
  return { registered, threw }
}

console.log('== RPC 注册：调用方式 × inject 声明 ==')

const good = await attempt({ inject: ['connection', 'webServer'], how: 'resolveRpc' })
check('resolveRpc + 声明 webServer → 注册成功', good.registered === true, good.threw)

const noInject = await attempt({ inject: ['connection'], how: 'resolveRpc' })
check(
  'resolveRpc 但不声明 webServer → 失败（证明 webServer 必需）',
  noInject.registered === false,
  noInject.threw
)

const direct = await attempt({ inject: ['connection', 'webServer'], how: 'direct' })
check(
  '直接 ctx.connection.rpc 写法 → 失败（证明 resolveRpc 必需）',
  direct.registered === false,
  direct.threw
)

// ---------------------------------------------------------------------------
// 端到端：加载插件真实的 apply()，在复刻的真实服务结构上跑一遍
// ---------------------------------------------------------------------------

console.log('\n== 插件真实 apply() 端到端注册 ==')

const { mkdtempSync, rmSync, existsSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')

const dir = mkdtempSync(joinPath(tmpdir(), 'mcp-hub-rpc-'))
let realApply
try {
  const mod = await import('./index.js')
  realApply = mod.apply
  check('导入插件真实 apply()', typeof realApply === 'function')

  const live = new Context()
  await live.plugin(WebServer)
  await live.plugin(Connection)
  // loader 替身：本用例只关心 RPC 注册，entries() 返回空即可
  live.provide('loader', { *entries() {} })
  live.provide('tools', { schemas: () => [] })

  let applyError
  try {
    // 走真实插件的 inject 声明与 apply 主体
    await live.plugin({ inject: mod.inject, apply: realApply }, { dataFile: joinPath(dir, 'mcp-hub.yml') })
  } catch (error) {
    applyError = error
  }
  check('插件 apply() 在真实服务结构上未抛错', applyError === undefined, applyError?.message)

  const routes = live.get('webServer').routes
  check(
    '插件成功注册 RPC 路由 /mcp-hub',
    routes.some((route) => route.channel === '/mcp-hub'),
    JSON.stringify(routes.map((r) => r.channel))
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n== 插件源码确实采用上述写法 ==')

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'index.js'), 'utf8')
check('源码声明了 webServer', /export const inject = \[[^\]]*'webServer'[^\]]*\]/.test(source))
check('源码通过 resolveRpc() 注册 RPC', source.includes('resolveRpc(ctx).handle(RPC_CHANNEL'))
check('源码含原型链查找访问器的实现', source.includes("Object.getOwnPropertyDescriptor(prototype, 'rpc')"))
check('源码未直接使用 ctx.connection.rpc.handle', !source.includes('ctx.connection.rpc.handle'))

console.log(`\n${checks - failures}/${checks} 通过`)
if (failures > 0) process.exitCode = 1
