/**
 * 容器终端验证（Docker / Podman）。
 *
 * 走完整条链路：侧栏只读探测 → 右键「进入」→ 在**已有那条 SSH 连接**上开一条
 * `docker exec` 通道 → 新标签页里是容器内的 shell。
 *
 * 关键断言都打在「不可能被 mock 伪造」的地方：
 *   - 容器里跑 `hostname`，必须与宿主机不同
 *   - 容器里必须有 /.dockerenv（或 podman 的 /run/.containerenv）—— 在宿主上不会有
 *   - 容器里 `stty size` 必须随窗口尺寸变化（证明 setWindow → SIGWINCH → 容器 resize
 *     这条链是通的，也就是容器里的 vim/top 能不能用）
 *   - 断线后 `container-` 前缀的会话**从不出现 reconnecting**
 *
 * 无 docker/podman 时优雅降级：降级路径照样验，其余打 skip 说明后正常退出。
 *
 * 用法：node scripts/verify-container.mjs
 * 前置：npm run build，且已保存一个可连接的设备
 *
 * 远端只做：`docker ps` / `docker exec` 进**已存在**的容器。
 * 不安装任何东西，不建任何文件，不启停任何容器。
 */
import { _electron as electron } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

mkdirSync('shots', { recursive: true })

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}
const skip = (label) => console.log(`  · ${label}`)

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())

/*
 * 认「当前是哪个终端」只允许有一种定义。
 *
 * 写（termInput）用 Playwright 的 :visible，读（termText）却用 display !== 'none' ——
 * 两者判定不同，于是读到的可能是**别的标签**的缓冲区：本机/宿主机那几个终端的
 * 登录 banner（Orange Pi 那几行带 IP 的欢迎语）会混进容器命令的读取结果里，
 * 于是 `stty size` 的正则从 `172.18.0.1` 里抠出「1x172」这种假值，
 * 报告成「resize 生效了」，而 /.dockerenv 那类需要独占一行的断言则无端失败。
 */
const activeContent = () => win.locator('.tab-content:visible').first()
const termInput = () => activeContent().locator('.xterm-helper-textarea')

/** 读**当前那个**终端的文本（依赖 DOM 渲染器，见下面开 ligatures 的那段） */
const termText = () =>
  activeContent().evaluate((el) =>
    [...el.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent ?? '').join('\n')
  )

/**
 * 断言某标记真的作为**一整行输出**出现过。
 * 不能用 includes：终端会回显敲进去的命令，命令里往往就含这个标记。
 */
const hasOutputLine = (text, marker) =>
  new RegExp(`(^|\\n)\\s*${marker}\\s*(\\n|$)`, 'm').test(text)

async function termRun(cmd, settleMs = 700) {
  await termInput().click()
  await win.keyboard.type(cmd)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(settleMs)
  const head = cmd.slice(0, 24)
  for (let i = 0; i < 12; i++) {
    const now = await termText()
    if (now.includes(head)) return now
    await win.waitForTimeout(250)
  }
  return termText()
}

/**
 * 标签栏快照。
 *
 * 不靠 `@` 之类的字面量去认宿主机标签 —— 已保存设备的标签标题是**设备名**，
 * 不含 `@`。容器标签有固定前缀，宿主机标签就是「既不是本地终端、也不是容器」的那个。
 */
const CONTAINER_TAB_PREFIX = '容器 · '
const tabStates = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.tab')].map((t) => ({
      title: (t.querySelector('.tab-title')?.textContent ?? '').trim(),
      dot: t.querySelector('.status-dot')?.className ?? ''
    }))
  )
/**
 * 本地终端标签的两种标题形态。
 *
 * shell integration 上报 cwd 之后是 `本地 · <目录>`，上报之前才是字面的「本地终端」。
 * 只排除后者会把**本机**标签错认成宿主机标签 —— 上一版就是这么错的：
 * phase 4 于是把 `kill -9 $PPID` 敲进了 cmd（那里根本没有 kill），
 * 父会话压根没断，容器标签自然还显示「已连接」，
 * 而「父会话重连回来了」又因为读的是本机标签而**空过**。
 */
const isLocalTab = (title) => title === '本地终端' || title.startsWith('本地 · ')
const hostTabDot = async () => {
  const tabs = await tabStates()
  return tabs.find((t) => !isLocalTab(t.title) && !t.title.startsWith(CONTAINER_TAB_PREFIX))?.dot ?? ''
}
const containerTabDot = async (name) => {
  const tabs = await tabStates()
  return tabs.find((t) => t.title === `${CONTAINER_TAB_PREFIX}${name}`)?.dot ?? null
}
const containerRows = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.container')].map((el) => ({
      name: (el.querySelector('.container-name')?.textContent ?? '').trim(),
      title: el.getAttribute('title') ?? '',
      stale: !!el.closest('.container-list')?.classList.contains('stale')
    }))
  )
const panelText = () =>
  win.evaluate(() => document.querySelector('.sidebar')?.textContent ?? '')

/**
 * 在**本机**直接跑 docker/podman，作为本机容器面板的独立对照物。
 *
 * 为什么不走应用终端：本机终端的 shell 由设置决定（Windows 上默认 cmd），
 * 往里敲 `command -v docker` 这类 POSIX 命令只会得到「不是内部或外部命令」，
 * 那是测试自己造出来的失败，不是产品的问题。终端还**会回显敲进去的命令**，
 * 所以拿 includes 去认标记时，命令里的标记会冒充输出（本文件为此单有 hasOutputLine）。
 *
 * 为什么优先挑 .exe：Windows 上 `where docker` 会把 Docker Desktop 在 bin 目录里
 * 放的 1359 字节 POSIX 脚本排在 docker.exe 前面，直接 execFile('docker') 会
 * 以 ERROR_BAD_EXE_FORMAT 挂掉 —— 应用里 `resolveExecutable` 踩过同一个坑。
 */
function findLocalRuntime() {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  for (const bin of ['docker', 'podman']) {
    let out = ''
    try {
      out = execFileSync(finder, [bin], { encoding: 'utf8', windowsHide: true })
    } catch {
      continue
    }
    const paths = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    const pick =
      process.platform === 'win32' ? (paths.find((p) => /\.exe$/i.test(p)) ?? paths[0]) : paths[0]
    if (pick) return { bin: pick, name: bin }
  }
  return null
}

/** 用 findLocalRuntime 挑出来的二进制跑一条命令；跑不了就返回 null */
function runLocal(runtime, args) {
  if (!runtime) return null
  try {
    return execFileSync(runtime.bin, args, { encoding: 'utf8', windowsHide: true })
  } catch (err) {
    return err.stdout ?? ''
  }
}

/**
 * 展开侧栏的「容器」分区。
 *
 * 侧栏现在只有一种标题形状（可折叠的 .section-head），所以直接按标题找、
 * 看 aria-expanded 决定要不要点 —— 而不是无条件点一下（那会把已展开的收起来，
 * 后面所有读面板的断言就全在读到「没有容器面板」）。
 */
async function openTools() {
  const head = win.locator('.sidebar .section-head', { hasText: '容器' })
  await head.waitFor({ timeout: 10000 })
  if ((await head.getAttribute('aria-expanded')) === 'false') {
    await head.click()
    await win.waitForTimeout(500)
  }
}

/**
 * 右键某容器 → 点「进入」。
 *
 * 用 `:text-is()` 精确匹配容器名，不用 hasText —— 后者是子串匹配，
 * 名叫 `web` 和 `web-1` 的两个容器会选中同一个。
 */
async function enterContainer(name) {
  const row = win
    .locator('.container')
    .filter({ has: win.locator(`.container-name:text-is("${name}")`) })
  await row.click({ button: 'right' })
  await win.waitForTimeout(300)
  await win.locator('.context-menu .menu-item:has-text("进入")').first().click()
}

/**
 * 把某个标签切到前台。
 *
 * 进入容器后要读的是**容器里**的输出，所以必须显式切过去，不能指望
 * 「新建标签会自己变成活动标签」—— 那是应用的行为，不是本测试可依赖的前提；
 * 万一哪天不自动切了，测试应当在这里失败并说清楚，而不是把宿主机的输出
 * 当成容器的输出、报出一堆看不懂的断言。
 */
async function focusTab(title) {
  await win.locator('.tab').filter({ hasText: title }).first().click()
  await win.waitForTimeout(500)
}

async function closeContainerTab(name) {
  const tab = win.locator('.tab').filter({ hasText: `${CONTAINER_TAB_PREFIX}${name}` }).first()
  await tab.locator('.tab-close').click()
  await win.waitForTimeout(400)
}

/** 等某个容器标签到达（或离开）已连接状态 */
async function waitForContainerTab(name, { connected, timeoutMs = 16000 }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const dot = await containerTabDot(name)
    if (connected ? dot?.includes('connected') : dot !== null && !dot.includes('connected')) {
      return dot
    }
    await win.waitForTimeout(400)
  }
  return containerTabDot(name)
}

// ---------- 阶段 0：起干净状态并连上设备 ----------
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)
// 清布局与 reload 放同一次 evaluate：布局 store 有 400ms 防抖自动保存，
// 留出间隙它会立刻把当前标签写回快照
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
await win.waitForTimeout(2500)

/*
 * 切到 DOM 渲染器，否则读不到 .xterm-rows（WebGL 把字符画在 canvas 上）。
 * 必须赶在**任何** termRun 之前 —— 阶段 1 就要读终端，所以不能像原来那样
 * 等连上设备之后才切。
 */
const origSettings = await win.evaluate(() => window.api.getSettings())
if (origSettings && !origSettings.ligatures) {
  await win.evaluate((s) => window.api.setSettings({ ...s, ligatures: true }), origSettings)
  await win.waitForTimeout(600)
}
await win.waitForFunction(() => document.querySelectorAll('.xterm-rows').length > 0, undefined, {
  timeout: 15000
})

// ---------- 阶段 1：本机容器（总是能跑）----------
/*
 * 应用启动就是一个本地终端，所以这时面板的目标是**本机**。
 * 这条路径不依赖任何 SSH，是唯一一个在「没有可连接设备」的机器上也跑得动的阶段。
 */
console.log('\n阶段 1：本机容器')
await openTools()
await win.waitForTimeout(2000)
const localPanel = await panelText()
check(
  '本地标签下面板探测的是本机（不是「先连接一台设备」）',
  !localPanel.includes('打开一个本地终端'),
  localPanel.slice(0, 80)
)

// 与 Node 侧独立读一次对账；没有 docker 的机器上这一步会如实报「没装」
const localRuntime = findLocalRuntime()
if (!localRuntime) {
  skip('本机没有 docker/podman —— 只验降级文案')
  check(
    '无 runtime 时如实说明本机没装',
    localPanel.includes('本机没有安装'),
    localPanel.slice(0, 100)
  )
} else {
  const localText = await panelText()
  const localRows = await containerRows()
  const localLive = runLocal(localRuntime, ['ps', '-a', '--format', '{{.Names}}']) ?? ''
  const localMissing = localRows.map((r) => r.name).filter((n) => !localLive.includes(n))
  check(
    '本机列出的容器都能在 docker ps -a 里找到',
    localMissing.length === 0,
    `${localRuntime.name}: ${localMissing.join(', ')}`
  )
  check(
    '本机没有运行中的容器时如实说明（含已停止计数）',
    localRows.length > 0 || localText.includes('没有运行中的容器'),
    localText.slice(0, 100)
  )
  await win.screenshot({ path: 'shots/52-local-containers.png' })

  // 进入本机容器：与远端同一条断言链（/.dockerenv 是宿主机上不存在的东西）
  if (!localRows.length) {
    skip('本机没有运行中的容器 —— 跳过「进入本机容器」验证')
  } else {
    const name = localRows[0].name
    await enterContainer(name)
    const dot = await waitForContainerTab(name, { connected: true })
    check(`进入了本机容器 ${name}`, dot?.includes('connected') ?? false, String(dot))
    if (dot?.includes('connected')) {
      await focusTab(`${CONTAINER_TAB_PREFIX}${name}`)
      const inside = await termRun(
        '[ -f /.dockerenv ] && echo IN_DOCKER; [ -f /run/.containerenv ] && echo IN_PODMAN; true'
      )
      check(
        '本机容器里有 /.dockerenv（宿主机上不会有）',
        hasOutputLine(inside, 'IN_DOCKER') || hasOutputLine(inside, 'IN_PODMAN')
      )
      await closeContainerTab(name)
    }
  }
}

const deviceCount = await win.locator('.device').count()
if (!deviceCount) {
  console.log('\n没有已保存设备，无法继续后续阶段。')
  console.log(process.exitCode ? '\n结论: 存在失败项' : '\n结论: 全部通过（部分跳过）')
  await app.close()
  process.exit(process.exitCode ?? 0)
}

// ---------- 连上设备，开 SFTP（后面要用），并取宿主机 hostname ----------
await win.locator('.device .device-name').first().dblclick()
await win.waitForFunction(
  () => document.querySelectorAll('.tab-content').length >= 2,
  undefined,
  { timeout: 25000 }
)
await win.waitForTimeout(2500)

/** 宿主机标签的标题（已保存设备时是设备名，不含 @，所以要从标签栏现取） */
const hostTabTitle = (await tabStates()).find(
  (t) => !isLocalTab(t.title) && !t.title.startsWith(CONTAINER_TAB_PREFIX)
)?.title
if (!hostTabTitle) {
  console.log('\n没能在标签栏里认出宿主机标签，无法继续。')
  await app.close()
  process.exit(1)
}

const hostText = await termRun('hostname')
const hostName = (hostText.split('\n').find((l) => l.trim() && !l.includes('hostname')) ?? '').trim()
const hostHasDockerEnv = await termRun('[ -f /.dockerenv ] && echo HOST_IS_CONTAINER || echo HOST_IS_NOT')
check('宿主机的 hostname 取到了', !!hostName, hostName)
check(
  '宿主机本身不是容器（否则本脚本的判据不成立）',
  !hasOutputLine(hostHasDockerEnv, 'HOST_IS_CONTAINER')
)

await win.locator('button:has-text("SFTP")').click()
await win.waitForTimeout(1500)

await openTools()
await win.waitForTimeout(800)

// ---------- 阶段 2：探测与列表 ----------
console.log('\n阶段 2：探测与列表')
const runtimeProbe = await termRun(
  'command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1 && echo DOX_HAS_RUNTIME || echo DOX_NO_RUNTIME',
  900
)
const hasRuntime = runtimeProbe.includes('DOX_HAS_RUNTIME')

if (!hasRuntime) {
  skip('测试主机没有 docker/podman —— 跳过容器端到端验证')
  const text = await panelText()
  check(
    '无 runtime 时面板如实说明（不是空白也不是通用报错）',
    text.includes('没有安装 docker') || text.includes('没有安装'),
    text.slice(0, 100)
  )
} else {
  let rows = []
  for (let i = 0; i < 20; i++) {
    rows = await containerRows()
    if (rows.length) break
    await win.waitForTimeout(400)
  }
  const text = await panelText()
  check(
    '面板列出了容器（或明确说没有运行中的）',
    rows.length > 0 || text.includes('没有运行中的容器'),
    `${rows.length} 行`
  )
  await win.screenshot({ path: 'shots/50-container-panel.png' })

  if (rows.length) {
    // 与终端里独立读一次 docker ps 对账，防「字段解析错了却看不出来」
    const liveText = await termRun(
      "docker ps --format '{{.Names}}' 2>/dev/null || podman ps --format '{{.Names}}'",
      1200
    )
    const missing = rows.map((r) => r.name).filter((n) => !liveText.includes(n))
    check('面板里的容器都能在 docker ps 输出里找到', missing.length === 0, missing.join(', '))

    const stoppedText = await termRun(
      "docker ps -a --format '{{.Status}}' 2>/dev/null | grep -cv '^Up' || echo 0",
      1200
    )
    const stoppedLive = Number(
      (stoppedText.split('\n').filter((l) => /^\d+$/.test(l.trim())).pop() ?? '0').trim()
    )
    const panelStopped = Number((text.match(/另有 (\d+) 个已停止/) ?? [])[1] ?? '0')
    check(
      '已停止数量与 docker ps -a 一致',
      panelStopped === stoppedLive,
      `面板 ${panelStopped} / 实际 ${stoppedLive}`
    )
  }

  // ---------- 阶段 3：进入容器 ----------
  console.log('\n阶段 3：进入容器')
  let entered = null
  for (const row of rows.slice(0, 3)) {
    await enterContainer(row.name)
    // 进容器要先探测 shell 再开通道，两次 exec 往返，给足时间
    const dot = await waitForContainerTab(row.name, { connected: true })
    if (dot?.includes('connected')) {
      entered = row.name
      break
    }
    skip(`容器 ${row.name} 进不去（多半没有 shell，或是 host 网络），换下一个`)
    await closeContainerTab(row.name)
  }

  if (!entered) {
    skip('没有可以进入的容器（全部没有 shell 或是 host 网络）—— 跳过进入容器的验证')
  } else {
    check(`进入了容器 ${entered}`, true)
    await focusTab(`${CONTAINER_TAB_PREFIX}${entered}`)
    const tabs = await tabStates()
    check(
      '新标签标题是 容器 · <名字>',
      tabs.some((t) => t.title === `${CONTAINER_TAB_PREFIX}${entered}`),
      tabs.map((t) => t.title).join(' | ')
    )
    await win.screenshot({ path: 'shots/51-container-tab.png' })

    // 真的在容器里：这两个标志在宿主机上都不会出现
    const inside = await termRun('[ -f /.dockerenv ] && echo IN_DOCKER; [ -f /run/.containerenv ] && echo IN_PODMAN; true')
    check(
      '容器里有 /.dockerenv 或 /run/.containerenv（宿主机上都没有）',
      hasOutputLine(inside, 'IN_DOCKER') || hasOutputLine(inside, 'IN_PODMAN')
    )
    const inner = await termRun('hostname')
    const innerName = (inner.split('\n').filter((l) => l.trim() && !l.includes('hostname')).pop() ?? '').trim()
    check('容器里的 hostname 与宿主机不同', innerName !== hostName, `${innerName} ≠ ${hostName}`)

    // resize 必须真的传到容器里，否则容器里的 vim/top 永远是 80×24
    const sizeBefore = await termRun('stty size')
    const before = (sizeBefore.match(/(\d+)\s+(\d+)/) ?? []).slice(1).join('x')
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1100, 620)
    })
    await win.waitForTimeout(1200)
    let after = before
    for (let i = 0; i < 12; i++) {
      const sizeAfter = await termRun('stty size', 400)
      after = (sizeAfter.match(/(\d+)\s+(\d+)/g) ?? []).slice(-1)[0] ?? after
      if (after && after !== before) break
      await win.waitForTimeout(400)
    }
    check('窗口变化传到了容器里（stty size 变了）', !!after && after !== before, `${before} → ${after}`)

    // SFTP 面板跟随活动标签换绑（容器文件管理上线后的现行行为）：
    // 切到容器标签 → 面板换绑到该容器（没装 agent 时给安装引导，不是宿主文件列表）；
    // 切回宿主机标签 → 面板换回宿主文件列表。
    await focusTab(CONTAINER_TAB_PREFIX)
    await win.waitForTimeout(800)
    check('容器标签下面板换绑到容器（徽章或安装引导）', await win.evaluate(() => {
      const el = document.querySelector('.explorer')
      if (!el || el.offsetParent === null) return false
      // 装了 agent：容器名徽章 + 容器内文件列表；没装：安装引导。两者都证明换绑成功。
      return el.querySelector('.ctr-badge') !== null || el.textContent.includes('安装到容器')
    }), await win.evaluate(() => {
      const el = document.querySelector('.explorer')
      return el ? `[visible=${el.offsetParent !== null}] ` + el.textContent.trim().slice(0, 120) : '(无 .explorer)'
    }))
    await focusTab(hostTabTitle)
    await win.waitForTimeout(800)
    check('切回宿主机标签后面板换回宿主文件列表', await win.evaluate(() => {
      const el = document.querySelector('.explorer')
      if (!el || el.offsetParent === null) return false
      return !el.textContent.includes('安装到容器') && el.querySelector('.file-list') !== null
    }))

    // ---------- 阶段 4：父会话断开 ----------
    console.log('\n阶段 4：父会话断开时的行为')
    await win.evaluate(() => {
      window.__containerStatuses = []
      window.__allStatuses = []
      window.api.onStatus((e) => {
        window.__allStatuses.push(`${e.id.slice(0, 8)}=${e.status}`)
        if (e.id.startsWith('container-')) window.__containerStatuses.push(e.status)
      })
    })

    await termRun('kill -9 $PPID', 400)

    // 等状态落定
    await win.waitForTimeout(4000)

    /*
     * 先确认父会话**真的掉线了**，再去断言它的后果。
     *
     * 少了这一步，「命令没送进去」会伪装成「容器标签没变 closed」——
     * 看着像功能坏了，其实是测试没驱到位；而后面「父会话重连回来了」还会**空过**
     * （读错标签时它一直是 connected）。这一类假失败/假通过都源于拿前因当既成事实。
     *
     * 判据取**事件**而不是状态点：自动重连很快，轮询状态点会整个错过那段中转态
     * （实测掉线→重连在两次轮询之间就完成了），只有事件流一定记得住。
     */
    const allStatuses = await win.evaluate(() => window.__allStatuses)
    check(
      '父会话确实掉线了（下面两条断言的前提）',
      allStatuses.some((s) => /=(reconnecting|closed)$/.test(s)),
      allStatuses.join(', ') || '(无状态事件)'
    )

    const statuses = await win.evaluate(() => window.__containerStatuses)
    check(
      '容器会话从不进入 reconnecting（它没有重连这回事）',
      !statuses.includes('reconnecting'),
      statuses.join(',') || '(无状态事件)'
    )
    const afterDrop = await containerTabDot(entered)
    check('容器标签如实变成已断开', !!afterDrop && afterDrop.includes('closed'), String(afterDrop))

    // 父会话自己会重连回来；容器标签不该被顺手拉起来
    let parentBack = false
    for (let i = 0; i < 60; i++) {
      await win.waitForTimeout(500)
      if ((await hostTabDot()).includes('connected')) {
        parentBack = true
        break
      }
    }
    check('父会话重连回来了', parentBack)
    const stillClosed = await containerTabDot(entered)
    check(
      '父会话重连后容器标签仍是已断开（不替用户假设容器还在）',
      !!stillClosed && stillClosed.includes('closed'),
      String(stillClosed)
    )

    // 再进一次：应当复用同一个标签，而不是越堆越多
    const tabsBefore = (await tabStates()).length
    await openTools()
    await win.waitForTimeout(1500)
    const rowsAgain = await containerRows()
    const sameRow = rowsAgain.find((r) => r.name === entered)
    if (!sameRow) {
      skip('重连后列表里没有这个容器了，跳过「复用标签」验证')
    } else {
      await enterContainer(entered)
      await waitForContainerTab(entered, { connected: true })
      const tabsAfter = (await tabStates()).length
      check(
        '再次进入复用同一个标签（标签数不变）',
        tabsAfter === tabsBefore,
        `${tabsBefore} → ${tabsAfter}`
      )
      await closeContainerTab(entered)
    }
  }
}

// ---------- 阶段 5：只读守卫 ----------
console.log('\n阶段 5：只读守卫（把「不装东西」这条约束编码进测试）')

/*
 * 先剥注释再匹配。
 *
 * 这些守卫是拿来查**代码**的，而注释里本来就会讨论 docker 的子命令
 * （「不启停容器」「必须是 pty 对象：pty:true 等于 80×24」）—— 拿原文匹配
 * 会被自己的说明文字绊倒，报一堆假失败，然后为了让它绿就去改注释，
 * 守卫就彻底失去意义了。
 *
 * 代价：字符串字面量里的 `//` 也会被当成注释起点。这几个文件里没有 URL，
 * 不构成实际问题；真出现了再加真正的词法扫描。
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const sources = stripComments(
  ['ContainerManager.ts', 'runtime.ts', 'localRun.ts']
    .map((f) => readFileSync(`src/main/container/${f}`, 'utf8'))
    .join('\n')
)

// docker/podman 的子命令里，ps / exec / logs 加生命周期四个（start/stop/unpause/rm，
// 经 CONTROL_VERBS 白名单，用户显式触发）是允许的；建容器/装东西/拷文件仍是红线
for (const sub of ['run', 'cp', 'build', 'pull', 'create']) {
  const hit = new RegExp(`\\b(docker|podman)\\s+${sub}\\b`).test(sources)
  check(`不出现 docker/podman ${sub}（不建容器、不装东西、不拷文件）`, !hit)
}
check(
  '生命周期动作经 CONTROL_VERBS 白名单（渲染层字符串不直接进命令）',
  /CONTROL_VERBS\s*=\s*\{\s*start/.test(readFileSync('src/main/container/runtime.ts', 'utf8'))
)
check(
  '探测一律不开 pty（否则 stderr 会被并进 stdout，错误分类就瞎了）',
  !/pty:\s*true/.test(sources)
)

if (origSettings) {
  await win.evaluate((s) => window.api.setSettings(s), origSettings)
  await win.waitForTimeout(300)
}

console.log(process.exitCode ? '\n结论: 存在失败项' : '\n结论: 全部通过')
await app.close()
process.exit(process.exitCode ?? 0)
