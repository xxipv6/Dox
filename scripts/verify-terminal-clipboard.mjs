/**
 * 终端剪贴板键位验证（Ctrl/Cmd+C 智能分流、Ctrl/Cmd+V 粘贴）。
 *
 * 覆盖：
 *   1. 有选中时 Ctrl+C 复制进系统剪贴板
 *   2. 复制会清除选中 → 第二次 Ctrl+C 能中断前台进程（智能分流的死穴）
 *   3. Ctrl+V 粘贴的内容真的到达 pty 并在 shell 里执行
 *   4. 多行粘贴不被逐行执行（bracketed paste 生效）
 *
 * 断言手法沿用 verify-broadcast：**让 shell 自己作证**。终端是 WebGL 画在
 * canvas 上的，DOM 里读不到文本，所以一律看「命令有没有真的执行」；
 * 剪贴板则直接读主进程的 Electron clipboard —— 渲染层那两条 IPC 读写的
 * 就是这一份，测它才有意义。
 *
 * 第 4 段是这次改动的核心：原来 pasteClipboard 直接把剪贴板原文灌进 pty，
 * 既不归一化换行也不包裹，多行内容会被 shell 逐行执行。
 *
 * 用法：node scripts/verify-terminal-clipboard.mjs
 * 前置：npm run build（本脚本加载 out/ 产物，不需要 dev server）
 */
import { _electron } from 'playwright'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 后台轮询/异步循环在窗口关掉后会抛未处理拒绝，直接把探测脚本带走
process.on('unhandledRejection', () => {})

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

const STAMP = Date.now()
const MARK = `DOXCLIP-${STAMP}`
const receipt = join(tmpdir(), `dox-clip-${STAMP}.log`)
/** 敲进终端的重定向目标：Git Bash 会把反斜杠当转义符吃掉，MSYS 认正斜杠 */
const receiptArg = receipt.replace(/\\/g, '/')

// 单实例锁（CLI 伴侣）下，上次的僵尸实例会让本实例启动即退；只能杀本仓库的 electron
try {
  if (process.platform === 'win32') {
    // Windows 没有 pkill：按可执行路径匹配本仓库的 electron（taskkill /IM 会误杀别的 Electron 应用）
    execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath -like '*Dox\\node_modules\\electron*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
    ], { stdio: 'ignore' })
  } else {
    execFileSync('pkill', ['-f', 'Dox/node_modules/electron'], { stdio: 'ignore' })
  }
} catch { /* 没有正好 */ }

const app = await _electron.launch({ args: ['.'] })

try {
  const win = await app.firstWindow()
  win.on('pageerror', (e) => console.log(`  [渲染层报错] ${e.message}`))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(1500)
  // 清掉可能恢复出来的旧标签（隔离 userData 里通常本来就是空的）
  await win.evaluate(() => window.api.setLayout({ tabs: [] })).catch(() => {})

  /*
   * Windows 默认本地 shell 是 cmd / PowerShell：两者都不启用 bracketed paste，
   * 第 4 段验证无从谈起。切成 Git Bash（bash 4.4+ 才有）。
   */
  if (process.platform === 'win32') {
    const hasGitBash = await win.evaluate(() =>
      window.api.listLocalShells().then((all) => all.some((s) => s.id === 'gitbash'))
    )
    if (hasGitBash) {
      await win.evaluate(async () => {
        const cur = await window.api.getSettings()
        await window.api.setSettings({ ...cur, localShellId: 'gitbash' })
      })
      console.log('  [win32] 本地 shell 切到 Git Bash')
    } else {
      console.log('  [win32] 未找到 Git Bash —— 第 4 段会失真')
    }
  }
  await win.reload()
  await win.waitForLoadState('domcontentloaded')

  const waitTerm = (n) =>
    win.waitForFunction(
      (want) => document.querySelectorAll('.terminal-container').length >= want,
      n,
      { timeout: 25000 }
    )

  await waitTerm(1)
  await win.waitForTimeout(3000)
  const term = win.locator('.terminal-container:visible').first()

  // ---- 输入通路自检：后面每一段都靠它，先确认敲键真的能到 shell ----
  console.log('阶段 0：输入通路自检')
  await term.click()
  await win.waitForTimeout(400)
  const focus = await win.evaluate(() => {
    const el = document.activeElement
    return el ? `${el.tagName}.${el.className}` : 'none'
  })
  console.log(`  焦点元素：${focus}`)
  await win.keyboard.type(`echo ${MARK}-T1 >> ${receiptArg}`)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2000)
  check('keyboard.type 敲的命令进了 shell',
    readReceipt().filter((l) => l.includes('-T1')).length === 1,
    JSON.stringify(readReceipt()))

  // ---- 工具 ----
  const readClip = () => app.evaluate(({ clipboard }) => clipboard.readText())
  const writeClip = (t) =>
    app.evaluate(({ clipboard }, text) => { clipboard.writeText(text) }, t)

  function readReceipt() {
    try {
      return readFileSync(receipt, 'utf8').split('\n').filter((l) => l.trim())
    } catch {
      return []
    }
  }

  /** 轮询 receipt 找 tag，超时就认作「没执行」 */
  async function waitReceipt(tag, ms = 5000) {
    const deadline = Date.now() + ms
    for (;;) {
      const hit = readReceipt().filter((l) => l.includes(tag))
      if (hit.length || Date.now() > deadline) return hit
      await win.waitForTimeout(200)
    }
  }

  /** 聚焦终端并敲一条命令回车 */
  async function run(cmd, settle = 1500) {
    await term.click()
    await win.waitForTimeout(200)
    await win.keyboard.type(cmd)
    await win.keyboard.press('Enter')
    await win.waitForTimeout(settle)
  }

  /** 全选终端内容：在 xterm 自己的 screen 元素内从左上拖到右下 */
  async function selectAll() {
    /*
     * 必须取 .xterm-screen 而不是 .terminal-container 的位置。容器比 xterm 的
     * 交互区域大一圈（padding：容器 289,87 vs screen 297,95），起点落在容器内、
     * screen 外时 xterm 收不到那个 mousedown，之后整段拖拽都不会产生选区 ——
     * 表现为「Ctrl+C 什么也没发生」，而且屏幕上一点高亮都没有，极难分辨。
     */
    const b = await win
      .locator('.terminal-container:visible .xterm-screen')
      .first()
      .boundingBox()
    if (!b) throw new Error('取不到 xterm-screen 的位置')
    await win.mouse.move(b.x + 2, b.y + 2)
    await win.mouse.down()
    await win.mouse.move(b.x + b.width - 2, b.y + b.height - 2, { steps: 12 })
    await win.mouse.up()
    await win.waitForTimeout(300)
  }

  // ---- 1. 有选中时 Ctrl+C 复制 ----
  console.log('阶段 1：Ctrl+C 有选中则复制')
  await run(`echo ${MARK}`)
  // 哨兵：剪贴板若原封不动，说明复制压根没走（区分「没选中」和「写失败」）
  await writeClip('DOX-SENTINEL')
  await selectAll()
  await win.keyboard.press('Control+c')
  await win.waitForTimeout(800)
  const clip = await readClip()
  check('选中后 Ctrl+C 把内容写进了系统剪贴板', clip.includes(MARK),
    `剪贴板：${JSON.stringify(clip.slice(0, 80))}`)

  // ---- 2. 复制清除选中 → 第二次 Ctrl+C 是 SIGINT ----
  console.log('阶段 2：复制清除选中，第二次 Ctrl+C 能中断前台进程')
  // 不用 sleep：Git Bash 的 PATH 里不一定有（实测这台机器就没有）。
  // read 是 bash 内建，一样阻塞在前台、一样能被 SIGINT 打断。
  await run('read -t 30', 1200)
  await selectAll()
  await win.keyboard.press('Control+c') // 第一次：复制（并应清除选中）
  await win.waitForTimeout(300)
  await win.keyboard.press('Control+c') // 第二次：应落到 SIGINT
  await win.waitForTimeout(300)
  const BACK = `${MARK}-BACK`
  // 不调 run()：它要 click，而 click 会先清掉选区再重新聚焦
  await win.keyboard.type(`echo ${BACK} >> ${receiptArg}`)
  await win.keyboard.press('Enter')
  const backLines = await waitReceipt(BACK, 5000)
  check('第二次 Ctrl+C 中断了前台进程（shell 回来了，选区已被清除）',
    backLines.length === 1, JSON.stringify(backLines))
  // 万一前台进程还在跑，别让它拖住后面的段落
  await win.keyboard.press('Control+c')
  await win.waitForTimeout(500)

  // ---- 3. Ctrl+V 粘贴到达 pty ----
  console.log('阶段 3：Ctrl+V 粘贴到达 pty')
  const PASTE = `${MARK}-PASTE`
  await writeClip(`echo ${PASTE} >> ${receiptArg}`)
  await term.click()
  await win.waitForTimeout(200)
  await win.keyboard.press('Control+v')
  await win.waitForTimeout(500)
  await win.keyboard.press('Enter')
  const pasteLines = await waitReceipt(PASTE, 5000)
  check('粘贴的内容真的在 shell 里执行了', pasteLines.length === 1, JSON.stringify(pasteLines))

  // ---- 4. 多行粘贴不被逐行执行 ----
  console.log('阶段 4：多行粘贴不被逐行执行（bracketed paste）')
  const L1 = `${MARK}-L1`
  const L2 = `${MARK}-L2`
  await writeClip(`echo ${L1} >> ${receiptArg}\necho ${L2} >> ${receiptArg}`)
  await term.click()
  await win.waitForTimeout(200)
  await win.keyboard.press('Control+v')
  await win.waitForTimeout(1500)
  const beforeEnter = readReceipt().filter((l) => l.includes(L1) || l.includes(L2))
  check('粘贴后未按回车 → 两行都还没执行（bracketed paste 挡下了）',
    beforeEnter.length === 0, JSON.stringify(beforeEnter))
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1500)
  const afterEnter = readReceipt().filter((l) => l.includes(L1) || l.includes(L2))
  check('按回车后两行都执行了（内容确实到达 pty）',
    afterEnter.length === 2, JSON.stringify(afterEnter))

  await win.screenshot({ path: 'shots/terminal-clipboard.png' })
  console.log('  截图：shots/terminal-clipboard.png')
} catch (err) {
  check('探测过程未抛错', false, err instanceof Error ? err.message : String(err))
} finally {
  await app.close().catch(() => {})
  rmSync(receipt, { force: true })
  if (process.platform !== 'win32') {
    try {
      execFileSync('pkill', ['-f', 'Dox/node_modules/electron'], { stdio: 'ignore' })
    } catch { /* 没有正好 */ }
  }
}

console.log(failed ? '\n结论: 存在失败项' : '\n结论: 全部通过')
process.exit(failed ? 1 : 0)
