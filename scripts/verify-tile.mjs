/**
 * 平铺（所有标签同屏各占一格）的验证。
 *
 *  阶段 1（纯函数，无需参数）：tileGrid 的列数/行数/末格拉通规则
 *  阶段 2（端到端，需要 dev 在跑）：起隔离实例 → 3 个本地标签 → 平铺 →
 *          断言每格都真的按格子尺寸重排了（pty 侧核对，见下）、焦点跟着点走、
 *          双击标题条能收起
 *
 * 阶段 2 的观测手法沿用 verify-broadcast.mjs：**让 shell 自己作证**。
 * 终端内容在 WebGL 下画在 canvas 上，DOM 里读不到，所以不读屏幕 ——
 * 开广播后敲一次 `echo $(stty size) >> 文件`，每个 shell 会把自己**当前 pty
 * 的尺寸**写进文件。这一步同时守住两件事：
 *   · 平铺后每个格子都真的被 fit 过（不是停在出生的 80x24 —— 那正是
 *     `safeFit` 尺寸守卫被踩到时最典型的静默故障）；
 *   · 三个会话都还活着、都收到了广播。
 *
 * 用法：node scripts/verify-tile.mjs          # 只跑阶段 1
 *      node scripts/verify-tile.mjs --e2e      # 阶段 1 + 阶段 2
 * 前置（阶段 2）：npm run dev（脚本用 --user-data-dir 起**独立**实例，不动你在跑的那个）
 */
import { MIN_TILE_HEIGHT, MIN_TILE_WIDTH, tileGrid } from '../src/renderer/src/utils/tileGrid.ts'

process.on('unhandledRejection', () => {})

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

console.log('阶段 1：网格计算')

const WIDE = 1400 // 典型全宽
const shape = (n, w = WIDE) => tileGrid(n, w)
const desc = ({ cols, rows, spanLast }) => `${cols}x${rows}${spanLast ? '+span' : ''}`

check('0 个标签不铺（行数为 0）', shape(0).rows === 0)
check('1 个标签：1 列 1 行', desc(shape(1)) === '1x1', desc(shape(1)))
check('2 个标签：并排两列', desc(shape(2)) === '2x1', desc(shape(2)))
check(
  '3 个标签：2x2 且第三个拉通整行（用户的正经场景）',
  desc(shape(3)) === '2x2+span',
  desc(shape(3))
)
check('4 个标签：2x2（不是挤成一排 4 列）', desc(shape(4)) === '2x2', desc(shape(4)))
check('5 个标签：3 列 2 行，末行两个不拉通', desc(shape(5)) === '3x2', desc(shape(5)))
check('7 个标签：3x3 且第七个拉通', desc(shape(7)) === '3x3+span', desc(shape(7)))
check('9 个标签：3x3', desc(shape(9)) === '3x3', desc(shape(9)))
check('16 个标签：4x4', desc(shape(16)) === '4x4', desc(shape(16)))

console.log('阶段 1：窄屏降列 / 兜底')

check('1400px：4 列放得下也不排 4 列（方阵优先）', shape(2).cols === 2)
check('700px：最多 2 列', shape(9, 700).cols === 2, desc(shape(9, 700)))
check('700px：9 个标签 2 列 5 行，末格拉通', desc(shape(9, 700)) === '2x5+span', desc(shape(9, 700)))
check('400px：放不下第二列，退成 1 列', shape(3, 400).cols === 1, desc(shape(3, 400)))
check('400px：5 个标签一列排 5 行', desc(shape(5, 400)) === '1x5', desc(shape(5, 400)))
check('宽度还没量到（0）时退成 1 列', shape(4, 0).cols === 1)
check('宽度是 NaN 时也不算出 NaN 列', Number.isFinite(shape(4, NaN).cols) && shape(4, NaN).cols === 1)
check('单列时不存在「拉通」', shape(3, 400).spanLast === false)
check('自定义最小宽度生效', shape(4, 1000, 500).cols === 2, desc(shape(4, 1000, 500)))

console.log('阶段 1：常量')

// 这两个下限必须**明显高于** safeFit 的 120×60 门槛（见 tileGrid.ts 的注释），
// 否则格子会被压到 fit 被静默拒绝的尺寸上
check('最小格子宽度远高于 safeFit 的 120 门槛', MIN_TILE_WIDTH >= 240, String(MIN_TILE_WIDTH))
check('最小格子高度远高于 safeFit 的 60 门槛', MIN_TILE_HEIGHT >= 120, String(MIN_TILE_HEIGHT))

if (process.argv.includes('--e2e')) {
  console.log('阶段 2：端到端（隔离实例）')
  const { _electron } = await import('playwright')
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const stamp = Date.now()
  const TAG = `DOXTILE-${stamp}-`
  const receipt = join(tmpdir(), `dox-tile-${stamp}.log`)
  /** 隔离的 userData：自己的单实例锁、自己的 dox-layout.json，不碰用户在跑的那个 */
  const userData = mkdtempSync(join(tmpdir(), 'dox-tile-'))
  const readReceipt = () => {
    try {
      return readFileSync(receipt, 'utf8').split('\n').filter((l) => l.trim())
    } catch {
      return []
    }
  }

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
    // 记下原始设置：后面切暗色核对配色时要基于它改，而不是造一份缺字段的
    const origSettings = await win.evaluate(() => window.api.getSettings())

    const waitTerm = (n) =>
      win.waitForFunction(
        (want) => document.querySelectorAll('.terminal-container').length >= want,
        n,
        { timeout: 25000 }
      )
    /** 可见的格子（clientWidth > 0 才算真的占着地方） */
    const visibleCells = () =>
      win.evaluate(() =>
        [...document.querySelectorAll('.tab-content')].filter((el) => el.clientWidth > 0).length
      )
    const cellRects = () =>
      win.evaluate(() =>
        [...document.querySelectorAll('.tile')]
          .filter((el) => el.clientWidth > 0)
          .map((el) => {
            const r = el.getBoundingClientRect()
            return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x) }
          })
      )
    const stackCols = () =>
      win.evaluate(() => {
        const stack = document.querySelector('.terminal-stack')
        if (!stack) return null
        const tpl = getComputedStyle(stack).gridTemplateColumns
        return { tpl, count: tpl.split(' ').filter(Boolean).length, width: stack.clientWidth }
      })

    // ---- 三个本地标签 ----
    await waitTerm(1)
    await win.waitForTimeout(2200)
    for (const _ of [1, 2]) {
      await win.locator('.tab-new').click()
      await win.waitForTimeout(1800)
    }
    await waitTerm(3)
    await win.waitForTimeout(2500)
    check('三个标签都建起来了', (await win.locator('.tab').count()) === 3)
    check('平铺前只有一格可见', (await visibleCells()) === 1)

    /*
     * 格子壳在普通模式下是 `display: contents`（不生成盒子）—— 这条断言就是
     * 守住那句注释的：不是平铺时，可见的那一格必须仍然铺满整个栈，
     * 而不是被新加的壳挤成半宽。
     */
    const fill = await win.evaluate(() => {
      const stack = document.querySelector('.terminal-stack')
      const cell = [...document.querySelectorAll('.tab-content')].find((el) => el.clientWidth > 0)
      return cell && stack
        ? { cell: Math.round(cell.getBoundingClientRect().width), stack: stack.clientWidth }
        : null
    })
    console.log(`  非平铺时可见格宽度 ${fill?.cell}px / 栈宽 ${fill?.stack}px`)
    check(
      '非平铺时格子壳不占位（可见格仍铺满整个栈宽）',
      !!fill && Math.abs(fill.cell - fill.stack) <= 2,
      JSON.stringify(fill)
    )

    // ---- 铺开 ----
    const tileBtn = win.locator('.bar-btn[title*="平铺"]')
    await tileBtn.click()
    await win.waitForTimeout(1200)
    check('平铺后三格同时可见', (await visibleCells()) === 3)
    check('每格都有标题条', (await win.locator('.tile-head').count()) === 3)
    const titles = await win.locator('.tile-head .tile-title').allTextContents()
    check('格子标题条有文字（不是空标题）', titles.every((t) => t.trim().length > 0), JSON.stringify(titles))

    const grid = await stackCols()
    const expected = tileGrid(3, grid.width)
    console.log(`  栈宽 ${grid.width}px → grid-template-columns "${grid.tpl}"`)
    check(
      `列数与 tileGrid(3, ${grid.width}) 一致（期望 ${expected.cols}）`,
      grid.count === expected.cols,
      JSON.stringify(grid)
    )

    const rects = await cellRects()
    console.log(`  格子尺寸：${JSON.stringify(rects)}`)
    check('三格都是有效尺寸', rects.length === 3 && rects.every((r) => r.w > 120 && r.h > 60))
    check(
      '前两格并排（同高同宽）',
      Math.abs(rects[0].w - rects[1].w) <= 2 && Math.abs(rects[0].h - rects[1].h) <= 2,
      JSON.stringify(rects)
    )
    check(
      '第三格拉通整行（宽度 ≈ 前两格之和 + 间距）',
      rects[2].w > rects[0].w * 1.9,
      JSON.stringify(rects)
    )
    check('第三格在下一行（纵坐标大于第一格）', rects[2].x === rects[0].x && rects[2].h > 60)

    // ---- 每格的 pty 是否真的按格子尺寸重排了 ----
    // 借广播把同一条命令发给三个 shell，各自把自己 pty 的尺寸写进文件
    const bcBtn = win.locator('.bar-btn[title^="广播"]')
    await bcBtn.click()
    await win.waitForTimeout(500)
    check('广播默认全勾（3 个目标）', (await bcBtn.textContent())?.includes('3'), '')
    await win.locator('.tab').first().click()
    await win.waitForTimeout(400)
    await win.locator('.terminal-container:visible').first().click()
    await win.waitForTimeout(400)
    await win.keyboard.type(`echo ${TAG}$$ $(stty size) >> ${receipt}`)
    await win.keyboard.press('Enter')
    await win.waitForTimeout(2600)

    const lines = readReceipt()
    /*
     * 每行是 "<PID> <rows> <cols>"（$$ 是各自的 shell PID，用来确认「三个不同的
     * shell 都执行了」，而不是同一个 shell 被写了三遍）。
     */
    const parsed = lines.map((l) => {
      const [pid, rows, cols] = l.replace(TAG, '').trim().split(/\s+/)
      return { pid, rows: Number(rows), cols: Number(cols) }
    })
    console.log(`  三个 shell 自报 pty 尺寸：${JSON.stringify(parsed)}`)
    check('三个会话都执行了（三行）', lines.length === 3, JSON.stringify(lines))
    check('是三个不同的 shell（PID 互不相同）', new Set(parsed.map((p) => p.pid)).size === 3, JSON.stringify(parsed))
    check(
      '没有一个是出生的 80x24（说明都真的按格子 fit 过）',
      parsed.every((p) => !(p.rows === 24 && p.cols === 80)),
      JSON.stringify(parsed)
    )
    /*
     * 三个 shell 各写一行，**行序是完成顺序、不是格子顺序**，所以这里按尺寸
     * 分组比，不能按下标取：两个并排的半宽格子应当同宽，拉通整行的那个明显更宽。
     * 这正是「每个格子的 pty 按自己那个盒子重排」的直接证据。
     */
    const sorted = parsed.map((p) => p.cols).sort((x, y) => x - y)
    console.log(`  列数排序：${JSON.stringify(sorted)}`)
    check('两个半宽格子列数相同且可用（>20 列）', sorted[0] === sorted[1] && sorted[0] > 20, JSON.stringify(sorted))
    check(
      '拉通整行的那格明显更宽（>1.5 倍）',
      sorted[2] > sorted[0] * 1.5,
      `${sorted[2]} vs ${sorted[0]}`
    )

    // ---- 点某一格的**终端本体** → 当前标签要跟着跳过去 ----
    const focusState = () =>
      win.evaluate(() => ({
        tile: [...document.querySelectorAll('.tile')].findIndex((el) =>
          el.classList.contains('focused')
        ),
        tab: [...document.querySelectorAll('.tabs-scroll .tab')].findIndex((el) =>
          el.classList.contains('active')
        ),
        activeInTile: [...document.querySelectorAll('.tile')].findIndex((el) =>
          el.contains(document.activeElement)
        )
      }))

    await win.locator('.tile').nth(1).locator('.terminal-container').click()
    await win.waitForTimeout(700)
    const fs = await focusState()
    console.log(`  点第二格终端后：${JSON.stringify(fs)}`)
    check('当前标签跟着跳到第二格（标签栏高亮也过去）', fs.tab === 1, JSON.stringify(fs))
    check('焦点环落在第二格', fs.tile === 1, JSON.stringify(fs))
    check('键盘焦点确实在第二格的终端里', fs.activeInTile === 1, JSON.stringify(fs))
    check('点格子不会退出平铺（三格仍在）', (await visibleCells()) === 3)

    // ---- 点标题条切焦点：三格仍在，焦点环跟着走 ----
    await win.locator('.tile-head').nth(1).click()
    await win.waitForTimeout(500)
    check('点第二格标题条后三格仍全可见（平铺没退出）', (await visibleCells()) === 3)
    check('焦点环落在第二格', (await win.locator('.tile.focused').count()) === 1)
    const focusedIndex = await win.evaluate(() =>
      [...document.querySelectorAll('.tile')].findIndex((el) => el.classList.contains('focused'))
    )
    check('焦点环确实在第二格（索引 1）', focusedIndex === 1, String(focusedIndex))

    // ---- 点标签栏里的标签 → 键盘焦点必须跟着过去（否则字会进上一个格子）----
    await win.locator('.tab').nth(2).click()
    await win.waitForTimeout(600)
    check(
      '点标签栏第三个标签后焦点环挪到第三格',
      (await win.evaluate(() =>
        [...document.querySelectorAll('.tile')].findIndex((el) => el.classList.contains('focused'))
      )) === 2
    )
    await win.keyboard.type(`echo ${TAG}FOCUS >> ${receipt}`)
    await win.keyboard.press('Enter')
    await win.waitForTimeout(2200)
    // 广播还开着，所以三个 shell 都会执行；这里看的是**第三个**会话有没有拿到
    check(
      '敲的字进了第三个格子（三行里含第三个 shell 的 PID）',
      readReceipt().filter((l) => l.includes(`${TAG}FOCUS`)).length === 3,
      JSON.stringify(readReceipt().filter((l) => l.includes('FOCUS')))
    )

    // ---- 双击标题条：只看这一个 ----
    await win.locator('.tile-head').first().dblclick()
    await win.waitForTimeout(1000)
    check('双击标题条后退出平铺（只剩一格可见）', (await visibleCells()) === 1)
    check('退出后标题条消失', (await win.locator('.tile-head').count()) === 0)

    // ---- 再铺开一次：状态不粘 ----
    await win.locator('.bar-btn[title*="平铺"]').click()
    await win.waitForTimeout(900)
    check('能重新铺开（幂等）', (await visibleCells()) === 3)

    await win.screenshot({ path: 'shots/tile-e2e.png' })
    console.log('  截图：shots/tile-e2e.png')

    /*
     * 暗色再走一遍。
     *
     * 新增的边框 / 标题条底色 / 焦点环全是取令牌的颜色（`MAINTENANCE.md` §3.3），
     * 亮色下看着对不代表暗色下也对 —— 顺手把「重启恢复出来的布局能不能直接平铺」
     * 也验了：重载之后三个本地标签会从布局快照里回来，而平铺是会话级视图状态、
     * 不会被恢复（这也是有意的），所以这里要重新点一次。
     */
    await win.evaluate((s) => window.api.setSettings({ ...s, uiTheme: 'dark' }), origSettings)
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await waitTerm(3)
    /*
     * 等布局**稳下来**再断言，别用固定 sleep：恢复出来的三个标签是异步连的，
     * 页面重载 + 主题切换又都在抢帧，固定等 2.5 秒会偶发跑在中间态上
     * （实测这一段的断言曾经偶发失败，但同一份代码重跑就过）。
     */
    const waitVisibleCells = (want) =>
      win.waitForFunction(
        (n) =>
          [...document.querySelectorAll('.tab-content')].filter((el) => el.clientWidth > 0)
            .length === n,
        want,
        { timeout: 20000 }
      )
    await waitVisibleCells(1)
    check('重载后三个标签从布局快照恢复回来', (await win.locator('.tab').count()) === 3)
    check('平铺状态没有被持久化（恢复后是单标签视图）', (await visibleCells()) === 1)
    await win.locator('.bar-btn[title*="平铺"]').click()
    await waitVisibleCells(3).catch(() => {})
    check('恢复出来的布局也能直接平铺', (await visibleCells()) === 3)
    await win.screenshot({ path: 'shots/tile-dark.png' })
    console.log('  截图：shots/tile-dark.png（暗色）')
  } catch (err) {
    check('探测过程未抛错', false, err instanceof Error ? err.message : String(err))
  } finally {
    await app.close().catch(() => {})
    rmSync(receipt, { force: true })
    try {
      // 隔离实例偶发不退，按 userData 目录名精确清掉
      execFileSync('pkill', ['-f', 'dox-tile-'], { stdio: 'ignore' })
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
