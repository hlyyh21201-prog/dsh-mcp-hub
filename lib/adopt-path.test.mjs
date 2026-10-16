/**
 * 回归测试：adopt 的写入目标必须来自 `profileContext`，不能来自环境变量。
 *
 * 真实事故（本测试就是为它写的）：
 * 我用 `DSH_PROFILE_DIR=/tmp/sbhome` 起了一个测试沙箱，但 `DSH_PROFILE_DIR` 是
 * 启动时注入且会被子进程继承的；沙箱进程里 `process.env.DSH_PROFILE_DIR` 仍指向
 * 真实 profile。当时 `planAdopt` 读环境变量决定要改哪个文件，于是**摘掉了真实
 * profile 里的 MCP 行**（已从自动备份恢复，无数据丢失）。
 *
 * 现在的实现改成读 `profileContext.patchPath`（宿主运行时的事实来源），并且对
 * 目标文件做白名单校验。本测试断言：
 *   1. 环境变量指向别处时，那些文件**不会**被当成来源；
 *   2. 目标不在白名单里时，操作被拒绝；
 *   3. 正常路径（profileContext 给出文件）仍可工作。
 *
 * 运行：node lib/adopt-path.test.mjs
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

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')

console.log('== 静态断言：源码不得再用环境变量定位 profile ==')

check(
  'planAdopt 不再读取 process.env.DSH_PROFILE_DIR',
  !/planAdopt[\s\S]{0,2000}DSH_PROFILE_DIR/.test(source),
  'planAdopt 里仍出现 DSH_PROFILE_DIR'
)
// 注释里会说明「为什么不用环境变量」，那是文档；这里只断言**代码**不再读它。
const codeOnly = source
  .split('\n')
  .filter((line) => !/^\s*(\*|\/\/)/.test(line))
  .join('\n')
check(
  '代码里不再读取 DSH_PROFILE_DIR 决定写入目标',
  !codeOnly.includes('DSH_PROFILE_DIR'),
  '代码里仍出现 DSH_PROFILE_DIR'
)
check(
  '改为读取 profileContext.patchPath',
  source.includes("ctx.get('profileContext')") && source.includes('profile.patchPath'),
  '未找到 profileContext.patchPath 的用法'
)
check(
  '有 allowedFiles 白名单校验',
  source.includes('allowedFiles') && source.includes('拒绝改写非当前 profile 的文件'),
  '未找到白名单校验'
)
check(
  '写入走排他锁 + 原子写（与宿主 config-editor 互斥）',
  source.includes('withExclusiveLock(') && source.includes('writeFileAtomicSync('),
  '写入未加锁或非原子'
)

console.log('\n== 解析 profile patch 路径：只认运行时事实 ==')

{
  const { resolveProfilePatchPath } = await import('./index.js')
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const d = mkdtempSync(join(tmpdir(), 'mcp-resolve-'))
  try {
    mkdirSync(join(d, 'profile'), { recursive: true })
    const real = join(d, 'profile', 'cordis.patch.yml')
    writeFileSync(real, '[]\n')

    const fake = (profile) => ({ get: (n) => (n === 'profileContext' ? profile : undefined), loader: { *entries() {} } })
    check('1) profileContext.patchPath 可解析', resolveProfilePatchPath(fake({ patchPath: real })) === real)
    check('2) profileContext.dir + 文件名可解析', resolveProfilePatchPath(fake({ dir: join(d, 'profile') })) === real)
    check(
      '3) 从 include 树 baseUrl 可解析',
      resolveProfilePatchPath({
        get: () => undefined,
        loader: { *entries() { yield { subtree: { ctx: { baseUrl: `${join(d, 'profile')}/` } } } } },
      }) === real
    )
    check('4) 无法确定时返回 undefined（拒绝执行）', resolveProfilePatchPath(fake(undefined)) === undefined)

    // 最关键：只有环境变量指向它时，仍然拒绝（事故的直接护栏）
    const prev = process.env.DSH_PROFILE_DIR
    process.env.DSH_PROFILE_DIR = join(d, 'profile')
    check(
      '5) 只有 DSH_PROFILE_DIR 时仍拒绝（事故护栏）',
      resolveProfilePatchPath(fake(undefined)) === undefined,
      '仍会跟随环境变量！'
    )
    if (prev === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = prev
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
}

console.log('\n== 行为断言：白名单外一律拒绝 ==')

// 用真实的 apply() + mock ctx 跑一遍 adopt，目标文件放在「白名单之外」
const { apply } = await import('./index.js')
const { dumpEntryList } = await import('./yaml.js')

function makeCtx({ patchPath, dataFile, entries }) {
  const handlers = new Map()
  return {
    loader: {
      *entries() {
        for (const entry of entries) yield entry
      },
    },
    get(name) {
      return name === 'profileContext' ? { patchPath } : undefined
    },
    tools: { schemas: () => [] },
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect: (callback) => {
      const disposer = callback()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    on: () => () => {},
    connection: {
      rpc: {
        handle(channel, handler) {
          handlers.set(channel, handler)
          return async () => handlers.delete(channel)
        },
      },
    },
    __handlers: handlers,
  }
}

/** 造一个「外部 MCP 行」entry（不在本插件 include 子树内）。 */
function externalEntry(id, serverName) {
  return {
    id,
    options: {
      id,
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName, transport: 'streamable-http', url: 'http://127.0.0.1:1/x' },
    },
    parent: { tree: { ctx: { fiber: { entry: { id: 'include' } } } } },
    fiber: { state: 2 },
  }
}

async function call(ctx, endpoint, payload) {
  const handler = ctx.__handlers.get('/mcp-hub')
  return await handler(endpoint, payload)
}

const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const dir = mkdtempSync(join(tmpdir(), 'mcp-adopt-path-'))
try {
  const dataFile = join(dir, 'mcp-hub.yml')
  const realPatch = join(dir, 'profile', 'cordis.patch.yml')
  const foreignPatch = join(dir, 'elsewhere', 'cordis.patch.yml')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(dir, 'profile'), { recursive: true })
  mkdirSync(join(dir, 'elsewhere'), { recursive: true })

  const ROW = (id, name) =>
    `- insert:\n    - id: ${id}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: ${name}\n        transport: streamable-http\n        url: http://127.0.0.1:1/x\n`
  writeFileSync(realPatch, ROW('mcp-in-profile', 'inprofile'), 'utf8')
  writeFileSync(foreignPatch, ROW('mcp-in-foreign', 'inforeign'), 'utf8')
  writeFileSync(dataFile, '[]\n', 'utf8')

  // 环境变量故意指向「别处」，profileContext 指向正确位置
  process.env.DSH_PROFILE_DIR = join(dir, 'elsewhere')

  const ctx = makeCtx({
    patchPath: realPatch,
    dataFile,
    entries: [
      { id: 'mcp-hub', options: { id: 'mcp-hub', name: '@yyh/dsh-mcp-hub' }, parent: { tree: { ctx: { fiber: { entry: { id: 'include' } } } } }, fiber: { state: 2 } },
      {
        id: 'mcp-hub-servers',
        options: { id: 'mcp-hub-servers', name: 'cordis:include', config: { path: dataFile } },
        parent: { tree: { ctx: { fiber: { entry: { id: 'include' } } } } },
        subtree: {
          filename: dataFile,
          async refresh() {},
          root: {
            data: [],
            async update(rows) {
              this.data = rows
            },
          },
          write() {},
          // 真实 Include 在 flushWrite 时把树落盘；mock 也要落盘，
          // 否则「接管后的行是否写进数据文件」就测不出来。
          async flushWrite() {
            writeFileSync(dataFile, dumpEntryList(this.root.data ?? []))
          },
        },
        fiber: { state: 2 },
      },
      externalEntry('mcp-in-profile', 'inprofile'),
      externalEntry('mcp-in-foreign', 'inforeign'),
    ],
  })
  apply(ctx, { dataFile })

  const dry = await call(ctx, 'adopt', { ids: ['mcp-in-profile'], dryRun: true })
  check('dryRun 成功', dry.ok === true, JSON.stringify(dry).slice(0, 160))
  check(
    '来源文件来自 profileContext（不是环境变量指向的别处）',
    dry.value.files.length === 1 && dry.value.files[0] === realPatch,
    JSON.stringify(dry.value.files)
  )
  check(
    '环境变量指向的文件不在候选里',
    !dry.value.files.includes(foreignPatch),
    JSON.stringify(dry.value.files)
  )
  check('白名单只含 profileContext 的文件', !dry.value.allowedFiles.includes(foreignPatch), JSON.stringify(dry.value.allowedFiles))

  // 真实执行：只应改动 profileContext 给出的那个文件
  const before = readFileSync(realPatch, 'utf8')
  const foreignBefore = readFileSync(foreignPatch, 'utf8')
  const done = await call(ctx, 'adopt', { ids: ['mcp-in-profile'] })
  check('接管成功', done.ok === true, JSON.stringify(done).slice(0, 160))
  check('profileContext 指向的文件被改（目标行移除）', !readFileSync(realPatch, 'utf8').includes('mcp-in-profile'))
  check('备份已生成', (done.value.backups ?? []).length === 1 && done.value.backups[0].startsWith(realPatch))
  check(
    '环境变量指向的文件【一个字节都没动】',
    readFileSync(foreignPatch, 'utf8') === foreignBefore,
    '别处的文件被改动了！'
  )
  check('接管来的行进了本插件的数据文件', readFileSync(dataFile, 'utf8').includes('inprofile'))

  // 清理环境变量，避免影响后续
  delete process.env.DSH_PROFILE_DIR
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} 通过`)
if (failures > 0) process.exitCode = 1
