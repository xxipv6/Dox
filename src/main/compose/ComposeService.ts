import { randomUUID } from 'node:crypto'
import type { Client } from 'ssh2'
import type { ComposeRunEvent, ComposeVerb } from '../../shared/types'
import { execCapture, execStream, type ExecStreamHandle } from '../ssh/remoteExec'
import { runLocal, runLocalStream } from '../container/localRun'
import { outputsOf } from '../execError'
import { assertContainerTarget, shellJoinArgv } from '../container/runtime'
import { isLocalContainerTarget } from '../../shared/sessionId'
import { createChunkBatcher } from '../chunkBatcher'

/**
 * Docker Compose 右键动作（SFTP 面板对 compose 文件直接 up/restart/down）。
 *
 * **流式 + 可取消**：compose 是最容易炸的命令（拉镜像超时、端口占用、yaml
 * 语法错），闷跑十分钟再给结果是反人类的 —— 输出边跑边经 composeEvent
 * 推进渲染层的底部抽屉，用户看着不对随时取消（关 SSH 通道 ≈ 远端收 HUP；
 * 本机 SIGTERM），改完 Dockerfile 再来一遍。
 *
 * 两个目标形态：
 *  - 宿主机：/bin/sh 自检测脚本（v2 插件优先，legacy docker-compose 降级），
 *    探测与执行在同一条命令里，流式一路到底；
 *  - 容器（dind）：先一次快速探测内层有没有 v2，再流式跑选中的形态
 *    （流式没法像脚本那样 if-else 降级，探测这步省不掉）。
 */

const RUN_TIMEOUT_MS = 10 * 60_000
const DETECT_TIMEOUT_MS = 10_000

const VERB_ARGS: Record<ComposeVerb, string[]> = {
  // up 固定带 -d：不分离的话 exec 通道会挂在服务日志上，这个动作就该是后台语义
  up: ['up', '-d'],
  restart: ['restart'],
  down: ['down']
}

/** sh 单引号包裹（路径来自渲染层，quoting 防分词也防注入） */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

interface RunningCompose {
  handle: { cancel: () => void } | null
  /** 取消打在句柄就位之前：置标志，句柄到了立即补刀 */
  canceled: boolean
}

export class ComposeService {
  /** 事件出口（main/index.ts 接线成广播） */
  onEvent: (ev: ComposeRunEvent) => void = () => {}
  private running = new Map<string, RunningCompose>()

  constructor(
    private getClient: (id: string) => Client | undefined,
    /** 宿主/本机 runtime 二进制解析（容器目标用；来自 ContainerManager 的探测缓存） */
    private runtimeBinary: (parentSessionId: string) => Promise<string | null>
  ) {}

  /** 启动一次 compose 动作，立即返回 runId；输出与结局走 onEvent */
  start(
    sessionId: string,
    containerName: string | undefined,
    filePath: string,
    verb: ComposeVerb
  ): string {
    // 只挡相对路径与控制字符；空格目录是合法的（下游 quoting/argv 都能正确处理）
    if (!/^\/[^\0\n\r]+$/.test(filePath)) throw new Error(`compose 文件路径不合法：${JSON.stringify(filePath)}`)
    const id = randomUUID()
    // 先占位再开跑：取消打在探测期/通道建立前也要生效（标志位模式，
    // 句柄晚到时检查标志立即 cancel），也挡住「结局事件先于渲染层注册」的竞态
    const slot: RunningCompose = { handle: null, canceled: false }
    this.running.set(id, slot)
    queueMicrotask(() => void this.drive(id, slot, sessionId, containerName, filePath, verb))
    return id
  }

  /** 取消：关通道/杀进程，远端 compose 收 HUP 退出（≈ 终端里 Ctrl+C） */
  cancel(id: string): void {
    const slot = this.running.get(id)
    if (!slot) return
    slot.canceled = true
    slot.handle?.cancel()
  }

  private emit(ev: ComposeRunEvent): void {
    this.onEvent(ev)
  }

  private async drive(
    id: string,
    slot: RunningCompose,
    sessionId: string,
    containerName: string | undefined,
    filePath: string,
    verb: ComposeVerb
  ): Promise<void> {
    const verbArgs = VERB_ARGS[verb]
    /*
     * 拉镜像的进度条每秒成百上千个小 chunk（\r 重写同一行），逐条发 IPC
     * 会烧结构化克隆 —— 与终端输出同款的 4ms/64KB 批处理先合流再发。
     * 出口只有 emitData 一个，结局前 flush 一次不丢尾。
     */
    const batcher = createChunkBatcher((buf) =>
      this.emit({ id, type: 'data', text: buf.toString('utf8') })
    )
    const emitData = (text: string): void => batcher.push(Buffer.from(text, 'utf8'))
    try {
      const handle = containerName
        ? await this.startInContainer(id, emitData, sessionId, containerName, filePath, verbArgs)
        : this.startOnHost(id, emitData, sessionId, filePath, verbArgs)
      // 取消打在探测期（startInContainer 最长 10s）：句柄刚到手就补 cancel
      if (slot.canceled) handle.cancel()
      slot.handle = handle
      const { code, canceled } = await handle.done
      batcher.flush()
      this.emit({ id, type: 'exit', code, canceled: canceled || slot.canceled })
    } catch (err) {
      const { stdout, stderr } = outputsOf(err)
      const text = [stdout, stderr].filter(Boolean).join('\n')
      if (text) emitData(`\n${text}\n`)
      batcher.flush()
      this.emit({ id, type: 'exit', code: 1, canceled: slot.canceled })
    } finally {
      batcher.dispose()
      this.running.delete(id)
    }
  }

  // ---- 宿主机：自检测脚本，探测+执行一条命令流式到底 ----

  private startOnHost(
    id: string,
    emitData: (text: string) => void,
    sessionId: string,
    filePath: string,
    verbArgs: string[]
  ): ExecStreamHandle {
    const client = this.getClient(sessionId)
    if (!client) throw new Error('会话已断开，请先恢复连接')
    const args = verbArgs.join(' ')
    const script =
      `PATH="$PATH:/usr/local/sbin:/usr/local/bin:/snap/bin"; ` +
      `if docker compose version >/dev/null 2>&1; then docker compose -f ${q(filePath)} ${args}; ` +
      `elif command -v docker-compose >/dev/null 2>&1; then docker-compose -f ${q(filePath)} ${args}; ` +
      `else echo "这台机器上没有 docker compose（v2 插件与 docker-compose 都没有）" >&2; exit 127; fi`
    void id
    return execStream(client, `/bin/sh -c ${q(script)}`, {
      timeoutMs: RUN_TIMEOUT_MS,
      onData: emitData
    })
  }

  // ---- 容器（dind；只支持顶层容器）：先探测内层形态，再流式跑 ----

  private async startInContainer(
    id: string,
    emitData: (text: string) => void,
    parentSessionId: string,
    containerName: string,
    filePath: string,
    verbArgs: string[]
  ): Promise<ExecStreamHandle> {
    assertContainerTarget(containerName)
    const local = isLocalContainerTarget(parentSessionId)
    const outer = local
      ? ((await this.runtimeBinary(parentSessionId)) ?? 'docker')
      : await this.runtimeBinary(parentSessionId)
    if (!outer) throw new Error('宿主侧还没探测到容器运行时，先在侧栏容器面板刷新一次')
    const client = local ? null : this.getClient(parentSessionId)
    if (!local && !client) throw new Error('父会话已断开，请先恢复 SSH 连接')

    // 内层 compose 形态探测：v2 子命令在不在（distroless 没有 sh，探测也走 argv 不经 shell）
    const detectArgv = [outer, 'exec', containerName, 'docker', 'compose', 'version']
    let hasV2 = false
    try {
      if (local) {
        await runLocal(detectArgv[0], detectArgv.slice(1), { timeoutMs: DETECT_TIMEOUT_MS })
        hasV2 = true
      } else {
        const res = await execCapture(client!, shellJoinArgv(detectArgv), {
          timeoutMs: DETECT_TIMEOUT_MS
        })
        hasV2 = res.code === 0
      }
    } catch {
      hasV2 = false
    }
    const inner = hasV2 ? ['docker', 'compose'] : ['docker-compose']
    void id
    emitData(`（容器 ${containerName} 内执行：${inner.join(' ')} ${['-f', filePath, ...verbArgs].join(' ')}）\n`)

    const argv = [outer, 'exec', containerName, ...inner, '-f', filePath, ...verbArgs]
    if (local) {
      return runLocalStream(argv[0], argv.slice(1), {
        timeoutMs: RUN_TIMEOUT_MS,
        onData: emitData
      })
    }
    return execStream(client!, shellJoinArgv(argv), {
      timeoutMs: RUN_TIMEOUT_MS,
      onData: emitData
    })
  }
}
