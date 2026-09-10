/**
 * 验证 POSIX shell integration：cwd（OSC 7）与退出码（OSC 133）是否正常上报。
 * 覆盖 zsh（ZDOTDIR 注入）与 bash（--rcfile 注入），装了的才测，一个都没装则跳过。
 * 用法：node scripts/verify-posix-integration.mjs
 *
 * 对标 verify-pwsh-integration.mjs —— 那是 Windows 侧的同一件事。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createRequire } from 'node:module'

if (process.platform === 'win32') {
  console.log('Windows 请用 verify-pwsh-integration.mjs / verify-cmd-integration.mjs')
  process.exit(0)
}

const require = createRequire(import.meta.url)
const pty = require('node-pty')

// 把 integration 脚本铺到临时目录（模拟 ensureScripts 的落盘结构）
const dir = join(tmpdir(), 'dox-verify-posix')
const zdotdir = join(dir, 'zdotdir')
mkdirSync(zdotdir, { recursive: true })
writeFileSync(join(dir, 'dox-bashrc.sh'), readFileSync('src/main/local/scripts/dox-bashrc.sh', 'utf8'))
writeFileSync(join(zdotdir, '.zshrc'), readFileSync('src/main/local/scripts/dox-zshrc.zsh', 'utf8'))

function onPath(exe) {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  for (const d of [...dirs, '/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']) {
    const p = join(d, exe)
    if (existsSync(p)) return p
  }
  return undefined
}

/** 跑一个 shell：cd 到 /tmp，再 exit 42，收集输出 */
function runShell(name, command, args, envExtra) {
  return new Promise((resolve) => {
    let out = ''
    const p = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: homedir(),
      env: { ...process.env, ...envExtra }
    })
    p.onData((c) => (out += c))
    setTimeout(() => p.write('cd /tmp\r'), 1200)
    // 用子 shell 返回 42：直接 exit 42 会把 shell 本身结束掉，
    // 退出码上报发生在「下一个提示符」，shell 死了就永远等不到（pwsh 脚本同理用 cmd /c exit 42）
    setTimeout(() => p.write('sh -c "exit 42"\r'), 2400)
    setTimeout(() => {
      p.kill()
      const osc7 = [...out.matchAll(/\x1b\]7;([^\x1b\x07]*)/g)].map((m) => m[1])
      const cwdOk = osc7.some((v) => v.endsWith('/tmp'))
      const exitOk = /133;D;42/.test(out)
      resolve({ name, command, cwdOk, exitOk, osc7: osc7.at(-1), out })
    }, 3600)
  })
}

const targets = []
const zsh = onPath('zsh')
if (zsh) targets.push(['zsh', zsh, ['-i'], { ZDOTDIR: zdotdir }])
const bash = onPath('bash')
if (bash) targets.push(['bash', bash, ['--rcfile', join(dir, 'dox-bashrc.sh'), '-i'], {}])
const fish = onPath('fish')
if (fish) {
  writeFileSync(join(dir, 'dox.fish'), readFileSync('src/main/local/scripts/dox-fish.fish', 'utf8'))
  targets.push(['fish', fish, ['-i', '-C', `source ${join(dir, 'dox.fish')}`], {}])
}

if (targets.length === 0) {
  console.log('本机没找到 zsh/bash/fish，跳过')
  process.exit(0)
}

let failed = false
for (const [name, command, args, envExtra] of targets) {
  const r = await runShell(name, command, args, envExtra)
  console.log(`\n=== ${r.name} (${r.command}) ===`)
  console.log('OSC7 最后一条   :', r.osc7)
  console.log('cd /tmp 已上报  :', r.cwdOk)
  console.log('检测到退出码 42 :', r.exitOk)
  if (!r.cwdOk || !r.exitOk) {
    failed = true
    const visible = r.out
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/\r/g, '')
    console.log('--- 用户可见输出（最后 400 字符）---')
    console.log(JSON.stringify(visible.slice(-400)))
  }
}

console.log(failed ? '\n有 shell 未通过' : '\n全部通过')
process.exit(failed ? 1 : 0)
