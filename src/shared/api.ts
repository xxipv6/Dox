import type {
  AppSettings,
  CommandSnippet,
  DroppedFile,
  FileEntry,
  ForwardRule,
  ForwardRuleInput,
  HostKeyDecision,
  HostKeyVerifyRequest,
  LayoutSnapshot,
  LocalShellInfo,
  RemoteFileContent,
  SavedSession,
  SaveSessionInput,
  SessionStatusEvent,
  SshAuth,
  SshSessionConfig,
  TermSize,
  TransferTask,
  ZmodemFile
} from './types'

/** preload 通过 contextBridge 暴露给渲染进程的 API（window.api） */
export interface DoxApi {
  /**
   * 建立 SSH 连接并打开 shell，返回会话 id。
   * 传 savedSessionId 时主进程不会常驻明文凭证 —— 断线重连时按该 id 重新解密。
   */
  connect(
    config: SshSessionConfig,
    term: TermSize,
    opts?: { savedSessionId?: string }
  ): Promise<string>
  /** 打开本地终端，返回 local- 前缀的会话 id；shellId 不传则用设置里的默认值 */
  connectLocal(term: TermSize, shellId?: string): Promise<string>
  /** 列出本机可用的本地 shell */
  listLocalShells(): Promise<LocalShellInfo[]>
  /** 键盘输入 → SSH（高频，send 不等待回执） */
  input(id: string, data: string | Uint8Array): void
  /** 终端尺寸变化（cols × rows） */
  resize(id: string, cols: number, rows: number): void
  disconnect(id: string): void
  /** 断线重连控制：停止自动重试 / 立即重试一次 */
  reconnectControl(id: string, action: 'stop' | 'now'): void
  /** 订阅远端输出，返回取消订阅函数 */
  onData(cb: (id: string, chunk: Uint8Array) => void): () => void
  /** 订阅会话状态变化（connected / closed / error） */
  onStatus(cb: (event: SessionStatusEvent) => void): () => void
  /** 订阅主机指纹确认请求（known_hosts） */
  onHostKeyVerify(cb: (req: HostKeyVerifyRequest) => void): () => void
  /** 回答指纹确认：信任并保存 / 仅本次 / 拒绝 */
  answerHostKey(requestId: string, decision: HostKeyDecision): void

  /** 读取应用设置；从未保存过则返回 null */
  getSettings(): Promise<AppSettings | null>
  /** 覆盖保存应用设置 */
  setSettings(settings: AppSettings): Promise<void>

  /** 读取上次退出时的标签布局；没有则返回 null */
  getLayout(): Promise<LayoutSnapshot | null>
  /** 覆盖保存标签布局（只含地址与设备 id，不含任何密码） */
  setLayout(snapshot: LayoutSnapshot): Promise<void>

  listSessions(): Promise<SavedSession[]>
  saveSession(input: SaveSessionInput): Promise<SavedSession>
  deleteSession(id: string): Promise<void>
  /** 取出某条已保存会话的解密后认证信息，用于发起连接 */
  getSessionAuth(id: string): Promise<SshAuth>

  // ---- SFTP 文件操作 ----
  sftpList(sessionId: string, dir: string): Promise<FileEntry[]>
  sftpRealpath(sessionId: string, path: string): Promise<string>
  sftpMkdir(sessionId: string, path: string): Promise<void>
  sftpRename(sessionId: string, from: string, to: string): Promise<void>
  sftpDelete(sessionId: string, path: string, isDir: boolean): Promise<void>
  /** 读取远端文本文件（内置编辑器用）；超限抛错，二进制返回 binary: true */
  sftpReadText(sessionId: string, path: string): Promise<RemoteFileContent>
  /**
   * 写回远端文本文件，返回新的 mtime。
   * 传 expectedMtime 时若远端 mtime 已变，抛错拒绝覆盖。
   */
  sftpWriteText(
    sessionId: string,
    path: string,
    content: string,
    expectedMtime?: number
  ): Promise<number>

  // ---- 传输队列 ----
  /** 弹出本地文件选择框，选中文件上传到 remoteDir */
  pickUpload(sessionId: string, remoteDir: string): Promise<TransferTask[]>
  /** 拖拽进来的本地上传（路径已解析） */
  enqueueDropped(sessionId: string, remoteDir: string, files: DroppedFile[]): Promise<TransferTask[]>
  /** 弹出保存对话框后下载远端文件；用户取消时返回 null */
  download(sessionId: string, remotePath: string, fileName: string): Promise<TransferTask | null>
  /** 弹出目录选择框后递归下载远端文件夹；用户取消时返回空数组 */
  downloadDir(sessionId: string, remotePath: string): Promise<TransferTask[]>
  listTransfers(): Promise<TransferTask[]>
  cancelTransfer(id: string): Promise<void>
  clearFinishedTransfers(): Promise<void>
  onTransferUpdate(cb: (tasks: TransferTask[]) => void): () => void

  /** 拖拽事件中把 File 对象解析为本地绝对路径（webUtils） */
  getPathForFile(file: File): string

  // ---- 端口转发 ----
  listForwards(): Promise<ForwardRule[]>
  addForward(input: ForwardRuleInput): Promise<ForwardRule>
  removeForward(id: string): Promise<void>
  onForwardUpdate(cb: (rules: ForwardRule[]) => void): () => void

  // ---- 快捷命令片段 ----
  listSnippets(): Promise<CommandSnippet[]>
  saveSnippet(input: Omit<CommandSnippet, 'id'> & { id?: string }): Promise<CommandSnippet>
  deleteSnippet(id: string): Promise<void>

  // ---- rz/sz（ZMODEM） ----
  pickDirectory(title: string): Promise<string | null>
  /** 弹文件选择框并读入内容（rz 上传用，单文件限 256MB） */
  pickAndReadFiles(): Promise<ZmodemFile[]>
  /** 把 sz 接收到的文件写入指定目录，重名自动加序号，返回最终路径 */
  writeReceivedFile(dir: string, name: string, data: Uint8Array): Promise<string>
}
