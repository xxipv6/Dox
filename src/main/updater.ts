import { app, BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
// electron-updater 是 CJS 包，ESM 下需默认导入后解构
import updaterPkg from 'electron-updater'
import { IpcChannels } from '../shared/ipc'
import { agentVersionOlder } from '../shared/agentVersion'
import type { UpdaterPhase, UpdaterSource, UpdaterState } from '../shared/types'

const { autoUpdater } = updaterPkg

/**
 * 应用内自动更新。
 *
 * 源策略（项目负责人拍板）：**镜像优先**。主源是 gh-proxy 代理的 GitHub
 * Releases `latest/download/` 目录（generic feed，`latest` 是 GitHub 的固定
 * 入口，URL 不随版本变）；检查或下载失败自动回退 GitHub 直连；再失败由
 * UI 给手动下载链接。exe 的 sha512 由 latest.yml 强制校验，镜像传错内容
 * 装不上，所以走第三方代理不降级安全性。
 *
 * macOS 未签名构建：Squirrel.Mac 要比对更新前后的签名证书，没证书直接拒绝。
 * 启动时用 codesign 探一次 Developer ID，没签就 supported=false —— 但仍做
 * 「轻量检查」：只拉 latest-mac.yml 比版本号（不下载不安装，签名管不着这个），
 * 发现新版就提醒用户去镜像手动下载 dmg，而不是让 mac 用户永远不知道有新版。
 */
/** generic 镜像基地址：必须以 / 结尾，updater 会在后面拼 latest.yml / 文件名 */
const MIRROR_FEED = 'https://gh-proxy.org/https://github.com/xxipv6/Dox/releases/latest/download/'
/** 同一入口的 GitHub 直连版（轻量检查的兜底源；完整更新走 github provider） */
const GITHUB_FEED_BASE = 'https://github.com/xxipv6/Dox/releases/latest/download/'
const GITHUB_FEED = { provider: 'github', owner: 'xxipv6', repo: 'Dox' } as const
const SOURCE_ORDER: UpdaterSource[] = ['mirror', 'github']
/** 手动下载的兜底页（拿不到具体文件名时用） */
const RELEASES_PAGE = 'https://github.com/xxipv6/Dox/releases/latest'
/** 各平台的更新清单文件名（electron-updater 约定） */
const CHANNEL_FILE =
  process.platform === 'darwin' ? 'latest-mac.yml' : process.platform === 'win32' ? 'latest.yml' : 'latest-linux.yml'
/**
 * 下载停滞判定：最后一次进度事件后这么久没动静就当挂了。
 * electron-updater（6.8）没有停滞超时也没有 cancelDownload，被代理中介的
 * TCP 流可以永远吊着不报错 —— 只能自己看门。
 */
const STALL_TIMEOUT_MS = 60_000

let state: UpdaterState = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  // darwin 要等 codesign 探测结果（detectSupported 里落定），先按不支持算，
  // 免得探测完成前手动检查溜进 electron-updater 然后必败
  supported: app.isPackaged && process.platform !== 'darwin'
}

/** 本轮已试过的源（一轮 = 一次检查到「落地/最终失败」为止） */
const triedSources = new Set<UpdaterSource>()
/** 发现/下载中的新版本号：广播与手动下载链接都要用 */
let pendingVersion: string | undefined
/** 下载停滞看门狗（见 STALL_TIMEOUT_MS） */
let stallTimer: ReturnType<typeof setTimeout> | undefined

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send(IpcChannels.updaterEvent, state)
  }
}

function setPhase(phase: UpdaterPhase, patch: Partial<UpdaterState> = {}): void {
  state = { ...state, ...patch, phase }
  broadcast()
}

/** 每次进度事件重置看门狗；停滞超时 → 转成可见的失败态（用户可换源重试） */
function armStallWatchdog(): void {
  clearTimeout(stallTimer)
  stallTimer = setTimeout(() => {
    if (state.phase !== 'downloading') return
    console.warn('[updater] 下载停滞超过 60s，转为失败态')
    setPhase('error', {
      error: '下载长时间没有进展（网络或镜像不稳定），请重试',
      manualUrl: manualUrlFor(pendingVersion)
    })
  }, STALL_TIMEOUT_MS)
}

function disarmStallWatchdog(): void {
  clearTimeout(stallTimer)
  stallTimer = undefined
}

function feedFor(source: UpdaterSource): void {
  if (source === 'mirror') {
    autoUpdater.setFeedURL({ provider: 'generic', url: MIRROR_FEED, channel: 'latest' })
  } else {
    autoUpdater.setFeedURL(GITHUB_FEED)
  }
}

function manualUrlFor(version?: string): string {
  if (!version) return RELEASES_PAGE
  // 安装包文件名是 electron-builder 默认 artifactName（v0.1.5 发版资产实测）
  if (process.platform === 'win32') return `${MIRROR_FEED}Dox-Setup-${version}.exe`
  if (process.platform === 'darwin') return `${MIRROR_FEED}Dox-${version}-arm64.dmg`
  return RELEASES_PAGE
}

async function check(manual = false): Promise<void> {
  // 进行中不叠检查；已下好的不动 —— 再查只会把「待安装」状态刷掉
  if (state.phase === 'checking' || state.phase === 'downloading') return
  if (state.phase === 'downloaded') return
  disarmStallWatchdog()
  triedSources.clear()
  pendingVersion = undefined
  setPhase('checking', { error: undefined })
  if (!state.supported) {
    await lightweightCheck(manual)
    return
  }
  await checkWith('mirror')
}

/**
 * 轻量检查：只拉清单比版本号，给「不支持自动更新」的构建（未签名 mac）用。
 * 镜像 → GitHub 直连两源都试；发现新版 → available + manualUrl（UI 提醒
 * 手动下载）。版本比较复用 agent 的 semver 比较（名字带 agent 但就是通用
 * x.y.z 比较）。
 */
async function lightweightCheck(manual: boolean): Promise<void> {
  let lastErr: unknown
  for (const base of [MIRROR_FEED, GITHUB_FEED_BASE]) {
    try {
      const res = await fetch(`${base}${CHANNEL_FILE}`, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const version = (await res.text()).match(/^version:\s*(\S+)/m)?.[1]
      if (!version) throw new Error(`${CHANNEL_FILE} 里没有版本号`)
      if (agentVersionOlder(state.currentVersion, version)) {
        pendingVersion = version
        setPhase('available', { version, manualUrl: manualUrlFor(version) })
      } else {
        setPhase('up-to-date')
      }
      return
    } catch (err) {
      console.warn(`[updater] 轻量检查 ${base} 失败:`, err instanceof Error ? err.message : err)
      lastErr = err
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
  // 已经确认过「有新版」时，一次网络抖动不该把这个事实抹掉 —— 保持 available
  if (pendingVersion) {
    setPhase('available', { version: pendingVersion, manualUrl: manualUrlFor(pendingVersion) })
  } else if (manual) {
    // 手动点击要给交代；兜底链接用 GitHub 发布页而不是刚失败的镜像深链
    setPhase('error', { error: msg, manualUrl: RELEASES_PAGE })
  } else {
    // 自动检查失败就安静待着（下轮再试）
    setPhase('idle')
  }
}

async function checkWith(source: UpdaterSource): Promise<void> {
  triedSources.add(source)
  feedFor(source)
  state = { ...state, source }
  broadcast() // 换源也要立即广播：设置里的「正在检查…（XX 源）」不能指错对象
  try {
    // 后续进展（发现新版本 / 已最新 / 进度 / 下完）全部走事件；
    // 失败时 error 事件与这个 reject 都会来 —— 统一在 onError 里处理，
    // 这里吞掉即可（不然换源重试会被执行两遍）
    await autoUpdater.checkForUpdates()
  } catch {
    /* 见上 */
  }
}

function onError(err: Error): void {
  disarmStallWatchdog()
  const failedOn = state.source ?? 'mirror'
  console.warn(`[updater] ${failedOn} 源失败:`, err.message)
  const next = SOURCE_ORDER.find((s) => !triedSources.has(s))
  if (next) {
    // 换源重查：下载阶段挂掉也走这条路（重新检查会重新下载，已下的部分作废）
    setPhase('checking')
    void checkWith(next)
    return
  }
  setPhase('error', { error: err.message, manualUrl: manualUrlFor(pendingVersion) })
}

export function updaterGetState(): UpdaterState {
  return state
}

export function updaterCheckNow(): Promise<void> {
  return check(true)
}

export function updaterQuitAndInstall(): void {
  // (true, true)：静默安装 + 装完自动拉起。静默的 assisted 安装包会从注册表
  // 读回用户原来的安装目录（自选目录不丢）；默认的 (false) 会把安装向导
  // 整个弹出来让用户再点一遍，那不是「重启更新」是「重新安装」。
  autoUpdater.quitAndInstall(true, true)
}

/** macOS：没签 Developer ID 的构建 Squirrel.Mac 拒绝更新，启动时探一次 */
async function detectSupported(): Promise<boolean> {
  if (!app.isPackaged) return false
  if (process.platform !== 'darwin') return true
  // execPath = Dox.app/Contents/MacOS/Dox → 上两级是 .app 包
  const bundleDir = join(dirname(process.execPath), '..', '..')
  return await new Promise<boolean>((resolve) => {
    // codesign -dv 的信息全走 stderr；未签名/自荐签名时没有 Authority 行
    execFile('/usr/bin/codesign', ['-dv', bundleDir], { timeout: 5000 }, (_err, _stdout, stderr) => {
      resolve(String(stderr).includes('Authority=Developer ID Application'))
    })
  })
}

export function setupAutoUpdater(): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  // 下好后用户直接退出也顺手装上（设置里的「重启安装」是主动路径，这是兜底）
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    pendingVersion = info.version
    armStallWatchdog() // autoDownload 即刻开始下载，首个进度事件前也可能吊死
    setPhase('available', { version: info.version, error: undefined })
  })
  autoUpdater.on('update-not-available', () => setPhase('up-to-date'))
  autoUpdater.on('download-progress', (p) => {
    armStallWatchdog()
    setPhase('downloading', {
      percent: p.percent,
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    disarmStallWatchdog()
    pendingVersion = info.version
    setPhase('downloaded', { version: info.version, error: undefined, manualUrl: undefined })
  })
  autoUpdater.on('error', onError)

  void detectSupported().then((supported) => {
    state = { ...state, supported }
    if (!supported && !state.manualUrl) {
      // 不支持的构建手动下载按钮常驻 —— 链接不能等出错才有
      state = { ...state, manualUrl: RELEASES_PAGE }
    }
    broadcast()
    // 探测期间用户手动点过「检查更新」并走了轻量路径：现在确认支持了，
    // 补一次完整检查把「available（只提示下载）」推进到真正的后台下载
    if (supported && state.phase === 'available') void check()
    /*
     * 延后 5s 再查：只避开启动第一屏（布局恢复 / SSH 重连 / pty 启动）那一两秒，
     * 更新检查本身是一次异步 HTTP 请求，谈不上挤占；再晚（曾经的 45s）就是
     * 用户开应用快一分钟才知道有新版，提示的意义没了。
     */
    const timer = setTimeout(() => {
      void check()
    }, 5_000)
    timer.unref?.()
  })
}
