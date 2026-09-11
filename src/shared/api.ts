import type {
  AppSettings,
  CommandSnippet,
  ContainerControlAction,
  ContainerProbeResult,
  DownloadRequest,
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
  WindowState,
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
  /** 探路径是文件还是目录；不存在/不可读返回 null（终端路径点击用） */
  sftpStat(sessionId: string, path: string): Promise<{ isDir: boolean } | null>
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

  // ---- 容器（Docker / Podman）----
  /**
   * 只读探测有哪些运行中的容器。
   * 「没装 docker」「没权限」是预期内的状态，用 reason 返回而不是抛错。
   * 只跑 `docker ps`，两侧都不安装任何东西。
   *
   * `parentSessionId` 有三种取值：真实 SSH 会话 id（列那台机器上的）、
   * `LOCAL_CONTAINER_TARGET`（列**本机**的）、以及 null（没有可列的目标）。
   */
  listContainers(parentSessionId: string): Promise<ContainerProbeResult>
  /**
   * 进入容器，返回 `container-` 前缀的会话 id；之后的输入/resize/断开走通用通道。
   *
   * 承载方式由 `parentSessionId` 决定：真实会话 id → 在**那条 SSH 连接**上开一条
   * `docker exec` 通道；`LOCAL_CONTAINER_TARGET` → 在本机起一个 pty 跑
   * `docker exec -it`。对渲染层来说两者没有区别。
   *
   * 容器名的字符集在主进程校验，shell 也由主进程解析，渲染层传的只是名字。
   */
  connectContainer(
    parentSessionId: string,
    containerName: string,
    term: TermSize
  ): Promise<string>
  /**
   * 查看容器日志（docker logs -f），返回 `container-` 前缀会话 id。
   * 与 connectContainer 的差别：不依赖容器里有 shell（distroless 也能看），
   * 已停止的容器也合法。之后的输入/resize/断开同样走通用通道。
   */
  connectContainerLogs(
    parentSessionId: string,
    containerName: string,
    term: TermSize
  ): Promise<string>
  /**
   * 容器生命周期操作（启动/停止/恢复/删除，白名单见 shared/types.ts）。
   * 由用户显式触发；不建容器、不装东西 —— 「远端零改动」红线指的是后者。
   */
  controlContainer(
    parentSessionId: string,
    containerName: string,
    action: ContainerControlAction
  ): Promise<void>
  /** 容器网桥 IP（端口转发建议的目标）；本机容器/无 IP/探测失败都返回 null */
  containerIp(parentSessionId: string, containerName: string): Promise<string | null>

  // ---- 传输队列 ----
  /** 弹出本地文件选择框，选中文件上传到 remoteDir */
  pickUpload(sessionId: string, remoteDir: string): Promise<TransferTask[]>
  /** 拖拽进来的本地上传（路径已解析） */
  enqueueDropped(sessionId: string, remoteDir: string, files: DroppedFile[]): Promise<TransferTask[]>
  /** 弹出保存对话框后下载远端文件；用户取消时返回 null */
  download(sessionId: string, remotePath: string, fileName: string): Promise<TransferTask | null>
  /** 弹出目录选择框后递归下载远端文件夹；用户取消时返回空数组 */
  downloadDir(sessionId: string, remotePath: string): Promise<TransferTask[]>
  /**
   * 批量下载。只弹一次目录选择框，把每一项都放进所选目录 ——
   * 选中十项弹十次保存框是没法用的。用户取消时返回空数组。
   */
  downloadMany(sessionId: string, items: DownloadRequest[]): Promise<TransferTask[]>
  /**
   * 打包：在远端当前目录把选中项 tar 成 .tar.gz（不下载），
   * 返回生成的包路径；失败把 tar 的 stderr 原文抛回。
   */
  sftpArchive(sessionId: string, paths: string[]): Promise<string>
  listTransfers(): Promise<TransferTask[]>
  cancelTransfer(id: string): Promise<void>
  clearFinishedTransfers(): Promise<void>
  /** 停掉整个队列，并中断还在展开的目录遍历 */
  cancelAllTransfers(): Promise<void>
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

  // ---- 自绘标题栏 ----
  /**
   * 当前平台，即 process.platform（'darwin' / 'win32' / 'linux' …）。
   *
   * 这里是 string 而不是 NodeJS.Platform：渲染层那份 tsconfig 不含 @types/node，
   * 引用 NodeJS 命名空间会直接编译不过；而真正的用途只有「是不是 darwin」这一个判断。
   */
  readonly platform: string
  /** 最小化窗口 */
  windowMinimize(): void
  /** 最大化 / 还原 */
  windowToggleMaximize(): void
  /** 关闭窗口 */
  windowClose(): void
  /** 当前是否最大化 —— 挂载时取初始值，用 onWindowState 跟后续变化 */
  windowIsMaximized(): Promise<boolean>
  /** 订阅最大化状态变化（图标在 □ / ❐ 之间切） */
  onWindowState(cb: (state: WindowState) => void): () => void
}
