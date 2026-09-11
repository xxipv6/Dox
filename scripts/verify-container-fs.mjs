/**
 * 容器文件管理（agent fs 协议 + 容器 SFTP 面板 + docker cp 传输）端到端：
 *  进 inner 容器标签 → UI 安装容器助手 → 打开文件面板（SFTP 按钮）→
 *  面板列出容器根目录 → UI 新建文件夹（容器里真实出现）→
 *  enqueueDropped 上传文件+目录（docker exec cat 校验字节）→
 *  面板双击进编辑器改内容保存（容器里内容变）→
 *  下载文件+目录（stub 原生对话框，本地内容比对）→
 *  递归删除（容器里消失）→ 清理。
 *
 * 用法：node scripts/verify-container-fs.mjs [host] [port] [user] [password]
 * 前置：npm run build && node scripts/build-agent.mjs；dind + inner 在跑
 */
import { _electron as electron } from 'playwright'
import { Client } from 'ssh2'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'

const host = process.argv[2] ?? 'localhost'
const port = Number(process.argv[3] ?? 2222)
const user = process.argv[4] ?? 'doxtest'
const password = process.argv[5] ?? 'doxtest123'
mkdirSync('shots', { recursive: true })
const INNER = 'inner'
const CTR_DIR = '/tmp/doxfs-test'
const LOCAL_DIR = '/tmp/doxfs-local'

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
const ctrExec = (c) => remoteExec(`docker exec ${INNER} sh -c '${c.replace(/'/g, `'\\''`)}'`)

// 夹具：inner 干净、本地目录备好
await remoteExec(`docker start ${INNER} 2>/dev/null || docker run -d --name ${INNER} alpine sleep 3600`)
await remoteExec(`docker exec ${INNER} sh -c "rm -f /tmp/dox-agent; rm -rf ${CTR_DIR}; true"`)
rmSync(LOCAL_DIR, { recursive: true, force: true })
mkdirSync(`${LOCAL_DIR}/up-dir/sub`, { recursive: true })
writeFileSync(`${LOCAL_DIR}/hello.txt`, '你好，容器\n第二行\n')
writeFileSync(`${LOCAL_DIR}/up-dir/a.conf`, 'key=value1\n')
writeFileSync(`${LOCAL_DIR}/up-dir/sub/b.log`, 'log-line\n')
console.log('  夹具就绪')

const cleanup = async () => {
  try { await remoteExec(`docker exec ${INNER} sh -c "rm -rf ${CTR_DIR} /tmp/dox-agent; true"`) } catch {}
  rmSync(LOCAL_DIR, { recursive: true, force: true })
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

// ---- SSH → 进容器 → 装助手 ----
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
  if (hk) { await win.locator('button:has-text("信任并保存")').click(); break }
}
await win.locator('.terminal-container:visible').first().waitFor({ timeout: 20000 })
await win.waitForTimeout(1500)
await win.keyboard.press('Escape')

const ctrHead = win.locator('.sidebar .section-head', { hasText: '容器' })
if ((await ctrHead.getAttribute('aria-expanded')) === 'false') {
  await ctrHead.click()
  await win.waitForTimeout(1500)
}
const row = win.locator('.container').filter({ hasText: INNER }).first()
await row.waitFor({ timeout: 15000 })
await row.click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu .menu-item').filter({ hasText: '进入' }).first().click()
await win.waitForTimeout(3000)

const agentHead = win.locator('.sidebar .section-head', { hasText: '助手' })
if ((await agentHead.getAttribute('aria-expanded')) === 'false') {
  await agentHead.click()
  await win.waitForTimeout(1000)
}
await win.locator('button', { hasText: `安装到容器 ${INNER}` }).click()
const installed = win.locator('.sidebar .agent-ok', { hasText: '已安装' })
let installOk = false
try {
  await installed.waitFor({ timeout: 30000 })
  installOk = true
} catch { /* 超时 */ }
check('容器助手安装成功', installOk)

// ---- 打开文件面板（容器标签的 SFTP 按钮）----
await win.locator('button.bar-btn:has-text("SFTP")').click()
await win.waitForTimeout(2500)
const listText = await win.evaluate(
  () => [...document.querySelectorAll('.explorer .file-name')].map((e) => e.textContent.trim()).join(',')
)
check('面板列出容器根目录（bin/etc/tmp）', /\bbin\b/.test(listText) && /\betc\b/.test(listText) && /\btmp\b/.test(listText), listText.slice(0, 120))
await win.screenshot({ path: 'shots/72-container-fs-panel.png' })

// ---- UI 新建文件夹：进 /tmp → 建 doxfs-test ----
await win.locator('.explorer .crumb', { hasText: 'tmp' }).first().click().catch(async () => {
  // 根目录下面包屑只有 "/"：双击 tmp 行进去
  await win.locator('.explorer .row', { hasText: 'tmp' }).first().dblclick()
})
await win.waitForTimeout(1200)
await win.locator('button[title="新建文件夹"]').click()
await win.locator('.explorer .rename-input').fill('doxfs-test')
await win.keyboard.press('Enter')
await win.waitForTimeout(1500)
const mkdirCheck = await ctrExec(`test -d ${CTR_DIR} && echo YES || echo NO`)
check('UI 新建文件夹在容器里真实出现', mkdirCheck.trim() === 'YES', mkdirCheck)

// ---- 上传（enqueueDropped：文件 + 目录）----
// 面板只是参数转发，传输走 IPC 级验证；新开一条会话当父会话（语义与面板相同）。
// connect 可能弹指纹确认（容器重建过），并行盯掉对话框，否则 evaluate 会吊死
const upSessionP = win.evaluate(async () => {
  const id = await window.api.connect(
    { host: 'localhost', port: 2222, username: 'doxtest', auth: { type: 'password', password: 'doxtest123' } },
    { cols: 80, rows: 24 }
  )
  return id
})
let upSession = null
for (let i = 0; i < 15 && upSession === null; i++) {
  await win.waitForTimeout(800)
  const trustBtn = win.locator('button:has-text("信任并保存")')
  if (await trustBtn.count()) await trustBtn.first().click().catch(() => {})
  upSession = await Promise.race([upSessionP, Promise.resolve(null)])
}
check('传输用父会话已建立', !!upSession)
await win.evaluate(
  async ({ sid, inner, localDir }) => {
    await window.api.enqueueDropped(sid, '/tmp/doxfs-test', [
      { path: `${localDir}/hello.txt`, name: 'hello.txt', size: 0 },
      { path: `${localDir}/up-dir`, name: 'up-dir', size: 0 }
    ], inner)
  },
  { sid: upSession, inner: INNER, localDir: LOCAL_DIR }
)
// 等队列传完
await win.waitForTimeout(6000)
const upCheck = await ctrExec(
  `cat ${CTR_DIR}/hello.txt 2>/dev/null; echo ---; cat ${CTR_DIR}/up-dir/a.conf 2>/dev/null; echo ---; cat ${CTR_DIR}/up-dir/sub/b.log 2>/dev/null`
)
check(
  '上传文件+目录到容器（字节校验）',
  upCheck.includes('你好，容器') && upCheck.includes('key=value1') && upCheck.includes('log-line'),
  upCheck
)

// ---- 面板双击进编辑器：改 hello.txt 保存 ----
// 面板从 /tmp 进 doxfs-test
await win.locator('.explorer .row', { hasText: 'doxfs-test' }).first().dblclick()
await win.waitForTimeout(1200)
await win.locator('.explorer .row', { hasText: 'hello.txt' }).first().dblclick()
await win.waitForTimeout(2500)
// CodeMirror 改内容：全选替换
await win.locator('.editor-panel .cm-content').click()
await win.keyboard.press('Meta+a')
await win.keyboard.type('编辑后的内容 from-dox\n')
await win.locator('.editor-panel button:has-text("保存")').click()
await win.waitForTimeout(2500)
const editCheck = await ctrExec(`cat ${CTR_DIR}/hello.txt`)
check('编辑器写回容器（agent fs_write）', editCheck.trim() === '编辑后的内容 from-dox', editCheck)
await win.screenshot({ path: 'shots/73-container-fs-editor.png' })

// ---- 下载（stub 原生对话框）：文件 + 目录 ----
await app.evaluate(({ dialog }) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: '/tmp/doxfs-local/dl-hello.txt' })
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['/tmp/doxfs-local'] })
})
await win.evaluate(
  async ({ sid, inner }) => {
    await window.api.download(sid, '/tmp/doxfs-test/hello.txt', 'hello.txt', inner)
    await window.api.downloadDir(sid, '/tmp/doxfs-test/up-dir', inner)
  },
  { sid: upSession, inner: INNER }
)
await win.waitForTimeout(6000)
let dlFile = ''
let dlDirA = ''
let dlDirB = ''
try {
  dlFile = readFileSync(`${LOCAL_DIR}/dl-hello.txt`, 'utf8')
  dlDirA = readFileSync(`${LOCAL_DIR}/up-dir/a.conf`, 'utf8')
  dlDirB = readFileSync(`${LOCAL_DIR}/up-dir/sub/b.log`, 'utf8')
} catch { /* 没落地 */ }
check('容器文件下载回本机', dlFile.trim() === '编辑后的内容 from-dox', dlFile)
check('容器目录递归下载（含子目录）', dlDirA === 'key=value1\n' && dlDirB === 'log-line\n', `${dlDirA}|${dlDirB}`)
// 中转目录不留痕
const stageLeft = await remoteExec(`ls -d /tmp/.dox-stage-* 2>/dev/null || echo CLEAN`)
check('宿主机中转目录已清理', stageLeft.includes('CLEAN'), stageLeft)

// ---- 递归删除 ----
// 打包放在删除之前：up-dir 还在，把它和 hello.txt 一起打成包（agent 用 Go 标准库产包）
const archivePath = await win.evaluate(
  async ({ sid, inner }) => {
    return window.api.sftpArchive(sid, ['/tmp/doxfs-test/hello.txt', '/tmp/doxfs-test/up-dir'], inner)
  },
  { sid: upSession, inner: INNER }
)
const tarCheck = await ctrExec(`tar -tzf ${archivePath} 2>/dev/null | tr '\n' ','`)
check(
  '容器内打包（agent Go 标准库产 tar.gz）',
  /hello\.txt/.test(tarCheck) && /up-dir\/a\.conf/.test(tarCheck) && /up-dir\/sub\/b\.log/.test(tarCheck),
  `${archivePath} -> ${tarCheck}`
)
// 撞名避让：再打一次应得到 -2 后缀
const archive2 = await win.evaluate(
  async ({ sid, inner }) => {
    return window.api.sftpArchive(sid, ['/tmp/doxfs-test/hello.txt', '/tmp/doxfs-test/up-dir'], inner)
  },
  { sid: upSession, inner: INNER }
)
check('打包撞名避让（-2 后缀）', archive2 !== archivePath && /-2\.tar\.gz$/.test(archive2), `${archivePath} vs ${archive2}`)

await win.evaluate(
  async ({ sid, inner }) => {
    await window.api.sftpDelete(sid, '/tmp/doxfs-test/up-dir', true, inner)
  },
  { sid: upSession, inner: INNER }
)
const delCheck = await ctrExec(`test -e ${CTR_DIR}/up-dir && echo STILL || echo GONE`)
check('容器内递归删除', delCheck.trim() === 'GONE', delCheck)

await win.evaluate((sid) => window.api.disconnect(sid), upSession)
await cleanup()
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
