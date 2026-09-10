/**
 * 界面走查回归：把「看着别扭」的那几处钉成断言。
 *
 *   A. SFTP 行尾按钮不再白占宽度（文件名不被挤到 7 个字符）
 *   B. 面包屑任何深度都只有一个斜杠
 *   C. 活动标签与标签栏底色有明显区分
 *   D. 三个弹窗都能按 Esc 关闭
 *   E. 图标统一走 SVG，按钮里不再有 emoji / 文字字形
 *
 * 用法：node scripts/verify-ui-polish.mjs
 * 前置：npm run build
 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const outDir = 'shots/polish'
mkdirSync(outDir, { recursive: true })

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)
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

// 把颜色统一转成 rgb 分量和，方便比较两个色差多少
const rgbSum = (s) => (s.match(/\d+/g) ?? []).slice(0, 3).reduce((a, b) => a + Number(b), 0)

// ---------- C. 活动标签可辨识度 ----------
console.log('C. 活动标签')
const tabColors = await win.evaluate(() => {
  const active = document.querySelector('.tab.active')
  const bar = document.querySelector('.tab-bar')
  return {
    active: active ? getComputedStyle(active).backgroundColor : null,
    bar: bar ? getComputedStyle(bar).backgroundColor : null,
    shadow: active ? getComputedStyle(active).boxShadow : null
  }
})
const delta = Math.abs(rgbSum(tabColors.active ?? 'rgb(0,0,0)') - rgbSum(tabColors.bar ?? 'rgb(0,0,0)'))
check(
  '活动标签背景与标签栏有可见差别（色差和 > 30）',
  delta > 30,
  `${tabColors.active} vs ${tabColors.bar}，差 ${delta}`
)
check('活动标签另有顶部高亮线', (tabColors.shadow ?? '').includes('inset'), tabColors.shadow ?? '')
await win.screenshot({ path: join(outDir, '10-tab-active.png'), clip: { x: 260, y: 0, width: 560, height: 46 } })

// ---------- E. 图标统一为 SVG ----------
console.log('\nE. 图标')
const iconAudit = await win.evaluate(() => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{FF0B}\u{2660}-\u{266F}]/u
  const buttons = [...document.querySelectorAll('.icon-btn, .tab-new, .tab-close, .bar-btn')]
  return {
    total: buttons.length,
    withSvg: buttons.filter((b) => b.querySelector('svg')).length,
    // 有 svg 的按钮里不该再残留字形
    leftover: buttons
      .filter((b) => b.querySelector('svg') && emoji.test(b.textContent ?? ''))
      .map((b) => `${b.title || b.className}="${(b.textContent ?? '').trim()}"`)
  }
})
check(
  '所有图标按钮都用 SVG',
  iconAudit.total > 0 && iconAudit.withSvg === iconAudit.total,
  `${iconAudit.withSvg}/${iconAudit.total}`
)
check('按钮里不再残留 emoji / 字形', iconAudit.leftover.length === 0, iconAudit.leftover.join(', '))

// ---------- D. Esc 关闭弹窗 ----------
console.log('\nD. Esc 关闭弹窗')
await win.locator('button[title="设置"]').click()
await win.waitForTimeout(400)
check('设置弹窗已打开', (await win.locator('.overlay .dialog-header:has-text("设置")').count()) > 0)
await win.keyboard.press('Escape')
await win.waitForTimeout(400)
check('Esc 关掉了设置弹窗', (await win.locator('.overlay').count()) === 0)

await win.locator('.add-btn').click()
await win.waitForTimeout(400)
check('添加设备弹窗已打开', (await win.locator('.overlay .dialog-header:has-text("添加设备")').count()) > 0)
await win.keyboard.press('Escape')
await win.waitForTimeout(400)
check('Esc 关掉了添加设备弹窗', (await win.locator('.overlay').count()) === 0)

// ---------- 连上设备，检查 SFTP ----------
const deviceCount = await win.locator('.device').count()
if (!deviceCount) {
  console.log('\n没有已保存设备，跳过 A/B（SFTP 相关断言）')
  console.log(process.exitCode ? '\n结论: 存在失败项' : '\n结论: 全部通过')
  await app.close()
  process.exit(process.exitCode ?? 0)
}

await win.locator('.device .device-name').first().dblclick()
await win.waitForFunction(
  () => document.querySelectorAll('.terminal-container').length >= 2,
  undefined, { timeout: 25000 }
)
await win.waitForTimeout(2500)
await win.locator('button:has-text("SFTP")').click()
await win.locator('.explorer .row').first().waitFor({ timeout: 15000 })
await win.waitForTimeout(1200)

// ---------- B. 面包屑 ----------
console.log('\nB. 面包屑')
const crumb = await win.evaluate(() => document.querySelector('.breadcrumb')?.textContent?.replace(/\s+/g, '') ?? '')
check('面包屑没有连续斜杠', !crumb.includes('//'), crumb)
check('面包屑不是「/ / xxx」', !/\/\s*\/\s*\//.test(crumb), crumb)

// ---------- A. 文件名可用宽度 ----------
console.log('\nA. 文件名宽度')
const nameStats = await win.evaluate(() => {
  const rows = [...document.querySelectorAll('.file-list .row')]
  const names = rows.map((r) => r.querySelector('.file-name')).filter(Boolean)
  const actions = [...document.querySelectorAll('.row-actions')]
  return {
    minWidth: Math.min(...names.map((n) => n.clientWidth)),
    truncated: names.filter((n) => n.scrollWidth > n.clientWidth + 1).length,
    total: names.length,
    // 不悬停时按钮是 display:none，宽高都是 0 —— 不再偷走横向空间
    actionWidth: actions.length ? actions[0].getBoundingClientRect().width : -1,
    sample: names.slice(0, 3).map((n) => n.textContent)
  }
})
check('行尾按钮不占宽度（未悬停时为 0）', nameStats.actionWidth === 0, String(nameStats.actionWidth))
check(
  '文件名列拿到足够宽度（≥100px）',
  nameStats.minWidth >= 100,
  `${nameStats.minWidth}px`
)
check(
  '仍有名字被截断的比例不超过 1/4',
  nameStats.truncated <= Math.ceil(nameStats.total / 4),
  `${nameStats.truncated}/${nameStats.total} 被截断`
)
await win.screenshot({ path: join(outDir, '11-sftp-names.png') })

// 悬停时按钮应出现，并且压在行内而不是把行撑开。
// 用 locator.hover() 而不是手算坐标：SFTP 列表在跟随终端时会自行刷新，
// 手算的坐标会落在刷新后已经位移的行上，断言随机失败。
const secondRow = win.locator('.file-list .row').nth(1)
let hovered = { visible: false }
for (let i = 0; i < 10 && !hovered.visible; i++) {
  await secondRow.hover()
  await win.waitForTimeout(200)
  hovered = await win.evaluate(() => {
    const a = document.querySelector('.file-list .row:hover .row-actions')
    return { visible: !!a && getComputedStyle(a).display !== 'none' }
  })
}
check('悬停时行尾按钮出现', hovered.visible)
await win.screenshot({ path: join(outDir, '12-row-hover.png') })

await win.evaluate(() => window.api.setLayout({ tabs: [] }))
console.log(process.exitCode ? '\n结论: 存在失败项' : '\n结论: 全部通过')
await app.close()
process.exit(process.exitCode ?? 0)
