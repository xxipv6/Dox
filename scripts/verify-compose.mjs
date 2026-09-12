/**
 * SFTP 右键 compose 动作的端到端（dind 夹具）：
 *  直连 SSH 写入 /tmp/compose-test/docker-compose.yml → 应用里 SFTP 面板导航过去 →
 *  右键出 Compose 三项 → up -d（卡片转 ok，docker ps 见服务）→ restart →
 *  down（确认弹窗自动接受，容器消失）→ 清理。
 *
 * 用法：node scripts/verify-compose.mjs [host] [port] [user] [password]
 * 前置：npm run build；dox-sshd-test 在跑且装了 docker-cli-compose
 */
import { _electron as electron } from 'playwright'
import { Client } from 'ssh2'
import { mkdirSync } from 'node:fs'

const host = process.argv[2] ?? 'localhost'
const port = Number(process.argv[3] ?? 2222)
const user = process.argv[4] ?? 'doxtest'
const password = process.argv[5] ?? 'doxtest123'
mkdirSync('shots', { recursive: true })

const DIR = '/tmp/compose-test'
const SVC = 'compose-test-svc'

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

// 夹具：compose 项目目录 + 最小服务定义
await remoteExec(`rm -rf ${DIR}; mkdir -p ${DIR}`)
await remoteExec(`cat > ${DIR}/docker-compose.yml <<'EOF'
services:
  app:
    image: alpine
    container_name: ${SVC}
    command: sleep 600
EOF`)
console.log('  夹具就绪')

const cleanup = async () => {
  try { await remoteExec(`cd ${DIR} && docker compose down >/dev/null 2>&1; rm -rf ${DIR}`) } catch {}
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

// ---- SSH 连接 ----
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
await win.waitForTimeout(1500)

// ---- SFTP 面板 → 导航到 /tmp/compose-test（起点是家目录，先点面包屑的根）----
await win.locator('button.bar-btn:has-text("SFTP")').click()
await win.waitForTimeout(3000)
await win.locator('.breadcrumb .crumb[title="/"]').click()
await win.waitForTimeout(1500)
await win.locator('.explorer .row', { hasText: 'tmp' }).first().dblclick()
await win.waitForTimeout(1200)
await win.locator('.explorer .row', { hasText: 'compose-test' }).first().dblclick()
await win.waitForTimeout(1200)

const composeRow = win.locator('.explorer .row', { hasText: 'docker-compose.yml' }).first()
await composeRow.waitFor({ timeout: 8000 })

/** 右键 compose 文件 → 点指定动作 → 等结果卡落定 */
async function runCompose(verbLabel) {
  await composeRow.click({ button: 'right' })
  await win.waitForTimeout(400)
  const item = win.locator('.context-menu .menu-item, .context-menu button').filter({ hasText: verbLabel }).first()
  await item.click()
  // 卡片先转 running，落定成 ok/err（up 拉镜像可能慢，宽限给足）
  const card = win.locator('.compose-card')
  await card.waitFor({ timeout: 5000 })
  for (let i = 0; i < 60; i++) {
    const cls = (await card.getAttribute('class')) ?? ''
    if (cls.includes(' ok') || cls.includes(' err')) return cls.includes(' ok') ? 'ok' : 'err'
    await win.waitForTimeout(1000)
  }
  return 'timeout'
}

// ---- up -d ----
// 菜单先验：三项都在
await composeRow.click({ button: 'right' })
await win.waitForTimeout(400)
const menuText = await win.locator('.context-menu').textContent()
check(
  '右键出 Compose 三项',
  ['Compose: up -d', 'Compose: restart', 'Compose: down'].every((t) => (menuText ?? '').includes(t)),
  (menuText ?? '').slice(0, 200)
)
await win.keyboard.press('Escape')

check('compose up -d 成功', (await runCompose('Compose: up -d')) === 'ok')
const psUp = await remoteExec('docker ps --format {{.Names}}')
check('服务容器真起来了', psUp.includes(SVC), psUp.trim())

// ---- restart ----
check('compose restart 成功', (await runCompose('Compose: restart')) === 'ok')

// ---- down（确认弹窗由全局 dialog 处理器接受）----
check('compose down 成功', (await runCompose('Compose: down')) === 'ok')
const psDown = await remoteExec('docker ps -a --format {{.Names}}')
check('容器被 down 掉', !psDown.includes(SVC), psDown.trim())

await win.screenshot({ path: 'shots/92-compose.png' })

await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()
await cleanup()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
