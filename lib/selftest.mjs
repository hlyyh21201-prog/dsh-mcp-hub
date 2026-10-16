/**
 * 离线自测：用 mock ctx 驱动 Host 侧的 apply()，验证 RPC 各端点。
 *
 * 运行：node --test 或 node lib/selftest.mjs
 * 不会改动任何真实 profile 文件（数据文件用临时目录）。
 */

import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, RPC_CHANNEL } from './index.js'
import { parseEntryList, dumpEntryList } from './yaml.js'

let failures = 0
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** 最小 ctx 替身：只实现 apply() 用到的部分。 */
function makeCtx(dataFile) {
  const effects = []
  const listeners = new Map()
  const handlers = new Map()
  // 真实 Include 的接口子集：persist() 现在走 root.update + write + flushWrite
  // （由 Include 独占写文件，避免与 Loader 自己的回写抢同一个 .tmp）。
  const includeTree = {
    filename: dataFile,
    refreshCount: 0,
    writeCount: 0,
    lastData: undefined,
    async refresh() {
      this.refreshCount += 1
    },
    root: {
      data: [],
      async update(rows) {
        includeTree.lastData = rows
        this.data = rows
      },
    },
    write() {
      includeTree.writeCount += 1
    },
    async flushWrite() {
      writeFileSync(dataFile, dumpEntryList(includeTree.lastData ?? []))
    },
  }
  const entries = [
    {
      id: 'mcp-hub',
      options: { id: 'mcp-hub', name: '@yyh/dsh-mcp-hub' },
      parent: { tree: { ctx: { fiber: { entry: { id: 'include' } } } } },
      fiber: { state: 2 },
    },
    {
      id: 'mcp-hub-servers',
      options: {
        id: 'mcp-hub-servers',
        name: 'cordis:include',
        config: { path: dataFile },
      },
      parent: { tree: { ctx: { fiber: { entry: { id: 'include' } } } } },
      subtree: includeTree,
      fiber: { state: 2 },
    },
  ]

  return {
    includeTree,
    entries,
    // 宿主用 ctx.get(name) 做可选服务查询；profileContext 决定 adopt 能写哪个文件。
    get(name) {
      return name === 'profileContext' ? ctx.profileContext : undefined
    },
    loader: {
      *entries() {
        for (const entry of entries) yield entry
      },
    },
    tools: {
      schemas() {
        return [
          { name: 'mcp__idea__open_file' },
          { name: 'mcp__idea__get_project_modules' },
          { name: 'mcp__other__x' },
        ]
      },
    },
    logger() {
      return { info() {}, warn() {}, error() {} }
    },
    effect(callback, label) {
      const disposer = callback()
      effects.push({ label, disposer })
      return () => {}
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => {}
    },
    connection: {
      rpc: {
        handle(channel, handler) {
          handlers.set(channel, handler)
          return async () => handlers.delete(channel)
        },
      },
    },
    call(endpoint, payload) {
      const handler = handlers.get(RPC_CHANNEL)
      if (handler === undefined) throw new Error('RPC 通道未注册')
      return handler(endpoint, payload)
    },
    disposeAll() {
      for (const effect of effects) {
        if (typeof effect.disposer === 'function') effect.disposer()
      }
    },
  }
}

/** 模拟 include 挂载后的 loader 行同步（refresh 后由 Cordis 负责，这里手工模拟）。 */
function syncEntries(ctx, dataFile) {
  const rows = existsSync(dataFile) ? parseEntryList(readFileSync(dataFile, 'utf8')) : []
  // 保留插件行与 include 行，其余按文件内容重建
  const kept = ctx.entries.filter(
    (entry) => entry.options.name === '@yyh/dsh-mcp-hub' || entry.options.name === 'cordis:include'
  )
  ctx.entries.length = 0
  ctx.entries.push(...kept)
  for (const row of rows) {
    ctx.entries.push({
      // 真实 Loader 里子条目的 id 是 `include:<includeRowId>:<childId>`
      // （见 cordis-plugin-loader 的 `get id()`），这里必须一致，
      // 否则「该行是否属于本插件」的判断在 mock 上测不出来。
      id: `include:mcp-hub-servers:${row.id}`,
      options: row,
      parent: { tree: { ctx: { fiber: { entry: { id: 'mcp-hub-servers' } } } } },
      fiber: { state: row.disabled === true ? 4 : 2 },
      disabled: row.disabled === true,
    })
  }
}

const dir = mkdtempSync(join(tmpdir(), 'mcp-hub-selftest-'))
const dataFile = join(dir, 'mcp-hub.yml')

try {
  console.log('== Host RPC 自测 ==')
  const ctx = makeCtx(dataFile)
  apply(ctx, { dataFile })

  // 1. info
  let result = await ctx.call('info', {})
  check('info 返回成功', result.ok === true, JSON.stringify(result))
  check('info 报告 dataFile', result.value.dataFile === dataFile)
  check('info 报告已挂载', result.value.mounted === true, JSON.stringify(result.value))
  check('数据文件已自动创建', existsSync(dataFile))

  // 2. list（空）
  result = await ctx.call('list', {})
  check('list 初始为空', result.ok === true && result.value.servers.length === 0, JSON.stringify(result))

  // 3. import (dryRun) —— 必须不写盘
  const codexSample = `
[mcp_servers.idea]
type = "http"
url = "http://127.0.0.1:64342/stream"

[mcp_servers.mysql-dev]
type = "stdio"
command = "/usr/bin/npx"
args = ["-y", "mysql-mcp-server"]

[mcp_servers.mysql-dev.env]
MYSQL_HOST = "dev.example.com"
MYSQL_PASSWORD = "s3cret"
`
  result = await ctx.call('import', { text: codexSample, dryRun: true, maskSecrets: true })
  check('dryRun 解析 2 台', result.ok === true && result.value.imported.length === 2, JSON.stringify(result).slice(0, 300))
  check('dryRun 标记 dryRun', result.value.dryRun === true)
  check(
    'dryRun 隐藏密钥',
    result.value.imported.find((item) => item.config.serverName === 'mysql-dev').maskedKeys.includes('MYSQL_PASSWORD')
  )
  check('dryRun 未写盘', parseEntryList(readFileSync(dataFile, 'utf8')).length === 0)
  check('dryRun 未触发 refresh', ctx.includeTree.refreshCount === 0, String(ctx.includeTree.refreshCount))

  // 4. import（真实写入）
  result = await ctx.call('import', { text: codexSample, maskSecrets: true })
  check('import 写入 2 台', result.ok === true && result.value.imported.length === 2)
  check('import 由 Include 落盘（write + flushWrite）', ctx.includeTree.writeCount === 1, String(ctx.includeTree.writeCount))
  const written = parseEntryList(readFileSync(dataFile, 'utf8'))
  check('文件中有 2 行', written.length === 2, JSON.stringify(written))
  check('写入 id 规范', written.every((row) => /^[A-Za-z0-9_-]+$/.test(row.id)), JSON.stringify(written.map((r) => r.id)))
  const mysqlRow = written.find((row) => row.config.serverName === 'mysql-dev')
  check('密码已占位', mysqlRow.config.env.MYSQL_PASSWORD === '__DSH_MCP_HUB_SET_ME__', JSON.stringify(mysqlRow.config.env))

  // 5. 同步 loader 行后 list
  syncEntries(ctx, dataFile)
  result = await ctx.call('list', {})
  const servers = result.value.servers
  check('list 返回 2 台', servers.length === 2, JSON.stringify(servers.map((s) => s.id)))
  const idea = servers.find((server) => server.serverName === 'idea')
  check('idea 识别为 streamable-http', idea.transport === 'streamable-http', JSON.stringify(idea))
  check('idea 工具数按前缀统计', idea.toolCount === 2, String(idea.toolCount))
  check('idea 标记为 managed', idea.managed === true)
  const mysql = servers.find((server) => server.serverName === 'mysql-dev')
  check('mysql 标记需要补密钥', mysql.needsSecret === true, JSON.stringify(mysql))

  // 6. 重名导入 → 自动改名
  result = await ctx.call('import', { text: codexSample, maskSecrets: true })
  const renamed = result.value.imported.map((item) => item.config.serverName).sort()
  check('重名自动改名', renamed.includes('idea-2') && renamed.includes('mysql-dev-2'), JSON.stringify(renamed))
  check('冲突已上报', result.value.conflicts.length === 2, JSON.stringify(result.value.conflicts))
  syncEntries(ctx, dataFile)

  // 7. setEnabled 停用
  result = await ctx.call('setEnabled', { id: 'mcp-idea', enabled: false })
  check('停用成功', result.ok === true, JSON.stringify(result))
  const afterDisable = parseEntryList(readFileSync(dataFile, 'utf8'))
  check('停用写入 disabled: true', afterDisable.find((row) => row.id === 'mcp-idea').disabled === true)

  // 8. setEnabled 启用
  result = await ctx.call('setEnabled', { id: 'mcp-idea', enabled: true })
  const afterEnable = parseEntryList(readFileSync(dataFile, 'utf8'))
  check('启用移除 disabled', afterEnable.find((row) => row.id === 'mcp-idea').disabled === undefined)

  // 9. update
  result = await ctx.call('update', {
    id: 'mcp-idea',
    config: { serverName: 'idea', transport: 'streamable-http', url: 'http://127.0.0.1:9999/stream' },
  })
  check('update 成功', result.ok === true, JSON.stringify(result))
  const afterUpdate = parseEntryList(readFileSync(dataFile, 'utf8'))
  check(
    'update 写入新 URL',
    afterUpdate.find((row) => row.id === 'mcp-idea').config.url === 'http://127.0.0.1:9999/stream'
  )

  // 10. 校验失败路径
  result = await ctx.call('add', { id: 'bad id!', config: { serverName: 'x', transport: 'stdio' } })
  check('非法 id 被拒', result.ok === false && result.error.code === 'invalid-config', JSON.stringify(result))
  check('字段错误可定位', result.error.details.fields.id !== undefined)

  result = await ctx.call('add', {
    id: 'mcp-dup',
    config: { serverName: 'idea', transport: 'streamable-http', url: 'http://x/y' },
  })
  check('重名 serverName 被拒', result.ok === false && result.error.code === 'duplicate-server-name', JSON.stringify(result))

  // 11. 外部条目不可写
  ctx.entries.push({
    id: 'chrome-devtools',
    options: { id: 'chrome-devtools', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'chrome-devtools', transport: 'streamable-http', url: 'http://z/z' } },
    parent: { tree: { ctx: { fiber: { entry: { id: 'include' } } } } },
    fiber: { state: 2 },
  })
  result = await ctx.call('setEnabled', { id: 'chrome-devtools', enabled: false })
  check('外部条目拒绝启停', result.ok === false && result.error.code === 'not-managed', JSON.stringify(result))
  result = await ctx.call('list', {})
  const external = result.value.servers.find((server) => server.id === 'chrome-devtools')
  check('外部条目在列表中标记 managed=false', external !== undefined && external.managed === false)

  // 11b. 回归：外部行与本插件的行【短 id 同名】时，绝不能把外部行当成自己的
  // 真实场景：profile patch 里有 `mcp-idea`（外部），本插件也导入了一台 idea，
  // 归一化后短 id 都是 `mcp-idea`。若只比对短 id，用户自己的行会被标成
  // managed=true 并出现停用/删除按钮，误点就会删掉用户的配置。
  ctx.entries.push({
    id: 'mcp-idea',
    options: {
      id: 'mcp-idea',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'idea', transport: 'streamable-http', url: 'http://external/stream' },
    },
    parent: { tree: { ctx: { fiber: { entry: { id: 'include' } } } } },
    fiber: { state: 2 },
  })
  result = await ctx.call('list', {})
  const sameName = result.value.servers.filter((server) => server.id === 'mcp-idea')
  const ownRow = sameName.find((server) => server.managed === true)
  const foreignRow = sameName.find((server) => server.managed === false)
  check('短 id 同名时两行都列出', sameName.length === 2, JSON.stringify(sameName.map((s) => `${s.id}/${s.managed}`)))
  check('其中本插件的行 managed=true', ownRow !== undefined, JSON.stringify(sameName))
  check('其中外部的行 managed=false（不被误认领）', foreignRow !== undefined, JSON.stringify(sameName))
  check(
    '外部行的 URL 是本插件没写过的那个（确实是外部行）',
    foreignRow?.url === 'http://external/stream',
    JSON.stringify(foreignRow)
  )
  // 外部行必须拒绝写操作
  result = await ctx.call('remove', { id: 'foreign-marker' })
  check('不存在的 id 删除被拒', result.ok === false && result.error.code === 'not-managed')
  ctx.entries.splice(ctx.entries.indexOf(ctx.entries.find((e) => e.id === 'mcp-idea' && e.options.name === '@deepseek-ai/dsh-mcp-client')), 1)

  // 12. remove
  result = await ctx.call('remove', { id: 'mcp-mysql-dev' })
  check('删除成功', result.ok === true, JSON.stringify(result))
  const afterRemove = parseEntryList(readFileSync(dataFile, 'utf8'))
  check('删除后文件少一行', afterRemove.find((row) => row.id === 'mcp-mysql-dev') === undefined)

  // 13. scan
  result = await ctx.call('scan', {})
  check('scan 返回数组', result.ok === true && Array.isArray(result.value.candidates))

  // 13b. 按文件路径导入：只回传解析出的服务器，绝不回传文件原文
  const codexPath = join(dir, 'config.toml')
  writeFileSync(
    codexPath,
    [
      '# 与 MCP 无关的顶层配置，不应出现在任何返回值里',
      'model_provider = "custom"',
      'model = "gpt-5.6-terra"',
      'sandbox_mode = "danger-full-access"',
      'approval_policy = "never"',
      'TOP_SECRET_MARKER = "abcdef"',
      '',
      '[mcp_servers.fromfile]',
      'type = "http"',
      'url = "http://127.0.0.1:64342/stream"',
      '',
      '[mcp_servers.fromfile.env]',
      'MYSQL_PASSWORD = "hunter2"',
      '',
    ].join('\n')
  )

  const rowsBeforeDryRun = parseEntryList(readFileSync(dataFile, 'utf8')).length
  result = await ctx.call('import', { path: codexPath, dryRun: true, maskSecrets: true })
  check('按路径导入成功', result.ok === true, JSON.stringify(result).slice(0, 200))
  check('按路径导入解析出 1 台', result.value.imported.length === 1, JSON.stringify(result.value.imported))
  check('按路径导入识别为 toml', result.value.format === 'toml', String(result.value.format))
  check('按路径导入回传 path', result.value.path === codexPath, String(result.value.path))

  // 关键断言：返回值里不能带文件原文
  const serialized = JSON.stringify(result.value)
  check('返回值不含文件原文（model_provider）', !serialized.includes('model_provider'), serialized.slice(0, 200))
  check('返回值不含无关顶层值（model =）', !serialized.includes('gpt-5.6-terra'), serialized.slice(0, 200))
  check('返回值不含 sandbox_mode', !serialized.includes('sandbox_mode'), serialized.slice(0, 200))
  check('返回值不含顶层明文密钥', !serialized.includes('TOP_SECRET_MARKER'), serialized.slice(0, 200))
  check('返回值不含未掩码的密码', !serialized.includes('hunter2'), serialized.slice(0, 200))
  // 远程传输不支持 env：必须显式告警，而不是静默丢弃
  check(
    '远程传输的 env 被忽略时给出告警',
    (result.value.warnings ?? []).some((w) => w.includes('MYSQL_PASSWORD') && w.includes('env')),
    JSON.stringify(result.value.warnings)
  )
  check(
    '被忽略的敏感键记为 maskedKeys（提示用户去别处配置）',
    result.value.imported[0].maskedKeys.includes('MYSQL_PASSWORD'),
    JSON.stringify(result.value.imported[0].maskedKeys)
  )
  check(
    '远程传输不写入 env 字段',
    result.value.imported[0].config.env === undefined,
    JSON.stringify(result.value.imported[0].config)
  )
  check(
    'dryRun 未写盘（行数不变）',
    result.value.dryRun === true &&
      parseEntryList(readFileSync(dataFile, 'utf8')).length === rowsBeforeDryRun,
    `${parseEntryList(readFileSync(dataFile, 'utf8')).length} vs ${rowsBeforeDryRun}`
  )

  // 按路径真实导入
  result = await ctx.call('import', { path: codexPath, maskSecrets: true })
  check('按路径真实导入成功', result.ok === true && result.value.reload === 'include', JSON.stringify(result).slice(0, 200))
  syncEntries(ctx, dataFile)
  const fromFileList = await ctx.call('list', {})
  const fromFileServer = fromFileList.value.servers.find((server) => server.serverName === 'fromfile')
  check('按路径导入的条目已挂载', fromFileServer !== undefined, JSON.stringify(fromFileList.value.servers.map((s) => s.serverName)))
  check(
    '远程条目不会被误标「待补密钥」（env 对该传输本就无效，已用告警告知）',
    fromFileServer?.needsSecret === false,
    JSON.stringify(fromFileServer)
  )

  // stdio + env 的文件路径导入：这次 env 应当保留并被掩码
  const stdioPath = join(dir, 'stdio.toml')
  writeFileSync(
    stdioPath,
    [
      '[mcp_servers.stdb]',
      'type = "stdio"',
      'command = "npx"',
      'args = ["-y", "mysql-mcp-server"]',
      '',
      '[mcp_servers.stdb.env]',
      'MYSQL_HOST = "dev.example.com"',
      'MYSQL_PASSWORD = "topsecret"',
      '',
    ].join('\n')
  )
  const stdioResult = await ctx.call('import', { path: stdioPath, dryRun: true, maskSecrets: true })
  check('stdio 文件路径导入成功', stdioResult.ok === true, JSON.stringify(stdioResult).slice(0, 200))
  check(
    'stdio 的 env 被保留并掩码',
    stdioResult.value.imported[0].config.env.MYSQL_PASSWORD === '__DSH_MCP_HUB_SET_ME__',
    JSON.stringify(stdioResult.value.imported[0].config.env)
  )
  check(
    'stdio 的非敏感 env 原样保留',
    stdioResult.value.imported[0].config.env.MYSQL_HOST === 'dev.example.com',
    JSON.stringify(stdioResult.value.imported[0].config.env)
  )
  check('stdio 返回值不含明文密码', !JSON.stringify(stdioResult.value).includes('topsecret'))
  await ctx.call('remove', { id: 'mcp-fromfile' })
  syncEntries(ctx, dataFile)

  // 13c. 勾选导入：only 只导入被勾中的，未勾中的不占名字
  const pickSource = [
    '[mcp_servers.pickA]',
    'type = "http"',
    'url = "http://127.0.0.1:1/a"',
    '',
    '[mcp_servers.pickB]',
    'type = "http"',
    'url = "http://127.0.0.1:1/b"',
    '',
  ].join('\n')

  const previewAll = await ctx.call('import', { text: pickSource, dryRun: true })
  check('预览列出全部 2 条', previewAll.value.imported.length === 2, JSON.stringify(previewAll.value.imported.map((i) => i.sourceName)))
  check('默认全部标记 selected', previewAll.value.imported.every((i) => i.selected === true))

  const onlyA = await ctx.call('import', { text: pickSource, dryRun: true, only: ['pickA'] })
  check('only=["pickA"] 时 preview 仍列出 2 条（供界面显示）', onlyA.value.imported.length === 2)
  check(
    'only=["pickA"] 时只有 pickA 标 selected',
    onlyA.value.imported.filter((i) => i.selected === true).map((i) => i.sourceName).join(',') === 'pickA',
    JSON.stringify(onlyA.value.imported.map((i) => `${i.sourceName}:${i.selected}`))
  )
  check(
    'only 生效时 selected 集合只含 pickA',
    onlyA.value.selected.length === 1 && onlyA.value.selected[0].sourceName === 'pickA',
    JSON.stringify(onlyA.value.selected.map((i) => i.sourceName))
  )

  // 真实导入只写勾中的那条（注意此前步骤已往文件里写过行，用增量判断）
  const beforePick = parseEntryList(readFileSync(dataFile, 'utf8')).length
  const wroteA = await ctx.call('import', { text: pickSource, only: ['pickA'] })
  check('勾选导入成功', wroteA.ok === true && wroteA.value.reload === 'include', JSON.stringify(wroteA).slice(0, 200))
  await syncEntries(ctx, dataFile)
  const afterPick = parseEntryList(readFileSync(dataFile, 'utf8'))
  check(
    '只新增勾中的 1 行',
    afterPick.length === beforePick + 1 && afterPick.some((row) => row.id === 'mcp-pickA'),
    `before=${beforePick} after=${afterPick.length} ids=${afterPick.map((r) => r.id)}`
  )
  check('未勾中的 pickB 未写入', !afterPick.some((row) => row.id === 'mcp-pickB'))

  // 未勾中的条目不应占用名字：再单独导入 pickB 应仍是 pickB（不是 pickB-2）
  const wroteB = await ctx.call('import', { text: pickSource, only: ['pickB'] })
  await syncEntries(ctx, dataFile)
  const afterBoth = parseEntryList(readFileSync(dataFile, 'utf8'))
  const serverNamesWritten = afterBoth.map((row) => row.config.serverName)
  // 关键：pickB 应当拿到自己的名字，而不是因为「pickA 那次导入」被顶成 pickB-2
  check(
    '未勾中的条目不占用 serverName（pickB 仍是 pickB）',
    serverNamesWritten.includes('pickB') && !serverNamesWritten.includes('pickB-2'),
    JSON.stringify(serverNamesWritten)
  )
  await ctx.call('remove', { id: 'mcp-pickA' })
  await ctx.call('remove', { id: 'mcp-pickB' })
  await syncEntries(ctx, dataFile)
  const afterCleanup = parseEntryList(readFileSync(dataFile, 'utf8'))
  check(
    '清理后回到导入前的行数',
    afterCleanup.length === beforePick,
    `${afterCleanup.length} vs ${beforePick}`
  )

  // 缺 path / 不存在路径
  result = await ctx.call('import', { dryRun: true })
  check('既无 text 也无 path 报 invalid-payload', result.ok === false && result.error.code === 'invalid-payload', JSON.stringify(result))
  result = await ctx.call('import', { path: join(dir, 'nope.toml'), dryRun: true })
  check('路径不存在报 not-found', result.ok === false && result.error.code === 'not-found', JSON.stringify(result))

  // 13d. restart：停用再启用，逼 Loader 重建 fiber
  const beforeRestart = parseEntryList(readFileSync(dataFile, 'utf8')).length
  const addForRestart = await ctx.call('add', { id: 'mcp-restart-me', config: { serverName: 'restartme', transport: 'streamable-http', url: 'http://127.0.0.1:1/r' } })
  check('restart 用例：条目已添加', addForRestart.ok === true, JSON.stringify(addForRestart).slice(0, 200))
  await syncEntries(ctx, dataFile)

  const r1 = await ctx.call('restart', { id: 'mcp-restart-me' })
  check('restart 成功', r1.ok === true, JSON.stringify(r1).slice(0, 200))
  check('restart 走 include 重载', r1.value.reload === 'include', String(r1.value.reload))
  check('restart 报告原状态为启用', r1.value.wasDisabled === false)
  const afterRestart = parseEntryList(readFileSync(dataFile, 'utf8'))
  const restartRow = afterRestart.find((row) => row.id === 'mcp-restart-me')
  check('restart 后条目仍在且已启用', restartRow !== undefined && restartRow.disabled !== true, JSON.stringify(restartRow))

  // 停用的条目 restart 应把它启用
  await ctx.call('setEnabled', { id: 'mcp-restart-me', enabled: false })
  await syncEntries(ctx, dataFile)
  check(
    'restart 前条目确为停用',
    parseEntryList(readFileSync(dataFile, 'utf8')).find((row) => row.id === 'mcp-restart-me').disabled === true
  )
  const r2 = await ctx.call('restart', { id: 'mcp-restart-me' })
  check('停用条目 restart 成功', r2.ok === true && r2.value.wasDisabled === true, JSON.stringify(r2).slice(0, 200))
  check(
    '停用条目 restart 后已启用',
    parseEntryList(readFileSync(dataFile, 'utf8')).find((row) => row.id === 'mcp-restart-me').disabled !== true
  )

  // 边界：未知 id / 外部条目
  const r3 = await ctx.call('restart', { id: 'does-not-exist' })
  check('restart 未知 id 报 not-managed', r3.ok === false && r3.error.code === 'not-managed', JSON.stringify(r3))
  const r4 = await ctx.call('restart', { id: 'chrome-devtools' })
  check('restart 外部条目被拒', r4.ok === false && r4.error.code === 'not-managed', JSON.stringify(r4))

  await ctx.call('remove', { id: 'mcp-restart-me' })
  await syncEntries(ctx, dataFile)
  check(
    'restart 用例清理完成',
    parseEntryList(readFileSync(dataFile, 'utf8')).length === beforeRestart,
    `${parseEntryList(readFileSync(dataFile, 'utf8')).length} vs ${beforeRestart}`
  )

  // 14. probe 未知 id
  result = await ctx.call('probe', { id: 'does-not-exist' })
  check('probe 未知 id 报 not-found', result.ok === false && result.error.code === 'not-found')

  // 15. 未知端点
  result = await ctx.call('nope', {})
  check('未知端点被拒', result.ok === false && result.error.code === 'unknown-endpoint')

  // 16. JSON 变体导入（用户给出的三种）
  const variants = [
    '{"mcpServers":{"idea":{"enabled":true,"type":"remote","url":"http://127.0.0.1:64342/stream"}}}',
    '{"idea":{"url":"http://127.0.0.1:64342/stream","type":"http"}}',
    '{"servers":{"idea":{"type":"http","url":"http://127.0.0.1:64342/stream"}}}',
  ]
  for (const [index, text] of variants.entries()) {
    const parsed = await ctx.call('import', { text, dryRun: true })
    check(
      `JSON 变体 ${index + 1} 解析为 streamable-http`,
      parsed.ok === true && parsed.value.imported.length === 1 && parsed.value.imported[0].config.transport === 'streamable-http',
      JSON.stringify(parsed).slice(0, 200)
    )
  }

  // 17. 损坏输入
  result = await ctx.call('import', { text: '{{{ not json', dryRun: true, format: 'json' })
  check('损坏输入报错而非崩溃', result.ok === false || result.value.imported.length === 0, JSON.stringify(result).slice(0, 200))

  // 18. 文件权限
  const mode = statSync(dataFile).mode & 0o777
  check('数据文件权限为 0600', mode === 0o600, mode.toString(8))

  ctx.disposeAll()
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} 通过`)
if (failures > 0) process.exitCode = 1
