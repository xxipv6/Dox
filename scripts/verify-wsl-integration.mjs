/**
 * 真实 WSL 冒烟：从侧栏分别进入两个已安装发行版，并在真实 PTY 输出里核对身份。
 * 没有 WSL 或不足两个发行版时明确跳过；mock 回归由 verify-wsl-sidebar.mjs 负责。
 *
 * 用法：npm run build && node scripts/verify-wsl-integration.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

if (process.platform !== 'win32') {
  console.log('非 Windows，跳过真实 WSL 冒烟')
  process.exit(0)
}

const listed = spawnSync('wsl.exe', ['-l', '-q'], { encoding: null })
const decode = (buffer) => (buffer ?? Buffer.alloc(0)).toString('utf16le').replace(/\0/g, '')
const distros = listed.status === 0
  ? decode(listed.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  : []
if (distros.length < 2) {
  console.log(`只发现 ${distros.length} 个 WSL 发行版，跳过真实多发行版冒烟`)
  process.exit(0)
}
const selected = distros.slice(0, 2)
console.log(`真实发行版：${selected.join('、')}`)
mkdirSync('shots', { recursive: true })
const shotStamp = Date.now()
const initialShot = `shots/wsl-real-${shotStamp}-initial.png`
const refreshedShot = `shots/wsl-real-${shotStamp}-refreshed.png`

const userData = mkdtempSync(join(tmpdir(), 'dox-wsl-real-'))
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
  await win.screenshot({ path: initialShot })
  console.log(`  初始截图：${initialShot}`)

  await win.evaluate(() => {
    globalThis.__realWslOutput = {}
    window.api.onData((id, chunk) => {
      const text = new TextDecoder().decode(chunk)
      globalThis.__realWslOutput[id] = (globalThis.__realWslOutput[id] ?? '') + text
    })
  })

  for (const distro of selected) {
    const knownIds = await win.evaluate(() => Object.keys(globalThis.__realWslOutput ?? {}))
    await win.locator('.wsl-row').filter({ hasText: distro }).first().dblclick()
    // 等 Vue 真正把新标签切到前台；否则下面的 :visible 可能还是上一个 cmd 终端。
    await win.waitForFunction(
      (expected) => document.querySelector('.tab.active .tab-title')?.textContent?.includes(expected),
      distro,
      { timeout: 15000 }
    )
    // 等新 PTY 的第一段输出（通常是提示符）再输入，避免慢启动时按键落在初始化阶段。
    await win.waitForFunction(
      (ids) => Object.keys(globalThis.__realWslOutput ?? {}).some((id) => !ids.includes(id)),
      knownIds,
      { timeout: 30000 }
    )
    const input = win.locator('.tab-content:visible .xterm-helper-textarea').first()
    await input.waitFor({ state: 'visible', timeout: 30000 })
    await input.click()
    // 命令回显里是 %s，只有真实 shell 的 printf 输出才会包含完整发行版标记。
    await win.keyboard.type("printf '\\nDOXREAL_%s_END\\n' \"$WSL_DISTRO_NAME\"")
    await win.keyboard.press('Enter')
    await win.waitForFunction(
      (expected) => Object.values(globalThis.__realWslOutput ?? {}).some((text) => text.includes(expected)),
      `DOXREAL_${distro}_END`,
      { timeout: 30000 }
    )
    check(`侧栏真实进入 ${distro}`, true)

    // 进入后手动刷新应重新执行 wsl -l -v，并把该发行版更新为运行中。
    await win.locator('button[title="刷新 WSL 发行版"]').click()
    await win.waitForFunction(
      (expected) => {
        const row = [...document.querySelectorAll('.wsl-row')].find(
          (el) => el.querySelector('.wsl-name')?.textContent?.trim() === expected
        )
        return row?.querySelector('.wsl-state')?.textContent?.trim() === '后台运行'
      },
      distro,
      { timeout: 20000 }
    )
    check(`刷新后 ${distro} 显示后台运行`, true)
  }

  await win.screenshot({ path: refreshedShot })
  console.log(`  刷新后截图：${refreshedShot}`)

  const before = await win.evaluate(() => window.api.getSettings())
  await win.locator('.tab-new').click()
  await win.waitForTimeout(500)
  const after = await win.evaluate(() => window.api.getSettings())
  check('真实打开 WSL 后设置仍未被修改', JSON.stringify(before) === JSON.stringify(after))
} catch (err) {
  failed = true
  console.error('  FAIL 真实 WSL 冒烟异常', err)
  if (win) {
    const debug = await win.evaluate(() => ({
      active: document.querySelector('.tab.active .tab-title')?.textContent ?? null,
      outputs: Object.fromEntries(
        Object.entries(globalThis.__realWslOutput ?? {}).map(([id, text]) => [id, text.slice(-1600)])
      )
    })).catch(() => null)
    if (debug) console.error('  调试输出', JSON.stringify(debug))
  }
} finally {
  if (app) await app.close().catch(() => {})
  rmSync(userData, { recursive: true, force: true })
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
