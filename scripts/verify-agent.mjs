/**
 * dox-agent v1 全套验证：
 *  阶段 1：go test（agent 解析单测）+ 交叉编译产物存在且可执行
 *  阶段 2（端到端，需要一台真实 SSH 主机）：
 *    UI 点「安装到这台机器」→ 远端二进制 version 校验 →
 *    serve 握手（hello → version/pid）→ watch_ports 事件抓到新起的 nc 监听 → stop
 *  结束清理：删除远端 ~/.dox（测试机回到未安装状态）
 *
 * 用法：node scripts/verify-agent.mjs <host> [port] [user] [password]
 * 前置：npm run build && node scripts/build-agent.mjs
 */
import { _electron as electron } from 'playwright'
import { Client } from 'ssh2'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdirSync } from 'node:fs'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

// ---------- 阶段 1 ----------
console.log('阶段 1：go test + 构建产物')
const goTest = execFileSync('go', ['test', './...'], { cwd: 'agent', encoding: 'utf8' })
check('go test 通过', goTest.includes('ok'))
check(
  '两个平台二进制齐备',
  existsSync('build/agent/dox-agent-linux-amd64') && existsSync('build/agent/dox-agent-linux-arm64')
)

// ---------- 阶段 2 ----------
const host = process.argv[2]
if (!host) {
  console.log('\n（未给主机参数，跳过阶段 2 端到端）')
  process.exit(failed ? 1 : 0)
}
const port = Number(process.argv[3] ?? 22)
const user = process.argv[4] ?? 'root'
const password = process.argv[5] ?? ''
mkdirSync('shots', { recursive: true })
const WATCH_PORT = 8327

console.log('阶段 2：端到端（安装 → 握手 → 端口事件）')

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

// 起点：未安装状态
await remoteExec('rm -rf ~/.dox; pkill -f "nc -lk" 2>/dev/null; true').catch(() => {})

// ---- 应用侧：连接并安装 ----
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
await win.waitForTimeout(1500)
await win.keyboard.press('Escape')

// 展开「远程助手」分区
const sectionHead = win.locator('.sidebar .section-head', { hasText: '助手' })
await sectionHead.waitFor({ timeout: 10000 })
if ((await sectionHead.getAttribute('aria-expanded')) === 'false') {
  await sectionHead.click()
  await win.waitForTimeout(600)
}
// 未安装态：描述 + 按钮
await win.locator('.agent-desc').first().waitFor({ timeout: 10000 })
check('未安装态显示说明与按钮', (await win.locator('button:has-text("安装到这台机器")').count()) === 1)
await win.screenshot({ path: 'shots/64-agent-not-installed.png' })

await win.locator('button:has-text("安装到这台机器")').click()
// 等已安装态出现
let installed = false
for (let i = 0; i < 30; i++) {
  await win.waitForTimeout(1000)
  const ok = await win.evaluate(() => document.querySelector('.agent-ok')?.textContent ?? '')
  if (ok.includes('已安装')) {
    installed = true
    break
  }
  const err = await win.evaluate(() => document.querySelector('.form-error')?.textContent ?? '')
  if (err) {
    console.log('  安装报错:', err)
    break
  }
}
check('UI 安装成功（已安装态）', installed)
await win.screenshot({ path: 'shots/64-agent-installed.png' })

// 远端二进制 version 自检
const verLine = (await remoteExec('~/.dox/dox-agent version')).trim()
check('远端 version 输出合法 JSON', verLine.includes('"dox-agent"') && verLine.includes('"version"'), verLine)

// ---- serve 协议：hello + watch_ports + stop（脚本直连，不经 UI）----
const serveResult = await new Promise((resolve) => {
  const events = []
  const responses = []
  let helloOk = false
  ssh.exec('~/.dox/dox-agent serve', (err, stream) => {
    if (err) return resolve({ helloOk: false, events, responses })
    let buf = ''
    stream.on('data', (d) => {
      buf += d
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        try {
          const msg = JSON.parse(line)
          if (msg.event) events.push(msg)
          else responses.push(msg)
          if (msg.result?.agent === 'dox-agent') helloOk = true
        } catch { /* 半行 */ }
      }
    })
    // hello → watch_ports → 起 nc → 等事件 → stop
    stream.write('{"id":1,"method":"hello","params":{}}\n')
    setTimeout(() => {
      stream.write('{"id":2,"method":"watch_ports","params":{"interval_ms":1000}}\n')
    }, 300)
    setTimeout(() => {
      ssh.exec(`nc -lk -p ${WATCH_PORT}`, () => {})
    }, 1000)
    setTimeout(() => {
      stream.write('{"id":3,"method":"stop"}\n')
    }, 5000)
    setTimeout(() => {
      stream.close()
      resolve({ helloOk, events, responses })
    }, 6500)
  })
})
check('serve hello 握手返回 version/pid', serveResult.helloOk)
const portEvents = serveResult.events.filter((e) => e.event === 'ports')
check(
  'watch_ports 事件抓到新监听（含 added 8327）',
  portEvents.some((e) => (e.data?.added ?? []).includes(WATCH_PORT)),
  JSON.stringify(portEvents.map((e) => e.data))
)

// ---- 清理：回到未安装状态 ----
await remoteExec('pkill -f "nc -lk" 2>/dev/null; rm -rf ~/.dox; true').catch(() => {})
ssh.end()
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
