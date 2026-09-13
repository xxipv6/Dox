import { randomUUID } from 'node:crypto'
import Store from 'electron-store'
import { safeStorage } from 'electron'
import {
  AUTH_DECRYPT_FAILED,
  type AiAccount,
  type AiAccountInput,
  type CommandSnippet,
  type SavedSession,
  type SaveSessionInput,
  type SshAuth,
  type SshSessionConfig
} from '../../shared/types'

interface StoreSchema {
  sessions: SavedSession[]
  snippets: CommandSnippet[]
  aiAccounts: AiAccount[]
  /** cwd 学习层：bucket（'local' / 设备 id）→ 目录 → 访问次数（含祖先累计） */
  dirStats: Record<string, Record<string, number>>
}

/**
 * 会话配置持久化。
 * 密码 / 密码短语经 safeStorage（Windows DPAPI / macOS Keychain / Linux Secret Service）
 * 加密后以 base64 落盘，永远不存明文。
 */
export class ConfigStore {
  private store = new Store<StoreSchema>({
    name: 'dox-config',
    defaults: { sessions: [], snippets: [], aiAccounts: [], dirStats: {} }
  })

  list(): SavedSession[] {
    return this.store.get('sessions')
  }

  getDirStats(): StoreSchema['dirStats'] {
    return this.store.get('dirStats')
  }

  setDirStats(stats: StoreSchema['dirStats']): void {
    this.store.set('dirStats', stats)
  }

  save(input: SaveSessionInput): SavedSession {
    const sessions = this.list()
    const existing = input.id ? sessions.find((s) => s.id === input.id) : undefined
    const id = existing?.id ?? randomUUID()

    const saved: SavedSession = {
      id,
      name: input.name || `${input.username}@${input.host}`,
      host: input.host,
      port: input.port,
      username: input.username,
      authType: input.authType,
      // 未重新填写密码时保留旧密文
      encryptedPassword: input.password
        ? this.encrypt(input.password)
        : existing?.encryptedPassword,
      privateKeyPath: input.privateKeyPath,
      encryptedPassphrase: input.passphrase
        ? this.encrypt(input.passphrase)
        : existing?.encryptedPassphrase,
      group: input.group,
      // 防止跳板机指向自己
      jumpHostId: input.jumpHostId && input.jumpHostId !== id ? input.jumpHostId : undefined
    }

    const next = existing ? sessions.map((s) => (s.id === saved.id ? saved : s)) : [...sessions, saved]
    this.store.set('sessions', next)
    return saved
  }

  remove(id: string): void {
    this.store.set(
      'sessions',
      this.list().filter((s) => s.id !== id)
    )
  }

  /** 取回解密后的认证信息，仅用于发起连接，不离开主进程 */
  resolveAuth(id: string): SshAuth {
    const saved = this.list().find((s) => s.id === id)
    if (!saved) throw new Error(`会话不存在: ${id}`)

    if (saved.authType === 'password') {
      if (!saved.encryptedPassword) throw new Error('该会话未保存密码')
      return { type: 'password', password: this.decrypt(saved.encryptedPassword) }
    }
    if (!saved.privateKeyPath) throw new Error('该会话未配置私钥路径')
    return {
      type: 'key',
      privateKeyPath: saved.privateKeyPath,
      passphrase: saved.encryptedPassphrase ? this.decrypt(saved.encryptedPassphrase) : undefined
    }
  }

  /** 解析一条已保存会话为可直接连接的完整配置（含解密认证与跳板机引用） */
  resolveConnection(id: string): SshSessionConfig {
    const saved = this.list().find((s) => s.id === id)
    if (!saved) throw new Error(`会话不存在: ${id}`)
    return {
      host: saved.host,
      port: saved.port,
      username: saved.username,
      auth: this.resolveAuth(id),
      jumpHostId: saved.jumpHostId
    }
  }

  // ---- 快捷命令片段 ----

  listSnippets(): CommandSnippet[] {
    return this.store.get('snippets')
  }

  saveSnippet(input: Omit<CommandSnippet, 'id'> & { id?: string }): CommandSnippet {
    const snippets = this.listSnippets()
    const existing = input.id ? snippets.find((s) => s.id === input.id) : undefined
    const snippet: CommandSnippet = {
      id: existing?.id ?? randomUUID(),
      name: input.name.trim() || input.command.slice(0, 30),
      command: input.command
    }
    const next = existing
      ? snippets.map((s) => (s.id === snippet.id ? snippet : s))
      : [...snippets, snippet]
    this.store.set('snippets', next)
    return snippet
  }

  removeSnippet(id: string): void {
    this.store.set(
      'snippets',
      this.listSnippets().filter((s) => s.id !== id)
    )
  }

  // ---- AI 账号（容量速览的查询对象；key 与会话密码同一套加密口径）----

  listAiAccounts(): AiAccount[] {
    return this.store.get('aiAccounts')
  }

  saveAiAccount(input: AiAccountInput): AiAccount {
    const accounts = this.listAiAccounts()
    const existing = input.id ? accounts.find((a) => a.id === input.id) : undefined
    const account: AiAccount = {
      id: existing?.id ?? randomUUID(),
      name: input.name.trim() || input.provider,
      provider: input.provider,
      // 未重新填写 key 时保留旧密文（与会话密码同一惯例）
      encryptedKey: input.apiKey ? this.encrypt(input.apiKey) : (existing?.encryptedKey ?? '')
    }
    const next = existing
      ? accounts.map((a) => (a.id === account.id ? account : a))
      : [...accounts, account]
    this.store.set('aiAccounts', next)
    return account
  }

  removeAiAccount(id: string): void {
    this.store.set(
      'aiAccounts',
      this.listAiAccounts().filter((a) => a.id !== id)
    )
  }

  /** 取回解密后的 apiKey，仅用于发起查询，不离开主进程 */
  resolveAiKey(id: string): string {
    const account = this.listAiAccounts().find((a) => a.id === id)
    if (!account?.encryptedKey) throw new Error(`AI 账号不存在或未配置 key: ${id}`)
    return this.decrypt(account.encryptedKey)
  }

  private encrypt(plain: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      // Linux 无 Secret Service 时的兜底：仍是 base64 明文，需在产品层面提示用户
      console.warn('[store] safeStorage 不可用，敏感信息将以弱保护方式存储')
      return `plain:${Buffer.from(plain, 'utf8').toString('base64')}`
    }
    return `enc:${safeStorage.encryptString(plain).toString('base64')}`
  }

  private decrypt(stored: string): string {
    const [scheme, payload] = stored.split(':', 2)
    const buf = Buffer.from(payload, 'base64')
    if (scheme !== 'enc') return buf.toString('utf8')
    try {
      return safeStorage.decryptString(buf)
    } catch {
      /*
       * 密文解不开 = 钥匙串身份变了（换机/重装/钥匙串重置/dev 与打包版不是一个
       * keychain 项）。这份密文永久不可恢复，别再拿原文重试，直接走
       * 「重新输入」流程 —— 渲染层认 AUTH_DECRYPT_FAILED 标记弹编辑框。
       */
      throw new Error(`${AUTH_DECRYPT_FAILED} 保存的密码无法解密（系统钥匙串或应用身份已变更），请重新输入一次密码`)
    }
  }
}
