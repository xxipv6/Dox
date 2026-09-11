/**
 * 端口转发建议（检测到服务横幅 → 一键转发）的全套验证：
 *
 *  阶段 1（纯函数，无需参数）：
 *    portSuggest.ts 字节门控/端口提取 + runtime.ts parseInspectIp
 *  阶段 2（端到端，需要一台真实 SSH 主机）：
 *    远端起 nc 监听 → 终端打印服务横幅 → 气泡出现 → 点「转发到本机」
 *    → 规则 active → 本机 nc -z 经转发连通 → 清理（删规则、杀监听）
 *
 * 用法：node scripts/verify-port-suggest.mjs            # 只跑阶段 1
 *      node scripts/verify-port-suggest.mjs <host> [port] [user] [password]
 * 前置（阶段 2）：npm run build；远端需要 nc（busybox 自带）。
 */
import { _electron as electron } from 'playwright'
import { Client } from 'ssh2'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { detectListenPorts, extractPorts, hasListenHint } from '../src/renderer/src/utils/portSuggest.ts'
import { parseInspectIp } from '../src/main/container/runtime.ts'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}
const enc = new TextEncoder()

// ---------- 阶段 1：纯函数 ----------
console.log('阶段 1：portSuggest / parseInspectIp 纯函数')

check('vite 横幅', extractPorts('➜  Local:   http://localhost:5173/').join() === '5173')
check('uvicorn 横幅', extractPorts('Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)').join() === '8000')
check('flask 横幅', extractPorts('* Running on http://127.0.0.1:5000').join() === '5000')
check('rails 0.0.0.0', extractPorts('Listening on http://0.0.0.0:3000').join() === '3000')
check('同块多端口', extractPorts('a localhost:3000 b 127.0.0.1:8000').join() === '3000,8000')
check('同端口去重', extractPorts('localhost:3000 localhost:3000').join() === '3000')
check('22 被拒之门外', extractPorts('localhost:22').join() === '')
check('超范围端口被拒', extractPorts('localhost:99999').join() === '')
check('无 host 字样不报（防日志数字误报）', extractPorts('Listening on port 3000').join() === '')
check('含提示字样才解码', hasListenHint(enc.encode('xx localhost:3000')) === true)
check('二进制无提示直接跳过', hasListenHint(new Uint8Array([1, 2, 3, 0x18, 4])) === false)
check('detectListenPorts 组合', detectListenPorts(enc.encode('Serving http://0.0.0.0:9000')).join() === '9000')

check('inspect 单网络', parseInspectIp('[{"NetworkSettings":{"Networks":{"bridge":{"IPAddress":"172.17.0.3"}}}}]') === '172.17.0.3')
check(
  'inspect 多网络取第一个有效',
  parseInspectIp('[{"NetworkSettings":{"Networks":{"a":{"IPAddress":""},"b":{"IPAddress":"10.5.0.9"}}}}]') === '10.5.0.9'
)
check('inspect host 网络 → null', parseInspectIp('[{"NetworkSettings":{"Networks":{"host":{"IPAddress":""}}}}]') === null)
check('inspect 畸形输出 → null', parseInspectIp('not json at all') === null)

// ---------- 阶段 2：端到端 ----------
const host = process.argv[2]
if (!host) {
  console.log('\n（未给主机参数，跳过阶段 2 端到端）')
  process.exit(failed ? 1 : 0)
}
const port = Number(process.argv[3] ?? 22)
const user = process.argv[4] ?? 'root'
const password = process.argv[5] ?? ''
mkdirSync('shots', { recursive: true })
const SUGGEST_PORT = 8321

console.log('阶段 2：端到端（横幅 → 气泡 → 转发 → 连通）')

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

// 远端真的监听（nc -lk 常驻）
await remoteExec('pkill -f "nc -lk" 2>/dev/null; true').catch(() => {})
ssh.exec(`nc -lk -p ${SUGGEST_PORT}`, () => {})
await new Promise((r) => setTimeout(r, 800))
await remoteExec(`nc -z 127.0.0.1 ${SUGGEST_PORT}`)
check('远端 nc 监听就绪', true)

const cleanup = async () => {
  try { await remoteExec('pkill -f "nc -lk" || true') } catch {}
  ssh.end()
}

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

// 打印服务横幅（uvicorn 风格）。连接刚建立时头几个字可能被吃（老坑），
// 气泡没出现就重打，最多 3 次
const toast = win.locator('.port-toast').filter({ hasText: String(SUGGEST_PORT) }).first()
let toastOk = false
for (let attempt = 0; attempt < 3 && !toastOk; attempt++) {
  await win.locator('.terminal-container:visible').first().click()
  await win.waitForTimeout(600)
  await win.keyboard.type(`echo "Uvicorn running on http://127.0.0.1:${SUGGEST_PORT} (Press CTRL+C to quit)"`, { delay: 40 })
  await win.keyboard.press('Enter')
  try {
    await toast.waitFor({ timeout: 8000 })
    toastOk = true
  } catch {
    /* 重打 */
  }
}
check('横幅触发建议气泡', toastOk)
await win.screenshot({ path: 'shots/61-port-suggest-toast.png' })

// 同端口不重复弹（再打印一次，气泡仍只有一个）
await win.keyboard.type(`echo "Uvicorn running on http://127.0.0.1:${SUGGEST_PORT} (Press CTRL+C to quit)"`, { delay: 40 })
await win.keyboard.press('Enter')
await win.waitForTimeout(1500)
check('同端口不重复建议', (await win.locator('.port-toast').count()) === 1)

// 点「转发到本机」→ 变成已转发
await toast.locator('button.act', { hasText: '转发到本机' }).click()
await win.waitForFunction(
  async () => (await window.api.listForwards()).some((r) => r.targetPort === 8321 && r.status === 'active'),
  undefined,
  { timeout: 15000 }
).catch(() => {})
const rules = await win.evaluate(() => window.api.listForwards())
const rule = rules.find((r) => r.targetPort === SUGGEST_PORT)
check('转发规则 active', rule?.status === 'active', JSON.stringify(rules))
await win.screenshot({ path: 'shots/61-port-suggest-done.png' })

// 本机经转发真的连通（nc -z）
let reachable = false
if (rule?.status === 'active') {
  for (let i = 0; i < 5; i++) {
    try {
      execFileSync('nc', ['-z', '127.0.0.1', String(rule.listenPort)], { timeout: 3000 })
      reachable = true
      break
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}
check('本机经转发连通远端监听', reachable)

// ---- 清理 ----
if (rule) await win.evaluate((id) => window.api.removeForward(id), rule.id)
await cleanup()
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
