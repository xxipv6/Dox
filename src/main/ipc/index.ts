import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { IpcChannels } from '../../shared/ipc'
import type {
  CommandSnippet,
  DroppedFile,
  ForwardRuleInput,
  HostKeyDecision,
  SaveSessionInput,
  SshSessionConfig,
  TermSize
} from '../../shared/types'
import type { SessionManager } from '../ssh/SessionManager'
import type { ConfigStore } from '../store/configStore'
import type { SftpService } from '../sftp/SftpService'
import type { TransferManager } from '../sftp/TransferManager'
import type { ForwardManager } from '../forward/ForwardManager'

/** 集中注册所有 IPC 路由 */
export function registerIpc(
  sessionManager: SessionManager,
  configStore: ConfigStore,
  sftpService: SftpService,
  transferManager: TransferManager,
  forwardManager: ForwardManager
): void {
  // ---- SSH 会话 ----
  ipcMain.handle('ssh:connect', (event, config: SshSessionConfig, term: TermSize) =>
    sessionManager.connect(config, event.sender, term)
  )
  // 输入与 resize 为高频消息，用 send/on 避免 handle 的 Promise 开销
  ipcMain.on(IpcChannels.sshInput, (_event, id: string, data: string | Uint8Array) =>
    sessionManager.write(id, data)
  )
  ipcMain.on(IpcChannels.sshResize, (_event, id: string, cols: number, rows: number) =>
    sessionManager.resize(id, cols, rows)
  )
  ipcMain.on(IpcChannels.sshDisconnect, (_event, id: string) => sessionManager.disconnect(id))
  ipcMain.on(IpcChannels.sshHostKeyAnswer, (_event, requestId: string, decision: HostKeyDecision) =>
    sessionManager.answerHostKey(requestId, decision)
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
