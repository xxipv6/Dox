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
// 截图区域按元素实际位置取，不写死坐标：标题栏插进来之后，
// 原来写死的 y:0 截到的已经不是标签栏了（这行本身没报错，只是悄悄截错地方）
const tabBarBox = await win.locator('.tab-bar').boundingBox()
await win.screenshot({
  path: join(outDir, '10-tab-active.png'),
  clip: tabBarBox ?? { x: 260, y: 36, width: 560, height: 48 }
})

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

// 侧栏改版后「添加设备」不再是 .add-btn，而是标题栏里的图标按钮（按 title 认）
await win.locator('button[title="添加设备"]').click()
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
// 先把鼠标挪开。Playwright 的鼠标位置会跨步骤保留，前面点过按钮之后
// 可能正好停在某一行上，那样量到的就是悬停态而不是静止态。
await win.mouse.move(2, 2)
await win.waitForTimeout(200)
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
    // 非 0 时要知道是谁在 hover，否则只能看到数字瞎猜
    hoverCount: document.querySelectorAll('.file-list .row:hover').length,
    flexCount: actions.filter((a) => getComputedStyle(a).display !== 'none').length,
    sample: names.slice(0, 3).map((n) => n.textContent)
  }
})
check(
  '行尾按钮不占宽度（未悬停时为 0）',
  nameStats.actionWidth === 0,
  `${nameStats.actionWidth}px（悬停行 ${nameStats.hoverCount} 个，展开的按钮组 ${nameStats.flexCount} 个）`
)
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

// ---------- F. 选中模型（对齐本地文件管理器的操作习惯）----------
console.log('\nF. 选中')

const selection = () =>
  win.evaluate(() => {
    const rows = [...document.querySelectorAll('.file-list .row')]
    return {
      count: rows.filter((r) => r.classList.contains('selected')).length,
      names: rows
        .filter((r) => r.classList.contains('selected'))
        .map((r) => (r.querySelector('.file-name')?.textContent ?? '').trim()),
      // 选中行的实际底色，用来确认不是只加了个 class 而没样式
      bg: (() => {
        const el = rows.find((r) => r.classList.contains('selected'))
        return el ? getComputedStyle(el).backgroundColor : null
      })(),
      bar: (() => {
        const el = rows.find((r) => r.classList.contains('selected'))
        return el ? getComputedStyle(el, '::before').width : null
      })()
    }
  })

const rowAt = (i) => win.locator('.file-list .row').nth(i)
const rowNames = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.file-list .row')].map((r) =>
      (r.querySelector('.file-name')?.textContent ?? '').trim()
    )
  )

/**
 * 点完之后把鼠标挪开再读样式。
 *
 * 鼠标停在刚点过的那一行上，量到的是 `.row.selected:hover` 的悬停底色，
 * 不是静止态的选中底色 —— 断言会莫名其妙地失败在一个「颜色不对」上，
 * 而其实样式完全正确。
 */
const clickThenPark = async (index, options) => {
  await rowAt(index).click(options)
  await win.mouse.move(2, 2)
  await win.waitForTimeout(250) // 等 --dur-base(120ms) 过渡走完
}

/**
 * 某个颜色令牌在当前主题下的**计算值**。
 *
 * 断言要盯着令牌本身，而不是写死一个色值：界面的配色是一层可换的令牌
 * （亮色「晴空」/ 深色「冷夜」），写死色值等于把测试绑死在某一次配色上 ——
 * 换配色时它会红，但它红的原因跟「选中行有没有底色」毫无关系。
 */
const tokenColor = (name, prop = 'background') =>
  win.evaluate(
    ({ n, p }) => {
      const probe = document.createElement('div')
      probe.style.setProperty(p, `var(${n})`)
      document.body.appendChild(probe)
      const v = getComputedStyle(probe)[p === 'background' ? 'backgroundColor' : p]
      probe.remove()
      return v
    },
    { n: name, p: prop }
  )

// 起点：还没点过任何行
check('起点没有选中项', (await selection()).count === 0)

await clickThenPark(1)
let s = await selection()
check('单击选中一行', s.count === 1, JSON.stringify(s))
check(
  '选中行有实际底色（就是 --bg-active，不是只有 class）',
  s.bg === (await tokenColor('--bg-active')),
  `${s.bg} vs --bg-active ${await tokenColor('--bg-active')}`
)
check('选中行左侧有竖条', s.bar === '2px', String(s.bar))
await win.screenshot({ path: join(outDir, '13-selection.png') })

await clickThenPark(3)
check('普通点击是单选（前一个取消）', (await selection()).count === 1)

await clickThenPark(5, { modifiers: ['Control'] })
check('Ctrl+点击 加到选区', (await selection()).count === 2, JSON.stringify((await selection()).names))

// Shift 连选 = 锚点(5) 到目标(8) 的闭区间，再并上已有的选区。
// 锚点在第 5 项已经选中，所以并集是 5 项而不是 4 项。
await clickThenPark(8, { modifiers: ['Shift'] })
s = await selection()
const names = await rowNames()
const expected = [3, 5, 6, 7, 8].map((i) => names[i]).sort()
check(
  'Shift+点击 连选到锚点',
  JSON.stringify([...s.names].sort()) === JSON.stringify(expected),
  `${JSON.stringify(s.names)} 期望 ${JSON.stringify(expected)}`
)

await clickThenPark(5, { modifiers: ['Control'] })
check('Ctrl+点击已选中项是取消它', (await selection()).count === 4, JSON.stringify((await selection()).names))

/*
 * 点列表空白处清空。
 *
 * 这里不能用「点 (5,5)」糊弄过去 —— 当前目录 36 项，列表是撑满且溢出的，
 * (5,5) 落在第一行上，测的是「点了第一行」。真正的空白区在内容不足一屏时
 * 才存在。所以两种情形分开测：
 *   内容溢出 → 直接派发一次 click 到 .file-list 自身，验证 @click.self 的绑定
 *   内容不满 → 用真实鼠标点最后一行下方的空白
 */
const listHasBlank = await win.evaluate(() => {
  const list = document.querySelector('.file-list')
  return !!list && list.scrollHeight <= list.clientHeight - 20
})
if (listHasBlank) {
  const box = await win.locator('.file-list').boundingBox()
  await win.mouse.click(box.x + 5, box.y + box.height - 6)
  await win.waitForTimeout(200)
  check('点空白处清空选中（真实鼠标）', (await selection()).count === 0)
} else {
  await win.locator('.file-list').dispatchEvent('click')
  await win.waitForTimeout(200)
  check('点空白处清空选中（@click.self 绑定）', (await selection()).count === 0)
}

// 换目录后旧路径没意义，必须一并清掉
await clickThenPark(1)
check('换目录前有选中项', (await selection()).count === 1)
const dirIndex = (await win.evaluate(() =>
  [...document.querySelectorAll('.file-list .row')].findIndex((r) =>
    r.querySelector('.file-icon.dir')
  )
))
if (dirIndex >= 0) {
  await rowAt(dirIndex).dblclick()
  await win.waitForTimeout(900)
  check('切换目录后选中被清空', (await selection()).count === 0)
} else {
  console.log('  · 当前目录没有子目录，跳过「换目录清空选中」')
}

// ---------- G. 过渡（“弹弹的”但克制）----------
console.log('\nG. 过渡')
const motion = await win.evaluate(() => {
  const pick = (sel, pseudo) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const cs = getComputedStyle(el, pseudo ?? undefined)
    return { dur: cs.transitionDuration, prop: cs.transitionProperty }
  }
  return {
    row: pick('.file-list .row'),
    tab: pick('.tab'),
    device: pick('.device'),
    icon: pick('.icon-btn')
  }
})
const hasMotion = (m) => !!m && m.dur !== '0s' && m.dur !== 'all 0s'
check('文件行有过渡', hasMotion(motion.row), JSON.stringify(motion.row))
check('标签有过渡', hasMotion(motion.tab), JSON.stringify(motion.tab))
check('设备行有过渡', hasMotion(motion.device), JSON.stringify(motion.device))
check('图标按钮有过渡', hasMotion(motion.icon), JSON.stringify(motion.icon))

// ---------- H. 设备搜索 ----------
/*
 * 这里用注入的假设备跑，不动用户真实保存的那些：
 * 真机上可能只有一台设备，删掉再建来验过滤太伤，而「只有一台」也验不出
 * 「筛掉一部分」这个关键行为。
 */
console.log('\nH. 设备搜索')
const devices = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.device .device-name')].map((e) => e.textContent?.trim() ?? '')
  )
const hintText = () =>
  win.evaluate(
    () => document.querySelector('.device-list .empty-hint')?.textContent?.trim() ?? ''
  )

const restore = await win.evaluate(() => window.api.listSessions())
const fake = [
  { name: '生产机 A', host: '10.0.0.5', port: 22, username: 'root', authType: 'password' },
  { name: '测试机 B', host: 'example.com', port: 2222, username: 'deploy', authType: 'password' }
]
for (const s of fake) await win.evaluate((x) => window.api.saveSession(x), s)
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await win.reload()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

const all = await devices()
check('起点：假设备都在', all.length >= 2, all.join(' | '))

const type = async (t) => {
  await win.locator('.search-input').fill(t)
  await win.waitForTimeout(400)
}

await type('测试')
let shown = await devices()
check(
  '按名称过滤',
  shown.length === 1 && shown[0].includes('测试'),
  shown.join(' | ')
)

await type('10.0.0.5')
shown = await devices()
check(
  '按地址过滤（只匹配名称的话，记得 IP 的人会觉得搜索是坏的）',
  shown.length === 1 && shown[0].includes('生产'),
  shown.join(' | ')
)

await type('deploy')
shown = await devices()
check('按登录名过滤', shown.length === 1 && shown[0].includes('测试'), shown.join(' | '))

await type('2222')
shown = await devices()
check('按端口过滤', shown.length === 1 && shown[0].includes('测试'), shown.join(' | '))

await type('zzz-不存在')
shown = await devices()
check('无匹配时列表为空', shown.length === 0, shown.join(' | '))
check(
  '无匹配的文案与「一台设备都没有」是两句话',
  (await hintText()).includes('没有匹配'),
  await hintText()
)

await win.locator('.search-clear').click()
await win.waitForTimeout(400)
check('点清空恢复全部', (await devices()).length === all.length, (await devices()).join(' | '))

// 收尾：把注入的假设备删掉，别留在用户配置里
for (const s of await win.evaluate(() => window.api.listSessions())) {
  if (fake.some((f) => f.name === s.name)) {
    await win.evaluate((id) => window.api.deleteSession(id), s.id)
  }
}
const left = await win.evaluate(() => window.api.listSessions())
check(
  '清理干净（假设备已删除，真实设备未受影响）',
  left.length === restore.length,
  `原有 ${restore.length} / 现在 ${left.length}`
)

await win.evaluate(() => window.api.setLayout({ tabs: [] }))
console.log(process.exitCode ? '\n结论: 存在失败项' : '\n结论: 全部通过')
await app.close()
process.exit(process.exitCode ?? 0)
