import { app, BrowserWindow, dialog, ipcMain, nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { IpcChannels } from '../../shared/ipc'
import type {
  AppSettings,
  CommandSnippet,
  ContainerControlAction,
  DownloadRequest,
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
import { isContainerId, isLocalId } from '../../shared/sessionId'
import { applyNativeTheme } from '../theme'
import type { ContainerManager } from '../container/ContainerManager'
import type { ConfigStore } from '../store/configStore'
import type { SftpService } from '../sftp/SftpService'
import type { TransferManager } from '../sftp/TransferManager'
import type { ForwardManager } from '../forward/ForwardManager'
import type { AgentManager } from '../agent/AgentManager'
import { createContainerTransferIO } from '../container/containerTransfer'
import type { ContainerIO } from '../sftp/TransferManager'

/** 集中注册所有 IPC 路由 */
export function registerIpc(
  sessionManager: SessionManager,
  configStore: ConfigStore,
  sftpService: SftpService,
  transferManager: TransferManager,
  forwardManager: ForwardManager,
  containerManager: ContainerManager,
  localPtyManager: LocalPtyManager,
  layoutStore: LayoutStore,
  settingsStore: SettingsStore,
  agentManager: AgentManager
): void {
  // ---- SSH 会话 ----
  ipcMain.handle(
    IpcChannels.sshConnect,
    (event, config: SshSessionConfig, term: TermSize, opts?: { savedSessionId?: string }) =>
      sessionManager.connect(config, event.sender, term, opts)
  )
  /*
   * 传输会话（直连容器的承载）：只收已保存设备 id，凭证不出主进程。
   * 渲染层拿不到也不该拿到这条后台连接的认证信息 —— 它只是容器/文件
   * 操作的传输层，不是给用户用的终端。
   */
  ipcMain.handle(IpcChannels.sshConnectTransport, (event, savedSessionId: string) =>
    sessionManager.connectTransport(configStore.resolveConnection(savedSessionId), event.sender, {
      savedSessionId
    })
  )
  // ---- 本地终端 ----
  ipcMain.handle(IpcChannels.localConnect, (event, term: TermSize, shellId?: string) =>
    localPtyManager.spawn(event.sender, term, shellId)
  )
  ipcMain.handle(IpcChannels.localListShells, () => localPtyManager.listShells())
  /*
   * 输入 / resize / 断开按 id 前缀路由到本地终端、容器终端或 SSH（高频消息用 send/on）。
   *
   * 容器会话跑在父 SSH 连接上，如果落到 sessionManager 手里，
   * disconnect 会 client.end() 掐断整条连接、resize 会去找一条并不存在的 shell ——
   * 前缀是这三条路唯一的分岔口。
   */
  ipcMain.on(IpcChannels.sshInput, (_event, id: string, data: string | Uint8Array) => {
    if (isLocalId(id)) localPtyManager.write(id, data)
    else if (isContainerId(id)) containerManager.write(id, data)
    else sessionManager.write(id, data)
  })
  ipcMain.on(IpcChannels.sshResize, (_event, id: string, cols: number, rows: number) => {
    if (isLocalId(id)) localPtyManager.resize(id, cols, rows)
    else if (isContainerId(id)) containerManager.resize(id, cols, rows)
    else sessionManager.resize(id, cols, rows)
  })
  ipcMain.on(IpcChannels.sshDisconnect, (_event, id: string) => {
    if (isLocalId(id)) localPtyManager.kill(id)
    else if (isContainerId(id)) containerManager.close(id)
    else sessionManager.disconnect(id)
  })
  /*
   * 重连控制**只认 SSH 会话** —— 容器终端没有重连这回事，
   * 本地终端也没有。放容器 id 进重连状态机只会造出「容器在重连」这种无意义循环。
   */
  ipcMain.on(
    IpcChannels.sshReconnectControl,
    (_event, id: string, action: 'stop' | 'now') => {
      if (!isLocalId(id) && !isContainerId(id)) sessionManager.reconnectControl(id, action)
    }
  )
  ipcMain.on(IpcChannels.sshHostKeyAnswer, (_event, requestId: string, decision: HostKeyDecision) =>
    sessionManager.answerHostKey(requestId, decision)
  )

  // ---- 应用设置 ----
  ipcMain.handle(IpcChannels.settingsGet, () => settingsStore.get())
  ipcMain.handle(IpcChannels.settingsSet, (_event, settings: AppSettings) => {
    settingsStore.set(settings)
    // 界面主题不只是渲染进程的事：原生下拉/滚动条吃的是 nativeTheme，
    // 窗口底色也要跟着换。不在这里同步的话，切主题后原生控件仍是旧外观
    applyNativeTheme(settings)
  })

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

  // ---- SFTP 文件操作（containerName 给了就走容器内 agent fs 协议）----
  ipcMain.handle(IpcChannels.sftpList, (_event, sessionId: string, dir: string, containerName?: string) =>
    sftpService.list(sessionId, dir, containerName)
  )
  ipcMain.handle(IpcChannels.sftpRealpath, (_event, sessionId: string, path: string, containerName?: string) =>
    sftpService.realpath(sessionId, path, containerName)
  )
  ipcMain.handle(IpcChannels.sftpStat, (_event, sessionId: string, path: string, containerName?: string) =>
    sftpService.stat(sessionId, path, containerName)
  )
  ipcMain.handle(IpcChannels.sftpMkdir, (_event, sessionId: string, path: string, containerName?: string) =>
    sftpService.mkdir(sessionId, path, containerName)
  )
  ipcMain.handle(IpcChannels.sftpRename, (_event, sessionId: string, from: string, to: string, containerName?: string) =>
    sftpService.rename(sessionId, from, to, containerName)
  )
  ipcMain.handle(
    IpcChannels.sftpDelete,
    (_event, sessionId: string, path: string, isDir: boolean, containerName?: string) =>
      sftpService.remove(sessionId, path, isDir, containerName)
  )
  ipcMain.handle(IpcChannels.sftpReadText, (_event, sessionId: string, path: string, containerName?: string) =>
    sftpService.readText(sessionId, path, containerName)
  )
  ipcMain.handle(
    IpcChannels.sftpWriteText,
    (_event, sessionId: string, path: string, content: string, expectedMtime?: number, containerName?: string) =>
      sftpService.writeText(sessionId, path, content, expectedMtime, containerName)
  )
  ipcMain.handle(IpcChannels.sftpArchive, (_event, sessionId: string, paths: string[], containerName?: string) =>
    sftpService.archive(sessionId, paths, containerName)
  )
  ipcMain.handle(IpcChannels.remoteListeners, (_event, sessionId: string) =>
    sessionManager.remoteListeners(sessionId)
  )
  ipcMain.handle(IpcChannels.agentStatus, (_event, sessionId: string, containerName?: string) =>
    agentManager.status(sessionId, containerName)
  )
  ipcMain.handle(IpcChannels.agentInstall, (_event, sessionId: string, containerName?: string) =>
    agentManager.install(sessionId, containerName)
  )
  ipcMain.handle(IpcChannels.agentWatchPorts, (event, sessionId: string, containerName?: string) =>
    agentManager.watchPorts(sessionId, containerName, event.sender)
  )
  ipcMain.handle(IpcChannels.agentUnwatchPorts, (event, sessionId: string, containerName?: string) =>
    agentManager.unwatchPorts(sessionId, containerName, event.sender)
  )
  ipcMain.handle(IpcChannels.agentWatchStats, (event, sessionId: string, containerName?: string) =>
    agentManager.watchStats(sessionId, containerName, event.sender)
  )
  ipcMain.handle(IpcChannels.agentUnwatchStats, (event, sessionId: string, containerName?: string) =>
    agentManager.unwatchStats(sessionId, containerName, event.sender)
  )
  ipcMain.handle(IpcChannels.agentFsHold, (event, sessionId: string, containerName?: string) =>
    agentManager.holdChannel(sessionId, containerName, event.sender)
  )
  ipcMain.handle(IpcChannels.agentFsRelease, (event, sessionId: string, containerName?: string) =>
    agentManager.releaseChannel(sessionId, containerName, event.sender)
  )

  // ---- 容器终端 ----
  ipcMain.handle(IpcChannels.containerList, (_event, parentSessionId: string) =>
    containerManager.list(parentSessionId)
  )
  ipcMain.handle(
    IpcChannels.containerConnect,
    (event, parentSessionId: string, containerName: string, term: TermSize) =>
      containerManager.open(parentSessionId, containerName, term, event.sender)
  )
  ipcMain.handle(
    IpcChannels.containerLogs,
    (event, parentSessionId: string, containerName: string, term: TermSize) =>
      containerManager.openLogs(parentSessionId, containerName, term, event.sender)
  )
  ipcMain.handle(
    IpcChannels.containerControl,
    (_event, parentSessionId: string, containerName: string, action: ContainerControlAction) =>
      containerManager.control(parentSessionId, containerName, action)
  )
  ipcMain.handle(IpcChannels.containerIp, (_event, parentSessionId: string, containerName: string) =>
    containerManager.containerIp(parentSessionId, containerName)
  )
  ipcMain.handle(
    IpcChannels.containerListeners,
    (_event, parentSessionId: string, containerName: string) =>
      containerManager.containerListeners(parentSessionId, containerName)
  )

  // ---- 传输队列 ----

  /** 容器传输 IO：docker cp 段 + agent fs 段（容器内目录操作）组合 */
  const containerIO = (sessionId: string, containerName: string): ContainerIO => ({
    ...createContainerTransferIO(
      (id) => sessionManager.getClient(id) ?? null,
      (id) => containerManager.runtimeBinary(id),
      sessionId,
      containerName
    ),
    mkdirContainer: async (dir) => {
      await agentManager.call(sessionId, containerName, 'fs_mkdir', { path: dir })
    },
    statContainer: async (path) => {
      const r = (await agentManager.call(sessionId, containerName, 'fs_stat', { path })) as {
        is_dir: boolean
        size: number
      }
      return { isDir: r.is_dir, size: r.size }
    },
    listContainer: async (dir) => {
      const r = (await agentManager.call(sessionId, containerName, 'fs_list', { path: dir })) as {
        entries: { name: string; is_dir: boolean; is_symlink: boolean; size: number }[]
      }
      return r.entries.map((e) => ({
        name: e.name,
        isDir: e.is_dir,
        isSymlink: e.is_symlink,
        size: e.size
      }))
    }
  })

  ipcMain.handle(IpcChannels.transferPickUpload, async (event, sessionId: string, remoteDir: string, containerName?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      title: '选择要上传的文件',
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled) return []
    const nested = await Promise.all(
      result.filePaths.map((p) =>
        containerName
          ? transferManager.enqueueUploadContainer(sessionId, containerName, p, remoteDir, containerIO(sessionId, containerName))
          : transferManager.enqueueUpload(sessionId, p, remoteDir)
      )
    )
    return nested.flat()
  })

  ipcMain.handle(
    IpcChannels.transferEnqueueDropped,
    async (_event, sessionId: string, remoteDir: string, files: DroppedFile[], containerName?: string) => {
      const nested = await Promise.all(
        files.map((f) =>
          containerName
            ? transferManager.enqueueUploadContainer(sessionId, containerName, f.path, remoteDir, containerIO(sessionId, containerName))
            : transferManager.enqueueUpload(sessionId, f.path, remoteDir)
        )
      )
      return nested.flat()
    }
  )

  ipcMain.handle(
    IpcChannels.transferDownload,
    async (event, sessionId: string, remotePath: string, fileName: string, containerName?: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showSaveDialog(win!, {
        title: '下载到',
        defaultPath: join(app.getPath('downloads'), fileName)
      })
      if (result.canceled || !result.filePath) return null
      return containerName
        ? transferManager.enqueueDownloadContainer(sessionId, containerName, remotePath, result.filePath, containerIO(sessionId, containerName))
        : transferManager.enqueueDownload(sessionId, remotePath, result.filePath)
    }
  )

  ipcMain.handle(
    IpcChannels.transferDownloadDir,
    async (event, sessionId: string, remotePath: string, containerName?: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showOpenDialog(win!, {
        title: '选择保存位置（文件夹将下载到所选目录内）',
        defaultPath: app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || !result.filePaths[0]) return []
      const dir = result.filePaths[0]
      return containerName
        ? transferManager.enqueueDownloadDirContainer(sessionId, containerName, remotePath, dir, containerIO(sessionId, containerName))
        : transferManager.enqueueDownloadDir(sessionId, remotePath, dir)
    }
  )

  /*
   * 批量下载：只弹一次目录选择框。
   *
   * 单文件走 transferDownload 的保存框（能顺手改文件名），多选就不行了 ——
   * 选中十项弹十次对话框没法用，所以统一问一次「放哪个目录」。
   */
  ipcMain.handle(
    IpcChannels.transferDownloadMany,
    async (event, sessionId: string, items: DownloadRequest[], containerName?: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showOpenDialog(win!, {
        title: `选择保存位置（${items.length} 项将下载到所选目录内）`,
        defaultPath: app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || !result.filePaths[0]) return []
      const dir = result.filePaths[0]
      const io = containerName ? containerIO(sessionId, containerName) : null
      // 入队本身是串行排队的，这里并发提交只是在建任务记录，不占传输通道
      const nested = await Promise.all(
        items.map((item) =>
          io
            ? item.isDir
              ? transferManager.enqueueDownloadDirContainer(sessionId, containerName!, item.remotePath, dir, io)
              : transferManager.enqueueDownloadContainer(sessionId, containerName!, item.remotePath, join(dir, item.name), io)
            : item.isDir
              ? transferManager.enqueueDownloadDir(sessionId, item.remotePath, dir)
              : transferManager.enqueueDownload(sessionId, item.remotePath, join(dir, item.name))
        )
      )
      return nested.flat()
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

  /*
   * 自绘标题栏的窗口控制。
   *
   * 每次都用 BrowserWindow.fromWebContents(event.sender) 反查，而不是在外面
   * 存一个窗口引用：这样发出请求的是哪个窗口就操作哪个窗口，多窗口下天然正确，
   * 也不会持有一个可能已经销毁的引用。
   *
   * 用 ipcMain.on 而不是 handle：这三件事没有返回值，也不需要调用方等回执。
   */
  ipcMain.on(IpcChannels.windowMinimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.on(IpcChannels.windowToggleMaximize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on(IpcChannels.windowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
  ipcMain.handle(IpcChannels.windowGetMaximized, (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })
}
