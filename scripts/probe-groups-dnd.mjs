// 设备分组·人性化入口探针：＋分组空组、拖拽进组、拖拽建组、拖拽移出
// 用法：npm run build && node scripts/probe-groups-dnd.mjs（隔离 userData，不读取真实设备）
import { withIsolatedElectron } from './lib/electronHarness.mjs'

await withIsolatedElectron(async ({ win: page, check }) => {
  await page.evaluate(async () => {
    for (const [name, host] of [['AI', 'ai.invalid'], ['Server', 'server.invalid']]) {
      await window.api.saveSession({
        name, host, port: 22, username: 'probe', authType: 'password', password: 'probe'
      })
    }
  })
  await page.reload()
  await page.waitForSelector('.device', { timeout: 5000 })

  // 1. ＋分组按钮 → 输入框 → 空组「运维区」（计数 0）
  await page.locator('.icon-btn[title*="新建分组"]').click()
  const createInput = page.locator('.group-head .rename-input')
  await createInput.waitFor({ timeout: 2000 })
  check('＋分组输入框出现', true)
  await createInput.fill('运维区')
  await createInput.press('Enter')
  await page.waitForSelector('.group-head', { timeout: 3000 })
  const headText = await page.locator('.group-head').first().innerText()
  check('空组「运维区」出现', headText.includes('运维区'))
  check('空组计数 = 0', (await page.locator('.group-head .group-count').innerText()) === '0')

  // 2. 刷新后空组还在（显式创建的分组靠 localStorage 记住）
  await page.reload()
  await page.waitForSelector('.group-head', { timeout: 5000 })
  check('刷新后空组仍在', (await page.locator('.group-head').first().innerText()).includes('运维区'))

  // 3. 拖 AI 到「运维区」组头 → 进组
  const ai = page.locator('.device', { hasText: 'AI' }).first()
  await ai.dragTo(page.locator('.group-head').first())
  await page.waitForSelector('.device-block.in-group .device', { timeout: 3000 })
  check('拖拽到组头 → AI 进组', (await page.locator('.group-head .group-count').innerText()) === '1')

  // 4. 拖 AI（组内）到 Server（未分组）上 → AI 移出分组
  const server = page.locator('.device', { hasText: 'Server' }).first()
  await page.locator('.device-block.in-group .device').first().dragTo(server)
  await page.waitForFunction(
    () => document.querySelector('.group-head .group-count')?.textContent === '0',
    undefined,
    { timeout: 3000 }
  )
  check('拖到未分组设备上 → 移出分组', true)

  // 5. 两台都没组：拖 AI 到 Server 上 → 现场建组（两台都进）+ 重命名框自动开
  await page.locator('.device', { hasText: 'AI' }).first().dragTo(page.locator('.device', { hasText: 'Server' }).first())
  const autoRename = page.locator('.group-head .rename-input')
  await autoRename.waitFor({ timeout: 3000 })
  check('拖两台未分组设备 → 现场建组', (await autoRename.inputValue()) === '新分组')
  check('建组后重命名框自动打开', true)
  await autoRename.fill('临时组')
  await autoRename.press('Enter')
  await page.waitForFunction(
    () => [...document.querySelectorAll('.group-head')].some((head) => head.textContent?.includes('临时组')),
    undefined,
    { timeout: 3000 }
  )
  const count = await page.locator('.group-head', { hasText: '临时组' }).locator('.group-count').innerText()
  check('现场组两台设备都在', count === '2', `count=${count}`)
}, { prefix: 'dox-groups-dnd-' })
