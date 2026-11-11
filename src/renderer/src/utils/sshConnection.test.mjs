import assert from 'node:assert/strict'
import test from 'node:test'
import { planSshConnection, presentSshConnectionError } from './sshConnection.ts'

const term = { cols: 120, rows: 30 }

test('saved tab 没有 config.auth 也走 savedSessionId 连接请求', () => {
  const request = planSshConnection({ savedSessionId: 'saved-1', config: null }, term)
  assert.deepEqual(request, { kind: 'saved', savedSessionId: 'saved-1', term })
  assert.equal('config' in request, false)
  assert.equal('auth' in request, false)
  assert.deepEqual(structuredClone(request), request)
})

test('saved 分支不会携带渲染层残留认证字段', () => {
  const config = {
    host: 'example.test',
    port: 22,
    username: 'root',
    auth: { type: 'password', password: 'must-not-cross' }
  }
  const request = planSshConnection({ savedSessionId: 'saved-1', config }, term)
  assert.equal(request.kind, 'saved')
  assert.equal(JSON.stringify(request).includes('must-not-cross'), false)
})

test('未保存的临时连接保留原有完整配置路径', () => {
  const config = {
    host: 'example.test',
    port: 22,
    username: 'root',
    auth: { type: 'password', password: 'one-shot' }
  }
  assert.deepEqual(planSshConnection({ config }, term), { kind: 'temporary', config, term })
})

test('saved 主进程解密失败在统一 connectPane 错误路径中请求重新编辑', () => {
  assert.deepEqual(presentSshConnectionError('[AUTH] decrypt failed', true, '[AUTH]'), {
    message: 'decrypt failed',
    decryptFailed: true
  })
  assert.deepEqual(presentSshConnectionError('[AUTH] unexpected', false, '[AUTH]'), {
    message: '[AUTH] unexpected',
    decryptFailed: false
  })
})
