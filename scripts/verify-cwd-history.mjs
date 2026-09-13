/**
 * SFTP 目录历史（前进/后退）+ 标签右键「换到最近目录」端到端：
 *
 * A. SFTP 历史：SSH 连 dind → SFTP 进 /etc → 回根进 /var →
 *    工具栏「后退」回到 /etc、「前进」回到 /var；未导航时两按钮均禁用。
 * B. 反悔入口：预置 dirStats（本机 /tmp、/var 高频）→ 重载 →
 *    新建本地终端自动落在榜首 /tmp → 右键标签出菜单 → 点 /var →
 *    终端收到 cd '/var'。
 *
 * 用法：node scripts/verify-cwd-history.mjs
 * 前置：npm run build；dox-sshd-test 在跑
 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'

mkdirSync('shots', { recursive: true })

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

const crumbText = async () => (await win.locator('.explorer .breadcrumb').textContent()) ?? ''

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => void d.accept())
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)

// 预置本机学习数据（测完恢复原值，不污染真实统计）
const savedStats = await win.evaluate(() => window.api.dirStatsGet())
await win.evaluate(() =>
  window.api.dirStatsSet({ local: { '/tmp': 9, '/var': 6, '/etc': 3 } })
)
await win.evaluate(async () => {
  await window.api.setLayout({ tabs: [] })
  location.reload()
})
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

// ---- A. SFTP 历史 ----
console.log('A. SFTP 目录历史')
await win.locator('button[title="添加设备"]').click()
await win.waitForTimeout(400)
await win.locator('input[placeholder^="192.168"]').fill('localhost')
await win.locator('input.port').fill('2222')
await win.locator('input[placeholder="root"]').fill('doxtest')
await win.locator('input[placeholder="登录密码"]').fill('doxtest123')
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

await win.locator('button.bar-btn:has-text("SFTP")').click()
await win.locator('.explorer .row').first().waitFor({ timeout: 15000 })
const backBtn = win.locator('.explorer button[title="后退（鼠标侧键）"]')
const fwdBtn = win.locator('.explorer button[title="前进（鼠标侧键）"]')
check('初始后退禁用', await backBtn.isDisabled())
check('初始前进禁用', await fwdBtn.isDisabled())

await win.locator('.explorer .crumb', { hasText: '/' }).first().click()
await win.waitForTimeout(1500)
await win.locator('.explorer .row', { hasText: 'etc' }).first().dblclick()
await win.waitForTimeout(1500)
check('进入 /etc', (await crumbText()).includes('etc'))
check('导航后后退可用', !(await backBtn.isDisabled()))
check('前进仍禁用', await fwdBtn.isDisabled())

await win.locator('.explorer .crumb', { hasText: '/' }).first().click()
await win.waitForTimeout(1500)
await win.locator('.explorer .row', { hasText: 'var' }).first().dblclick()
await win.waitForTimeout(1500)
check('进入 /var', (await crumbText()).includes('var'))

// 历史是浏览器式的逐层回退：路径是 /root → / → /etc → / → /var，
// 第一次后退回到的是「/」（上一步所在），再退一次才是 /etc
await backBtn.click()
await win.waitForTimeout(1500)
const afterBack1 = await crumbText()
check('第一次后退回到 /', !afterBack1.includes('var') && !afterBack1.includes('etc'), afterBack1)
check('后退后前进可用', !(await fwdBtn.isDisabled()))

await backBtn.click()
await win.waitForTimeout(1500)
check('第二次后退回到 /etc', (await crumbText()).includes('etc'))

await fwdBtn.click()
await win.waitForTimeout(1500)
const afterFwd1 = await crumbText()
check('前进回到 /', !afterFwd1.includes('etc'), afterFwd1)
await fwdBtn.click()
await win.waitForTimeout(1500)
check('再前进回到 /var', (await crumbText()).includes('var'))
await win.screenshot({ path: 'shots/98-sftp-history.png' })

// ---- B. 标签右键「换到最近目录」----
console.log('B. 标签右键反悔入口')
// 新开本地终端：学习层榜首是 /tmp（预置 9 次），应自动落过去
await win.locator('button.tab-new').click()
await win.waitForTimeout(2500)
const localTab = win.locator('.tab', { hasText: '本地' }).first()
await localTab.waitFor({ timeout: 10000 })
// 等 OSC7 上报 cwd，标签名变成「本地 · tmp」说明确实落在了 /tmp
let fellIntoTmp = false
for (let i = 0; i < 10; i++) {
  const t = (await localTab.textContent()) ?? ''
  if (t.includes('tmp')) { fellIntoTmp = true; break }
  await win.waitForTimeout(500)
}
check('新本地终端自动落到 /tmp（学习层榜首）', fellIntoTmp, (await localTab.textContent()) ?? '')

await localTab.click({ button: 'right' })
await win.waitForTimeout(600)
const menu = win.locator('.context-menu')
await menu.waitFor({ timeout: 5000 })
const menuText = (await menu.textContent()) ?? ''
check('菜单含 /tmp', menuText.includes('/tmp'), menuText)
check('菜单含 /var', menuText.includes('/var'), menuText)

await menu.locator('.menu-item', { hasText: '/var' }).first().click()
await win.waitForTimeout(1200)
const termText = await win.evaluate(() => {
  // 找到「本地」标签对应的可见终端
  for (const tc of document.querySelectorAll('.tab-content:not([style*="display: none"])')) {
    const rows = tc.querySelector('.xterm-rows')
    if (rows) return rows.textContent ?? ''
  }
  return ''
})
check('终端收到 cd \'/var\'', termText.includes("cd '/var'") || termText.includes('cd /var'), termText.slice(-100))
await win.screenshot({ path: 'shots/98-tab-menu.png' })

// 恢复原学习数据，清布局
await win.evaluate((stats) => window.api.dirStatsSet(stats), savedStats)
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
