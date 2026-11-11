import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { AgentManager } from './AgentManager.ts'
import {
  HOST_AGENT_UNINSTALL_COMMAND,
  HOST_UNINSTALL_COMMAND,
  localContainerAgentUninstallArgs,
  localContainerUninstallArgs,
  remoteContainerAgentUninstallCommand,
  remoteContainerUninstallCommand,
  assertAgentUninstallReceipt
} from './agentUninstall.ts'

function deferred() {
  let resolve
  const promise = new Promise((res) => { resolve = res })
  return { promise, resolve }
}

class ServeChannel extends EventEmitter {
  constructor(log = []) {
    super()
    this.log = log
    this.closed = false
  }
  write(text) {
    const req = JSON.parse(text)
    this.log.push(`serve:${req.method}`)
    queueMicrotask(() => {
      if (!this.closed) this.emit('data', Buffer.from(JSON.stringify({ id: req.id, result: {} }) + '\n'))
    })
    return true
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.log.push('serve:close')
    this.emit('close')
  }
}

class ExecChannel extends EventEmitter {
  stderr = new EventEmitter()
  close() { this.emit('close') }
}

class FakeClient {
  constructor() {
    this.execCount = 0
    this.commands = []
    this.serveChannels = []
    this.gate = null
    this.log = []
    this.uninstallOutput = '{"ok":true}\n'
    this.uninstallError = null
    this.uninstallGate = null
  }
  exec(command, _opts, cb) {
    if (command.includes(' serve')) {
      this.execCount++
      const open = () => {
        const channel = new ServeChannel(this.log)
        this.serveChannels.push(channel)
        cb(undefined, channel)
      }
      if (this.gate) void this.gate.then(open)
      else queueMicrotask(open)
      return
    }
    this.commands.push(command)
    this.log.push(`exec:${command}`)
    const channel = new ExecChannel()
    cb(undefined, channel)
    const finish = () => {
      if (command.includes('uninstall')) {
        if (this.uninstallOutput) channel.emit('data', Buffer.from(this.uninstallOutput))
        if (this.uninstallError) channel.stderr.emit('data', Buffer.from(this.uninstallError))
      }
      channel.emit('exit', command.includes('uninstall') && this.uninstallError ? 2 : 0)
      channel.emit('close')
    }
    if (command.includes('uninstall') && this.uninstallGate) void this.uninstallGate.then(finish)
    else queueMicrotask(finish)
  }
}

function fixture() {
  const client = new FakeClient()
  const sessions = { getClient: () => client, onStatus: () => undefined }
  const agents = new AgentManager(sessions, async () => '/usr/bin/docker')
  return { client, agents }
}

test('H7: 同 key 并发 connect 只启动一个 serve 通道', async () => {
  const { client, agents } = fixture()
  const gate = deferred()
  client.gate = gate.promise
  const first = agents.call('s', undefined, 'fs_stat', { path: '/a' })
  const second = agents.call('s', undefined, 'fs_stat', { path: '/b' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(client.execCount, 1)
  gate.resolve()
  await Promise.all([first, second])
  assert.equal(agents.channels.size, 1)
})

test('H7: 旧通道迟到的死亡事件不得清理新通道的隧道处理器', async () => {
  const { client, agents } = fixture()
  await agents.call('s', undefined, 'fs_stat', {})
  const old = agents.channels.get('s')
  agents.dropChannel('s', old)
  await agents.call('s', undefined, 'fs_stat', {})
  const current = agents.channels.get('s')
  assert.notEqual(current, old)
  let closedEvents = 0
  agents.setTunnelHandler('s', undefined, () => { closedEvents++ })
  agents.dropChannel('s', old)
  assert.equal(closedEvents, 0)
  assert.equal(agents.channels.get('s'), current)
  assert.equal(client.serveChannels.length, 2)
})

test('卸载只由显式调用触发，先 stop/close 目标通道再删除宿主机 ~/.dox', async () => {
  const { client, agents } = fixture()
  assert.equal(client.commands.length, 0)
  await agents.call('s', undefined, 'fs_stat', {})
  assert.equal(client.commands.length, 0, '普通建连/状态流程不得隐式卸载')
  agents.cache.set('s', { installed: true, version: '0.9.6' })
  const result = await agents.uninstall('s')
  assert.deepEqual(result, { installed: false })
  assert.equal(client.commands.length, 2)
  assert.equal(client.commands[0], HOST_AGENT_UNINSTALL_COMMAND)
  assert.equal(client.commands[1], HOST_UNINSTALL_COMMAND)
  assert.ok(client.commands[1].includes('$HOME/.dox'))
  assert.equal(agents.cache.get('s').installed, false)
  assert.equal(agents.watches.has('s'), false)
  const stop = client.log.indexOf('serve:stop')
  const close = client.log.indexOf('serve:close')
  const remove = client.log.findIndex((x) => x.startsWith('exec:'))
  assert.ok(stop >= 0 && close > stop && remove > close, `实际顺序：${client.log.join(', ')}`)
})

test('卸载后保留目标墓碑，安装成功才允许重新建连', async () => {
  const { client, agents } = fixture()
  const gate = deferred()
  client.uninstallGate = gate.promise
  const removing = agents.uninstall('s')
  await new Promise((resolve) => setImmediate(resolve))
  try {
    await assert.rejects(agents.uninstall('s'), /正在卸载/)
    await assert.rejects(agents.install('s'), /正在卸载/)
    await assert.rejects(agents.call('s', undefined, 'fs_stat', {}), /正在卸载/)
    assert.equal(client.execCount, 0)
  } finally {
    gate.resolve()
  }
  await removing
  await assert.rejects(agents.call('s', undefined, 'fs_stat', {}), /已卸载/)
  assert.equal(client.execCount, 0)
  agents.restartChannelAfterInstall('s')
  await agents.call('s', undefined, 'fs_stat', {})
  assert.equal(client.execCount, 1)
})

test('卸载广播触发自动重订阅时不得留下新 watch 或 serve', async () => {
  const { client, agents } = fixture()
  const gate = deferred()
  client.uninstallGate = gate.promise
  let resubscribe
  const owner = {
    isDestroyed: () => false,
    send: (_channel, _session, _container, payload) => {
      if (payload.event === 'agent_closed') {
        resubscribe = agents.watchPorts('s', undefined, owner)
        resubscribe.catch(() => undefined)
      }
    }
  }
  await agents.watchPorts('s', undefined, owner)
  const removing = agents.uninstall('s')
  await new Promise((resolve) => setImmediate(resolve))
  try {
    await assert.rejects(resubscribe, /正在卸载/)
    assert.equal(agents.watches.has('s'), false)
    assert.equal(agents.channels.has('s'), false)
    assert.equal(client.execCount, 1)
  } finally {
    gate.resolve()
  }
  await removing
  await assert.rejects(agents.watchPorts('s', undefined, owner), /已卸载/)
  assert.equal(agents.watches.has('s'), false)
})

test('远端/本机容器优先用 agent 自卸载 argv，旧版才回退固定 shell 删除', async () => {
  const { client, agents } = fixture()
  await agents.uninstall('s', 'ctr')
  assert.deepEqual(client.commands, [remoteContainerAgentUninstallCommand('/usr/bin/docker', 'ctr')])
  assert.deepEqual(localContainerAgentUninstallArgs('ctr'), [
    'exec', 'ctr', '/tmp/dox-agent', 'uninstall'
  ])
  assert.deepEqual(localContainerUninstallArgs('ctr'), [
    'exec', 'ctr', 'sh', '-c', 'rm -f -- /tmp/dox-agent'
  ])
  assert.throws(() => localContainerAgentUninstallArgs('ctr;rm -rf /'), /容器名不合法/)
})

test('自卸载回执必须明确 ok=true，空对象/错误字段都是状态未知', () => {
  assert.doesNotThrow(() => assertAgentUninstallReceipt('{"ok":true}'))
  assert.throws(() => assertAgentUninstallReceipt('{}'), /状态未知/)
  assert.throws(() => assertAgentUninstallReceipt('{"ok":false}'), /状态未知/)
})

test('旧 agent 的 unknown subcommand 可回退；其他删除失败必须可见且不得回退', async () => {
  const old = fixture()
  old.client.uninstallOutput = ''
  old.client.uninstallError = 'unknown subcommand: uninstall\n'
  await old.agents.uninstall('s', 'ctr')
  assert.deepEqual(old.client.commands, [
    remoteContainerAgentUninstallCommand('/usr/bin/docker', 'ctr'),
    remoteContainerUninstallCommand('/usr/bin/docker', 'ctr')
  ])

  const failed = fixture()
  failed.agents.cache.set('s::ctr', { installed: true, version: '0.9.6' })
  failed.client.uninstallOutput = ''
  failed.client.uninstallError = 'permission denied\n'
  await assert.rejects(failed.agents.uninstall('s', 'ctr'), /permission denied/)
  assert.deepEqual(failed.client.commands, [remoteContainerAgentUninstallCommand('/usr/bin/docker', 'ctr')])
  assert.notEqual(failed.agents.cache.get('s::ctr')?.installed, false)
})
