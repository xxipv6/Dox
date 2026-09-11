/**
 * 用真实 UI 验证关键流程：保存设备 → 删除设备 → SSH 连接（含主机指纹确认）。
 * 通过 Playwright 捕获渲染进程的 dialog/alert 与 console 报错。
 * 用法：node scripts/verify-ui-flows.mjs [host] [port] [user]
 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// 不再硬编码测试主机：公开仓库里写死自己的服务器地址，等于公开
// 「这台机器开着 22 端口」，改用参数或环境变量传入。
const host = process.argv[2] ?? process.env.DOX_TEST_HOST
if (!host) {
  console.error('用法: node scripts/verify-ui-flows.mjs <host> [port] [user]，或设置 DOX_TEST_HOST')
  process.exit(2)
}
const port = process.argv[3] ?? '22'
const user = process.argv[4] ?? 'root'
mkdirSync('shots', { recursive: true })

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()

// 捕获渲染进程报错与原生 confirm
const consoleErrors = []
win.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
win.on('pageerror', (e) => consoleErrors.push(`PAGEERROR ${e.message}`))
win.on('dialog', async (d) => {
  console.log(`  [原生对话框] ${d.type()}: ${d.message().slice(0, 80)}`)
  await d.accept()
})

await win.waitForLoadState('domcontentloaded')

/*
 * 先清掉上次运行留下的布局快照再重新加载。
 *
 * 本脚本上一轮会留下「密码错、连不上」的 SSH 标签，重启后布局恢复把它恢复
 * 成活动标签 —— 那个标签没有终端，于是所有 .terminal-container 都是 v-show
 * 隐藏的、clientWidth 为 0，下面这个等待必然超时。表现是「第一次能跑通、
 * 第二次必挂」，与代码改动无关。
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

const devices = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.device .device-name')].map((e) => e.textContent.trim())
  )

console.log('初始设备:', JSON.stringify(await devices()))

// ---------- 1. 保存一个设备 ----------
await win.locator('button[title="添加设备"]').click()
await win.waitForTimeout(400)
await win.locator('input[placeholder^="192.168"]').fill(host)
await win.locator('input[placeholder="root"]').fill(user)
await win.locator('input[placeholder="登录密码"]').fill('test-password-for-ui-flow')
await win.locator('button:has-text("保存")').first().click()
await win.waitForTimeout(900)
console.log('保存后设备:', JSON.stringify(await devices()))

// ---------- 2. 删除刚保存的设备 ----------
const before = await devices()
if (before.length) {
  await win.locator('.device').last().hover()
  await win.locator('.device').last().locator('button[title="删除"]').click()
  await win.waitForTimeout(1200)
  const after = await devices()
  console.log('删除后设备:', JSON.stringify(after))
  console.log(after.length < before.length ? '  => 删除成功' : '  => 删除失败（设备仍在）')
} else {
  console.log('  => 没有设备可删，跳过')
}

// ---------- 3. SSH 连接（假密码，验证错误可见） ----------
await win.locator('button[title="添加设备"]').click()
await win.waitForTimeout(400)
await win.locator('input[placeholder^="192.168"]').fill(host)
await win.locator('input[placeholder="root"]').fill(user)
await win.locator('input[placeholder="登录密码"]').fill('__wrong_password__')
await win.locator('button:has-text("仅连接")').click()

// 跑满全程不做提前退出：早期退出条件容易被「正在连接」或本地标签的终端误判
for (let i = 0; i < 6; i++) {
  await win.waitForTimeout(1500)
  const state = await win.evaluate(() => {
    const hk = [...document.querySelectorAll('.dialog-header')]
      .map((e) => e.textContent.trim())
      .find((t) => t.includes('主机'))
    return {
      hostKey: hk ?? null,
      tabCount: document.querySelectorAll('.tab').length,
      placeholder: document.querySelector('.tab-placeholder')?.textContent?.trim() ?? null,
      // 终端面板挂载 = shell 通道已建立（认证成功）
      hasTerminal: !!document.querySelector('.terminal-container'),
      dialogOpen: !!document.querySelector('.overlay')
    }
  })
  console.log(`[${(i + 1) * 1.5}s] ${JSON.stringify(state)}`)
  if (state.hostKey) {
    await win.screenshot({ path: join('shots', '20-hostkey.png') })
    await win.locator('button:has-text("信任并保存")').click()
    console.log('  → 已点「信任并保存」')
  }
}

await win.screenshot({ path: join('shots', '21-ssh-result.png') })
console.log('\n渲染进程报错:', consoleErrors.length ? consoleErrors.slice(0, 5) : '无')

// 收尾：本脚本会留下一个连不上的 SSH 标签，别让它变成用户下次开机的布局
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()
