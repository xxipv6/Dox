/**
 * 会话 id 的命名空间。
 *
 * 三类会话共用同一套数据/输入通道（`ssh:data` / `ssh:status` / `ssh:input` /
 * `ssh:resize` / `ssh:disconnect`），主进程与渲染进程都靠 id 前缀决定往哪儿路由。
 * 前缀集中放在这里定义，是为了不让「'local-'」这种字面量在主进程、preload、
 * 渲染层各抄一份 —— 抄漏一处就是一类会话的输入静默打到别的地方去。
 *
 *   （无前缀）     SSH 会话：宿主机上的交互式 shell，主进程 SessionManager 管
 *   local-        本地终端：node-pty，LocalPtyManager 管
 *   container-    容器终端：容器里的一个 shell，ContainerManager 管。
 *                 承载方式有两种 —— 远端是**父 SSH 连接**上的一条 docker exec
 *                 通道，本机是一个 node-pty 进程。两者都不是独立的 SSH 连接。
 */

/** 本地终端会话 id 前缀 */
export const LOCAL_ID_PREFIX = 'local-'

/**
 * 容器会话 id 前缀。
 *
 * 容器终端跑在父 SSH 会话的连接上，所以它**不归属于 SessionManager**：
 * 对它调 SessionManager 的 disconnect 会 client.end() 掐断整条 SSH 连接，
 * 对它调 sftp() 会返回宿主机的文件系统。前缀让这两条路从入口就分得开。
 */
export const CONTAINER_ID_PREFIX = 'container-'

export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX)
}

export function isContainerId(id: string): boolean {
  return id.startsWith(CONTAINER_ID_PREFIX)
}

/**
 * 普通 SSH 会话（既不是本地终端也不是容器）。
 *
 * 渲染层用它做正向判断，而不是写 `!id.startsWith('local-')` —— 后者在
 * 多出第三类会话时会静默改变含义：容器会话不是 SFTP 会话，却被算进了「是 SSH」。
 */
export function isPlainSshId(id: string): boolean {
  return !isLocalId(id) && !isContainerId(id)
}

/**
 * 「伪父会话」——容器面板和设备列表问「你要列哪台机器上的容器」时，
 * 本机就是这样一个目标。
 *
 * 它不是会话 id，只是 `parentSessionId` 这个位置上的第三个合法取值（另外两个
 * 是真实的 SSH 会话 id 和「没有」）。之所以用哨兵而不是 null：渲染层那边
 * `null` 已经被「没有可列的目标」占用了，混用会让「本机」和「没标签」变成
 * 同一件事 —— 那正是这个功能要区分的两种情况。
 *
 * 注意别用 `'local'` 去撞 `local-` 前缀的既有含义：`'local'.startsWith('local-')`
 * 是 false，两者不会互相误判，但读代码的人容易搞混，所以单独给它一个名字。
 */
export const LOCAL_CONTAINER_TARGET = 'local'

export function isLocalContainerTarget(id: string): boolean {
  return id === LOCAL_CONTAINER_TARGET
}
