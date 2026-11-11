import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deleteEditorState,
  dropSessionStates,
  getEditorState,
  setEditorState
} from './stateCache.ts'

test('EditorState 缓存按 path + reloadSeq 隔离代际', () => {
  const sessionId = 'state-generation'
  const oldState = { doc: 'old' }
  const newState = { doc: 'new' }
  try {
    setEditorState(sessionId, '/tmp/a', oldState, 0)
    assert.equal(getEditorState(sessionId, '/tmp/a', 1), undefined)

    setEditorState(sessionId, '/tmp/a', newState, 1)
    assert.equal(getEditorState(sessionId, '/tmp/a', 1), newState)
    assert.equal(getEditorState(sessionId, '/tmp/a', 0), undefined)
  } finally {
    dropSessionStates(sessionId)
  }
})

test('后台 reload 删除缓存后，旧视图 teardown 不能恢复旧代际', () => {
  const sessionId = 'state-background-reload'
  const oldState = { doc: 'before reload' }
  try {
    setEditorState(sessionId, '/tmp/a', oldState, 3)
    deleteEditorState(sessionId, '/tmp/a')
    setEditorState(sessionId, '/tmp/a', oldState, 3)

    assert.equal(getEditorState(sessionId, '/tmp/a', 4), undefined)
  } finally {
    dropSessionStates(sessionId)
  }
})
