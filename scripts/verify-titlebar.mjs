/**
 * 自绘标题栏验证。
 *
 * 窗口是无边框的（frame: false），所以「最小化 / 最大化 / 关闭」这三件事
 * 系统不再代劳 —— 必须由渲染层那三枚按钮经 IPC 打到主进程。
 * 这条链路只在无边框窗口下存在，因此值得单独守：
 * 它断了不会报任何错，只是那三枚按钮变成画上去的装饰。
 *
 * 一并守住的还有拖拽区：整条 .title-bar 是 drag，按钮必须是 no-drag ——
 * 按钮忘了标 no-drag 的话，点它会变成拖窗口，按钮按不动，
 * 而这在截图里完全看不出来。
 *
 * 用法：node scripts/verify-titlebar.mjs
 * 前置：npm run build
 * 不连任何远端，不改任何远端状态。
 */
import { _electron as electron } from 'playwright'

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2000)

const mainWindow = () =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    return { maximized: w.isMaximized(), minimized: w.isMinimized(), destroyed: w.isDestroyed() }
  })

/*
 * 窗口自己的事件流。
 *
 * 「最小化到底有没有生效」必须看这个，不能只看 isMinimized() 轮询 ——
 * Playwright 驱动下的窗口会在一两秒后被**测试侧**弄回来（窗口自身并不会发
 * restore/show 事件，可见不是应用把它叫回来的）。轮询于是可能读到 false，
 * 报出一个假失败。事件流不会被这套干扰影响：按钮 → IPC → 主进程 → 窗口事件，
 * 这条链断没断，事件说了算。
 */
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  globalThis.__winEvents = []
  for (const e of ['minimize', 'maximize', 'unmaximize', 'restore']) {
    w.on(e, () => globalThis.__winEvents.push(e))
  }
})
const winEvents = () => app.evaluate(() => globalThis.__winEvents ?? [])

console.log('\n1. 标题栏与拖拽区')
check('自绘标题栏在', (await win.locator('.title-bar').count()) === 1)
check('标题栏里有品牌', (await win.locator('.title-bar .logo-mark').count()) === 1)

const regions = await win.evaluate(() => {
  const bar = document.querySelector('.title-bar')
  const btn = document.querySelector('.tb-btn')
  return {
    bar: getComputedStyle(bar).webkitAppRegion,
    btn: getComputedStyle(btn).webkitAppRegion
  }
})
check('整条标题栏可拖窗口（drag）', regions.bar === 'drag', regions.bar)
check(
  '按钮自己不可拖（no-drag）—— 否则点上去是拖窗口而不是点按钮',
  regions.btn === 'no-drag',
  regions.btn
)

console.log('\n2. 三枚按钮都在')
for (const [title, label] of [
  ['最小化', '最小化'],
  ['最大化', '最大化'],
  ['关闭', '关闭']
]) {
  const n = await win.locator(`.tb-btn[title="${title}"]`).count()
  check(`有${label}按钮`, n === 1, `${n} 个`)
}

console.log('\n3. 最大化 / 还原真的作用到窗口上')
await win.locator('.tb-btn[title="最大化"]').click()
await win.waitForTimeout(900)
let st = await mainWindow()
check('点最大化 → 窗口真的最大化了', st.maximized === true, JSON.stringify(st))
check(
  '图标跟着变成「向下还原」',
  (await win.locator('.tb-btn[title="向下还原"]').count()) === 1
)

await win.locator('.tb-btn[title="向下还原"]').click()
await win.waitForTimeout(900)
st = await mainWindow()
check('再点 → 还原回非最大化', st.maximized === false, JSON.stringify(st))
check('图标变回「最大化」', (await win.locator('.tb-btn[title="最大化"]').count()) === 1)

console.log('\n4. 最小化')
await win.locator('.tb-btn[title="最小化"]').click()
await win.waitForTimeout(1200)
let evs = await winEvents()
check('点最小化 → 窗口收到了 minimize 事件', evs.includes('minimize'), evs.join(', ') || '(无事件)')
// 拉回来，免得测试窗口一直挂在任务栏上
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore())
await win.waitForTimeout(800)
evs = await winEvents()
check('恢复后窗口确实回到可见状态', (await mainWindow()).minimized === false, JSON.stringify(evs))

console.log('\n5. 关闭')
const closed = new Promise((resolve) => {
  app.on('close', () => resolve(true))
  setTimeout(() => resolve(false), 8000)
})
await win.locator('.tb-btn[title="关闭"]').click()
check('点关闭 → 应用真的退出了', await closed)

console.log(process.exitCode ? '\n结论: 存在失败项' : '\n结论: 全部通过')
