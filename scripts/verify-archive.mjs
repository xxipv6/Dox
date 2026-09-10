/**
 * SFTP 右键「打包」（远端就地打包，不下载）的全套验证：
 *
 *  阶段 1（纯函数，无需参数，Node 24 type stripping 直接 import TS）：
 *    archive.ts 的命令构造 / 双引号转义 / 命名与撞名后缀 / 非法输入拒绝
 *  阶段 2（端到端，需要一台真实 SSH 主机）：
 *    连接 → 远端造 fixtures → 多选「打包这 N 项」→ 面板出现 打包-2项.tar.gz
 *    → 校验包内容 → 单项「打包」→ 撞名避让（a.txt-2.tar.gz）→ 清理
 *
 * 远端 fixtures 与包内容校验走**脚本自己的 ssh2 直连**，不读终端文本
 * （终端会回显命令本身，includes 认标记是踩过的坑，见 MAINTENANCE §4）。
 * UI 只负责被测路径：面板导航、多选、右键菜单、结果出现。
 *
 * 用法：node scripts/verify-archive.mjs                      # 只跑阶段 1
 *      node scripts/verify-archive.mjs <host> [port] [user] [password]
 * 前置（阶段 2）：npm run build；会在远端 /tmp/dox-arch 建临时文件，结束时删除。
 */
import { _electron as electron } from 'playwright'
import { Client } from 'ssh2'
import { mkdirSync } from 'node:fs'
import {
  archiveBaseName,
  buildArchiveCommand,
  dq,
  withSuffix
} from '../src/main/sftp/archive.ts'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

// ---------- 阶段 1：纯函数 ----------
console.log('阶段 1：archive.ts 纯函数')

const cmd = buildArchiveCommand('/tmp/x', 'foo.tar.gz', ['a b.txt', '-weird', 'q"uote', 'd$ollar', 'bk`tick'])
check('命令用 /bin/sh -c 包裹', cmd.startsWith("/bin/sh -c '") && cmd.endsWith("'"))
const payload = cmd.slice("/bin/sh -c '".length, -1)
check('脚本内不出现单引号（登录 shell 兼容红线）', !payload.includes("'"))
check('cd 进父目录再打相对名', payload.startsWith('cd "/tmp/x" && tar -czf "foo.tar.gz" -- '))
check('空格文件名被双引号包住', payload.includes('"a b.txt"'))
check('以 - 开头的文件名有 -- 兜底', payload.includes(' -- ') && payload.includes('"-weird"'))
check('双引号 / $ / 反引号被转义', payload.includes('"q\\"uote"') && payload.includes('"d\\$ollar"') && payload.includes('"bk\\`tick"'))

check('单项包名用本名', archiveBaseName(['foo']) === 'foo.tar.gz')
check('多项包名用「打包-N项」', archiveBaseName(['a', 'b', 'c']) === '打包-3项.tar.gz')
check('撞名后缀 -2 / -3', withSuffix('foo.tar.gz', 2) === 'foo-2.tar.gz' && withSuffix('foo.tar.gz', 3) === 'foo-3.tar.gz')
check('n<2 时原名', withSuffix('foo.tar.gz', 1) === 'foo.tar.gz')

const throws = (fn) => {
  try { fn(); return false } catch { return true }
}
check('换行文件名被拒绝', throws(() => dq('a\nb')))
check('相对路径父目录被拒绝', throws(() => buildArchiveCommand('tmp/x', 'a.tar.gz', ['a'])))
check('空名单被拒绝', throws(() => buildArchiveCommand('/tmp', 'a.tar.gz', [])) && throws(() => archiveBaseName([])))

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

console.log('阶段 2：端到端（远端 /tmp/dox-arch）')

// ---- 脚本自己的直连：fixtures / 内容校验 / 清理 ----
const ssh = new Client()
await new Promise((resolve, reject) => {
  ssh.on('ready', resolve).on('error', reject).connect({
    host, port, username: user, password, readyTimeout: 10000
  })
})
const remoteExec = (command) =>
  new Promise((resolve, reject) => {
    ssh.exec(command, (err, stream) => {
      if (err) return reject(err)
      let out = ''
      stream.on('data', (d) => (out += d))
      stream.stderr.on('data', () => {})
      stream.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`退出码 ${code}: ${command}`))))
    })
  })

await remoteExec('rm -rf /tmp/dox-arch && mkdir -p /tmp/dox-arch/sub && echo hello-dox > /tmp/dox-arch/a.txt && echo world-dox > /tmp/dox-arch/sub/b.txt')
check('远端 fixtures 就绪', true)

const cleanup = async () => {
  try { await remoteExec('rm -rf /tmp/dox-arch') } catch {}
  ssh.end()
}

// ---- 应用侧：连接 ----
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
    [...document.querySelectorAll('.dialog-header')]
      .map((e) => e.textContent.trim())
      .some((t) => t.includes('主机'))
  )
  if (hk) {
    await win.locator('button:has-text("信任并保存")').click()
    break
  }
}
await win.locator('.terminal-container:visible').first().click()
await win.waitForTimeout(1500)
await win.keyboard.press('Escape')

// ---- 打开 SFTP 面板（先开面板再 cd：跟随只认面板开着时到达的 OSC 7）----
await win.locator('button[title="SFTP 文件面板"]').click()
await win.waitForTimeout(1500)

/*
 * 终端 cd 过去，让 SFTP 面板跟随（OSC 7 联动是既有功能，顺手再验一次）。
 * 打字要慢：连接刚建立时焦点/首字符可能被吃（亲眼见过 cd 变成 d）。
 * 最多试 3 次，以面包屑到位为准。
 */
let followed = false
for (let attempt = 0; attempt < 3 && !followed; attempt++) {
  await win.locator('.terminal-container:visible').first().click()
  await win.waitForTimeout(600)
  await win.keyboard.type('cd /tmp/dox-arch', { delay: 60 })
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1800)
  const crumbs = await win.evaluate(() =>
    [...document.querySelectorAll('.breadcrumb .crumb')].map((e) => e.textContent.trim()).join('/')
  )
  followed = crumbs.includes('dox-arch')
}
console.log(followed ? '  ok  面板跟随 cd' : '  FAIL 面板跟随 cd（将直接刷新兜底）')
if (!followed) failed = true
await win.locator('.toolbar button[title="刷新"]').click()
await win.waitForTimeout(1200)

const rowOf = (name) =>
  win.locator('.explorer .file-list .row').filter({ has: win.locator(`.file-name:text-is("${name}")`) }).first()
const rowNames = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.explorer .file-list .row .file-name')].map((e) => e.textContent.trim())
  )
const waitRow = async (name, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await rowNames()).includes(name)) return true
    await win.waitForTimeout(500)
  }
  return false
}

/*
 * 多选修饰键：macOS 上 Ctrl+点击 = 系统级右键（会开出上下文菜单而不是加选），
 * 真实用户在 mac 上用 Cmd。脚本必须按平台分，否则菜单背板会拦截后续所有点击。
 */
const MULTI_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control'

check('面板跟随到 /tmp/dox-arch（能看到 fixtures）', await waitRow('a.txt', 10000), JSON.stringify(await rowNames()))

// ---- 多选打包 ----
await rowOf('a.txt').click()
await rowOf('sub').click({ modifiers: [MULTI_MODIFIER] })
await rowOf('a.txt').click({ button: 'right' })
await win.waitForTimeout(400)
await win.screenshot({ path: 'shots/50-archive-menu.png' })
const menuHasMulti = await win.evaluate(() =>
  [...document.querySelectorAll('.context-menu .menu-item')].some((b) => b.textContent.includes('打包这 2 项'))
)
check('多选菜单出现「打包这 2 项」', menuHasMulti)
await win.locator('.context-menu .menu-item', { hasText: '打包这 2 项' }).click()
check('面板出现 打包-2项.tar.gz', await waitRow('打包-2项.tar.gz'))
await win.screenshot({ path: 'shots/50-archive-multi-done.png' })

// ---- 校验包内容（脚本直连 tar -tzf，不读终端）----
const listing = await remoteExec("tar -tzf '/tmp/dox-arch/打包-2项.tar.gz'")
check(
  '包内成员是相对路径 a.txt + sub/b.txt',
  listing.split('\n').some((l) => l.trim() === 'a.txt') &&
    listing.split('\n').some((l) => l.trim() === 'sub/b.txt'),
  JSON.stringify(listing)
)

// ---- 单项打包 ----
await rowOf('a.txt').click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu .menu-item', { hasText: /^打包$/ }).click()
check('单项打包生成 a.txt.tar.gz', await waitRow('a.txt.tar.gz'))
const singleListing = await remoteExec("tar -tzf /tmp/dox-arch/a.txt.tar.gz")
check('单项包内容正确', singleListing.split('\n').some((l) => l.trim() === 'a.txt'), JSON.stringify(singleListing))

// ---- 撞名避让：再打包一次 a.txt → a.txt-2.tar.gz ----
await rowOf('a.txt').click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu .menu-item', { hasText: /^打包$/ }).click()
check('撞名避让生成 a.txt-2.tar.gz', await waitRow('a.txt-2.tar.gz'))
await win.screenshot({ path: 'shots/50-archive-conflict.png' })

// ---- 清理 ----
await cleanup()
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
