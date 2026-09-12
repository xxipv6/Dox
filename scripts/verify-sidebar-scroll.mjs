/**
 * 侧栏滚动回归：容器很多（38 台级）时 sidebar-body 必须可滚动，
 * 底部「远程助手/快捷命令」分区滚到底要看得见。
 * （守着 .sidebar 缺 min-height: 0 把网格行顶出视口那个 bug）
 *
 * 用法：node scripts/verify-sidebar-scroll.mjs <host> [port] [user] [password]
 * 前置：npm run build；目标机器上容器越多越好（<10 个测不出回归）
 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'
mkdirSync('shots', { recursive: true })

const host = process.argv[2]
if (!host) { console.log('需要主机参数'); process.exit(1) }
const port = process.argv[3] ?? '22'
const user = process.argv[4] ?? 'root'
const password = process.argv[5] ?? ''

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => void d.accept())
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)
await win.evaluate(async () => { await window.api.setLayout({ tabs: [] }); location.reload() })
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2000)

// 快速连接 Server（不保存，纯连接）
await win.locator('button[title="添加设备"]').click()
await win.waitForTimeout(400)
await win.locator('input[placeholder^="192.168"]').fill(host)
await win.locator('input.port').fill(port)
await win.locator('input[placeholder="root"]').fill(user)
await win.locator('input[placeholder="登录密码"]').fill(password)
await win.locator('button:has-text("仅连接")').click()
for (let i = 0; i < 8; i++) {
  await win.waitForTimeout(1000)
  const hk = await win.evaluate(() =>
    [...document.querySelectorAll('.dialog-header')].map((e) => e.textContent.trim()).some((t) => t.includes('主机'))
  )
  if (hk) {
    // 指纹对话：优先「仅本次」，不把测试主机写进 known_hosts
    const once = win.locator('button:has-text("仅本次")')
    if (await once.count()) await once.click()
    else await win.locator('button:has-text("信任并保存")').click()
    break
  }
}
await win.locator('.terminal-container:visible').first().waitFor({ timeout: 20000 })
await win.waitForTimeout(1500)

// 展开容器分区
const head = win.locator('.sidebar .section-head', { hasText: '容器' })
if ((await head.getAttribute('aria-expanded')) === 'false') { await head.click() }
await win.waitForTimeout(4000)

const before = await win.evaluate(() => {
  const body = document.querySelector('.sidebar-body')
  return {
    sections: [...document.querySelectorAll('.sidebar .section-head')].map((e) => e.textContent.trim()),
    scrollH: body.scrollHeight,
    clientH: body.clientHeight,
    canScroll: body.scrollHeight > body.clientHeight + 5,
    sidebarH: Math.round(document.querySelector('.sidebar').getBoundingClientRect().height),
    winH: innerHeight
  }
})
console.log('展开后:', JSON.stringify(before))

// 真滚到底，看最末分区（快捷命令）是否可见
await win.evaluate(() => { document.querySelector('.sidebar-body').scrollTop = 999999 })
await win.waitForTimeout(400)
const bottom = await win.evaluate(() => {
  const heads = [...document.querySelectorAll('.sidebar .section-head')]
  const last = heads[heads.length - 1]
  const r = last.getBoundingClientRect()
  return { last: last.textContent.trim(), visible: r.top >= 0 && r.bottom <= innerHeight }
})
console.log('滚到底:', JSON.stringify(bottom))
await win.screenshot({ path: 'shots/94-sidebar-scroll.png' })

const pass = before.canScroll && bottom.visible
console.log(pass ? '全部通过' : 'FAIL: 仍不可滚动')
await app.close()
process.exit(pass ? 0 : 1)
