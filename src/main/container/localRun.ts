import { execFile, spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { CommandError, firstLine } from '../execError'

/**
 * 在本机跑一条命令并收齐输出 —— `ssh/remoteExec.ts` 的本机版。
 *
 * 两者形状一样（resolve 成功输出 / reject 带两路输出的 CommandError），
 * 所以上层的 docker 错误分类、降级重试逻辑一个字都不用改就能两路通用。
 *
 * 三个刻意的选择：
 *
 * 1. **走 execFile 而不是 exec。** 不经 shell，参数就是 argv —— 既没有引号
 *    转义问题，也没有把容器名拼进命令串的注入面。远端之所以要套 `/bin/sh -c`，
 *    是因为 sshd 只收字符串，本机没这个限制。
 * 2. **不接管 env。** `execFile` 默认继承 `process.env`，也就是启动 Dox 的那个
 *    环境。Docker Desktop / Podman Desktop 装在系统 PATH 上，正常都能找到；
 *    反过来往里塞 PATH 只会让「为什么我这里找不到」更难查。
 * 3. **ENOENT 单独归类成 `spawn`。** 「本机没装 docker」和「docker 报错了」
 *    要给用户完全不同的提示，不能都塌成一句 generic 失败。
 */

export interface LocalRunResult {
  stdout: string
  stderr: string
  code: number
}

const DEFAULT_TIMEOUT_MS = 10_000

export function runLocal(
  binary: string,
  args: string[],
  opts: { timeoutMs?: number } = {}
): Promise<LocalRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<LocalRunResult>((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout, stderr, code: 0 })
          return
        }

        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean }
        // ENOENT：PATH 里没有这个可执行文件。这是「没装」，不是「跑失败了」
        if (e.code === 'ENOENT') {
          reject(new CommandError(`找不到可执行文件 ${binary}`, 'spawn', null, stdout, stderr))
          return
        }
        // execFile 在超时时把 code 设成 'ETIMEDOUT'，且会先 kill 掉子进程
        if (e.code === 'ETIMEDOUT' || e.killed) {
          reject(
            new CommandError(`本机命令超时（${timeoutMs}ms）`, 'timeout', null, stdout, stderr)
          )
          return
        }

        const exitCode = typeof e.code === 'number' ? e.code : null
        reject(
          new CommandError(
            firstLine(stderr) || firstLine(stdout) || `本机命令退出码 ${exitCode}`,
            'exit',
            exitCode,
            stdout,
            stderr
          )
        )
      }
    )
  })
}

/** 可执行文件不存在（本机没装 / 不在 PATH 上） */
export function isNotFound(err: unknown): boolean {
  return err instanceof CommandError && err.failure === 'spawn'
}

/**
 * runLocal 的流式版（spawn 边跑边吐输出），带取消（SIGTERM 杀子进程）。
 * 用途同远端 execStream：compose 这类长时间命令的本机侧承载。
 */
export function runLocalStream(
  binary: string,
  args: string[],
  opts: { timeoutMs?: number; onData: (text: string) => void }
): { done: Promise<{ code: number; canceled: boolean }>; cancel: () => void } {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000
  const child = spawn(binary, args, { windowsHide: true })
  let canceled = false
  const decOut = new StringDecoder('utf8')
  const decErr = new StringDecoder('utf8')

  const done = new Promise<{ code: number; canceled: boolean }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`本机命令超时（${timeoutMs}ms）`))
    }, timeoutMs)
    timer.unref()

    child.stdout?.on('data', (chunk: Buffer) => opts.onData(decOut.write(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => opts.onData(decErr.write(chunk)))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const tail = decOut.end() + decErr.end()
      if (tail) opts.onData(tail)
      resolve({ code: code ?? 1, canceled })
    })
  })

  return {
    done,
    cancel: () => {
      if (canceled) return
      canceled = true
      child.kill('SIGTERM')
    }
  }
}
