/**
 * 两套主题各截一张图，供人工核对配色。
 *
 * 这不是断言型验证（那个是 verify-theme.mjs）—— 它的用途是在改配色的过程中
 * 快速看一眼实际效果。改完颜色跑一次，看 shots/theme-light.png 和
 * shots/theme-dark.png，比读 computed style 直观得多。
 *
 * 用法：node scripts/shot-theme.mjs
 * 前置：npm run build
 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'

mkdirSync('shots', { recursive: true })

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())

await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1500)
/*
 * 清掉上次的标签布局，让截图回到「只有一个本地终端」的可比初始形态。
 *
 * 清空和 reload 必须在**同一次 evaluate 里**做完：布局 store 挂着 400ms 防抖的
 * 自动保存，只要留出间隙，它就会把当前还开着的标签重新写回快照，
 * 下次启动又恢复出来 —— 表现为「清了但没清掉」，两张图还不在同一个形态上。
 */
await win.evaluate(async () => {
  await window.api.setLayout({ tabs: [] })
  location.reload()
})
await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(
  () => [...document.querySelectorAll('.tab-content')].some((el) => el.clientWidth > 200),
  undefined,
  { timeout: 20000 }
)
// 等本地 shell 把提示符打出来，截图里才有真实内容而不是一片空白
await win.waitForTimeout(3500)
const tabCount = await win.locator('.tab').count()
if (tabCount !== 1) console.warn(`  ! 预期只有 1 个标签，实际 ${tabCount} 个 —— 截图形态可能不干净`)

const themeNow = () => win.evaluate(() => document.documentElement.dataset.theme)

/**
 * 用 .theme-toggle 这个稳定类名，不用 title 文案。
 *
 * 按钮的 title 描述的是「点一下会切到哪」，所以它本身会随当前主题变 —— 拿它
 * 当选择器就意味着脚本的结果依赖上一条用例留下的持久化状态（第一版就踩了：
 * 上一轮把深色写进了设置，这一轮启动即深色，选择器就再也匹配不上了）。
 */
async function switchTheme() {
  await win.locator('.sidebar .theme-toggle').click()
  await win.waitForTimeout(900)
}

async function shot(name) {
  const theme = await themeNow()
  await win.screenshot({ path: `shots/theme-${name}.png` })
  console.log(`  ✓ shots/theme-${name}.png  (data-theme=${theme})`)
}

/** 展开侧栏所有分区，把转发/容器/快捷命令的内容一起拍进去 */
async function expandAllSections() {
  for (let pass = 0; pass < 4; pass++) {
    const collapsed = win.locator('.sidebar .section-head[aria-expanded="false"]')
    const n = await collapsed.count()
    if (!n) break
    for (let i = 0; i < n; i++) await collapsed.nth(0).click()
    await win.waitForTimeout(300)
  }
  await win.waitForTimeout(400)
}

console.log('截图：')

// 先确保落在亮色：上一轮可能把深色持久化了下来
if ((await themeNow()) !== 'light') await switchTheme()
if ((await themeNow()) !== 'light') throw new Error('切不回亮色')

await shot('light')
await expandAllSections()
await shot('light-expanded')

// 打开设置弹窗：主题三选、终端预设列表都在这里，是本次改动最集中的地方
await win.locator('.sidebar .icon-btn[title="设置"]').click()
await win.waitForTimeout(600)
await win.screenshot({ path: 'shots/theme-light-settings.png' })
console.log('  ✓ shots/theme-light-settings.png')
await win.keyboard.press('Escape')
await win.waitForTimeout(400)

await switchTheme()
if ((await themeNow()) !== 'dark') throw new Error('没切到深色')
await shot('dark')

await win.locator('.sidebar .icon-btn[title="设置"]').click()
await win.waitForTimeout(600)
await win.screenshot({ path: 'shots/theme-dark-settings.png' })
console.log('  ✓ shots/theme-dark-settings.png')

await app.close()
