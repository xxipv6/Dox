// 设备分组 UI 探针：新分组 → 折叠持久化 → 重命名 → 移动 → 移出/解散 → 清理现场
// 用法：先 REMOTE_DEBUGGING_PORT=9333 npm run dev，再 node scripts/probe-groups.mjs
import { chromium } from 'playwright'

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`)
}

const browser = await chromium.connectOverCDP('http://localhost:9333')
const page = browser.contexts()[0].pages()[0]

try {
  // 上次失败运行可能留下开着的右键菜单（backdrop 会拦截一切点击），先清场
  const backdrop = page.locator('.menu-backdrop')
  if (await backdrop.count()) await backdrop.first().click({ force: true }).catch(() => {})

  const devices = page.locator('.device')
  const baseCount = await devices.count()
  if (!baseCount) throw new Error('没有已保存设备，探针没法跑')
  const first = devices.first()
  const firstName = (await first.locator('.device-name').innerText()).trim()

  // 1. 右键设备 → 菜单里有「新分组…」
  await first.click({ button: 'right' })
  const menu = page.locator('.context-menu')
  await menu.waitFor({ timeout: 3000 })
  const menuText = await menu.innerText()
  check('设备菜单含「新分组…」', menuText.includes('新分组'))
  check('初始无「移出分组」（设备未分组）', !menuText.includes('移出分组'))

  // 2. 新分组… → 输入框出现 → 填 DMZ → Enter
  await menu.getByText('新分组…').click()
  const newInput = page.locator('.group-new-row input')
  await newInput.waitFor({ timeout: 2000 })
  check('新分组输入框出现', true)
  await newInput.fill('DMZ')
  await newInput.press('Enter')
  const groupHead = page.locator('.group-head')
  await groupHead.waitFor({ timeout: 3000 })
  check('组头出现（DMZ）', (await groupHead.first().innerText()).includes('DMZ'))
  check('组头计数 = 1', (await groupHead.first().locator('.group-count').innerText()) === '1')
  const inGroup = await page.locator('.device-block.in-group').count()
  check('设备缩进在组内', inGroup === 1, `in-group=${inGroup}`)

  // 3. 折叠组 → 组内设备消失，计数不变；刷新后仍折叠
  await groupHead.first().click()
  const visibleAfterCollapse = await page.locator('.device-block.in-group .device').count()
  check('折叠后组内设备隐藏', visibleAfterCollapse === 0)
  await page.reload()
  await page.waitForSelector('.group-head', { timeout: 5000 })
  const stillCollapsed = (await page.locator('.device-block.in-group .device').count()) === 0
  check('刷新后折叠状态保持', stillCollapsed)
  await page.locator('.group-head').first().click() // 展开，继续下面的步骤
  await page.waitForSelector('.device-block.in-group .device', { timeout: 3000 })

  // 4. 组头右键 → 重命名分组 → DMZ 改 运维区
  await page.locator('.group-head').first().click({ button: 'right' })
  await page.locator('.context-menu').getByText('重命名分组').click()
  const renameInput = page.locator('.group-head .rename-input')
  await renameInput.waitFor({ timeout: 2000 })
  await renameInput.fill('运维区')
  await renameInput.press('Enter')
  await page.waitForFunction(
    () => document.querySelector('.group-head')?.textContent?.includes('运维区'),
    { timeout: 3000 }
  )
  check('重命名为「运维区」', true)

  // 5. 设备右键 → 菜单出现「移出分组」；移出 → 组消失（单设备组）、设备回平铺
  const grouped = page.locator('.device-block.in-group .device').first()
  await grouped.click({ button: 'right' })
  const menu2Text = await page.locator('.context-menu').innerText()
  check('组内设备菜单含「移出分组」', menu2Text.includes('移出分组'))
  await page.locator('.context-menu').getByText('移出分组').click()
  await page.waitForFunction(() => !document.querySelector('.group-head'), { timeout: 3000 })
  check('移出后组头消失', true)

  // 6. 再建组测「解散」：新分组 tmp解散 → 组头右键解散 → 组消失设备还在
  await page.locator('.device').first().click({ button: 'right' })
  await page.locator('.context-menu').getByText('新分组…').click()
  await page.locator('.group-new-row input').fill('tmp解散')
  await page.locator('.group-new-row input').press('Enter')
  await page.waitForSelector('.group-head', { timeout: 3000 })
  await page.locator('.group-head').first().click({ button: 'right' })
  await page.locator('.context-menu').getByText('解散分组').click()
  await page.waitForFunction(() => !document.querySelector('.group-head'), { timeout: 3000 })
  const deviceStillThere = (await page.locator('.device-name').allInnerTexts()).some((t) =>
    t.trim().includes(firstName)
  )
  check('解散后组消失、设备仍在', deviceStillThere)

  // 7. 现场清理确认：localStorage 折叠态里不留测试组名
  const collapsedStored = await page.evaluate(() => localStorage.getItem('dox-collapsed-groups'))
  check('折叠态残留检查', !collapsedStored?.includes('运维区') && !collapsedStored?.includes('DMZ'), collapsedStored ?? 'null')
} catch (err) {
  console.error('PROBE ERROR:', err?.message ?? err)
  results.push({ name: '（异常中断）', ok: false })
} finally {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  await browser.close()
  process.exit(failed.length ? 1 : 0)
}
