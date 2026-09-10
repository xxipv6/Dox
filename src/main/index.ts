import { app, BrowserWindow, nativeTheme, powerMonitor, shell } from 'electron'
import { existsSync } from 'node:fs'
import { applyNativeTheme, backgroundColorFor } from './theme'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionManager } from './ssh/SessionManager'
import { ConfigStore } from './store/configStore'
import { KnownHostsStore } from './store/knownHosts'
import { LayoutStore } from './store/layoutStore'
import { SettingsStore } from './store/settingsStore'
import { SftpService } from './sftp/SftpService'
import { TransferManager } from './sftp/TransferManager'
import { ForwardManager } from './forward/ForwardManager'
import { ContainerManager } from './container/ContainerManager'
import { LocalPtyManager } from './local/LocalPtyManager'
import { prewarmShells } from './local/shells'
import { IpcChannels } from '../shared/ipc'
import { registerIpc } from './ipc'
import { setupAutoUpdater } from './updater'

// 注意：不能命名为 __dirname，electron-vite dev 模式会注入同名 polyfill 导致重复声明
const mainDir = dirname(fileURLToPath(import.meta.url))

const configStore = new ConfigStore()
const knownHosts = new KnownHostsStore()
// 标签布局与应用设置都放在主进程而非渲染进程 localStorage，
// 后者在打包后的 file:// 源下不落盘，见 LayoutSnapshot 的注释
const layoutStore = new LayoutStore()
const settingsStore = new SettingsStore()
// 已保存会话解析器：id → 完整连接配置（认证信息解密不出主进程）。
// 跳板机建链与断线重连都走它 —— 重连时重新解密，主进程不必常驻明文密码。
const sessionManager = new SessionManager((id) => configStore.resolveConnection(id), knownHosts)
const sftpService = new SftpService(sessionManager)
const transferManager = new TransferManager(
  (sessionId) => sessionManager.sftp(sessionId),
  // 队列变化广播给所有窗口
  (tasks) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcChannels.transferUpdate, tasks)
    }
  }
)
const forwardManager = new ForwardManager(
  (sessionId) => sessionManager.getClient(sessionId),
  (rules) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcChannels.forwardUpdate, rules)
    }
  }
)
/*
 * 容器终端：跑在父 SSH 连接上的一条 docker exec 通道。
 *
 * 它只借父会话的 client，自己不管连接 —— 所以「容器标签不重连」这件事
 * 不需要任何 guard，因为这里根本没有那套代码。
 */
const containerManager = new ContainerManager((id) => sessionManager.getClient(id))

// 会话断开时自动停止其转发规则（规则记录会保留，状态置为 stopped），
// 并把它承载的容器终端通道一并收掉
sessionManager.onClosed = (id) => {
  forwardManager.stopBySession(id)
  containerManager.stopBySession(id)
}
// 重连成功后按原参数把该会话的转发规则重新建立起来，
// 否则隧道会无声死掉，用户还以为它开着
sessionManager.onReconnected = (id) => void forwardManager.restartBySession(id)
const localPtyManager = new LocalPtyManager()

// Windows 通知 / 任务栏跳转列表所需
if (process.platform === 'win32') {
  app.setAppUserModelId('com.dox.terminal')
}

function createWindow(): void {
  // 每次建窗都重新读一次设置，不缓存：macOS 上 activate 会再走一遍这里，
  // 那时用户可能已经在设置里换过主题了
  /*
   * 标题栏：Windows / Linux 上完全自绘，macOS 保留系统红绿灯。
   *
   * Windows 上「自绘那三枚按钮」和「保留系统按钮」不能兼得：系统按钮只能由
   * titleBarOverlay 提供，而它画出来的样子改不了（圆角、悬停、间距全是系统的）。
   * 要自己的样式就只能 frame: false，代价是失去「悬停最大化按钮弹出贴靠布局」
   * —— 双击最大化与边缘拖拽缩放仍由 Electron/Chromium 提供。
   *
   * macOS 反过来：红绿灯在左边、且用户对它的位置有肌肉记忆，
   * 自绘得不偿失，所以用 hiddenInset 让系统继续画，我们只是把内容铺到它下面。
   */
  const isMac = process.platform === 'darwin'
  /*
   * 任务栏 / 窗口图标。
   *
   * 打包后 Windows 用的是写进 exe 的那份（electron-builder 生成），这个选项那时
   * 是多余的；但开发模式下 exe 是 electron.exe，不给它就会一直显示 Electron 的
   * 默认图标 —— 明明刚换过图标，任务栏上却还是旧的那个，很容易以为没生效。
   * build/icon.png 在 electron-builder.yml 的 files 里，asar 内也是同一个相对路径。
   */
  const devIcon = join(mainDir, '../../build/icon.png')
  const win = new BrowserWindow({
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : { frame: false }),
    ...(existsSync(devIcon) ? { icon: devIcon } : {}),
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: backgroundColorFor(settingsStore.get()?.uiTheme),
    webPreferences: {
      preload: join(mainDir, '../preload/index.mjs'),
      contextIsolation: true,
      // ESM preload 要求关闭 sandbox；安全边界由 contextIsolation 保证
      sandbox: false,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  /*
   * 最大化状态要推给渲染层：自绘的那枚按钮得知道该画 □（还原）还是 ❐（最大化）。
   * 事件只在状态真变时推，初值由渲染层挂载时 invoke 一次 windowGetMaximized 拿 ——
   * 只靠事件会漏掉「启动时窗口就是最大化」这种情况（比如上次退出时是最大化）。
   */
  const pushWindowState = (): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(IpcChannels.windowState, { maximized: win.isMaximized() })
  }
  win.on('maximize', pushWindowState)
  win.on('unmaximize', pushWindowState)

  // 外部链接一律交给系统浏览器，不在应用内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(mainDir, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // 先把 nativeTheme 摆正：它决定 <select> 弹出层、滚动条与 confirm() 的外观，
  // 必须在建窗之前设好，否则第一帧的原生控件会是系统默认而不是用户的主题
  applyNativeTheme(settingsStore.get())

  // 系统深浅色变化时（只在 'system' 模式下会走到这里）把窗口底色跟上。
  // 渲染进程那边由 matchMedia 自己响应，不需要额外通知。
  nativeTheme.on('updated', () => {
    applyNativeTheme(settingsStore.get())
  })

  registerIpc(
    sessionManager,
    configStore,
    sftpService,
    transferManager,
    forwardManager,
    containerManager,
    localPtyManager,
    layoutStore,
    settingsStore
  )
  createWindow()
  setupAutoUpdater()
  // 异步预热 shell 列表（含 WSL）——wsl.exe 首次调用可能耗时数秒，
  // 绝不能放在渲染进程的调用路径上同步执行，否则主进程连同所有 IPC 一起冻住
  void prewarmShells()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // 笔记本合盖再打开后，所有长连接其实已经断了。让正在重连的会话立刻重试，
  // 不必再等满退避。已在 §resumeAfterSuspend 说明：未检测到死亡的连接仍靠 keepalive。
  powerMonitor.on('resume', () => sessionManager.resumeAfterSuspend())
})

app.on('window-all-closed', () => {
  sessionManager.disconnectAll()
  containerManager.closeAll()
  localPtyManager.killAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  sessionManager.disconnectAll()
  containerManager.closeAll()
  localPtyManager.killAll()
})
