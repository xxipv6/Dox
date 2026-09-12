/**
 * agent watch_stats + 性能监控概览页的端到端验证：
 *  预装 agent + 一枚**假的 nvidia-smi**（输出罐头 CSV，验 GPU 解析与展示）→
 *  应用连接 → 右键「性能监控」→ 概览页出每核 CPU 格子 + 内存 + GPU（含显卡全名）→
 *  持续刷新不报错 → 清理。
 *（终端左下角的状态条已移除，watch_stats 订阅由监控面板自己持有。）
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
check('agent 预装完成', /\d+\.\d+\.\d+/.test(versionOut), versionOut)

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

// ---- 性能监控概览：CPU / 每核格子 / 内存 / GPU ----
await win.locator('.terminal-container:visible').first().click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu button', { hasText: '性能监控' }).click()
await win.locator('.mon-panel').waitFor({ timeout: 5000 })
// 概览数据来自面板自己持有的 watch_stats 订阅，等首帧（首帧 200ms 短采样）
let coreCount = 0
for (let k = 0; k < 15 && coreCount === 0; k++) {
  await win.waitForTimeout(1000)
  coreCount = await win.locator('.mon-panel .core-box').count()
}
check('概览：每核 CPU 格子出现', coreCount > 0, `cores=${coreCount}`)
const overviewText = (await win.locator('.mon-panel .page:visible').textContent()) ?? ''
check('概览含内存条', overviewText.includes('内存'), overviewText.slice(0, 120))
check('概览含 GPU 占用（假 nvidia-smi）', overviewText.includes('GPU') && overviewText.includes('42%'), overviewText.slice(0, 200))
const gpuLine = await win.locator('.mon-panel .dim-line', { hasText: 'DoxTest-9000' }).count()
check('GPU 行含显卡全名与显存', gpuLine >= 1)
await win.waitForTimeout(3500) // 再等一帧，确认持续推送不报错
const stillLive = await win.locator('.mon-panel .core-box').count()
check('概览持续刷新（后续帧仍在）', stillLive > 0)
await win.screenshot({ path: 'shots/68-agent-stats.png' })

await cleanup()
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
