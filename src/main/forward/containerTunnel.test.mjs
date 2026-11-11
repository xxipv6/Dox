import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { ContainerTunnelManager } from './containerTunnel.ts'

class ControlledSocket extends EventEmitter {
  paused = false
  pauseCount = 0
  resumeCount = 0
  destroyed = false
  source = []
  writableLength = 0

  send(...chunks) {
    this.source.push(...chunks)
    this.pump()
  }
  pump() {
    while (!this.paused && this.source.length) this.emit('data', this.source.shift())
  }
  pause() {
    this.paused = true
    this.pauseCount++
    return this
  }
  resume() {
    this.paused = false
    this.resumeCount++
    this.pump()
    return this
  }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('close')
    return this
  }
  write() { return true }
  end() { return this }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('H8: 每条 socket 的 tunnel_data RPC 有界，窗口满 pause、确认后 resume', async () => {
  const pending = []
  const calls = []
  const agent = {
    call(_session, _container, method, params) {
      calls.push({ method, params })
      if (method === 'tunnel_connect') return Promise.resolve({})
      if (method === 'tunnel_data') {
        const next = deferred()
        pending.push(next)
        return next.promise
      }
      return Promise.resolve({})
    }
  }
  const tunnels = new ContainerTunnelManager(agent)
  const socket = new ControlledSocket()
  const target = { sessionId: 's', containerName: 'c', targetHost: '127.0.0.1', targetPort: 80 }
  tunnels.onLocalConn({ id: 'r' }, target, socket)
  await Promise.resolve()

  socket.send(...Array.from({ length: 12 }, (_, i) => Buffer.from([i])))
  const dataCalls = () => calls.filter((c) => c.method === 'tunnel_data')
  assert.equal(dataCalls().length, 4, '窗口外字节必须留在 socket，而不是继续生成 pending RPC')
  assert.equal(socket.paused, true)
  assert.ok(socket.pauseCount > 0)

  let maxPending = pending.length
  while (pending.length || socket.source.length) {
    const current = pending.shift()
    current.resolve({})
    await new Promise((resolve) => setImmediate(resolve))
    maxPending = Math.max(maxPending, pending.length)
  }
  assert.equal(dataCalls().length, 12)
  assert.ok(maxPending <= 4)
  assert.ok(socket.resumeCount > 0, 'RPC 确认后必须恢复 socket')
  assert.deepEqual(dataCalls().map((c) => Buffer.from(c.params.data, 'base64')[0]), [...Array(12).keys()])
  socket.destroy()
})

test('停止最后一条隧道先 close 再移除意图，新建 serve 也会按持有归零收口', async () => {
  const order = []
  const agent = {
    call: async (_s, _c, method) => { order.push(method) },
    removeTunnelIntent: () => { order.push('removeIntent') },
    setTunnelHandler: () => undefined
  }
  const tunnels = new ContainerTunnelManager(agent)
  tunnels.targets.set('r', {
    sessionId: 's', containerName: 'c', targetHost: '127.0.0.1', targetPort: 80
  })
  await tunnels.stop({ id: 'r' })
  assert.deepEqual(order, ['tunnel_close', 'removeIntent'])
})

test('H8: 连接关闭后迟到的 RPC 确认不得 resume 已销毁 socket', async () => {
  const pending = []
  const agent = {
    call(_s, _c, method) {
      if (method === 'tunnel_connect') return Promise.resolve({})
      if (method === 'tunnel_data') {
        const next = deferred()
        pending.push(next)
        return next.promise
      }
      return Promise.resolve({})
    }
  }
  const tunnels = new ContainerTunnelManager(agent)
  const socket = new ControlledSocket()
  tunnels.onLocalConn({ id: 'r' }, {
    sessionId: 's', containerName: 'c', targetHost: '127.0.0.1', targetPort: 80
  }, socket)
  await Promise.resolve()
  socket.send(...Array.from({ length: 4 }, () => Buffer.alloc(1)))
  assert.equal(socket.paused, true)
  socket.destroy()
  const resumesAtClose = socket.resumeCount
  for (const next of pending) next.resolve({})
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(socket.resumeCount, resumesAtClose)
  assert.equal(tunnels.flows.size, 0)
})
