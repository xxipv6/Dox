import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveTransportConnection } from './transportLifecycle.ts'

test('transport invoke 返回前早到 closed/error 时立即断开，不登记为 ready', () => {
  assert.deepEqual(
    resolveTransportConnection({ status: 'closed' }, true),
    { action: 'disconnect', error: '连接已断开' }
  )
  assert.deepEqual(
    resolveTransportConnection({ status: 'error', error: 'handshake failed' }, true),
    { action: 'disconnect', error: 'handshake failed' }
  )
})

test('transport 连接途中失去全部消费者时立即断开', () => {
  assert.deepEqual(
    resolveTransportConnection({ status: 'connected' }, false),
    { action: 'disconnect', error: '连接已取消' }
  )
})

test('存活事件且仍有消费者时才登记 transport', () => {
  assert.deepEqual(resolveTransportConnection({ status: 'connected' }, true), { action: 'ready' })
  assert.deepEqual(resolveTransportConnection(undefined, true), { action: 'ready' })
})
