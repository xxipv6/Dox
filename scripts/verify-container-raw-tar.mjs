/**
 * 远端容器 raw-tar 快路径真机回归。
 *
 * 用法：
 *   DOX_TEST_PASS=... DOX_TEST_CONTAINER=sandbox \
 *   node --experimental-transform-types scripts/verify-container-raw-tar.mjs <host> [port] [user]
 *
 * 只在容器 /tmp 建独立目录，不安装/删除 agent，不改应用布局。
 * 覆盖：能力探测、普通文件/子目录/硬链接内容、下载中流取消与半截文件清理。
 */
import { Client } from 'ssh2'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { execCapture } from '../src/main/ssh/remoteExec.ts'
import { createContainerTransferIO } from '../src/main/container/containerTransfer.ts'
import { TransferManager } from '../src/main/sftp/TransferManager.ts'

const host = process.argv[2]
const port = Number(process.argv[3] ?? 22)
const user = process.argv[4] ?? 'root'
const password = process.env.DOX_TEST_PASS
const containerName = process.env.DOX_TEST_CONTAINER ?? 'sandbox'
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
const runId = randomUUID().slice(0, 8)
const remoteRoot = `/tmp/dox-rawtar-e2e-${runId}`
const localRoot = join(tmpdir(), `dox-rawtar-e2e-${runId}`)
const ssh = new Client()
let tm

const remoteExec = async (command, timeoutMs = 30_000) => {
  const result = await execCapture(ssh, command, { timeoutMs })
  return result.stdout
}
const shQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`
const containerExec = (script) => remoteExec(`docker exec ${containerName} sh -c ${shQuote(script)}`)
const waitTerminal = async (id, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const task = tm.list().find((item) => item.id === id)
    if (task && !['pending', 'active'].includes(task.status)) return task
    await sleep(25)
  }
  throw new Error(`任务 ${id} 等待终态超时`)
}

try {
  // 先校验容器名，再把它拼进 docker 命令。
  const io = {
    ...createContainerTransferIO(() => ssh, async () => 'docker', 's', containerName),
    mkdirContainer: async () => { throw new Error('raw-tar 测试不应调用 agent mkdir') },
    statContainer: async () => { throw new Error('raw-tar 测试不应回退 agent stat') },
    listContainer: async () => { throw new Error('raw-tar 测试不应回退 agent list') }
  }
  tm = new TransferManager(
    async () => { throw new Error('raw-tar 测试不应打开 SFTP') },
    () => {},
    () => ssh
  )
  await new Promise((resolve, reject) => {
    ssh.on('ready', resolve).on('error', reject).connect({
      host, port, username: user, password, readyTimeout: 15_000
    })
  })
  const availableContainers = (await remoteExec("docker ps -a --format '{{.Names}}'"))
    .trim().split(/\r?\n/).filter(Boolean)
  if (!availableContainers.includes(containerName)) {
    throw new Error(`远端容器不存在：${containerName}；可用容器：${availableContainers.join(', ') || '(无)'}`)
  }
  await remoteExec(`docker start ${containerName}`)
  await containerExec(
    `mkdir -p '${remoteRoot}/root/sub' '${remoteRoot}/big' && ` +
    `printf 'alpha\\n' > '${remoteRoot}/root/a.txt' && ` +
    `printf 'beta\\n' > '${remoteRoot}/root/sub/b.txt' && ` +
    `ln '${remoteRoot}/root/a.txt' '${remoteRoot}/root/a-hard.txt' && ` +
    `truncate -s 512M '${remoteRoot}/big/big.bin'`
  )

  const downloadDir = join(localRoot, 'download')
  fs.mkdirSync(downloadDir, { recursive: true })
  const tasks = await tm.enqueueDownloadDirContainer('s', containerName, `${remoteRoot}/root`, downloadDir, io)
  check('raw-tar 目录下载只产生一个任务', tasks.length === 1, `${tasks.length}`)
  check('确实选择 raw-tar 快路径', tasks[0]?.fileName.includes('容器原始整流'), tasks[0]?.fileName)
  const done = await waitTerminal(tasks[0].id)
  check('raw-tar 目录下载完成', done.status === 'done', done.error ?? done.status)
  const readLocal = (name) => fs.readFileSync(join(downloadDir, 'root', name), 'utf8')
  check('普通文件内容一致', readLocal('a.txt') === 'alpha\n')
  check('子目录文件内容一致', readLocal('sub/b.txt') === 'beta\n')
  check('硬链接文件没有丢失且内容一致', readLocal('a-hard.txt') === 'alpha\n')

  const cancelDir = join(localRoot, 'cancel')
  fs.mkdirSync(cancelDir, { recursive: true })
  const cancelTasks = await tm.enqueueDownloadDirContainer('s', containerName, `${remoteRoot}/big`, cancelDir, io)
  const cancelId = cancelTasks[0].id
  for (let i = 0; i < 400; i++) {
    const task = tm.list().find((item) => item.id === cancelId)
    if (task?.transferred > 0) break
    await sleep(25)
  }
  const started = performance.now()
  tm.cancel(cancelId)
  const canceled = await waitTerminal(cancelId, 10_000)
  const cancelMs = Math.round(performance.now() - started)
  check('raw-tar 取消状态正确', canceled.status === 'canceled', canceled.error ?? canceled.status)
  check('raw-tar 取消在 2 秒内落定', cancelMs < 2000, `${cancelMs}ms`)
  check('raw-tar 取消删除当前半截文件', !fs.existsSync(join(cancelDir, 'big', 'big.bin')))
} catch (err) {
  check('测试执行未出现异常', false, err instanceof Error ? err.stack : String(err))
} finally {
  if (ssh) {
    try { await containerExec(`rm -rf -- '${remoteRoot}'`) } catch { /* 连接失败时本地仍继续清理 */ }
    ssh.end()
  }
  fs.rmSync(localRoot, { recursive: true, force: true })
}

console.log(failed ? '\n存在失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
