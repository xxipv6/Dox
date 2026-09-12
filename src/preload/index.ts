import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IpcChannels } from '../shared/ipc'
import type { DoxApi } from '../shared/api'
import type {
  AgentStatsPayload,
  AiAccountInput,
  AiUsageSnapshot,
  DownloadRequest,
  DroppedFile,
  ForwardRule,
  HostKeyVerifyRequest,
  SaveSessionInput,
  SessionStatusEvent,
  SshSessionConfig,
  TermSize,
  TransferTask,
  WindowState
} from '../shared/types'

const api: DoxApi = {
  connect: (config: SshSessionConfig, term: TermSize, opts?: { savedSessionId?: string }) =>
    ipcRenderer.invoke(IpcChannels.sshConnect, config, term, opts),
  connectTransport: (savedSessionId: string) =>
    ipcRenderer.invoke(IpcChannels.sshConnectTransport, savedSessionId),
  connectLocal: (term: TermSize, shellId?: string) =>
    ipcRenderer.invoke(IpcChannels.localConnect, term, shellId),
  listLocalShells: () => ipcRenderer.invoke(IpcChannels.localListShells),
  input: (id, data) => ipcRenderer.send(IpcChannels.sshInput, id, data),
  resize: (id, cols, rows) => ipcRenderer.send(IpcChannels.sshResize, id, cols, rows),
  disconnect: (id) => ipcRenderer.send(IpcChannels.sshDisconnect, id),
  reconnectControl: (id, action) =>
    ipcRenderer.send(IpcChannels.sshReconnectControl, id, action),

  onData: (cb) => {
    const listener = (_e: IpcRendererEvent, id: string, chunk: Uint8Array): void => cb(id, chunk)
    ipcRenderer.on(IpcChannels.sshData, listener)
    return () => ipcRenderer.removeListener(IpcChannels.sshData, listener)
  },
  onStatus: (cb) => {
    const listener = (_e: IpcRendererEvent, event: SessionStatusEvent): void => cb(event)
    ipcRenderer.on(IpcChannels.sshStatus, listener)
    return () => ipcRenderer.removeListener(IpcChannels.sshStatus, listener)
  },
  onHostKeyVerify: (cb) => {
    const listener = (_e: IpcRendererEvent, req: HostKeyVerifyRequest): void => cb(req)
    ipcRenderer.on(IpcChannels.sshHostKeyVerify, listener)
    return () => ipcRenderer.removeListener(IpcChannels.sshHostKeyVerify, listener)
  },
  answerHostKey: (requestId, decision) =>
    ipcRenderer.send(IpcChannels.sshHostKeyAnswer, requestId, decision),

  // ---- 应用设置 ----
  getSettings: () => ipcRenderer.invoke(IpcChannels.settingsGet),
  setSettings: (settings) => ipcRenderer.invoke(IpcChannels.settingsSet, settings),

  // ---- 标签布局 ----
  getLayout: () => ipcRenderer.invoke(IpcChannels.layoutGet),
  setLayout: (snapshot) => ipcRenderer.invoke(IpcChannels.layoutSet, snapshot),

  listSessions: () => ipcRenderer.invoke(IpcChannels.configList),
  saveSession: (input: SaveSessionInput) => ipcRenderer.invoke(IpcChannels.configSave, input),
  deleteSession: (id: string) => ipcRenderer.invoke(IpcChannels.configDelete, id),
  getSessionAuth: (id: string) => ipcRenderer.invoke(IpcChannels.configGetAuth, id),

  // ---- SFTP ----
  sftpList: (sessionId, dir, containerName) =>
    ipcRenderer.invoke(IpcChannels.sftpList, sessionId, dir, containerName),
  sftpRealpath: (sessionId, path, containerName) =>
    ipcRenderer.invoke(IpcChannels.sftpRealpath, sessionId, path, containerName),
  sftpStat: (sessionId, path, containerName) =>
    ipcRenderer.invoke(IpcChannels.sftpStat, sessionId, path, containerName),
  sftpMkdir: (sessionId, path, containerName) =>
    ipcRenderer.invoke(IpcChannels.sftpMkdir, sessionId, path, containerName),
  sftpRename: (sessionId, from, to, containerName) =>
    ipcRenderer.invoke(IpcChannels.sftpRename, sessionId, from, to, containerName),
  sftpDelete: (sessionId, path, isDir, containerName) =>
    ipcRenderer.invoke(IpcChannels.sftpDelete, sessionId, path, isDir, containerName),
  sftpReadText: (sessionId, path, containerName) =>
    ipcRenderer.invoke(IpcChannels.sftpReadText, sessionId, path, containerName),
  sftpWriteText: (sessionId, path, content, expectedMtime, containerName) =>
    ipcRenderer.invoke(IpcChannels.sftpWriteText, sessionId, path, content, expectedMtime, containerName),

  // ---- 容器 ----
  listContainers: (parentSessionId, chain) =>
    ipcRenderer.invoke(IpcChannels.containerList, parentSessionId, chain),
  connectContainer: (parentSessionId, containerName, term, chain) =>
    ipcRenderer.invoke(IpcChannels.containerConnect, parentSessionId, containerName, term, chain),
  connectContainerLogs: (parentSessionId, containerName, term, chain) =>
    ipcRenderer.invoke(IpcChannels.containerLogs, parentSessionId, containerName, term, chain),
  controlContainer: (parentSessionId, containerName, action, chain) =>
    ipcRenderer.invoke(IpcChannels.containerControl, parentSessionId, containerName, action, chain),
  containerIp: (parentSessionId, containerName) =>
    ipcRenderer.invoke(IpcChannels.containerIp, parentSessionId, containerName),
  containerListeners: (parentSessionId, containerName) =>
    ipcRenderer.invoke(IpcChannels.containerListeners, parentSessionId, containerName),

  // ---- 传输队列 ----
  pickUpload: (sessionId, remoteDir, containerName) =>
    ipcRenderer.invoke(IpcChannels.transferPickUpload, sessionId, remoteDir, containerName),
  enqueueDropped: (sessionId, remoteDir, files: DroppedFile[], containerName) =>
    ipcRenderer.invoke(IpcChannels.transferEnqueueDropped, sessionId, remoteDir, files, containerName),
  download: (sessionId, remotePath, fileName, containerName) =>
    ipcRenderer.invoke(IpcChannels.transferDownload, sessionId, remotePath, fileName, containerName),
  downloadDir: (sessionId, remotePath, containerName) =>
    ipcRenderer.invoke(IpcChannels.transferDownloadDir, sessionId, remotePath, containerName),
  downloadMany: (sessionId, items, containerName) =>
    ipcRenderer.invoke(IpcChannels.transferDownloadMany, sessionId, items, containerName),
  sftpArchive: (sessionId, paths, containerName) =>
    ipcRenderer.invoke(IpcChannels.sftpArchive, sessionId, paths, containerName),
  remoteListeners: (sessionId) =>
    ipcRenderer.invoke(IpcChannels.remoteListeners, sessionId),
  agentStatus: (sessionId, containerName) =>
    ipcRenderer.invoke(IpcChannels.agentStatus, sessionId, containerName),
  agentInstall: (sessionId, containerName) =>
    ipcRenderer.invoke(IpcChannels.agentInstall, sessionId, containerName),
  agentWatchPorts: (sessionId, containerName) =>
    ipcRenderer.invoke(IpcChannels.agentWatchPorts, sessionId, containerName),
  agentUnwatchPorts: (sessionId, containerName) =>
    ipcRenderer.invoke(IpcChannels.agentUnwatchPorts, sessionId, containerName),
  onAgentPorts: (cb) => {
    const listener = (
      _e: IpcRendererEvent,
      sessionId: string,
      containerName: string | null,
      data: { event: string; listening?: number[]; added?: number[]; removed?: number[] }
    ): void => cb(sessionId, containerName, data)
    ipcRenderer.on(IpcChannels.agentPorts, listener)
    return () => ipcRenderer.removeListener(IpcChannels.agentPorts, listener)
  },
  agentWatchStats: (sessionId, containerName) =>
    ipcRenderer.invoke(IpcChannels.agentWatchStats, sessionId, containerName),
  agentUnwatchStats: (sessionId, containerName) =>
    ipcRenderer.invoke(IpcChannels.agentUnwatchStats, sessionId, containerName),
  agentFsHold: (sessionId, containerName) =>
    ipcRenderer.invoke(IpcChannels.agentFsHold, sessionId, containerName),
  agentFsRelease: (sessionId, containerName) =>
    ipcRenderer.invoke(IpcChannels.agentFsRelease, sessionId, containerName),
  agentCall: (sessionId, containerName, method, params) =>
    ipcRenderer.invoke(IpcChannels.agentCall, sessionId, containerName, method, params),
  procList: (sessionId, containerName) =>
    ipcRenderer.invoke(IpcChannels.procList, sessionId, containerName),
  procKill: (sessionId, pid, signal, containerName) =>
    ipcRenderer.invoke(IpcChannels.procKill, sessionId, pid, signal, containerName),
  sftpDiskUsage: (sessionId, path, containerName) =>
    ipcRenderer.invoke(IpcChannels.sftpDiskUsage, sessionId, path, containerName),
  onAgentStats: (cb) => {
    const listener = (
      _e: IpcRendererEvent,
      sessionId: string,
      containerName: string | null,
      data: { event: string } & Partial<AgentStatsPayload>
    ): void => cb(sessionId, containerName, data)
    ipcRenderer.on(IpcChannels.agentStats, listener)
    return () => ipcRenderer.removeListener(IpcChannels.agentStats, listener)
  },
  listTransfers: () => ipcRenderer.invoke(IpcChannels.transferList),
  cancelTransfer: (id) => ipcRenderer.invoke(IpcChannels.transferCancel, id),
  clearFinishedTransfers: () => ipcRenderer.invoke(IpcChannels.transferClearFinished),
  cancelAllTransfers: () => ipcRenderer.invoke(IpcChannels.transferCancelAll),
  onTransferUpdate: (cb) => {
    const listener = (_e: IpcRendererEvent, tasks: TransferTask[]): void => cb(tasks)
    ipcRenderer.on(IpcChannels.transferUpdate, listener)
    return () => ipcRenderer.removeListener(IpcChannels.transferUpdate, listener)
  },

  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // ---- 端口转发 ----
  listForwards: () => ipcRenderer.invoke(IpcChannels.forwardList),
  addForward: (input) => ipcRenderer.invoke(IpcChannels.forwardAdd, input),
  removeForward: (id) => ipcRenderer.invoke(IpcChannels.forwardRemove, id),
  onForwardUpdate: (cb) => {
    const listener = (_e: IpcRendererEvent, rules: ForwardRule[]): void => cb(rules)
    ipcRenderer.on(IpcChannels.forwardUpdate, listener)
    return () => ipcRenderer.removeListener(IpcChannels.forwardUpdate, listener)
  },

  // ---- 快捷命令片段 ----
  listSnippets: () => ipcRenderer.invoke(IpcChannels.snippetList),
  saveSnippet: (input) => ipcRenderer.invoke(IpcChannels.snippetSave, input),
  deleteSnippet: (id) => ipcRenderer.invoke(IpcChannels.snippetDelete, id),

  // ---- rz/sz（ZMODEM） ----
  pickDirectory: (title) => ipcRenderer.invoke(IpcChannels.dialogPickDirectory, title),
  pickAndReadFiles: () => ipcRenderer.invoke(IpcChannels.zmodemPickReadFiles),
  writeReceivedFile: (dir, name, data) =>
    ipcRenderer.invoke(IpcChannels.zmodemWriteFile, dir, name, data),

  // ---- 自绘标题栏 ----
  platform: process.platform,
  windowMinimize: () => ipcRenderer.send(IpcChannels.windowMinimize),
  windowToggleMaximize: () => ipcRenderer.send(IpcChannels.windowToggleMaximize),
  windowClose: () => ipcRenderer.send(IpcChannels.windowClose),
  windowIsMaximized: () => ipcRenderer.invoke(IpcChannels.windowGetMaximized),
  onWindowState: (cb) => {
    const listener = (_e: IpcRendererEvent, state: WindowState): void => cb(state)
    ipcRenderer.on(IpcChannels.windowState, listener)
    return () => ipcRenderer.removeListener(IpcChannels.windowState, listener)
  },

  // ---- AI 容量 ----
  aiAccountList: () => ipcRenderer.invoke(IpcChannels.aiAccountList),
  aiAccountSave: (input) => ipcRenderer.invoke(IpcChannels.aiAccountSave, input),
  aiAccountDelete: (id) => ipcRenderer.invoke(IpcChannels.aiAccountDelete, id),
  aiUsageGet: () => ipcRenderer.invoke(IpcChannels.aiUsageGet),
  aiUsageRefresh: () => ipcRenderer.invoke(IpcChannels.aiUsageRefresh),
  onAiUsageUpdate: (cb) => {
    const listener = (_e: IpcRendererEvent, snapshot: AiUsageSnapshot): void => cb(snapshot)
    ipcRenderer.on(IpcChannels.aiUsageUpdate, listener)
    return () => ipcRenderer.removeListener(IpcChannels.aiUsageUpdate, listener)
  },

  // ---- Docker Compose ----
  composeRun: (sessionId, filePath, verb, containerName) =>
    ipcRenderer.invoke(IpcChannels.composeRun, sessionId, filePath, verb, containerName)
}

contextBridge.exposeInMainWorld('api', api)
