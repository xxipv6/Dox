/**
 * agent watch_stats + 性能监控概览页的端到端验证。
 * 假 nvidia-smi 与真实 agent 二进制放在本次唯一远端临时目录；~/.dox 原内容先备份，
 * 临时 wrapper 只负责把该临时 bin 注入 agent 的 PATH。最外层 finally 关闭应用并恢复原状。
 *
 * 用法：node scripts/verify-agent-stats.mjs [host] [port] [user] [password]
 * 前置：npm run build && node scripts/build-agent.mjs
 */
import { Client } from 'ssh2'
import { createReadStream, mkdirSync } from 'node:fs'
import { withIsolatedElectron } from './lib/electronHarness.mjs'

const host = process.argv[2] ?? 'localhost'
const port = Number(process.argv[3] ?? 2222)
const user = process.argv[4] ?? 'doxtest'
const password = process.argv[5] ?? 'doxtest123'
mkdirSync('shots', { recursive: true })

const ssh = new Client()
await new Promise((resolve, reject) => {
  ssh.on('ready', resolve).on('error', reject).connect({ host, port, username: user, password, readyTimeout: 10000 })
})
const remoteExec = (command) => new Promise((resolve, reject) => {
  ssh.exec(command, (error, stream) => {
    if (error) return reject(error)
    let stdout = ''
    let stderr = ''
    stream.on('data', (data) => { stdout += data })
    stream.stderr.on('data', (data) => { stderr += data })
    stream.on('close', (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(`${command} -> ${code}: ${stderr}`)))
  })
})
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`
const home = (await remoteExec('echo $HOME')).trim()
const backup = `${home}/.dox.dox-stats-backup-${process.pid}-${Date.now()}`
let remoteRoot = ''
let ownsDox = false

const cleanup = async () => {
  if (!remoteRoot) return
  if (ownsDox) {
    await remoteExec(`rm -rf ~/.dox && if [ -e ${quote(backup)} ] || [ -L ${quote(backup)} ]; then mv ${quote(backup)} ~/.dox; fi`)
  }
  await remoteExec(`rm -rf ${quote(remoteRoot)}`)
}

try {
  remoteRoot = (await remoteExec('mktemp -d /tmp/dox-agent-stats.XXXXXX')).trim()
  if (!remoteRoot.startsWith('/tmp/dox-agent-stats.')) throw new Error(`异常远端临时目录：${remoteRoot}`)
  await remoteExec(`if [ -e ~/.dox ] || [ -L ~/.dox ]; then mv ~/.dox ${quote(backup)}; fi`)
  ownsDox = true
  await remoteExec(`mkdir -p ~/.dox ${quote(`${remoteRoot}/bin`)}`)

  const machine = (await remoteExec('uname -m')).trim()
  const goarch = machine === 'x86_64' ? 'amd64' : 'arm64'
  await new Promise((resolve, reject) => {
    ssh.sftp((error, sftp) => {
      if (error) return reject(error)
      const src = createReadStream(`build/agent/dox-agent-linux-${goarch}`)
      const dst = sftp.createWriteStream(`${remoteRoot}/dox-agent`)
      src.on('error', reject)
      dst.on('error', reject)
      dst.on('close', resolve)
      src.pipe(dst)
    })
  })
  const fakeSmi = '#!/bin/sh\necho "NVIDIA DoxTest-9000, 42, 2048, 24576"\n'
  const wrapper = `#!/bin/sh\nPATH=${quote(`${remoteRoot}/bin`)}:"$PATH"\nexport PATH\nexec ${quote(`${remoteRoot}/dox-agent`)} "$@"\n`
  await remoteExec(`printf %s ${quote(fakeSmi)} > ${quote(`${remoteRoot}/bin/nvidia-smi`)} && printf %s ${quote(wrapper)} > ~/.dox/dox-agent && chmod 755 ~/.dox/dox-agent ${quote(`${remoteRoot}/dox-agent`)} ${quote(`${remoteRoot}/bin/nvidia-smi`)}`)
  const versionOut = await remoteExec('~/.dox/dox-agent version')
  const agentReady = /\d+\.\d+\.\d+/.test(versionOut)

  await withIsolatedElectron(async ({ app, win, check }) => {
    check('agent 临时安装完成', agentReady, versionOut)
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
      const hostKey = await win.evaluate(() =>
        [...document.querySelectorAll('.dialog-header')].map((el) => el.textContent.trim()).some((text) => text.includes('主机'))
      )
      if (hostKey) {
        await win.locator('button:has-text("信任并保存")').click()
        break
      }
    }
    await win.locator('.terminal-container:visible').first().click()
    await win.keyboard.press('Escape')

    await win.locator('.terminal-container:visible').first().click({ button: 'right' })
    await win.waitForTimeout(400)
    await win.locator('.context-menu button', { hasText: '性能监控' }).click()
    await win.locator('.mon-panel').waitFor({ timeout: 5000 })
    let coreCount = 0
    for (let i = 0; i < 15 && coreCount === 0; i++) {
      await win.waitForTimeout(1000)
      coreCount = await win.locator('.mon-panel .core-box').count()
    }
    check('概览：每核 CPU 格子出现', coreCount > 0, `cores=${coreCount}`)
    const overviewText = (await win.locator('.mon-panel .page:visible').textContent()) ?? ''
    check('概览含内存条', overviewText.includes('内存'), overviewText.slice(0, 120))
    check('概览含 GPU 占用（假 nvidia-smi）', overviewText.includes('GPU') && overviewText.includes('42%'), overviewText.slice(0, 200))
    const gpuLine = await win.locator('.mon-panel .dim-line', { hasText: 'DoxTest-9000' }).count()
    check('GPU 行含显卡全名与显存', gpuLine >= 1)
    await win.waitForTimeout(3500)
    check('概览持续刷新（后续帧仍在）', (await win.locator('.mon-panel .core-box').count()) > 0)
    await win.screenshot({ path: 'shots/68-agent-stats.png' })
    await app.close()
  }, { prefix: 'dox-agent-stats-' })
} finally {
  try {
    await cleanup()
  } finally {
    ssh.end()
  }
}
