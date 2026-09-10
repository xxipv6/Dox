import { app } from 'electron'
// electron-updater 是 CJS 包，ESM 下需默认导入后解构
import updaterPkg from 'electron-updater'

const { autoUpdater } = updaterPkg

/**
 * 自动更新：从 electron-builder.yml 的 publish 渠道（GitHub Releases）检查更新。
 * 仅打包后启用；开发模式与检查失败都静默降级，不影响主流程。
 */
export function setupAutoUpdater(): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.on('error', (err) => console.warn('[updater] 检查更新失败:', err.message))
  autoUpdater.on('update-available', (info) => console.info('[updater] 发现新版本:', info.version))
  // 下载完成后 checkForUpdatesAndNotify 会弹系统通知，用户重启即安装

  void autoUpdater.checkForUpdatesAndNotify().catch(() => undefined)
}
