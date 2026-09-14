/**
 * 标签栏撑多标签的验证：收窄 + 溢出清单 + 右键批量关闭。
 *
 *  阶段 1（纯函数，无需参数）：tabbarCompact 的收窄判定
 *  阶段 2（端到端，需要 dev 在跑）：起隔离实例 → 连开 12 个标签 →
 *          断言收窄生效、溢出清单列出全部标签且数字对得上、点行能跳、
 *          右键菜单四种批量关闭都真的把标签关掉（且关的是该关的那些）
 *
 * 用法：node scripts/verify-tabbar.mjs          # 只跑阶段 1
 *      node scripts/verify-tabbar.mjs --e2e      # 阶段 1 + 阶段 2
 * 前置（阶段 2）：npm run dev（脚本用 --user-data-dir 起**独立**实例，不动你在跑的那个）
 */
import { TAB_MIN_WIDTH, tabbarCompact } from '../src/renderer/src/utils/tabbar.ts'

process.on('unhandledRejection', () => {})

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

console.log('阶段 1：收窄判定')

check('空标签栏不收窄', tabbarCompact(0, 1151) === false)
check('7 个标签（7×140 = 980 < 1151）不收窄', tabbarCompact(7, 1151) === false)
check('8 个标签（1120 < 1151）仍然不收窄', tabbarCompact(8, 1151) === false)
check('9 个标签（1260 > 1151）开始收窄', tabbarCompact(9, 1151) === true)
check('20 个标签必然收窄', tabbarCompact(20, 1151) === true)
check('窄窗口下 3 个就收窄（400px）', tabbarCompact(3, 400) === true)
check('窄窗口下 2 个不收窄（280 < 400）', tabbarCompact(2, 400) === false)
check('宽度没量到（0）时不收窄', tabbarCompact(20, 0) === false)
check('宽度是 NaN 时不收窄（也不算出 NaN 判定）', tabbarCompact(20, NaN) === false)
check('最小宽度常量就是 140', TAB_MIN_WIDTH === 140, String(TAB_MIN_WIDTH))

if (process.argv.includes('--e2e')) {
  console.log('阶段 2：端到端（隔离实例）')
  const { _electron } = await import('playwright')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const userData = mkdtempSync(join(tmpdir(), 'dox-tabbar-'))
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
    await win.waitForTimeout(1500)

    const tabCount = () => win.locator('.tab').count()
    const compact = () =>
      win.evaluate(() => document.querySelector('.tabs-scroll')?.classList.contains('compact') ?? false)

    /**
     * 在一帧之内同时读出「按钮上的数字」和「实测的视口外个数」。
     *
     * 必须同一帧读：界面那边的量测是 rAF 延迟的（它要等自己那个 ▾ 按钮排完版），
     * 而 evaluate 是同步强制排版 —— 分开读会读到两个不同时刻的布局，差一两个数
     * （实测：标签刚建完那会儿，同一个 DOM 能同时得出 6 和 7）。
     */
    const tabsStateInFrame = () =>
      win.evaluate(
        () =>
          new Promise((res) => {
            requestAnimationFrame(() => {
              const box = document.querySelector('.tabs-scroll')
              const view = box.getBoundingClientRect()
              let inside = 0
              let outside = 0
              for (const el of box.querySelectorAll('.tab')) {
                const r = el.getBoundingClientRect()
                if (r.right > view.right + 1 || r.left < view.left - 1) outside++
                else inside++
              }
              res({
                inside,
                outside,
                badge: document.querySelector('.tab-overflow')?.textContent?.trim() ?? null
              })
            })
          })
      )

    /** 量测是逐帧追的：等它收敛（最多 3 秒），再断言 */
    const settleTabs = async () => {
      let last = null
      for (let i = 0; i < 15; i++) {
        last = await tabsStateInFrame()
        if (last.badge !== null && Number(last.badge) === last.outside) return last
        await win.waitForTimeout(200)
      }
      return last
    }
    const tabWidths = () =>
      win.evaluate(() =>
        [...document.querySelectorAll('.tabs-scroll .tab')].map((el) =>
          Math.round(el.getBoundingClientRect().width)
        )
      )

    // ---- 连开 12 个标签（点得快一点：标签是同步出现的，终端在后台慢慢连）----
    for (let i = 0; i < 11; i++) {
      await win.locator('.tab-new').click()
      await win.waitForTimeout(120)
    }
    await win.waitForFunction(() => document.querySelectorAll('.tab').length === 12, undefined, {
      timeout: 20000
    })
    await win.waitForTimeout(800)
    check('12 个标签都建起来了', (await tabCount()) === 12)

    check('标签多到排不下时自动收窄', await compact())
    const widths = await tabWidths()
    console.log(`  标签宽度：${JSON.stringify(widths)}`)
    // 收窄后普通标签 ≤128；只有当前那个放宽到 200。大于 128 的最多一个。
    check(
      '收窄后普通标签都 ≤128px（当前那个 ≤200）',
      Math.max(...widths) <= 201 && widths.filter((w) => w > 129).length <= 1,
      JSON.stringify(widths)
    )

    const vis = await settleTabs()
    console.log(`  可见 ${vis.inside} 个 / 视口外 ${vis.outside} 个 / 按钮写着 ${vis.badge}`)
    check('确实有标签被挤到视口外（否则这个场景测不到东西）', vis.outside > 0, JSON.stringify(vis))
    check('可见 + 视口外 = 全部 12 个', vis.inside + vis.outside === 12, JSON.stringify(vis))

    const overflowBtn = win.locator('.tab-overflow')
    check('溢出清单按钮出现了', (await overflowBtn.count()) === 1)
    await win.screenshot({ path: 'shots/tabbar-many.png' })
    console.log('  截图：shots/tabbar-many.png（12 个标签的收窄状态）')
    check(
      `按钮上的数字等于视口外的个数（${vis.badge}）`,
      Number(vis.badge) === vis.outside,
      JSON.stringify(vis)
    )

    // ---- 溢出清单：列出全部标签、点行能跳过去 ----
    await overflowBtn.click()
    await win.waitForTimeout(400)
    check('清单打开了', (await win.locator('.tab-list').count()) === 1)
    check('清单列出全部 12 个标签', (await win.locator('.tab-list-row').count()) === 12)
    const currentRow = await win.evaluate(() =>
      [...document.querySelectorAll('.tab-list-row')].findIndex((el) =>
        el.classList.contains('current')
      )
    )
    check('清单里标出了当前标签（只有一行）', currentRow >= 0, String(currentRow))

    await win.locator('.tab-list-row').nth(11).click()
    await win.waitForTimeout(600)
    check('点第 12 行后清单关掉', (await win.locator('.tab-list').count()) === 0)
    const activeIdx = await win.evaluate(() =>
      [...document.querySelectorAll('.tabs-scroll .tab')].findIndex((el) =>
        el.classList.contains('active')
      )
    )
    check('第 12 个标签成了当前标签', activeIdx === 11, String(activeIdx))

    // ---- 溢出清单里的 ✕：关一个，清单留着（连着关几个是常态）----
    await overflowBtn.click()
    await win.waitForTimeout(400)
    const before = await tabCount()
    await win.locator('.tab-list-row').first().locator('.row-close').click()
    await win.waitForTimeout(500)
    check('清单里的 ✕ 关掉了一个标签', (await tabCount()) === before - 1, String(await tabCount()))
    check('关完清单还开着（可以接着关）', (await win.locator('.tab-list').count()) === 1)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)
    check('Esc 关掉清单', (await win.locator('.tab-list').count()) === 0)

    // ---- 右键菜单：关闭其他 ----
    const rightClickTab = async (nth) => {
      await win.locator('.tabs-scroll .tab').nth(nth).click({ button: 'right' })
      await win.waitForTimeout(400)
    }
    await rightClickTab(0)
    check('右键标签弹出菜单', (await win.locator('.context-menu').count()) === 1)
    const items = await win.locator('.menu-item').allTextContents()
    console.log(`  菜单项：${JSON.stringify(items)}`)
    check('菜单有四项：当前 / 其他 / 右侧 / 全部', items.length === 4, JSON.stringify(items))
    const left = await tabCount()
    await win.locator('.menu-item', { hasText: '关闭其他' }).click()
    await win.waitForTimeout(900)
    check('「关闭其他」后只剩 1 个标签', (await tabCount()) === 1, `${left} → ${await tabCount()}`)
    check(
      '留下的正是右键点的那一个（第一个）',
      (await win.evaluate(() =>
        [...document.querySelectorAll('.tabs-scroll .tab')].findIndex((el) =>
          el.classList.contains('active')
        )
      )) === 0
    )
    // 只剩一个标签时不该再收窄、也不该有溢出清单
    check('只剩一个标签时取消收窄', (await compact()) === false)
    check('只剩一个标签时溢出清单按钮消失', (await win.locator('.tab-overflow').count()) === 0)

    // ---- 右键菜单：关闭右侧 ----
    for (let i = 0; i < 4; i++) {
      await win.locator('.tab-new').click()
      await win.waitForTimeout(150)
    }
    await win.waitForFunction(() => document.querySelectorAll('.tab').length === 5, undefined, {
      timeout: 20000
    })
    await win.waitForTimeout(600)
    await rightClickTab(1)
    await win.locator('.menu-item', { hasText: '关闭右侧' }).click()
    await win.waitForTimeout(900)
    check('「关闭右侧」后只剩左边 2 个（含被点的那个）', (await tabCount()) === 2, String(await tabCount()))

    // ---- 右键菜单：关闭全部 ----
    await rightClickTab(0)
    await win.locator('.menu-item', { hasText: '关闭全部' }).click()
    await win.waitForTimeout(1200)
    // 全关掉之后 closeTab 会自动补一个本地终端（应用不留空白界面），所以最终是 1 个
    check('「关闭全部」后回到只有一个默认本地终端', (await tabCount()) === 1, String(await tabCount()))

    // ---- 收窄是纯粹的「标签多」触发的，标签少时不该有 ----
    check('标签少时不再收窄', (await compact()) === false)

    /*
     * ---- Ctrl+W 关标签，而不是关整扇窗 ----
     *
     * 用户报的就是这个：以前 Ctrl+W 直接把窗口关了（Windows/Linux 上默认应用菜单
     * 的 CmdOrCtrl+W 干的），而他只想关掉当前这一个标签。
     *
     * 焦点在终端里这一条还顺便守住另一件事：xterm 自己的按键处理和 window 上的
     * 全局处理**不能各关一次** —— 所以断言是「正好 -1」，不是「-2」。
     * （两者靠 `.xterm` 这个选择器分工，见 useCloseTabShortcut.ts 的注释。）
     */
    for (const _ of [1, 2]) {
      await win.locator('.tab-new').click()
      await win.waitForTimeout(1100)
    }
    await win.waitForFunction(() => document.querySelectorAll('.tab').length === 3, undefined, {
      timeout: 20000
    })
    const beforeHotkey = await tabCount()
    // 必须点**可见**的那一格：非当前标签的 .tab-content 是 v-show 隐藏的，
    // Playwright 的 click 会一直等可见（点了也没意义，焦点进不去）
    await win.locator('.tab-content:visible .terminal-container').first().click()
    await win.waitForTimeout(300)
    await win.keyboard.press('Control+w')
    await win.waitForTimeout(1000)
    check(
      '终端里 Ctrl+W 关掉当前标签（正好一个）',
      (await tabCount()) === beforeHotkey - 1,
      `${beforeHotkey} → ${await tabCount()}`
    )
    check('按完 Ctrl+W 窗口还开着（不再关整扇窗）', !win.isClosed())

    // 焦点不在终端里（侧栏分区头）时走全局那条，效果应当一样
    const beforeGlobal = await tabCount()
    await win.locator('.sidebar .section-head').first().click()
    await win.waitForTimeout(300)
    await win.keyboard.press('Control+w')
    await win.waitForTimeout(1000)
    check(
      '焦点在侧栏时 Ctrl+W 也关标签',
      (await tabCount()) === beforeGlobal - 1,
      `${beforeGlobal} → ${await tabCount()}`
    )

    /*
     * 例外的例外也要守：输入框里的 Ctrl+W 是「删掉前一个词」（原生编辑命令），
     * 不许被这条快捷键抢走 —— 否则在文件名、命令片段里按一下就少一个词，
     * 用户会以为是自己手滑。
     */
    await win.locator('.sidebar .section-head', { hasText: '快捷命令' }).click()
    await win.waitForTimeout(400)
    await win
      .locator('.sidebar .section-head', { hasText: '快捷命令' })
      .locator('.head-actions button')
      .click()
    await win.waitForTimeout(400)
    const box = win.locator('.snippet-form textarea')
    const hasBox = (await box.count()) > 0
    const beforeTyping = await tabCount()
    if (hasBox) {
      await box.click()
      await win.keyboard.type('echo foo bar')
      await win.keyboard.press('Control+w')
      await win.waitForTimeout(600)
    }
    check(
      '输入框里按 Ctrl+W 不关标签（那是「删前一个词」）',
      hasBox && (await tabCount()) === beforeTyping,
      `${beforeTyping} → ${await tabCount()}`
    )

    /*
     * ---- macOS 那条路：⌘W 归菜单管 ----
     *
     * mac 上 ⌘W 是**应用菜单的加速键**，优先于网页 —— 渲染层收不到那个 keydown，
     * 所以拦不住，只能把菜单项本身换成「关闭标签」。这里守三件事：
     * ⌘W 没留在「关闭窗口」上（用户报的就是这个）、编辑菜单还在（⌘C/⌘V 靠它）、
     * 点那一项真的能关掉一个标签（主进程 → IPC → 渲染层整条链）。
     *
     * 注意：真正的 ⌘W 按键**没法在这里合成**（Playwright 走 CDP 发给渲染层，
     * 不经过原生菜单），所以这里点的是菜单项本身，不是按键。
     */
    if (process.platform === 'darwin') {
      const menu = await app.evaluate(({ Menu }) => {
        const walk = (items, out = []) => {
          for (const it of items) {
            out.push({ label: it.label, role: it.role ?? null, acc: it.accelerator ?? null })
            if (it.submenu) walk(it.submenu.items, out)
          }
          return out
        }
        const m = Menu.getApplicationMenu()
        return m ? walk(m.items) : null
      })
      const flat = menu ?? []
      const cmdW = flat.filter((i) => i.acc === 'Command+W')
      check(
        'mac 上 ⌘W 只绑在「关闭标签」上（不再关整扇窗）',
        cmdW.length === 1 && cmdW[0].label === '关闭标签',
        JSON.stringify(cmdW)
      )
      check(
        '关窗口挪到了 ⌘⇧W',
        flat.some((i) => i.acc === 'Command+Shift+W'),
        JSON.stringify(flat.filter((i) => i.role === 'close'))
      )
      check(
        '编辑菜单还在（⌘C/⌘V/⌘A 全靠它，不能把菜单整个换掉）',
        flat.some((i) => i.role === 'copy') && flat.some((i) => i.role === 'paste'),
        JSON.stringify(flat.filter((i) => i.acc === 'CommandOrControl+C'))
      )

      // 先凑到 3 个：只剩 1 个时关掉会自动补一个本地终端，数不出「少了几个」
      for (const _ of [1, 2]) {
        await win.locator('.tab-new').click()
        await win.waitForTimeout(1100)
      }
      await win.waitForFunction(() => document.querySelectorAll('.tab').length === 3, undefined, {
        timeout: 20000
      })
      const beforeMenu = await tabCount()
      const clicked = await app.evaluate(({ Menu, BrowserWindow }) => {
        const find = (items) => {
          for (const it of items) {
            if (it.accelerator === 'Command+W') return it
            if (it.submenu) {
              const r = find(it.submenu.items)
              if (r) return r
            }
          }
          return null
        }
        const item = find(Menu.getApplicationMenu().items)
        if (!item) return 'no-item'
        item.click(item, BrowserWindow.getFocusedWindow(), {})
        return 'clicked'
      })
      await win.waitForTimeout(1000)
      check(
        '点菜单里的「关闭标签」关掉当前标签（主进程 → IPC → 渲染层）',
        clicked === 'clicked' && (await tabCount()) === beforeMenu - 1,
        `${clicked} ${beforeMenu} → ${await tabCount()}`
      )
      check('关完标签窗口还在', !win.isClosed())
    }

    await win.screenshot({ path: 'shots/tabbar-e2e.png' })
    console.log('  截图：shots/tabbar-e2e.png')
  } catch (err) {
    check('探测过程未抛错', false, err instanceof Error ? err.message : String(err))
  } finally {
    await app.close().catch(() => {})
    try {
      execFileSync('pkill', ['-f', 'dox-tabbar-'], { stdio: 'ignore' })
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
