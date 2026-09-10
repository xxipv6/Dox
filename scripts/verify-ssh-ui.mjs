/**
 * 驱动真实 UI 走一遍 SSH 连接流程（故意用错密码），检查错误是否可见。
 * 用法：node scripts/verify-ssh-ui.mjs [host] [port] [user]
 *
 * 前置：npm run build
 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const host = process.argv[2] ?? 'example.com'
const port = process.argv[3] ?? '22'
const user = process.argv[4] ?? 'root'
mkdirSync('shots', { recursive: true })

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(
  () => (document.querySelector('.terminal-container')?.clientWidth ?? 0) > 200,
  { timeout: 10000 }
)

// 打开添加设备弹窗
await win.locator('.add-btn').click()
await win.waitForTimeout(500)

// 填表：密码故意填错，验证失败路径是否有可见反馈
await win.locator('input[placeholder^="192.168"]').fill(host)
await win.locator('input[placeholder="root"]').fill(user)
await win.locator('input[placeholder="登录密码"]').fill('__definitely_wrong_password__')
await win.screenshot({ path: join('shots', '10-dialog-filled.png') })

await win.locator('button:has-text("仅连接")').click()

// 观察 8 秒内发生的事（可能先弹主机指纹确认，再报认证失败）
for (const sec of [1, 3, 6, 9]) {
  await win.waitForTimeout(sec === 1 ? 1000 : 2000 + (sec === 9 ? 1000 : 0))
  const state = await win.evaluate(() => ({
    hostKeyDialog: !!document.querySelector('.overlay .dialog-header'),
    hostKeyText: document.querySelector('.overlay .dialog-header')?.textContent?.trim() ?? null,
    tabCount: document.querySelectorAll('.tab').length,
    placeholder: document.querySelector('.tab-placeholder')?.textContent?.trim() ?? null
  }))
  console.log(`[${sec}s]`, JSON.stringify(state))
  if (state.hostKeyDialog) {
    await win.screenshot({ path: join('shots', '11-hostkey-dialog.png') })
    // 指纹确认框出现 → 点「信任并保存」继续
    await win.locator('button:has-text("信任并保存")').click()
    console.log('  → 已点击「信任并保存」')
  }
}

await win.screenshot({ path: join('shots', '12-ssh-result.png') })
await app.close()
console.log('截图：shots/10-dialog-filled.png, 11-hostkey-dialog.png, 12-ssh-result.png')
