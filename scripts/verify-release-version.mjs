/** Release 创建前守卫：tag、package.json 与更新公告必须描述同一个版本。 */
import { readFileSync } from 'node:fs'

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME
if (!tag) throw new Error('缺少 tag 参数或 GITHUB_REF_NAME')
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const top = JSON.parse(readFileSync('src/shared/whatsnew.json', 'utf8'))[0]
const expectedTag = `v${pkg.version}`
const problems = []
if (tag !== expectedTag) problems.push(`tag ${tag} != ${expectedTag}`)
if (top?.version !== pkg.version) {
  problems.push(`whatsnew 首条 ${top?.version ?? '无'} != package ${pkg.version}`)
}
if (!Array.isArray(top?.notes) || top.notes.length === 0 || top.notes.some((note) => typeof note !== 'string' || !note.trim())) {
  problems.push('whatsnew 首条必须含非空字符串 notes')
}
if (problems.length) throw new Error(`Release 版本校验失败：\n- ${problems.join('\n- ')}`)
console.log(`Release 版本一致：${tag}，${top.notes.length} 条更新公告`)
