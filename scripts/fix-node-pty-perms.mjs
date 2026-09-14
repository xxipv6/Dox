/**
 * node-pty 安装后的两处修补，挂在 postinstall 上（npm ci / 全新安装都会跑到）：
 *
 *  1. 补 macOS 预编译 spawn-helper 丢失的执行位。
 *     node-pty 1.1.0 的 npm tarball 里 spawn-helper 就是 0644（打包时没带执行位）。
 *     dev 里没人发现，是因为本机 node_modules 的执行位不知何时被补过；CI 全新
 *     `npm ci` 按 tarball 原样解出 0644，electron-builder 原样打包 → release 里
 *     macOS 的 pty 全部 spawn 不了（posix_spawnp failed），本地终端直接不可用。
 *
 *  2. Windows：给 ConPTY 的两个管道 socket 补 error 监听。
 *     windowsPtyAgent 里的 _inSocket/_outSocket 没有 on('error')；关闭 pty 时
 *     还有在途写入的话，命名管道的 EAGAIN 会在 WriteWrap.onWriteComplete 里
 *     异步冒成 uncaughtException → Electron 弹「A JavaScript error occurred
 *     in the main process」原生模态框 → 主进程（连带整个应用）冻住，直到用户
 *     点掉弹窗。挂上监听把这类「写到已死管道」的残余错误就地吞掉。
 *     上游：node-pty 1.1.0 lib/windowsPtyAgent.js 第 71-87 行。
 */
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'node-pty')

// ---- 1. spawn-helper 执行位（仅 macOS prebuilds 里存在；Windows 天然 no-op）----
const prebuilds = join(root, 'prebuilds')
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}

// ---- 2. ConPTY 管道 socket 的 error 监听（幂等：认 dox-err-guard 标记）----
const agentJs = join(root, 'lib', 'windowsPtyAgent.js')
if (existsSync(agentJs) && !readFileSync(agentJs, 'utf8').includes('dox-err-guard')) {
  let src = readFileSync(agentJs, 'utf8')
  for (const name of ['_outSocket', '_inSocket']) {
    src = src.replace(
      `this.${name}.setEncoding('utf8');`,
      `this.${name}.setEncoding('utf8');\n` +
        `        this.${name}.on('error', function () { }); // dox-err-guard: pty 关闭后残余写在 Windows 上异步 EAGAIN`
    )
  }
  writeFileSync(agentJs, src)
}
