/**
 * 把当前版本的更新公告导出成 release 资产 whatsnew.json。
 *
 * 旧版本发现新版时拉这个文件做「更新前展示」（main/updater.ts 的
 * fetchReleaseNotes；镜像与 GitHub 的 latest/download/ 都指得到它）。
 * 内容只有首条（当前版本）——拉的人只关心「新版是什么、改了什么」。
 *
 * 用法：node scripts/dump-whatsnew.mjs [输出路径=dist/whatsnew.json]
 * CI 发版（package job）在 electron-builder 发布后 gh release upload 它。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version
const top = JSON.parse(readFileSync('src/shared/whatsnew.json', 'utf8'))[0]
// build-agent.mjs 的守卫在打包路径上已经拦过；这里是独立调用时的双保险
if (!top || top.version !== pkgVersion) {
  throw new Error(
    `whatsnew.json 首条（${top?.version ?? '无'}）与 package.json（${pkgVersion}）不一致 —— 先补公告条目`
  )
}

const out = process.argv[2] ?? 'dist/whatsnew.json'
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ version: top.version, notes: top.notes }, null, 2) + '\n')
console.log(`${out} ← v${top.version}（${top.notes.length} 条）`)
