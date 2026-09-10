/**
 * 终端路径交互的端到端验证（SSH 会话）：
 *  A. `cd va<TAB>` 这类用过补全的命令不得把 SFTP 面板带偏（/va → no such file 那个回归）
 *  B. 正常 `cd /etc` 面板跟随（带 sftpStat 落地校验）
 *  C. Ctrl+点击终端输出里的文件路径 → 内置编辑器打开
 *
 * 用法：node scripts/verify-path-links.mjs <host> [port] [user] [password]
 * 前置：npm run build；目标主机可达（只读操作，不改远端任何东西）。
 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const host = process.argv[2]
if (!host) {
  console.error('用法: node scripts/verify-path-links.mjs <host> [port] [user] [password]')
  process.exit(2)
}
const port = process.argv[3] ?? '22'
const user = process.argv[4] ?? 'root'
const password = process.argv[5] ?? ''
mkdirSync('shots', { recursive: true })

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
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

// ---------- 连接 ----------
await win.locator('button[title="添加设备"]').click()
await win.waitForTimeout(400)
await win.locator('input[placeholder^="192.168"]').fill(host)
await win.locator('input.port').fill(port)
await win.locator('input[placeholder="root"]').fill(user)
await win.locator('input[placeholder="登录密码"]').fill(password)
await win.locator('button:has-text("仅连接")').click()
for (let i = 0; i < 8; i++) {
  await win.waitForTimeout(1000)
  const hk = await win.evaluate(() =>
    [...document.querySelectorAll('.dialog-header')]
      .map((e) => e.textContent.trim())
      .some((t) => t.includes('主机'))
  )
  if (hk) {
    await win.locator('button:has-text("信任并保存")').click()
    break
  }
}
// 等终端出来并拿到焦点
await win.locator('.terminal-container:visible').first().click()
await win.waitForTimeout(1500)
await win.keyboard.press('Escape') // 收掉可能还开着的设备弹窗

// ---------- 打开 SFTP 面板 ----------
await win.locator('button[title="SFTP 文件面板"]').click()
await win.waitForTimeout(2000)

const crumbs = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.breadcrumb .crumb')].map((e) => e.textContent.trim()).join(' ')
  )
const panelError = () =>
  win.evaluate(
    () =>
      document.querySelector('.explorer .error, .panel-error, [class*="error"]')?.textContent?.trim() ?? ''
  )

const initialCrumbs = await crumbs()
console.log('面板初始路径:', JSON.stringify(initialCrumbs))

async function typeCmd(cmd) {
  await win.locator('.terminal-container:visible').first().click()
  await win.keyboard.type(cmd)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1200)
}

// ---------- A. Tab 补全的 cd：前缀补全后跟随到 /var（不是字面的 /va） ----------
await typeCmd('cd /va')
// Tab 在终端里是补全（va → var/），跟踪器把参数当前缀去远端补全，唯一匹配才跳
await win.keyboard.press('Tab')
await win.waitForTimeout(600)
await win.keyboard.press('Enter')
await win.waitForTimeout(2500)
const afterTab = await crumbs()
check('Tab 补全的 cd 跟随到 /var（而非字面 /va）', /\bvar\b/.test(afterTab), `${initialCrumbs} → ${afterTab}`)

// ---------- B. 正常 cd 跟随（stat 落地校验通过） ----------
await typeCmd('cd /etc')
await win.waitForTimeout(1500) // stat 校验有一个 SFTP 往返
const afterCd = await crumbs()
check('正常 cd 面板跟随到 /etc', /\betc\b/.test(afterCd), afterCd)

// ---------- B2. cd 到不存在的目录不跳 ----------
await typeCmd('cd /no-such-dir-xyz')
await win.waitForTimeout(1500)
const afterBadCd = await crumbs()
check('cd 到不存在的目录面板不动', afterBadCd === afterCd, afterBadCd)

// ---------- C. Ctrl+点击文件路径 → 编辑器打开 ----------
await typeCmd('clear')
await typeCmd('echo /etc/hosts')
await win.waitForTimeout(500)

// 逐格扫前几行做 Ctrl+点击：路径在第几行哪个字符不做脆性假设，
// 扫到编辑器打开为止（每次点击后等一拍看 .editor-panel 出没出现）
const box = await win.locator('.terminal-container:visible').first().boundingBox()
let editorOpened = false
if (box) {
  await win.keyboard.down('Control')
  outer: for (let dy = 10; dy <= 70; dy += 14) {
    for (let dx = 6; dx <= 160; dx += 7) {
      await win.mouse.click(box.x + dx, box.y + dy)
      await win.waitForTimeout(350)
      if (await win.locator('.editor-panel').isVisible().catch(() => false)) {
        editorOpened = true
        break outer
      }
    }
  }
  await win.keyboard.up('Control')
}
check('Ctrl+点击文件路径打开编辑器', editorOpened)
if (editorOpened) {
  const etab = await win.locator('.editor-panel .etab.active').innerText().catch(() => '')
  check('编辑器打开的是 hosts', etab.includes('hosts'), etab)
}
await win.screenshot({ path: join('shots', '32-path-link.png') })

// ---------- 收尾 ----------
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()
console.log(failed ? '\n有断言未通过' : '\n全部通过')
process.exit(failed ? 1 : 0)
