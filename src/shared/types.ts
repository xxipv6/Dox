/** 认证方式：密码 或 私钥 */
export type SshAuth =
  | { type: 'password'; password: string }
  | { type: 'key'; privateKeyPath: string; passphrase?: string }

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
  direction: TransferDirection
  localPath: string
  remotePath: string
  fileName: string
  size: number
  transferred: number
  status: TransferStatus
  error?: string
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

/** local = 本地转发（ssh -L）；remote = 远程转发（ssh -R） */
export type ForwardType = 'local' | 'remote'

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

/** rz/sz（ZMODEM）传输用的内存文件（主进程读取后经 IPC 传给渲染进程） */
export interface ZmodemFile {
  name: string
  size: number
  data: Uint8Array
}

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
