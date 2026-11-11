import assert from 'node:assert/strict'
import test from 'node:test'
import { RunEventClaimer } from './runEventClaimer.ts'

const idOf = (event) => event.runId

test('invoke 返回前的 data/done 按序回放，done 先到不会永久 running', () => {
  const claimer = new RunEventClaimer(idOf)
  const operation = claimer.begin()
  const delivered = []

  claimer.accept({ runId: 'run-1', type: 'data', text: 'output' }, (event) => delivered.push(event))
  claimer.accept({ runId: 'run-1', type: 'done' }, (event) => delivered.push(event))
  assert.deepEqual(delivered, [])

  const run = { status: 'running', text: '' }
  for (const event of claimer.claim(operation, 'run-1')) {
    if (event.type === 'data') run.text += event.text
    else run.status = 'done'
    delivered.push(event)
  }

  assert.equal(run.text, 'output')
  assert.equal(run.status, 'done')
  assert.deepEqual(delivered.map((event) => event.type), ['data', 'done'])
})

test('旧 run 的迟到事件不会污染正在认领的新 run', () => {
  const claimer = new RunEventClaimer(idOf)
  const first = claimer.begin()
  claimer.claim(first, 'old-run')
  claimer.release('old-run')

  const second = claimer.begin()
  claimer.accept({ runId: 'old-run', type: 'done' }, () => assert.fail('旧事件不应直接交付'))
  claimer.accept({ runId: 'new-run', type: 'done' }, () => assert.fail('认领前应暂存'))

  assert.deepEqual(claimer.claim(second, 'new-run'), [{ runId: 'new-run', type: 'done' }])
  const delivered = []
  assert.equal(claimer.accept({ runId: 'old-run', type: 'done' }, (event) => delivered.push(event)), false)
  assert.deepEqual(delivered, [])
})

test('启动失败会清掉该次操作留下的未认领事件', () => {
  const claimer = new RunEventClaimer(idOf)
  const failed = claimer.begin()
  claimer.accept({ runId: 'never-started', type: 'done' }, () => assert.fail('认领前应暂存'))
  claimer.abort(failed)

  const next = claimer.begin()
  assert.deepEqual(claimer.claim(next, 'next-run'), [])
})

test('没有启动在途时到达的旧事件不会留到下一次 claim', () => {
  const claimer = new RunEventClaimer(idOf)
  claimer.accept({ runId: 'old-run', type: 'done' }, () => assert.fail('旧事件不应交付'))

  const next = claimer.begin()
  assert.deepEqual(claimer.claim(next, 'old-run'), [])
})

test('并发启动按各自 runId 认养，与 invoke 返回顺序无关', () => {
  const claimer = new RunEventClaimer(idOf)
  const first = claimer.begin()
  const second = claimer.begin()
  claimer.accept({ runId: 'run-a', type: 'done' }, () => assert.fail('认领前应暂存'))
  claimer.accept({ runId: 'run-b', type: 'done' }, () => assert.fail('认领前应暂存'))

  assert.deepEqual(claimer.claim(second, 'run-b'), [{ runId: 'run-b', type: 'done' }])
  assert.deepEqual(claimer.claim(first, 'run-a'), [{ runId: 'run-a', type: 'done' }])
})
