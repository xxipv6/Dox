/**
 * /proc 静默监听发现（端口转发建议的完全体）验证：
 *
 *  阶段 1（纯函数）：procNet.ts 的 /proc/net/tcp{,6} 解析
 *  阶段 2（端到端）：
 *    连接前已在监听的端口 = 基线 → **不弹**（防轰炸）；
 *    连接后静默起的 nc（不打任何横幅）→ 5s 级轮询差分 → 气泡 →
 *    转发 → 本机 nc -z 连通 → 清理
 *
 * 用法：node scripts/verify-port-watch.mjs            # 只跑阶段 1
 *      node scripts/verify-port-watch.mjs <host> [port] [user] [password]
 * 前置（阶段 2）：npm run build；远端需要 nc（busybox 自带）。
 */
import { _electron as electron } from 'playwright'
import { Client } from 'ssh2'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { parseProcNetTcp, procListenCommand } from '../src/main/ssh/procNet.ts'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

// ---------- 阶段 1：纯函数 ----------
console.log('阶段 1：procNet 纯函数')

const SAMPLE_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0
   1: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 23456 1 0000000000000000 100 0 0 10 5
   2: 0100007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 34567 1 0000000000000000 20 0 0 10 -1`
const SAMPLE_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 45678 1 0000000000000000 100 0 0 10 0`

const parsed = parseProcNetTcp(SAMPLE_TCP)
check('LISTEN 端口被解析（0x1F90=8080, 0x50=80）', parsed.join() === '80,8080', parsed.join())
check('ESTABLISHED（st=01）被跳过', !parsed.includes(50000))
check('tcp6 双栈同端口去重', parseProcNetTcp(SAMPLE_TCP + '\n' + SAMPLE_TCP6).join() === '80,8080')
check('空输出安全', parseProcNetTcp('').join() === '')
check('畸形行跳过', parseProcNetTcp('garbage line\n::::\n' + SAMPLE_TCP).join() === '80,8080')
check('命令走 /bin/sh -c 且无单引号内嵌', procListenCommand().startsWith("/bin/sh -c '") && !procListenCommand().slice(12, -1).includes("'"))

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
const BASELINE_PORT = 8322 // 连接前就在听：应进基线，不弹
const FRESH_PORT = 8323 // 连接后静默起：应被差分发现

console.log('阶段 2：端到端（基线抑制 + 静默发现）')

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

await remoteExec('pkill -f "nc -lk" 2>/dev/null; true').catch(() => {})
ssh.exec(`nc -lk -p ${BASELINE_PORT}`, () => {})
await new Promise((r) => setTimeout(r, 800))
await remoteExec(`nc -z 127.0.0.1 ${BASELINE_PORT}`)
check('基线端口监听就绪（连接前）', true)

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

// 基线抑制：等两轮轮询（5s × 2 + 余量），基线端口不得弹气泡
await win.waitForTimeout(13000)
check(
  '连接前已在监听的端口不弹（基线抑制）',
  (await win.locator('.port-toast').filter({ hasText: String(BASELINE_PORT) }).count()) === 0
)

// 静默起一个新监听（不打横幅），等差分发现
ssh.exec(`nc -lk -p ${FRESH_PORT}`, () => {})
await new Promise((r) => setTimeout(r, 500))
const toast = win.locator('.port-toast').filter({ hasText: String(FRESH_PORT) }).first()
let found = true
try {
  await toast.waitFor({ timeout: 12000 })
} catch {
  found = false
}
check('静默监听被 /proc 差分发现（无横幅）', found)
await win.screenshot({ path: 'shots/62-port-watch-toast.png' })

// 点转发 → 规则 active → 本机连通
await toast.locator('button.act', { hasText: '转发到本机' }).click()
await win.waitForTimeout(3000)
const rules = await win.evaluate(() => window.api.listForwards())
const rule = rules.find((r) => r.targetPort === FRESH_PORT && r.status === 'active')
check('转发规则 active', !!rule, JSON.stringify(rules))

let reachable = false
if (rule) {
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
check('本机经转发连通静默监听', reachable)

// ---- 清理 ----
if (rule) await win.evaluate((id) => window.api.removeForward(id), rule.id)
await cleanup()
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
