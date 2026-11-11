import assert from 'node:assert/strict'
import test from 'node:test'
import { createContainerIO } from './containerIO.ts'

function fixture(version) {
  const calls = []
  const sessions = { getClient: () => null }
  const containers = { runtimeBinary: async () => '/usr/bin/docker' }
  const agents = {
    status: async () => ({ installed: true, version }),
    call: async (_s, _c, method) => {
      calls.push(method)
      if (method === 'fs_stat') return { is_dir: false, size: 42 }
      if (method === 'fs_list') return { entries: [{ name: 'a', is_dir: false, is_symlink: false, size: 42 }] }
      return {}
    }
  }
  return { sessions, containers, agents, calls }
}

test('S1: 工厂组合容器 cp/rawTar、fs 与按版本启用的 stream/archive', async () => {
  const { sessions, containers, agents, calls } = fixture('0.9.6')
  const io = await createContainerIO('s', 'ctr', sessions, containers, agents)
  assert.equal(typeof io.cp, 'function')
  assert.equal(typeof io.rawTar.supportsTar, 'function')
  assert.equal(typeof io.stream.upload, 'function')
  assert.equal(typeof io.archive.download, 'function')
  await io.mkdirContainer('/a')
  assert.deepEqual(await io.statContainer('/a'), { isDir: false, size: 42 })
  assert.deepEqual(await io.listContainer('/a'), [{ name: 'a', isDir: false, isSymlink: false, size: 42 }])
  assert.deepEqual(calls, ['fs_mkdir', 'fs_stat', 'fs_list'])
})

test('H2: 旧版没有连续区间元数据，不暴露可能提交空洞的分块流', async () => {
  const { sessions, containers, agents } = fixture('0.9.5')
  const io = await createContainerIO('s', 'ctr', sessions, containers, agents)
  assert.equal(io.stream, undefined)
  assert.equal(typeof io.archive.download, 'function', '0.9.5 仍可保留已支持的归档能力')
})
