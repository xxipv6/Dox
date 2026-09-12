/**
 * 界面走查截图：把主要界面状态各截一张，供人工看「好不好看」。
 * 用法：node scripts/shot-review.mjs
 * 前置：npm run build
 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const outDir = process.argv[2] ?? 'shots/review'
mkdirSync(outDir, { recursive: true })

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())
await win.waitForLoadState('domcontentloaded')

const shot = async (name) => {
  await win.screenshot({ path: join(outDir, `${name}.png`) })
  console.log(`  → ${name}.png`)
}

// 干净起点：清掉上次留下的布局，只留默认本地终端
await win.waitForTimeout(1500)
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await win.reload()
await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(
  () => [...document.querySelectorAll('.terminal-container')].some((el) => el.clientWidth > 200),
  // 签名是 (fn, arg, options)：漏掉 arg 会把 timeout 当成页面函数参数，
  // 静默退回默认的 30 秒 —— 写在代码里的值从来没生效过。
  undefined, { timeout: 20000 }
)
await win.waitForTimeout(1500)

// 1. 主界面：侧栏 + 标签栏 + 本地终端
console.log('主界面')
await shot('01-main')

// 2. 侧栏各面板
for (const [label, name] of [
  ['片段', '02-snippets'],
  ['转发', '03-forward']
]) {
  const btn = win.locator(`.sidebar-tab:has-text("${label}"), button:has-text("${label}")`).first()
  if (await btn.count()) {
    await btn.click()
    await win.waitForTimeout(400)
    await shot(name)
  } else {
    console.log(`  (找不到「${label}」入口)`)
  }
}

// 3. 添加设备弹窗
console.log('弹窗')
const addBtn = win.locator('button[title="添加设备"]')
if (await addBtn.count()) {
  await addBtn.click()
  await win.waitForTimeout(600)
  await shot('04-device-dialog')
  // 注意：这些弹窗目前没绑 Esc，只能点 × 关
  await win.locator('.overlay .close-btn').click()
  await win.waitForTimeout(400)
}

// 4. 设置弹窗
const settingsBtn = win.locator('button[title="设置"]')
if (await settingsBtn.count()) {
  await settingsBtn.click()
  await win.waitForTimeout(600)
  await shot('05-settings')
  await win.locator('.overlay .close-btn').click()
  await win.waitForTimeout(400)
}

// 5. 多标签
console.log('多标签')
if (await win.locator('.tab-new').count()) {
  await win.locator('.tab-new').click()
  await win.waitForTimeout(2000)
  await shot('06-two-tabs')
}

// 6. SSH 设备连接（若有已保存设备）
const deviceCount = await win.locator('.device').count()
if (deviceCount) {
  console.log(`连接设备（共 ${deviceCount} 个已保存设备）`)
  await win.locator('.device .device-name').first().dblclick()
  try {
    await win.waitForFunction(
      () => document.querySelectorAll('.terminal-container').length >= 3,
      undefined, { timeout: 25000 }
    )
    await win.waitForTimeout(2500)
    await shot('07-ssh-connected')

    // SFTP 面板
    const sftpBtn = win.locator('button:has-text("SFTP")')
    if (await sftpBtn.count()) {
      await sftpBtn.click()
      await win.waitForTimeout(2500)
      await shot('08-sftp')
    }
  } catch {
    console.log('  (SSH 连接超时，跳过远端界面)')
  }
} else {
  console.log('(无已保存设备，跳过远端界面)')
}

// 收尾：别把测试布局留给用户
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()
console.log(`\n截图已保存到 ${outDir}/`)
