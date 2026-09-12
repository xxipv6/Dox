/**
 * 启动打包产物（out/）里的 Electron 应用并截图，用于人工/自动核对界面。
 * 用法：node scripts/screenshot-app.mjs [输出目录]
 *
 * 前置：npm run build
 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const outDir = process.argv[2] ?? 'shots'
mkdirSync(outDir, { recursive: true })

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
// 等本地终端起来并渲染出提示符；同时等容器真正拿到布局尺寸
await win.waitForTimeout(2000)
try {
  await win.waitForFunction(
    () => [...document.querySelectorAll('.terminal-container')].some((el) => el.clientWidth > 200),
    // 签名是 (fn, arg, options)：漏掉 arg 会把 timeout 当成页面函数参数，
    // 静默退回默认的 30 秒 —— 写在代码里的值从来没生效过。
    undefined, { timeout: 8000 }
  )
} catch {
  console.log('警告：终端容器始终未获得有效尺寸')
}
await win.waitForTimeout(1200)

/** 把 xterm 的可见内容读回来，核对是否与 pty 尺寸一致 */
const termInfo = await win.evaluate(() => {
  const el = document.querySelector('.terminal-container')
  const screen = el?.querySelector('.xterm-screen')
  const viewport = el?.querySelector('.xterm-viewport')
  return {
    container: el ? `${el.clientWidth}x${el.clientHeight}` : null,
    screen: screen ? `${screen.clientWidth}x${screen.clientHeight}` : null,
    viewportWidth: viewport?.clientWidth ?? null,
    // 从 DOM 里读 xterm 的行元素，估算每行字符数
    rows: document.querySelectorAll('.xterm-rows > div').length
  }
})
console.log('终端尺寸信息:', JSON.stringify(termInfo))

await win.screenshot({ path: join(outDir, '01-main.png') })

// 打开「添加设备」弹窗
const addBtn = win.locator('button[title="添加设备"]')
if (await addBtn.count()) {
  await addBtn.click()
  await win.waitForTimeout(600)
  await win.screenshot({ path: join(outDir, '02-device-dialog.png') })
  await win.keyboard.press('Escape')
}

// 标签栏加号：新建本地终端
const newTab = win.locator('.tab-new')
if (await newTab.count()) {
  await newTab.click()
  await win.waitForTimeout(2500)
  await win.screenshot({ path: join(outDir, '03-second-tab.png') })
}

await app.close()
console.log(`截图已保存到 ${outDir}/`)
