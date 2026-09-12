/**
 * Git Bash integration 验证（Windows 特有）：
 *  阶段 1（pty 级）：按 shells.ts 的同款参数（--rcfile dox-bashrc.sh -i）起 Git Bash，
 *    断言 OSC 7 报的是 MSYS 形式 file:///<盘符小写>/...（/c/...），OSC 133 带退出码。
 *  阶段 2（UI 级）：真实应用里把本地 shell 设为 Git Bash → 开本地终端 → cd /c/ →
 *    标签标题必须是「本地 · C:」—— pathFromOsc7 的 MSYS→Windows 转换若失效，
 *    标题会是「本地 · c」（未转换的 /c/ 取 basename）。
 *
 * 用法：node scripts/verify-gitbash-integration.mjs
 * 前置：npm run build；本机装有 Git for Windows
 */
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pty = require('node-pty')

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

// ---------- 探测 Git Bash（与 shells.ts 的 probeBaseSync 同口径）----------
const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
const candidates = [
  join(programFiles, 'Git', 'bin', 'bash.exe'),
  join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
  ...(process.env.PATH ?? '')
    .split(';')
    .filter(Boolean)
    .map((d) => join(d, 'bash.exe'))
]
const gitBash = candidates.find((p) => existsSync(p) && !p.toLowerCase().includes('system32'))
check('探测到 Git Bash（且不是 WSL 的 System32\\bash.exe）', !!gitBash, gitBash ?? '未找到')
if (!gitBash) {
  console.log('没有 Git Bash，跳过')
  process.exit(failed ? 1 : 0)
}
console.log('  使用:', gitBash)

// ---------- 阶段 1：pty 级 ----------
console.log('\n阶段 1：pty 级（OSC 7 MSYS 形式 + OSC 133 退出码）')
const dir = join(tmpdir(), 'dox-verify-gitbash')
mkdirSync(dir, { recursive: true })
const rcfile = join(dir, 'dox-bashrc.sh')
writeFileSync(rcfile, readFileSync('src/main/local/scripts/dox-bashrc.sh', 'utf8'))

const p = pty.spawn(gitBash, ['--rcfile', rcfile, '-i'], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: process.env.USERPROFILE,
  env: process.env
})
let buf = ''
p.onData((d) => (buf += d))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await wait(2500)
p.write('cd /c/\r')
await wait(1200)
p.write('true\r')
await wait(800)
p.write('false\r')
await wait(800)

const osc7 = [...buf.matchAll(/\x1d?\x1b\]7;(file:\/\/[^\x1b\x07]+)/g)].map((m) => m[1])
check('OSC 7 已上报', osc7.length > 0, JSON.stringify(osc7.slice(-2)))
const lastUri = osc7[osc7.length - 1] ?? ''
check('报的是 MSYS 形式 /c（pathFromOsc7 要转换的就是它）', /file:\/\/[^/]*\/c$/.test(lastUri), lastUri)
check('OSC 133 退出码 true→0', /\]133;D;0\x1b/.test(buf))
check('OSC 133 退出码 false→1', /\]133;D;1\x1b/.test(buf))
p.kill()

// ---------- 阶段 2：UI 级 ----------
console.log('\n阶段 2：UI 级（标签标题拿到转换后的 Windows 路径）')
const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1500)

// 默认本地 shell 改成 Git Bash（收尾必须恢复 —— 设置是真实落盘的共享状态）
const original = await win.evaluate(() => window.api.getSettings())
await win.evaluate((s) => window.api.setSettings(s), { ...original, localShellId: 'gitbash' })

await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await win.reload()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

const tabTitles = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.tab .tab-title')].map((e) => e.textContent?.trim() ?? '')
  )

// 默认本地终端应当已经用 Git Bash 起了（布局清空后开一个默认本地终端）
await win.locator('.terminal-container:visible').first().click()
await win.waitForTimeout(2500)
await win.keyboard.type('cd /c/', { delay: 60 })
await win.keyboard.press('Enter')

let titles = []
for (let i = 0; i < 10; i++) {
  await win.waitForTimeout(800)
  titles = await tabTitles()
  if (titles.some((t) => t === '本地 · C:')) break
}
check('标签标题是「本地 · C:」（MSYS→Windows 转换生效）', titles.some((t) => t === '本地 · C:'), JSON.stringify(titles))
check('没有出现未转换的「本地 · c」', !titles.some((t) => t === '本地 · c'), JSON.stringify(titles))

// 收尾：恢复设置与布局（否则用户下次开应用默认 shell 被改了）
await win.evaluate((s) => window.api.setSettings(s), original)
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
