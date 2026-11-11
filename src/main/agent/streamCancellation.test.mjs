import assert from 'node:assert/strict'
import test from 'node:test'
import { createStreamCancellation, STREAM_CANCELED } from './streamCancellation.ts'

test('S3: 重复取消只中断一次并只发一次 remote abort，dispose 保持幂等归属', async () => {
  let cancel
  let disposed = 0
  let aborted = 0
  let canceled = false
  const ctl = createStreamCancellation(
    () => canceled,
    (cb) => {
      cancel = cb
      return () => { disposed++ }
    },
    async () => { aborted++ }
  )
  const waiting = ctl.wait(new Promise(() => undefined))
  canceled = true
  cancel()
  cancel()
  await assert.rejects(waiting, (err) => err.message === STREAM_CANCELED)
  assert.equal(aborted, 1)
  assert.throws(() => ctl.check(), new Error(STREAM_CANCELED))
  ctl.dispose()
  assert.equal(disposed, 1)
})

test('S3: 未取消的等待仍返回原结果', async () => {
  const ctl = createStreamCancellation(() => false)
  assert.equal(await ctl.wait(Promise.resolve(42)), 42)
  ctl.dispose()
})
