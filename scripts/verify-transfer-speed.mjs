/**
 * 传输吞吐冒烟（配合「并发 4 + 大高水位」优化）：
 * 本机造 64MB 随机文件 → 经 UI 上传到测试机 → 远端 sha256 比对 →
 * 再下载回来 → 本地 sha256 比对；顺带打出两个方向的速度。
 *
 * 用法：node scripts/verify-transfer-speed.mjs <host> [port] [user] [password]
 * 前置：npm run build；会在远端 /tmp 与本机 os.tmpdir 建临时文件，结束自删。
 */
import { _electron as electron } from 'playwright'
import { Client } from 'ssh2'
import { createHash, randomBytes } from 'node:crypto'
import { writeFileSync, unlinkSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const host = process.argv[2]
if (!host) {
  console.error('用法: node scripts/verify-transfer-speed.mjs <host> [port] [user] [password]')
  process.exit(2)
}
const port = Number(process.argv[3] ?? 22)
const user = process.argv[4] ?? 'root'
const password = process.argv[5] ?? ''
mkdirSync('shots', { recursive: true })

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

// ---- 本机 fixture：64MB 随机（不可压缩，测的是真吞吐）----
const SIZE = 64 * 1024 * 1024
const localFile = join(tmpdir(), `dox-speed-${process.pid}.bin`)
writeFileSync(localFile, randomBytes(SIZE))
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const localHash = sha256(readFileSync(localFile))
console.log(`本地 fixture 就绪: ${localFile} (${SIZE / 1024 / 1024}MB)`)

// ---- 远端直连：校验与清理 ----
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
// 上传按本地文件原名落盘
const REMOTE = `/tmp/${basename(localFile)}`
const hasher = (await remoteExec('command -v sha256sum || command -v shasum')).trim()
check('远端有 sha256 工具', !!hasher, 'sha256sum/shasum 都没有')

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
await win.waitForTimeout(1500)
await win.keyboard.press('Escape')

// 打开 SFTP 面板，cd 到 /tmp 让上传落在那（跟随不到就重试，见过首字符被吃）
await win.locator('button[title="SFTP 文件面板"]').click()
await win.waitForTimeout(1500)
for (let attempt = 0; attempt < 3; attempt++) {
  await win.locator('.terminal-container:visible').first().click()
  await win.waitForTimeout(600)
  await win.keyboard.type('cd /tmp', { delay: 60 })
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1800)
  const crumbs = await win.evaluate(() =>
    [...document.querySelectorAll('.breadcrumb .crumb')].map((e) => e.textContent.trim()).join('/')
  )
  if (crumbs.includes('tmp')) break
}

const tasks = () => win.evaluate(() => window.api.listTransfers())

/** 等所有任务落定（done/error/canceled）。waitForFunction 套异步 IPC 不靠谱，用轮询 */
async function waitTransfersSettled(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const list = await tasks()
    if (list.length > 0 && list.every((t) => t.status !== 'active' && t.status !== 'pending')) {
      return list
    }
    await win.waitForTimeout(500)
  }
  return await tasks()
}

// ---- 上传（打桩文件选择框；路径作为参数传进主进程）----
await app.evaluate(({ dialog }, filePath) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
}, localFile)
// SFTP 面板已在 /tmp（上面 cd 跟随），点工具栏「上传文件」
await win.locator('.toolbar button[title="上传文件"]').click()
const t0 = Date.now()
// 等上传任务出现
{
  const deadline = Date.now() + 15000
  while ((await tasks()).length === 0 && Date.now() < deadline) await win.waitForTimeout(300)
}
check('上传任务入队', (await tasks()).length > 0)
const upTasks = await waitTransfersSettled()
const upSec = (Date.now() - t0) / 1000
check('上传完成', upTasks.every((t) => t.status === 'done'), JSON.stringify(upTasks.map((t) => t.status + ':' + (t.error ?? ''))))
console.log(`  上传 ${(SIZE / 1024 / 1024 / upSec).toFixed(1)} MB/s（${upSec.toFixed(1)}s）`)

// ---- 远端校验 ----
const remoteHash = (await remoteExec(`${hasher} ${REMOTE} | cut -d' ' -f1`)).trim()
check('上传 sha256 一致', remoteHash === localHash, `${remoteHash} != ${localHash}`)

// ---- 下载（打桩保存框）----
const downloadTo = join(tmpdir(), `dox-speed-dl-${process.pid}.bin`)
await app.evaluate(({ dialog }, savePath) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: savePath })
}, downloadTo)
await win.locator(`.explorer .file-list .row`).filter({ hasText: basename(localFile) }).first().click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu .menu-item', { hasText: /^下载$/ }).click()
const t1 = Date.now()
const dlTasks = await waitTransfersSettled()
const dlSec = (Date.now() - t1) / 1000
check('下载完成', dlTasks.every((t) => t.status === 'done'), JSON.stringify(dlTasks.map((t) => t.status + ':' + (t.error ?? ''))))
console.log(`  下载 ${(SIZE / 1024 / 1024 / dlSec).toFixed(1)} MB/s（${dlSec.toFixed(1)}s）`)
const dlHash = sha256(readFileSync(downloadTo))
check('下载 sha256 一致', dlHash === localHash, `${dlHash} != ${localHash}`)

await win.screenshot({ path: 'shots/60-transfer-speed.png' })

// ---- 清理 ----
await remoteExec(`rm -f ${REMOTE}`).catch(() => {})
ssh.end()
unlinkSync(localFile)
unlinkSync(downloadTo)
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
