import assert from 'node:assert/strict'
import test from 'node:test'
import { saveContentSnapshot } from './saveSnapshot.ts'

test('保存响应后，新输入仍为 dirty，保存基线和 size 使用请求快照', async () => {
  const file = {
    content: 'old',
    savedContent: 'old',
    mtime: 10,
    size: 3
  }
  let resolveWrite
  const written = []
  const saving = saveContentSnapshot(file, (content, expectedMtime) => {
    written.push({ content, expectedMtime })
    return new Promise((resolve) => {
      resolveWrite = resolve
    })
  })

  file.content = 'new input 😀'
  resolveWrite(20)
  await saving

  assert.deepEqual(written, [{ content: 'old', expectedMtime: 10 }])
  assert.equal(file.mtime, 20)
  assert.equal(file.savedContent, 'old')
  assert.equal(file.size, 3)
  assert.notEqual(file.content, file.savedContent)
})
