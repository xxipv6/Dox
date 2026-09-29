/**
 * issue #5 回归：原位刷新（fs 事件触发）不丢滚动位置。
 *  browse 模式 → 滚到底 → 建/删文件触发刷新 → scrollTop 不变。
 * 用法：node scripts/verify-sftp-scroll.mjs   前置：npm run build
 */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
try { execFileSync('pkill', ['-f', 'Dox/node_modules/electron'], { stdio: 'ignore' }) } catch {}

let failed = false
const check = (n, c, x='') => { console.log(c ? `  ok  ${n}` : `  FAIL ${n} ${x}`); if (!c) failed = true }
const DIR = path.join(os.homedir(), 'Library/Caches')

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1500)
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await win.evaluate(() => location.reload())
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

const { createRequire } = await import('node:module')
const ELECTRON = createRequire(import.meta.url)('electron')
execFileSync(ELECTRON, ['.', '--cli=local', `--cwd=${DIR}`], { stdio: 'ignore', timeout: 20000 })
await win.waitForTimeout(3000)

await win.locator('button[title="本机文件面板"]').click()
await win.waitForTimeout(2000)
// 项目模式就退出来（面包屑栏的项目芯片有退出按钮；没有就直接失败重查）
if (await win.locator('.project-bar:visible').count()) {
  await win.locator('.project-bar:visible button[title*="退出"], .project-bar:visible .icon-btn').last().click().catch(() => {})
  await win.waitForTimeout(800)
}
const list = win.locator('.file-list:visible')
await list.waitFor({ timeout: 8000 })
const rowCount = await list.locator('.row').count()
check('browse 模式且行数足够滚动', rowCount > 30, `rows=${rowCount}`)

await list.evaluate((el) => { el.scrollTop = el.scrollHeight })
await win.waitForTimeout(300)
const before = await list.evaluate((el) => el.scrollTop)
const firstRowBefore = await list.locator('.row').first().textContent()
check('滚动条能离开顶部', before > 0, `before=${before}`)

fs.writeFileSync(path.join(DIR, '.dox-scroll-probe'), 'x')
await win.waitForTimeout(1500)
const mid = await list.evaluate((el) => el.scrollTop)
fs.rmSync(path.join(DIR, '.dox-scroll-probe'), { force: true })
await win.waitForTimeout(1500)
const after = await list.evaluate((el) => el.scrollTop)
const firstRowAfter = await list.locator('.row').first().textContent()

check('建文件触发刷新：滚动位置不丢', mid > 0 && Math.abs(mid - before) < 50, `before=${before} mid=${mid}`)
check('删文件触发刷新：滚动位置不丢', after > 0 && Math.abs(after - before) < 50, `before=${before} after=${after}`)
check('刷新后列表内容仍在（不是空列表装出来的 scrollTop）', (firstRowAfter ?? '').length > 0 && firstRowBefore === firstRowAfter)

await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()
console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
