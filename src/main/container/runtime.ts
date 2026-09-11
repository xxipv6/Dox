import type { ContainerControlAction, ContainerInfo, ContainerProbeReason } from '../../shared/types'

/**
 * 容器 runtime 的命令构造、输出解析与错误分类。
 *
 * 全是纯函数，不碰会话生命周期 —— 这样这一层可以单独读、单独验，
 * 也逼着「怎么问」和「怎么理解回答」这两件事各自写清楚。
 */

/**
 * 合法的 docker/podman 目标（容器名或 id）。
 *
 * 容器名的字符集是 Docker 强制的 `[a-zA-Z0-9][a-zA-Z0-9_.-]*`，所以这条正则
 * 同时覆盖了名字和十六进制 id。**插入命令前必须过这一关** —— 容器名来自
 * 渲染进程，而 IPC 参数并不因为 contextIsolation 就自动可信。
 */
export const CONTAINER_TARGET_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

export function assertContainerTarget(name: string): string {
  if (!CONTAINER_TARGET_RE.test(name)) {
    throw new Error(`容器名不合法：${JSON.stringify(name)}`)
  }
  return name
}

/** 探测脚本用这一行把 runtime 的绝对路径回传出来，与后面的列表区分开 */
const MARKER = '@@DOX@@'

/**
 * `docker ps --format` 里的字段分隔符。
 *
 * 用**真正的制表符**而不是 `\t` 两个字符：`\t` 要不要反转义取决于 docker 的
 * 版本与模板实现，而一个字面制表符在任何版本里都会被原样输出。容器名与镜像名
 * 的字符集里没有制表符（Docker 强制），所以拿它当分隔符是安全的。
 */
const SEP = '\t'

const FORMAT_FULL = `{{.ID}}${SEP}{{.Names}}${SEP}{{.Image}}${SEP}{{.Status}}`
/** 老 docker 不认模板里的某些字段时的降级格式；没有状态列 */
const FORMAT_LEGACY = `{{.ID}}${SEP}{{.Names}}${SEP}{{.Image}}`

/**
 * 探测 runtime **并**列出全部容器（含已停止），一次往返。
 *
 * 四个细节都对应一个真会踩到的坑：
 *
 * 1. `/bin/sh -c '…'` 包一层：sshd 是把命令串交给用户的**登录 shell** 执行的，
 *    而登录 shell 可能是 fish 或 csh —— `$()`、`command -v`、环境变量前缀的
 *    写法各不相同。钉死 POSIX 语义。**因此脚本里不出现单引号。**
 * 2. 补 PATH：非交互式 sshd exec 拿到的是最小 PATH，`/usr/local/bin`、`/snap/bin`
 *    经常不在里面。不补就会「我自己 shell 里能列，应用里列不出来」。
 * 3. 回传绝对路径：`command -v` 是在补过的 PATH 下解析的，而后面交互式的
 *    `docker exec` 通道没有这份补充 —— 所以必须把绝对路径带下去。
 * 4. `-a` 一次拿全：既得到运行中列表，也顺手数出「另有 N 个已停止」。
 *    比再来一次 `-f status=exited` 省一趟，也避开了 docker 与 podman 在
 *    多值过滤上的语义差异。
 */
export function listCommand(legacy = false): string {
  const format = legacy ? FORMAT_LEGACY : FORMAT_FULL
  return (
    `/bin/sh -c 'PATH="$PATH:/usr/local/sbin:/usr/local/bin:/snap/bin"; ` +
    `d=$(command -v docker 2>/dev/null) || d=$(command -v podman 2>/dev/null) || true; ` +
    `if [ -z "$d" ]; then echo "${MARKER} none"; exit 0; fi; ` +
    `echo "${MARKER} $d"; ` +
    `exec "$d" ps -a --format "${format}"'`
  )
}

/**
 * 本机版的列容器参数。
 *
 * 与远端那份的区别只有一点，但很关键：**不经过 shell**。
 *
 * 远端那套 `/bin/sh -c '…'` 包裹 + `command -v` + 补 PATH 全是围着 sshd 转的
 * （非交互 exec 拿最小 PATH，且命令串交给用户的登录 shell，可能是 fish/csh）。
 * 本机用 `execFile` 直接给 argv，这些问题一个都不存在，顺带也没有了把容器名
 * 拼进 shell 串的注入面。
 */
export function localListArgs(legacy = false): string[] {
  return ['ps', '-a', '--format', legacy ? FORMAT_LEGACY : FORMAT_FULL]
}

/** 本机版的 shell 预检参数 */
export function localShellProbeArgs(name: string, shell: string): string[] {
  return ['exec', assertContainerTarget(name), shell, '-c', 'exit 0']
}

/**
 * 本机版的进入容器参数。
 *
 * `-i` 让 stdin 保持打开（pty 的输入从那儿进去），`-t` 让 docker 给容器分配 tty。
 * 外面那层我们自己的 pty 是另一层 —— 两层都要，缺了 `-t` 行编辑会失效。
 */
export function localInteractiveArgs(name: string, shell: string): string[] {
  return ['exec', '-it', assertContainerTarget(name), shell]
}

/** 探测某个容器里有没有指定的 shell —— 顺带充当「能不能进得去」的预检 */
export function shellProbeCommand(binary: string, name: string, shell: string): string {
  return `${binary} exec ${assertContainerTarget(name)} ${shell} -c "exit 0"`
}

/**
 * 真正进去的那条命令。
 *
 * `-i` 让 stdin 保持打开（我们的 pty 输入从那儿进去），`-t` 给容器分配 tty。
 * **两层 tty 都要**：SSH 那边的 pty 是另一层。
 * 不需要 `-e TERM=…`：sshd 从 pty-req 里设好 TERM，docker CLI 继承并传进容器。
 */
export function interactiveExecCommand(binary: string, name: string, shell: string): string {
  return `${binary} exec -it ${assertContainerTarget(name)} ${shell}`
}

/**
 * 查看日志的那条命令（远端，拼进 shell 串）。
 *
 * 与 interactiveExec 的关键差别：**不需要容器里有 shell** —— logs 是守护进程
 * 读的日志驱动，distroless 容器照样能看。所以不做 shell 预检。
 * `--tail 200` 防止把几周的全量日志一次性灌进终端；`-f` 跟随。
 * 已停止的容器也能看（docker logs 对 stopped 合法），这对「它为什么挂了」
 * 恰恰是最高频的场景。
 */
export function logsCommand(binary: string, name: string): string {
  return `${binary} logs -f --tail 200 ${assertContainerTarget(name)}`
}

/** 本机版日志参数（不经 shell，argv 直给，与 localInteractiveArgs 同一个理由） */
export function localLogsArgs(name: string): string[] {
  return ['logs', '-f', '--tail', '200', assertContainerTarget(name)]
}

/*
 * 容器生命周期操作的白名单：只允许这四个动作，且只能经这张表换成动词。
 * 「不建容器（run/create/pull）、不拷文件（cp）、不构建（build）」仍是红线 ——
 * 守卫词表在 verify-container.mjs，调整它前先想清楚。
 */
const CONTROL_VERBS = { start: 'start', stop: 'stop', unpause: 'unpause', remove: 'rm' } as const

/** 远端生命周期命令（binary 是探测回传的绝对路径，name 过字符集校验） */
export function controlCommand(binary: string, name: string, action: ContainerControlAction): string {
  return `${binary} ${CONTROL_VERBS[action]} ${assertContainerTarget(name)}`
}

/** 本机生命周期参数（argv 直给，不经 shell） */
export function localControlArgs(name: string, action: ContainerControlAction): string[] {
  return [CONTROL_VERBS[action], assertContainerTarget(name)]
}

/** 依次尝试的候选 shell；容器里多半只有 sh，distroless 类一个都没有 */
export const SHELL_CANDIDATES = ['bash', 'sh'] as const

/**
 * 从 `docker inspect` 的 JSON 输出抠容器的网桥 IP（端口转发建议用）。
 *
 * 容器没发布端口时，远端 127.0.0.1 摸不到它，但宿主机能直连网桥 IP ——
 * SSH 转发的目标指过来就通了。host 网络 / 无 IP / 输出畸形都返回 null，
 * 调用方回退 127.0.0.1。
 */
export function parseInspectIp(stdout: string): string | null {
  try {
    const data = JSON.parse(stdout) as Array<{
      NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> }
    }>
    const networks = data?.[0]?.NetworkSettings?.Networks
    if (!networks) return null
    for (const net of Object.values(networks)) {
      if (net.IPAddress && /^\d{1,3}(\.\d{1,3}){3}$/.test(net.IPAddress)) {
        return net.IPAddress
      }
    }
    return null
  } catch {
    return null
  }
}

export interface ParsedListing {
  /** runtime 可执行文件绝对路径；null = 远端没有 docker 也没有 podman */
  binary: string | null
  containers: ContainerInfo[]
  stoppedCount: number
}

/**
 * 解析 listCommand 的输出。
 *
 * 一行坏数据不该让整块面板空掉，所以畸形行跳过并计数，不抛错。
 * 抛出的是「连 marker 都没有」这种情况 —— 那说明命令根本没按预期跑。
 */
export function parseListing(stdout: string, legacy = false): ParsedListing {
  const lines = splitLines(stdout)

  const marker = lines.shift() ?? ''
  if (!marker.startsWith(MARKER)) {
    throw new Error(`远端输出不符合预期（缺少标记行）：${marker.slice(0, 120)}`)
  }
  const binary = marker.slice(MARKER.length).trim()
  if (!binary || binary === 'none') {
    return { binary: null, containers: [], stoppedCount: 0 }
  }

  return { binary, ...parseRows(lines, legacy) }
}

/**
 * 只解析数据行，不认标记行。
 *
 * 本机那条路用这个：二进制是 `execFile` 自己选出来的，已经知道了，不需要
 * 让远端把它回传回来。「怎么问」两条路不同，「怎么理解回答」完全一样 ——
 * 所以解析、状态推导、健康推导这些一律共用。
 */
export function parseRows(
  input: string[] | string,
  legacy = false
): { containers: ContainerInfo[]; stoppedCount: number } {
  const lines = Array.isArray(input) ? input : splitLines(input)

  const all: ContainerInfo[] = []
  for (const line of lines) {
    const info = parseRow(line, legacy)
    if (info) all.push(info)
  }

  /*
   * 全部状态都进列表（running / paused / exited），排序：在跑 > 暂停 > 已停。
   * 已停止的不再是「另有 N 个未列出」的数字 —— 启动和删除按钮就在它们身上。
   * stoppedCount 保留给「一个都没有」时的文案。
   */
  const rank = (c: ContainerInfo): number =>
    c.state === 'running' ? 0 : c.state === 'paused' ? 1 : 2
  const containers = all.sort((a, b) => rank(a) - rank(b))
  return { containers, stoppedCount: all.length - all.filter((c) => rank(c) < 2).length }
}

function splitLines(stdout: string): string[] {
  return stdout
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim().length > 0)
}

function parseRow(line: string, legacy: boolean): ContainerInfo | null {
  let fields = line.split(SEP)
  // 兜底：某些 runtime 不把 --format 里的转义还原。这里只处理「整行只有字面 \t」的情形
  if (fields.length < (legacy ? 3 : 4) && line.includes('\\t')) {
    fields = line.split('\\t')
  }
  if (fields.length < (legacy ? 3 : 4)) return null

  const [id, names, image, status = ''] = fields.map((f) => f.trim())
  if (!id || !names) return null

  return {
    id,
    // 一个容器可以有多个名字（comma 分隔），第一个就是 `docker exec` 认的那个
    name: names.split(',')[0].trim(),
    image,
    status,
    state: legacy ? 'other' : deriveState(status),
    health: legacy ? undefined : deriveHealth(status)
  }
}

/**
 * 从 `.Status` 的文案推导状态。
 *
 * 刻意**不用** `{{.State}}`：那个字段在老版本 docker 的 `--format` 模板里不存在，
 * 会直接模板解析错误，整个列表都拿不到。`.Status` 从很早就一直有，podman 也一致。
 */
export function deriveState(status: string): ContainerInfo['state'] {
  if (/\bUp\b/.test(status)) return /\(Paused\)/i.test(status) ? 'paused' : 'running'
  if (/^Restarting\b/i.test(status)) return 'other'
  return 'exited'
}

export function deriveHealth(status: string): ContainerInfo['health'] {
  if (/\(unhealthy\)/i.test(status)) return 'unhealthy'
  if (/\(healthy\)/i.test(status)) return 'healthy'
  if (/\(health: starting\)/i.test(status)) return 'starting'
  return undefined
}

export interface ClassifiedFailure {
  reason: ContainerProbeReason
  message: string
}

/**
 * 把 docker/podman 的报错翻译成一句人话。
 *
 * 顺序有讲究：先判 socket 权限，再判守护进程 —— 因为「连不上守护进程」的
 * 典型文案里同时出现 docker.sock 和 permission denied，只有先看前者才不会
 * 把「没权限」误报成「没在跑」。
 */
export function classifyFailure(raw: string): ClassifiedFailure {
  const text = (raw || '').toLowerCase()
  const has = (...pats: string[]): boolean => pats.some((p) => text.includes(p))

  if (has('permission denied') && has('docker.sock', 'podman.sock', 'docker daemon socket', 'socket')) {
    return {
      reason: 'no-permission',
      message: '当前用户无权访问 Docker（需要加入 docker 组，或用 root 连接）'
    }
  }
  if (
    has(
      'cannot connect to the docker daemon',
      'is the docker daemon running',
      'error during connect',
      'cannot connect to podman'
    )
  ) {
    return { reason: 'daemon-down', message: 'Docker 守护进程未运行（或 socket 不可达）' }
  }
  if (has('is not running', 'no such container', 'container state improper', 'no such object')) {
    return { reason: 'container-gone', message: '容器已不在运行，请刷新列表' }
  }
  if (has('executable file not found', 'not found in $path')) {
    return {
      reason: 'no-shell',
      message: '容器内没有可用的 shell（可能是 distroless / scratch 镜像）'
    }
  }
  if (has('permission denied', 'oci runtime exec failed', 'operation not permitted')) {
    return {
      reason: 'exec-denied',
      message: '进入容器被拒绝（seccomp / AppArmor / 容器用户权限限制）'
    }
  }
  return { reason: 'error', message: firstLine(raw) || '容器探测失败' }
}

/**
 * `--format` 不被支持（docker 太老或模板字段不存在）时，是否值得降级重试一次。
 * 降级只丢状态列，面板挂一条提示即可 —— 比整个功能报错好得多。
 */
export function shouldDowngradeFormat(err: unknown): boolean {
  const text = (extractText(err) || '').toLowerCase()
  return /template|format|unrecognized|unknown|invalid/.test(text)
}

function extractText(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    return [e.stderr, e.stdout, e.message].filter(Boolean).join('\n')
  }
  return String(err ?? '')
}

function firstLine(text: string, max = 200): string {
  const line = (text || '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  if (!line) return ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}
