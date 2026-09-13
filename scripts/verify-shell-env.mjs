/**
 * 新开本地终端带「当前环境」端到端：
 *  往只有 resolveShellEnv 抓取路径能看到的地方塞一个测试变量 →
 *  启动 app → 新开本地终端里 echo 这个变量 → 终端里能看到值，
 *  证明 pty 环境混进了新抓的环境（不是只靠 process.env 启动快照）。
 *
 *  - POSIX：造假 $SHELL，只在 'env -0' 抓取路径上 export 变量
 *  - Windows：reg add 进 HKCU\Environment（注册表 = 新进程环境的来源），
 *    app 进程自己的 env 里没有它，终端里能看到只能是注册表读出来的
 *
 * 用法：node scripts/verify-shell-env.mjs
 * 前置：npm run build
 */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync } from 'node:fs'

mkdirSync('shots', { recursive: true })

const WIN = process.platform === 'win32'
const MARKER = WIN ? 'DOX_WINENV_MARKER' : 'DOX_LOGINENV_MARKER'
const VALUE = WIN ? 'from_registry' : 'from_login_shell'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

// ---- 注入测试变量（只在抓取路径可见）----
const fakeDir = path.join(os.tmpdir(), 'dox-shellenv-test')
if (WIN) {
  execFileSync('reg', ['add', 'HKCU\\Environment', '/v', MARKER, '/t', 'REG_SZ', '/d', VALUE, '/f'], {
    stdio: 'ignore'
  })
} else {
  // 假 shell：必须叫 zsh（flavorOf 只认精确文件名），且只在抓取路径注入
  fs.rmSync(fakeDir, { recursive: true, force: true })
  fs.mkdirSync(fakeDir, { recursive: true })
  fs.writeFileSync(
    path.join(fakeDir, 'zsh'),
    `#!/bin/zsh
# 带 'env -0' 参数 = Dox 的 resolveShellEnv 在抓 login 环境，只有这时注入变量；
# 终端标签的交互 shell 不注入 —— 终端里能看到它只能来自 pty 环境（功能本身）
for a in "$@"; do
  case "$a" in
    *"env -0"*) export ${MARKER}=${VALUE} ;;
  esac
done
exec /bin/zsh "$@"
`,
    { mode: 0o755 }
  )
}

try {
  if (WIN) {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath -like '*Dox\\node_modules\\electron*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
      ],
      { stdio: 'ignore' }
    )
  } else {
    execFileSync('pkill', ['-f', 'Dox/node_modules/electron'], { stdio: 'ignore' })
  }
} catch {
  /* 没有正好 */
}

const app = await electron.launch({
  args: ['.'],
  env: WIN ? { ...process.env } : { ...process.env, SHELL: path.join(fakeDir, 'zsh') }
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)
// 读终端文本要走 DOM 渲染器（WebGL 把字画在 canvas 上，.xterm-rows 是空的）。
// 设置存主进程、渲染层 store 只在启动时 load 一次 —— ligatures 必须赶在
// 第一次 reload 之前写，收尾恢复
const origSettings = await win.evaluate(() => window.api.getSettings())
if (origSettings && !origSettings.ligatures) {
  await win.evaluate((s) => window.api.setSettings({ ...s, ligatures: true }), origSettings)
  await win.waitForTimeout(300)
}
await win.evaluate(async () => {
  await window.api.setLayout({ tabs: [] })
  location.reload()
})
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)

try {
  await win.locator('.terminal-container:visible').first().waitFor({ timeout: 15000 })
  await win.waitForTimeout(1500)
  await win.locator('.terminal-container:visible').first().click()
  // cmd 用 %VAR% 展开；POSIX shell 用 $VAR
  await win.keyboard.type(WIN ? `echo [%${MARKER}%]` : `echo "[$${MARKER}]"`)
  await win.keyboard.press('Enter')
  let saw = ''
  for (let i = 0; i < 16; i++) {
    await win.waitForTimeout(500)
    saw = await win.evaluate(
      () => document.querySelector('.tab-content:not([style*="display: none"]) .xterm-rows')?.textContent ?? ''
    )
    if (saw.includes(`[${VALUE}]`)) break
  }
  check('终端拿到新注入的环境变量（非 process.env 快照）', saw.includes(`[${VALUE}]`), saw.slice(-120))
} finally {
  await win.evaluate(() => window.api.setLayout({ tabs: [] })).catch(() => undefined)
  if (origSettings && !origSettings.ligatures) {
    await win
      .evaluate((s) => window.api.setSettings({ ...s, ligatures: false }), origSettings)
      .catch(() => undefined)
  }
  await app.close()
  if (WIN) {
    try {
      execFileSync('reg', ['delete', 'HKCU\\Environment', '/v', MARKER, '/f'], { stdio: 'ignore' })
    } catch {
      /* 没加上正好 */
    }
  } else {
    fs.rmSync(fakeDir, { recursive: true, force: true })
  }
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
