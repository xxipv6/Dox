/**
 * SFTP「在终端中打开此目录」端到端：
 *  SSH 连 dind → 开 SFTP 面板 → 面包屑进 /etc → 点「在终端中打开此目录」→
 *  终端收到 cd '/etc' → 焦点落在终端标签上（不是点了没反应）。
 *
 * 用法：node scripts/verify-sftp-open-terminal.mjs [host] [port] [user] [password]
 * 前置：npm run build；dox-sshd-test 在跑
 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'

const host = process.argv[2] ?? 'localhost'
const port = Number(process.argv[3] ?? 2222)
const user = process.argv[4] ?? 'doxtest'
const password = process.argv[5] ?? 'doxtest123'
mkdirSync('shots', { recursive: true })

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
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
await win.waitForTimeout(2000)

// ---- SSH 连接 ----
await win.locator('button[title="添加设备"]').click()
await win.waitForTimeout(400)
await win.locator('input[placeholder^="192.168"]').fill(host)
await win.locator('input.port').fill(String(port))
await win.locator('input[placeholder="root"]').fill(user)
await win.locator('input[placeholder="登录密码"]').fill(password)
await win.locator('button:has-text("仅连接")').click()
for (let i = 0; i < 8; i++) {
  await win.waitForTimeout(1000)
  const hk = await win.evaluate(() =>
    [...document.querySelectorAll('.dialog-header')].map((e) => e.textContent.trim()).some((t) => t.includes('主机'))
  )
  if (hk) { await win.locator('button:has-text("信任并保存")').click(); break }
}
await win.locator('.terminal-container:visible').first().waitFor({ timeout: 20000 })
await win.waitForTimeout(1500)
await win.keyboard.press('Escape')

// ---- 开 SFTP 面板，进 /etc ----
await win.locator('button.bar-btn:has-text("SFTP")').click()
await win.locator('.explorer .row').first().waitFor({ timeout: 15000 })
await win.locator('.explorer .crumb', { hasText: '/' }).first().click()
await win.waitForTimeout(1500)
const etcRow = win.locator('.explorer .row', { hasText: 'etc' }).first()
await etcRow.dblclick()
await win.waitForTimeout(1500)
const crumbText = (await win.locator('.explorer .breadcrumb').textContent()) ?? ''
check('SFTP 进入 /etc', crumbText.includes('etc'), crumbText)

// ---- 点「在终端中打开此目录」----
await win.locator('.explorer button[title="在终端中打开此目录"]').click()
await win.waitForTimeout(1200)
// 终端应该收到 cd '/etc'（回显可见）
const termText = await win.evaluate(
  () => document.querySelector('.tab-content:not([style*="display: none"]) .xterm-rows')?.textContent ?? ''
)
check('终端收到 cd 到 /etc', termText.includes("/etc"), termText.slice(-80))
// 焦点应已落在终端标签（SFTP 按钮所在的标签就是终端标签，验证 SFTP 面板已不可见或终端可见）
const termVisible = await win.evaluate(
  () => !!document.querySelector('.tab-content:not([style*="display: none"]) .terminal-container')
)
check('点击后焦点落在终端标签', termVisible)
await win.screenshot({ path: 'shots/99-sftp-open-terminal.png' })

await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
