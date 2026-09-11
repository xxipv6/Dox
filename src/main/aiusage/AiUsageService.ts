import { BrowserWindow } from 'electron'
import type {
  AiAccount,
  AiProvider,
  AiUsageResult,
  AiUsageSnapshot
} from '../../shared/types'
import type { ConfigStore } from '../store/configStore'
import { IpcChannels } from '../../shared/ipc'

/**
 * AI 容量查询服务（Kimi Code / DeepSeek / GLM）。
 *
 * 主进程常驻：每 5 分钟轮询一轮所有账号，结果缓存 + 广播，渲染层只读快照。
 * 查询全部走 HTTPS 直连（三家都是国内服务，不走代理）；key 从 ConfigStore
 * 解密出来只用于这一次请求，不落日志。
 *
 * 解析逻辑与 kimi_usage.py 对齐：
 *  - Kimi Code：顶层 usage 是每周配额；limits[] 里 300 分钟窗是 5 小时滚动配额
 *  - DeepSeek：balance_infos[0] 的总/赠送/充值余额
 *  - GLM：limits[] 中 unit=3 是 5 小时窗、unit=6 是每周窗、TIME_LIMIT 是 MCP 月度次数
 */

const TIMEOUT_MS = 20_000
const POLL_MS = 5 * 60_000

/*
 * 测试钩子：用环境变量换掉查询地址，验证脚本起一个本地 mock 服务即可，
 * 不用拿真实 key 碰真实接口。
 */
const BASE_URLS: Record<AiProvider, string> = {
  kimi: process.env.DOX_AIUSAGE_URL_KIMI ?? 'https://api.kimi.com/coding/v1/usages',
  deepseek: process.env.DOX_AIUSAGE_URL_DEEPSEEK ?? 'https://api.deepseek.com/user/balance',
  glm: process.env.DOX_AIUSAGE_URL_GLM ?? 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
}

const PROVIDER_LABEL: Record<AiProvider, string> = {
  kimi: 'Kimi Code',
  deepseek: 'DeepSeek',
  glm: 'GLM'
}

function toNum(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const n = Number(String(value).trim())
  return Number.isFinite(n) ? n : null
}

/** 已用/剩余互补推导：接口给哪两个算哪个，给三个以它为准 */
function quotaFields(quota: Record<string, unknown>): { used: number | null; remaining: number | null } {
  let used = toNum(quota.used)
  const limit = toNum(quota.limit)
  let remaining = toNum(quota.remaining)
  if (remaining === null && used !== null && limit !== null) remaining = limit - used
  if (used === null && limit !== null && remaining !== null) used = limit - remaining
  return { used, remaining }
}

/** GLM 的 nextResetTime 是毫秒时间戳，转成 ISO8601 */
function isoFromMs(value: unknown): string | null {
  const ms = toNum(value)
  if (ms === null) return null
  try {
    return new Date(ms).toISOString()
  } catch {
    return null
  }
}

async function httpGetJson(url: string, apiKey: string, bearer: boolean): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: bearer ? `Bearer ${apiKey}` : apiKey,
        Accept: 'application/json',
        'User-Agent': 'Dox/1.0'
      },
      signal: controller.signal
    })
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`Key 无效或已过期（HTTP ${resp.status}）`)
    }
    if (resp.status === 429) throw new Error('请求过于频繁（HTTP 429），请稍后再试')
    if (!resp.ok) throw new Error(`接口返回 HTTP ${resp.status}`)
    return await resp.json()
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('网络请求超时')
    if (err instanceof Error && /HTTP|Key/.test(err.message)) throw err
    throw new Error('网络请求失败，请检查网络连接')
  } finally {
    clearTimeout(timer)
  }
}

function windowMinutes(win: Record<string, unknown> | undefined): number | null {
  const duration = toNum(win?.duration) ?? 0
  switch (win?.timeUnit) {
    case 'TIME_UNIT_MINUTE':
      return duration
    case 'TIME_UNIT_HOUR':
      return duration * 60
    case 'TIME_UNIT_DAY':
      return duration * 1440
    default:
      return null
  }
}

function parseKimi(account: AiAccount, data: Record<string, unknown>): AiUsageResult {
  const out: AiUsageResult = { id: account.id, name: account.name, provider: 'kimi', ok: true }
  const user = data.user as Record<string, unknown> | undefined
  const membership = (user?.membership as Record<string, unknown> | undefined)?.level
  if (membership) out.membership = String(membership)

  const usage = (data.usage ?? {}) as Record<string, unknown>
  const { used, remaining } = quotaFields(usage)
  if (used !== null) out.weeklyUsed = used
  if (remaining !== null) out.weeklyRemaining = remaining
  if (usage.resetTime) out.weeklyReset = String(usage.resetTime)

  const limits = Array.isArray(data.limits) ? (data.limits as Record<string, unknown>[]) : []
  const fiveHour = limits.find(
    (item) => windowMinutes(item.window as Record<string, unknown> | undefined) === 300
  )
  if (fiveHour) {
    const detail = (fiveHour.detail ?? {}) as Record<string, unknown>
    let { used: fUsed, remaining: fRemaining } = quotaFields(detail)
    // 全新未使用的窗口 detail 为空：视为 0% 已用
    if (fUsed === null && fRemaining === null && Object.keys(detail).length === 0) {
      fUsed = 0
      fRemaining = 100
    }
    if (fUsed !== null) out.fiveHourUsed = fUsed
    if (fRemaining !== null) out.fiveHourRemaining = fRemaining
    if (detail.resetTime) out.fiveHourReset = String(detail.resetTime)
  } else {
    out.fiveHourUsed = 0
    out.fiveHourRemaining = 100
  }
  return out
}

function parseDeepseek(account: AiAccount, data: Record<string, unknown>): AiUsageResult {
  const out: AiUsageResult = { id: account.id, name: account.name, provider: 'deepseek', ok: true }
  out.isAvailable = Boolean(data.is_available)
  const infos = Array.isArray(data.balance_infos) ? (data.balance_infos as Record<string, unknown>[]) : []
  const info = infos[0]
  if (info) {
    if (info.currency) out.currency = String(info.currency)
    const total = toNum(info.total_balance)
    const granted = toNum(info.granted_balance)
    const topped = toNum(info.topped_up_balance)
    if (total !== null) out.totalBalance = total
    if (granted !== null) out.grantedBalance = granted
    if (topped !== null) out.toppedUpBalance = topped
  }
  return out
}

function parseGlm(account: AiAccount, data: Record<string, unknown>): AiUsageResult {
  if (data.success === false || (data.code !== undefined && data.code !== 200)) {
    throw new Error(`接口返回：${(data.msg as string) || '未知错误'}`)
  }
  const payload = data.data as Record<string, unknown> | undefined
  if (!payload || typeof payload !== 'object') throw new Error('接口返回格式异常')

  const out: AiUsageResult = { id: account.id, name: account.name, provider: 'glm', ok: true }
  if (payload.level) out.membership = String(payload.level).toUpperCase()

  const limits = Array.isArray(payload.limits) ? (payload.limits as Record<string, unknown>[]) : []
  const tokenLimits = limits.filter((item) => item.type === 'TOKENS_LIMIT')
  let fiveHour = tokenLimits.find((item) => item.unit === 3)
  let weekly = tokenLimits.find((item) => item.unit === 6)
  // 兼容没有 unit 字段的旧返回：按重置时间排序，前者 5 小时窗，后者每周窗
  if (!fiveHour && tokenLimits.length) {
    const ordered = [...tokenLimits].sort(
      (a, b) => (toNum(a.nextResetTime) ?? 0) - (toNum(b.nextResetTime) ?? 0)
    )
    fiveHour = ordered[0]
    if (!weekly && ordered.length > 1) weekly = ordered[1]
  }
  if (fiveHour) {
    const pct = toNum(fiveHour.percentage)
    if (pct !== null) {
      out.fiveHourUsed = pct
      out.fiveHourRemaining = Math.max(0, 100 - pct)
    }
    const reset = isoFromMs(fiveHour.nextResetTime)
    if (reset) out.fiveHourReset = reset
  }
  if (weekly) {
    const pct = toNum(weekly.percentage)
    if (pct !== null) {
      out.weeklyUsed = pct
      out.weeklyRemaining = Math.max(0, 100 - pct)
    }
    const reset = isoFromMs(weekly.nextResetTime)
    if (reset) out.weeklyReset = reset
  }
  const mcp = limits.find((item) => item.type === 'TIME_LIMIT')
  if (mcp) {
    const used = toNum(mcp.currentValue)
    const limit = toNum(mcp.usage)
    let remaining = toNum(mcp.remaining)
    if (remaining === null && used !== null && limit !== null) remaining = limit - used
    if (used !== null) out.mcpUsed = used
    if (limit !== null) out.mcpLimit = limit
    if (remaining !== null) out.mcpRemaining = remaining
  }
  return out
}

export class AiUsageService {
  private snapshot: AiUsageSnapshot | null = null
  private timer: NodeJS.Timeout | null = null
  private querying = false

  constructor(private configStore: ConfigStore) {}

  /** 启动定时轮询（应用启动时调一次）；首轮立即跑 */
  start(): void {
    if (this.timer) return
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), POLL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 最近一次快照（还没查过返回 null，界面据此显示「未配置/加载中」） */
  get(): AiUsageSnapshot | null {
    return this.snapshot
  }

  /**
   * 立即查一轮（手动刷新 / 账号变更后）。正在查时合并到同一轮，
   * 避免连点刷出并发请求被平台 429。
   */
  async refresh(): Promise<AiUsageSnapshot> {
    if (this.querying) return this.snapshot ?? { fetchedAt: new Date().toISOString(), accounts: [] }
    this.querying = true
    try {
      const accounts = this.configStore.listAiAccounts()
      const results = await Promise.all(accounts.map((a) => this.queryOne(a)))
      this.snapshot = { fetchedAt: new Date().toISOString(), accounts: results }
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IpcChannels.aiUsageUpdate, this.snapshot)
      }
      return this.snapshot
    } finally {
      this.querying = false
    }
  }

  private async queryOne(account: AiAccount): Promise<AiUsageResult> {
    const fail = (error: string): AiUsageResult => ({
      id: account.id,
      name: account.name,
      provider: account.provider,
      ok: false,
      error
    })
    let key: string
    try {
      key = this.configStore.resolveAiKey(account.id)
    } catch (err) {
      return fail(err instanceof Error ? err.message : '缺少 API Key')
    }
    try {
      // GLM 的 Authorization 直接携带 Key，不加 Bearer
      const data = (await httpGetJson(
        BASE_URLS[account.provider],
        key,
        account.provider !== 'glm'
      )) as Record<string, unknown>
      if (!data || typeof data !== 'object') throw new Error('接口返回格式异常')
      if (account.provider === 'deepseek') {
        if (!('balance_infos' in data)) throw new Error('接口返回格式异常')
        return parseDeepseek(account, data)
      }
      if (account.provider === 'glm') return parseGlm(account, data)
      return parseKimi(account, data)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }
}

export { PROVIDER_LABEL }
