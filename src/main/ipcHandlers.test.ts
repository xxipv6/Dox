import assert from 'node:assert/strict'
import test from 'node:test'
import { ipcMain, shell } from 'electron'
import { IpcChannels } from '../shared/ipc.ts'
import { registerIpc } from './ipc/index.ts'

function registerRouteFixture(): {
  handlers: Map<string, (...args: any[]) => unknown>
  connectSaved: unknown[][]
  uninstall: unknown[][]
} {
  const handlers = (ipcMain as any).handlers as Map<string, (...args: any[]) => unknown>
  handlers.clear()
  const connectSaved: unknown[][] = []
  const uninstall: unknown[][] = []
  const sessionManager = {
    connectSaved: async (...args: unknown[]) => {
      connectSaved.push(args)
      return 'session-1'
    }
  }
  const agentManager = {
    uninstall: async (...args: unknown[]) => {
      uninstall.push(args)
      return { installed: false }
    }
  }
  registerIpc(
    sessionManager as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    agentManager as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  )
  return { handlers, connectSaved, uninstall }
}

test('sshConnectSaved IPC 只转发 id/term，agentUninstall 直接调用领域卸载', async () => {
  const { handlers, connectSaved, uninstall } = registerRouteFixture()
  const owner = {}
  const term = { cols: 120, rows: 40 }
  const event = { sender: owner }

  assert.equal(await handlers.get(IpcChannels.sshConnectSaved)!(event, 'saved-1', term), 'session-1')
  assert.deepEqual(connectSaved, [['saved-1', owner, term]])
  assert.deepEqual(await handlers.get(IpcChannels.agentUninstall)!(event, 'session-1', 'ctr'), {
    installed: false
  })
  assert.deepEqual(uninstall, [['session-1', 'ctr']])
  assert.equal(handlers.has('config:getAuth'), false)
})

test('shellOpenExternal IPC 通过共享 HTTP(S) 策略，不打开其他 scheme', async () => {
  const { handlers } = registerRouteFixture()
  const opened: string[] = []
  ;(shell as any).openExternal = async (url: string): Promise<void> => {
    opened.push(url)
  }
  const handler = handlers.get(IpcChannels.shellOpenExternal)!
  await handler({}, 'file:///C:/Windows/System32/cmd.exe')
  await handler({}, 'https://example.test/docs')
  assert.deepEqual(opened, ['https://example.test/docs'])
})
