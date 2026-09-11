/** 认证方式：密码 或 私钥 */
export type SshAuth =
  | { type: 'password'; password: string }
  | { type: 'key'; privateKeyPath: string; passphrase?: string }

/**
 * safeStorage 解密失败的错误标记（嵌在 Error.message 里跨 IPC 传递）。
 *
 * 密文与系统钥匙串绑定：换机 / 重装 / 钥匙串重置 / dev 与打包版身份不同，
 * 老密文就永久解不开 —— 唯一出路是用户重新输入。渲染层靠这个标记识别出
 * 「该弹编辑框让人重输密码了」，而不是把它当普通连接错误。
 */
export const AUTH_DECRYPT_FAILED = '[AUTH_DECRYPT_FAILED]'

/** 建立一条 SSH 会话所需的完整配置（含明文敏感信息，只在主进程内存中流转） */
export interface SshSessionConfig {
  host: string
  port: number
  username: string
  auth: SshAuth
  /** 跳板机：指向另一条已保存会话的 id，支持多级嵌套（主进程限 3 层） */
  jumpHostId?: string
}

export type SessionStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error'

/** 渲染进程可见的会话状态（不含任何敏感信息） */
export interface SessionStatusEvent {
  id: string
  status: SessionStatus
  error?: string
  /** status = reconnecting 时的第几次尝试（从 1 开始） */
  attempt?: number
  /** 本次退避时长，用于界面提示「N 秒后重试」 */
  delayMs?: number
  /** status = connected 且是重连成功后发出（不是首次连接） */
  reconnected?: boolean
}

/** dox-agent watch_stats 推送的单卡状态（nvidia-smi 存在才有这项） */
export interface AgentGpuStat {
  name: string
  util_percent: number
  mem_used_mb: number
  mem_total_mb: number
}

/** dox-agent watch_stats 推送帧（CPU 为两次采样差分百分比） */
export interface AgentStatsPayload {
  cpu_percent: number
  mem_total_mb: number
  mem_used_mb: number
  gpus?: AgentGpuStat[]
}

/** 持久化到本地的会话配置（敏感字段经 safeStorage 加密，base64 存储） */
export interface SavedSession {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  /** safeStorage.encryptString 后的 base64 */
  encryptedPassword?: string
  privateKeyPath?: string
  encryptedPassphrase?: string
  group?: string
  /** 跳板机：另一条已保存会话的 id */
  jumpHostId?: string
}

/** 保存会话时渲染进程提交的表单（明文密码仅在此次 IPC 调用中存在） */
export interface SaveSessionInput {
  id?: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  password?: string
  privateKeyPath?: string
  passphrase?: string
  group?: string
  jumpHostId?: string
}

/** 终端初始尺寸（shell 建立后由 xterm 的 resize 事件持续修正） */
export interface TermSize {
  cols: number
  rows: number
}

/** SFTP 目录条目（path 为远端 posix 绝对路径） */
export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  isSymlink: boolean
  size: number
  /** 秒级时间戳 */
  mtime: number
}

/** 界面主题。'system' 跟随操作系统的深浅色设置 */
export type UiTheme = 'light' | 'dark' | 'system'

/**
 * 应用设置（界面主题/终端配色/字体/本地 shell）。
 *
 * 与布局一样存在主进程，不放渲染进程的 localStorage —— 打包后渲染进程从
 * file:// 加载，往那个源写 localStorage 不会落盘，用户改完设置重启就丢。
 */
export interface AppSettings {
  /**
   * 终端配色预设 id。
   *
   * `'auto'` 是**哨兵值不是预设**：表示「跟随界面主题」，由渲染层按当前
   * 界面深浅解析成具体的亮/暗终端预设。老配置里存的是具体预设 id，
   * 那种情况就按手动覆盖处理，不去动用户的选择。
   */
  themeId: string
  /** 界面主题：亮色 / 深色 / 跟随系统 */
  uiTheme: UiTheme
  fontSize: number
  fontId: string
  /** 连字需要 DOM 渲染器（WebGL 逐字形绘制，无法做字形替换） */
  ligatures: boolean
  localShellId: string
  /** 终端输出里检测到服务监听横幅时，弹出「转发到本机」建议 */
  suggestPortForward: boolean
}

/**
 * 标签布局快照，重启后据此重建会话。
 *
 * ⚠️ 存在主进程（electron-store）而不是渲染进程的 localStorage：
 * 打包后渲染进程从 file:// 加载，Chromium 视其为不透明源，localStorage
 * 写入不落盘（已实测：整个 userData 里没有任何 file:// 源记录）。
 * 换成自定义协议 dox:// 同样不落盘，故一律走主进程存储。
 *
 * 只存地址与设备 id，**绝不存密码**。
 */
export interface LayoutTabSnapshot {
  kind: 'ssh' | 'local'
  title: string
  split: 'none' | 'row' | 'column'
  paneCount: number
  active: boolean
  /** 有它才能重启后自动重连 */
  savedSessionId?: string
  /** 未保存的 SSH 会话：重启后没凭证，恢复成占位标签，用它预填认证表单 */
  host?: string
  port?: number
  username?: string
}

export interface LayoutSnapshot {
  tabs: LayoutTabSnapshot[]
}

/** 内置编辑器可打开的文件大小上限（字节）。超过则只允许下载后查看 */
export const MAX_EDITABLE_BYTES = 2 * 1024 * 1024


/**
 * 远端文本文件读取结果（内置编辑器用）。
 * binary 为 true 时 content 必为空字符串 —— 二进制文件不进入编辑器。
 */
export interface RemoteFileContent {
  path: string
  content: string
  size: number
  /** 读取时的 mtime（秒），保存时回传用于检测「别人在我编辑期间改过」 */
  mtime: number
  binary: boolean
}

export type TransferDirection = 'upload' | 'download'
export type TransferStatus = 'pending' | 'active' | 'done' | 'error' | 'canceled'

export interface TransferTask {
  id: string
  sessionId: string
  /** 容器传输的目标容器（经宿主机 /tmp 中转 + docker cp）；宿主机传输为 undefined */
  containerName?: string
  direction: TransferDirection
  localPath: string
  remotePath: string
  fileName: string
  size: number
  transferred: number
  status: TransferStatus
  error?: string
}

/** 批量下载的一项（右键菜单选中多项时提交给主进程） */
export interface DownloadRequest {
  remotePath: string
  name: string
  isDir: boolean
}

/** 渲染进程拖拽文件时经 webUtils 解析出的本地文件信息 */
export interface DroppedFile {
  path: string
  name: string
  size: number
}

/** 主机指纹确认请求（known_hosts 机制） */
export interface HostKeyVerifyRequest {
  requestId: string
  host: string
  port: number
  /** SHA256:xxx 格式（OpenSSH 风格） */
  fingerprint: string
  /** status 为 changed 时带上旧指纹 */
  storedFingerprint?: string
  status: 'new' | 'changed'
}

/** trust = 信任并保存；once = 仅本次；reject = 拒绝连接 */
export type HostKeyDecision = 'trust' | 'once' | 'reject'

/** local = 本地转发（ssh -L）；remote = 远程转发（ssh -R）；socks = 动态转发（ssh -D，SOCKS5） */
export type ForwardType = 'local' | 'remote' | 'socks'

/** 端口转发规则 */
export interface ForwardRule {
  id: string
  sessionId: string
  type: ForwardType
  /** 监听地址：本地转发为本机地址，远程转发为远端绑定地址 */
  listenHost: string
  listenPort: number
  targetHost: string
  targetPort: number
  status: 'active' | 'error' | 'stopped'
  error?: string
}

export interface ForwardRuleInput {
  sessionId: string
  type: ForwardType
  listenPort: number
  targetHost: string
  targetPort: number
  listenHost?: string
}

/** 快捷命令片段 */
export interface CommandSnippet {
  id: string
  name: string
  /** 支持多行命令，执行时逐行发送 */
  command: string
}

/** 窗口状态。自绘标题栏要知道当前是不是最大化，好决定那枚按钮画 □ 还是 ❐ */
export interface WindowState {
  maximized: boolean
}

/** rz/sz（ZMODEM）传输用的内存文件（主进程读取后经 IPC 传给渲染进程） */
export interface ZmodemFile {
  name: string
  size: number
  data: Uint8Array
}

// ---- 容器（Docker / Podman）----

/**
 * 一个容器的摘要。
 *
 * `status` 原样保留 docker 给的文案（"Up 3 hours (healthy)"）—— 那句话本身
 * 就是信息，翻译或裁剪都只会丢东西。`state` 才是给程序判断用的。
 */
export interface ContainerInfo {
  /** 短 id（12 位）。也是容器默认的 hostname，验证脚本靠这点确认真的进了容器 */
  id: string
  /** 容器名，`docker exec` 的目标。已按 CONTAINER_TARGET_RE 校验过字符集 */
  name: string
  image: string
  status: string
  state: 'running' | 'paused' | 'exited' | 'other'
  health?: 'healthy' | 'unhealthy' | 'starting'
}

/** 容器生命周期操作（白名单之外的动作在主进程不存在入口） */
export type ContainerControlAction = 'start' | 'stop' | 'unpause' | 'remove'

/** 一次容器列表探测的结果 */
export interface ContainerList {
  runtime: 'docker' | 'podman'
  /**
   * runtime 可执行文件的**绝对路径**。
   * 探测时补过 PATH 才解析出来，而交互式 exec 通道没有那份 PATH 补充，
   * 所以后续命令必须用这个绝对路径，不能再用裸 `docker`。
   */
  binary: string
  /** 只含运行中（与 paused）的容器 */
  containers: ContainerInfo[]
  /** 有多少个已停止的，用于「另有 N 个已停止」 */
  stoppedCount: number
  /** 容器太多被字节上限截断；此时 stoppedCount 只是下界 */
  truncated?: boolean
  /** docker 版本过旧，--format 降级过，状态信息不可用 */
  formatDowngraded?: boolean
}

/** 探测失败的原因，决定界面给哪一句话 */
export type ContainerProbeReason =
  /** 远端既没有 docker 也没有 podman */
  | 'no-binary'
  /** 没有权限访问 docker socket */
  | 'no-permission'
  /** 守护进程没跑 / socket 不可达 */
  | 'daemon-down'
  /** 容器此刻不在运行（列表与点击之间被停了） */
  | 'container-gone'
  /** exec 被 seccomp / AppArmor / 容器用户权限拒绝 */
  | 'exec-denied'
  /** 容器里没有可用的 shell（distroless / scratch） */
  | 'no-shell'
  | 'error'

/**
 * 探测结果用判别联合返回，**不抛错**。
 *
 * 「没装 docker」「没权限」都是预期内的状态，各自要有各自的界面 —— 把它们
 * 当成异常扔到 catch 里，界面就只剩一句通用的「失败了」，用户不知道该做什么。
 * （`open()` 是动作，那个才走抛错 + errorText 的既有路径。）
 */
export type ContainerProbeResult =
  | { ok: true; list: ContainerList }
  | { ok: false; reason: ContainerProbeReason; message: string }

/** 本地终端可用的 shell */
export interface LocalShellInfo {
  id: string
  name: string
  /** 是否支持 shell integration（cwd / 退出码上报） */
  integrated: boolean
}

/** 创建本地终端的参数（cols/rows 复用 TermSize） */
export interface LocalTermOptions extends TermSize {
  /** 不传则用设置里的默认 shell */
  shellId?: string
}
