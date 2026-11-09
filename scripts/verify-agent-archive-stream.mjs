/**
 * agent 0.9 目录归档流真机验证（不改应用布局、不需要 Docker）。
 *
 * 用法：
 *   DOX_TEST_PASS=... node --experimental-transform-types \
 *     scripts/verify-agent-archive-stream.mjs <host> [port] [user]
 *
 * 远端仅在 /tmp 建独立目录并上传本次构建的 agent；本地仅用系统临时目录。
 * 覆盖：3 万文件双向 sha256、单任务、遍历期取消、上传/下载中流取消。
 * 设 DOX_ARCHIVE_TOTAL_BYTES=2147483648 可把 2 GiB 分布到 3 万文件做全量校验；
 * 小目录诊断用 DOX_ARCHIVE_SMALL=1。两种模式都只流式读写，不整树载入内存。
 */
import { Client } from 'ssh2'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { createAgentArchiveIO } from '../src/main/agent/agentArchiveStream.ts'
import { createAgentStreamIO } from '../src/main/agent/agentStream.ts'
import { TransferManager } from '../src/main/sftp/TransferManager.ts'

const host = process.argv[2]
const port = Number(process.argv[3] ?? 22)
const user = process.argv[4] ?? 'root'
const password = process.env.DOX_TEST_PASS
if (!host || !password) {
  console.error('需要 host 参数与 DOX_TEST_PASS 环境变量')
  process.exit(2)
}

let failed = false
const check = (name, condition, detail = '') => {
  console.log(`${condition ? '  ok  ' : '  FAIL '}${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failed = true
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const small = process.env.DOX_ARCHIVE_SMALL === '1'
const directoryCount = small ? 1 : 60
const filesPerDirectory = small ? 3 : 500
const targetContentBytes = Number(process.env.DOX_ARCHIVE_TOTAL_BYTES ?? 0)
if (!Number.isSafeInteger(targetContentBytes) || targetContentBytes < 0) {
  console.error('DOX_ARCHIVE_TOTAL_BYTES 必须是非负安全整数')
  process.exit(2)
}

const runId = randomUUID().slice(0, 8)
const remoteRoot = `/tmp/dox-agent-archive-e2e-${runId}`
const localRoot = join(tmpdir(), `dox-agent-archive-e2e-${runId}`)
const fixture = join(localRoot, 'fixture')
const download = join(localRoot, 'download')
const cancelDownload = join(localRoot, 'cancel-download')
const bigUpload = join(localRoot, 'big-upload')

const ssh = new Client()
let agentStream
let sftp
let tm
const pending = new Map()
const archiveHandlers = new Map()
const calls = []
let nextId = 1
let lineBuffer = ''
let archiveEventCount = 0
const decoder = new StringDecoder('utf8')

const remoteExec = (command) => new Promise((resolve, reject) => {
  ssh.exec(command, (err, stream) => {
    if (err) return reject(err)
    let stdout = ''
    let stderr = ''
    stream.on('data', (d) => { stdout += d })
    stream.stderr.on('data', (d) => { stderr += d })
    stream.on('close', (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(`远端命令退出 ${code}: ${stderr || command}`)))
  })
})

const call = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++
  calls.push(method)
  pending.set(id, { resolve, reject })
  agentStream.write(`${JSON.stringify({ id, method, params })}\n`)
})

const agents = {
  call: (_sessionId, _containerName, method, params) => call(method, params),
  setArchiveHandler: (_sessionId, _containerName, id, cb) => {
    archiveHandlers.set(id, cb)
    return () => archiveHandlers.delete(id)
  }
}

const handleAgentLine = (line) => {
  let msg
  try { msg = JSON.parse(line) } catch (err) {
    console.error(`  无法解析 agent 行：${String(err)}，长度 ${line.length}`)
    return
  }
  if (msg.event === 'archive') {
    archiveEventCount++
    archiveHandlers.get(msg.data?.id)?.(msg.data)
    return
  }
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  if (msg.error) p.reject(new Error(msg.error))
  else p.resolve(msg.result)
}

const waitTask = async (id, timeoutMs = small ? 20_000 : targetContentBytes > 0 ? 1_200_000 : 480_000) => {
  const deadline = Date.now() + timeoutMs
  let lastLog = 0
  while (Date.now() < deadline) {
    const task = tm.list().find((t) => t.id === id)
    if (task && ['done', 'error', 'canceled'].includes(task.status)) return task
    if (Date.now() - lastLog > 10_000) {
      console.log(`  …任务状态 ${task?.status ?? 'missing'}，${task?.transferred ?? 0}/${task?.size ?? 0} 字节，归档事件 ${archiveEventCount}，最近调用 ${calls.slice(-4).join(',')}`)
      lastLog = Date.now()
    }
    await sleep(50)
  }
  const last = tm.list().find((t) => t.id === id)
  if (small) {
    await remoteExec(`pkill -QUIT -f '^${remoteRoot}/dox-agent serve$' || true`).catch(() => '')
    await sleep(500)
  }
  throw new Error(`任务等待超时：${JSON.stringify(last ?? null)}`)
}

const hashTree = async (root) => {
  const result = new Map()
  const walk = async (dir, rel) => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(full, child)
      else if (entry.isFile()) {
        result.set(child, createHash('sha256').update(await fs.promises.readFile(full)).digest('hex'))
      }
    }
  }
  await walk(root, '')
  return result
}

const remoteHashTree = async (root) => {
  const output = await remoteExec(`cd '${root}' && find . -type f -exec sha256sum {} +`)
  const result = new Map()
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    result.set(line.slice(66).replace(/^\.\//, ''), line.slice(0, 64))
  }
  return result
}

const mapDifference = (a, b) => {
  if (a.size !== b.size) return `文件数 ${a.size} != ${b.size}`
  for (const [name, hash] of a) if (b.get(name) !== hash) return `${name} 哈希不一致`
  return null
}

const makeFixture = async () => {
  fs.mkdirSync(fixture, { recursive: true })
  const regularFiles = directoryCount * filesPerDirectory
  const baseSize = targetContentBytes > 0 ? Math.floor(targetContentBytes / regularFiles) : 0
  const remainder = targetContentBytes > 0 ? targetContentBytes % regularFiles : 0
  let distributedBytes = 0
  for (let d = 0; d < directoryCount; d++) {
    const dir = join(fixture, `sub-${String(d).padStart(2, '0')}`)
    fs.mkdirSync(dir, { recursive: true })
    for (let start = 0; start < filesPerDirectory; start += 50) {
      const count = Math.min(50, filesPerDirectory - start)
      await Promise.all(Array.from({ length: count }, (_, offset) => {
        const i = start + offset
        const fileIndex = d * filesPerDirectory + i
        const size = targetContentBytes > 0
          ? baseSize + (fileIndex < remainder ? 1 : 0)
          : (i * 7 + d) % 257
        distributedBytes += size
        return fs.promises.writeFile(
          join(dir, `file-${String(i).padStart(4, '0')}.bin`),
          Buffer.alloc(size, (i + d) % 251)
        )
      }))
    }
  }
  fs.mkdirSync(join(fixture, 'empty-dir'), { recursive: true })
  fs.mkdirSync(join(fixture, '子目录'), { recursive: true })
  await fs.promises.writeFile(join(fixture, '子目录', '你好 世界.txt'), '中文内容\n'.repeat(100))
  await fs.promises.writeFile(join(fixture, 'zero.bin'), Buffer.alloc(0))
  const longName = `长名-${'很'.repeat(30)}-${'long'.repeat(20)}.txt`
  await fs.promises.writeFile(join(fixture, longName), 'long-name-content')
  return distributedBytes
}

const cleanup = async () => {
  try { agentStream?.close() } catch {}
  try { await remoteExec(`rm -rf '${remoteRoot}'`) } catch {}
  try { sftp?.end() } catch {}
  ssh.end()
  fs.rmSync(localRoot, { recursive: true, force: true })
}

try {
  console.log('阶段 1：准备真实 SSH 与隔离 agent')
  await new Promise((resolve, reject) => {
    ssh.on('ready', resolve).on('error', reject).connect({
      host, port, username: user, password, readyTimeout: 10_000
    })
  })
  sftp = await new Promise((resolve, reject) => ssh.sftp((err, value) => err ? reject(err) : resolve(value)))
  await remoteExec(`rm -rf '${remoteRoot}' && mkdir -p '${remoteRoot}'`)
  const remoteArch = (await remoteExec('uname -m')).trim()
  const agentBinary = remoteArch === 'aarch64' || remoteArch === 'arm64'
    ? 'build/agent/dox-agent-linux-arm64'
    : remoteArch === 'x86_64' || remoteArch === 'amd64'
      ? 'build/agent/dox-agent-linux-amd64'
      : null
  if (!agentBinary) throw new Error(`不支持的远端架构：${remoteArch}`)
  await new Promise((resolve, reject) => {
    sftp.fastPut(agentBinary, `${remoteRoot}/dox-agent`, (err) => err ? reject(err) : resolve())
  })
  await remoteExec(`chmod 700 '${remoteRoot}/dox-agent' && '${remoteRoot}/dox-agent' version`)
  agentStream = await new Promise((resolve, reject) => {
    ssh.exec(`${remoteRoot}/dox-agent serve`, { pty: false }, (err, stream) => err ? reject(err) : resolve(stream))
  })
  agentStream.on('data', (chunk) => {
    lineBuffer += decoder.write(chunk)
    for (;;) {
      const index = lineBuffer.indexOf('\n')
      if (index < 0) break
      const line = lineBuffer.slice(0, index)
      lineBuffer = lineBuffer.slice(index + 1)
      handleAgentLine(line)
    }
  })
  agentStream.stderr.on('data', (chunk) => {
    console.error(`  agent stderr: ${chunk.toString('utf8').trim()}`)
  })
  agentStream.on('close', () => {
    console.log(`  agent 通道关闭，待响应 ${pending.size}，归档事件 ${archiveEventCount}`)
    for (const p of pending.values()) p.reject(new Error('agent 通道已关闭'))
    pending.clear()
    for (const [id, cb] of archiveHandlers) {
      cb({ id, type: 'done', error: 'agent 通道已关闭' })
    }
    archiveHandlers.clear()
  })
  const hello = await call('hello', {})
  check('agent 版本为 0.9.5', hello?.version === '0.9.5', hello?.version)

  tm = new TransferManager(() => Promise.resolve(sftp), () => {}, () => ssh)
  const io = {
    cp: async () => { throw new Error('归档测试不应走 docker cp') },
    rmHostStage: async () => {},
    mkdirContainer: async (path) => call('fs_mkdir', { path }),
    statContainer: async (path) => {
      const r = await call('fs_stat', { path })
      return { isDir: r.is_dir, size: r.size }
    },
    listContainer: async (path) => {
      const r = await call('fs_list', { path })
      return r.entries.map((e) => ({
        name: e.name, isDir: e.is_dir, isSymlink: e.is_symlink, size: e.size
      }))
    },
    archive: createAgentArchiveIO(agents, 's', ''),
    stream: createAgentStreamIO(agents, 's', '')
  }

  console.log('阶段 2：生成 3 万文件 fixture 并计算基线')
  const distributedBytes = await makeFixture()
  const localMap = await hashTree(fixture)
  check('fixture 文件数正确', localMap.size === directoryCount * filesPerDirectory + 3, `${localMap.size}`)
  if (targetContentBytes > 0) {
    check(
      'fixture 分布总量正确',
      distributedBytes === targetContentBytes,
      `${(distributedBytes / 1024 ** 3).toFixed(2)} GiB / ${directoryCount * filesPerDirectory} 个文件`
    )
  }

  console.log('阶段 3：归档上传与全量哈希')
  const remoteUp = `${remoteRoot}/up`
  await remoteExec(`mkdir -p '${remoteUp}'`)
  const upTasks = await tm.enqueueUploadContainer('s', '', fixture, remoteUp, io)
  check('3 万文件上传只产生一个任务', upTasks.length === 1, `${upTasks.length}`)
  const upDone = await waitTask(upTasks[0].id)
  check('归档上传完成', upDone.status === 'done', upDone.error ?? upDone.status)
  const remoteMap = await remoteHashTree(`${remoteUp}/${basename(fixture)}`)
  const upDiff = mapDifference(localMap, remoteMap)
  check('远端 3 万文件 SHA-256 全量一致', upDiff === null, upDiff ?? '')
  const emptyUp = await remoteExec(`test -d '${remoteUp}/${basename(fixture)}/empty-dir' && echo yes`)
  check('空目录已上传', emptyUp.trim() === 'yes')

  console.log('阶段 4：归档下载与全量哈希')
  fs.mkdirSync(download, { recursive: true })
  const downTasks = await tm.enqueueDownloadDirContainer(
    's', '', `${remoteUp}/${basename(fixture)}`, download, io
  )
  check('3 万文件下载只产生一个任务', downTasks.length === 1, `${downTasks.length}`)
  const downDone = await waitTask(downTasks[0].id)
  check('归档下载完成', downDone.status === 'done', downDone.error ?? downDone.status)
  const downloadMap = await hashTree(join(download, basename(fixture)))
  const downDiff = mapDifference(localMap, downloadMap)
  check('下载 3 万文件 SHA-256 全量一致', downDiff === null, downDiff ?? '')
  check('空目录已下载', fs.existsSync(join(download, basename(fixture), 'empty-dir')))

  console.log('阶段 5：遍历期与中流取消')
  const expansion = tm.enqueueUploadContainer('s', '', fixture, `${remoteRoot}/cancel-expansion`, io)
  tm.cancelAll()
  const expansionTasks = await expansion
  check('遍历期全部取消没有任务入队', expansionTasks.length === 0, `${expansionTasks.length}`)

  fs.mkdirSync(bigUpload, { recursive: true })
  const bigFile = join(bigUpload, 'big.bin')
  await fs.promises.writeFile(bigFile, Buffer.alloc(0))
  await fs.promises.truncate(bigFile, 512 * 1024 * 1024)
  const cancelUpTasks = await tm.enqueueUploadContainer('s', '', bigUpload, `${remoteRoot}/cancel-up`, io)
  const upId = cancelUpTasks[0].id
  for (let i = 0; i < 400; i++) {
    const task = tm.list().find((t) => t.id === upId)
    if (task?.transferred > 0) break
    await sleep(25)
  }
  let t0 = performance.now()
  tm.cancelAll()
  const cancelUpDone = await waitTask(upId, 10_000)
  const cancelUpMs = Math.round(performance.now() - t0)
  check('上传中流取消状态正确', cancelUpDone.status === 'canceled', cancelUpDone.status)
  check('上传取消在 2 秒内落定', cancelUpMs < 2000, `${cancelUpMs}ms`)
  check('上传取消发送了远端 abort', calls.includes('fs_extract_abort'))
  await call('fs_stat', { path: remoteRoot })
  check('上传取消后 agent 仍可响应', true)

  const remoteBig = `${remoteRoot}/remote-big`
  await remoteExec(`mkdir -p '${remoteBig}' && truncate -s 512M '${remoteBig}/big.bin'`)
  fs.mkdirSync(cancelDownload, { recursive: true })
  const cancelDownTasks = await tm.enqueueDownloadDirContainer('s', '', remoteBig, cancelDownload, io)
  const downId = cancelDownTasks[0].id
  for (let i = 0; i < 400; i++) {
    const task = tm.list().find((t) => t.id === downId)
    if (task?.transferred > 0) break
    await sleep(25)
  }
  t0 = performance.now()
  tm.cancelAll()
  const cancelDownDone = await waitTask(downId, 10_000)
  const cancelDownMs = Math.round(performance.now() - t0)
  check('下载中流取消状态正确', cancelDownDone.status === 'canceled', cancelDownDone.status)
  check('下载取消在 2 秒内落定', cancelDownMs < 2000, `${cancelDownMs}ms`)
  check('下载当前半截文件已删除', !fs.existsSync(join(cancelDownload, 'remote-big', 'big.bin')))
  await call('fs_stat', { path: remoteRoot })
  check('下载取消后 agent 仍可响应', true)

  const singleLocal = join(cancelDownload, 'single-big.bin')
  const singleTask = await tm.enqueueDownloadContainer('s', '', `${remoteBig}/big.bin`, singleLocal, io)
  const singleId = singleTask.id
  for (let i = 0; i < 400; i++) {
    const task = tm.list().find((t) => t.id === singleId)
    if (task?.transferred > 0) break
    await sleep(25)
  }
  t0 = performance.now()
  tm.cancel(singleId)
  const singleDone = await waitTask(singleId, 10_000)
  const singleCancelMs = Math.round(performance.now() - t0)
  check('单文件直传取消状态正确', singleDone.status === 'canceled', singleDone.status)
  check('单文件直传取消在 2 秒内落定', singleCancelMs < 2000, `${singleCancelMs}ms`)
  check('单文件直传取消删除半截文件', !fs.existsSync(singleLocal))
  await call('fs_stat', { path: remoteRoot })
  check('单文件取消后 agent 仍可响应', true)
} catch (err) {
  check('测试执行未出现异常', false, err instanceof Error ? err.stack : String(err))
} finally {
  await cleanup()
}

console.log(failed ? '\n存在失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
