/**
 * 本机 WSL 侧栏端到端回归（mock IPC，不要求测试机安装 WSL）。
 * 覆盖：加载/状态/默认徽标、多发行版启动、默认 Shell 不污染、分屏、
 * 真正刷新、空态，以及布局保存/恢复。
 *
 * 用法：npm run build && node scripts/verify-wsl-sidebar.mjs
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

const CMD = { id: 'cmd', name: '命令提示符 (cmd)', integrated: false, integration: 'cmd' }
const UBUNTU = {
  id: 'wsl:Ubuntu',
  name: 'WSL · Ubuntu',
  integrated: false,
  integration: 'none',
  wsl: { distro: 'Ubuntu', isDefault: true, state: 'running' }
}
const DEBIAN = {
  id: 'wsl:Debian',
  name: 'WSL · Debian',
  integrated: false,
  integration: 'none',
  wsl: { distro: 'Debian', isDefault: false, state: 'stopped' }
}
const CUSTOM = {
  id: 'wsl:Custom Linux',
  name: 'WSL · Custom Linux',
  integrated: false,
  integration: 'none',
  wsl: { distro: 'Custom Linux', state: 'unknown' }
}

const userData = mkdtempSync(join(tmpdir(), 'dox-wsl-sidebar-'))
let app
try {
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: process.cwd() })
  const win = await app.firstWindow()
  win.on('pageerror', (err) => console.log(`  [渲染层报错] ${err.message}`))
  await win.waitForLoadState('domcontentloaded')

  // 只替换外部 IPC 边界，Vue 侧栏、session store、preload 和布局仍走真实代码。
  await app.evaluate(
    ({ ipcMain }, fixture) => {
      globalThis.__wslTest = {
        shells: fixture,
        listDelay: 1200,
        listCalls: [],
        connectCalls: []
      }
      ipcMain.removeHandler('local:listShells')
      ipcMain.handle('local:listShells', (_event, forceRefresh) => {
        const test = globalThis.__wslTest
        test.listCalls.push({ forceRefresh: !!forceRefresh })
        return new Promise((resolve) => setTimeout(() => resolve(test.shells), test.listDelay))
      })
      ipcMain.removeHandler('local:connect')
      ipcMain.handle('local:connect', (_event, term, shellId, cwd) => {
        const test = globalThis.__wslTest
        test.connectCalls.push({ shellId: shellId ?? null, cwd: cwd ?? null, term })
        return `local-test-${test.connectCalls.length}`
      })
    },
    [CMD, UBUNTU, DEBIAN, CUSTOM]
  )

  await win.evaluate(() => window.api.setLayout({ tabs: [] }))
  await win.reload()
  await win.waitForLoadState('domcontentloaded')

  const rows = win.locator('.wsl-row')
  await win.waitForSelector('text=正在发现 WSL 发行版…', { timeout: 10000 })
  check('首次延迟列表显示 loading', true)
  await win.waitForFunction(() => document.querySelectorAll('.wsl-row').length === 3, undefined, {
    timeout: 15000
  })
  check('侧栏列出多个 WSL 发行版', (await rows.count()) === 3)
  check('默认发行版徽标只有一个', (await win.locator('.wsl-default').count()) === 1)
  const states = await win.locator('.wsl-state').allTextContents()
  check(
    'running/stopped/unknown 状态都呈现',
    states.join('|') === '后台运行|未运行|状态未知',
    states.join('|')
  )

  const initialCalls = await app.evaluate(() => globalThis.__wslTest.connectCalls)
  const defaultShellId = initialCalls.at(-1)?.shellId ?? null
  const settingsBefore = await win.evaluate(() => window.api.getSettings())
  await app.evaluate(() => {
    globalThis.__wslTest.connectCalls = []
    globalThis.__wslTest.listDelay = 0
  })

  const debianRow = rows.filter({ hasText: 'Debian' })
  await debianRow.click()
  await win.waitForTimeout(300)
  let calls = await app.evaluate(() => globalThis.__wslTest.connectCalls)
  check('单击只选中，不打开终端', calls.length === 0 && (await debianRow.getAttribute('class'))?.includes('selected'))

  await debianRow.click({ button: 'right' })
  const wslMenuText = (await win.locator('.context-menu').textContent()) ?? ''
  check(
    '右键选中并显示实用操作（无打开文件）',
    (await debianRow.getAttribute('class'))?.includes('selected') &&
      wslMenuText.includes('打开终端') &&
      wslMenuText.includes('复制发行版名称') &&
      wslMenuText.includes('刷新状态') &&
      !wslMenuText.includes('打开文件'),
    wslMenuText
  )
  await win.keyboard.press('Escape')
  await debianRow.dblclick()
  await win.waitForFunction(() => document.querySelectorAll('.tab').length === 2)
  calls = await app.evaluate(() => globalThis.__wslTest.connectCalls)
  check('点击 Debian 传递 wsl:Debian', calls.at(-1)?.shellId === 'wsl:Debian', JSON.stringify(calls))
  await win.waitForTimeout(700)
  const autoListCalls = await app.evaluate(() => globalThis.__wslTest.listCalls)
  check('打开 WSL 标签后自动刷新后台状态', autoListCalls.at(-1)?.forceRefresh === true)

  await rows.filter({ hasText: 'Ubuntu' }).click({ button: 'right' })
  await win.locator('.context-menu .menu-item').filter({ hasText: '打开终端' }).click()
  await win.waitForFunction(() => document.querySelectorAll('.tab').length === 3)
  calls = await app.evaluate(() => globalThis.__wslTest.connectCalls)
  check('再点 Ubuntu 不复用上次发行版', calls.at(-1)?.shellId === 'wsl:Ubuntu', JSON.stringify(calls))

  await win.locator('button[title^="向右分屏"]').click()
  await win.waitForTimeout(300)
  calls = await app.evaluate(() => globalThis.__wslTest.connectCalls)
  check('WSL 标签分屏继承原发行版', calls.at(-1)?.shellId === 'wsl:Ubuntu', JSON.stringify(calls.at(-1)))

  await win.locator('.tab-new').click()
  await win.waitForFunction(() => document.querySelectorAll('.tab').length === 4)
  calls = await app.evaluate(() => globalThis.__wslTest.connectCalls)
  check(
    '普通新标签仍使用全局默认 Shell',
    calls.at(-1)?.shellId === defaultShellId,
    `默认=${defaultShellId}，实际=${calls.at(-1)?.shellId}`
  )
  const settingsAfter = await win.evaluate(() => window.api.getSettings())
  check(
    '侧栏点击没有修改持久化设置',
    JSON.stringify(settingsAfter) === JSON.stringify(settingsBefore)
  )

  // 刷新期间旧列表保留；新结果返回后才替换，且 IPC 必须带 forceRefresh。
  // 先让标签事件触发的自动刷新完成，再单独观察这次手动刷新。
  await win.waitForTimeout(700)
  await app.evaluate(() => {
    globalThis.__wslTest.listCalls = []
    globalThis.__wslTest.listDelay = 800
    globalThis.__wslTest.shells = [
      { id: 'cmd', name: '命令提示符 (cmd)', integrated: false, integration: 'cmd' },
      {
        id: 'wsl:Ubuntu',
        name: 'WSL · Ubuntu',
        integrated: false,
        integration: 'none',
        wsl: { distro: 'Ubuntu', isDefault: true, state: 'stopped' }
      }
    ]
  })
  await win.locator('button[title="刷新 WSL 发行版"]').click()
  await win.waitForTimeout(100)
  check('刷新期间保留旧列表', (await rows.count()) === 3)
  check('刷新期间旧列表标记 refreshing', (await win.locator('.wsl-list.refreshing').count()) === 1)
  await win.waitForFunction(() => document.querySelectorAll('.wsl-row').length === 1, undefined, {
    timeout: 10000
  })
  const listCalls = await app.evaluate(() => globalThis.__wslTest.listCalls)
  check('手动刷新传递 forceRefresh=true', listCalls.at(-1)?.forceRefresh === true)

  await app.evaluate(() => {
    globalThis.__wslTest.listDelay = 0
    globalThis.__wslTest.shells = [{ id: 'cmd', name: '命令提示符 (cmd)', integrated: false, integration: 'cmd' }]
  })
  await win.locator('button[title="刷新 WSL 发行版"]').click()
  await win.waitForSelector('.wsl-empty')
  check('没有 WSL 时显示空态且其他界面还在', (await win.locator('.wsl-empty').count()) === 1)

  // 等自动保存防抖结束，检查显式 Shell 覆盖进入快照，再通过真实 restore 路径重载。
  await win.waitForTimeout(1200)
  const snapshot = await win.evaluate(() => window.api.getLayout())
  const wslSnapshotIds = snapshot.tabs.filter((tab) => tab.localShellId).map((tab) => tab.localShellId).sort()
  check(
    '布局快照保存每个 WSL 标签的 Shell',
    JSON.stringify(wslSnapshotIds) === JSON.stringify(['wsl:Debian', 'wsl:Ubuntu']),
    JSON.stringify(snapshot.tabs)
  )

  await app.evaluate(() => {
    globalThis.__wslTest.connectCalls = []
    globalThis.__wslTest.shells = globalThis.__wslTest.shells.length > 1
      ? globalThis.__wslTest.shells
      : [
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
  })
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => document.querySelectorAll('.tab').length === 4, undefined, {
    timeout: 15000
  })
  await win.waitForTimeout(800)
  calls = await app.evaluate(() => globalThis.__wslTest.connectCalls)
  const restoredIds = calls.map((call) => call.shellId)
  check(
    '布局恢复仍进入原发行版（含分屏）',
    restoredIds.filter((id) => id === 'wsl:Debian').length === 1 &&
      restoredIds.filter((id) => id === 'wsl:Ubuntu').length === 2,
    JSON.stringify(restoredIds)
  )

  await app.evaluate(() => {
    globalThis.__wslTest.listCalls = []
  })
  await win.locator('.tab').filter({ hasText: 'WSL · Ubuntu' }).first().click()
  await win.locator('.tab.active .tab-close').click()
  await win.waitForTimeout(700)
  const closeListCalls = await app.evaluate(() => globalThis.__wslTest.listCalls)
  check('关闭 WSL 标签后自动刷新后台状态', closeListCalls.at(-1)?.forceRefresh === true)

  // 老快照没有 localShellId，仍按全局默认恢复。
  await win.evaluate((shellId) =>
    window.api.setLayout({
      tabs: [{ kind: 'local', title: '本地终端', split: 'none', paneCount: 1, active: true }]
    }),
  defaultShellId
  )
  await app.evaluate(() => {
    globalThis.__wslTest.connectCalls = []
  })
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => document.querySelectorAll('.tab').length === 1, undefined, {
    timeout: 15000
  })
  await win.waitForTimeout(300)
  calls = await app.evaluate(() => globalThis.__wslTest.connectCalls)
  check('旧布局快照保持默认 Shell 回退', calls.at(-1)?.shellId === defaultShellId, JSON.stringify(calls))
} catch (err) {
  failed = true
  console.error('  FAIL 端到端执行异常', err)
} finally {
  if (app) await app.close().catch(() => {})
  rmSync(userData, { recursive: true, force: true })
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
