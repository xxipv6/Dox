import { app, BrowserWindow, ipcMain, Menu, nativeTheme, powerMonitor, shell } from 'electron'
import { existsSync } from 'node:fs'
import { applyNativeTheme, backgroundColorFor } from './theme'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setupCliCommand, flushCliCommand } from './cliCommand'
import { cliInstallStatus, installCli } from './local/cliInstall'
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
import { AgentManager } from './agent/AgentManager'
import { ProcessService } from './proc/ProcessService'
import { AiUsageService } from './aiusage/AiUsageService'
import { ComposeService } from './compose/ComposeService'
import { prewarmShells } from './local/shells'
import { IpcChannels } from '../shared/ipc'
import { registerIpc } from './ipc'
import { setupAutoUpdater } from './updater'

// 注意：不能命名为 __dirname，electron-vite dev 模式会注入同名 polyfill 导致重复声明
const mainDir = dirname(fileURLToPath(import.meta.url))

/*
 * 单实例（CLI 伴侣）：必须在 ready 之前注册。
 * 没拿到锁 = 已有一个实例在跑，本进程的 --cli 参数会经 second-instance
 * 交给它。这里用 app.exit 而不是 app.quit：ready 之前调 quit 不阻止
 * whenReady 回调继续建窗（实测：第二个实例照样开出窗口，CLI 参数全丢）。
 */
if (!setupCliCommand()) {
  app.exit(0)
}
// 渲染层挂载完成才 flush 排队命令（冷启动参数会早于第一帧到达）
ipcMain.on(IpcChannels.cliCommandReady, () => flushCliCommand())
ipcMain.handle(IpcChannels.cliInstall, () => installCli())
ipcMain.handle(IpcChannels.cliStatus, () => cliInstallStatus())

const configStore = new ConfigStore()
const knownHosts = new KnownHostsStore()
// 标签布局与应用设置都放在主进程而非渲染进程 localStorage，
// 后者在打包后的 file:// 源下不落盘，见 LayoutSnapshot 的注释
const layoutStore = new LayoutStore()
const settingsStore = new SettingsStore()
// 已保存会话解析器：id → 完整连接配置（认证信息解密不出主进程）。
// 跳板机建链与断线重连都走它 —— 重连时重新解密，主进程不必常驻明文密码。
const sessionManager = new SessionManager((id) => configStore.resolveConnection(id), knownHosts)
// 容器文件操作桥留一个后注册口：AgentManager 依赖 ContainerManager，构造在更后面
const agentFsHolder: { bridge?: import('./sftp/SftpService').AgentFsBridge } = {}
const sftpService = new SftpService(sessionManager, {
  call: (sessionId, containerName, method, params) => {
    if (!agentFsHolder.bridge) return Promise.reject(new Error('容器文件通道尚未就绪'))
    return agentFsHolder.bridge.call(sessionId, containerName, method, params)
  }
})
const transferManager = new TransferManager(
  (sessionId) => sessionManager.sftp(sessionId),
  // 队列变化广播给所有窗口
  (tasks) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcChannels.transferUpdate, tasks)
    }
  },
  // tar 整流传输要在连接上开 exec 通道
  (sessionId) => sessionManager.getClient(sessionId)
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
const agentManager = new AgentManager(sessionManager, (id) => containerManager.runtimeBinary(id))
agentFsHolder.bridge = agentManager
const processService = new ProcessService((id) => sessionManager.getClient(id), agentManager)
// AI 容量速览：主进程常驻轮询（5 分钟一轮），结果缓存 + 广播
const aiUsageService = new AiUsageService(configStore)
// compose 右键动作：复用会话连接与容器 runtime 探测缓存；输出流式广播给所有窗口
const composeService = new ComposeService(
  (id) => sessionManager.getClient(id),
  (id) => containerManager.runtimeBinary(id)
)
composeService.onEvent = (ev) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannels.composeEvent, ev)
  }
}

// 会话断开时自动停止其转发规则（规则记录会保留，状态置为 stopped），
// 并把它承载的容器终端通道一并收掉
sessionManager.onClosed = (id) => {
  forwardManager.stopBySession(id)
  containerManager.stopBySession(id)
  agentManager.invalidate(id)
}
/*
 * 容器标签独立存活（Dev Containers 式）：关宿主终端标签时，若还有容器
 * exec 通道骑在这条连接上，SessionManager 不掐连接、把它留作孤儿保活；
 * 最后一个容器通道关闭时再真正断开。
 */
sessionManager.shouldKeepAlive = (id) => containerManager.hasActiveChannels(id)
containerManager.onParentDrained = (id) => sessionManager.releaseOrphan(id)
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
  /*
   * ---- 应用菜单：两个平台走两条完全不同的路 ----
   *
   * Windows / Linux：**整个摘掉**。autoHideMenuBar 只是「不画出来」，菜单还在，
   * 它的加速键照样生效：F11 能切全屏（全屏不触发 maximize/unmaximize，标题栏那枚
   * 自绘按钮就停在旧图标上），打包版还留着默认的 DevTools 快捷键；更要紧的是
   * 默认菜单里的「关闭窗口」绑的是 CmdOrCtrl+W —— 用户按 Ctrl+W 想关标签，
   * 结果整扇窗没了。这台窗口本来就是 frame:false 自绘标题栏，菜单没有任何
   * 存在理由（Ctrl+W 由渲染层接管，见 useCloseTabShortcut.ts）。
   *
   * macOS：**不能置空**（系统菜单栏是 ⌘C/⌘V/⌘Q 的唯一来源），也**不能留着默认的**
   * ——默认那条「关闭窗口」的加速键正是 ⌘W。所以自建一份：编辑/应用/窗口这些
   * 用 Electron 的角色菜单还原（⌘C/⌘V/⌘Q 照旧），只把 ⌘W 改成「关闭标签」、
   * 关窗口挪到 ⌘⇧W。这也更合 mac 的习惯：终端、iTerm、Safari 里 ⌘W 都是关当前标签。
   *
   * ⌘W 只能这么绕：菜单加速键优先于网页，渲染层收不到那个 keydown，
   * 所以菜单项点一下 → IPC → 渲染层关标签（menuCloseTab）。
   */
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
  } else {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        {
          label: '文件',
          submenu: [
            {
              label: '关闭标签',
              accelerator: 'Command+W',
              click: () => {
                const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
                win?.webContents.send(IpcChannels.menuCloseTab)
              }
            },
            // 关窗口留在菜单里，但换到 ⌘⇧W —— 关掉整扇窗必须有明确的手指动作
            { label: '关闭窗口', accelerator: 'Command+Shift+W', role: 'close' }
          ]
        },
        // 编辑菜单是 ⌘C/⌘V/⌘A/⌘Z 的宿主，必需；窗口菜单给最小化/缩放
        { role: 'editMenu' },
        // 开发时才给视图菜单（⌘R 重载、⌘⌥I 开发者工具）—— 打包版不留这些快捷键
        ...(process.env['ELECTRON_RENDERER_URL'] ? [{ role: 'viewMenu' as const }] : []),
        { role: 'windowMenu' }
      ])
    )
  }

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
    settingsStore,
    agentManager,
    processService,
    aiUsageService,
    composeService
  )
  aiUsageService.start()
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
