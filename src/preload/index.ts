import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IpcChannels } from '../shared/ipc'
import type { DoxApi } from '../shared/api'
import type {
  DroppedFile,
  ForwardRule,
  HostKeyVerifyRequest,
  SaveSessionInput,
  SessionStatusEvent,
  SshSessionConfig,
  TermSize,
  TransferTask
} from '../shared/types'

const api: DoxApi = {
  connect: (config: SshSessionConfig, term: TermSize, opts?: { savedSessionId?: string }) =>
    ipcRenderer.invoke(IpcChannels.sshConnect, config, term, opts),
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

  listSessions: () => ipcRenderer.invoke(IpcChannels.configList),
  saveSession: (input: SaveSessionInput) => ipcRenderer.invoke(IpcChannels.configSave, input),
  deleteSession: (id: string) => ipcRenderer.invoke(IpcChannels.configDelete, id),
  getSessionAuth: (id: string) => ipcRenderer.invoke(IpcChannels.configGetAuth, id),

  // ---- SFTP ----
  sftpList: (sessionId, dir) => ipcRenderer.invoke(IpcChannels.sftpList, sessionId, dir),
  sftpRealpath: (sessionId, path) => ipcRenderer.invoke(IpcChannels.sftpRealpath, sessionId, path),
  sftpMkdir: (sessionId, path) => ipcRenderer.invoke(IpcChannels.sftpMkdir, sessionId, path),
  sftpRename: (sessionId, from, to) =>
    ipcRenderer.invoke(IpcChannels.sftpRename, sessionId, from, to),
  sftpDelete: (sessionId, path, isDir) =>
    ipcRenderer.invoke(IpcChannels.sftpDelete, sessionId, path, isDir),
  sftpReadText: (sessionId, path) => ipcRenderer.invoke(IpcChannels.sftpReadText, sessionId, path),
  sftpWriteText: (sessionId, path, content, expectedMtime) =>
    ipcRenderer.invoke(IpcChannels.sftpWriteText, sessionId, path, content, expectedMtime),

  // ---- 传输队列 ----
  pickUpload: (sessionId, remoteDir) =>
    ipcRenderer.invoke(IpcChannels.transferPickUpload, sessionId, remoteDir),
  enqueueDropped: (sessionId, remoteDir, files: DroppedFile[]) =>
    ipcRenderer.invoke(IpcChannels.transferEnqueueDropped, sessionId, remoteDir, files),
  download: (sessionId, remotePath, fileName) =>
    ipcRenderer.invoke(IpcChannels.transferDownload, sessionId, remotePath, fileName),
  downloadDir: (sessionId, remotePath) =>
    ipcRenderer.invoke(IpcChannels.transferDownloadDir, sessionId, remotePath),
  listTransfers: () => ipcRenderer.invoke(IpcChannels.transferList),
  cancelTransfer: (id) => ipcRenderer.invoke(IpcChannels.transferCancel, id),
  clearFinishedTransfers: () => ipcRenderer.invoke(IpcChannels.transferClearFinished),
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
    ipcRenderer.invoke(IpcChannels.zmodemWriteFile, dir, name, data)
}

contextBridge.exposeInMainWorld('api', api)
