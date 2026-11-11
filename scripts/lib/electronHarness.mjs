import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 启动拥有独立 userData 与临时目录的 Electron，并统一收尾和失败汇总。
 * 回调里的 check/pageerror/异常都会变成非零退出码；不在进程级吞异步异常。
 */
export async function withIsolatedElectron(run, options = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), options.prefix ?? 'dox-electron-'))
  const userData = join(tempDir, 'user-data')
  const home = join(tempDir, 'home')
  const env = { ...process.env, ...options.env }
  if (options.isolateHome) {
    mkdirSync(home, { recursive: true })
    env.HOME = home
    env.USERPROFILE = home
    env.APPDATA = join(home, 'AppData', 'Roaming')
    env.LOCALAPPDATA = join(home, 'AppData', 'Local')
  }
  const failures = []
  const apps = new Set()
  let currentApp
  let currentWindow

  const fail = (name, detail = '') => {
    failures.push({ name, detail })
    console.log(`  FAIL ${name}${detail ? ` ${detail}` : ''}`)
  }
  const check = (name, condition, detail = '') => {
    if (condition) console.log(`  ok  ${name}`)
    else fail(name, detail)
    return !!condition
  }
  const observe = (win) => {
    win.on('pageerror', (error) => fail('渲染层 pageerror', error.message))
    if (options.acceptDialogs !== false) {
      win.on('dialog', (dialog) => void dialog.accept())
    }
  }
  const launch = async (extra = {}) => {
    const app = await electron.launch({
      ...extra,
      args: ['.', `--user-data-dir=${userData}`, ...(options.args ?? []), ...(extra.args ?? [])],
      cwd: extra.cwd ?? options.cwd ?? process.cwd(),
      env: { ...env, ...extra.env }
    })
    apps.add(app)
    app.once('close', () => apps.delete(app))
    const win = await app.firstWindow()
    observe(win)
    await win.waitForLoadState('domcontentloaded')
    currentApp = app
    currentWindow = win
    return { app, win }
  }
  const close = async () => {
    for (const app of [...apps]) {
      try {
        await app.close()
      } catch (error) {
        fail('Electron 关闭失败', error instanceof Error ? error.message : String(error))
      }
    }
    apps.clear()
  }

  const context = {
    check,
    tempDir,
    userData,
    home,
    env,
    launch,
    restart: async () => {
      await close()
      return launch()
    },
    close,
    get app() { return currentApp },
    get win() { return currentWindow },
    failures
  }

  try {
    await launch()
    await run(context)
  } catch (error) {
    fail('验证过程未抛错', error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    await close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch (error) {
      fail('隔离临时目录清理失败', error instanceof Error ? error.message : String(error))
    }
  }

  if (failures.length) {
    console.log(`\n结论: ${failures.length} 个失败项`)
    process.exitCode = 1
  } else {
    console.log('\n结论: 全部通过')
  }
}
