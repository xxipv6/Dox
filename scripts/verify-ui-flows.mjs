/**
 * 用真实 UI 验证关键流程：保存设备 → 删除设备 → SSH 错误认证必须可见。
 * 用法：node scripts/verify-ui-flows.mjs [host] [port] [user]
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { withIsolatedElectron } from './lib/electronHarness.mjs'

const host = process.argv[2] ?? process.env.DOX_TEST_HOST
if (!host) {
  console.error('用法: node scripts/verify-ui-flows.mjs <host> [port] [user]，或设置 DOX_TEST_HOST')
  process.exit(2)
}
const port = process.argv[3] ?? '22'
const user = process.argv[4] ?? 'root'
mkdirSync('shots', { recursive: true })

await withIsolatedElectron(async ({ win, check }) => {
  const consoleErrors = []
  win.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await win.waitForTimeout(1200)
  await win.evaluate(() => window.api.setLayout({ tabs: [] }))
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(
    () => [...document.querySelectorAll('.terminal-container')].some((el) => el.clientWidth > 200),
    undefined,
    { timeout: 15000 }
  )

  const devices = () => win.evaluate(() =>
    [...document.querySelectorAll('.device .device-name')].map((el) => el.textContent.trim())
  )
  const expectedName = `${user}@${host}`
  console.log('初始设备:', JSON.stringify(await devices()))

  // ---------- 1. 保存一个设备 ----------
  await win.locator('button[title="添加设备"]').click()
  await win.locator('input[placeholder^="192.168"]').fill(host)
  await win.locator('input.port').fill(String(port))
  await win.locator('input[placeholder="root"]').fill(user)
  await win.locator('input[placeholder="登录密码"]').fill('test-password-for-ui-flow')
  await win.locator('button:text-is("保存")').click()
  await win.waitForFunction((name) =>
    [...document.querySelectorAll('.device .device-name')].some((el) => el.textContent.trim() === name),
  expectedName, { timeout: 5000 })
  const afterSave = await devices()
  check('保存设备后列表包含新设备', afterSave.includes(expectedName), JSON.stringify(afterSave))

  // ---------- 2. 删除刚保存的设备 ----------
  const savedRow = win.locator('.device').filter({ has: win.locator(`.device-name:text-is("${expectedName}")`) })
  await savedRow.hover()
  await savedRow.locator('button[title="删除"]').click()
  await win.locator('.confirm-dialog button:text-is("确定")').click()
  await win.waitForFunction((name) =>
    ![...document.querySelectorAll('.device .device-name')].some((el) => el.textContent.trim() === name),
  expectedName, { timeout: 5000 })
  const afterDelete = await devices()
  check('删除后新设备不再出现', !afterDelete.includes(expectedName), JSON.stringify(afterDelete))

  // ---------- 3. SSH 连接（假密码，必须出现可见错误，不能变成成功终端） ----------
  await win.locator('button[title="添加设备"]').click()
  await win.locator('input[placeholder^="192.168"]').fill(host)
  await win.locator('input.port').fill(String(port))
  await win.locator('input[placeholder="root"]').fill(user)
  await win.locator('input[placeholder="登录密码"]').fill('__wrong_password__')
  await win.locator('button:has-text("仅连接")').click()

  const deadline = Date.now() + 30000
  let authError = ''
  while (Date.now() < deadline && !authError) {
    const hostKey = win.locator('.overlay .dialog-header', { hasText: '主机' })
    if (await hostKey.count()) {
      await win.screenshot({ path: join('shots', '20-hostkey.png') })
      await win.locator('button:has-text("信任并保存")').click()
    }
    authError = await win.evaluate(() =>
      [...document.querySelectorAll('.tab-placeholder')]
        .map((el) => el.textContent?.trim() ?? '')
        .find((text) => text.includes('连接失败')) ?? ''
    )
    if (!authError) await win.waitForTimeout(250)
  }
  check('错误密码产生可见的连接失败', authError.includes('连接失败'), authError || '30 秒内无失败状态')
  check('错误认证没有建立可见 SSH shell',
    (await win.locator('.tab-content:visible .terminal-container').count()) === 0)
  await win.screenshot({ path: join('shots', '21-ssh-result.png') })
  console.log('\n渲染进程 console error:', consoleErrors.length ? consoleErrors.slice(0, 5) : '无')
}, { prefix: 'dox-ui-flows-' })
