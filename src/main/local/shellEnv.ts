import { execFile } from 'node:child_process'

/**
 * 新本地终端的环境解析（VS Code 的 resolveShellEnv 同款思路）。
 *
 * 问题：GUI 启动的 Dox 拿到的是 launchd/桌面会话的稀疏环境，而且
 * process.env 是启动那一刻的快照 —— Dox 开着的时候在别处改了环境变量
 * （macOS 上改 ~/.zprofile、Windows 上改系统属性里的环境变量），
 * 新开终端也看不见。
 *
 * 解法：每次 spawn 本地终端前抓一份「现在」的环境 merge 进 pty 环境
 * （新环境**赢**，这正是目的）：
 * - macOS/Linux：用用户默认 shell 跑一次 login+interactive 拿全量环境
 *   （~/.zprofile 里的 Homebrew shellenv 这类变量也进得来）
 * - Windows：没有 login shell 概念，但新进程的环境来自注册表（HKLM
 *   ...\Session Manager\Environment + HKCU\Environment，Explorer 在
 *   WM_SETTINGCHANGE 后也是从这里取）——直接读注册表就是最新环境
 *
 * 代价用两层缓存压住：10s TTL + in-flight 去重（布局恢复批量开标签只解析一次）。
 * 连续失败 2 次熔断：rc 文件卡死/PowerShell 不可用时，不为每个标签白等 8s。
 * 失败一律回退 process.env，不影响开终端。
 */

const MARKER = '__DOX_ENV_BEGIN__'
/** 解析结果缓存：新标签环境变量「秒级新鲜」就够，不需要次次都跑 */
const TTL_MS = 10_000
const TIMEOUT_MS = 8_000

let cached: { at: number; env: Record<string, string> } | null = null
let inFlight: Promise<Record<string, string> | null> | null = null
let consecutiveFailures = 0

// ---- POSIX：login+interactive shell 抓全量环境 ----

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

function fetchPosixEnv(): Promise<Record<string, string> | null> {
  const shell = process.env['SHELL']
  if (!shell) return Promise.resolve(null)
  return new Promise((resolve) => {
    // 标记行防 rc 文件垃圾输出：neofetch/motd 之类全在标记之前，丢弃；
    // `env -0` 用 NUL 分隔，多行值也拆不坏
    execFile(
      shell,
      ['-l', '-i', '-c', `echo ${MARKER}; env -0`],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : parseEnvZero(stdout))
    )
  })
}

// ---- Windows：注册表 Machine+User 就是新进程会拿到的环境 ----

/**
 * 注册表读法刻意走 PowerShell 的 .NET API 而不是 reg query：
 * GetEnvironmentVariables(target) 直接读注册表并顺手展开 REG_EXPAND_SZ
 * （系统 PATH 里的 %SystemRoot% 这类引用）；reg.exe 的输出走控制台 OEM
 * 代码页（中文机 GBK），值里的中文目录按 UTF-8 解码会坏。
 */
function fetchWindowsEnv(): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
          'ConvertTo-Json -Compress @{' +
          'machine=[Environment]::GetEnvironmentVariables("Machine");' +
          'user=[Environment]::GetEnvironmentVariables("User")' +
          '}'
      ],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        try {
          const { machine, user } = JSON.parse(stdout) as {
            machine: Record<string, string>
            user: Record<string, string>
          }
          resolve(composeWindowsEnv(machine, user))
        } catch {
          resolve(null)
        }
      }
    )
  })
}

/**
 * Windows 环境合成规则（新进程从 Explorer 拿到的就是这套）：
 * 变量名不区分大小写，User 覆盖 Machine；PATH 是特例 —— 系统 PATH 在前、
 * 用户 PATH 追加在后（不是覆盖）。
 */
function composeWindowsEnv(
  machine: Record<string, string>,
  user: Record<string, string>
): Record<string, string> | null {
  const out = new Map<string, { name: string; value: string }>()
  const put = (name: string, value: string): void => {
    out.set(name.toLowerCase(), { name, value })
  }
  const get = (src: Record<string, string>, key: string): string | undefined => {
    const hit = Object.keys(src).find((k) => k.toLowerCase() === key)
    return hit ? src[hit] : undefined
  }
  for (const [k, v] of Object.entries(machine)) put(k, String(v))
  for (const [k, v] of Object.entries(user)) put(k, String(v))
  const machinePath = get(machine, 'path')
  const userPath = get(user, 'path')
  if (machinePath || userPath) {
    put(out.get('path')?.name ?? 'Path', [machinePath, userPath].filter(Boolean).join(';'))
  }
  if (out.size === 0) return null
  return Object.fromEntries([...out.values()].map(({ name, value }) => [name, value]))
}

/** 「现在」的全量环境；抓不到（或连续失败熔断）时返回 null，调用方回退 process.env */
export function resolveShellEnv(): Promise<Record<string, string> | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.env)
  if (inFlight) return inFlight
  if (consecutiveFailures >= 2) return Promise.resolve(null)

  inFlight = (process.platform === 'win32' ? fetchWindowsEnv() : fetchPosixEnv())
    .then((env) => {
      if (env) {
        cached = { at: Date.now(), env }
        consecutiveFailures = 0
      } else {
        consecutiveFailures++
        if (consecutiveFailures === 2) {
          console.warn('[shell-env] 环境解析连续失败，本会话停用（回退 process.env）')
        }
      }
      return env
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/**
 * 合并进 pty env 前的去重：Windows 环境变量名不区分大小写，process.env 的
 * `Path` 和注册表读出来的 `PATH` 同时塞进去会出两个键（交给 CreateProcess
 * 的行为未定义）—— 同名（不区分大小写）只留新值。POSIX 区分大小写，直接铺。
 */
export function mergeEnv(
  base: Record<string, string>,
  overlay: Record<string, string>
): Record<string, string> {
  if (process.platform !== 'win32') return { ...base, ...overlay }
  const overlayKeys = new Set(Object.keys(overlay).map((k) => k.toLowerCase()))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (!overlayKeys.has(k.toLowerCase())) out[k] = v
  }
  return { ...out, ...overlay }
}
