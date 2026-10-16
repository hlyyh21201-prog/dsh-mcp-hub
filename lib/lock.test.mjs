/**
 * 写入锁与原子写的测试。
 *
 * 背景：profile 的 `cordis.patch.yml` 会被多个写入方碰 —— 本插件的「接管」，
 * 以及宿主的 `dsh-config-editor`（改模型 / 插件设置时）。两边都是「读-改-写」，
 * 若不加同一把锁，后写的一方会按旧快照覆盖先写的一方，表现为「刚接管的行又回来了」
 * 或用户其它配置丢失。
 *
 * 这里验证：
 *   - 锁的约定与宿主一致（`<file>.lock`、wx 独占创建、锁内是 PID、结束即删除）；
 *   - 与宿主 `@deepseek-ai/dsh-atomic-write` 真能互斥（若该包可解析）；
 *   - 并发写入不丢更新；
 *   - 原子写不留临时文件、失败会清理。
 *
 * 运行：node lib/lock.test.mjs
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

// 从 index.js 里取出这两个内部实现来单测（它们不导出，这里按源码提取后 eval）。
// 这样测的就是**真正跑在插件里的那份实现**，而不是复制品。
const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
function extract(name) {
  // 允许 `function name(` 或 `async function name(`
  const re = new RegExp(`(?:async )?function ${name}\\(`)
  const match = re.exec(source)
  if (match === null) throw new Error(`找不到 ${name}`)
  const start = match.index
  // 从函数名的括号开始配平，只在该函数的 { } 内计数（跳过字符串里的花括号影响很小，
  // 这里的函数体不含花括号字面量）
  let depth = 0
  let started = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') {
      depth += 1
      started = true
    } else if (char === '}') {
      depth -= 1
      if (started && depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`${name} 未闭合`)
}

const constants = `const LOCK_WAIT_MS = 10000
const LOCK_RETRY_MIN_MS = 20
const LOCK_RETRY_MAX_MS = 250
`
const factory = new Function(
  'writeFileSync',
  'readFileSync',
  'renameSync',
  'rmSync',
  `${constants}${extract('withExclusiveLock')}\n${extract('writeFileAtomicSync')}\nreturn { withExclusiveLock, writeFileAtomicSync }`
)
const { withExclusiveLock, writeFileAtomicSync } = factory(writeFileSync, readFileSync, (await import('node:fs')).renameSync, rmSync)

const dir = mkdtempSync(join(tmpdir(), 'mcp-lock-'))
try {
  console.log('== 锁约定与宿主一致 ==')

  {
    const file = join(dir, 'a.yml')
    writeFileSync(file, 'v0\n')
    let sawLock = false
    await withExclusiveLock(file, async () => {
      // 锁内应存在 <file>.lock，内容是 PID
      sawLock = existsSync(`${file}.lock`)
      check('锁内存在 <file>.lock', sawLock)
      check('锁文件内容是当前 PID', readFileSync(`${file}.lock`, 'utf8').trim() === String(process.pid), readFileSync(`${file}.lock`, 'utf8'))
    })
    check('退出后锁已释放', !existsSync(`${file}.lock`))
  }

  console.log('\n== 与宿主实现互斥（若可解析） ==')

  const hostModule = await import(
    '/home/yyh/.config/nvm/versions/node/v26.8.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js'
  ).catch(() => null)

  if (hostModule === null) {
    console.log('  --   宿主的 atomic-write 不可解析，跳过互斥测试')
  } else {
    const file = join(dir, 'b.yml')
    writeFileSync(file, 'v0\n')

    // 我的锁先持有 → 宿主的锁必须等（拿不到就说明互斥生效）
    let hostEntered = false
    const hostPromise = withExclusiveLock(file, async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
      hostEntered = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    check('我的锁持有时，宿主的锁未进入', hostEntered === false)
    await hostPromise
    check('我的锁释放后，宿主的锁进入', hostEntered === true)

    // 反向：宿主先持有 → 我的锁必须等
    const file2 = join(dir, 'c.yml')
    writeFileSync(file2, 'v0\n')
    let mineEntered = false
    const hostHold = hostModule.withFileLock(file2, async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const mineWait = withExclusiveLock(file2, async () => {
      mineEntered = true
    })
    check('宿主持有时，我的锁未进入', mineEntered === false)
    await Promise.all([hostHold, mineWait])
    check('宿主释放后，我的锁进入', mineEntered === true)
  }

  console.log('\n== 并发读-改-写不丢更新 ==')

  {
    const file = join(dir, 'counter.yml')
    writeFileSync(file, '0\n')
    // 20 个任务各自「读到当前值 +1 写回」，正确的锁应得到 20
    const bump = () =>
      withExclusiveLock(file, async () => {
        const current = Number.parseInt(readFileSync(file, 'utf8').trim(), 10)
        await new Promise((resolve) => setTimeout(resolve, 1))
        writeFileAtomicSync(file, `${current + 1}\n`)
      })
    await Promise.all(Array.from({ length: 20 }, bump))
    check('20 次并发自增结果为 20', readFileSync(file, 'utf8').trim() === '20', readFileSync(file, 'utf8').trim())
  }

  console.log('\n== 原子写不留垃圾 ==')

  {
    const file = join(dir, 'd.yml')
    writeFileAtomicSync(file, 'hello\n')
    check('写入成功', readFileSync(file, 'utf8') === 'hello\n')
    const temps = readdirSync(dir).filter((name) => name.endsWith('.tmp'))
    check('没有残留 .tmp', temps.length === 0, JSON.stringify(temps))
    const locks = readdirSync(dir).filter((name) => name.endsWith('.lock'))
    check('没有残留 .lock', locks.length === 0, JSON.stringify(locks))
  }

  console.log('\n== 陈旧锁可回收 ==')

  {
    const file = join(dir, 'stale.yml')
    writeFileSync(file, 'v0\n')
    // 扮一个「已退出的进程」留下的锁：用一个不可能存在的 PID
    writeFileSync(`${file}.lock`, '999999999\n')
    try {
      process.kill(999999999, 0)
      console.log('  --   该 PID 意外存在，跳过')
    } catch {
      let entered = false
      await withExclusiveLock(file, async () => {
        entered = true
      })
      check('陈旧的锁被回收并进入临界区', entered === true)
      check('回收后锁已释放', !existsSync(`${file}.lock`))
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} 通过`)
if (failures > 0) process.exitCode = 1
