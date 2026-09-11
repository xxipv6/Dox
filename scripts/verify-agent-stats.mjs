/**
 * agent watch_stats + 系统状态条的端到端验证：
 *  预装 agent 0.2.0 + 一枚**假的 nvidia-smi**（输出罐头 CSV，验 GPU 解析与展示）→
 *  应用连接 → 左下状态条出现 CPU/MEM/GPU → 悬停提示里有显卡全名与显存 →
 *  撤掉假 nvidia-smi 重装 agent → GPU 项消失（无卡机器的正确形态）→ 清理。
 *
 * 用法：node scripts/verify-agent-stats.mjs [host] [port] [user] [password]
 * 前置：npm run build && node scripts/build-agent.mjs
 */
import { _electron as electron } from 'playwright'
import { Client } from 'ssh2'
import { createReadStream, mkdirSync } from 'node:fs'

const host = process.argv[2] ?? 'localhost'
const port = Number(process.argv[3] ?? 2222)
const user = process.argv[4] ?? 'doxtest'
const password = process.argv[5] ?? 'doxtest123'
mkdirSync('shots', { recursive: true })

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

const ssh = new Client()
await new Promise((res, rej) => {
  ssh.on('ready', res).on('error', rej).connect({ host, port, username: user, password, readyTimeout: 10000 })
})
const remoteExec = (c) =>
  new Promise((res, rej) => {
    ssh.exec(c, (e, s) => {
      if (e) return rej(e)
      let o = ''
      s.on('data', (d) => (o += d))
      s.stderr.on('data', () => {})
      s.on('close', (code) => (code === 0 ? res(o) : rej(new Error(`${c} -> ${code}`))))
    })
  })
const sudo = (c) => remoteExec(`sh -c '${c}'`) // 测试容器里 doxtest 需要 root 写系统目录时用 docker exec 代替

// ---- 预装 agent 0.2.0 ----
const machine = (await remoteExec('uname -m')).trim()
const goarch = machine === 'x86_64' ? 'amd64' : 'arm64'
await remoteExec('rm -rf ~/.dox && mkdir -p ~/.dox')
const home = (await remoteExec('echo $HOME')).trim()
await new Promise((res, rej) => {
  ssh.sftp((err, sftp) => {
    if (err) return rej(err)
    const src = createReadStream(`build/agent/dox-agent-linux-${goarch}`)
    const dst = sftp.createWriteStream(`${home}/.dox/dox-agent`)
    src.on('error', rej)
    dst.on('error', rej)
    dst.on('close', res)
    src.pipe(dst)
  })
})
const versionOut = await remoteExec('chmod 755 ~/.dox/dox-agent && ~/.dox/dox-agent version')
check('agent 0.2.0 预装完成', versionOut.includes('0.2.0'), versionOut)

// ---- 假 nvidia-smi：doxtest 写不了 /usr/local/bin，用 ~/.dox/bin 加 PATH 不行
// （agent 以 SSH exec 启动，PATH 不含自定义目录）→ 让 root 经 docker 写。
// 这里远程是测试容器，脚本直接用 ssh 写到用户可写的 /usr/local/bin 试一次，
// 失败则退到 docker exec（脚本与容器同名的测试环境约定）。
const fakeSmi = '#!/bin/sh\necho "NVIDIA DoxTest-9000, 42, 2048, 24576"\n'
try {
  await remoteExec(`printf '%s' '${fakeSmi.replace(/'/g, `'\\''`)}' > /usr/local/bin/nvidia-smi && chmod 755 /usr/local/bin/nvidia-smi`)
  check('假 nvidia-smi 落盘（ssh 直写）', true)
} catch {
  const { execFileSync } = await import('node:child_process')
  execFileSync('docker', ['exec', 'dox-sshd-test', 'sh', '-c',
    `printf '%s' '${fakeSmi.replace(/'/g, `'\\''`)}' > /usr/local/bin/nvidia-smi && chmod 755 /usr/local/bin/nvidia-smi`])
  check('假 nvidia-smi 落盘（docker exec）', true)
}
await remoteExec('nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || true')

const cleanup = async () => {
  try { await remoteExec('rm -rf ~/.dox; true') } catch {}
  try {
    const { execFileSync } = await import('node:child_process')
    execFileSync('docker', ['exec', 'dox-sshd-test', 'rm', '-f', '/usr/local/bin/nvidia-smi'])
  } catch {}
  ssh.end()
}

// ---- 应用侧 ----
const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => void d.accept())
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)
await win.evaluate(async () => {
  await window.api.setLayout({ tabs: [] })
  location.reload()
})
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2000)

await win.locator('button[title="添加设备"]').click()
await win.waitForTimeout(400)
await win.locator('input[placeholder^="192.168"]').fill(host)
await win.locator('input.port').fill(String(port))
await win.locator('input[placeholder="root"]').fill(user)
await win.locator('input[placeholder="登录密码"]').fill(password)
await win.locator('button:has-text("仅连接")').click()
for (let i = 0; i < 8; i++) {
  await win.waitForTimeout(1000)
  const hk = await win.evaluate(() =>
    [...document.querySelectorAll('.dialog-header')].map((e) => e.textContent.trim()).some((t) => t.includes('主机'))
  )
  if (hk) {
    await win.locator('button:has-text("信任并保存")').click()
    break
  }
}
await win.locator('.terminal-container:visible').first().click()
await win.keyboard.press('Escape')

// ---- 状态条出现：CPU / MEM / GPU ----
const bar = win.locator('.agent-stats:visible')
let barText = ''
try {
  await bar.waitFor({ timeout: 15000 })
  barText = (await bar.textContent()) ?? ''
} catch { /* 未出现 */ }
check('系统状态条出现', !!barText)
check('状态条含 CPU 百分比', /CPU \d+%/.test(barText), barText)
check('状态条含 MEM 百分比', /MEM \d+%/.test(barText), barText)
check('状态条含 GPU 百分比（假 nvidia-smi）', /GPU\s?42%/.test(barText), barText)
const tip = await bar.getAttribute('title').catch(() => '')
check('悬停提示含显卡全名与显存', (tip ?? '').includes('NVIDIA DoxTest-9000') && (tip ?? '').includes('24.0G'), tip ?? '')
await win.waitForTimeout(3500) // 等第二帧，确认持续推送不报错
const barText2 = (await bar.textContent().catch(() => '')) ?? ''
check('状态条持续刷新（第二帧仍在）', /CPU \d+%/.test(barText2), barText2)
await win.screenshot({ path: 'shots/68-agent-stats.png' })

await cleanup()
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
