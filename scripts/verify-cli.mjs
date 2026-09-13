/**
 * CLI 伴侣（dox 命令，--cli 参数经单实例锁转发）端到端：
 *  A. 第二个进程带 --cli local --cwd 启动 → 单实例转发 → 第一个窗口开出新标签且落在该目录
 *  B. --cli connect --target user@host:port（无库存设备）→ 预填添加设备表单
 *  C. cliInstall 真装一遍 → 脚本存在、可执行、内容是 --cli 壳（测完清理）
 *
 * 用法：node scripts/verify-cli.mjs
 * 前置：npm run build
 */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdirSync } from 'node:fs'

mkdirSync('shots', { recursive: true })

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

// 上次跑挂可能留下僵尸实例：共享锁（单实例 CLI）与布局文件都会污染本次运行。
// 只能杀本仓库的 electron（别的 verify 脚本/ dev 同时跑本来就会互相踩）
try { execFileSync('pkill', ['-f', 'Dox/node_modules/electron'], { stdio: 'ignore' }) } catch { /* 没有正好 */ }

const ELECTRON = 'node_modules/.bin/electron'
/** 第二个实例带 --cli 参数启动：应被单实例锁挡下并把参数转给第一个实例，自己秒退 */
function fireCli(...args) {
  execFileSync(ELECTRON, ['.', ...args], { stdio: 'ignore', timeout: 20000 })
}

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => void d.accept())
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)
await win.evaluate(async () => {
  await window.api.setLayout({ tabs: [] })
  location.reload()
})
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

// ---- A. --cli local --cwd /tmp → 新标签落在 /tmp ----
fireCli('--cli=local', '--cwd=/tmp')
await win.waitForTimeout(2000)
const tabCount = await win.locator('.tab').count()
check('深链开出新标签', tabCount >= 2, `tabs=${tabCount}`)
let fellIntoTmp = false
for (let i = 0; i < 10; i++) {
  const active = (await win.locator('.tab.active').textContent()) ?? ''
  if (active.includes('tmp')) { fellIntoTmp = true; break }
  await win.waitForTimeout(500)
}
check('新标签落在 CLI 指定目录（/tmp）', fellIntoTmp, (await win.locator('.tab.active').textContent()) ?? '')

// ---- B. --cli connect --target doxtest@localhost:2222 → 预填表单 ----
fireCli('--cli=connect', '--target=doxtest@localhost:2222')
await win.waitForTimeout(1500)
const hostVal = await win.locator('input[placeholder^="192.168"]').inputValue().catch(() => '')
const portVal = await win.locator('input.port').inputValue().catch(() => '')
const userVal = await win.locator('input[placeholder="root"]').inputValue().catch(() => '')
check(
  'connect 深链预填表单',
  hostVal === 'localhost' && portVal === '2222' && userVal === 'doxtest',
  `host=${hostVal} port=${portVal} user=${userVal}`
)
await win.keyboard.press('Escape')
await win.screenshot({ path: 'shots/96-cli-deeplink.png' })

// ---- C. cliInstall ----
const res = await win.evaluate(() => window.api.cliInstall())
check('dox 命令安装成功', !!res?.path && fs.existsSync(res.path), JSON.stringify(res))
if (res?.path && fs.existsSync(res.path)) {
  const st = fs.statSync(res.path)
  const content = fs.readFileSync(res.path, 'utf8')
  check('脚本可执行', (st.mode & 0o111) !== 0)
  check('脚本是 --cli 壳', content.includes('--cli=local') && content.includes('--cwd=') && content.includes('--cli=connect'))
  fs.rmSync(res.path, { force: true }) // 测试产物清理
}

await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
