import { app, BrowserWindow, dialog, ipcMain, nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { IpcChannels } from '../../shared/ipc'
import type {
  AppSettings,
  CommandSnippet,
  DroppedFile,
  ForwardRuleInput,
  HostKeyDecision,
  LayoutSnapshot,
  SaveSessionInput,
  SshSessionConfig,
  TermSize
} from '../../shared/types'
import type { LayoutStore } from '../store/layoutStore'
import type { SettingsStore } from '../store/settingsStore'
import type { SessionManager } from '../ssh/SessionManager'
import type { LocalPtyManager } from '../local/LocalPtyManager'
import { LOCAL_ID_PREFIX } from '../local/LocalPtyManager'
import type { ConfigStore } from '../store/configStore'
import type { SftpService } from '../sftp/SftpService'
import { dragOutDir } from '../sftp/dragOut'
import type { TransferManager } from '../sftp/TransferManager'
import type { ForwardManager } from '../forward/ForwardManager'

/** 集中注册所有 IPC 路由 */
export function registerIpc(
  sessionManager: SessionManager,
  configStore: ConfigStore,
  sftpService: SftpService,
  transferManager: TransferManager,
  forwardManager: ForwardManager,
  localPtyManager: LocalPtyManager,
  layoutStore: LayoutStore,
  settingsStore: SettingsStore
): void {
  // 拖拽图标。开发时是仓库根目录下的 build/icon.png；打包后它在 asar 里，
  // 用 nativeImage 读（能穿 asar）。electron-builder 的 files 里已包含它，
  // 万一还是取不到就退回空图 —— 拖拽照常可用，只是没有自定义图标。
  const dragIcon = (() => {
    const p = join(app.getAppPath(), 'build', 'icon.png')
    const img = existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty()
    return img.isEmpty() ? nativeImage.createEmpty() : img
  })()

  // ---- SSH 会话 ----
  ipcMain.handle(
    IpcChannels.sshConnect,
    (event, config: SshSessionConfig, term: TermSize, opts?: { savedSessionId?: string }) =>
      sessionManager.connect(config, event.sender, term, opts)
  )
  // ---- 本地终端 ----
  ipcMain.handle(IpcChannels.localConnect, (event, term: TermSize, shellId?: string) =>
    localPtyManager.spawn(event.sender, term, shellId)
  )
  ipcMain.handle(IpcChannels.localListShells, () => localPtyManager.listShells())
  // 输入 / resize / 断开按 id 前缀路由到本地或 SSH（高频消息用 send/on）
  ipcMain.on(IpcChannels.sshInput, (_event, id: string, data: string | Uint8Array) =>
    id.startsWith(LOCAL_ID_PREFIX) ? localPtyManager.write(id, data) : sessionManager.write(id, data)
  )
  ipcMain.on(IpcChannels.sshResize, (_event, id: string, cols: number, rows: number) =>
    id.startsWith(LOCAL_ID_PREFIX)
      ? localPtyManager.resize(id, cols, rows)
      : sessionManager.resize(id, cols, rows)
  )
  ipcMain.on(IpcChannels.sshDisconnect, (_event, id: string) =>
    id.startsWith(LOCAL_ID_PREFIX) ? localPtyManager.kill(id) : sessionManager.disconnect(id)
  )
  // 本地终端没有重连概念，只对 SSH 会话生效
  ipcMain.on(
    IpcChannels.sshReconnectControl,
    (_event, id: string, action: 'stop' | 'now') => {
      if (!id.startsWith(LOCAL_ID_PREFIX)) sessionManager.reconnectControl(id, action)
    }
  )
  ipcMain.on(IpcChannels.sshHostKeyAnswer, (_event, requestId: string, decision: HostKeyDecision) =>
    sessionManager.answerHostKey(requestId, decision)
  )

  // ---- 应用设置 ----
  ipcMain.handle(IpcChannels.settingsGet, () => settingsStore.get())
  ipcMain.handle(IpcChannels.settingsSet, (_event, settings: AppSettings) =>
    settingsStore.set(settings)
  )

  // ---- 标签布局 ----
  ipcMain.handle(IpcChannels.layoutGet, () => layoutStore.get())
  ipcMain.handle(IpcChannels.layoutSet, (_event, snapshot: LayoutSnapshot) =>
    layoutStore.set(snapshot)
  )

  // ---- 会话配置 ----
  ipcMain.handle(IpcChannels.configList, () => configStore.list())
  ipcMain.handle(IpcChannels.configSave, (_event, input: SaveSessionInput) =>
    configStore.save(input)
  )
  ipcMain.handle(IpcChannels.configDelete, (_event, id: string) => configStore.remove(id))
  ipcMain.handle(IpcChannels.configGetAuth, (_event, id: string) => configStore.resolveAuth(id))

  // ---- SFTP 文件操作 ----
  ipcMain.handle(IpcChannels.sftpList, (_event, sessionId: string, dir: string) =>
    sftpService.list(sessionId, dir)
  )
  ipcMain.handle(IpcChannels.sftpRealpath, (_event, sessionId: string, path: string) =>
    sftpService.realpath(sessionId, path)
  )
  ipcMain.handle(IpcChannels.sftpMkdir, (_event, sessionId: string, path: string) =>
    sftpService.mkdir(sessionId, path)
  )
  ipcMain.handle(IpcChannels.sftpRename, (_event, sessionId: string, from: string, to: string) =>
    sftpService.rename(sessionId, from, to)
  )
  ipcMain.handle(
    IpcChannels.sftpDelete,
    (_event, sessionId: string, path: string, isDir: boolean) =>
      sftpService.remove(sessionId, path, isDir)
  )
  ipcMain.handle(IpcChannels.sftpReadText, (_event, sessionId: string, path: string) =>
    sftpService.readText(sessionId, path)
  )
  ipcMain.handle(
    IpcChannels.sftpWriteText,
    (_event, sessionId: string, path: string, content: string, expectedMtime?: number) =>
      sftpService.writeText(sessionId, path, content, expectedMtime)
  )

  /*
   * 拖出到资源管理器。
   *
   * 必须先下载到本地再由主进程发起原生拖拽 —— 操作系统的拖放协议要的是
   * 一个真实文件路径，渲染进程没法凭远端路径凭空造出一个拖放源。
   * 所以这一步是「下载完才开始拖」，慢是必然的，超限文件在 prepareDragOut
   * 里直接拒绝，避免用户对着「拖了没反应」的界面干等。
   */
  ipcMain.handle(
    IpcChannels.sftpStartDrag,
    async (event, sessionId: string, remotePath: string, fileName: string) => {
      const localPath = await sftpService.prepareDragOut(sessionId, remotePath, fileName, dragOutDir())
      event.sender.startDrag({ file: localPath, icon: dragIcon })
      return localPath
    }
  )
  // 取消：只置一个标记，正在跑的拷贝自己会在下一个数据块处停下来并清理半截文件
  ipcMain.handle(IpcChannels.sftpCancelDrag, (_event, sessionId: string) =>
    sftpService.cancelDragOut(sessionId)
  )

  // ---- 传输队列 ----
  ipcMain.handle(IpcChannels.transferPickUpload, async (event, sessionId: string, remoteDir: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      title: '选择要上传的文件',
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled) return []
    const nested = await Promise.all(
      result.filePaths.map((p) => transferManager.enqueueUpload(sessionId, p, remoteDir))
    )
    return nested.flat()
  })

  ipcMain.handle(
    IpcChannels.transferEnqueueDropped,
    async (_event, sessionId: string, remoteDir: string, files: DroppedFile[]) => {
      const nested = await Promise.all(
        files.map((f) => transferManager.enqueueUpload(sessionId, f.path, remoteDir))
      )
      return nested.flat()
    }
  )

  ipcMain.handle(
    IpcChannels.transferDownload,
    async (event, sessionId: string, remotePath: string, fileName: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showSaveDialog(win!, {
        title: '下载到',
        defaultPath: join(app.getPath('downloads'), fileName)
      })
      if (result.canceled || !result.filePath) return null
      return transferManager.enqueueDownload(sessionId, remotePath, result.filePath)
    }
  )

  ipcMain.handle(
    IpcChannels.transferDownloadDir,
    async (event, sessionId: string, remotePath: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showOpenDialog(win!, {
        title: '选择保存位置（文件夹将下载到所选目录内）',
        defaultPath: app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || !result.filePaths[0]) return []
      return transferManager.enqueueDownloadDir(sessionId, remotePath, result.filePaths[0])
    }
  )

  ipcMain.handle(IpcChannels.transferList, () => transferManager.list())
  ipcMain.handle(IpcChannels.transferCancel, (_event, id: string) => transferManager.cancel(id))
  ipcMain.handle(IpcChannels.transferClearFinished, () => transferManager.clearFinished())
  ipcMain.handle(IpcChannels.transferCancelAll, () => transferManager.cancelAll())

  // ---- 端口转发 ----
  ipcMain.handle(IpcChannels.forwardList, () => forwardManager.list())
  ipcMain.handle(IpcChannels.forwardAdd, (_event, input: ForwardRuleInput) =>
    forwardManager.add(input)
  )
  ipcMain.handle(IpcChannels.forwardRemove, (_event, id: string) => forwardManager.remove(id))

  // ---- 快捷命令片段 ----
  ipcMain.handle(IpcChannels.snippetList, () => configStore.listSnippets())
  ipcMain.handle(IpcChannels.snippetSave, (_event, input: Omit<CommandSnippet, 'id'> & { id?: string }) =>
    configStore.saveSnippet(input)
  )
  ipcMain.handle(IpcChannels.snippetDelete, (_event, id: string) => configStore.removeSnippet(id))

  // ---- rz/sz（ZMODEM） ----
  ipcMain.handle(IpcChannels.dialogPickDirectory, async (event, title: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      title,
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(IpcChannels.zmodemPickReadFiles, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      title: '选择要上传到远端的文件（rz）',
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled) return []
    const files = []
    for (const p of result.filePaths) {
      const stat = await fs.stat(p)
      if (!stat.isFile()) continue
      if (stat.size > 256 * 1024 * 1024) {
        throw new Error(`文件 ${basename(p)} 超过 256MB，ZMODEM 内存传输模式不支持`)
      }
      files.push({ name: basename(p), size: stat.size, data: await fs.readFile(p) })
    }
    return files
  })

  ipcMain.handle(
    IpcChannels.zmodemWriteFile,
    async (_event, dir: string, name: string, data: Uint8Array) => {
      // 防路径穿越：只取文件名部分
      const safe = name.split(/[\\/]/).pop() || 'download.bin'
      const ext = extname(safe)
      const stem = basename(safe, ext)
      let target = join(dir, safe)
      let n = 1
      while (existsSync(target)) {
        target = join(dir, `${stem}-${n++}${ext}`)
      }
      await fs.writeFile(target, Buffer.from(data))
      return target
    }
  )
}
