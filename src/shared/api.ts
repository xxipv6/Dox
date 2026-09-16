import type {
  AgentStatsPayload,
  AiAccount,
  AiAccountInput,
  AiUsageSnapshot,
  AppSettings,
  CommandSnippet,
  ComposeRunEvent,
  CliCommandPayload,
  ComposeVerb,
  ContainerControlAction,
  ContainerProbeResult,
  DiskUsage,
  DownloadRequest,
  DroppedFile,
  FileEntry,
  ForwardRule,
  ForwardRuleInput,
  HostKeyDecision,
  HostKeyVerifyRequest,
  LayoutSnapshot,
  LocalShellInfo,
  ProcListResult,
  RemoteFileContent,
  SavedSession,
  SaveSessionInput,
  SearchEngine,
  SearchEvent,
  SearchStartParams,
  SessionStatusEvent,
  SshAuth,
  SshSessionConfig,
  TermSize,
  TransferTask,
  UpdaterState,
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
  /**
   * 建立传输会话（不开 shell、不开终端标签的后台连接），返回会话 id。
   * 直连容器的承载：容器列表/容器标签/容器文件操作都借它的 client。
   * 只收已保存设备 id，凭证不出主进程。
   */
  connectTransport(savedSessionId: string): Promise<string>
  /** 打开本地终端，返回 local- 前缀的会话 id；shellId 不传则用设置里的默认值 */
  connectLocal(term: TermSize, shellId?: string, cwd?: string): Promise<string>
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
  // containerName 给了就是容器内文件操作（经容器里的 dox-agent，Dev Containers 式）
  sftpList(sessionId: string, dir: string, containerName?: string): Promise<FileEntry[]>
  sftpRealpath(sessionId: string, path: string, containerName?: string): Promise<string>
  /** 探路径是文件还是目录；不存在/不可读返回 null（终端路径点击用） */
  sftpStat(sessionId: string, path: string, containerName?: string): Promise<{ isDir: boolean } | null>
  sftpMkdir(sessionId: string, path: string, containerName?: string): Promise<void>
  sftpRename(sessionId: string, from: string, to: string, containerName?: string): Promise<void>
  sftpDelete(sessionId: string, path: string, isDir: boolean, containerName?: string): Promise<void>
  /** 批量删除（多选）。rm 逐操作数独立处理：一项失败不耽误其他项，失败项进错误信息 */
  sftpDeleteMany(sessionId: string, targets: { path: string; isDir: boolean }[], containerName?: string): Promise<void>
  /** 远端就地复制（粘贴）：sources 复制进 destDir（同会话）。覆盖语义同上传，符号链接不跟 */
  sftpCopyWithin(sessionId: string, sources: string[], destDir: string): Promise<void>
  /** 读取远端文本文件（内置编辑器用）；超限抛错，二进制返回 binary: true */
  sftpReadText(sessionId: string, path: string, containerName?: string): Promise<RemoteFileContent>
  /**
   * 写回远端文本文件，返回新的 mtime。
   * 传 expectedMtime 时若远端 mtime 已变，抛错拒绝覆盖。
   */
  sftpWriteText(
    sessionId: string,
    path: string,
    content: string,
    expectedMtime?: number,
    containerName?: string
  ): Promise<number>

  // ---- 容器（Docker / Podman）----
  /**
   * 只读探测有哪些运行中的容器。
   * 「没装 docker」「没权限」是预期内的状态，用 reason 返回而不是抛错。
   * 只跑 `docker ps`，两侧都不安装任何东西。
   *
   * `parentSessionId` 有三种取值：真实 SSH 会话 id（列那台机器上的）、
   * `LOCAL_CONTAINER_TARGET`（列**本机**的）、以及 null（没有可列的目标）。
   * `chain` 给了就是**嵌套列表**：列链末端容器里面的容器（docker exec 链，可任意深）。
   */
  listContainers(parentSessionId: string, chain?: string[]): Promise<ContainerProbeResult>
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
    term: TermSize,
    chain?: string[]
  ): Promise<string>
  /**
   * 查看容器日志（docker logs -f），返回 `container-` 前缀会话 id。
   * 与 connectContainer 的差别：不依赖容器里有 shell（distroless 也能看），
   * 已停止的容器也合法。之后的输入/resize/断开同样走通用通道。
   */
  connectContainerLogs(
    parentSessionId: string,
    containerName: string,
    term: TermSize,
    chain?: string[]
  ): Promise<string>
  /**
   * 容器生命周期操作（启动/停止/恢复/删除，白名单见 shared/types.ts）。
   * 由用户显式触发；不建容器、不装东西 —— 「远端零改动」红线指的是后者。
   */
  controlContainer(
    parentSessionId: string,
    containerName: string,
    action: ContainerControlAction,
    chain?: string[]
  ): Promise<void>
  /** 容器网桥 IP（端口转发建议的目标）；本机容器/无 IP/探测失败都返回 null */
  containerIp(parentSessionId: string, containerName: string): Promise<string | null>
  /**
   * 容器内 LISTEN 端口列表（docker exec 读容器 netns 的 /proc）。
   * 容器有自己的 netns，宿主机那张表里看不到它的 socket。
   * supported=false = 容器没 sh / 已停止 / 非 Linux，调用方应停止轮询。
   */
  containerListeners(
    parentSessionId: string,
    containerName: string
  ): Promise<{ ports: number[]; supported: boolean }>

  // ---- 传输队列 ----
  /** 弹出本地文件选择框，选中文件上传到 remoteDir（containerName = 传到容器里） */
  pickUpload(sessionId: string, remoteDir: string, containerName?: string): Promise<TransferTask[]>
  /** 拖拽进来的本地上传（路径已解析） */
  enqueueDropped(sessionId: string, remoteDir: string, files: DroppedFile[], containerName?: string): Promise<TransferTask[]>
  /** 弹出保存对话框后下载远端文件；用户取消时返回 null */
  download(sessionId: string, remotePath: string, fileName: string, containerName?: string): Promise<TransferTask | null>
  /** 弹出目录选择框后递归下载远端文件夹；用户取消时返回空数组 */
  downloadDir(sessionId: string, remotePath: string, containerName?: string): Promise<TransferTask[]>
  /**
   * 批量下载。只弹一次目录选择框，把每一项都放进所选目录 ——
   * 选中十项弹十次保存框是没法用的。用户取消时返回空数组。
   */
  downloadMany(sessionId: string, items: DownloadRequest[], containerName?: string): Promise<TransferTask[]>
  /**
   * 打包：在远端当前目录把选中项 tar 成 .tar.gz（不下载），
   * 返回生成的包路径；失败把 tar 的 stderr 原文抛回。
   * 容器内由 agent 用 Go 标准库产包（不依赖容器里有 tar，distroless 也能打）。
   */
  sftpArchive(sessionId: string, paths: string[], containerName?: string): Promise<string>
  /**
   * 远端 LISTEN 端口列表（/proc/net/tcp，端口转发建议的静默检测）。
   * supported=false = 远端没有 /proc（非 Linux），调用方应停止轮询。
   */
  remoteListeners(sessionId: string): Promise<{ ports: number[]; supported: boolean }>
  /**
   * 远程助手状态（installed/version/osArch）与显式安装（opt-in）。
   * containerName 给了就是容器内安装（Dev Containers 式注入，docker cp + exec）。
   */
  agentStatus(
    sessionId: string,
    containerName?: string
  ): Promise<{ installed: boolean; version?: string; osArch?: string }>
  agentInstall(
    sessionId: string,
    containerName?: string
  ): Promise<{ installed: boolean; version?: string; osArch?: string }>
  /** 订阅/退订 agent 端口推送（首个订阅者建立通道，归零自动 stop） */
  agentWatchPorts(sessionId: string, containerName?: string): Promise<void>
  agentUnwatchPorts(sessionId: string, containerName?: string): Promise<void>
  /**
   * agent 端口事件：listening/added/removed 差分帧，或 agent_closed（通道死，应降级）。
   * containerName 区分同一会话上的宿主机（null）与容器目标。
   */
  onAgentPorts(
    cb: (
      sessionId: string,
      containerName: string | null,
      data: { event: string; listening?: number[]; added?: number[]; removed?: number[] }
    ) => void
  ): () => void
  /** 订阅/退订 agent 系统状态推送（CPU/内存/GPU，与端口推送共用通道） */
  agentWatchStats(sessionId: string, containerName?: string): Promise<void>
  agentUnwatchStats(sessionId: string, containerName?: string): Promise<void>
  /** agent 状态帧（event='stats' 时载荷为 AgentStatsPayload），或 agent_closed */
  onAgentStats(
    cb: (
      sessionId: string,
      containerName: string | null,
      data: { event: string } & Partial<AgentStatsPayload>
    ) => void
  ): () => void
  /** 文件面板持有/释放 agent 通道（面板打开期间通道不被退订收掉） */
  agentFsHold(sessionId: string, containerName?: string): Promise<void>
  agentFsRelease(sessionId: string, containerName?: string): Promise<void>
  /**
   * agent 白名单泛通道（0.4.0 起的显式方法：ps_list/ps_kill/exec/fs_usage/fs_*）。
   * method 不在白名单会被主进程拒绝。
   */
  agentCall(
    sessionId: string,
    containerName: string | undefined,
    method: string,
    params: unknown
  ): Promise<unknown>
  /** 进程列表（agent ps_list / 宿主机 ps 命令退化；容器无 agent 会报错指路） */
  procList(sessionId: string, containerName?: string): Promise<ProcListResult>
  /** 结束进程（TERM/KILL 白名单） */
  procKill(sessionId: string, pid: number, signal: 15 | 9, containerName?: string): Promise<void>
  /** 路径所在文件系统的用量；目标不支持时返回 null（调用方不显示即可） */
  sftpDiskUsage(sessionId: string, path: string, containerName?: string): Promise<DiskUsage | null>
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

  /**
   * 用系统默认浏览器打开一个外部链接。
   *
   * 终端里的 URL 走这条通道，而不是渲染层的 window.open：WebLinksAddon 的默认
   * handler 是「先 window.open() 再往返回的窗口写 location.href」，而主进程的
   * setWindowOpenHandler 对一切 window.open 都是 deny —— 那条路的结果只有一条
   * console.warn，链接永远打不开。
   *
   * 入参来自终端输出（远端可控），所以主进程侧只放行 http/https。
   */
  openExternal(url: string): Promise<void>

  /**
   * 写系统剪贴板。
   *
   * 走主进程的 Electron clipboard 模块，不用渲染层的 navigator.clipboard：
   * 后者在 Electron 里要求文档处于焦点，失败时只是 reject 一个没人接的 promise，
   * 用户看到的就是「点了复制没反应」而且无从排查。终端里选中即复制、右键复制、
   * 快捷键复制都走这条通道。
   */
  writeClipboardText(text: string): Promise<void>
  /** 读系统剪贴板（终端粘贴用，理由同上） */
  readClipboardText(): Promise<string>

  /** CLI 伴侣：安装 dox 命令到 PATH（返回安装位置与 PATH 提示） */
  cliInstall(): Promise<{ path: string; note?: string }>
  /** CLI 伴侣：查询安装状态（设置页回显）；null = 没装 */
  cliStatus(): Promise<{ path: string; note?: string } | null>
  /** dox 命令事件（--cli 参数经单实例锁转发而来）：local 开标签、connect 连接、focus 前置窗口 */
  onCliCommand(cb: (cmd: CliCommandPayload) => void): () => void
  /** 渲染层挂载完成信号：主进程据此 flush 排队中的 CLI 命令（冷启动参数） */
  cliCommandReady(): void
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
  /** cwd 学习层：读取/写回目录访问统计（bucket → 目录 → 次数） */

  readonly platform: string
  /** 本机家目录（学习层的 home 排除用） */
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
  /**
   * 订阅 mac 菜单里的 ⌘W（关闭标签）。
   * Windows/Linux 用不到 —— 那边 Ctrl+W 由渲染层直接收（菜单已摘掉）。
   */
  onMenuCloseTab(cb: () => void): () => void

  // ---- AI 容量 ----
  /** 列出已配置的 AI 账号（不含 key —— key 不出主进程） */
  aiAccountList(): Promise<Omit<AiAccount, 'encryptedKey'>[]>
  /** 新增/更新账号；apiKey 留空表示保留旧 key */
  aiAccountSave(input: AiAccountInput): Promise<void>
  aiAccountDelete(id: string): Promise<void>
  /** 最近一次查询快照；还没查过返回 null */
  aiUsageGet(): Promise<AiUsageSnapshot | null>
  /** 立即查询一轮（手动刷新；服务内部合并并发） */
  aiUsageRefresh(): Promise<AiUsageSnapshot>
  /** 订阅查询结果广播（定时轮询与手动刷新都从这里推） */
  onAiUsageUpdate(cb: (snapshot: AiUsageSnapshot) => void): () => void

  // ---- Docker Compose ----
  /**
   * 对 compose 文件执行 up/restart/down（宿主机或容器内；down 的确认在渲染层）。
   * 立即返回 runId；输出与结局经 onComposeEvent 流式推进。
   */
  composeRun(sessionId: string, filePath: string, verb: ComposeVerb, containerName?: string): Promise<string>
  /** 取消正在运行的 compose 动作（≈ 终端里 Ctrl+C） */
  composeCancel(runId: string): void
  /** 订阅 compose 流式输出与结局事件 */
  onComposeEvent(cb: (ev: ComposeRunEvent) => void): () => void

  // ---- 项目模式全文搜索 ----
  /**
   * 在 root 下全文搜索（引擎链 agent → rg → grep → node，主进程自动选择）。
   * 立即返回 {runId, engine}；匹配与结局经 onSearchEvent 流式推进。
   */
  searchStart(params: SearchStartParams): Promise<{ runId: string; engine: SearchEngine }>
  /** 取消正在运行的搜索 */
  searchCancel(runId: string): void
  /** 订阅搜索事件（全窗口广播，按 runId 过滤） */
  onSearchEvent(cb: (ev: SearchEvent) => void): () => void

  // ---- 应用内自动更新 ----
  /** 当前更新状态快照（挂载时取一次，之后靠 onUpdaterEvent 跟） */
  updaterGetState(): Promise<UpdaterState>
  /** 手动检查更新（镜像优先，失败自动回 GitHub；已下好/进行中时是空操作） */
  updaterCheck(): Promise<void>
  /** 重启并安装已下载的更新 —— 会断开所有会话，确认动作在渲染层做 */
  updaterQuitAndInstall(): void
  /** 订阅更新状态变化（快照整体替换） */
  onUpdaterEvent(cb: (state: UpdaterState) => void): () => void
}
