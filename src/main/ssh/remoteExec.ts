import { StringDecoder } from 'node:string_decoder'
import type { Client, ClientChannel } from 'ssh2'
import { CommandError, ExecFailure, firstLine } from '../execError'

/**
 * 在**已有**的 SSH 连接上跑一条命令，把 stdout / stderr 分开收齐。
 *
 * 整个仓库原先只有 `client.shell()`（交互式 shell），没有「跑一条命令拿输出」
 * 的能力。容器探测要的就是后者。
 *
 * 三条刻意的设计：
 *
 * 1. **不开 pty。** 加了 pty，远端会把 stderr 并进 stdout、把 `
` 改写成 `

`、
 *    还会把命令回显混进来 —— 而 docker 的错误分类全靠 stderr 的原文。
 * 2. **非零退出码也把输出带回来。** 直接 reject 成一句话会把「docker 不存在」
 *    和「没权限」压成同一个样子；这两件事要给用户完全不同的提示。
 * 3. **不做重连校验。** 调用方应当在 await 前后各取一次 client 做同一性比对
 *    （见 SessionManager.sftp 的写法）—— 这个函数拿到的 client 是快照，
 *    它没有能力判断连接是否已被换掉。
 *
 * 错误对象与 outputsOf 定义在 ../execError.ts：本机那条路要用同一套。
 */

export interface ExecCaptureOptions {
  /** 默认 10s。远端卡住时不能把调用方（往往是界面）挂死 */
  timeoutMs?: number
  /** 默认 1 MiB。容器很多的机器上 `docker ps -a` 输出会很长 */
  maxBytes?: number
}

export interface ExecCaptureResult {
  stdout: string
  stderr: string
  code: number
  truncated: boolean
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 1024 * 1024

/** 信号名 → 编号；拿不到编号时退回 -1，至少能表达「不是正常退出」 */
const SIGNALS: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGPIPE: 13
}

export function execCapture(
  client: Client,
  command: string,
  opts: ExecCaptureOptions = {}
): Promise<ExecCaptureResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES

  return new Promise<ExecCaptureResult>((resolve, reject) => {
    let settled = false
    // 分块收，最后再拼：UTF-8 的多字节序列会跨 chunk，逐块 toString 会出乱码
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    // 「跑完了」以 close 为准（那才是流真的结束），退出码先记下来备用
    let exitCode: number | null = null
    let sawExit = false
    let truncated = false

    let channel: ClientChannel | null = null

    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const finish = (failure: ExecFailure, fallbackMessage: string): void => {
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      if (failure === 'exit') {
        const message = firstLine(stderr) || firstLine(stdout) || fallbackMessage
        reject(new CommandError(message, failure, exitCode, stdout, stderr))
        return
      }
      reject(new CommandError(fallbackMessage, failure, exitCode, stdout, stderr))
    }

    const timer = setTimeout(() => {
      done(() => {
        channel?.close()
        finish('timeout', `远端命令超时（${timeoutMs}ms）`)
      })
      timer.unref?.()
    }, timeoutMs)

    try {
      // socket 已死时 ssh2 会**同步**抛 'Not connected'，必须包住
      client.exec(command, { pty: false }, (error, stream) => {
        if (error) {
          done(() => reject(error))
          return
        }
        channel = stream

        const take = (bucket: Buffer[]) => (chunk: Buffer) => {
          if (settled || truncated) return
          bucket.push(chunk)
          size += chunk.length
          if (size > maxBytes) {
            truncated = true
            done(() => {
              stream.close()
              finish('truncated', `远端命令输出超过 ${maxBytes} 字节，已截断`)
            })
          }
        }
        stream.on('data', take(out))
        // exec 通道一定有 stderr；pty 通道才没有，这里只是防御
        stream.stderr?.on('data', take(err))

        stream.on('exit', (code: number | null, signal?: string) => {
          sawExit = true
          exitCode = code ?? (signal ? -(SIGNALS[signal] ?? 1) : null)
        })

        stream.on('error', (streamErr: Error) => {
          done(() => reject(streamErr))
        })

        stream.on('close', () => {
          done(() => {
            // OpenSSH 对 exec 一定会发 exit-status；收不到就按 0 处理
            if (!sawExit) exitCode = 0
            if (exitCode === 0) {
              resolve({
                stdout: Buffer.concat(out).toString('utf8'),
                stderr: Buffer.concat(err).toString('utf8'),
                code: 0,
                truncated: false
              })
              return
            }
            finish('exit', `远端命令退出码 ${exitCode}`)
          })
        })
      })
    } catch (syncErr) {
      done(() => reject(syncErr))
    }
  })
}

/** 流式执行的句柄：done 拿结果，cancel 中断远端命令（关通道 ≈ 远端收到 HUP） */
export interface ExecStreamHandle {
  done: Promise<{ code: number; canceled: boolean }>
  cancel: () => void
}

/**
 * execCapture 的流式版：边跑边把输出吐给 onData（StringDecoder 处理跨块
 * 的 UTF-8 多字节序列），结束时给退出码。compose 这类「可能跑几分钟、
 * 用户要盯着进度、随时想掐掉改 Dockerfile 再来」的命令用它；
 * 一次性探测仍走 execCapture。
 */
export function execStream(
  client: Client,
  command: string,
  opts: { timeoutMs?: number; onData: (text: string) => void }
): ExecStreamHandle {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000
  let channel: ClientChannel | null = null
  let canceled = false

  const done = new Promise<{ code: number; canceled: boolean }>((resolve, reject) => {
    let settled = false
    let exitCode: number | null = null
    let sawExit = false
    const decOut = new StringDecoder('utf8')
    const decErr = new StringDecoder('utf8')

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      finish(() => {
        channel?.close()
        reject(new Error(`远端命令超时（${timeoutMs}ms）`))
      })
      timer.unref?.()
    }, timeoutMs)

    try {
      // socket 已死时 ssh2 会**同步**抛 'Not connected'，必须包住
      client.exec(command, { pty: false }, (error, stream) => {
        if (error) {
          finish(() => reject(error))
          return
        }
        channel = stream
        stream.on('data', (chunk: Buffer) => opts.onData(decOut.write(chunk)))
        stream.stderr?.on('data', (chunk: Buffer) => opts.onData(decErr.write(chunk)))
        stream.on('exit', (code: number | null) => {
          sawExit = true
          exitCode = code
        })
        stream.on('error', (streamErr: Error) => finish(() => reject(streamErr)))
        stream.on('close', () => {
          // 冲刷解码器尾部，别丢最后一个多字节字符
          const tail = decOut.end() + decErr.end()
          if (tail) opts.onData(tail)
          // OpenSSH 对 exec 一定会发 exit-status；收不到按 0
          finish(() => resolve({ code: sawExit ? (exitCode ?? 0) : 0, canceled }))
        })
      })
    } catch (syncErr) {
      finish(() => reject(syncErr))
    }
  })

  return {
    done,
    cancel: () => {
      // 幂等：连点取消不会重复关通道
      if (canceled) return
      canceled = true
      channel?.close()
    }
  }
}
