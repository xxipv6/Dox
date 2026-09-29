/**
 * 容器端口转发（agent 隧道，containerTunnel.ts + agent/tunnel.go）端到端验证：
 *
 *  前置：npm run build；一台有 docker 的 SSH 主机（密码走命令行参数，不进仓库）。
 *  夹具：远端起一次性 alpine 容器（busybox nc 监听 18080，固定应答 dox-tunnel-ok），
 *        容器助手经产品自己的 opt-in 入口安装（agentInstall，与 UI「安装到容器」同一条路）。
 *
 *  -L（本机监听 → 容器内拨目标）：
 *    addForward(type:'local', container) → 本机 net 连 127.0.0.1:listenPort →
 *    字节经 本机→SSH→agent→容器内 nc 走完全程，应答逐字节对上。
 *  -R（容器内监听 → 本机拨目标）：
 *    本机起 echo server；addForward(type:'remote', container) →
 *    容器里 nc 127.0.0.1:listenPort → 本机 echo 收到并回写，容器侧读回。
 *
 * 用法：node scripts/verify-container-tunnel.mjs <host> [port] [user] [password]
 */
import { _electron as electron } from 'playwright'
import { Client } from 'ssh2'
import net from 'node:net'
import { agentVersionOlder, TUNNEL_MIN_AGENT_VERSION } from '../src/shared/agentVersion.ts'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

const host = process.argv[2]
if (!host) {
  console.log('用法：node scripts/verify-container-tunnel.mjs <host> [port] [user] [password]')
  process.exit(1)
}
const port = Number(process.argv[3] ?? 22)
const user = process.argv[4] ?? 'root'
const password = process.argv[5] ?? ''

const CONTAINER = 'dox-tunnel-test'
const IN_PORT = 18080 // 容器内 nc 监听
const L_LOCAL = 18321 // -L：本机监听
const R_IN = 18081 // -R：容器内监听
const R_LOCAL = 18322 // -R：本机 echo server
const MARK = 'dox-tunnel-ok'

// ---------- 夹具：远端一次性容器 ----------
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

await remoteExec(`docker rm -f ${CONTAINER} 2>/dev/null; true`).catch(() => {})
try {
  await remoteExec('docker image inspect alpine:latest >/dev/null 2>&1')
} catch {
  console.log('  ..  远端拉取 alpine:latest')
  await remoteExec('docker pull alpine:latest >/dev/null')
}
await remoteExec(
  `docker run -d --name ${CONTAINER} alpine:latest sh -c "while true; do printf '${MARK}' | nc -l -p ${IN_PORT}; done" >/dev/null`
)
await new Promise((r) => setTimeout(r, 1000))
await remoteExec(`docker exec ${CONTAINER} nc -z 127.0.0.1 ${IN_PORT}`)
check('夹具容器监听就绪（busybox nc :' + IN_PORT + '）', true)

// ---------- 本机 echo server（-R 的目标） ----------
const echoReceived = []
const echo = net.createServer((sock) => {
  sock.on('data', (chunk) => {
    echoReceived.push(chunk.toString())
    sock.write('pong:' + chunk) // 回写验证双向
  })
})
await new Promise((res) => echo.listen(R_LOCAL, '127.0.0.1', res))

let app
const cleanup = async () => {
  try { await remoteExec(`docker rm -f ${CONTAINER}`) } catch {}
  try { ssh.end() } catch {}
  try { echo.close() } catch {}
  try { await app?.close() } catch {}
}

try {
  // 单实例锁下上次的僵尸实例会让本实例启动即退；只杀本仓库的 electron
  if (process.platform === 'win32') {
    const { execFileSync } = await import('node:child_process')
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath -like '*Dox\\node_modules\\electron*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
      ], { stdio: 'ignore' })
    } catch { /* 没有正好 */ }
  }

  app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(1500)

  // 直连（主机指纹此前 e2e 已信任并存入 dox-known-hosts.json）
  const sessionId = await win.evaluate(
    async ({ host, port, user, password }) =>
      window.api.connect(
        { host, port, username: user, auth: { type: 'password', password } },
        { cols: 120, rows: 30 }
      ),
    { host, port, user, password }
  )
  check('SSH 会话建立', typeof sessionId === 'string' && sessionId.length > 0, String(sessionId))

  // 容器助手：状态 → （缺则）opt-in 安装 → 版本门槛
  let st = await win.evaluate(
    ({ sessionId, c }) => window.api.agentStatus(sessionId, c),
    { sessionId, c: CONTAINER }
  )
  if (!st.installed) {
    console.log('  ..  容器助手未安装，走 opt-in 安装（agentInstall）')
    st = await win.evaluate(
      ({ sessionId, c }) => window.api.agentInstall(sessionId, c),
      { sessionId, c: CONTAINER }
    )
  }
  check('容器助手已安装', !!st.installed, JSON.stringify(st))
  check(`助手版本 ≥ ${TUNNEL_MIN_AGENT_VERSION}（tunnel_*）`, !!st.version && !agentVersionOlder(st.version, TUNNEL_MIN_AGENT_VERSION), st.version)

  const waitRule = async (id, want) => {
    for (let i = 0; i < 20; i++) {
      const rules = await win.evaluate(() => window.api.listForwards())
      const r = rules.find((x) => x.id === id)
      if (r?.status === want) return r
      if (r?.status === 'error') throw new Error(`规则 ${id} error: ${r.error}`)
      await win.waitForTimeout(500)
    }
    throw new Error(`规则 ${id} 迟迟不到 ${want}`)
  }

  // ---------- -L：本机监听 → 容器内拨目标 ----------
  const ruleL = await win.evaluate(
    ({ sessionId, c }) =>
      window.api.addForward({
        sessionId,
        type: 'local',
        listenHost: '127.0.0.1',
        listenPort: 18321,
        targetHost: '127.0.0.1',
        targetPort: 18080,
        container: c
      }),
    { sessionId, c: CONTAINER }
  )
  await waitRule(ruleL.id, 'active')
  check('-L 规则 active', true)

  const lResp = await new Promise((resolve, reject) => {
    const sock = net.connect(L_LOCAL, '127.0.0.1')
    let buf = ''
    sock.on('data', (d) => { buf += d.toString(); sock.end() })
    sock.on('close', () => resolve(buf))
    sock.on('error', reject)
    setTimeout(() => { sock.destroy(); reject(new Error('超时，收到: ' + buf)) }, 8000)
  }).catch((e) => String(e))
  check('-L 本机经隧道拿到容器内应答', lResp === MARK, JSON.stringify(lResp))

  // ---------- -R：容器内监听 → 本机拨目标 ----------
  const ruleR = await win.evaluate(
    ({ sessionId, c }) =>
      window.api.addForward({
        sessionId,
        type: 'remote',
        listenHost: '127.0.0.1',
        listenPort: 18081,
        targetHost: '127.0.0.1',
        targetPort: 18322,
        container: c
      }),
    { sessionId, c: CONTAINER }
  )
  await waitRule(ruleR.id, 'active')
  check('-R 规则 active', true)

  // busybox nc 在 stdin EOF 后立刻关连接（-w 留不住），回写路径得让 stdin 多撑一会儿
  const rResp = await remoteExec(
    `docker exec ${CONTAINER} sh -c "(printf 'ping-r'; sleep 2) | nc -w 3 127.0.0.1 ${R_IN}"`
  ).catch((e) => String(e))
  check('-R 容器内连接到达本机 echo', echoReceived.join('').includes('ping-r'), JSON.stringify(echoReceived))
  check('-R 本机回写被容器侧读回', String(rResp).includes('pong:ping-r'), JSON.stringify(rResp))

  // ---------- 收口：删规则 → 隧道断 ----------
  await win.evaluate((id) => window.api.removeForward(id), ruleL.id)
  await win.evaluate((id) => window.api.removeForward(id), ruleR.id)
  await win.waitForTimeout(800)
  const gone = await new Promise((resolve) => {
    const sock = net.connect(L_LOCAL, '127.0.0.1')
    sock.once('connect', () => { sock.destroy(); resolve(false) })
    sock.once('error', () => resolve(true))
  })
  check('删规则后 -L 本机监听已收', gone)
  const rulesLeft = await win.evaluate(() => window.api.listForwards())
  check('规则表已清空', !rulesLeft.some((r) => r.id === ruleL.id || r.id === ruleR.id))

  await win.evaluate((id) => window.api.disconnect(id), sessionId)
} finally {
  await cleanup()
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
