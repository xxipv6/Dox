/**
 * 补 node-pty 预编译 spawn-helper 丢失的执行位。
 *
 * node-pty 1.1.0 的 npm tarball 里 macOS 的 spawn-helper 就是 0644（打包时
 * 就没带执行位）。dev 里没人发现，是因为本机 node_modules 的执行位不知何时
 * 被补过；CI 全新 `npm ci` 按 tarball 原样解出 0644，electron-builder 原样
 * 打包 → release 里 macOS 的 pty 全部 spawn 不了（node-pty 在 __APPLE__ 下
 * 先 posix_spawnp 这个 helper），本地终端直接报「posix_spawnp failed.」。
 *
 * 挂在 postinstall 上：`npm ci`（含 CI 打包前）和本地全新安装都会跑到。
 * Windows 的 prebuilds 里没有 spawn-helper，天然是 no-op。
 */
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const prebuilds = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'node-pty', 'prebuilds')
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
