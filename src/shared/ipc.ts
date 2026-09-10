/** 所有 IPC 通道名集中定义，主进程 / preload / 渲染进程共用 */
export const IpcChannels = {
  // SSH 会话
  sshConnect: 'ssh:connect',
  sshInput: 'ssh:input',
  sshResize: 'ssh:resize',
  sshDisconnect: 'ssh:disconnect',
  // 本地终端（id 带 local- 前缀，input/resize/disconnect 共用上方通道按前缀路由）
  localConnect: 'local:connect',
  localListShells: 'local:listShells',
  // 主进程 → 渲染进程事件
  sshData: 'ssh:data',
  sshStatus: 'ssh:status',
  // 主机指纹确认（双向问答）
  sshHostKeyVerify: 'ssh:hostKeyVerify',
  sshHostKeyAnswer: 'ssh:hostKeyAnswer',
  // 会话配置持久化
  configList: 'config:list',
  configSave: 'config:save',
  configDelete: 'config:delete',
  configGetAuth: 'config:getAuth',
  // SFTP 文件操作
  sftpList: 'sftp:list',
  sftpRealpath: 'sftp:realpath',
  sftpMkdir: 'sftp:mkdir',
  sftpRename: 'sftp:rename',
  sftpDelete: 'sftp:delete',
  // 传输队列
  transferPickUpload: 'transfer:pickUpload',
  transferEnqueueDropped: 'transfer:enqueueDropped',
  transferDownload: 'transfer:download',
  transferDownloadDir: 'transfer:downloadDir',
  transferList: 'transfer:list',
  transferCancel: 'transfer:cancel',
  transferClearFinished: 'transfer:clearFinished',
  // 主进程 → 渲染进程事件
  transferUpdate: 'transfer:update',
  // 端口转发
  forwardList: 'forward:list',
  forwardAdd: 'forward:add',
  forwardRemove: 'forward:remove',
  forwardUpdate: 'forward:update',
  // 快捷命令片段
  snippetList: 'snippet:list',
  snippetSave: 'snippet:save',
  snippetDelete: 'snippet:delete',
  // rz/sz（ZMODEM）
  dialogPickDirectory: 'dialog:pickDirectory',
  zmodemPickReadFiles: 'zmodem:pickReadFiles',
  zmodemWriteFile: 'zmodem:writeFile'
} as const
