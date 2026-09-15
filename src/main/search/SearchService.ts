import { randomUUID } from 'node:crypto'
import type { Client } from 'ssh2'
import type { SearchEngine, SearchEvent, SearchMatch, SearchStartParams } from '../../shared/types'
import { isLocalId } from '../../shared/sessionId'
import { agentVersionOlder, FS_SEARCH_MIN_AGENT_VERSION } from '../../shared/agentVersion'
import { execCapture, execStream } from '../ssh/remoteExec'
import { runLocalStream } from '../container/localRun'
import { resolveExecutable } from '../local/which'
import type { AgentStatus } from '../agent/AgentManager'
import {
  SEARCH_MAX_TOTAL,
  SEARCH_TIMEOUT_MS,
  buildGrepArgs,
  buildGrepCommand,
  buildRgArgs,
  buildRgCommand,
  createLineAccumulator,
  createNodeMatcher,
  isPatternSafe,
  parseGrepLine,
  parseRgJsonLine
} from './commands'
import { searchLocalNode } from './localNodeSearch'

/**
 * 项目模式全文搜索（对标 VS Code 全局搜索）。
 *
 * 三级引擎回退链（同一目标只探测一次，结果缓存）：
 *   agent（dox-agent fs_search，RE2 并发遍历）→ rg（现成的 ripgrep）
 *   → grep（POSIX 保底）→ node（Windows 本机纯遍历兜底）。
 * 红线：绝不往远端装任何东西（rg 只用现成的）；容器只走 agent（没装/过旧 =
 * 报错指路，文案在这里组装好），绝不回退。
 *
 * 三路引擎在主进程统一成同一条 SearchEvent 流：rg/grep 边搜边出，
 * agent 一问一答拿到全量后按 200 条/批重放 —— UI 感知不到引擎差异。
 *
 * 取消语义：SSH 关通道（远端收 HUP）、本机 SIGTERM→SIGKILL、node 协作旗标
 * 都是真取消；agent 一问一答不可取消（协议级取消超出一期范畴），
 * 靠 agent 内部 8s 硬预算兜底 + 这里按 runId 丢弃迟到响应。
 */

/** AgentManager 的结构子集（注入子集接口：可 mock，也避免 search → AgentManager 重依赖） */
export interface SearchAgentBridge {
  status: (sessionId: string, containerName?: string) => Promise<AgentStatus>
  call: (sessionId: string, containerName: string | undefined, method: string, params: unknown) => Promise<unknown>
}

interface RunningSearch {
  handle: { cancel: () => void } | null
  /** 取消打在句柄就位之前：置标志，句柄到了立即补刀（ComposeService 同款模式） */
  canceled: boolean
  /** 已经发出过 match（超时/出错时据此决定 done{truncated} 还是 error） */
  emitted: boolean
  matchCount: number
  started: number
  /** 归属会话：掉线时按它整批取消 */
  fsSessionId: string
}

interface AgentSearchResponse {
  matches?: SearchMatch[]
  truncated?: boolean
  files_searched?: number
  elapsed_ms?: number
}

/** match 合批：50ms 或 200 条一批，防 IPC 信封风暴 */
const MATCH_BATCH_MS = 50
const MATCH_BATCH_SIZE = 200

/** grep 的 flag 不被认（BusyBox 不认 --null/--exclude-dir）时抛出，触发去 --null 的重试梯子 */
const GREP_FLAGS_UNSUPPORTED = 'grep: flags unsupported (busybox?)'

export class SearchService {
  /** 事件出口（main/index.ts 接线成全窗口广播；渲染层按 runId 过滤） */
  onEvent: (ev: SearchEvent) => void = () => {}

  private running = new Map<string, RunningSearch>()
  /** 引擎探测缓存：key = `${fsSessionId}|${containerName ?? ''}`（同一目标只探一次） */
  private engineCache = new Map<string, SearchEngine>()
  /** 远端 rg 的绝对路径（按会话）：探测一次够用，别每次搜索都 command -v */
  private rgPathCache = new Map<string, string>()

  constructor(
    private getClient: (id: string) => Client | undefined,
    private agent: SearchAgentBridge
  ) {}

  /** 启动一次搜索，立即返回 runId 与选定的引擎；结果与结局走 onEvent */
  async start(params: SearchStartParams): Promise<{ runId: string; engine: SearchEngine }> {
    if (!isPatternSafe(params.pattern)) throw new Error('搜索词不合法（不能为空、不含换行）')
    if (!params.root) throw new Error('搜索范围不能为空')
    const runId = randomUUID()
    const slot: RunningSearch = {
      handle: null,
      canceled: false,
      emitted: false,
      matchCount: 0,
      started: Date.now(),
      fsSessionId: params.fsSessionId
    }
    this.running.set(runId, slot)
    try {
      const engine = await this.pickEngine(params)
      queueMicrotask(() => void this.drive(runId, slot, engine, params))
      return { runId, engine }
    } catch (err) {
      this.running.delete(runId)
      throw err
    }
  }

  cancel(runId: string): void {
    const slot = this.running.get(runId)
    if (!slot) return
    slot.canceled = true
    slot.handle?.cancel()
  }

  /** 会话断开：其上跑着的搜索全部取消（双保险，面板一般也随标签销毁了） */
  cancelBySession(fsSessionId: string): void {
    for (const slot of this.running.values()) {
      if (slot.fsSessionId !== fsSessionId) continue
      slot.canceled = true
      slot.handle?.cancel()
    }
  }

  // ---- 引擎选择（带缓存 + 自愈降级）----

  private async pickEngine(params: SearchStartParams): Promise<SearchEngine> {
    const key = `${params.fsSessionId}|${params.containerName ?? ''}`
    const cached = this.engineCache.get(key)
    if (cached) return cached
    const engine = await this.detectEngine(params)
    this.engineCache.set(key, engine)
    return engine
  }

  private async detectEngine(params: SearchStartParams): Promise<SearchEngine> {
    // 容器分支：只走 agent（容器文件操作的既有红线），没装/过旧 = 指路
    if (params.containerName) {
      const st = await this.agent.status(params.fsSessionId, params.containerName)
      if (!st.installed) {
        throw new Error(`在容器里搜索需要容器助手（dox-agent），请在侧栏「远程助手」安装到容器 ${params.containerName}`)
      }
      if (st.version && agentVersionOlder(st.version, FS_SEARCH_MIN_AGENT_VERSION)) {
        throw new Error(`容器内搜索需要容器助手 v${FS_SEARCH_MIN_AGENT_VERSION}（当前 v${st.version}），请在侧栏「远程助手」升级`)
      }
      return 'agent'
    }
    // SSH 分支：agent → rg → grep
    if (!isLocalId(params.fsSessionId)) {
      const st = await this.agent.status(params.fsSessionId).catch(() => null)
      if (st?.installed && !(st.version && agentVersionOlder(st.version, FS_SEARCH_MIN_AGENT_VERSION))) {
        return 'agent'
      }
      const client = this.getClient(params.fsSessionId)
      if (!client) throw new Error('连接已断开')
      try {
        await execCapture(client, 'command -v rg', { timeoutMs: 5000 })
        return 'rg'
      } catch {
        return 'grep' // POSIX 必有；真没有则命令退出 127，错误文案自然上浮
      }
    }
    // 本机分支：rg → grep（仅 POSIX）→ node（Windows 兜底）
    const rgPath = await resolveExecutable('rg')
    if (rgPath !== 'rg') return 'rg'
    if (process.platform !== 'win32') {
      const grepPath = await resolveExecutable('grep')
      if (grepPath !== 'grep') return 'grep'
    }
    return 'node'
  }

  // ---- 执行 ----

  private emit(runId: string, slot: RunningSearch, matches: SearchMatch[]): void {
    slot.emitted = true
    slot.matchCount += matches.length
    this.onEvent({ runId, type: 'match', matches })
  }

  private async drive(
    runId: string,
    slot: RunningSearch,
    engine: SearchEngine,
    params: SearchStartParams
  ): Promise<void> {
    /** match 合批出口：所有引擎共用这一个，结局前 flush 不丢尾 */
    let batch: SearchMatch[] = []
    let batchTimer: NodeJS.Timeout | null = null
    const flushBatch = (): void => {
      if (batchTimer) {
        clearTimeout(batchTimer)
        batchTimer = null
      }
      if (batch.length) {
        const out = batch
        batch = []
        this.emit(runId, slot, out)
      }
    }
    const pushMatches = (matches: SearchMatch[]): void => {
      // 总量上限 service 自扛：撞线取消引擎句柄，结局记 truncated
      const room = SEARCH_MAX_TOTAL - slot.matchCount - batch.length
      if (room <= 0) {
        slot.handle?.cancel()
        return
      }
      batch.push(...matches.slice(0, Math.max(room, 0)))
      if (batch.length >= MATCH_BATCH_SIZE) flushBatch()
      else if (!batchTimer) batchTimer = setTimeout(flushBatch, MATCH_BATCH_MS)
      if (slot.matchCount + batch.length >= SEARCH_MAX_TOTAL) slot.handle?.cancel()
    }

    let filesSearched = 0
    let truncated = slot.matchCount + batch.length >= SEARCH_MAX_TOTAL
    let engineUsed = engine
    try {
      switch (engine) {
        case 'agent':
          ({ filesSearched, truncated } = await this.runAgent(runId, slot, params, pushMatches, truncated))
          break
        case 'rg':
        case 'grep':
          ({ filesSearched, truncated, engine: engineUsed } = await this.runCommand(
            runId, slot, engine, params, pushMatches, truncated
          ))
          break
        case 'node':
          ({ filesSearched, truncated } = await this.runNode(runId, slot, params, pushMatches))
          break
      }
      flushBatch()
      if (slot.matchCount >= SEARCH_MAX_TOTAL) truncated = true
      this.onEvent({
        runId,
        type: 'done',
        engine: engineUsed,
        matchCount: slot.matchCount,
        filesSearched,
        elapsedMs: Date.now() - slot.started,
        truncated,
        canceled: slot.canceled
      })
    } catch (err) {
      flushBatch()
      const message = err instanceof Error ? err.message : String(err)
      if (slot.canceled) {
        this.onEvent({
          runId, type: 'done', engine: engineUsed, matchCount: slot.matchCount,
          filesSearched, elapsedMs: Date.now() - slot.started, truncated, canceled: true
        })
        return
      }
      // 已出过结果的失败降级为「部分结果 + 截断」，零结果才报错（部分结果永远比一句失败有用）
      if (slot.matchCount > 0) {
        this.onEvent({
          runId, type: 'done', engine: engineUsed, matchCount: slot.matchCount,
          filesSearched, elapsedMs: Date.now() - slot.started, truncated: true, canceled: false
        })
        return
      }
      this.onEvent({ runId, type: 'error', message, engine: engineUsed })
    } finally {
      if (batchTimer) clearTimeout(batchTimer)
      this.running.delete(runId)
    }
  }

  // ---- agent 引擎（一问一答 → 按批重放；不可取消，迟到响应按 runId 丢弃）----

  private async runAgent(
    runId: string,
    slot: RunningSearch,
    params: SearchStartParams,
    pushMatches: (m: SearchMatch[]) => void,
    truncated: boolean
  ): Promise<{ filesSearched: number; truncated: boolean }> {
    const res = (await this.agent.call(params.fsSessionId, params.containerName, 'fs_search', {
      dir: params.root,
      pattern: params.pattern,
      is_regex: params.isRegex,
      ignore_case: params.ignoreCase,
      max_results: SEARCH_MAX_TOTAL,
      max_elapsed_ms: 8000
    })) as AgentSearchResponse
    if (slot.canceled) return { filesSearched: 0, truncated }
    const matches = res.matches ?? []
    // 按 200 条/批、每批一个 macrotask 的节奏重放，UI 与流式引擎无差异
    for (let i = 0; i < matches.length; i += MATCH_BATCH_SIZE) {
      pushMatches(matches.slice(i, i + MATCH_BATCH_SIZE))
      await new Promise((r) => setTimeout(r, 0))
      if (slot.canceled) break
    }
    return { filesSearched: res.files_searched ?? 0, truncated: truncated || (res.truncated ?? false) }
  }

  // ---- rg / grep 引擎（SSH execStream / 本机 runLocalStream；流式 + 真取消）----

  private async runCommand(
    runId: string,
    slot: RunningSearch,
    engine: 'rg' | 'grep',
    params: SearchStartParams,
    pushMatches: (m: SearchMatch[]) => void,
    truncated: boolean
  ): Promise<{ filesSearched: number; truncated: boolean; engine: SearchEngine }> {
    // 自愈降级梯子（有界，最多两重）：
    //  ① 缓存/探测说 rg 在，跑起来 127（用户中途卸了）→ 降 grep 重试并更新缓存
    //  ② grep 的 --null/--exclude-dir 不被 BusyBox 认（退出 2）→ 去 --null 重试
    try {
      return await this.runCommandOnce(runId, slot, engine, params, pushMatches, truncated, { nul: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (slot.canceled || slot.matchCount > 0) throw err
      if (engine === 'rg' && /127|not found|找不到/.test(msg)) {
        this.engineCache.set(`${params.fsSessionId}|${params.containerName ?? ''}`, 'grep')
        return this.runCommand(runId, slot, 'grep', params, pushMatches, truncated)
      }
      if (engine === 'grep' && msg === GREP_FLAGS_UNSUPPORTED) {
        return this.runCommandOnce(runId, slot, 'grep', params, pushMatches, truncated, { nul: false })
      }
      throw err
    }
  }

  private async runCommandOnce(
    runId: string,
    slot: RunningSearch,
    engine: 'rg' | 'grep',
    params: SearchStartParams,
    pushMatches: (m: SearchMatch[]) => void,
    truncated: boolean,
    opts: { nul: boolean }
  ): Promise<{ filesSearched: number; truncated: boolean; engine: SearchEngine }> {
    const filesSeen = new Set<string>()
    const acc = createLineAccumulator((line) => {
      const m =
        engine === 'rg'
          ? parseRgJsonLine(line)
          : parseGrepLine(line, { nul: opts.nul })
      if (!m) return
      filesSeen.add(m.path)
      pushMatches([m])
    })
    // stderr 单独攒着（execStream/runLocalStream 已分流），只在结局分类时用
    let stderrTail = ''
    const onStderr = (text: string): void => {
      if (stderrTail.length < 64 * 1024) stderrTail += text
    }

    let handle: { done: Promise<{ code: number; canceled: boolean }>; cancel: () => void }
    if (isLocalId(params.fsSessionId)) {
      if (engine === 'rg') {
        handle = runLocalStream(await resolveExecutable('rg'), buildRgArgs(params), {
          timeoutMs: SEARCH_TIMEOUT_MS,
          onData: (text) => acc.feed(text),
          onStderr
        })
      } else {
        handle = runLocalStream(await resolveExecutable('grep'), buildGrepArgs(params, opts), {
          timeoutMs: SEARCH_TIMEOUT_MS,
          onData: (text) => acc.feed(text),
          onStderr
        })
      }
    } else {
      const client = this.getClient(params.fsSessionId)
      if (!client) throw new Error('连接已断开')
      const command =
        engine === 'rg'
          ? buildRgCommand(await resolveRemoteRg(this.rgPathCache, params.fsSessionId, client), params)
          : buildGrepCommand(params, opts)
      handle = execStream(client, command, {
        timeoutMs: SEARCH_TIMEOUT_MS,
        onData: (text) => acc.feed(text),
        onStderr
      })
    }
    slot.handle = handle
    if (slot.canceled) handle.cancel()
    const { code, canceled } = await handle.done
    acc.end()
    if (canceled || slot.canceled) {
      return { filesSearched: filesSeen.size, truncated: true, engine }
    }
    // rg/grep 退出码：0=有命中，1=无命中（不是错误），2=出错；127=命令不存在（抛给降级梯子）
    if (code === 127) throw new Error(`${engine} 不存在（退出码 127）`)
    if (code > 1) {
      // grep 退出 2 且零命中：可能是 BusyBox 不认 --null/--exclude-dir，抛标记错误走梯子
      if (engine === 'grep' && opts.nul && slot.matchCount === 0) throw new Error(GREP_FLAGS_UNSUPPORTED)
      if (slot.matchCount > 0) return { filesSearched: filesSeen.size, truncated: true, engine }
      throw new Error(stderrTail.trim().split('\n')[0] || `${engine} 出错（退出码 ${code}）`)
    }
    return { filesSearched: filesSeen.size, truncated, engine }
  }

  // ---- node 兜底引擎（Windows 本机；顺序遍历 + 协作取消）----

  private async runNode(
    runId: string,
    slot: RunningSearch,
    params: SearchStartParams,
    pushMatches: (m: SearchMatch[]) => void
  ): Promise<{ filesSearched: number; truncated: boolean }> {
    const matcher = createNodeMatcher(params)
    if (matcher.error) throw new Error(matcher.error)
    const res = await searchLocalNode(params.root, matcher.match, SEARCH_MAX_TOTAL, {
      onBatch: pushMatches,
      shouldAbort: () => slot.canceled
    })
    return { filesSearched: res.filesSearched, truncated: res.truncated }
  }
}

/** 远端 rg 路径（按会话缓存：detectEngine 已探过一次存在性，不必每次搜索再跑 command -v） */
async function resolveRemoteRg(
  cached: Map<string, string>,
  sessionId: string,
  client: Client
): Promise<string> {
  const hit = cached.get(sessionId)
  if (hit) return hit
  try {
    const res = await execCapture(client, 'command -v rg', { timeoutMs: 5000 })
    const p = res.stdout.trim().split('\n')[0]
    if (p) {
      cached.set(sessionId, p)
      return p
    }
  } catch {
    // 探测失败不挡路：按名字跑，127 走降级梯子
  }
  return 'rg'
}
