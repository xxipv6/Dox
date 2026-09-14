/**
 * HIG 打磨那一轮的验证：令牌单一出处、浮层材质与进退场、按下反馈、
 * 终端内边距、以及「减弱动效」的降级。
 *
 *  阶段 1（静态，不需要 dev）：令牌在**两套主题块**里都定义了；组件里不再有
 *          写死的时长 / 缓动 / 模糊；重复定义过的类收进了全局。
 *  阶段 2（端到端，需要 dev 在跑）：起隔离实例，量真实计算样式 ——
 *          浮层是半透明 + 模糊、进场动效时长来自令牌、按住不放真的有按下态、
 *          终端内容四周有内边距且**没有把 fit 算坏**、系统要求减弱动效时降级。
 *
 * 用法：node scripts/verify-hig.mjs          # 只跑阶段 1
 *      node scripts/verify-hig.mjs --e2e      # 阶段 1 + 阶段 2
 * 前置（阶段 2）：npm run dev（脚本用 --user-data-dir 起**独立**实例，不动你在跑的那个）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

process.on('unhandledRejection', () => {})

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

const SRC = 'src/renderer/src'
const STYLES = `${SRC}/styles.css`

// ---------------------------------------------------------------- 阶段 1
console.log('阶段 1：令牌单一出处（静态守卫）')

const css = readFileSync(STYLES, 'utf8')

/** 只取某个主题块（从它的选择器到下一个顶层 `}`），免得两套主题串味 */
function themeBlock(selector) {
  const at = css.indexOf(selector)
  if (at < 0) return ''
  const end = css.indexOf('\n}', at)
  return css.slice(at, end < 0 ? undefined : end)
}
const light = themeBlock(":root,\n:root[data-theme='light']")
const dark = themeBlock(":root[data-theme='dark']")

check('亮色块存在且能找到', light.length > 100)
check('深色块存在且能找到', dark.length > 100)
// 材质是唯一一个「必须两套主题各写一份」的新令牌（它随底色走）
check('亮色定义了 --material', /--material:\s*rgba\(/.test(light))
check('深色定义了 --material', /--material:\s*rgba\(/.test(dark))

const shared = [
  '--dur-gauge',
  '--ease-enter',
  '--sp-6',
  '--fs-2xl',
  '--lh-tight',
  '--lh-base',
  '--z-dialog',
  '--z-menu',
  '--z-toast',
  '--material-blur',
  '--blur-veil',
  '--font-mono'
]
const missing = shared.filter((t) => !new RegExp(`${t}:`).test(css))
check('不随主题变的令牌都在 :root 定义', missing.length === 0, missing.join(', '))

check(
  '减弱动效的降级块存在（且把四个时长令牌清零）',
  /@media \(prefers-reduced-motion: reduce\)/.test(css) &&
    ['--dur-fast', '--dur-base', '--dur-slow', '--dur-gauge'].every((t) =>
      new RegExp(`@media \\(prefers-reduced-motion: reduce\\)[\\s\\S]*${t}:\\s*0ms`).test(css)
    )
)
check(
  '降级只停「呼吸」类脉冲，不碰加载转圈（spinner 是必要反馈）',
  /prefers-reduced-motion[\s\S]*\.pulse[\s\S]*animation: none/.test(css) &&
    !/prefers-reduced-motion[\s\S]*\.spinner[\s\S]*animation: none/.test(css)
)

// 全局类：这些语义只该有一处定义
for (const cls of ['.btn', '.close-btn', '.menu-item', '.empty-hint', '.error-banner', '.retry', '.overlay', '.dialog']) {
  check(`styles.css 定义了全局 ${cls}`, new RegExp(`\\${cls} \\{`).test(css))
}
// 组件里不许再抄一份基础规则（.btn 只允许留变体，比如 HostKeyDialog 的 flex）
const dupChecks = [
  [/^\.empty-hint \{/m, '空态文案'],
  [/^\.error-banner \{/m, '错误横幅'],
  [/\.overlay \{\n\s*position: fixed/, '弹窗遮罩'],
  [/^\.close-btn \{/m, '关闭键'],
  [/^\.menu-item \{/m, '菜单项']
]

/** 递归收集组件文件 */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}
const vueFiles = walk(SRC)

const dupHits = []
const literalTime = []
const literalEase = []
const literalBlur = []
const literalMono = []
for (const f of vueFiles) {
  const lines = readFileSync(f, 'utf8').split('\n')
  lines.forEach((line, i) => {
    const t = line.trim()
    // 注释行不算：说明文字里出现「160ms」正是我们希望的（解释为什么是这个值）
    const isComment = t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')
    if (isComment) return
    for (const [re, label] of dupChecks) {
      if (re.test(line)) dupHits.push(`${f}:${i + 1} ${label}`)
    }
    // 时长：周期动画（呼吸、转圈）单列，它们不是交互动效
    if (!line.includes('animation:') && /\b\d+(\.\d+)?(ms|s)\b/.test(line)) {
      literalTime.push(`${f}:${i + 1} ${t}`)
    }
    if (line.includes('cubic-bezier(')) literalEase.push(`${f}:${i + 1} ${t}`)
    if (/\bblur\(/.test(line) && !line.includes('var(--')) literalBlur.push(`${f}:${i + 1} ${t}`)
    /*
     * 等宽字体也必须走令牌。写死 `Consolas, monospace` 的后果不是报错而是
     * **静默降级**：mac 上 Consolas 不存在，会掉到通用 monospace，和隔壁
     * 用令牌的面板长得不一样；Windows 上反过来。同一排面板两套字形，
     * 就是这么来的（`--font-mono` 曾长期没定义，5 处 var() 全在空转）。
     */
    if (
      /font-family:/.test(line) &&
      !/font-family:\s*(var\(|inherit)/.test(line) &&
      /mono|Consolas|Menlo|'SF Mono'/.test(line)
    ) {
      literalMono.push(`${f}:${i + 1} ${t}`)
    }
  })
}
check('组件里没有重复定义的基础类', dupHits.length === 0, dupHits.slice(0, 5).join(' | '))
check(
  '组件里没有写死的时长（全部走 --dur-* 令牌）',
  literalTime.length === 0,
  literalTime.slice(0, 5).join(' | ')
)
check('组件里没有写死的缓动曲线', literalEase.length === 0, literalEase.slice(0, 5).join(' | '))
check('组件里没有写死的模糊半径（走 --material-blur / --blur-veil）', literalBlur.length === 0, literalBlur.slice(0, 3).join(' | '))
check(
  '组件里没有写死的等宽字体（走 --font-mono）',
  literalMono.length === 0,
  literalMono.slice(0, 5).join(' | ')
)

/*
 * 应用菜单：两个平台两条路，静态守的是「别哪天顺手把条件删了」。
 *
 * - 非 macOS 必须**置空**：默认菜单里「关闭窗口」占着 CmdOrCtrl+W，用户按 Ctrl+W
 *   想关标签结果整扇窗没了；还留着 F11 / DevTools 这些加速键。
 * - macOS 必须**自建一份**（不能置空 —— 系统菜单栏是 ⌘C/⌘V/⌘Q 的唯一来源；
 *   也不能留默认的 —— 那条「关闭窗口」的加速键正是 ⌘W）。
 *   菜单内容对不对，由 verify-tabbar 在真 mac 上读 Menu.getApplicationMenu() 验。
 */
const mainIndex = readFileSync('src/main/index.ts', 'utf8')
const menuNullOnOthers =
  /if \(process\.platform !== 'darwin'\) \{\s*\n\s*Menu\.setApplicationMenu\(null\)/.test(mainIndex)
const menuBuiltOnMac =
  /else \{\s*\n\s*Menu\.setApplicationMenu\(\s*\n\s*Menu\.buildFromTemplate\(/.test(mainIndex)
const menuUnguarded = /\n\s*Menu\.setApplicationMenu\(null\)/g
check('非 macOS 上摘掉默认应用菜单（Ctrl+W 抢窗、F11、DevTools 一起消失）', menuNullOnOthers)
check('macOS 上不是置空而是自建菜单（置空会废掉 Cmd+C/V/Q）', menuBuiltOnMac)
// 置空只允许出现在上面那个 if 里一次；多出来的那处必然是无条件的
check(
  '摘菜单只有一处、且在平台分支里（不能无条件执行）',
  (mainIndex.match(menuUnguarded) ?? []).length === 1,
  String((mainIndex.match(menuUnguarded) ?? []).length)
)

// ---------------------------------------------------------------- 阶段 2
if (process.argv.includes('--e2e')) {
  console.log('阶段 2：端到端（隔离实例）')
  const { _electron } = await import('playwright')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const { tmpdir } = await import('node:os')

  const userData = mkdtempSync(join(tmpdir(), 'dox-hig-'))
  const app = await _electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RENDERER_URL: 'http://localhost:5173/' }
  })

  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => console.log(`  [渲染层报错] ${e.message}`))
    await win.waitForLoadState('domcontentloaded')
    await win.waitForTimeout(1500)
    await win.evaluate(() => window.api.setLayout({ tabs: [] })).catch(() => {})
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForFunction(
      () => document.querySelectorAll('.terminal-container').length >= 1,
      undefined,
      { timeout: 25000 }
    )
    await win.waitForTimeout(2000)

    /** 造一个临时的探针元素量某个过渡类算出来的时长（类只在过渡期间挂得上，量不到） */
    const probe = (cls, prop) =>
      win.evaluate(
        ([c, p]) => {
          const el = document.createElement('div')
          el.className = c
          document.body.appendChild(el)
          const v = getComputedStyle(el)[p]
          el.remove()
          return v
        },
        [cls, prop]
      )

    // ---- 浮层材质 ----
    await win.locator('.sidebar .icon-btn[title="设置"]').click()
    await win.waitForTimeout(600)
    check('设置弹窗打开了', (await win.locator('.overlay .dialog').count()) === 1)

    const surface = await win.evaluate(() => {
      const el = document.querySelector('.overlay .dialog')
      const cs = getComputedStyle(el)
      const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/)
      const parts = m ? m[1].split(',').map((x) => Number(x.trim())) : []
      return {
        alpha: parts.length === 4 ? parts[3] : 1,
        backdrop: cs.backdropFilter || cs.webkitBackdropFilter,
        radius: cs.borderTopLeftRadius,
        shadow: cs.boxShadow,
        animation: cs.animationName,
        // 里面的内容面必须还是不透明的（半透明只给最外层）
        innerBg: getComputedStyle(document.querySelector('.overlay .dialog .field') ?? el)
          .backgroundColor
      }
    })
    check('弹窗是半透明材质（alpha < 1）', surface.alpha < 1, `alpha=${surface.alpha}`)
    check('弹窗带背景模糊', /blur\(/.test(surface.backdrop ?? ''), surface.backdrop)
    check('弹窗圆角是令牌里那一档（16px）', surface.radius === '16px', surface.radius)
    check('弹窗有阴影（层级靠阴影表达）', surface.shadow !== 'none', surface.shadow)
    check('弹窗进场有动画', surface.animation === 'pop-in', surface.animation)

    const enterDur = await probe('pop-enter-active', 'transitionDuration')
    const leaveDur = await probe('pop-leave-active', 'transitionDuration')
    check('进场时长 = --dur-base（180ms）', enterDur.startsWith('0.18s'), enterDur)
    check('退场更快 = --dur-fast（120ms）', leaveDur.startsWith('0.12s'), leaveDur)

    await win.screenshot({ path: 'shots/hig-light-dialog.png' })
    console.log('  截图：shots/hig-light-dialog.png')
    await win.keyboard.press('Escape')
    await win.waitForTimeout(500)

    // ---- 按下反馈（按住不放时量，松开就没了）----
    const barBtn = win.locator('.bar-btn').first()
    const box = await barBtn.boundingBox()
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await win.mouse.down()
    await win.waitForTimeout(120)
    const pressed = await win.evaluate(() => {
      const el = document.querySelector('.bar-btn')
      const cs = getComputedStyle(el)
      return { transform: cs.transform, bg: cs.backgroundColor }
    })
    await win.mouse.up()
    await win.waitForTimeout(200)
    const released = await win.evaluate(() => {
      const el = document.querySelector('.bar-btn')
      const cs = getComputedStyle(el)
      return { transform: cs.transform, bg: cs.backgroundColor }
    })
    check(
      '按住工具栏按钮时真的下沉（按下态存在）',
      pressed.transform !== 'none' && pressed.transform !== released.transform,
      JSON.stringify(pressed)
    )

    // ---- 热区 ----
    const hits = await win.evaluate(() => {
      const size = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return [Math.round(r.width), Math.round(r.height)]
      }
      return { tabClose: size('.tab-close'), iconBtn: size('.sidebar .icon-btn') }
    })
    check('标签关闭键 ≥24×24', hits.tabClose && Math.min(...hits.tabClose) >= 24, JSON.stringify(hits.tabClose))
    check('图标按钮 ≥24×24', hits.iconBtn && Math.min(...hits.iconBtn) >= 24, JSON.stringify(hits.iconBtn))

    /*
     * ---- 全屏浮层背板不许盖住标题栏 ----
     *
     * Windows 走 frame:false，最小化 / 最大化 / 关闭是标题栏里的 DOM 按钮；
     * 浮层那层 `position: fixed; inset: 0` + --z-pill 的透明背板一盖上去，
     * 点第一下只会把浮层关掉（浮层甚至可能没开着），窗口还拖不动。
     * macOS 的红绿灯是系统层画的、压在 webview 之上，**这个错误在 mac 上看不见**，
     * 所以只能靠这条守着。
     *
     * 这里自己造一块同层级的背板再对标题栏做命中测试 —— 比只比 z-index 更接近
     * 真正要保证的事：按钮点得到的。AI 容量浮层在干净配置里压根不渲染
     * （accounts 为空），所以不能指望把它点开。
     */
    const shadeHit = await win.evaluate(() => {
      const bar = document.querySelector('.title-bar')
      if (!bar) return null
      const zPill = getComputedStyle(document.documentElement).getPropertyValue('--z-pill').trim()
      const shade = document.createElement('div')
      shade.id = 'probe-backdrop'
      shade.style.cssText = `position:fixed;inset:0;z-index:${zPill};background:transparent`
      document.body.appendChild(shade)
      /** 命中测试：这个元素（或它的后代）是不是落在标题栏里 */
      const hitsBar = (el) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height) return null
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        return { hit: top?.className?.toString?.() ?? null, inBar: !!top?.closest('.title-bar') }
      }
      const brand = hitsBar(bar.querySelector('.tb-brand'))
      const ctrl = hitsBar(bar.querySelector('.tb-controls .tb-btn'))
      shade.remove()
      return { brand, ctrl, hasControls: !!bar.querySelector('.tb-controls') }
    })
    check(
      '铺满全窗的浮层背板盖不住标题栏（点得到、拖得动）',
      !!shadeHit?.brand?.inBar,
      JSON.stringify(shadeHit)
    )
    // 非 mac 才有自绘窗口按钮；mac 上这条自动跳过（红绿灯是系统画的）
    check(
      '窗口按钮没被任何全屏背板盖住（仅非 mac 有这几枚按钮）',
      !shadeHit?.hasControls || !!shadeHit?.ctrl?.inBar,
      JSON.stringify(shadeHit?.ctrl)
    )

    // ---- 终端内边距，以及「加了内边距有没有把 fit 算坏」----
    const term = await win.evaluate(() => {
      const box = document.querySelector('.terminal-container')
      const cs = getComputedStyle(box)
      const screen = box.querySelector('.xterm-screen')
      const viewport = box.querySelector('.xterm-viewport')
      const rect = screen?.getBoundingClientRect()
      return {
        padLeft: parseInt(cs.paddingLeft),
        padTop: parseInt(cs.paddingTop),
        boxWidth: box.getBoundingClientRect().width,
        screenWidth: rect?.width ?? 0,
        screenHeight: rect?.height ?? 0,
        overflowX: viewport ? viewport.scrollWidth - viewport.clientWidth : 0
      }
    })
    check('终端内容四周有内边距', term.padLeft > 0 && term.padTop > 0, JSON.stringify(term))
    check(
      '内边距算进了 fit：屏幕宽度 + 两侧内边距不超出容器',
      term.screenWidth + term.padLeft * 2 <= term.boxWidth + 1,
      JSON.stringify(term)
    )
    check('终端没有出现横向滚动（列数没算多）', term.overflowX <= 1, String(term.overflowX))
    /*
     * 终端确实画出来了。
     *
     * 这里只量像素盒子，不去数 .xterm-rows 的子元素：默认渲染器是 WebGL，
     * 单元格画在 canvas 上、DOM 行是空的。pty 那边「列数真的按新尺寸重排了」
     * 由 verify-tile.mjs 用 `stty size` 实测（那条路更贵，但它是唯一作数的证据）。
     */
    check(
      '终端画面尺寸正常（不是 0×0）',
      term.screenWidth > 100 && term.screenHeight > 50,
      JSON.stringify({ w: term.screenWidth, h: term.screenHeight })
    )

    // ---- 面板展开/收起的动效（grid-template-rows 那套）----
    const section = await win.evaluate(() => {
      const heads = [...document.querySelectorAll('.sidebar .section-head')]
      const target = heads.find((h) => h.getAttribute('aria-expanded') === 'false')
      if (!target) return null
      target.click()
      const body = target.parentElement?.querySelector('.section-body')
      const cs = body ? getComputedStyle(body) : null
      return { rows: cs?.gridTemplateRows, transition: cs?.transitionProperty }
    })
    await win.waitForTimeout(400)
    const sectionOpen = await win.evaluate(() => {
      const body = document.querySelector('.sidebar .section-body.open')
      if (!body) return null
      const cs = getComputedStyle(body)
      return { duration: cs.transitionDuration, visibility: cs.visibility }
    })
    check(
      '侧栏分区用 grid 行高做展开（不是 v-show 硬切）',
      section !== null && (section.transition ?? '').includes('grid-template-rows'),
      JSON.stringify(section)
    )
    check(
      '展开时长 = --dur-slow（240ms），展开后内容可见',
      sectionOpen !== null &&
        sectionOpen.duration.startsWith('0.24s') &&
        sectionOpen.visibility === 'visible',
      JSON.stringify(sectionOpen)
    )

    /*
     * ---- 分区头的 + 要自动展开分区 ----
     *
     * 点 + 的意思就是「我要新建一条」，而表单在折叠区里 —— 收起状态下点它
     * 等于什么都没发生（用户只能自己去点箭头）。先把分区收起、把表单关掉，
     * 再点 +，看它有没有连分区一起打开。
     */
    const readSection = (label, formSel) =>
      win.evaluate(
        ({ label, formSel }) => {
          const head = [...document.querySelectorAll('.sidebar .section-head')].find(
            (h) => h.querySelector('.head-label')?.textContent?.trim() === label
          )
          const body = head?.parentElement?.querySelector('.section-body')
          return {
            found: !!head,
            expanded: head?.getAttribute('aria-expanded') ?? null,
            open: !!body?.classList.contains('open'),
            visible: body ? getComputedStyle(body).visibility === 'visible' : null,
            form: !!document.querySelector(formSel)
          }
        },
        { label, formSel }
      )
    const clickSectionButton = (label) =>
      win.evaluate((label) => {
        const head = [...document.querySelectorAll('.sidebar .section-head')].find(
          (h) => h.querySelector('.head-label')?.textContent?.trim() === label
        )
        head?.querySelector('.head-actions button')?.click()
        return !!head
      }, label)

    for (const [label, formSel] of [
      ['端口转发', '.forward-form'],
      ['快捷命令', '.snippet-form']
    ]) {
      // 归一到一个确定的起点：表单关掉、分区收起
      await win.evaluate(
        ({ label, formSel }) => {
          const head = [...document.querySelectorAll('.sidebar .section-head')].find(
            (h) => h.querySelector('.head-label')?.textContent?.trim() === label
          )
          if (!head) return
          if (document.querySelector(formSel)) head.querySelector('.head-actions button')?.click()
          if (head.getAttribute('aria-expanded') === 'true') head.click()
        },
        { label, formSel }
      )
      await win.waitForTimeout(400)
      const before = await readSection(label, formSel)
      check(
        `「${label}」起点是收起的（这样才测得出 + 有没有展开它）`,
        before.expanded === 'false' && !before.form,
        JSON.stringify(before)
      )

      const clicked = await clickSectionButton(label)
      await win.waitForTimeout(500)
      const after = await readSection(label, formSel)
      check(`「${label}」分区头里确实有个 + 按钮`, clicked, JSON.stringify(after))
      check(
        `点「${label}」的 + → 分区自动展开且表单出现`,
        after.expanded === 'true' && after.open && after.visible && after.form,
        JSON.stringify(after)
      )
    }

    // ---- 本地文件面板的行：按下态（这条不依赖 SSH，本地终端也有文件面板）----
    await win.locator('.bar-btn:has-text("文件")').first().click()
    await win.waitForTimeout(1500)
    const rows = await win.locator('.explorer .row').count()
    check('本地文件面板列出了条目', rows > 0, String(rows))
    if (rows > 0) {
      const rowBox = await win.locator('.explorer .row').first().boundingBox()
      check(
        '文件行的过渡里含 transform（按下才有得动）',
        await win.evaluate(() =>
          getComputedStyle(document.querySelector('.explorer .row')).transitionProperty.includes(
            'transform'
          )
        )
      )
      await win.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2)
      await win.mouse.down()
      await win.waitForTimeout(120)
      const pressedRow = await win.evaluate(() => {
        const row = document.querySelector('.explorer .row')
        return { transform: getComputedStyle(row).transform }
      })
      await win.mouse.up()
      await win.waitForTimeout(200)
      check('按住文件行时下沉（按下态）', pressedRow.transform !== 'none', JSON.stringify(pressedRow))
    }

    // ---- 减弱动效 ----
    const cdp = await app.context().newCDPSession(win)
    let emulated = true
    try {
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
      })
    } catch (err) {
      emulated = false
      console.log(`  ! CDP 模拟减弱动效不可用（${err.message}）—— 跳过这一段`)
    }
    if (emulated) {
      check(
        '系统要求减弱动效时，媒体查询命中',
        await win.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
      )
      const reduced = await probe('pop-enter-active', 'transitionDuration')
      check('降级后过渡时长归零', /^0s|0ms/.test(reduced) || parseFloat(reduced) === 0, reduced)
      const spinner = await win.evaluate(() => {
        const el = document.querySelector('.spinner')
        return el ? getComputedStyle(el).animationDuration : null
      })
      // 加载指示是必要反馈：降级里明确留着它
      check(
        'spinner 仍然在转（加载指示属于必要反馈）',
        spinner === null || (parseFloat(spinner) > 0.1 && !spinner.startsWith('0ms')),
        String(spinner)
      )
    }

    // ---- 两套主题各截一张 ----
    await cdp.send('Emulation.setEmulatedMedia', { features: [] }).catch(() => {})
    const themeNow = () => win.evaluate(() => document.documentElement.dataset.theme)
    if ((await themeNow()) !== 'light') {
      await win.locator('.sidebar .theme-toggle').click()
      await win.waitForTimeout(900)
    }
    await win.screenshot({ path: 'shots/hig-light.png' })
    await win.locator('.sidebar .theme-toggle').click()
    await win.waitForTimeout(900)
    await win.screenshot({ path: 'shots/hig-dark.png' })
    console.log('  截图：shots/hig-light.png / shots/hig-dark.png')
    // 收尾把主题切回亮色：这两个脚本都不该把用户的主题改掉
    if ((await themeNow()) !== 'light') {
      await win.locator('.sidebar .theme-toggle').click()
      await win.waitForTimeout(600)
    }
  } catch (err) {
    check('探测过程未抛错', false, err instanceof Error ? err.message : String(err))
  } finally {
    await app.close().catch(() => {})
    try {
      execFileSync('pkill', ['-f', 'dox-hig-'], { stdio: 'ignore' })
    } catch {
      /* 没有正好 */
    }
    rmSync(userData, { recursive: true, force: true })
  }
} else {
  console.log('（阶段 2 需要 dev 在跑：加 --e2e 参数）')
}

console.log(failed ? '\n结论: 存在失败项' : '\n结论: 全部通过')
process.exit(failed ? 1 : 0)
