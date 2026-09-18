/**
 * 服务器互传（远端 A → 远端 B，TransferManager.enqueueServerCopy）的验证。
 *
 * 两条连接连同一台主机、扮演 A 与 B（sessionId 不同即可，中继逻辑
 * 只认 getSftp/getClient 的入参）：
 *  1. tar 整流：混合树（小文件/子目录/8MB 随机/空目录/中文名）+ 一个
 *     散文件互传 → B 上 sha256 全量比对、空目录在、进度事件见过、
 *     transferred === size。
 *  2. 中流取消：200MB 大文件起步后 cancel → 任务 canceled、B 上无完整文件。
 *  3. 无 tar 回退（fileRelay 逐文件中继）：tarSupport 强制 false 后
 *     同小树再来一遍 → 哈希比对。
 *
 * 用法：node scripts/verify-server-copy.mjs <host> [port] [user] [password]
 * 远端只在 /tmp 建临时目录，结束时删除。
 */
import { Client } from 'ssh2'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// TransferManager.ts 用了构造参数属性（TS 独有语法），要 transform-types 自重入
const host = process.argv[2]
if (host && !process.env.DOX_TAR_E2E) {
  const r = spawnSync(
    process.execPath,
    ['--experimental-transform-types', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, DOX_TAR_E2E: '1' } }
  )
  process.exit(r.status ?? 1)
}
if (!host) {
  console.log('用法：node scripts/verify-server-copy.mjs <host> [port] [user] [password]')
  process.exit(1)
}
const port = Number(process.argv[3] ?? 22)
const user = process.argv[4] ?? 'root'
const password = process.argv[5]

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

const { TransferManager } = await import('../src/main/sftp/TransferManager.ts')

const connect = (label) =>
  new Promise((resolve, reject) => {
    const c = new Client()
    c.on('ready', () => resolve(c))
    c.on('error', (err) => reject(new Error(`${label} 连接失败：${err.message}`)))
    c.connect({ host, port, username: user, password, readyTimeout: 15000 })
  })

const exec = (client, cmd) =>
  new Promise((resolve, reject) => {
    client.exec(cmd, (err, ch) => {
      if (err) return reject(err)
      let out = ''
      let errOut = ''
      ch.on('data', (d) => (out += d))
      ch.stderr.on('data', (d) => (errOut += d))
      ch.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(errOut || `退出码 ${code}`))))
    })
  })

const sftpOf = (client) =>
  new Promise((resolve, reject) => {
    client.sftp((err, s) => (err ? reject(err) : resolve(s)))
  })

const ts = Date.now()
const SRC = `/tmp/dox-relay-src-${ts}`
const DST = `/tmp/dox-relay-dst-${ts}`

const clientA = await connect('A')
const clientB = await connect('B')
const sftpA = await sftpOf(clientA)
const sftpB = await sftpOf(clientB)

let lastTasks = []
let progressSeen = 0
const tm = new TransferManager(
  (id) => Promise.resolve(id === 'A' ? sftpA : sftpB),
  (tasks) => {
    lastTasks = tasks
    for (const t of tasks) if (t.status === 'active' && t.transferred > 0) progressSeen++
  },
  (id) => (id === 'A' ? clientA : clientB)
)

const waitSettled = (ids, timeoutMs = 120000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      const mine = lastTasks.filter((t) => ids.includes(t.id))
      if (mine.length && mine.every((t) => ['done', 'error', 'canceled'].includes(t.status))) {
        clearInterval(timer)
        resolve(mine)
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer)
        reject(new Error('等任务落定超时'))
      }
    }, 100)
  })

// ---------- 造 fixtures（A 上）----------
console.log('准备 fixtures')
await exec(
  clientA,
  `rm -rf ${SRC} ${DST} && mkdir -p ${SRC}/sub ${SRC}/空目录 && ` +
    `echo hello-relay > ${SRC}/a.txt && ` +
    `echo 中文内容 > ${SRC}/中文.txt && ` +
    `dd if=/dev/urandom of=${SRC}/sub/b.bin bs=1M count=1 2>/dev/null && ` +
    `dd if=/dev/urandom of=${SRC}/big.bin bs=1M count=8 2>/dev/null && ` +
    `echo solo > ${SRC}/solo.txt && ` +
    `dd if=/dev/urandom of=${SRC}/huge.bin bs=1M count=200 2>/dev/null`
)

const hashes = (client, dir) =>
  exec(client, `cd ${dir} && find . -type f ! -name huge.bin -exec sha256sum {} + | sort`)

try {
  // ---------- 0. 同台直连（machine-id 相同 → cp -a，零流量）----------
  console.log('阶段 0：同台直连（默认 opts，两连接同 machine-id）')
  const tasks0 = await tm.enqueueServerCopy('A', [SRC, `${SRC}/solo.txt`], 'B', `${DST}0`)
  check('同台：displayName 标注同台直连', tasks0.every((t) => t.fileName.includes('同台直连')))
  const settled0 = await waitSettled(tasks0.map((t) => t.id))
  check('同台：全部完成', settled0.every((t) => t.status === 'done'),
    settled0.map((t) => `${t.fileName}:${t.status}:${t.error ?? ''}`).join(' | '))
  const exp0 = await hashes(clientA, SRC)
  const act0 = await hashes(clientB, `${DST}0/${SRC.split('/').pop()}`)
  check('同台：目录树 sha256 全量一致', exp0 === act0, `\nA:\n${exp0}\nB:\n${act0}`)

  // ---------- 1. tar 整流中继（跳过同台检测）----------
  console.log('阶段 1：tar 整流互传·中继（目录 + 散文件）')
  const tasks1 = await tm.enqueueServerCopy('A', [SRC, `${SRC}/solo.txt`], 'B', DST, { skipSameMachineCheck: true })
  check('整流：目录组一条任务 + 散文件一条', tasks1.length === 2, `实际 ${tasks1.length}`)
  const ids1 = tasks1.map((t) => t.id)
  const settled1 = await waitSettled(ids1)
  check('整流：全部完成', settled1.every((t) => t.status === 'done'),
    settled1.map((t) => `${t.fileName}:${t.status}:${t.error ?? ''}`).join(' | '))
  check('整流：走了中继路线', settled1.every((t) => t.fileName.includes('互传中继')))
  check('整流：进度事件出现过', progressSeen > 0)
  check('整流：总量与已传一致', settled1.every((t) => t.size === 0 || t.transferred === t.size))

  const [expA, actB] = [await hashes(clientA, SRC), await hashes(clientB, `${DST}/${SRC.split('/').pop()}`)]
  check('整流：目录树 sha256 全量一致', expA === actB, `\nA:\n${expA}\nB:\n${actB}`)
  const soloHash = await exec(clientB, `sha256sum ${DST}/solo.txt | awk '{print $1}'`)
  check('整流：散文件落地', soloHash.trim() === (await exec(clientA, `sha256sum ${SRC}/solo.txt | awk '{print $1}'`)).trim())
  await exec(clientB, `test -d ${DST}/${SRC.split('/').pop()}/空目录`)
    .then(() => check('整流：空目录保留', true))
    .catch(() => check('整流：空目录保留', false))

  // ---------- 2. 中流取消 ----------
  console.log('阶段 2：200MB 大文件流中取消')
  const tasks2 = await tm.enqueueServerCopy('A', [`${SRC}/huge.bin`], 'B', DST, { skipSameMachineCheck: true })
  const id2 = tasks2[0].id
  // 等它真的在传（transferred > 0）再取消
  await new Promise((resolve) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      const t = lastTasks.find((x) => x.id === id2)
      if ((t && t.transferred > 0) || Date.now() - t0 > 20000) {
        clearInterval(timer)
        resolve()
      }
    }, 50)
  })
  tm.cancel(id2)
  const settled2 = await waitSettled([id2], 30000)
  check('取消：任务落定 canceled', settled2[0]?.status === 'canceled', `实际 ${settled2[0]?.status}`)
  const hugeSize = await exec(clientB, `stat -c %s ${DST}/huge.bin 2>/dev/null || echo 0`)
  check('取消：B 上无完整文件', parseInt(hugeSize.trim(), 10) < 200 * 1024 * 1024, `大小 ${hugeSize.trim()}`)

  // ---------- 3. 无 tar 回退（fileRelay 逐文件中继） ----------
  console.log('阶段 3：无 tar 回退（逐文件 SFTP 中继）')
  tm['tarSupport'].set('A', false)
  tm['tarSupport'].set('B', false)
  await exec(clientB, `rm -rf ${DST}2`)
  // 排除 huge.bin 的小树：重建一个小目录
  await exec(clientA, `rm -rf ${SRC}-small && mkdir -p ${SRC}-small && cp -r ${SRC}/a.txt ${SRC}/中文.txt ${SRC}/sub ${SRC}/空目录 ${SRC}-small/`)
  const tasks3 = await tm.enqueueServerCopy('A', [`${SRC}-small`], 'B', `${DST}2`, { skipSameMachineCheck: true })
  check('回退：逐文件展开（3 个文件任务）', tasks3.length === 3, `实际 ${tasks3.length}`)
  const settled3 = await waitSettled(tasks3.map((t) => t.id))
  check('回退：全部完成', settled3.every((t) => t.status === 'done'),
    settled3.map((t) => `${t.fileName}:${t.status}:${t.error ?? ''}`).join(' | '))
  const expS = await exec(clientA, `cd ${SRC}-small && find . -type f -exec sha256sum {} + | sort`)
  const actS = await exec(clientB, `cd ${DST}2/${SRC.split('/').pop()}-small && find . -type f -exec sha256sum {} + | sort`)
  check('回退：sha256 全量一致', expS === actS, `\nA:\n${expS}\nB:\n${actS}`)
  await exec(clientB, `test -d ${DST}2/${SRC.split('/').pop()}-small/空目录`)
    .then(() => check('回退：空目录保留', true))
    .catch(() => check('回退：空目录保留', false))

  // ---------- 4. P2P 直传（一次性密钥对；两连接同机但跳过同台检测）----------
  console.log('阶段 4：P2P 直传（临时密钥装/传/清全链路）')
  tm['tarSupport'].set('A', true)
  tm['tarSupport'].set('B', true)
  await exec(clientB, `rm -rf ${DST}3`)
  const tasks4 = await tm.enqueueServerCopy('A', [`${SRC}-small`], 'B', `${DST}3`, {
    skipSameMachineCheck: true,
    p2pTarget: { host, port, username: user }
  })
  const settled4 = await waitSettled(tasks4.map((t) => t.id), 60000)
  check('P2P：任务完成', settled4.every((t) => t.status === 'done'),
    settled4.map((t) => `${t.fileName}:${t.status}:${t.error ?? ''}`).join(' | '))
  check('P2P：走了直传路线', settled4.every((t) => t.fileName.includes('P2P 直传')))
  const act4 = await exec(clientB, `cd ${DST}3/${SRC.split('/').pop()}-small && find . -type f -exec sha256sum {} + | sort`)
  check('P2P：sha256 全量一致', expS === act4, `\nA:\n${expS}\nB:\n${act4}`)
  // 收尾验证：A 的私钥已删、B 的 authorized_keys 无标记残留
  const keyLeft = await exec(clientA, `ls /tmp/.dox-p2p-* 2>/dev/null | wc -l`)
  check('P2P：A 上临时私钥已删除', keyLeft.trim() === '0', `残留 ${keyLeft.trim()}`)
  const markLeft = await exec(clientB, `cat ~/.ssh/authorized_keys 2>/dev/null | grep -c 'dox-p2p-' || true`)
  check('P2P：B 上 authorized_keys 无标记残留', markLeft.trim() === '0', `残留 ${markLeft.trim()}`)
} finally {
  await exec(clientA, `rm -rf ${SRC} ${SRC}-small`).catch(() => undefined)
  await exec(clientB, `rm -rf ${DST} ${DST}0 ${DST}2 ${DST}3`).catch(() => undefined)
  clientA.end()
  clientB.end()
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
