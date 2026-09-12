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
  try {
    await remoteExec(
      `cd ${DIR} 2>/dev/null && docker compose down >/dev/null 2>&1; ` +
        `cd ${DIR}-hang 2>/dev/null && docker compose down >/dev/null 2>&1; ` +
        `rm -rf ${DIR} ${DIR}-hang`
    )
  } catch {}
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

/** 右键 compose 文件 → 点指定动作 → 抽屉出现 → 等结局（完成/失败/已取消） */
async function runCompose(verbLabel, rowSel) {
  const row = rowSel ?? composeRow
  await row.click({ button: 'right' })
  await win.waitForTimeout(400)
  const item = win.locator('.context-menu .menu-item, .context-menu button').filter({ hasText: verbLabel }).first()
  await item.click()
  const drawer = win.locator('.compose-drawer')
  await drawer.waitFor({ timeout: 5000 })
  for (let i = 0; i < 90; i++) {
    const foot = await drawer.locator('.cd-foot').textContent().catch(() => null)
    if (foot) {
      if (foot.includes('完成')) return 'ok'
      if (foot.includes('已取消')) return 'canceled'
      if (foot.includes('失败')) return 'err'
    }
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

// 先验证流式：点击 up 后，输出抽屉应该**在结局之前**就开始滚字
await composeRow.click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu .menu-item, .context-menu button').filter({ hasText: 'Compose: up -d' }).first().click()
const drawer = win.locator('.compose-drawer')
await drawer.waitFor({ timeout: 5000 })
let streamedEarly = false
for (let i = 0; i < 10; i++) {
  const text = await drawer.locator('.cd-out').textContent()
  const foot = await drawer.locator('.cd-foot').count()
  if ((text ?? '').length > 0 && foot === 0) { streamedEarly = true; break }
  if (foot > 0) break
  await win.waitForTimeout(400)
}
check('输出在结局之前流式滚动（不是闷跑）', streamedEarly)
for (let i = 0; i < 90; i++) {
  const foot = await drawer.locator('.cd-foot').textContent().catch(() => null)
  if (foot) break
  await win.waitForTimeout(1000)
}
const upFoot = await drawer.locator('.cd-foot').textContent()
check('compose up -d 成功', (upFoot ?? '').includes('完成'), (upFoot ?? '').slice(0, 80))
const psUp = await remoteExec('docker ps --format {{.Names}}')
check('服务容器真起来了', psUp.includes(SVC), psUp.trim())
await win.screenshot({ path: 'shots/93-compose-drawer.png' })

// ---- restart ----
check('compose restart 成功', (await runCompose('Compose: restart')) === 'ok')

// ---- 取消：不可达镜像的 pull 会挂着，用户取消后状态要是「已取消」----
await remoteExec(`mkdir -p ${DIR}-hang && cat > ${DIR}-hang/docker-compose.yml <<'EOF'
services:
  app:
    image: 10.255.255.1/dox-never:latest
    container_name: compose-hang-svc
    command: sleep 600
EOF`)
await win.locator('.breadcrumb .crumb', { hasText: 'tmp' }).click()
await win.waitForTimeout(1200)
await win.locator('.explorer .row', { hasText: 'compose-test-hang' }).first().dblclick()
await win.waitForTimeout(1200)
const hangRow = win.locator('.explorer .row', { hasText: 'docker-compose.yml' }).first()
await hangRow.click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu .menu-item, .context-menu button').filter({ hasText: 'Compose: up -d' }).first().click()
await win.waitForTimeout(3000) // 让 pull 挂起来
const hangPill = drawer.locator('.cd-pill', { hasText: 'up -d' }).last()
await hangPill.click()
await drawer.locator('.cd-btn.danger', { hasText: '取消' }).click()
let canceled = false
for (let i = 0; i < 30; i++) {
  const foot = await drawer.locator('.cd-foot').textContent().catch(() => null)
  if (foot?.includes('已取消')) { canceled = true; break }
  if (foot) break
  await win.waitForTimeout(1000)
}
check('取消中断了挂起的 up（状态「已取消」）', canceled)
const psHang = await remoteExec('docker ps -a --format {{.Names}}')
check('被取消的项目没有留下容器', !psHang.includes('compose-hang-svc'), psHang.trim())

// ---- down（确认弹窗由全局 dialog 处理器接受）----
await win.locator('.breadcrumb .crumb', { hasText: 'tmp' }).click()
await win.waitForTimeout(1200)
await win.locator('.explorer .row', { hasText: 'compose-test' }).first().dblclick()
await win.waitForTimeout(1200)
check('compose down 成功', (await runCompose('Compose: down')) === 'ok')
const psDown = await remoteExec('docker ps -a --format {{.Names}}')
check('容器被 down 掉', !psDown.includes(SVC), psDown.trim())

await win.screenshot({ path: 'shots/92-compose.png' })

await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()
await cleanup()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
