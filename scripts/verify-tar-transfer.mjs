/**
 * tar 整流文件夹传输（上传 + 下载）的验证。
 *
 *  阶段 1（纯函数，无需参数）：tarStream.ts 写读往返
 *    常规树 / 空文件 / 空目录 / 中文名 / pax 长名 / ustar 拆分长名 /
 *    GNU longname('L') / base-256 size / 坏校验和 / tar slip 防护
 *  阶段 2（主进程级端到端，需要一台真实 SSH 主机）：
 *    真实 TransferManager + 真实 ssh2 连接：2000+ 文件树上传 → 远端
 *    sha256 全量比对 → 下载回本地 → 再与原树比对；取消两条路（遍历期
 *    中断、下载中流取消）。fixtures 与校验走脚本自己的 ssh2 直连
 *    （MAINTENANCE §4：不读终端文本）。
 *  阶段 3（应用级冒烟，同主机）：真实 Electron 窗口连上 → CDP 拖文件夹
 *    进 SFTP 面板 → 队列出现「整流模式」一条任务并完成（验主进程接线：
 *    IPC → 构造时注入的 getClient → tar 探测 → 整流分支）。
 *
 * 用法：node scripts/verify-tar-transfer.mjs                      # 只跑阶段 1
 *      node scripts/verify-tar-transfer.mjs <host> [port] [user] [password]
 * 前置（阶段 3）：npm run build。远端只在 /tmp 建临时目录，结束时删除。
 *
 * 实现备注：TransferManager.ts 用了构造参数属性（TS 独有语法），普通
 * type stripping 吃不下，阶段 2/3 用 --experimental-transform-types
 * 自重入一次（DOX_TAR_E2E 防循环）。
 */
import { _electron as electron } from 'playwright'
import { Client } from 'ssh2'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import {
  TarParser,
  safeLocalJoin,
  tarEntryBytes,
  tarHeaderBlocks,
  tarPadSize,
  tarTrailer
} from '../src/main/sftp/tarStream.ts'

// ---------- 阶段 2/3 需要 transform-types，先自重入 ----------
const host = process.argv[2]
if (host && !process.env.DOX_TAR_E2E) {
  const r = spawnSync(
    process.execPath,
    ['--experimental-transform-types', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, DOX_TAR_E2E: '1' } }
  )
  process.exit(r.status ?? 1)
}

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

// ---------- 阶段 1：tarStream 纯函数 ----------
console.log('阶段 1：tarStream 写读往返')

const collect = () => {
  const dirs = []
  const files = []
  let cur = null
  return {
    sink: {
      async onDir(e) { dirs.push(e.name) },
      async onFileStart(e) { cur = { name: e.name, size: e.size, chunks: [] }; files.push(cur) },
      async onFileData(c) { cur.chunks.push(c) },
      async onFileEnd() {}
    },
    dirs,
    files,
    dataOf: (f) => Buffer.concat(f.chunks)
  }
}

/** 以不规则块大小喂流，模拟真实通道的任意切分 */
const feed = async (parser, stream, sink) => {
  const sizes = [1, 7, 512, 3, 4096, 100, 8192, 13]
  let pos = 0
  let i = 0
  while (pos < stream.length) {
    const n = Math.min(sizes[i++ % sizes.length], stream.length - pos)
    await parser.push(stream.subarray(pos, pos + n), sink)
    pos += n
  }
}

/** entries: [{name, isDir, data?}]；返回拼好的完整 tar 流与期望清单 */
const buildStream = (entries) => {
  const parts = []
  const expect = []
  for (const e of entries) {
    const meta = {
      name: e.name,
      size: e.isDir ? 0 : e.data.length,
      mode: e.isDir ? 0o755 : 0o644,
      mtime: 1700000000,
      isDir: e.isDir
    }
    for (const hb of tarHeaderBlocks(meta)) parts.push(hb)
    if (!e.isDir) {
      parts.push(e.data)
      const pad = tarPadSize(e.data.length)
      if (pad) parts.push(Buffer.alloc(pad))
    }
    expect.push({ name: e.name, isDir: e.isDir, data: e.data ?? null })
    // 字节数自洽：线上总量必须等于预算
    const blockBytes = tarHeaderBlocks(meta).reduce((s, b) => s + b.length, 0)
    check(
      `tarEntryBytes 与实际块一致（${e.name.slice(0, 24)}…）`,
      tarEntryBytes(meta) === blockBytes + (e.isDir ? 0 : e.data.length + tarPadSize(e.data.length))
    )
  }
  parts.push(tarTrailer())
  return { stream: Buffer.concat(parts), expect }
}

const roundTrip = async (label, entries) => {
  const { stream, expect } = buildStream(entries)
  const c = collect()
  await feed(new TarParser(), stream, c.sink)
  const gotDirs = c.dirs
  const gotFiles = c.files
  const wantDirs = expect.filter((e) => e.isDir).map((e) => e.name)
  const wantFiles = expect.filter((e) => !e.isDir)
  check(
    `${label}：目录序列一致`,
    JSON.stringify(gotDirs) === JSON.stringify(wantDirs),
    `got=${JSON.stringify(gotDirs)}`
  )
  check(
    `${label}：文件序列一致`,
    JSON.stringify(gotFiles.map((f) => f.name)) === JSON.stringify(wantFiles.map((f) => f.name)),
    `got=${JSON.stringify(gotFiles.map((f) => f.name))}`
  )
  let dataOk = gotFiles.length === wantFiles.length
  for (let i = 0; i < wantFiles.length && dataOk; i++) {
    dataOk = gotFiles[i].size === wantFiles[i].data.length &&
      collect().dataOf(gotFiles[i]).equals(wantFiles[i].data)
  }
  check(`${label}：每个文件字节逐一对上`, dataOk)
}

check('tarPadSize 边界', tarPadSize(0) === 0 && tarPadSize(1) === 511 && tarPadSize(512) === 0 && tarPadSize(513) === 511)

await roundTrip('常规树', [
  { name: 'root/', isDir: true },
  { name: 'root/a.txt', data: Buffer.from('hello tar') },
  { name: 'root/zero.bin', data: Buffer.alloc(0) },
  { name: 'root/sub/', isDir: true },
  { name: 'root/sub/b-512.bin', data: Buffer.alloc(512, 1) },
  { name: 'root/sub/c-513.bin', data: Buffer.alloc(513, 2) },
  { name: 'root/你好 世界.txt', data: Buffer.from('中文文件名内容'.repeat(10)) },
  { name: 'root/empty-dir/', isDir: true }
])

const longName = `root/${'长'.repeat(60)}-${'x'.repeat(80)}.txt`
const longBlocks = tarHeaderBlocks({ name: longName, size: 3, mode: 0o644, mtime: 1, isDir: false })
check('pax 长名走扩展头（>100 字节且无法 ustar 拆分）', longBlocks.length > 1)
await roundTrip('pax 长名', [
  { name: 'root/', isDir: true },
  { name: longName, data: Buffer.from('abc') }
])

const splitName = `root/${'d'.repeat(60)}/${'e'.repeat(70)}.txt`
const splitBlocks = tarHeaderBlocks({ name: splitName, size: 3, mode: 0o644, mtime: 1, isDir: false })
check('可拆分长名不进 pax（prefix/name 两段装得下）', splitBlocks.length === 1)
await roundTrip('ustar 拆分长名', [
  { name: 'root/', isDir: true },
  { name: splitName, data: Buffer.from('abc') }
])

// ---- 手搓 GNU 风格流：longname('L') + base-256 size（远端 GNU tar 默认 gnu 格式会产出）----
const craftHeader = ({ name, size, type, magic = 'ustar\0' + '00' }) => {
  const b = Buffer.alloc(512)
  b.write(name, 0, 'utf8')
  b.write('0000644\0', 100, 'ascii')
  b.write('0000000\0', 108, 'ascii')
  b.write('0000000\0', 116, 'ascii')
  b.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  b.write('0000000000\0', 136, 'ascii')
  b.fill(0x20, 148, 156)
  b.write(type, 156, 'ascii')
  b.write(magic, 257, 'ascii')
  let sum = 0
  for (let i = 0; i < 512; i++) sum += b[i]
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return b
}

const gnuLong = `root/${'g'.repeat(120)}.txt`
const gnuLongNameBuf = Buffer.from(gnuLong + '\0', 'utf8')
const gnuStream = Buffer.concat([
  craftHeader({ name: './@LongLink', size: gnuLongNameBuf.length, type: 'L' }),
  gnuLongNameBuf,
  Buffer.alloc(tarPadSize(gnuLongNameBuf.length)),
  craftHeader({ name: gnuLong.slice(0, 90), size: 2, type: '0' }),
  Buffer.from('hi'),
  Buffer.alloc(tarPadSize(2)),
  tarTrailer()
])
{
  const c = collect()
  await feed(new TarParser(), gnuStream, c.sink)
  check("GNU 'L' longname 还原长名", c.files[0]?.name === gnuLong, c.files[0]?.name ?? '(无)')
  check("GNU 'L' 数据正确", c.files.length === 1 && Buffer.concat(c.files[0].chunks).toString() === 'hi')
}

// base-256 size：目录条目携带（文件的话解析器会等 8GB 数据，没法测；目录不读数据）
const bigSize = 8589934591 + 5 // 0o77777777777 + 5，超出 11 位八进制
{
  const sizes = []
  const b = (() => {
    const blk = craftHeader({ name: 'bigdir/', size: 0, type: '5' })
    blk.fill(0, 124, 136)
    blk[124] = 0x80
    let v = bigSize
    for (let i = 135; i > 124; i--) { blk[i] = v % 256; v = Math.floor(v / 256) }
    blk.fill(0x20, 148, 156)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += blk[i]
    blk.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
    return blk
  })()
  const p = new TarParser()
  await p.push(Buffer.concat([b, tarTrailer()]), {
    async onDir(e) { sizes.push(e.size) },
    async onFileStart() {},
    async onFileData() {},
    async onFileEnd() {}
  })
  check('base-256 size 数值正确', sizes[0] === bigSize, `got=${sizes[0]}`)
}

// 坏校验和必须炸出来（通道数据损坏不能静默解出错误文件）
{
  const { stream } = buildStream([{ name: 'root/', isDir: true }])
  const corrupted = Buffer.from(stream)
  corrupted[10] ^= 0xff
  let threw = false
  try {
    await new TarParser().push(corrupted, collect().sink)
  } catch {
    threw = true
  }
  check('坏校验和抛错（不静默解错）', threw)
}

// tar slip 防护
check('.. 越界被拒绝', safeLocalJoin('/base', 'a/../../etc/passwd') === null)
check('正常相对路径放行', safeLocalJoin('/base', 'root/a.txt') === join('/base', 'root', 'a.txt'))
check('点段被吞', safeLocalJoin('/base', './root/./a.txt') === join('/base', 'root', 'a.txt'))

// ---------- 阶段 2/3：需要真实主机 ----------
if (!host) {
  console.log('\n（未给主机参数，跳过阶段 2/3）')
  process.exit(failed ? 1 : 0)
}
const port = Number(process.argv[3] ?? 22)
const user = process.argv[4] ?? 'root'
const password = process.argv[5] ?? ''

// ---------- 阶段 2：真实 TransferManager + 真实 ssh2 ----------
console.log('\n阶段 2：TransferManager 直连端到端')
const { TransferManager } = await import('../src/main/sftp/TransferManager.ts')

const ssh = new Client()
await new Promise((res, rej) => {
  ssh.on('ready', res).on('error', rej).connect({ host, port, username: user, password, readyTimeout: 10000 })
})
const remoteExec = (command) =>
  new Promise((res, rej) => {
    ssh.exec(command, (err, stream) => {
      if (err) return rej(err)
      let out = ''
      stream.on('data', (d) => (out += d))
      stream.stderr.on('data', () => {})
      stream.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`退出码 ${code}: ${command}`))))
    })
  })

const sftp = await new Promise((res, rej) => ssh.sftp((e, s) => (e ? rej(e) : res(s))))
const tm = new TransferManager(() => Promise.resolve(sftp), () => {}, () => ssh)

const waitTask = async (id, timeoutMs = 180_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const t = tm.list().find((x) => x.id === id)
    if (t && (t.status === 'done' || t.status === 'error' || t.status === 'canceled')) return t
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('任务超时未落定')
}

// ---- 本地 fixture 树：2000 小文件 + 边界情况 ----
const FIXTURE_ROOT = join(tmpdir(), 'dox-tar-fixture')
// 184 字节：>100 触发 pax 扩展头，但必须在 255 的 NAME_MAX 之内（ext4/overlayfs
// 单段上限，超过的 tar 流是对的、是文件系统拒收）
const LONG_NAME = `长名-${'很'.repeat(30)}-${'long'.repeat(20)}.txt`
const buildFixture = () => {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true })
  for (let d = 0; d < 5; d++) {
    const dir = join(FIXTURE_ROOT, `sub-${d}`)
    fs.mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 400; i++) {
      // 大小错开：小文件为主，夹几个跨块边界的
      const size = (i * 7 + d) % 997 + (i % 97 === 0 ? 512 : 0)
      fs.writeFileSync(join(dir, `file-${String(i).padStart(4, '0')}.txt`), Buffer.alloc(size, (i + d) % 251))
    }
  }
  fs.mkdirSync(join(FIXTURE_ROOT, 'empty-dir'), { recursive: true })
  fs.mkdirSync(join(FIXTURE_ROOT, '子目录'), { recursive: true })
  fs.writeFileSync(join(FIXTURE_ROOT, '子目录', '你好 世界.txt'), Buffer.from('中文内容'.repeat(100)))
  fs.writeFileSync(join(FIXTURE_ROOT, 'zero.bin'), Buffer.alloc(0))
  fs.writeFileSync(join(FIXTURE_ROOT, LONG_NAME), Buffer.from('long-name-content'))
}
buildFixture()

const hashTree = async (root) => {
  const map = new Map()
  const walk = async (dir, rel) => {
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(full, r)
      else if (e.isFile()) {
        map.set(r, createHash('sha256').update(await fs.promises.readFile(full)).digest('hex'))
      }
    }
  }
  await walk(root, '')
  return map
}

const remoteHashMap = async (remoteRoot) => {
  const out = await remoteExec(`cd '${remoteRoot}' && find . -type f -exec sha256sum {} +`)
  const map = new Map()
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const hash = line.slice(0, 64)
    const p = line.slice(66).replace(/^\.\//, '')
    map.set(p, hash)
  }
  return map
}

const mapsEqual = (a, b) => {
  if (a.size !== b.size) return `数量不等 ${a.size} vs ${b.size}`
  for (const [k, v] of a) if (b.get(k) !== v) return `${k} 哈希不等`
  return null
}

const UP_REMOTE = '/tmp/dox-tar-up'
const localMap = await hashTree(FIXTURE_ROOT)
console.log(`  …fixture ${localMap.size} 个文件就绪`)

await remoteExec(`rm -rf ${UP_REMOTE} && mkdir -p ${UP_REMOTE}`)
const upTasks = await tm.enqueueUpload('s', FIXTURE_ROOT, UP_REMOTE)
check('上传只产生一条任务（整流）', upTasks.length === 1, `${upTasks.length} 条`)
check('任务名带整流模式与文件数', upTasks[0]?.fileName.includes('整流模式'), upTasks[0]?.fileName ?? '')
const upDone = await waitTask(upTasks[0].id)
check('上传完成', upDone.status === 'done', upDone.error ?? '')
check('上传进度精确到字节（transferred == size）', upDone.transferred === upDone.size && upDone.size > 0)

const remoteMap = await remoteHashMap(`${UP_REMOTE}/${basename(FIXTURE_ROOT)}`)
const upDiff = mapsEqual(localMap, remoteMap)
check('远端树 sha256 全量一致', upDiff === null, upDiff ?? '')
await remoteExec(`test -d '${UP_REMOTE}/${basename(FIXTURE_ROOT)}/empty-dir'`)
check('空目录也上去了', true)

// ---- 下载回原树比对 ----
const DL_LOCAL = join(tmpdir(), 'dox-tar-download')
fs.rmSync(DL_LOCAL, { recursive: true, force: true })
fs.mkdirSync(DL_LOCAL, { recursive: true })
const dlTasks = await tm.enqueueDownloadDir('s', `${UP_REMOTE}/${basename(FIXTURE_ROOT)}`, DL_LOCAL)
check('下载只产生一条任务（整流）', dlTasks.length === 1, `${dlTasks.length} 条`)
const dlDone = await waitTask(dlTasks[0].id)
check('下载完成', dlDone.status === 'done', dlDone.error ?? '')
check('下载有真实字节流动', dlDone.transferred > 0, `${dlDone.transferred}`)
const dlMap = await hashTree(join(DL_LOCAL, basename(FIXTURE_ROOT)))
const dlDiff = mapsEqual(localMap, dlMap)
check('下载树与原树 sha256 全量一致', dlDiff === null, dlDiff ?? '')
check('空目录也下来了', fs.existsSync(join(DL_LOCAL, basename(FIXTURE_ROOT), 'empty-dir')))

// ---- 就地复制（粘贴）：服务端 cp -a，不经本机中转 ----
const { SftpService } = await import('../src/main/sftp/SftpService.ts')
const sftpSvc = new SftpService({ sftp: () => Promise.resolve(sftp), getClient: () => ssh })

const cpT0 = Date.now()
await sftpSvc.copyWithin('s', [`${UP_REMOTE}/${basename(FIXTURE_ROOT)}/sub-0`], `${UP_REMOTE}/${basename(FIXTURE_ROOT)}/empty-dir`)
const sub0Local = await hashTree(join(FIXTURE_ROOT, 'sub-0'))
const sub0Copy = await remoteHashMap(`${UP_REMOTE}/${basename(FIXTURE_ROOT)}/empty-dir/sub-0`)
const cpDiff = mapsEqual(sub0Local, sub0Copy)
check(`就地复制子树（${Date.now() - cpT0}ms）sha256 一致`, cpDiff === null, cpDiff ?? '')
await remoteExec(`rm -rf '${UP_REMOTE}/${basename(FIXTURE_ROOT)}/empty-dir/sub-0'`)

// 符号链接复制为链接（cp -a 含 --no-dereference，不跟链）
await remoteExec('ln -sfn /etc/hostname /tmp/dox-link-src')
await sftpSvc.copyWithin('s', ['/tmp/dox-link-src'], UP_REMOTE)
const isLink = await remoteExec(`test -L ${UP_REMOTE}/dox-link-src && echo yes`)
check('符号链接复制为链接（不跟链）', isLink.trim() === 'yes')
await remoteExec(`rm -f /tmp/dox-link-src ${UP_REMOTE}/dox-link-src`)

// ---- 删除：rm 整删 + 符号链接不跟链 ----
// 树里塞一个指向外部的符号链接：删除必须只删链，外面的东西一根汗毛不能少
await remoteExec(
  `mkdir -p /tmp/dox-outside && echo precious > /tmp/dox-outside/keep.txt && ` +
    `ln -sfn /tmp/dox-outside '${UP_REMOTE}/${basename(FIXTURE_ROOT)}/link-out'`
)
const t0 = Date.now()
await sftpSvc.remove('s', `${UP_REMOTE}/${basename(FIXTURE_ROOT)}`, true)
const rmElapsed = Date.now() - t0
check(`rm 整删 2003 文件树（${rmElapsed}ms）`, rmElapsed < 30_000, `${rmElapsed}ms`)
await remoteExec(`test ! -d '${UP_REMOTE}/${basename(FIXTURE_ROOT)}'`)
check('树已删除', true)
const keep = await remoteExec('cat /tmp/dox-outside/keep.txt')
check('符号链接没跟：外部文件原样还在', keep.trim() === 'precious')
await remoteExec('rm -rf /tmp/dox-outside')

// ---- 深度防线（与 agent fs_delete 同一道）----
let rejected = false
try {
  await sftpSvc.remove('s', '/tmp', true)
} catch {
  rejected = true
}
check('过浅路径被拒绝（/tmp 单段）', rejected)

// ---- 批量删除（多选）：502 项分块拼 rm ----
await remoteExec(
  'rm -rf /tmp/dox-many && mkdir -p /tmp/dox-many/d1 /tmp/dox-many/d2 && ' +
    'for i in $(seq 1 500); do echo x > /tmp/dox-many/f$i.txt; done && touch /tmp/dox-many/d1/a /tmp/dox-many/d2/b'
)
const targets = [
  { path: '/tmp/dox-many/d1', isDir: true },
  { path: '/tmp/dox-many/d2', isDir: true },
  ...Array.from({ length: 500 }, (_, i) => ({ path: `/tmp/dox-many/f${i + 1}.txt`, isDir: false }))
]
const t1 = Date.now()
await sftpSvc.removeMany('s', targets)
const manyElapsed = Date.now() - t1
const leftOver = await remoteExec('find /tmp/dox-many -mindepth 1 | wc -l')
check(`批量删除 502 项（${manyElapsed}ms）`, leftOver.trim() === '0', `剩 ${leftOver.trim()} 项`)
await remoteExec('rm -rf /tmp/dox-many')

// ---- 取消：遍历期中断（全部取消必须拦得住上传，见用户报告）----
const abortP = tm.enqueueUpload('s', FIXTURE_ROOT, '/tmp/dox-tar-abort')
tm.cancelAll()
const abortTasks = await abortP
check('遍历期全部取消：没有任务漏进队列', abortTasks.length === 0, `${abortTasks.length} 条`)
check(
  '遍历期全部取消：队列无在途',
  tm.list().every((t) => t.status !== 'pending' && t.status !== 'active')
)

// ---- 取消：下载中流取消，半截文件必须删 ----
await remoteExec('rm -rf /tmp/dox-big-dir && mkdir -p /tmp/dox-big-dir && dd if=/dev/zero of=/tmp/dox-big-dir/big.bin bs=1M count=1024 2>/dev/null')
const DL_CANCEL = join(tmpdir(), 'dox-tar-cancel')
fs.rmSync(DL_CANCEL, { recursive: true, force: true })
fs.mkdirSync(DL_CANCEL, { recursive: true })
const cancelTasks = await tm.enqueueDownloadDir('s', '/tmp/dox-big-dir', DL_CANCEL)
// 等流真正跑起来再取消（别取消在 du 探测上）
for (let i = 0; i < 200; i++) {
  const t = tm.list().find((x) => x.id === cancelTasks[0].id)
  if (t && t.transferred > 0) break
  await new Promise((r) => setTimeout(r, 50))
}
tm.cancelAll()
const cancelDone = await waitTask(cancelTasks[0].id)
check('下载中流取消落定「已取消」而非「失败」', cancelDone.status === 'canceled', cancelDone.error ?? cancelDone.status)
check(
  '取消后半截文件已删',
  !fs.existsSync(join(DL_CANCEL, 'dox-big-dir', 'big.bin'))
)

// ---- 清理 ----
await remoteExec(`rm -rf ${UP_REMOTE} /tmp/dox-tar-abort /tmp/dox-big-dir`)
fs.rmSync(DL_LOCAL, { recursive: true, force: true })
fs.rmSync(DL_CANCEL, { recursive: true, force: true })
ssh.end()
console.log(failed ? '阶段 2 有失败项，停在这' : '阶段 2 通过')
if (failed) process.exit(1)

// ---------- 阶段 3：应用级冒烟（真实 Electron，验主进程接线）----------
console.log('\n阶段 3：Electron UI 拖文件夹上传')
fs.mkdirSync('shots', { recursive: true })
const UI_ROOT = join(tmpdir(), 'dox-tar-ui-fixture')
fs.rmSync(UI_ROOT, { recursive: true, force: true })
fs.mkdirSync(join(UI_ROOT, 'sub'), { recursive: true })
for (let i = 0; i < 50; i++) fs.writeFileSync(join(UI_ROOT, `f${i}.txt`), `ui-${i}`)
fs.writeFileSync(join(UI_ROOT, 'sub', 'inner.txt'), 'inner')

try {
  if (process.platform === 'win32') {
    spawnSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath -like '*Dox\\node_modules\\electron*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
    ], { stdio: 'ignore' })
  } else {
    spawnSync('pkill', ['-f', 'Dox/node_modules/electron'], { stdio: 'ignore' })
  }
} catch { /* 没有正好 */ }

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
await win.locator('button[title="SFTP 文件面板"]').click()
await win.locator('.explorer .row').first().waitFor({ timeout: 15000 })
await win.waitForTimeout(1000)

// CDP 拖文件夹进面板（Playwright 驱动不了原生选择框，拖拽是既有打法）
const cdp = await win.context().newCDPSession(win)
const box = await win.locator('.explorer').boundingBox()
const x = Math.round(box.x + box.width / 2)
const y = Math.round(box.y + box.height / 2)
const data = { items: [], files: [resolve(UI_ROOT)], dragOperationsMask: 1 }
await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data })
await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data })
await win.waitForTimeout(200)
await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data })

let uiTask = null
for (let i = 0; i < 60; i++) {
  await win.waitForTimeout(500)
  const tasks = await win.evaluate(() =>
    [...document.querySelectorAll('.task')].map((t) => ({
      name: (t.querySelector('.task-name')?.textContent ?? '').trim(),
      status: (t.querySelector('.task-status')?.textContent ?? '').replace(/\s+/g, ' ').trim()
    }))
  )
  uiTask = tasks.find((t) => t.name.includes('dox-tar-ui-fixture'))
  if (uiTask && uiTask.status.startsWith('完成')) break
  if (uiTask && uiTask.status.startsWith('失败')) break
}
check('UI 队列出现整流任务', !!uiTask?.name.includes('整流模式'), uiTask?.name ?? '(任务没出现)')
check('UI 上传完成', uiTask?.status.startsWith('完成'), uiTask?.status ?? '')
await win.screenshot({ path: 'shots/60-tar-transfer.png' })

await win.locator('.toolbar button[title="刷新"]').click()
await win.waitForTimeout(1500)
const uiRows = await win.evaluate(() =>
  [...document.querySelectorAll('.explorer .file-list .row .file-name')].map((e) => e.textContent.trim())
)
check('面板能看到上传上去的目录', uiRows.includes('dox-tar-ui-fixture'), JSON.stringify(uiRows))

// 清理远端（终端敲命令，慢打防吃字符）
await win.locator('.terminal-container:visible').first().click()
await win.waitForTimeout(600)
await win.keyboard.type('rm -rf ~/dox-tar-ui-fixture', { delay: 40 })
await win.keyboard.press('Enter')
await win.waitForTimeout(1500)

fs.rmSync(UI_ROOT, { recursive: true, force: true })
fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true })
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
