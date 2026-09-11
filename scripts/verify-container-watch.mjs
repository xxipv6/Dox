/**
 * 容器标签静默端口发现的端到端验证：
 *  SSH 连进 dind 测试容器（dox-sshd-test，privileged + dockerd）→
 *  侧栏容器列表右键「进入」inner → 容器标签（无横幅）→
 *  脚本直连在 inner 里静默起 nc → docker exec /proc 差分应在 ~12s 内弹气泡 →
 *  点「转发到本机」（目标 = inner 网桥 IP，docker inspect 解析）→ 本机 nc -z 连通 → 清理。
 *
 * 用法：node scripts/verify-container-watch.mjs [host] [port] [user] [password]
 * 前置：npm run build；dox-sshd-test 里 dockerd 已起、inner（alpine sleep）在跑
 */
import { _electron as electron } from 'playwright'
import { Client } from 'ssh2'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const host = process.argv[2] ?? 'localhost'
const port = Number(process.argv[3] ?? 2222)
const user = process.argv[4] ?? 'doxtest'
const password = process.argv[5] ?? 'doxtest123'
mkdirSync('shots', { recursive: true })
const INNER = 'inner'
const FRESH_PORT = 8350

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

// 测试夹具：inner 在跑且当前没有测试端口的 nc
await remoteExec(`docker start ${INNER} 2>/dev/null || docker run -d --name ${INNER} alpine sleep 600`)
await remoteExec(`docker exec ${INNER} sh -c "pkill nc 2>/dev/null; true"`)
console.log('  夹具就绪：inner 运行中，测试端口空闲')

const cleanup = async () => {
  try { await remoteExec(`docker exec ${INNER} sh -c "pkill nc 2>/dev/null; true"`) } catch {}
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

// ---- SSH 连接（保持宿主机标签激活，容器面板才列远端）----
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
await win.locator('.terminal-container:visible').first().waitFor({ timeout: 20000 })
await win.waitForTimeout(2000)
await win.keyboard.press('Escape')

// ---- 容器列表：展开 → 找到 inner → 右键进入 ----
const sectionHead = win.locator('.sidebar .section-head', { hasText: '容器' })
await sectionHead.waitFor({ timeout: 10000 })
if ((await sectionHead.getAttribute('aria-expanded')) === 'false') {
  await sectionHead.click()
  await win.waitForTimeout(1500)
}
let row = win.locator('.container').filter({ hasText: INNER }).first()
if (!(await row.count())) {
  await win.locator('button[title="刷新容器列表"]').click().catch(() => {})
  await win.waitForTimeout(2000)
}
await row.waitFor({ timeout: 15000 })
await row.click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu .menu-item').filter({ hasText: '进入' }).first().click()

// 容器标签打开（新 tab 激活），等首轮轮询建基线
await win.waitForTimeout(8000)
const tabs = await win.evaluate(() =>
  [...document.querySelectorAll('.tab .tab-title')].map((e) => e.textContent.trim())
)
check('容器标签已打开', tabs.some((t) => t.includes(INNER)), tabs.join(','))

// ---- 静默起 nc（容器内、无横幅），等 docker exec /proc 差分发现 ----
const t0 = Date.now()
ssh.exec(`docker exec -d ${INNER} nc -lk -p ${FRESH_PORT}`, () => {})
const toast = win.locator('.port-toast').filter({ hasText: String(FRESH_PORT) }).first()
let latencyMs = -1
try {
  await toast.waitFor({ timeout: 20000 })
  latencyMs = Date.now() - t0
} catch { /* 未出现 */ }
check('容器内静默监听被 docker exec /proc 差分发现', latencyMs >= 0, `latency=${latencyMs}`)
if (latencyMs >= 0) console.log(`  气泡延迟 ${(latencyMs / 1000).toFixed(1)}s`)
await win.screenshot({ path: 'shots/66-container-watch-toast.png' })

// ---- 转发（目标应为 inner 网桥 IP）→ 本机连通 ----
if (latencyMs >= 0) {
  await toast.locator('button.act', { hasText: '转发到本机' }).click()
  await win.waitForTimeout(3000)
  const rules = await win.evaluate(() => window.api.listForwards())
  const rule = rules.find((r) => r.targetPort === FRESH_PORT && r.status === 'active')
  check('转发规则 active', !!rule, JSON.stringify(rules))
  if (rule) {
    check(
      '转发目标是容器网桥 IP（不是 127.0.0.1）',
      rule.targetHost !== '127.0.0.1',
      rule.targetHost
    )
    let reachable = false
    for (let i = 0; i < 5; i++) {
      try {
        execFileSync('nc', ['-z', '127.0.0.1', String(rule.listenPort)], { timeout: 3000 })
        reachable = true
        break
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    check('本机经转发连通容器服务', reachable)
    await win.evaluate((id) => window.api.removeForward(id), rule.id)
  }
}

await cleanup()
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
