/**
 * 目录跟随（终端里 cd → SFTP 面板跟着走）的纯逻辑验证。
 *
 * 覆盖的是**退化路径**：远端没装 shell integration 时，靠本地重建命令行解析 cd。
 * 装了 integration 的机器走 OSC 7，不经过这里。
 *
 * 用法：node scripts/verify-cwd-follow.mjs
 *
 * 为什么需要这个脚本：连续 cd 时「基准要同步推进、不能等 sftpStat 往返」这条
 * 约束是这次修复的核心（原来会只跟一级就冻死），而 store/组件的路径没有任何
 * 脚本覆盖（verify-archive.mjs 走 OSC 7，verify-cwd-history.mjs 测的是面板前进后退）。
 */
import {
  cdArgOf,
  createCwdTracker,
  normalizePosix,
  resolveCdTarget
} from '../src/renderer/src/utils/cwdFollow.ts'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

console.log('阶段 1：cd 参数提取')

check('普通 cd', cdArgOf('cd /var/log') === '/var/log')
check('前面有空格', cdArgOf('   cd /tmp') === '/tmp')
check('pushd 也算', cdArgOf('pushd /tmp') === '/tmp')
check('带引号', cdArgOf('cd "my dir"') === 'my dir')
check('单引号', cdArgOf("cd 'my dir'") === 'my dir')
check('跟了 && 只取第一段', cdArgOf('cd /a && ls') === '/a')
check('跟了分号只取第一段', cdArgOf('cd /a; ls') === '/a')
check('cd 后面没参数', cdArgOf('cd') === '')
check('不是 cd 命令', cdArgOf('ls -la') === null)
check('夹在别的命令里不算', cdArgOf('echo cd /tmp') === null)
check('空行', cdArgOf('') === null)

console.log('阶段 2：路径归一化与解析')

check('归一化 ..', normalizePosix('/a/b/../c') === '/a/c')
check('归一化 .', normalizePosix('/a/./b') === '/a/b')
check('重复斜杠', normalizePosix('/a//b') === '/a/b')
check('结尾斜杠', normalizePosix('/a/b/') === '/a/b')
check('根目录', normalizePosix('/') === '/')
check('root 上 .. 不越界', normalizePosix('/../a') === '/a')

check('绝对路径直接归一化', resolveCdTarget('/var//log', '/elsewhere', '/root') === '/var/log')
check('相对路径按基准拼', resolveCdTarget('log', '/var', '/root') === '/var/log')
check('相对路径里的 ..', resolveCdTarget('../etc', '/var/log', '/root') === '/var/etc')
check('cd 无参数 = 回家', resolveCdTarget('', '/var', '/root') === '/root')
check('cd ~ = 回家', resolveCdTarget('~', '/var', '/root') === '/root')
check('cd ~/x', resolveCdTarget('~/x', '/var', '/root') === '/root/x')
check('cd - 不跟随', resolveCdTarget('-', '/var', '/root') === null)
check('家目录未知时不猜', resolveCdTarget('~', '/var', null) === null)
check('~/x 在未知家目录时不猜', resolveCdTarget('~/x', '/var', null) === null)
// 这条是第二个病灶：原来基准会退化成 '/'，把 `cd tmp` 算成 /tmp 这种看着合理的错路径
check('基准未知时不跟随（原来会算成 /tmp）', resolveCdTarget('tmp', null, null) === null)
check('基准未知但给绝对路径仍可跟随', resolveCdTarget('/tmp', null, null) === '/tmp')

console.log('阶段 3：期望 cwd 链（连续 cd 的核心）')

{
  const t = createCwdTracker()
  // 初始：没有任何期望值，基准只能是已确认值
  check('初始基准 = 已确认值', t.base('s1', '/home/me') === '/home/me')
  check('都没有时返回 null', t.base('s1', undefined) === null)

  // 连着两条 cd：第一条的 stat 还没回来，第二条必须按第一条的目标算
  const a = resolveCdTarget('a', t.base('s1', '/home/me'), null)
  check('第一条依据已确认值', a === '/home/me/a')
  t.advance('s1', a)
  const b = resolveCdTarget('b', t.base('s1', '/home/me'), null)
  check('第二条按第一条推进后的基准（未等 stat）', b === '/home/me/a/b')
  t.advance('s1', b)
  const c = resolveCdTarget('..', t.base('s1', '/home/me'), null)
  check('第三条继续按链算', c === '/home/me/a')

  // stat 确认成功 → store 写确认值 → watch 同步（同一个值，等价空操作）
  t.sync('s1', b)
  check('确认值同步后链仍是确认值', t.base('s1', b) === b)

  // stat 说「不存在」→ 退回最后一个确认值
  t.rollback('s1', '/home/me')
  check('失败后基准退回已确认值', t.base('s1', '/home/me') === '/home/me')
  check('失败后不再记着那条错路径', resolveCdTarget('x', t.base('s1', '/home/me'), null) === '/home/me/x')

  // 别的权威来源（OSC 7 / 面板点目录）改了值 → 基准跟上
  t.advance('s1', '/somewhere/stale')
  t.sync('s1', '/var/log')
  check('外部权威覆盖链上的过期期望值', t.base('s1', '/home/me') === '/var/log')

  // 会话互不干扰
  t.advance('s2', '/other')
  check('按 sessionId 分键', t.base('s1', '/x') === '/var/log' && t.base('s2', '/x') === '/other')

  // 面板卸载 → 丢掉（会话还在时确认值仍然有效）
  t.forget('s2')
  check('forget 后回落到确认值', t.base('s2', '/x') === '/x')
  check('forget 只影响自己', t.base('s1', '/x') === '/var/log')

  // 确认值也被清掉时（会话关闭）不留脏数据
  t.rollback('s1', undefined)
  check('确认值消失时链清空', t.base('s1', undefined) === null)
}

console.log(failed ? '\n结论: 存在失败项' : '\n结论: 全部通过')
process.exit(failed ? 1 : 0)
