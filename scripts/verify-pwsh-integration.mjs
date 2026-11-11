/**
 * 验证 PowerShell shell integration：cwd（OSC 7）与退出码（OSC 133）是否正常上报。
 * 用法：node scripts/verify-pwsh-integration.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pty = require('node-pty')
const tempDir = mkdtempSync(join(tmpdir(), 'dox-pwsh-integration-'))
const profilePath = join(tempDir, 'dox-profile.ps1')
writeFileSync(profilePath, readFileSync('src/main/local/scripts/dox-profile.ps1', 'utf8'))

const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const args = ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', `. '${profilePath}'`]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let out = ''
let failed = false
const check = (name, condition, detail = '') => {
  console.log(`${condition ? '  ok  ' : '  FAIL '}${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failed = true
}
const waitFor = async (predicate, timeout = 8000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(100)
  }
  return predicate()
}

const p = pty.spawn(pwsh, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: homedir() })
p.onData((chunk) => { out += chunk })
try {
  await waitFor(() => /\x1b\]133;A/.test(out))
  p.write(`Set-Location '${process.cwd().replace(/'/g, "''")}'\r`)
  const expectedCwd = process.cwd().replace(/\\/g, '/')
  const cwdReported = await waitFor(() => out.includes(`]7;file:///${expectedCwd}`))
  p.write('cmd /c exit 42\r')
  const exitReported = await waitFor(() => /\x1b\]133;D;42(?:\x07|\x1b\\)/.test(out))

  const osc7 = [...out.matchAll(/\x1b\]7;([^\x1b\x07]*)/g)].map((match) => match[1])
  const osc133 = [...out.matchAll(/\x1b\]133;([A-D])(?:;(\d+))?/g)].map(
    (match) => match[1] + (match[2] !== undefined ? ':' + match[2] : '')
  )
  console.log('OSC7 (cwd) 上报次数 :', osc7.length)
  console.log('OSC7 最后一条       :', osc7.at(-1))
  console.log('OSC133 事件序列     :', osc133.slice(-10).join(' '))

  check('OSC7 上报了当前 cwd', cwdReported && osc7.some((uri) => uri.endsWith(expectedCwd)), osc7.at(-1) ?? '无')
  check('OSC133 上报了退出码 42', exitReported && /133;D;42/.test(out), osc133.slice(-10).join(' '))
  check('OSC133 包含提示符/命令序列', osc133.includes('A') && osc133.includes('B'), osc133.join(' '))

  const visible = out
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r/g, '')
  console.log('\n--- 用户可见输出（最后 500 字符）---')
  console.log(JSON.stringify(visible.slice(-500)))
  check('PowerShell 没有配置加载错误', !/无法将|Cannot bind|Join-Path|错误/.test(visible), visible.slice(-200))
} catch (error) {
  check('PowerShell 集成探测未抛错', false, error instanceof Error ? error.message : String(error))
} finally {
  p.kill()
  rmSync(tempDir, { recursive: true, force: true })
}
process.exitCode = failed ? 1 : 0
