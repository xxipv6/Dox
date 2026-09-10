/**
 * 验证 PowerShell shell integration：cwd（OSC 7）与退出码（OSC 133）是否正常上报。
 * 用法：node scripts/verify-pwsh-integration.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pty = require('node-pty')

const profilePath = join(tmpdir(), 'dox-verify-profile.ps1')
writeFileSync(profilePath, readFileSync('src/main/local/scripts/dox-profile.ps1', 'utf8'))

const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const args = ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', `. '${profilePath}'`]

let out = ''
const p = pty.spawn(pwsh, args, {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: homedir()
})
p.onData((c) => (out += c))

setTimeout(() => p.write(`Set-Location '${process.cwd()}'\r`), 1200)
setTimeout(() => p.write('cmd /c exit 42\r'), 2400)
setTimeout(() => {
  const osc7 = [...out.matchAll(/\x1b\]7;([^\x1b\x07]*)/g)].map((m) => m[1])
  const osc133 = [...out.matchAll(/\x1b\]133;([A-D])(?:;(\d+))?/g)].map(
    (m) => m[1] + (m[2] !== undefined ? ':' + m[2] : '')
  )

  console.log('OSC7 (cwd) 上报次数 :', osc7.length)
  console.log('OSC7 最后一条       :', osc7.at(-1))
  console.log('OSC133 事件序列     :', osc133.slice(-10).join(' '))
  console.log('检测到退出码 42     :', /133;D;42/.test(out))
  console.log('提示符含 git 分支   :', /\x1b\[38;2;158;206;106m\(/.test(out))

  // 用户实际看到的文本（剥掉全部转义序列）
  const visible = out
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') // CSI
    .replace(/\r/g, '')
  console.log('\n--- 用户可见输出（最后 500 字符）---')
  console.log(JSON.stringify(visible.slice(-500)))
  console.log('\n--- 是否出现 PowerShell 错误 ---')
  console.log(/无法将|Cannot bind|Join-Path|错误/.test(visible) ? '有错误！' : '无')

  p.kill()
  process.exit(0)
}, 3800)
