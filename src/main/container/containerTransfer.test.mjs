import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createContainerTransferIO } from './containerTransfer.ts'

class ExecChannel extends EventEmitter {
  stderr = new EventEmitter()
  close() { this.emit('close') }
}

test('S3 基线: rawTar 探测 single-flight，命令保持 argv quoting', async () => {
  const commands = []
  const client = {
    exec(command, _opts, cb) {
      commands.push(command)
      const channel = new ExecChannel()
      cb(undefined, channel)
      queueMicrotask(() => {
        channel.emit('exit', 0)
        channel.emit('close')
      })
    }
  }
  const io = createContainerTransferIO(() => client, async () => '/usr/bin/docker', 's', 'ctr')
  assert.deepEqual(await Promise.all([io.rawTar.supportsTar(), io.rawTar.supportsTar()]), [true, true])
  assert.equal(commands.length, 1)
  assert.equal(
    io.rawTar.command("/tmp/a'b"),
    `'/usr/bin/docker' exec -i ctr tar -cf - -C '/tmp' -- 'a'\\''b'`
  )
})
