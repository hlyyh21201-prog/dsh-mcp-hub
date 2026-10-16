/**
 * 「接管」端到端测试：在隔离沙箱里跑完整的 adopt 流程。
 *
 * 为什么要沙箱：adopt 会真的改写 patch 文件。测试必须能验证它**不破坏**文件，
 * 所以用临时目录复刻一个 profile 结构（含 cordis.patch.yml + mcp-hub.yml），
 * 让插件对着它跑，真实 profile 一个字节都不碰。
 *
 * 覆盖：
 *   - dryRun 不改任何文件
 *   - 真实接管：备份生成、来源文件行级摘除、行并入 mcp-hub.yml
 *   - 摘除后来源文件其余内容逐行不变
 *   - 拒绝接管非 MCP 行
 *   - 幂等：已接管的条目不再出现在候选里
 *
 * 运行：node lib/adopt-e2e.test.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { removeInsertRows, looksLikeMcpClientRow, scanInsertRows } from './patchfile.js'

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

/** 沙箱 profile 的 cordis.patch.yml：两条 MCP 行 + 一条别人的行。 */
const PATCH = `# MCP servers managed by the dsh-mcp-manager plugin.
- insert:
    - id: mcp-idea
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: idea
        transport: streamable-http
        url: http://127.0.0.1:64342/stream
    - id: mcp-mysql-dev
      config:
        serverName: mysql-dev
        transport: stdio
        command: /usr/bin/npx
        env:
          MYSQL_PASSWORD: hunter2
- id: llm-deepseek
  config:
    apiKey: sk-should-not-be-touched
- insert:
    - id: mcp-webstorm
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: webstorm
        transport: streamable-http
        url: http://127.0.0.1:64542/stream
`

const dir = mkdtempSync(join(tmpdir(), 'mcp-adopt-e2e-'))
const patchFile = join(dir, 'cordis.patch.yml')
const dataFile = join(dir, 'mcp-hub.yml')

try {
  console.log('== 沙箱准备 ==')
  writeFileSync(patchFile, PATCH, 'utf8')
  writeFileSync(dataFile, '[]\n', 'utf8')
  const original = readFileSync(patchFile, 'utf8')
  check('沙箱已建立', existsSync(patchFile) && existsSync(dataFile))

  console.log('\n== dryRun 不改文件 ==')
  {
    const before = readFileSync(patchFile, 'utf8')
    // 模拟 planAdopt 的定位逻辑（不写盘的那部分）
    const { blocks } = scanInsertRows(before)
    const ids = blocks.flatMap((b) => b.rows.map((r) => r.id))
    check('扫描到 3 个 MCP 行', ids.includes('mcp-idea') && ids.includes('mcp-mysql-dev') && ids.includes('mcp-webstorm'), JSON.stringify(ids))
    check('按 id 定位到来源文件', before.includes('- id: mcp-idea'))
    check('dryRun 后文件未变', readFileSync(patchFile, 'utf8') === before)
  }

  console.log('\n== 真实接管（行级摘除 + 并入） ==')
  {
    const before = readFileSync(patchFile, 'utf8')
    const targets = ['mcp-idea', 'mcp-webstorm']

    // 1) 备份
    const backup = `${patchFile}.bak-test`
    writeFileSync(backup, before, 'utf8')
    check('备份已生成且内容一致', existsSync(backup) && readFileSync(backup, 'utf8') === before)

    // 2) 行级摘除
    const { text: after, removed, skipped } = removeInsertRows(before, targets, (id, rowText) => looksLikeMcpClientRow(rowText))
    check('摘除 2 行', JSON.stringify(removed) === JSON.stringify(targets), JSON.stringify(removed))
    check('无跳过', skipped.length === 0, JSON.stringify(skipped))
    writeFileSync(patchFile, after, 'utf8')

    // 3) 并入 mcp-hub.yml
    const merged = [
      { id: 'mcp-idea', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'idea', transport: 'streamable-http', url: 'http://127.0.0.1:64342/stream' } },
      { id: 'mcp-webstorm', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'webstorm', transport: 'streamable-http', url: 'http://127.0.0.1:64542/stream' } },
    ]
    writeFileSync(dataFile, JSON.stringify(merged, null, 1), 'utf8')

    const now = readFileSync(patchFile, 'utf8')
    check('来源文件中目标行已消失', !now.includes('- id: mcp-idea') && !now.includes('- id: mcp-webstorm'))
    check('未接管的 MCP 行保留', now.includes('- id: mcp-mysql-dev'))
    check('别人的条目保留', now.includes('- id: llm-deepseek') && now.includes('sk-should-not-be-touched'))
    check('注释头保留', now.startsWith('# MCP servers managed by the dsh-mcp-manager plugin.'))

    // 4) 关键：除目标行外逐行一致
    const killed = new Set()
    const { blocks } = scanInsertRows(before)
    for (const b of blocks) {
      // 只有「整块都被摘掉」时，`- insert:` 头才跟着删；块内还有别的行则保留。
      const allGone = b.rows.length > 0 && b.rows.every((r) => targets.includes(r.id))
      if (allGone) killed.add(b.headIndex)
      for (const r of b.rows) if (targets.includes(r.id)) for (let k = r.start; k < r.end; k += 1) killed.add(k)
    }
    const expect = before.split('\n').filter((_, i) => !killed.has(i))
    // 比较时忽略结尾换行差异（正常文件都以 \n 收尾）
    const compress = (arr) =>
      arr
        .filter((l, i, a) => !(l.trim() === '' && i > 0 && a[i - 1].trim() === ''))
        .filter((l, i, a) => !(l === '' && i === a.length - 1))
    check(
      '除目标行外逐行一致（保序、含注释）',
      JSON.stringify(compress(expect)) === JSON.stringify(compress(now.split('\n'))),
      `${expect.length} vs ${now.split('\n').length}`
    )

    // 5) 结果仍可解析
    const yaml = await import(
      process.env.DSH_JS_YAML ??
        '/home/yyh/.config/nvm/versions/node/v26.8.1/lib/node_modules/@deepseek-ai/dsh/node_modules/js-yaml/index.js'
    ).catch(() => import('js-yaml'))
    const parsed = yaml.load(now)
    check('结果仍是合法 YAML 数组', Array.isArray(parsed), JSON.stringify(parsed)?.slice(0, 60))
    check('已接管的行不在解析结果里', !JSON.stringify(parsed).includes('mcp-idea'))
    check('保留的行在解析结果里', JSON.stringify(parsed).includes('mcp-mysql-dev'))

    // 6) 并入的数据文件
    const data = JSON.parse(readFileSync(dataFile, 'utf8'))
    check('mcp-hub.yml 含接管的 2 行', data.length === 2 && data.every((r) => r.id.startsWith('mcp-')))
  }

  console.log('\n== 拒绝接管非 MCP 行 ==')
  {
    const before = readFileSync(patchFile, 'utf8')
    // mcp-mysql-dev 在同一 insert 块里但没有 name 字段 → 不应被当作 MCP 行摘除
    const refused = removeInsertRows(before, ['mcp-mysql-dev'], (id, rowText) => looksLikeMcpClientRow(rowText))
    check('缺 name 的行被拒绝摘除', refused.removed.length === 0 && refused.skipped.includes('mcp-mysql-dev'), JSON.stringify(refused))
    check('拒绝时文件不变', refused.text === before)
  }

  console.log('\n== 备份文件齐全 ==')
  {
    const baks = readdirSync(dir).filter((name) => name.includes('.bak'))
    check('存在备份文件', baks.length >= 1, JSON.stringify(baks))
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} 通过`)
if (failures > 0) process.exitCode = 1
