import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { CommandError, firstLine } from '../execError'
import { mergeEnv, resolveShellEnv } from '../local/shellEnv'

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
 * 2. **env 用 login shell 解析出的「现在的环境」而不是裸 process.env。**
 *    从 Finder/Dock 启动的 GUI 进程只有 launchd 的最小 PATH（没有
 *    /opt/homebrew/bin 等），Homebrew 装的 docker/podman 裸名直接 ENOENT，
 *    面板会误报「没装」；dev 从终端启动继承了全量 PATH，永远暴露不了。
 *    顺带 login 环境里的 DOCKER_HOST / DOCKER_CONTEXT（colima、podman
 *    machine 用户常设）也能进来。解析失败回退 process.env，不会更差。
 * 3. **ENOENT 单独归类成 `spawn`。** 「本机没装 docker」和「docker 报错了」
 *    要给用户完全不同的提示，不能都塌成一句 generic 失败。
 */

export interface LocalRunResult {
  stdout: string
  stderr: string
  code: number
}

const DEFAULT_TIMEOUT_MS = 10_000

/** 本机子进程环境：process.env < login shell 当前环境（与 LocalPtyManager 同一合并口径） */
async function localEnv(): Promise<Record<string, string>> {
  const loginEnv = await resolveShellEnv()
  return mergeEnv(process.env as Record<string, string>, loginEnv ?? {})
}

export function runLocal(
  binary: string,
  args: string[],
  opts: { timeoutMs?: number } = {}
): Promise<LocalRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return localEnv().then(
    (env) =>
      new Promise<LocalRunResult>((resolve, reject) => {
        execFile(
          binary,
          args,
          { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env },
          (err, stdout, stderr) => {
            if (!err) {
              resolve({ stdout, stderr, code: 0 })
              return
            }

            const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean }
            // ENOENT：PATH 里没有这个可执行文件。这是「没装」，不是「跑失败了」
            if (e.code === 'ENOENT') {
              reject(
                new CommandError(`找不到可执行文件 ${binary}`, 'spawn', null, stdout, stderr)
              )
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
  )
}

/** 可执行文件不存在（本机没装 / 不在 PATH 上） */
export function isNotFound(err: unknown): boolean {
  return err instanceof CommandError && err.failure === 'spawn'
}

/**
 * runLocal 的流式版（spawn 边跑边吐输出），带取消（SIGTERM 杀子进程）。
 * 用途同远端 execStream：compose 这类长时间命令的本机侧承载。
 *
 * onStderr 不给时 stderr 并进 onData（历史行为）；stdout 是结构化数据
 * 的调用方（搜索的 rg --json）必须给 onStderr，warning 混流会打烂解析。
 */
export function runLocalStream(
  binary: string,
  args: string[],
  opts: { timeoutMs?: number; onData: (text: string) => void; onStderr?: (text: string) => void }
): { done: Promise<{ code: number; canceled: boolean }>; cancel: () => void } {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000
  // spawn 要等 env 解析完才有，取消/超时可能抢在 spawn 之前，全部按可空处理
  let child: ChildProcess | null = null
  let canceled = false
  const decOut = new StringDecoder('utf8')
  const decErr = new StringDecoder('utf8')

  /*
   * SIGTERM 后给 3s 宽限，不退出升级 SIGKILL —— 子进程忽略 TERM 时
   * 不能让它没了句柄还继续跑（孤儿 compose pull 就是这么来的）。
   */
  let killTimer: NodeJS.Timeout | null = null
  const terminate = (): void => {
    if (!child) return
    child.kill('SIGTERM')
    killTimer = setTimeout(() => child?.kill('SIGKILL'), 3000)
    killTimer.unref?.()
  }

  const done = new Promise<{ code: number; canceled: boolean }>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      fn()
    }
    const timer = setTimeout(() => {
      terminate()
      settle(() => reject(new Error(`本机命令超时（${timeoutMs}ms）`)))
    }, timeoutMs)
    timer.unref()

    void localEnv().then((env) => {
      // env 解析期间已经被取消/超时：不要再把进程拉起来
      if (settled || canceled) {
        settle(() => resolve({ code: 1, canceled: true }))
        return
      }
      child = spawn(binary, args, { windowsHide: true, env })

      child.stdout?.on('data', (chunk: Buffer) => opts.onData(decOut.write(chunk)))
      child.stderr?.on('data', (chunk: Buffer) => (opts.onStderr ?? opts.onData)(decErr.write(chunk)))
      child.on('error', (err) => {
        // ENOENT 归成「没装」的友好文案，与 runLocal 同口径（裸抛出去只剩一句「失败了」）
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          settle(() => reject(new CommandError(`找不到可执行文件 ${binary}`, 'spawn', null, '', '')))
          return
        }
        settle(() => reject(err))
      })
      child.on('close', (code) => {
        const tailOut = decOut.end()
        const tailErr = decErr.end()
        if (tailOut) opts.onData(tailOut)
        if (tailErr) (opts.onStderr ?? opts.onData)(tailErr)
        settle(() => resolve({ code: code ?? 1, canceled }))
      })
    })
  })

  return {
    done,
    cancel: () => {
      if (canceled) return
      canceled = true
      terminate()
    }
  }
}
