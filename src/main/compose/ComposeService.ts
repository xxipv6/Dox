import type { Client } from 'ssh2'
import type { ComposeRunResult, ComposeVerb } from '../../shared/types'
import { execCapture } from '../ssh/remoteExec'
import { CommandError, outputsOf } from '../execError'
import { runLocal } from '../container/localRun'
import { assertContainerTarget, shellJoinArgv } from '../container/runtime'
import { isLocalContainerTarget } from '../../shared/sessionId'

/**
 * Docker Compose 右键动作（SFTP 面板对 compose 文件直接 up/restart/down）。
 *
 * 两个目标形态：
 *  - 宿主机：在既有 SSH 连接上跑一条自检测脚本（v2 插件优先，老式
 *    docker-compose 自动降级），/bin/sh 包裹 + 补 PATH 与容器探测同口径；
 *  - 容器（dind 场景）：宿主 runtime exec 进容器跑 compose，内层同样
 *    先 v2 后 legacy。嵌套容器不支持（文件面板就不对嵌套开放）。
 *
 * 输出合流返回（compose 的进度本来就走 stderr，分开渲染反而别扭）。
 * 这些动作与容器生命周期操作同口径：用户显式触发的 docker 子命令，
 * 不装东西、不留文件 —— down 的确认在渲染层。
 */

/** compose up 可能拉镜像，给足 10 分钟；输出截 1MB 保尾部 */
const RUN_TIMEOUT_MS = 10 * 60_000
const RUN_MAX_BYTES = 1024 * 1024

const VERB_ARGS: Record<ComposeVerb, string[]> = {
  up: ['up', '-d'],
  restart: ['restart'],
  down: ['down']
}

/** sh 单引号包裹（路径来自渲染层，quoting 防分词也防注入） */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export class ComposeService {
  constructor(
    private getClient: (id: string) => Client | undefined,
    /** 宿主/本机 runtime 二进制解析（容器目标用；来自 ContainerManager 的探测缓存） */
    private runtimeBinary: (parentSessionId: string) => Promise<string | null>
  ) {}

  async run(
    sessionId: string,
    containerName: string | undefined,
    filePath: string,
    verb: ComposeVerb
  ): Promise<ComposeRunResult> {
    if (!/^\/\S+$/.test(filePath)) throw new Error(`compose 文件路径不合法：${JSON.stringify(filePath)}`)
    return containerName
      ? this.runInContainer(sessionId, containerName, filePath, verb)
      : this.runOnHost(sessionId, filePath, verb)
  }

  // ---- 宿主机 ----

  private async runOnHost(
    sessionId: string,
    filePath: string,
    verb: ComposeVerb
  ): Promise<ComposeRunResult> {
    const client = this.getClient(sessionId)
    if (!client) throw new Error('会话已断开，请先恢复连接')
    const args = VERB_ARGS[verb].join(' ')
    const script =
      `PATH="$PATH:/usr/local/sbin:/usr/local/bin:/snap/bin"; ` +
      `if docker compose version >/dev/null 2>&1; then docker compose -f ${q(filePath)} ${args}; ` +
      `elif command -v docker-compose >/dev/null 2>&1; then docker-compose -f ${q(filePath)} ${args}; ` +
      `else echo "这台机器上没有 docker compose（v2 插件与 docker-compose 都没有）" >&2; exit 127; fi`
    try {
      const res = await execCapture(client, `/bin/sh -c ${q(script)}`, {
        timeoutMs: RUN_TIMEOUT_MS,
        maxBytes: RUN_MAX_BYTES
      })
      return toResult(res.code, res.stdout, res.stderr, res.truncated)
    } catch (err) {
      return errorResult(err)
    }
  }

  // ---- 容器（dind；只支持顶层容器）----

  private async runInContainer(
    parentSessionId: string,
    containerName: string,
    filePath: string,
    verb: ComposeVerb
  ): Promise<ComposeRunResult> {
    assertContainerTarget(containerName)
    const verbArgs = VERB_ARGS[verb]

    // 内层 compose 的两种形态都试：v2 子命令 → legacy 二进制
    const variants: string[][] = [
      ['docker', 'compose', '-f', filePath, ...verbArgs],
      ['docker-compose', '-f', filePath, ...verbArgs]
    ]

    if (isLocalContainerTarget(parentSessionId)) {
      const bin = (await this.runtimeBinary(parentSessionId)) ?? 'docker'
      let lastErr: unknown = null
      for (const inner of variants) {
        try {
          const res = await runLocal(bin, ['exec', containerName, ...inner], {
            timeoutMs: RUN_TIMEOUT_MS
          })
          return toResult(res.code, res.stdout, res.stderr, false)
        } catch (err) {
          lastErr = err
          if (!isMissingInner(err)) break
        }
      }
      return errorResult(lastErr)
    }

    const client = this.getClient(parentSessionId)
    if (!client) throw new Error('父会话已断开，请先恢复 SSH 连接')
    const outer = await this.runtimeBinary(parentSessionId)
    if (!outer) throw new Error('宿主侧还没探测到容器运行时，先在侧栏容器面板刷新一次')

    for (const inner of variants) {
      const argv = [outer, 'exec', containerName, ...inner]
      try {
        const res = await execCapture(client, shellJoinArgv(argv), {
          timeoutMs: RUN_TIMEOUT_MS,
          maxBytes: RUN_MAX_BYTES
        })
        return toResult(res.code, res.stdout, res.stderr, res.truncated)
      } catch (err) {
        if (!isMissingInner(err)) return errorResult(err)
      }
    }
    return { ok: false, code: 127, output: '容器里没有 docker compose', truncated: false }
  }
}

/** 内层没有 compose 的两种报错形态（v2 子命令缺失 / legacy 二进制缺失） */
function isMissingInner(err: unknown): boolean {
  const { stdout, stderr } = outputsOf(err)
  return /executable file not found|not found in \$PATH|unknown command/i.test(`${stdout}\n${stderr}`)
}

function toResult(code: number, stdout: string, stderr: string, truncated: boolean): ComposeRunResult {
  // 进度在 stderr、结果在 stdout：先 stdout 后 stderr 合流，读感最接近终端直出
  const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n')
  return { ok: code === 0, code, output, truncated }
}

function errorResult(err: unknown): ComposeRunResult {
  if (err instanceof CommandError) {
    return toResult(err.code ?? 1, err.stdout ?? '', err.stderr ?? '', false)
  }
  throw err
}
