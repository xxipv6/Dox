import { app, BrowserWindow, powerMonitor, shell } from 'electron'
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
import { LocalPtyManager } from './local/LocalPtyManager'
import { clearDragOutDir } from './sftp/dragOut'
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
// 会话断开时自动停止其转发规则（规则记录会保留，状态置为 stopped）
sessionManager.onClosed = (id) => forwardManager.stopBySession(id)
// 重连成功后按原参数把该会话的转发规则重新建立起来，
// 否则隧道会无声死掉，用户还以为它开着
sessionManager.onReconnected = (id) => void forwardManager.restartBySession(id)
const localPtyManager = new LocalPtyManager()

// Windows 通知 / 任务栏跳转列表所需
if (process.platform === 'win32') {
  app.setAppUserModelId('com.dox.terminal')
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1a1b26',
    webPreferences: {
      preload: join(mainDir, '../preload/index.mjs'),
      contextIsolation: true,
      // ESM preload 要求关闭 sandbox；安全边界由 contextIsolation 保证
      sandbox: false,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

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
  registerIpc(
    sessionManager,
    configStore,
    sftpService,
    transferManager,
    forwardManager,
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
  localPtyManager.killAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  sessionManager.disconnectAll()
  localPtyManager.killAll()
  // 拖出下载留下的临时文件；不清的话会一直待在用户临时目录里
  void clearDragOutDir()
})
