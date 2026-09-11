/**
 * /proc/net/tcp 监听端口发现（纯函数，可 Node 直接单测）。
 *
 * 这是 VS Code Remote 的默认检测源（"process"）的无 agent 版本：
 * /proc/net/tcp 是内核 socket 表，任何进程都能读 —— 程序打不打印横幅
 * 都无所谓，静默起的服务一样在表里。我们付出的只是每几秒一条只读命令，
 * VS Code 付出的则是在远端常驻一个 server。
 */

/** 读两张表（tcp + tcp6）。/bin/sh -c 包裹：登录 shell 可能是 fish/csh；脚本内无单引号 */
export function procListenCommand(): string {
  return `/bin/sh -c 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null'`
}

/**
 * 解析 /proc/net/tcp{,6}，返回处于 LISTEN（st = 0A）的本地端口列表。
 *
 * 行形如：
 *   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 ...
 * local_address 是 十六进制IP:十六进制端口。两表内容可能重叠（双栈监听），
 * 输出去重升序。畸形行跳过 —— 内核格式稳定，但半行截断不值得让整个功能报错。
 */
export function parseProcNetTcp(stdout: string): number[] {
  const ports = new Set<number>()
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/)
    // 数据行至少 4 列，且第 1 列是 "N:" 序号（表头那行第 1 列是 "sl"）
    if (fields.length < 4 || !/^\d+:$/.test(fields[0])) continue
    if (fields[3] !== '0A') continue // 0A = LISTEN，其余状态（ESTABLISHED 等）跳过
    const hexPort = fields[1].split(':')[1]
    if (!hexPort) continue
    const port = parseInt(hexPort, 16)
    if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port)
  }
  return [...ports].sort((a, b) => a - b)
}
