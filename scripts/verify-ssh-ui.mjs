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

/*
 * 先清掉上次运行留下的布局快照再重新加载 —— 本脚本上一轮会留下一个连不上的
 * SSH 标签，布局恢复会把它恢复成活动标签；那种标签没有终端，所有
 * .terminal-container 都是 v-show 隐藏的、clientWidth 为 0，下面必然超时。
 */
await win.waitForTimeout(1200)
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await win.reload()
await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(
  () => [...document.querySelectorAll('.terminal-container')].some((el) => el.clientWidth > 200),
  // 签名是 (fn, arg, options)：漏掉 arg 会把 timeout 当成页面函数参数，
  // 静默退回默认的 30 秒 —— 写在代码里的值从来没生效过。
  undefined, { timeout: 15000 }
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
  const state = await win.evaluate(() => {
    // 必须按标题内容认指纹弹窗：只用 '.overlay .dialog-header' 会把还开着的
    // 「添加设备」弹窗也算进来，于是去点一个不存在的「信任并保存」而超时
    const headers = [...document.querySelectorAll('.overlay .dialog-header')].map(
      (e) => e.textContent?.trim() ?? ''
    )
    const hostKeyText = headers.find((t) => t.includes('主机')) ?? null
    return {
      hostKeyDialog: hostKeyText !== null,
      hostKeyText,
      anyDialog: headers[0] ?? null,
      tabCount: document.querySelectorAll('.tab').length,
      placeholder: document.querySelector('.tab-placeholder')?.textContent?.trim() ?? null
    }
  })
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
