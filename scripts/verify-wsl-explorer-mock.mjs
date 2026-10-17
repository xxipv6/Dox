/**
 * WSL 文件面板渲染层回归（mock IPC，不依赖测试机的 WSL 安装）。
 * 真实 Vue/store/preload 仍走产品代码，只替换主进程外部边界，重点检查：
 * POSIX 请求路径、Linux home、编辑器/新建目录、终端 cd 与布局 cwd、
 * 降级菜单、按 distro 隔离的项目根，以及全局默认 Shell 为 WSL 的落点。
 *
 * 用法：npm run build && node scripts/verify-wsl-explorer-mock.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

const shells = [
  { id: 'cmd', name: '命令提示符 (cmd)', integrated: false, integration: 'cmd' },
  {
    id: 'wsl:Ubuntu',
    name: 'WSL · Ubuntu',
    integrated: false,
    integration: 'none',
    wsl: { distro: 'Ubuntu', isDefault: true, state: 'running' }
  },
  {
    id: 'wsl:Debian',
    name: 'WSL · Debian',
    integrated: false,
    integration: 'none',
    wsl: { distro: 'Debian', isDefault: false, state: 'stopped' }
  }
]

const userData = mkdtempSync(join(tmpdir(), 'dox-wsl-explorer-mock-'))
let app
let win
try {
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: process.cwd() })
  win = await app.firstWindow()
  win.on('pageerror', (err) => console.log(`  [渲染层报错] ${err.message}`))
  await win.waitForLoadState('domcontentloaded')

  await app.evaluate(
    ({ ipcMain }, fixture) => {
      const state = {
        calls: { connect: [], list: [], mkdir: [], read: [], write: [], input: [], watch: [] },
        sessions: {},
        contents: {},
        seq: 0
      }
      globalThis.__wslExplorerMock = state
      const distroOf = (sessionId) => state.sessions[sessionId]
      const homeOf = (sessionId) => `/home/${(distroOf(sessionId) ?? 'unknown').toLowerCase()}`
      const entry = (path, isDir = false) => ({
        name: path.split('/').filter(Boolean).pop() ?? '/',
        path,
        isDir,
        isSymlink: false,
        size: isDir ? 0 : (state.contents[path]?.length ?? 4),
        mtime: 100,
        mode: isDir ? 0o040755 : 0o100644
      })
      const replace = (channel, handler) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, handler)
      }

      replace('local:listShells', () => fixture)
      replace('local:connect', (_event, _term, shellId, cwd) => {
        const sessionId = `local-mock-${++state.seq}`
        state.sessions[sessionId] = shellId?.startsWith('wsl:') ? shellId.slice(4) : undefined
        state.calls.connect.push({ sessionId, shellId: shellId ?? null, cwd: cwd ?? null })
        return sessionId
      })
      replace('sftp:realpath', (_event, sessionId) => homeOf(sessionId))
      replace('sftp:list', (_event, sessionId, dir) => {
        state.calls.list.push({ sessionId, dir })
        const distro = distroOf(sessionId)
        return [
          entry(`${dir === '/' ? '' : dir.replace(/\/$/, '')}/folder`, true),
          entry(`${dir === '/' ? '' : dir.replace(/\/$/, '')}/${distro}-only.txt`)
        ]
      })
      replace('sftp:stat', (_event, sessionId, path) => entry(path, path.endsWith('/folder')))
      replace('sftp:mkdir', (_event, sessionId, path) => {
        state.calls.mkdir.push({ sessionId, path })
      })
      replace('sftp:readText', (_event, sessionId, path) => {
        state.calls.read.push({ sessionId, path })
        const content = state.contents[path] ?? `${distroOf(sessionId)}-content`
        state.contents[path] = content
        return { path, content, size: content.length, mtime: 100, binary: false }
      })
      replace('sftp:writeText', (_event, sessionId, path, content) => {
        state.calls.write.push({ sessionId, path, content })
        state.contents[path] = content
        return 101
      })
      replace('sftp:diskUsage', () => null)
      replace('localFs:watch', (_event, sessionId, dirs) => {
        state.calls.watch.push({ sessionId, dirs })
      })
      ipcMain.removeAllListeners('ssh:input')
      ipcMain.on('ssh:input', (_event, sessionId, data) => {
        state.calls.input.push({ sessionId, data: String(data) })
      })
    },
    shells
  )

  await win.evaluate(async () => {
    const settings = await window.api.getSettings()
    await window.api.setSettings({ ...settings, localDefaultDir: 'C:\\Windows\\Temp', projectRoots: {} })
    await window.api.setLayout({ tabs: [] })
  })
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => document.querySelectorAll('.wsl-row').length === 2, undefined, {
    timeout: 15000
  })

  await win.locator('.wsl-row').filter({ hasText: 'Ubuntu' }).dblclick()
  await win.waitForFunction(() => document.querySelector('.tab.active .tab-title')?.textContent?.includes('Ubuntu'))
  await win.locator('button.bar-btn', { hasText: '文件' }).click()
  const panel = win.locator('.explorer:visible')
  await panel.locator('.row').first().waitFor({ timeout: 10000 })
  check('WSL 徽章标识当前发行版', (await panel.locator('.ctr-badge').textContent())?.includes('WSL · Ubuntu'))
  const homeCrumb = (await panel.locator('.breadcrumb').textContent()) ?? ''
  check(
    '初始目录是 Linux home，忽略 Windows 默认目录',
    homeCrumb.includes('/home/ubuntu') && !homeCrumb.includes('此电脑') && !homeCrumb.includes('Windows'),
    homeCrumb
  )
  check(
    '相同文件名按当前 distro 返回',
    (await panel.locator('.row').filter({ hasText: 'Ubuntu-only.txt' }).count()) === 1 &&
      (await panel.locator('.row').filter({ hasText: 'Debian-only.txt' }).count()) === 0
  )

  await panel.locator('.row').filter({ hasText: 'Ubuntu-only.txt' }).click({ button: 'right' })
  const menuText = (await win.locator('.context-menu').textContent()) ?? ''
  check(
    'WSL 隐藏 archive 和 Windows 资源管理器入口',
    !menuText.includes('打包') && !menuText.includes('资源管理器'),
    menuText
  )
  await win.keyboard.press('Escape')

  await panel.locator('.row').filter({ hasText: 'Ubuntu-only.txt' }).dblclick()
  await win.locator('.cm-content').waitFor({ timeout: 10000 })
  check(
    '编辑器读取请求保持 POSIX path',
    (await win.locator('.cm-content').textContent())?.includes('Ubuntu-content')
  )
  await win.locator('.cm-content').click()
  await win.keyboard.press('Control+a')
  await win.keyboard.type('Ubuntu-saved')
  await win.keyboard.press('Control+s')
  await win.waitForTimeout(400)
  let mock = await app.evaluate(() => ({
    read: globalThis.__wslExplorerMock.calls.read,
    write: globalThis.__wslExplorerMock.calls.write
  }))
  check(
    '编辑器读写都落在当前会话的 POSIX 文件',
    mock.read.at(-1)?.path === '/home/ubuntu/Ubuntu-only.txt' &&
      mock.write.at(-1)?.path === '/home/ubuntu/Ubuntu-only.txt' &&
      mock.write.at(-1)?.content === 'Ubuntu-saved',
    JSON.stringify(mock)
  )

  await panel.locator('button[title="新建文件夹"]').click()
  await panel.locator('.rename-input').fill('made')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(400)
  mock = await app.evaluate(() => ({ mkdir: globalThis.__wslExplorerMock.calls.mkdir }))
  check(
    '新建目录使用 POSIX join，不出现反斜杠或盘符',
    mock.mkdir.at(-1)?.path === '/home/ubuntu/made',
    JSON.stringify(mock.mkdir)
  )

  await panel.locator('button[title="在终端中打开此目录"]').click()
  await win.waitForTimeout(900)
  mock = await app.evaluate(() => ({ input: globalThis.__wslExplorerMock.calls.input }))
  check(
    '在终端打开发送 Linux cd',
    mock.input.some((call) => call.data === "cd '/home/ubuntu'\r"),
    JSON.stringify(mock.input)
  )
  const layout = await win.evaluate(() => window.api.getLayout())
  check(
    '程序化 cd 也写入 POSIX 布局 cwd',
    layout.tabs.some((tab) => tab.localShellId === 'wsl:Ubuntu' && tab.cwd === '/home/ubuntu'),
    JSON.stringify(layout.tabs)
  )

  // 相同项目相对位置在 Ubuntu/Debian 下必须使用不同 settings key。
  await panel.locator('.row').filter({ hasText: 'folder' }).click({ button: 'right' })
  await win.locator('.context-menu .menu-item').filter({ hasText: '进入项目模式' }).click()
  await panel.locator('.project-bar').waitFor()
  await win.locator('.wsl-row').filter({ hasText: 'Debian' }).dblclick()
  await win.waitForFunction(() => document.querySelector('.tab.active .tab-title')?.textContent?.includes('Debian'))
  await win.waitForFunction(() =>
    [...document.querySelectorAll('.explorer')].some(
      (el) => el.clientWidth > 0 && el.querySelector('.ctr-badge')?.textContent?.includes('WSL · Debian')
    )
  )
  const debianPanel = win.locator('.explorer:visible')
  await debianPanel.locator('.row').first().waitFor()
  await debianPanel.locator('.row').filter({ hasText: 'folder' }).click({ button: 'right' })
  await win.locator('.context-menu .menu-item').filter({ hasText: '进入项目模式' }).click()
  await debianPanel.locator('.project-bar').waitFor()
  await win.waitForTimeout(400)
  const rooted = await win.evaluate(() => window.api.getSettings())
  check(
    '项目根按 distro 隔离，不共用 @local',
    rooted.projectRoots['@wsl:Ubuntu'] === '/home/ubuntu/folder' &&
      rooted.projectRoots['@wsl:Debian'] === '/home/debian/folder',
    JSON.stringify(rooted.projectRoots)
  )

  // 全局默认 Shell 为 WSL 且标签没有显式 localShellId 时，也必须走同一套语义。
  await win.evaluate(async () => {
    const settings = await window.api.getSettings()
    await window.api.setSettings({
      ...settings,
      localShellId: 'wsl:Ubuntu',
      localDefaultDir: 'C:\\Windows\\Temp',
      projectRoots: {}
    })
    await window.api.setLayout({ tabs: [] })
  })
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => document.querySelector('.tab.active .tab-title')?.textContent?.includes('WSL · Ubuntu'))
  await win.locator('button.bar-btn', { hasText: '文件' }).click()
  await win.locator('.explorer:visible .row').first().waitFor()
  const defaultCrumb = (await win.locator('.explorer:visible .breadcrumb').textContent()) ?? ''
  const defaultConnects = await app.evaluate(() => globalThis.__wslExplorerMock.calls.connect)
  check(
    '全局默认 WSL 同样忽略 Windows 默认目录',
    defaultCrumb.includes('/home/ubuntu') && defaultConnects.at(-1)?.cwd === null,
    JSON.stringify({ defaultCrumb, connect: defaultConnects.at(-1) })
  )
} catch (err) {
  failed = true
  console.error('  FAIL WSL 文件面板 mock 执行异常', err)
} finally {
  if (app) await app.close().catch(() => {})
  rmSync(userData, { recursive: true, force: true })
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
