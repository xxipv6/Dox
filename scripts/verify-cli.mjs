/**
 * CLI 伴侣（dox 命令，--cli 参数经单实例锁转发）端到端：
 *  A. 第二个进程带 --cli local --cwd 启动 → 单实例转发 → 第一个窗口开出新标签且落在该目录
 *  B. --cli connect --target user@host:port（无库存设备）→ 预填添加设备表单
 *  C. cliInstall 真装一遍 → 脚本存在、可执行、内容是 --cli 壳（测完清理）
 *
 * 用法：node scripts/verify-cli.mjs
 * 前置：npm run build。应用、CLI 文件和 HOME/LOCALAPPDATA 均隔离；Windows 用户 PATH
 * 仍需走真实安装路径，但在最外层 finally 按原类型/原值恢复。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { withIsolatedElectron } from './lib/electronHarness.mjs'

fs.mkdirSync('shots', { recursive: true })
const ELECTRON = createRequire(import.meta.url)('electron')

const readUserPath = () => {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true
    })
    const match = out.match(/^\s*Path\s+(REG_(?:EXPAND_)?SZ)\s?(.*)$/m)
    return match ? { exists: true, type: match[1], value: (match[2] ?? '').replace(/\r$/, '') } : { exists: false }
  } catch (error) {
    throw new Error(`无法备份 HKCU\\Environment，拒绝继续真实 CLI 安装：${error instanceof Error ? error.message : String(error)}`)
  }
}
const broadcastEnvironmentChange = () => {
  execFileSync('powershell', ['-NoProfile', '-Command',
    'Add-Type -Namespace W -Name S -MemberDefinition ' +
    '\'[System.Runtime.InteropServices.DllImport("user32.dll",CharSet=System.Runtime.InteropServices.CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr h,uint m,System.UIntPtr w,string l,uint f,uint t,out System.UIntPtr r);\';' +
    '$r=[System.UIntPtr]::Zero;[W.S]::SendMessageTimeout([System.IntPtr]0xffff,0x1A,[System.UIntPtr]::Zero,"Environment",2,5000,[ref]$r) | Out-Null'
  ], { stdio: 'ignore', windowsHide: true })
}
const originalPath = process.platform === 'win32' ? readUserPath() : null
const posixTarget = '/usr/local/bin/dox'
const originalPosix = process.platform !== 'win32' && fs.existsSync(posixTarget)
  ? { content: fs.readFileSync(posixTarget), mode: fs.statSync(posixTarget).mode }
  : null

const restoreEnvironment = () => {
  if (process.platform === 'win32') {
    if (originalPath?.exists) {
      execFileSync('reg', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', originalPath.type,
        '/d', originalPath.value, '/f'], { stdio: 'ignore', windowsHide: true })
      const restored = readUserPath()
      if (!restored.exists || restored.type !== originalPath.type || restored.value !== originalPath.value) {
        throw new Error('Windows 用户 PATH 恢复后校验不一致')
      }
    } else {
      try {
        execFileSync('reg', ['delete', 'HKCU\\Environment', '/v', 'Path', '/f'],
          { stdio: 'ignore', windowsHide: true })
      } catch (error) {
        if (readUserPath().exists) throw error
      }
    }
    broadcastEnvironmentChange()
  } else if (originalPosix) {
    fs.writeFileSync(posixTarget, originalPosix.content, { mode: originalPosix.mode })
    fs.chmodSync(posixTarget, originalPosix.mode)
  } else {
    fs.rmSync(posixTarget, { force: true })
  }
}

try {
  await withIsolatedElectron(async ({ win, check, tempDir, userData, env }) => {
    const markerDir = path.join(tempDir, 'cwd-marker')
    fs.mkdirSync(markerDir, { recursive: true })
    const fireCli = (...args) => {
      execFileSync(ELECTRON, ['.', `--user-data-dir=${userData}`, ...args], {
        stdio: 'ignore', timeout: 20000, env
      })
    }

    await win.waitForTimeout(1200)
    await win.evaluate(async () => {
      await window.api.setLayout({ tabs: [] })
      location.reload()
    })
    await win.waitForLoadState('domcontentloaded')
    await win.waitForTimeout(2500)

    // ---- A. --cli local --cwd <标记目录> → 新标签落在该目录 ----
    fireCli('--cli=local', `--cwd=${markerDir}`)
    await win.waitForTimeout(2000)
    const tabCount = await win.locator('.tab').count()
    check('深链开出新标签', tabCount >= 2, `tabs=${tabCount}`)
    let fellIntoTmp = false
    for (let i = 0; i < 10; i++) {
      const active = (await win.locator('.tab.active').textContent()) ?? ''
      if (active.includes('cwd-marker')) { fellIntoTmp = true; break }
      await win.waitForTimeout(500)
    }
    check('新标签落在 CLI 指定目录', fellIntoTmp, (await win.locator('.tab.active').textContent()) ?? '')

    // ---- B. --cli connect --target doxtest@localhost:2222 → 预填表单 ----
    fireCli('--cli=connect', '--target=doxtest@localhost:2222')
    await win.waitForTimeout(1500)
    const hostVal = await win.locator('input[placeholder^="192.168"]').inputValue().catch(() => '')
    const portVal = await win.locator('input.port').inputValue().catch(() => '')
    const userVal = await win.locator('input[placeholder="root"]').inputValue().catch(() => '')
    check('connect 深链预填表单', hostVal === 'localhost' && portVal === '2222' && userVal === 'doxtest',
      `host=${hostVal} port=${portVal} user=${userVal}`)
    await win.keyboard.press('Escape')
    await win.screenshot({ path: 'shots/96-cli-deeplink.png' })

    // ---- C. cliInstall：文件落在隔离 HOME/LOCALAPPDATA；系统 PATH 由外层恢复 ----
    const res = await win.evaluate(() => window.api.cliInstall())
    check('dox 命令安装成功', !!res?.path && fs.existsSync(res.path), JSON.stringify(res))
    if (res?.path && fs.existsSync(res.path)) {
      const st = fs.statSync(res.path)
      const content = fs.readFileSync(res.path, 'utf8')
      check('脚本可执行', process.platform === 'win32' ? res.path.endsWith('.cmd') : (st.mode & 0o111) !== 0, res.path)
      check('脚本是 --cli 壳', content.includes('--cli=local') && content.includes('--cwd=') && content.includes('--cli=connect'))
    }
  }, { isolateHome: true, prefix: 'dox-cli-' })
} finally {
  restoreEnvironment()
}
