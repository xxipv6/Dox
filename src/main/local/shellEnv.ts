import { execFile } from 'node:child_process'

/**
 * login shell 环境解析（VS Code 的 resolveShellEnv 同款思路）。
 *
 * 问题：GUI 启动的 Dox 拿到的是 launchd/桌面会话的稀疏环境 —— 用户在
 * ~/.zprofile、~/.bash_profile 里的变量（Homebrew shellenv 就在那）进不来；
 * 而且 process.env 是启动那一刻的快照，Dox 开着的时候在别处改了环境变量，
 * 新开终端也看不见。
 *
 * 解法：每次 spawn 本地终端前，用用户默认 shell 跑一次 login+interactive
 * 拿全量环境，merge 进 pty 环境（login 环境**赢**，这正是目的）。
 * 代价用两层缓存压住：10s TTL + in-flight 去重（布局恢复批量开标签只解析一次）。
 *
 * 标记行防 rc 文件垃圾输出：neofetch/motd 之类全在标记之前，丢弃；
 * `env -0` 用 NUL 分隔，多行值也拆不坏。失败一律回退 process.env，不影响开终端。
 */

const MARKER = '__DOX_ENV_BEGIN__'
/** 解析结果缓存：新标签环境变量「秒级新鲜」就够，不需要次次都跑 */
const TTL_MS = 10_000
const TIMEOUT_MS = 8_000

let cached: { at: number; env: Record<string, string> } | null = null
let inFlight: Promise<Record<string, string> | null> | null = null
/**
 * 连续失败熔断：用户的 rc 文件在无 TTY 下卡死/报错时，每个新标签都为解析
 * 白等 8 秒是不可接受的。连挂两次本会话不再尝试（回退 process.env 照常用）。
 */
let consecutiveFailures = 0

function parseEnvZero(stdout: string): Record<string, string> | null {
  const idx = stdout.indexOf(MARKER)
  if (idx < 0) return null
  let rest = stdout.slice(idx + MARKER.length)
  if (rest.startsWith('\r\n')) rest = rest.slice(2)
  else if (rest.startsWith('\n')) rest = rest.slice(1)
  const env: Record<string, string> = {}
  for (const entry of rest.split('\0')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(entry)
    if (m) env[m[1]] = m[2]
  }
  return Object.keys(env).length > 0 ? env : null
}

/** 用户 login shell 的全量环境；拿不到的平台上（Windows）或失败时返回 null */
export function resolveShellEnv(): Promise<Record<string, string> | null> {
  if (process.platform === 'win32') return Promise.resolve(null)
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.env)
  if (inFlight) return inFlight
  if (consecutiveFailures >= 2) return Promise.resolve(null)

  const shell = process.env['SHELL']
  if (!shell) return Promise.resolve(null)

  inFlight = new Promise<Record<string, string> | null>((resolve) => {
    execFile(
      shell,
      ['-l', '-i', '-c', `echo ${MARKER}; env -0`],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const env = err ? null : parseEnvZero(stdout)
        if (env) {
          cached = { at: Date.now(), env }
          consecutiveFailures = 0
        } else {
          consecutiveFailures++
          if (consecutiveFailures === 2) {
            console.warn('[shell-env] login 环境解析连续失败，本会话停用（回退 process.env）', err?.message ?? '输出无法解析')
          }
        }
        resolve(env)
      }
    )
  }).finally(() => {
    inFlight = null
  })
  return inFlight
}
