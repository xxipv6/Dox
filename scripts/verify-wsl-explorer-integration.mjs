/**
 * 真实 WSL Linux 文件面板验收：Ubuntu/Debian 相同 POSIX 路径放不同内容，
 * 通过 UI 浏览、CRUD、编辑器保存和“在终端打开”，再用各发行版的 wsl.exe 权威校验。
 * 用法：npm run build && node scripts/verify-wsl-explorer-integration.mjs
 */
import { _electron as electron } from 'playwright'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}
const distros = ['Ubuntu', 'Debian']
const stamp = Date.now()
const fixture = `/tmp/dox-wsl-panel-${stamp}`
const sessionIds = {}
const userData = mkdtempSync(join(tmpdir(), 'dox-wsl-explorer-'))
const winFixture = mkdtempSync(join(tmpdir(), 'dox-wsl-copy-'))
const winSource = join(winFixture, 'outside.txt')
const winFixtureWsl = `/mnt/${winFixture[0].toLowerCase()}${winFixture.slice(2).replace(/\\/g, '/')}`
writeFileSync(winSource, 'win-to-wsl', 'utf8')
mkdirSync('shots', { recursive: true })

function wsl(distro, script) {
  const r = spawnSync('wsl.exe', ['-d', distro, '-e', 'sh', '-c', script], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${distro} 命令失败：${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

for (const distro of distros) {
  wsl(distro, `rm -rf -- ${fixture} && mkdir -p -- ${fixture} && printf '%s' '${distro}' > ${fixture}/who.txt && printf '%s' '${distro}-only' > ${fixture}/${distro}-only.txt`)
}

let app
let win
try {
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: process.cwd() })
  win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(() => window.api.setLayout({ tabs: [] }))
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => document.querySelectorAll('.wsl-row').length >= 2, undefined, {
    timeout: 30000
  })
  await win.evaluate(() => {
    globalThis.__wslExplorerOutput = {}
    globalThis.__wslExplorerSearch = []
    window.api.onData((id, chunk) => {
      const text = new TextDecoder().decode(chunk)
      globalThis.__wslExplorerOutput[id] = (globalThis.__wslExplorerOutput[id] ?? '') + text
    })
    window.api.onSearchEvent((event) => globalThis.__wslExplorerSearch.push(event))
  })

  for (const distro of distros) {
    console.log(`\n${distro}`)
    const knownIds = await win.evaluate(() => Object.keys(globalThis.__wslExplorerOutput ?? {}))
    await win.locator('.wsl-row').filter({ hasText: distro }).first().dblclick()
    await win.waitForFunction(
      (expected) => document.querySelector('.tab.active .tab-title')?.textContent?.includes(expected),
      distro,
      { timeout: 20000 }
    )
    await win.locator('.tab-content:visible .xterm-helper-textarea').first().waitFor({ state: 'visible', timeout: 30000 })
    await win.waitForFunction(
      (ids) => Object.keys(globalThis.__wslExplorerOutput ?? {}).some((id) => !ids.includes(id)),
      knownIds,
      { timeout: 30000 }
    )
    const candidateIds = await win.evaluate(
      (ids) => Object.keys(globalThis.__wslExplorerOutput ?? {}).filter((id) => !ids.includes(id)),
      knownIds
    )
    // 后台本地通道也可能在新标签期间出现；用真实文件列表找出当前 WSL pane，而不是猜第一个新 id。
    for (const id of candidateIds) {
      const entries = await win.evaluate(
        ({ sessionId, dir }) => window.api.sftpList(sessionId, dir).catch(() => null),
        { sessionId: id, dir: fixture }
      )
      if (entries?.some((entry) => entry.name === 'who.txt') && entries[0]?.path.startsWith('/')) {
        sessionIds[distro] = id
        break
      }
    }
    check('识别当前 WSL 文件会话', !!sessionIds[distro], candidateIds.join(','))
    if ((await win.locator('.explorer:visible').count()) === 0) {
      await win.locator('button.bar-btn', { hasText: '文件' }).click()
    }
    await win.waitForFunction(
      (expected) => [...document.querySelectorAll('.explorer')].some(
        (el) => el.clientWidth > 0 && el.querySelector('.ctr-badge')?.textContent?.includes(`WSL · ${expected}`)
      ),
      distro,
      { timeout: 30000 }
    )
    const panel = win.locator('.explorer:visible')
    await panel.locator('.row').first().waitFor({ timeout: 30000 })

    const initialCrumb = (await panel.locator('.breadcrumb').textContent()) ?? ''
    const expectedHome = wsl(distro, 'cd "$HOME" && pwd -P')
    check(
      '初始是 POSIX home，不是 Windows 目录',
      initialCrumb.includes(expectedHome) && !initialCrumb.includes('此电脑') && !initialCrumb.includes('Users'),
      initialCrumb
    )

    // 回到 Linux 根，逐层进入 /tmp/<fixture>。
    await panel.locator('.breadcrumb .crumb').first().click()
    await panel.locator('.row').filter({ hasText: 'tmp' }).first().dblclick()
    await panel.locator('.row').filter({ hasText: `dox-wsl-panel-${stamp}` }).first().dblclick()
    await win.waitForFunction(
      (expected) => [...document.querySelectorAll('.explorer')].some(
        (el) => el.clientWidth > 0 && el.querySelector('.breadcrumb')?.textContent?.includes(expected)
      ),
      fixture,
      { timeout: 15000 }
    )
    const crumb = (await panel.locator('.breadcrumb').textContent()) ?? ''
    check('根/面包屑进入 Linux 测试目录', crumb.includes(fixture) && !crumb.includes('此电脑'), crumb)
    check(
      '本发行版 marker 正确且不串另一个发行版',
      (await panel.locator('.row').filter({ hasText: `${distro}-only.txt` }).count()) === 1 &&
        (await panel.locator('.row').filter({ hasText: 'who.txt' }).count()) === 1
    )

    // /mnt/<盘符> 是宿主的 drvfs 挂载：实际读写必须绕开 WSL UNC 回环，公开路径仍是 POSIX。
    const mountedEntries = await win.evaluate(
      ({ sessionId, dir }) => window.api.sftpList(sessionId, dir),
      { sessionId: sessionIds[distro], dir: winFixtureWsl }
    )
    check(
      '可从 WSL 文件会话列出宿主盘 /mnt 目录',
      mountedEntries.some((entry) => entry.path === `${winFixtureWsl}/outside.txt`),
      JSON.stringify({ dir: winFixtureWsl, entries: mountedEntries })
    )
    const mountedRealpath = await win.evaluate(
      ({ sessionId, dir }) => window.api.sftpRealpath(sessionId, dir),
      { sessionId: sessionIds[distro], dir: winFixtureWsl }
    )
    check('宿主盘 realpath 转回 /mnt POSIX', mountedRealpath === winFixtureWsl, mountedRealpath)
    const mountedText = await win.evaluate(
      ({ sessionId, path }) => window.api.sftpReadText(sessionId, path),
      { sessionId: sessionIds[distro], path: `${winFixtureWsl}/outside.txt` }
    )
    check(
      '宿主盘编辑器读取保持内容和 POSIX path',
      mountedText.content === 'win-to-wsl' && mountedText.path === `${winFixtureWsl}/outside.txt`,
      JSON.stringify(mountedText)
    )

    // 编辑器读取并保存，最终由对应 distro 的 cat 校验。
    await panel.locator('.row').filter({ hasText: 'who.txt' }).first().dblclick()
    await win.locator('.cm-content').waitFor({ timeout: 15000 })
    const content = (await win.locator('.cm-content').textContent()) ?? ''
    check('编辑器读取当前发行版内容', content.includes(distro), content)
    await win.locator('.cm-content').click()
    await win.keyboard.press('Control+a')
    await win.keyboard.type(`${distro}-saved`)
    await win.keyboard.press('Control+s')
    await win.waitForTimeout(700)
    check('编辑器保存到当前发行版', wsl(distro, `cat ${fixture}/who.txt`) === `${distro}-saved`)

    // WSL 搜索固定走 Node，结果路径必须仍是 POSIX，不能泄漏 UNC。
    await win.evaluate(() => {
      globalThis.__wslExplorerSearch = []
    })
    const started = await win.evaluate(
      ({ sessionId, root }) => window.api.searchStart({
        fsSessionId: sessionId,
        root,
        pattern: 'saved',
        isRegex: false,
        ignoreCase: true
      }),
      { sessionId: sessionIds[distro], root: fixture }
    )
    await win.waitForFunction(
      (runId) => (globalThis.__wslExplorerSearch ?? []).some((event) => event.runId === runId && event.type === 'done'),
      started.runId,
      { timeout: 20000 }
    )
    const searchEvents = await win.evaluate(() => globalThis.__wslExplorerSearch)
    const matches = searchEvents.filter((event) => event.type === 'match').flatMap((event) => event.matches)
    check(
      'Node 搜索结果保持 POSIX 且属于当前发行版',
      started.engine === 'node' && matches.some((match) => match.path === `${fixture}/who.txt`),
      JSON.stringify({ engine: started.engine, sessionId: sessionIds[distro], events: searchEvents })
    )

    // 新建和删除目录。
    await panel.locator('button[title="新建文件夹"]').click()
    await panel.locator('.rename-input').fill('made')
    await win.keyboard.press('Enter')
    await win.waitForTimeout(700)
    check('新建目录落在当前发行版', wsl(distro, `test -d ${fixture}/made && printf yes`) === 'yes')
    await panel.locator('.row').filter({ hasText: 'made' }).first().click({ button: 'right' })
    await win.locator('.context-menu .menu-item').filter({ hasText: '删除' }).click()
    await win.locator('.confirm-dialog button').filter({ hasText: '确定' }).click()
    await win.waitForTimeout(700)
    check('删除目录落在当前发行版', wsl(distro, `test ! -e ${fixture}/made && printf yes`) === 'yes')

    // “在终端打开”后用真实 PWD 验证，不以 cd 命令回显作为通过依据。
    await panel.locator('button[title="在终端中打开此目录"]').click()
    const input = win.locator('.tab-content:visible .xterm-helper-textarea').first()
    await input.click()
    await win.keyboard.type("printf '\\nDOXPWD_%s_END\\n' \"$PWD\"")
    await win.keyboard.press('Enter')
    await win.waitForFunction(
      (expected) => Object.values(globalThis.__wslExplorerOutput ?? {}).some((text) => text.includes(expected)),
      `DOXPWD_${fixture}_END`,
      { timeout: 20000 }
    )
    check('在终端打开进入同一 Linux 目录', true)

    // 无 OSC 7 的 WSL 也要靠 cd 输入跟踪让文件面板跟随，且路径始终保持 POSIX。
    const followButton = panel.locator('button[title^="跟随终端"]')
    if (((await followButton.getAttribute('title')) ?? '').includes('关')) await followButton.click()
    await input.click()
    await win.keyboard.type('cd /tmp')
    await win.keyboard.press('Enter')
    await panel.locator('.row').filter({ hasText: `dox-wsl-panel-${stamp}` }).first().waitFor({ timeout: 15000 })
    const followedTmpCrumb = (await panel.locator('.breadcrumb').textContent()) ?? ''
    check(
      '终端 cd /tmp 后面板跟随到 Linux /tmp',
      followedTmpCrumb.includes('tmp') && !followedTmpCrumb.includes(fixture) && !followedTmpCrumb.includes('此电脑'),
      followedTmpCrumb
    )
    await input.click()
    await win.keyboard.type(`cd ${fixture}`)
    await win.keyboard.press('Enter')
    await win.waitForFunction(
      (expected) => [...document.querySelectorAll('.explorer')].some(
        (el) => el.clientWidth > 0 && el.querySelector('.breadcrumb')?.textContent?.includes(expected)
      ),
      fixture,
      { timeout: 15000 }
    )
    check('终端 cd 回测试目录后面板继续跟随', true)

    // 同面板复制：源和目标都是 POSIX，主进程实际按当前 distro 转成 UNC。
    await panel.locator('.row').filter({ hasText: 'who.txt' }).first().click()
    await win.keyboard.press('Control+c')
    await panel.locator('button[title="新建文件夹"]').click()
    await panel.locator('.rename-input').fill('copydst')
    await win.keyboard.press('Enter')
    await win.waitForTimeout(500)
    await panel.locator('.row').filter({ hasText: 'copydst' }).first().dblclick()
    await win.waitForTimeout(300)
    await win.keyboard.press('Control+v')
    await win.waitForTimeout(1000)
    check(
      '同面板复制落到当前发行版',
      wsl(distro, `cat ${fixture}/copydst/who.txt`) === `${distro}-saved`
    )
    const transfers = await win.evaluate(() => window.api.listTransfers())
    check(
      '复制任务公开路径仍为 POSIX',
      transfers.some((task) => task.remotePath === `${fixture}/copydst/who.txt`),
      JSON.stringify(transfers)
    )

    // Windows → WSL 与 WSL → Windows 都复用同一本机复制边界。
    await win.evaluate(
      ({ sessionId, dir, source }) => window.api.enqueueDropped(
        sessionId,
        dir,
        [{ path: source, name: 'outside.txt', size: 11 }]
      ),
      { sessionId: sessionIds[distro], dir: fixture, source: winSource }
    )
    await win.waitForTimeout(700)
    check('Windows 文件复制进当前发行版', wsl(distro, `cat ${fixture}/outside.txt`) === 'win-to-wsl')

    const downloadDir = join(winFixture, distro)
    mkdirSync(downloadDir, { recursive: true })
    await win.evaluate(
      ({ sessionId, dir, source }) => window.api.enqueueDropped(
        sessionId,
        dir,
        [{ path: source, name: 'who.txt', size: 12 }]
      ),
      { sessionId: sessionIds[distro], dir: downloadDir, source: `${fixture}/who.txt` }
    )
    await win.waitForTimeout(700)
    check(
      '当前发行版文件复制回 Windows',
      readFileSync(join(downloadDir, 'who.txt'), 'utf8') === `${distro}-saved`
    )

    // 项目根也必须按 distro 记账；两个发行版使用同一个 POSIX 路径仍不能共享 @local。
    await panel.locator('.breadcrumb .crumb').filter({ hasText: `dox-wsl-panel-${stamp}` }).click()
    await panel.locator('.row').filter({ hasText: 'copydst' }).first().click({ button: 'right' })
    await win.locator('.context-menu .menu-item').filter({ hasText: '进入项目模式' }).click()
    await panel.locator('.project-bar').waitFor({ timeout: 10000 })
    await win.waitForTimeout(400)
    const projectRoots = (await win.evaluate(() => window.api.getSettings())).projectRoots
    check(
      '真实项目根按 distro 隔离',
      projectRoots[`@wsl:${distro}`] === `${fixture}/copydst`,
      JSON.stringify(projectRoots)
    )
  }

  // 布局中的 WSL cwd 必须保持 POSIX，并在恢复时通过 wsl --cd 回到同一目录。
  await win.waitForTimeout(1300)
  const layout = await win.evaluate(() => window.api.getLayout())
  check(
    'WSL 布局快照保存 POSIX cwd',
    layout.tabs.some((tab) => tab.localShellId?.startsWith('wsl:') && tab.cwd === fixture),
    JSON.stringify(layout.tabs.map((tab) => ({ shell: tab.localShellId, cwd: tab.cwd })))
  )
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(
    () => document.querySelector('.tab.active .tab-title')?.textContent?.includes('WSL · Debian'),
    undefined,
    { timeout: 30000 }
  )
  await win.evaluate(() => {
    globalThis.__wslLayoutOutput = {}
    window.api.onData((id, chunk) => {
      const text = new TextDecoder().decode(chunk)
      globalThis.__wslLayoutOutput[id] = (globalThis.__wslLayoutOutput[id] ?? '') + text
    })
  })
  const restoredInput = win.locator('.tab-content:visible .xterm-helper-textarea').first()
  await restoredInput.click()
  await win.keyboard.type("printf '\\nDOXLAYOUT_%s_END\\n' \"$PWD\"")
  await win.keyboard.press('Enter')
  await win.waitForFunction(
    (expected) => Object.values(globalThis.__wslLayoutOutput ?? {}).some((text) => text.includes(expected)),
    `DOXLAYOUT_${fixture}_END`,
    { timeout: 20000 }
  )
  check('布局恢复后 WSL 终端回到原 POSIX cwd', true)

  // 全局默认 Shell 也是 WSL 时，仍要识别发行版并忽略 Windows 默认目录。
  await win.evaluate(() =>
    window.api.setSettings({
      themeId: 'auto',
      uiTheme: 'light',
      fontSize: 14,
      fontId: 'default',
      ligatures: false,
      localShellId: 'wsl:Ubuntu',
      suggestPortForward: true,
      portSentinel: true,
      outputHighlight: true,
      monitorWidth: 536,
      localDefaultDir: 'C:\\Windows\\Temp',
      projectRoots: {}
    })
  )
  await win.evaluate(() => window.api.setLayout({ tabs: [] }))
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(
    () => document.querySelector('.tab.active .tab-title')?.textContent?.includes('WSL · Ubuntu'),
    undefined,
    { timeout: 30000 }
  )
  await win.locator('button.bar-btn', { hasText: '文件' }).click()
  await win.waitForFunction(
    () => [...document.querySelectorAll('.explorer')].some(
      (el) => el.clientWidth > 0 && el.querySelector('.ctr-badge')?.textContent?.includes('WSL · Ubuntu')
    ),
    undefined,
    { timeout: 30000 }
  )
  const defaultCrumb = (await win.locator('.explorer:visible .breadcrumb').textContent()) ?? ''
  check(
    '全局默认 WSL 也落 Linux home 并忽略 Windows 默认目录',
    defaultCrumb.includes('/home/') && !defaultCrumb.includes('Windows\\Temp') && !defaultCrumb.includes('此电脑'),
    defaultCrumb
  )

  await win.screenshot({ path: `shots/wsl-explorer-${stamp}.png` })
  console.log(`  截图：shots/wsl-explorer-${stamp}.png`)
} catch (err) {
  failed = true
  console.error('  FAIL WSL 文件面板执行异常', err)
} finally {
  if (app) await app.close().catch(() => {})
  rmSync(userData, { recursive: true, force: true })
  rmSync(winFixture, { recursive: true, force: true })
  for (const distro of distros) {
    try {
      wsl(distro, `rm -rf -- ${fixture}`)
    } catch (err) {
      console.error(`  清理 ${distro} 测试目录失败`, err)
    }
  }
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
