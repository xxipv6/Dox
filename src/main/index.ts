import { app, BrowserWindow, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionManager } from './ssh/SessionManager'
import { ConfigStore } from './store/configStore'
import { KnownHostsStore } from './store/knownHosts'
import { SftpService } from './sftp/SftpService'
import { TransferManager } from './sftp/TransferManager'
import { ForwardManager } from './forward/ForwardManager'
import { IpcChannels } from '../shared/ipc'
import { registerIpc } from './ipc'
import { setupAutoUpdater } from './updater'

// 注意：不能命名为 __dirname，electron-vite dev 模式会注入同名 polyfill 导致重复声明
const mainDir = dirname(fileURLToPath(import.meta.url))

const configStore = new ConfigStore()
const knownHosts = new KnownHostsStore()
// 跳板机解析器：jumpHostId → 完整连接配置（认证信息解密不出主进程）
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
// 会话断开时自动停止其转发规则
sessionManager.onClosed = (id) => forwardManager.stopBySession(id)

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
  registerIpc(sessionManager, configStore, sftpService, transferManager, forwardManager)
  createWindow()
  setupAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  sessionManager.disconnectAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => sessionManager.disconnectAll())
