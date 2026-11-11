import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { materializeHardlink } from './tarDisk.ts'
import { shQuote } from './shQuote.ts'

test('S3: 硬链接材料化复制已解出的内容并创建父目录', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dox-tar-disk-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'dir'))
  fs.writeFileSync(path.join(root, 'dir/source'), 'payload')
  await materializeHardlink(root, { name: 'nested/copy', linkName: 'dir/source' })
  assert.equal(fs.readFileSync(path.join(root, 'nested/copy'), 'utf8'), 'payload')
  await assert.rejects(materializeHardlink(root, { name: 'bad', linkName: '../outside' }), /越界或缺失/)
  await assert.doesNotReject(materializeHardlink(root, { name: '../ignored', linkName: 'dir/source' }))
})

test('S3: shQuote 保持 POSIX 单引号转义', () => {
  assert.equal(shQuote("a'b"), `'a'\\''b'`)
  assert.equal(shQuote('a b'), `'a b'`)
})
