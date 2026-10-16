/**
 * 回归测试：数据文件的位置必须让它解析到**与运行时匹配**的
 * `@deepseek-ai/dsh-mcp-client`。
 *
 * 真实事故（本测试就是为它写的）：
 * 数据文件原本放在 `<DSH_HOME>/mcp-hub.yml`。dsh 启动时的兼容性预检会
 * **从声明该行的文件自身**向上解析裸包名：
 *
 *     createRequire(pathToFileURL(<include 文件>)).resolve.paths('@deepseek-ai/dsh-mcp-client')
 *
 * `<DSH_HOME>` 的父目录是用户工作区；那里若残留一份旧 dsh 安装（例如
 * `/home/yyh/package.json` 里 `@deepseek-ai/dsh: ^0.1.2-rc.1`），就命中旧版
 * `dsh-mcp-client@0.1.2-rc.1`。运行时是 0.2.0-rc.2，peer 校验失败，dsh 于是
 * **整体禁用该 include**：
 *
 *     disabling profile plugin row "mcp-hub-servers": its included file
 *     .../mcp-hub.yml reaches an incompatible plugin, and that file is never rewritten
 *
 * 症状是：文件写得进去、面板也能列出来，但里面的服务器重启后不会被挂载。
 *
 * 运行：node lib/datafile-path.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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

const source = await import('node:fs').then((fs) =>
  fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
)

console.log('== 静态断言 ==')

check(
  'bundle 的 include 行用 config 同目录的相对路径（./mcp-hub.yml）',
  source.length > 0 &&
    (await import('node:fs'))
      .readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
      .includes("path: './mcp-hub.yml'"),
  'include 的 path 不是 ./mcp-hub.yml'
)
check(
  'resolveDataFile 接受 profileDir 参数',
  /resolveDataFile\(configured, profileDir\)/.test(source),
  'resolveDataFile 未接收 profileDir'
)
check(
  'apply() 从 profileContext.dir 取 profile 目录',
  /ctx\.get\('profileContext'\)/.test(source) && /profile\.dir/.test(source),
  '未从 profileContext.dir 取目录'
)
// 注释里提到 profiles/web 是说明性的（指出旧方案），只断言**代码**不含硬编码。
const codeLines = source
  .split('\n')
  .filter((line) => !/^\s*(\*|\/\/)/.test(line))
  .join('\n')
check(
  '代码不硬编码 profiles/web（不钉死单个 profile）',
  !codeLines.includes('profiles/web'),
  '代码里仍然硬编码了 profiles/web'
)
check(
  'bundle 的 patch 不硬编码 profiles/web',
  !(await import('node:fs'))
    .readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    .includes('profiles/web'),
  'patch 里硬编码了 profiles/web'
)

console.log('\n== 行为断言：路径解析 ==')

const { resolveDataFile } = await import('./index.js')

check(
  '显式 dataFile 优先',
  resolveDataFile('/tmp/explicit.yml', '/tmp/profile') === '/tmp/explicit.yml'
)
check(
  '有 profileDir 时落在 profile 目录内（与 include 的 ./mcp-hub.yml 对齐）',
  resolveDataFile(undefined, '/tmp/profile') === join('/tmp/profile', 'mcp-hub.yml'),
  resolveDataFile(undefined, '/tmp/profile')
)
check(
  '没有 profileDir 时回退到 DSH_HOME',
  resolveDataFile(undefined, undefined).endsWith('mcp-hub.yml') &&
    resolveDataFile(undefined, undefined).includes('.dsh'),
  resolveDataFile(undefined, undefined)
)
check('空字符串 profileDir 视为未提供', resolveDataFile(undefined, '  ') === resolveDataFile(undefined, undefined))

console.log('\n== 行为断言：位置决定了解析到哪个版本的 mcp-client ==')

// 复刻「工作区里有旧 dsh 安装」的布局，证明位置的影响
const workspace = mkdtempSync(join(tmpdir(), 'mcp-datafile-'))
try {
  const dshHome = join(workspace, 'dsh-home')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })

  // 旧 dsh 安装：<workspace>/node_modules/<pkg>/package.json（版本 0.1.2-rc.1）
  const pkg = '@deepseek-ai/dsh-mcp-client'
  const oldPkgDir = join(workspace, 'node_modules', pkg)
  mkdirSync(oldPkgDir, { recursive: true })
  writeFileSync(join(oldPkgDir, 'package.json'), JSON.stringify({ name: pkg, version: '0.1.2-rc.1' }))

  // 与运行时匹配的安装：<dshHome>/profiles/node_modules/<pkg>（版本 0.2.0-rc.2）
  const goodPkgDir = join(dshHome, 'profiles', 'node_modules', pkg)
  mkdirSync(goodPkgDir, { recursive: true })
  writeFileSync(join(goodPkgDir, 'package.json'), JSON.stringify({ name: pkg, version: '0.2.0-rc.2' }))

  const fs = await import('node:fs')

  /** 复刻 dsh 的解析方式：从声明该行的文件 URL 向上找 node_modules。 */

  const versionAt = (file) => {
    try {
      for (const base of createRequire(pathToFileURL(file)).resolve.paths(pkg)) {
        const candidate = join(base, pkg, 'package.json')
        if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf8')).version
      }
      return undefined
    } catch {
      return undefined
    }
  }

  const oldLocation = join(dshHome, 'mcp-hub.yml')
  const newLocation = resolveDataFile(undefined, profileDir)
  writeFileSync(oldLocation, '[]\n')
  writeFileSync(newLocation, '[]\n')

  const versionOld = versionAt(oldLocation)
  const versionNew = versionAt(newLocation)

  check(
    '旧位置（DSH_HOME 根）会解析到工作区的旧版本',
    versionOld === '0.1.2-rc.1',
    `${oldLocation} → ${versionOld}`
  )
  check(
    '新位置（profile 目录内）解析到匹配版本',
    versionNew === '0.2.0-rc.2',
    `${newLocation} → ${versionNew}`
  )
  check(
    '两者确实解析到不同版本（这就是当年 include 被禁用的原因）',
    versionOld !== versionNew,
    `${versionOld} vs ${versionNew}`
  )
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

console.log('\n== 静态断言：旧位置数据会被迁移而不是丢弃 ==')

check(
  'ensureDataFile 含一次性迁移逻辑',
  /migrated-/.test(source) && /legacyHasRows/.test(source),
  '未见迁移逻辑'
)
check(
  '迁移时保留旧文件（改名归档而非删除）',
  /renameSync\(legacy, archived\)/.test(source),
  '旧文件被直接删除，无法回溯'
)

console.log('\n== 静态断言：与同目录的 cordis.patch.yml 不冲突 ==')

{
  const fs = await import('node:fs')
  const boot = fs.readFileSync(
    '/home/yyh/.config/nvm/versions/node/v26.8.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
    'utf8'
  )
  // dsh 按确切文件名读 patch 层，不扫目录
  check(
    'dsh 的 readProfilePatches 按确切文件名读层（不 glob 目录）',
    /join\(context\.home, "cordis\.patch\.yml"\)/.test(boot) && /context\.patchPath/.test(boot),
    '未见按文件名读取的证据'
  )
  // profile 目录里只应有这两处 readdirSync，且都与 patch 无关
  const readdirs = [...boot.matchAll(/readdirSync\(([^)]*)/g)].map((m) => m[1])
  const patchRelated = readdirs.filter((arg) => /profile|patch|cordis/i.test(arg))
  check(
    '没有任何 readdirSync 针对 profile/patch 目录做扫描',
    patchRelated.length === 0,
    JSON.stringify(patchRelated)
  )
  check(
    '数据文件名 mcp-hub.yml 与 PROFILE_PATCH_FILENAME 不同名',
    'mcp-hub.yml' !== 'cordis.patch.yml'
  )
}

console.log(`\n${checks - failures}/${checks} 通过`)
if (failures > 0) process.exitCode = 1
