import { app, BrowserWindow } from 'electron'

/**
 * CLI 伴侣（dox 命令）的参数通道。
 *
 * 不注册 URL scheme、不开 socket：`dox` 脚本直接用 app 二进制带参数启动 ——
 * 没跑 = 正常冷启动（参数在 process.argv 里）；
 * 在跑 = 第二个进程被单实例锁挡下，参数经 second-instance 转给在跑的实例。
 * 系统里不留任何协议注册痕迹。
 *
 * 参数契约：`--cli=focus` / `--cli=local --cwd=<dir>` / `--cli=connect --target=<user@host:port>`
 *
 * 为什么必须用 `=` 连写：`--cli local --cwd /tmp` 这种空格形式会被 Chromium
 * 的命令行解析拆成「开关组 + 裸参数组」重新排序（second-instance 收到的
 * argv 变成 --cli --cwd . local /tmp），flag 和值彻底失联；`=` 形式的值
 * 跟随开关不位移（实测踩过）。
 */

export interface CliCommand {
  kind: 'focus' | 'local' | 'connect'
  cwd?: string
  target?: string
}

export function parseCliArgv(argv: string[]): CliCommand | null {
  const raw = argv.find((a) => a === '--cli' || a.startsWith('--cli='))
  if (!raw) return null
  // `=` 形式值在开关里；空格形式取下一个裸参数（冷启动 argv 未重排时可兼容）
  const action = raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : argv[argv.indexOf(raw) + 1]
  const read = (flag: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`${flag}=`))
    return hit ? hit.slice(flag.length + 1) : undefined
  }
  switch (action) {
    case 'focus':
      return { kind: 'focus' }
    case 'local': {
      let cwd = read('--cwd')
      // 批处理把带结尾反斜杠的路径塞进引号参数时，CommandLineToArgvW 把 \"
      // 当转义引号，值会吃进一个引号（--cwd=C:"）。dox.cmd 已对盘符根目录
      // 双写反斜杠规避；这里剥掉残留引号兜底（win32 路径本就不能含引号）
      if (cwd && process.platform === 'win32') cwd = cwd.replace(/"+$/g, '')
      return cwd ? { kind: 'local', cwd } : null
    }
    case 'connect': {
      const target = read('--target')
      return target ? { kind: 'connect', target } : null
    }
    default:
      return null
  }
}

/** 窗口还没建好/没加载完时收到的命令先排队（second-instance 会早于第一帧） */
let pending: CliCommand[] = []
let rendererReady = false
/** 冷启动参数只投递一次：渲染层每次 HMR 重载都会报 ready，不能重复开标签 */
let bootDelivered = false

function deliver(cmd: CliCommand): void {
  if (!rendererReady) {
    pending.push(cmd)
    return
  }
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) {
    pending.push(cmd)
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send('cli:command', cmd)
}

/**
 * 注册单实例锁与 second-instance 入口（必须在 ready 之前调）。
 * 返回 false = 已有实例在跑：本进程的参数已经转交给它，这里直接退出。
 */
export function setupCliCommand(): boolean {
  if (!app.requestSingleInstanceLock()) return false
  app.on('second-instance', (_e, argv) => {
    deliver(parseCliArgv(argv) ?? { kind: 'focus' })
  })
  return true
}

/** 渲染层挂载完成后调用：投递排队的命令 + 冷启动参数（仅一次） */
export function flushCliCommand(): void {
  const first = pending.splice(0)
  rendererReady = true
  for (const cmd of first) deliver(cmd)
  if (!bootDelivered) {
    bootDelivered = true
    const boot = parseCliArgv(process.argv)
    if (boot) deliver(boot)
  }
}
