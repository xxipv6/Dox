/**
 * 「终端里 cd 之后 SFTP 面板跟到哪儿」的纯逻辑。
 *
 * 抽出来是因为这条路径原先有个只有 SSH 会话才会踩的坑：`resolveCdTarget` 解析
 * 相对路径时，基准取的是**已确认的** cwd（`store.cwdBySession`），而 SSH 上那个
 * 值要等 `sftpStat` 往返回来才写（这是为了保住「cd 到不存在的目录时面板不跳」
 * 的语义）。于是连着敲两条 cd：第二条仍以旧目录为基准去算（路径多半不存在）→
 * stat 失败不更新 → 第一条的结果又已被世代号作废 → 面板 cwd 冻死，之后每条
 * 相对 cd 都基于错基准继续错。表现出来就是「只跟一级，再往下就不跟了」。
 *
 * 解法是把两件事拆开：**解析基准**（下面的 CwdTracker，每次 cd 同步推进，不等
 * 网络）与**面板显示值**（仍然只在 stat 确认后才写 store）。这样基准永远跟着
 * 用户敲的命令走，而 UI 不会因为一条失败的 cd 乱跳。
 *
 * 注意基准**不能**直接写进 `store.cwdBySession`：那是 SFTP 面板的真实来源
 * （FileExplorer 对它 watch 后立刻导航），乐观值会让面板先跳一下；cd 失败时
 * 面板自己回滚而 store 留着错值 → 两者分叉。它还会污染布局快照、拖放上传目标
 * 和断线重连的 cd。
 */

/** 归一化 posix 路径：折叠 `.` / `..`、去掉重复与结尾斜杠 */
export function normalizePosix(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

/** 从命令行里取出 cd/pushd 的参数（不是 cd 命令则 null） */
export function cdArgOf(line: string): string | null {
  const m = /^\s*(?:cd|pushd)\s*(.*)$/.exec(line)
  if (!m) return null
  const arg = (m[1] ?? '').trim().split(/\s*(?:&&|\|\||[;|])\s*/)[0]?.trim() ?? ''
  return arg.replace(/^["']|["']$/g, '')
}

/**
 * 把 cd 参数解析成绝对路径（解析不出来返回 null = 不要跟随）。
 *
 * base 是解析相对路径的基准（期望 cwd 或已确认 cwd），**null 表示基准未知**：
 * 远端家目录还没拿回来时就是这种情况。原来这里会退化成 `'/'` 去拼，于是
 * `cd tmp` 被算成 `/tmp` 这种看着合理的错路径 —— 宁可不跟随，也不要跟错。
 */
export function resolveCdTarget(
  arg: string,
  base: string | null,
  home: string | null
): string | null {
  // `cd -`（回到上一个目录）我们看不到那个目录是什么
  if (arg === '-') return null
  if (!arg || arg === '~') return home
  if (arg.startsWith('/')) return normalizePosix(arg)
  if (arg.startsWith('~/')) return home ? normalizePosix(home + arg.slice(1)) : null
  if (!base) return null
  return normalizePosix(base + '/' + arg)
}

export interface CwdTracker {
  /** 解析用的基准：优先链上的期望值（同步推进的那条），没有才退回已确认值 */
  base(sessionId: string, confirmed: string | undefined): string | null
  /** 一条 cd 被解析出来时同步推进（不等 stat） */
  advance(sessionId: string, next: string): void
  /** stat 确认「这个目录不存在/没权限」时退回最后一个确认值 */
  rollback(sessionId: string, confirmed: string | undefined): void
  /** 外部权威（OSC 7、面板点目录、终端里点路径）改了 cwd 时跟随 */
  sync(sessionId: string, confirmed: string): void
  forget(sessionId: string): void
}

/** 每个终端一个实例（内部按 sessionId 分键） */
export function createCwdTracker(): CwdTracker {
  const expected = new Map<string, string>()
  return {
    base(sessionId, confirmed) {
      return expected.get(sessionId) ?? confirmed ?? null
    },
    advance(sessionId, next) {
      expected.set(sessionId, next)
    },
    rollback(sessionId, confirmed) {
      if (confirmed) expected.set(sessionId, confirmed)
      else expected.delete(sessionId)
    },
    sync(sessionId, confirmed) {
      expected.set(sessionId, confirmed)
    },
    forget(sessionId) {
      expected.delete(sessionId)
    }
  }
}
