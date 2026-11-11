import assert from 'node:assert/strict'
import test from 'node:test'
import { archiveBaseName, withSuffix } from './archiveNames.ts'

test('通用归档命名与撞名避让不依赖 SFTP 或本地业务模块', () => {
  assert.equal(archiveBaseName(['a.txt']), 'a.txt.tar.gz')
  assert.equal(archiveBaseName(['a.txt', 'b.txt']), '打包-2项.tar.gz')
  assert.equal(withSuffix('a.txt.tar.gz', 2), 'a.txt-2.tar.gz')
  assert.throws(() => archiveBaseName([]), /没有可打包的项/)
})
