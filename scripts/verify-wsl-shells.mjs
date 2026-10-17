/**
 * WSL 探测纯逻辑回归：UTF-16 解析、verbose → quiet 回退、启动 argv 与并发调度。
 * 用法：node scripts/verify-wsl-shells.mjs（Node 24 直接跑 TS）
 */
import {
  WslProbeScheduler,
  parseWslQuiet,
  parseWslVerbose,
  probeWslDistros,
  wslLaunchSpec
} from '../src/main/local/wsl.ts'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}
const utf16 = (text) => Buffer.from(text, 'utf16le')
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// 1. verbose：不依赖表头语言，保留名称中的单个空格，识别默认标记与状态
{
  const input = utf16(
    '﻿  名称              状态          版本\r\n' +
      '* Ubuntu 24.04 Test   Running       2\r\n' +
      '  Debian            Stopped       2\r\n' +
      '  自定义发行版       Installing     2\r\n\0'
  )
  const list = parseWslVerbose(input)
  check('verbose 解析全部发行版', list.length === 3, JSON.stringify(list))
  check('名称中的单个空格保留', list[0]?.distro === 'Ubuntu 24.04 Test')
  check('默认星标与 Running', list[0]?.isDefault === true && list[0]?.state === 'running')
  check('Stopped 与非默认', list[1]?.isDefault === false && list[1]?.state === 'stopped')
  check('未知状态不猜成 stopped', list[2]?.state === 'unknown')
}

// 2. quiet：只返回名称，由探测层补 unknown
{
  const names = parseWslQuiet(utf16('﻿Ubuntu\r\nDebian Test\r\n\r\n\0'))
  check('quiet 清理 BOM/NUL/CRLF', names.join('|') === 'Ubuntu|Debian Test', names.join('|'))
}

// 3. verbose 结构异常时只回退一次 quiet，默认标记保持未知
{
  const calls = []
  const list = await probeWslDistros(async (args) => {
    calls.push(args)
    if (args.includes('-v')) return utf16('任意表头\n这不是可靠数据行')
    return utf16('Ubuntu\r\nDebian Test\r\n')
  })
  check(
    'verbose 异常回退 quiet',
    calls.length === 2 && calls[0].includes('-v') && calls[1].includes('-q'),
    JSON.stringify(calls)
  )
  check(
    'quiet 元数据不猜默认/状态',
    list.length === 2 && list.every((d) => d.isDefault === undefined && d.state === 'unknown')
  )
}

// 4. verbose 命令失败同样回退；两个命令都失败则本次探测失败
{
  const list = await probeWslDistros(async (args) => {
    if (args.includes('-v')) throw new Error('old wsl')
    return utf16('Debian\r\n')
  })
  check('verbose 命令失败回退 quiet', list[0]?.distro === 'Debian' && list[0]?.state === 'unknown')

  let rejected = false
  try {
    await probeWslDistros(async () => {
      throw new Error('wsl unavailable')
    })
  } catch {
    rejected = true
  }
  check('两个命令都失败会向上报告', rejected)
}

// 5. 启动参数保持 argv 边界，不做 shell 字符串拼接
{
  const spec = wslLaunchSpec('Debian Test')
  check(
    '带空格发行版仍是单一 argv',
    spec.command === 'wsl.exe' && spec.args.length === 2 && spec.args[0] === '-d' && spec.args[1] === 'Debian Test',
    JSON.stringify(spec)
  )
}

// 6. 首次普通调用共享 prewarm；运行期间的多个 force 合并为一个尾随刷新
{
  const calls = []
  const scheduler = new WslProbeScheduler(() => {
    const task = deferred()
    calls.push(task)
    return task.promise
  })

  const initialA = scheduler.ensure()
  const initialB = scheduler.ensure()
  await tick()
  check('并发首次加载只探测一次', calls.length === 1, String(calls.length))
  calls[0].resolve()
  await Promise.all([initialA, initialB])
  await scheduler.ensure()
  await tick()
  check('初始化后的普通列表只读缓存', calls.length === 1, String(calls.length))

  const refreshA = scheduler.ensure(true)
  await tick()
  check('手动刷新真正重跑探测', calls.length === 2, String(calls.length))
  const refreshB = scheduler.ensure(true)
  const refreshC = scheduler.ensure(true)
  check('探测中的重复刷新共享尾随任务', refreshB === refreshC)

  calls[1].resolve()
  await refreshA
  await tick()
  check('探测期间的 force 会补一次新探测', calls.length === 3, String(calls.length))
  calls[2].resolve()
  await Promise.all([refreshB, refreshC])
  await tick()
  check('尾随任务合并后没有多余探测', calls.length === 3, String(calls.length))
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
