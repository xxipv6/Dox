/** WSL POSIX ↔ UNC 与 home 纯逻辑回归。用法：node scripts/verify-wsl-paths.mjs */
import {
  LocalPathResolver,
  fromWslNativePath,
  fromWslUncPath,
  normalizeWslPosixPath,
  toWslNativePath,
  toWslUncPath,
  wslUncRoot
} from '../src/main/local/LocalPathResolver.ts'
import { queryWslHome } from '../src/main/local/wsl.ts'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}
const rejects = (fn) => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

check('Ubuntu 根映射', toWslUncPath('Ubuntu', '/') === '\\\\wsl.localhost\\Ubuntu\\')
check(
  '相同 POSIX 按 distro 隔离',
  toWslUncPath('Debian', '/tmp/a.txt') === '\\\\wsl.localhost\\Debian\\tmp\\a.txt'
)
check(
  '规范化点段/重复分隔/空格/Unicode',
  toWslUncPath('Ubuntu', '/tmp//a/../b c/中文') === '\\\\wsl.localhost\\Ubuntu\\tmp\\b c\\中文'
)
check('POSIX 规范化不会逃出根', normalizeWslPosixPath('/../../tmp') === '/tmp')
check('UNC 往返', fromWslUncPath('Ubuntu', '\\\\wsl.localhost\\Ubuntu\\tmp\\a b.txt') === '/tmp/a b.txt')
check(
  '扩展 UNC 前缀往返',
  fromWslUncPath('Ubuntu', '\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\u') === '/home/u'
)
check('wsl$ 别名往返', fromWslUncPath('Ubuntu', '\\\\wsl$\\Ubuntu\\tmp') === '/tmp')
check('UNC 根映射回 POSIX 根', fromWslUncPath('Ubuntu', '\\\\wsl.localhost\\Ubuntu\\') === '/')
check('宿主盘根绕过 UNC 回环', toWslNativePath('Debian', '/mnt/d') === 'D:\\')
check(
  '宿主盘子路径保持空格并转成分隔符',
  toWslNativePath('Ubuntu', '/mnt/d/Code/AICode/a b.txt') === 'D:\\Code\\AICode\\a b.txt'
)
check(
  '大写盘符目录和普通 Linux 目录不映射宿主盘',
  toWslNativePath('Debian', '/mnt/D') === '\\\\wsl.localhost\\Debian\\mnt\\D' &&
    toWslNativePath('Debian', '/mnt/data') === '\\\\wsl.localhost\\Debian\\mnt\\data'
)
check(
  '宿主盘路径先规范化再选择实际后端',
  toWslNativePath('Debian', '/mnt/d/../../tmp') === '\\\\wsl.localhost\\Debian\\tmp'
)
check('宿主盘根转回 POSIX', fromWslNativePath('Debian', 'D:\\') === '/mnt/d')
check(
  '宿主盘子路径转回 POSIX',
  fromWslNativePath('Ubuntu', 'D:\\Code\\AICode\\a b.txt') === '/mnt/d/Code/AICode/a b.txt'
)
check(
  '扩展盘符路径转回 POSIX',
  fromWslNativePath('Ubuntu', '\\\\?\\D:\\Code\\AICode') === '/mnt/d/Code/AICode'
)
check(
  '统一 fromNative 仍支持 Linux UNC',
  fromWslNativePath('Ubuntu', '\\\\wsl.localhost\\Ubuntu\\tmp') === '/tmp'
)
check('其他 distro UNC 被拒绝', rejects(() => fromWslUncPath('Ubuntu', '\\\\wsl.localhost\\Debian\\tmp')))
check('Windows 盘符被拒绝', rejects(() => toWslUncPath('Ubuntu', 'C:\\tmp')))
check('UNC 输入被拒绝', rejects(() => toWslUncPath('Ubuntu', '\\\\server\\share')))
check('相对路径被拒绝', rejects(() => toWslUncPath('Ubuntu', 'tmp/a')))
check('反斜杠文件名被拒绝', rejects(() => toWslUncPath('Ubuntu', '/tmp/a\\b')))
check('非法 distro 被拒绝', rejects(() => wslUncRoot('../Ubuntu')))

{
  const sessions = new Map([
    ['local-ubuntu', 'Ubuntu'],
    ['local-debian', 'Debian']
  ])
  let homeCalls = 0
  const resolver = new LocalPathResolver(
    (id) => sessions.get(id),
    async (distro) => {
      homeCalls++
      return distro === 'Ubuntu' ? '/home/test user' : '/'
    }
  )
  check('普通 Windows 路径原样通过', resolver.toNative('local-win', 'D:\\dir') === 'D:\\dir')
  check(
    'resolver 按 session 选择 UNC 根',
    resolver.toNative('local-debian', '/tmp') === '\\\\wsl.localhost\\Debian\\tmp'
  )
  check(
    'resolver 对 /mnt 盘符选择原生 Windows 后端并往返',
    resolver.toNative('local-debian', '/mnt/d/Code') === 'D:\\Code' &&
      resolver.fromNative('local-debian', 'D:\\Code') === '/mnt/d/Code'
  )
  check('home 返回 POSIX', await resolver.home('local-ubuntu') === '/home/test user')
  await resolver.home('local-ubuntu')
  check('home 按 distro 缓存', homeCalls === 1, String(homeCalls))
}

{
  const calls = []
  const home = await queryWslHome('Custom Linux', async (args) => {
    calls.push(args)
    return Buffer.from('/home/test user\n', 'utf8')
  })
  check('home 查询按 UTF-8 且保留空格', home === '/home/test user', home)
  check(
    'home 查询 distro 保持单独 argv',
    calls[0][0] === '-d' && calls[0][1] === 'Custom Linux' && calls[0].includes('--cd') === false
  )
  check('home 非绝对输出回退 /', await queryWslHome('Ubuntu', async () => Buffer.from('C:\\Users\\x\n')) === '/')
  check('home 查询失败回退 /', await queryWslHome('Ubuntu', async () => { throw new Error('down') }) === '/')
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
