import assert from 'node:assert/strict'
import test from 'node:test'
import { openHttpExternal } from './externalUrl.ts'

test('HTTP(S) 双协议使用同一打开策略并规范化 URL', async () => {
  const opened: string[] = []
  const open = async (url: string): Promise<void> => {
    opened.push(url)
  }
  assert.equal(await openHttpExternal('http://example.test/path', open), true)
  assert.equal(await openHttpExternal('https://example.test/path', open), true)
  assert.deepEqual(opened, ['http://example.test/path', 'https://example.test/path'])
})

test('file、自定义协议、畸形 URL 和非字符串不会调用系统 opener', async () => {
  const opened: string[] = []
  const open = async (url: string): Promise<void> => {
    opened.push(url)
  }
  for (const value of ['file:///C:/Windows/System32/cmd.exe', 'dox:connect?host=x', 'not a url', null, 42]) {
    assert.equal(await openHttpExternal(value, open), false)
  }
  assert.deepEqual(opened, [])
})
