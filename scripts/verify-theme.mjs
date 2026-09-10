/**
 * 界面主题验证。
 *
 * 这个脚本存在的核心理由是**一条断言**：在亮色主题下遍历整棵 DOM 的计算样式，
 * 断言没有任何一处还等于旧的深色调色板。漏改一个色值是最容易发生、也最难发现
 * 的错误 —— 它在新深色主题下看着完全正常，只有切到亮色才露出「一块黑」。
 * 逐个人工核对 270 处不现实，机器扫一遍就必然找得出来。
 *
 * 其余覆盖：默认亮色、一键切换、三选（含跟随系统）、持久化跨重启、
 * WCAG 对比度、终端与界面联动、以及把「不许再出现硬编码色」编码成静态守卫。
 *
 * 用法：node scripts/verify-theme.mjs
 * 前置：npm run build
 * 不连任何远端，不改任何远端状态。
 */
import { _electron as electron } from 'playwright'
import { readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

/* ---------------------------------------------------------------------------
 * 旧调色板。改版前的 chrome 色值，一个都不该在新界面里出现。
 * 这是本脚本最重要的一份数据 —— 它就是「漏改检测」的比对表。
 * ------------------------------------------------------------------------- */
const LEGACY = [
  '#1a1b26', // 应用底
  '#16161e', // 面板底
  '#1f2335', // 悬停面
  '#24283b', // 活动面
  '#292e42', // 活动面悬停
  '#2a2b3d', // 边框
  '#3d59a1', // 聚焦环
  '#565f89', // 次要文字
  '#7aa2f7', // 主色
  '#9ab8ff', // 主色悬停
  '#a9b1d6', // 次级正文
  '#c0caf5', // 正文
  '#f7768e', // 危险
  '#e0af68', // 警告
  '#9ece6a' // 成功
]

/** '#1a1b26' → 'rgb(26, 27, 38)'，getComputedStyle 返回的是后者 */
const toRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
const LEGACY_RGB = LEGACY.map(toRgb)

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())

const themeNow = () => win.evaluate(() => document.documentElement.dataset.theme)
const bodyBg = () =>
  win.evaluate(() => getComputedStyle(document.getElementById('app')).backgroundColor)
const termBg = () =>
  win.evaluate(() => {
    const el = document.querySelector('.terminal-container')
    return el ? getComputedStyle(el).backgroundColor : null
  })

/** 切换主题。按稳定类名点，不按 title —— title 描述的是「点一下会切到哪」，会随状态变 */
async function switchTheme() {
  await win.locator('.sidebar .theme-toggle').click()
  await win.waitForTimeout(900)
}

/** 确保停在指定主题 */
async function ensureTheme(target) {
  if ((await themeNow()) !== target) await switchTheme()
  return (await themeNow()) === target
}

await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)
// 清布局 + reload 必须在同一次 evaluate 里：布局 store 有 400ms 防抖自动保存，
// 留出间隙它就会把当前标签重新写回快照
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
await win.waitForTimeout(3000)

// ---------- 阶段 1：令牌层与默认主题 ----------
console.log('\n阶段 1：令牌层与默认主题')
check('html 上有 data-theme 属性', (await themeNow()) !== undefined)
check('默认是亮色', (await themeNow()) === 'light', await themeNow())

const tokens = await win.evaluate(() => {
  const cs = getComputedStyle(document.documentElement)
  const names = ['--bg', '--bg-panel', '--fg', '--fg-muted', '--accent', '--danger', '--border']
  return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]))
})
check(
  '颜色令牌都有值（不是定义在了错误的层级上）',
  Object.values(tokens).every((v) => v.length > 0),
  JSON.stringify(tokens)
)
check(
  '亮色下 #app 的底色就是 --bg',
  (await bodyBg()) === 'rgb(248, 250, 255)',
  await bodyBg()
)

// ---------- 阶段 2：漏改检测（本脚本的核心） ----------
console.log('\n阶段 2：漏改检测（亮色下不该出现任何旧深色）')

/**
 * 遍历所有元素的所有颜色属性，抓出等于旧调色板的值。
 *
 * 只看 background/color/border/shadow，不看 SVG 的 fill/stroke —— 图标走
 * currentColor，本来就跟文字同色，重复统计没有意义。
 *
 * 终端区（.xterm 及其子树）与 CodeMirror 内部**排除**：它们的颜色由各自
 * 的主题系统给（终端预设 / oneDark），在亮色界面下选一个深色终端预设是
 * 用户的合法选择，不该判为漏改。终端配色是否跟着界面走，由阶段 5 单独验。
 */
const sweepExpr = (legacyList) => {
  const result = []
  const skip = (el) =>
    el.closest('.xterm') !== null ||
    el.closest('.cm-editor') !== null ||
    el.closest('.terminal-container') !== null
  for (const el of document.querySelectorAll('*')) {
    if (skip(el)) continue
    const cs = getComputedStyle(el)
    for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'outlineColor', 'boxShadow']) {
      const v = cs[prop]
      if (!v || v === 'none') continue
      for (const legacy of legacyList) {
        if (v.includes(legacy)) {
          result.push({
            tag: el.tagName,
            cls: (el.className?.toString?.() ?? '').slice(0, 60),
            prop,
            value: v.slice(0, 80)
          })
        }
      }
    }
  }
  return result
}

const leakedLight = await win.evaluate(sweepExpr, LEGACY_RGB)
check(
  '亮色下没有任何元素还在用旧深色',
  leakedLight.length === 0,
  leakedLight.length ? JSON.stringify(leakedLight.slice(0, 5), null, 1) : ''
)

// 深色下也扫一遍：防的是「把新深色写死在组件里」，那样亮色下会露黑、
// 深色下看不出来，将来再改就更难查
await ensureTheme('dark')
await win.waitForTimeout(600)
const leakedDark = await win.evaluate(sweepExpr, LEGACY_RGB)
check(
  '深色下也没有任何元素在用旧深色',
  leakedDark.length === 0,
  leakedDark.length ? JSON.stringify(leakedDark.slice(0, 5), null, 1) : ''
)

// ---------- 阶段 3：一键切换 ----------
console.log('\n阶段 3：侧栏一键切换')
await ensureTheme('light')
const tabsBefore = await win.locator('.tab').count()
check('亮色下终端底色是晴空白', (await termBg()) === 'rgb(255, 255, 255)', await termBg())

await switchTheme()
check('切换后是深色', (await themeNow()) === 'dark')
check('切换后 #app 底色跟着换', (await bodyBg()) === 'rgb(11, 18, 32)', await bodyBg())
check('切换后终端底色跟着换（界面与终端联动）', (await termBg()) === 'rgb(11, 18, 32)', await termBg())
check(
  '切换是全屏重绘而不是重建标签（标签数不变）',
  (await win.locator('.tab').count()) === tabsBefore
)

await switchTheme()
check('再切一次回到亮色', (await themeNow()) === 'light')
check('回到亮色后终端也回来了', (await termBg()) === 'rgb(255, 255, 255)', await termBg())

// ---------- 阶段 4：设置弹窗三选 ----------
console.log('\n阶段 4：设置里的三选')
await win.locator('.sidebar .icon-btn[title="设置"]').click()
await win.waitForSelector('.segmented button')

const segLabels = await win.evaluate(() =>
  [...document.querySelectorAll('.segmented button')].map((b) => b.textContent.trim())
)
check('三选是 亮色/深色/跟随系统', segLabels.join('/') === '亮色/深色/跟随系统', segLabels.join('/'))

await win.locator('.segmented button', { hasText: '深色' }).click()
await win.waitForTimeout(700)
check('点「深色」立刻生效', (await themeNow()) === 'dark')

await win.locator('.segmented button', { hasText: '跟随系统' }).click()
await win.waitForTimeout(700)
const sysDark = await win.evaluate(
  () => window.matchMedia('(prefers-color-scheme: dark)').matches
)
check(
  '点「跟随系统」后与系统深浅一致',
  (await themeNow()) === (sysDark ? 'dark' : 'light'),
  `系统偏好深色=${sysDark}`
)

await win.locator('.segmented button', { hasText: '亮色' }).click()
await win.waitForTimeout(700)
check('点回「亮色」', (await themeNow()) === 'light')

// 终端配色确实**跟随**界面，而不是写死某一套
const autoSwatch = await win.evaluate(() => {
  const row = [...document.querySelectorAll('.theme-item')].find((el) =>
    el.textContent.includes('跟随界面')
  )
  return row ? getComputedStyle(row.querySelector('.swatch')).backgroundColor : null
})
check('「跟随界面主题」色板在亮色下显示浅色', autoSwatch === 'rgb(255, 255, 255)', String(autoSwatch))

await win.locator('.segmented button', { hasText: '深色' }).click()
await win.waitForTimeout(700)
const autoSwatchDark = await win.evaluate(() => {
  const row = [...document.querySelectorAll('.theme-item')].find((el) =>
    el.textContent.includes('跟随界面')
  )
  return row ? getComputedStyle(row.querySelector('.swatch')).backgroundColor : null
})
check(
  '「跟随界面主题」色板切到深色后也跟着变',
  autoSwatchDark === 'rgb(11, 18, 32)',
  String(autoSwatchDark)
)
await win.keyboard.press('Escape')
await win.waitForTimeout(400)

// ---------- 阶段 5：对比度 ----------
console.log('\n阶段 5：对比度（WCAG）')

/** 在页面里算真实对比度：拿计算样式的 color 与最近的实心背景色 */
const contrastExpr = (selectors) => {
  const srgb = (c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b)
  const parse = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const parts = m[1].split(',').map((x) => parseFloat(x))
    return { rgb: parts.slice(0, 3), a: parts.length > 3 ? parts[3] : 1 }
  }
  /** 往上找最近的、真的画了背景的祖先 */
  const bgOf = (el) => {
    let node = el
    while (node) {
      const c = parse(getComputedStyle(node).backgroundColor)
      if (c && c.a > 0.95) return c.rgb
      node = node.parentElement
    }
    return [255, 255, 255]
  }
  const out = []
  for (const sel of selectors) {
    const el = document.querySelector(sel)
    if (!el) {
      out.push({ sel, missing: true })
      continue
    }
    const fg = parse(getComputedStyle(el).color)
    if (!fg) continue
    const bg = bgOf(el)
    const l1 = lum(fg.rgb)
    const l2 = lum(bg)
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    out.push({
      sel,
      ratio: Math.round(ratio * 100) / 100,
      size: parseFloat(getComputedStyle(el).fontSize),
      text: (el.textContent || '').trim().slice(0, 16)
    })
  }
  return out
}

// 挑的都是「真的会显示文字」的地方：次要文字是最容易翻车的一档，
// 因为它在深色下只是"暗一点"，在浅色下容易变成"看不见"
const TEXT_SELECTORS = [
  '.logo',
  '.device-name',
  '.device-host',
  '.section-head .head-label',
  '.empty-hint',
  '.tab-title',
  '.scroll-hint, .hint'
]

for (const theme of ['light', 'dark']) {
  await ensureTheme(theme)
  await win.waitForTimeout(600)
  if (theme === 'dark') {
    // 深色下要展开侧栏分区才有那些文字节点
    for (let pass = 0; pass < 3; pass++) {
      const collapsed = win.locator('.sidebar .section-head[aria-expanded="false"]')
      if ((await collapsed.count()) === 0) break
      await collapsed.first().click()
      await win.waitForTimeout(250)
    }
  }
  const results = await win.evaluate(contrastExpr, TEXT_SELECTORS)
  const present = results.filter((r) => !r.missing)
  const failing = present.filter((r) => r.ratio < 4.5)
  check(
    `${theme}：有文字的元素都达到 WCAG AA（4.5:1）`,
    failing.length === 0,
    failing.map((r) => `${r.sel} ${r.ratio}:1 (${r.size}px)`).join(', ')
  )
  const worst = present.slice().sort((a, b) => a.ratio - b.ratio)[0]
  if (worst) console.log(`    · 最紧的一处：${worst.sel} = ${worst.ratio}:1`)
}

// ---------- 阶段 6：持久化跨重启 ----------
console.log('\n阶段 6：持久化跨重启')
await ensureTheme('dark')
await win.waitForTimeout(900)
await app.close()

const app2 = await electron.launch({ args: ['.'] })
const win2 = await app2.firstWindow()
// 尽早读：这里同时验了「启动即正确」——若不成立，用户会看到先闪一下亮色
await win2.waitForLoadState('domcontentloaded')
const earlyTheme = await win2.evaluate(() => document.documentElement.dataset.theme)
check('重启后仍是深色', earlyTheme === 'dark', String(earlyTheme))
const winBg = await app2.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows()[0].getBackgroundColor()
)
check(
  '窗口原生底色也跟着是深色（否则启动瞬间会闪一块亮色）',
  winBg.toLowerCase() === '#0b1220',
  winBg
)
await app2.close()

// ---------- 阶段 7：静态守卫 ----------
console.log('\n阶段 7：静态守卫（硬编码色不许再出现）')

/** 递归收集渲染层里所有 vue / css 源码 */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) collect(p, out)
    else if (/\.(vue|css)$/.test(entry.name)) out.push(p)
  }
  return out
}

const files = collect('src/renderer/src')
const offenders = []
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  for (const hex of LEGACY) {
    if (src.toLowerCase().includes(hex)) offenders.push(`${file}: ${hex}`)
  }
}
check(
  `渲染层源码里不再出现旧调色板字面量（扫了 ${files.length} 个文件）`,
  offenders.length === 0,
  offenders.slice(0, 6).join(', ')
)

// 令牌只允许定义在 styles.css 里；散在组件里就等于没有令牌层
const defining = files.filter(
  (f) => !f.endsWith('styles.css') && /--(bg|fg|accent|border|danger|success|warning)[a-z-]*\s*:/.test(readFileSync(f, 'utf8'))
)
check('颜色令牌只在 styles.css 里定义', defining.length === 0, defining.join(', '))

check(
  '主题默认值仍是亮色（新装用户的第一印象）',
  readFileSync('src/renderer/src/stores/settings.ts', 'utf8').includes("uiTheme: 'light'")
)

console.log(process.exitCode ? '\n结论: 存在失败项' : '\n结论: 全部通过')
process.exit(process.exitCode ?? 0)
