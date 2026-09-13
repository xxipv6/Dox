/**
 * login shell 环境解析端到端：
 *  造一个假 $SHELL（只在 resolveShellEnv 的抓取路径上注入测试变量）→
 *  启动 app → 新开本地终端里 echo 这个变量 → 终端里能看到值，
 *  证明 pty 环境混进了 login shell 的环境（不是只靠 process.env 快照）。
 *
 * 用法：node scripts/verify-shell-env.mjs
 * 前置：npm run build
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync } from 'node:fs'

mkdirSync('shots', { recursive: true })

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

// ---- 假 shell：必须叫 zsh（flavorOf 只认精确文件名），且只在抓取路径注入 ----
const fakeDir = path.join(os.tmpdir(), 'dox-shellenv-test')
fs.rmSync(fakeDir, { recursive: true, force: true })
fs.mkdirSync(fakeDir, { recursive: true })
const fakeShell = path.join(fakeDir, 'zsh')
fs.writeFileSync(
  fakeShell,
  `#!/bin/zsh
# 带 'env -0' 参数 = Dox 的 resolveShellEnv 在抓 login 环境，只有这时注入变量；
# 终端标签的交互 shell 不注入 —— 终端里能看到它只能来自 pty 环境（功能本身）
for a in "$@"; do
  case "$a" in
    *"env -0"*) export DOX_LOGINENV_MARKER=from_login_shell ;;
  esac
done
exec /bin/zsh "$@"
`,
  { mode: 0o755 }
)

try { (await import('node:child_process')).execFileSync('pkill', ['-f', 'Dox/node_modules/electron'], { stdio: 'ignore' }) } catch { /* 没有正好 */ }
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SHELL: fakeShell }
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)
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
  await win.keyboard.type('echo "[$DOX_LOGINENV_MARKER]"')
  await win.keyboard.press('Enter')
  let saw = ''
  for (let i = 0; i < 16; i++) {
    await win.waitForTimeout(500)
    saw = await win.evaluate(
      () => document.querySelector('.tab-content:not([style*="display: none"]) .xterm-rows')?.textContent ?? ''
    )
    if (saw.includes('[from_login_shell]')) break
  }
  check('终端拿到 login shell 注入的环境变量', saw.includes('[from_login_shell]'), saw.slice(-120))
} finally {
  await win.evaluate(() => window.api.setLayout({ tabs: [] })).catch(() => undefined)
  await app.close()
  fs.rmSync(fakeDir, { recursive: true, force: true })
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
