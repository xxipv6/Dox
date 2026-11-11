import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { ConfigStore } from './store/configStore.ts'
import { SessionManager } from './ssh/SessionManager.ts'

function configStoreWith(initialRecords: Record<string, unknown>[]): {
  store: ConfigStore
  state: { records: Record<string, unknown>[] }
} {
  const state = { records: initialRecords }
  const store = Object.create(ConfigStore.prototype) as ConfigStore
  ;(store as any).store = {
    get: (key: string) => {
      assert.equal(key, 'sessions')
      return state.records
    },
    set: (key: string, value: Record<string, unknown>[]) => {
      assert.equal(key, 'sessions')
      state.records = value
    }
  }
  return { store, state }
}

test('公开 session summary 不含密文，内部记录仍可保留并解析凭证', () => {
  const encrypted = `plain:${Buffer.from('old-secret').toString('base64')}`
  const { store, state } = configStoreWith([
    {
      id: 'saved-1',
      name: 'server',
      host: 'example.test',
      port: 22,
      username: 'user',
      authType: 'password',
      encryptedPassword: encrypted,
      encryptedPassphrase: 'plain:cGFzc3BocmFzZQ=='
    }
  ])

  for (const summary of store.list()) {
    assert.equal('encryptedPassword' in summary, false)
    assert.equal('encryptedPassphrase' in summary, false)
    structuredClone(summary)
  }
  assert.deepEqual(store.resolveAuth('saved-1'), { type: 'password', password: 'old-secret' })

  const saved = store.save({
    id: 'saved-1',
    name: 'server',
    host: 'example.test',
    port: 22,
    username: 'user',
    authType: 'password'
  })
  assert.equal('encryptedPassword' in saved, false)
  assert.equal('encryptedPassphrase' in saved, false)
  assert.equal(state.records[0].encryptedPassword, encrypted)
  assert.equal(state.records[0].encryptedPassphrase, 'plain:cGFzc3BocmFzZQ==')
})

test('正常 shell exit 删除会话前显式 end SSH Client，不等待 client close', () => {
  const manager = new SessionManager() as any
  let endCount = 0
  const client = { end: () => endCount++ }
  manager.sessions.set('session-1', {
    id: 'session-1',
    client,
    shell: {},
    sftpClient: null,
    jumps: [],
    owner: { isDestroyed: () => true, send: () => undefined },
    term: { cols: 80, rows: 24 },
    disposed: false,
    stopped: false,
    attempt: 0,
    timer: null
  })

  manager.handleClosed('session-1', client, true, 'shell')
  assert.equal(endCount, 1)
  assert.equal(manager.sessions.has('session-1'), false)
})

test('closed/reconnected 使用可多订阅且可退订的接口，不能互相覆盖', () => {
  const manager = new SessionManager() as any
  const closed: string[] = []
  const reconnected: string[] = []
  const offClosedA = manager.onClosed((id: string) => closed.push(`a:${id}`))
  manager.onClosed((id: string) => closed.push(`b:${id}`))
  manager.onReconnected((id: string) => reconnected.push(`a:${id}`))
  manager.onReconnected((id: string) => reconnected.push(`b:${id}`))

  manager.finalize({ id: 'session-1', jumps: [] })
  for (const listener of manager.reconnectedListeners) listener('session-1')
  offClosedA()
  manager.finalize({ id: 'session-2', jumps: [] })

  assert.deepEqual(closed, ['a:session-1', 'b:session-1', 'b:session-2'])
  assert.deepEqual(reconnected, ['a:session-1', 'b:session-1'])
})

test('shouldKeepAlive 可通过构造策略注入', () => {
  const manager = new SessionManager(undefined, undefined, {
    shouldKeepAlive: (id) => id === 'session-1'
  }) as any
  const client = { end: () => assert.fail('保活会话不应 end client') }
  manager.sessions.set('session-1', {
    id: 'session-1',
    client,
    shell: { end: () => undefined },
    sftpClient: null,
    jumps: [],
    owner: { isDestroyed: () => true, send: () => undefined },
    term: { cols: 80, rows: 24 },
    disposed: false,
    stopped: false,
    attempt: 0,
    timer: null
  })

  manager.disconnect('session-1')
  assert.equal(manager.sessions.get('session-1').orphaned, true)
})

test('SessionManager 提供只接收 savedSessionId 的连接入口', async () => {
  const config = {
    host: 'example.test',
    port: 22,
    username: 'user',
    auth: { type: 'password', password: 'secret' }
  }
  const manager = new SessionManager((id) => {
    assert.equal(id, 'saved-1')
    return config as any
  }) as any
  const owner = {}
  const term = { cols: 100, rows: 30 }
  manager.connect = async (receivedConfig: unknown, receivedOwner: unknown, receivedTerm: unknown, opts: unknown) => {
    assert.equal(receivedConfig, config)
    assert.equal(receivedOwner, owner)
    assert.equal(receivedTerm, term)
    assert.deepEqual(opts, { savedSessionId: 'saved-1' })
    return 'session-1'
  }

  assert.equal(await manager.connectSaved('saved-1', owner, term), 'session-1')
})

test('IPC、URL、shared 契约与通用模块保持单一事实源和中立依赖方向', () => {
  const ipc = readFileSync(resolve(process.cwd(), 'src/main/ipc/index.ts'), 'utf8')
  const main = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
  const search = readFileSync(resolve(process.cwd(), 'src/main/search/SearchService.ts'), 'utf8')
  const localFs = readFileSync(resolve(process.cwd(), 'src/main/local/localFs.ts'), 'utf8')
  const proc = readFileSync(resolve(process.cwd(), 'src/main/proc/ProcessService.ts'), 'utf8')
  const cli = readFileSync(resolve(process.cwd(), 'src/main/cliCommand.ts'), 'utf8')

  assert.doesNotMatch(ipc, /configGetAuth/)
  assert.match(ipc, /IpcChannels\.sshConnectSaved/)
  assert.match(ipc, /IpcChannels\.agentUninstall/)
  assert.match(ipc, /createContainerIO/)
  assert.doesNotMatch(ipc, /createContainerTransferIO|createAgentStreamIO|createAgentArchiveIO/)

  assert.match(ipc, /openHttpExternal/)
  assert.match(main, /openHttpExternal/)

  assert.match(search, /from '\.\.\/local\/localRun'/)
  assert.doesNotMatch(search, /from '\.\.\/container\/localRun'/)
  assert.match(localFs, /from '\.\.\/archiveNames\.ts'/)
  assert.doesNotMatch(localFs, /from '\.\.\/sftp\/archive\.ts'/)

  assert.doesNotMatch(proc, /export interface ProcInfo|export interface ProcListResult/)
  assert.match(proc, /type \{[^}]*ProcInfo[^}]*ProcListResult[^}]*\} from '\.\.\/\.\.\/shared\/types'/s)
  assert.doesNotMatch(cli, /export interface CliCommand/)
  assert.match(cli, /CliCommandPayload/)
  assert.match(cli, /IpcChannels\.cliCommand/)
})
