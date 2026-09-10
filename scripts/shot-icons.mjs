/** 放大截取各组图标，逐个核对画出来的形状对不对。 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const outDir = 'shots/polish'
mkdirSync(outDir, { recursive: true })

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await win.reload()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

// 侧栏头部 + 设备行
await win.screenshot({
  path: join(outDir, 'z-sidebar.png'),
  clip: { x: 0, y: 0, width: 260, height: 150 }
})
console.log('  → z-sidebar.png')

// 标签栏 + 分屏/SFTP 按钮
await win.screenshot({
  path: join(outDir, 'z-tabs.png'),
  clip: { x: 260, y: 0, width: 1140, height: 46 }
})
console.log('  → z-tabs.png')

// 连设备后看 SFTP 工具栏
await win.locator('.device .device-name').first().dblclick()
await win.waitForFunction(
  () => document.querySelectorAll('.terminal-container').length >= 2,
  // 签名是 (fn, arg, options)：漏掉 arg 会把 timeout 当成页面函数参数，
  // 静默退回默认的 30 秒 —— 写在代码里的值从来没生效过。
  undefined, { timeout: 25000 }
)
await win.waitForTimeout(2500)
await win.locator('button:has-text("SFTP")').click()
await win.locator('.explorer .row').first().waitFor({ timeout: 15000 })
await win.waitForTimeout(1200)

const exp = await win.locator('.explorer').boundingBox()
await win.screenshot({
  path: join(outDir, 'z-explorer-top.png'),
  clip: { x: exp.x, y: exp.y, width: exp.width, height: 110 }
})
console.log('  → z-explorer-top.png')

// 悬停一行看行尾按钮
const row = await win.locator('.file-list .row').nth(1).boundingBox()
await win.mouse.move(row.x + row.width - 50, row.y + row.height / 2)
await win.waitForTimeout(400)
await win.screenshot({
  path: join(outDir, 'z-row-hover.png'),
  clip: { x: exp.x, y: row.y - 45, width: exp.width, height: 130 }
})
console.log('  → z-row-hover.png')

// 顺带核对目录/文件图标的实际颜色
console.log(
  '图标颜色:',
  await win.evaluate(() => {
    const dir = document.querySelector('.file-list .file-icon.dir')
    const file = document.querySelector('.file-list .file-icon:not(.dir)')
    return { dir: dir ? getComputedStyle(dir).color : null, file: file ? getComputedStyle(file).color : null }
  })
)

await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()
