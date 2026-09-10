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

export type SessionStatus = 'connecting' | 'connected' | 'closed' | 'error'

/** 渲染进程可见的会话状态（不含任何敏感信息） */
export interface SessionStatusEvent {
  id: string
  status: SessionStatus
  error?: string
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
