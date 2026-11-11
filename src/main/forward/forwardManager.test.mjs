import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import test from 'node:test'
import { ForwardManager } from './ForwardManager.ts'

function manager() {
  return new ForwardManager(() => undefined, () => undefined, {
    start: async () => undefined,
    stop: async () => undefined
  })
}

test('H5: list 只公开白名单字段且可 structuredClone', () => {
  const forwards = manager()
  forwards.rules.set('r1', {
    id: 'r1', sessionId: 's1', type: 'local', listenHost: '127.0.0.1', listenPort: 1000,
    targetHost: 'localhost', targetPort: 2000, status: 'stopped',
    server: {}, sockets: new Set([new net.Socket()]), tcpHandler: () => undefined,
    stopPromise: Promise.resolve(), internalNote: '不得越界'
  })
  const dto = forwards.list()[0]
  assert.deepEqual(Object.keys(dto).sort(), [
    'id', 'listenHost', 'listenPort', 'sessionId', 'status', 'targetHost', 'targetPort', 'type'
  ].sort())
  assert.doesNotThrow(() => structuredClone(dto))
  assert.equal('stopPromise' in dto, false)
  assert.equal('sockets' in dto, false)
  assert.equal('internalNote' in dto, false)
  const snapshot = forwards.snapshot(forwards.rules.get('r1'))
  assert.deepEqual(snapshot, dto)
  assert.doesNotThrow(() => structuredClone(snapshot))
})

class FakeClient extends EventEmitter {
  forwardIn(_host, _port, cb) { cb(undefined) }
  unforwardIn(_host, _port, cb) { cb() }
}

function fakeDuplex() {
  const emitter = new EventEmitter()
  emitter.destroyed = false
  emitter.pipe = (other) => other
  emitter.destroy = () => {
    emitter.destroyed = true
    emitter.emit('close')
    return emitter
  }
  return emitter
}

test('M4: 停止 remote forward 同时销毁已建立的 channel 和 socket', async () => {
  const client = new FakeClient()
  const forwards = new ForwardManager(() => client, () => undefined, {
    start: async () => undefined,
    stop: async () => undefined
  })
  const rule = await forwards.add({
    sessionId: 's1', type: 'remote', listenHost: '127.0.0.1', listenPort: 1000,
    targetHost: 'localhost', targetPort: 2000
  })
  const channel = fakeDuplex()
  const socket = fakeDuplex()
  const originalConnect = net.connect
  net.connect = () => socket
  try {
    client.emit('tcp connection', { destIP: '127.0.0.1', destPort: 1000 }, () => channel)
    await forwards.remove(rule.id)
  } finally {
    net.connect = originalConnect
  }
  assert.equal(channel.destroyed, true, 'remote SSH channel 必须销毁')
  assert.equal(socket.destroyed, true, 'remote 本地目标 socket 必须销毁')
})
