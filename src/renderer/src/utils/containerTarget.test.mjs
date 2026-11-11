import assert from 'node:assert/strict'
import test from 'node:test'
import {
  containerDeviceBase,
  containerOriginForTab,
  containerTargetKey,
  isCurrentContainerRequest,
  usesContainerTransport
} from './containerTarget.ts'

test('refresh 只提交同目标 key 且同代际的响应', () => {
  const request = { generation: 3, key: containerTargetKey('ssh-a') }
  assert.equal(isCurrentContainerRequest(request, request), true)
  assert.equal(isCurrentContainerRequest(request, { generation: 4, key: request.key }), false)
  assert.equal(
    isCurrentContainerRequest(request, {
      generation: 3,
      key: containerTargetKey('ssh-b')
    }),
    false
  )
  assert.notEqual(containerTargetKey('ssh-a'), containerTargetKey('ssh-a', ['outer']))
})

test('普通已保存 SSH 进入容器传 originSavedId，嵌套容器继承原身份', () => {
  assert.deepEqual(
    containerOriginForTab({ kind: 'ssh', savedSessionId: 'saved-1', config: null }, 'ssh-1'),
    { originSavedId: 'saved-1' }
  )
  assert.deepEqual(
    containerOriginForTab(
      {
        kind: 'container',
        config: null,
        container: { originSavedId: 'saved-1', parentSessionId: 'container-1' }
      },
      'container-1'
    ),
    { originSavedId: 'saved-1', originDeviceKey: undefined }
  )
})

test('只有本机容器使用 @local，临时 SSH 与未知远端都有非本机身份', () => {
  assert.deepEqual(containerOriginForTab({ kind: 'local', config: null }, 'local-1'), {
    originSavedId: undefined,
    originDeviceKey: '@local'
  })
  const temporary = containerOriginForTab(
    {
      kind: 'ssh',
      config: { host: 'example.test', port: 22, username: 'root' }
    },
    'ssh-temp'
  )
  assert.equal(temporary.originDeviceKey, 'tmp:root@example.test:22')

  assert.equal(containerDeviceBase({ sessionId: 'local' }, true), '@local')
  assert.equal(
    containerDeviceBase({ sessionId: 'ssh-temp', ...temporary }, false),
    'tmp:root@example.test:22'
  )
  assert.equal(containerDeviceBase({ sessionId: 'ssh-unknown' }, false), 'session:ssh-unknown')
  assert.equal(
    containerDeviceBase({ sessionId: 'ssh-1', originSavedId: 'saved-1' }, false),
    'saved:saved-1'
  )
})

test('普通 SSH 容器的 originSavedId 不会被误认为直连 transport 所有权', () => {
  assert.equal(usesContainerTransport({ originSavedId: 'saved-1' }), false)
  assert.equal(usesContainerTransport({ originSavedId: 'saved-1', usesTransport: true }), true)
  assert.equal(usesContainerTransport({}), false)
})
