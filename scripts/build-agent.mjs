/**
 * dox-agent 交叉编译：产出各目标平台的静态二进制到 build/agent/。
 *
 * CGO_ENABLED=0 → 纯静态，远端不需要任何运行时/glibc 版本匹配；
 * -s -w 去掉符号表与调试信息，体积砍 ~30%。
 *
 * 用法：node scripts/build-agent.mjs           # 全部平台
 *      node scripts/build-agent.mjs linux/arm64 # 指定一个
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const TARGETS = process.argv[2]
  ? [process.argv[2]]
  : ['linux/amd64', 'linux/arm64']

// 输出要用绝对路径：go build 的 cwd 是 agent/，相对路径会落到那里面去
const outDir = resolve('build/agent')
mkdirSync(outDir, { recursive: true })

for (const target of TARGETS) {
  const [goos, goarch] = target.split('/')
  const out = `${outDir}/dox-agent-${goos}-${goarch}`
  console.log(`构建 ${target} → ${out}`)
  execFileSync(
    'go',
    ['build', '-trimpath', '-ldflags', '-s -w', '-o', out, '.'],
    { cwd: 'agent', stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch } }
  )
}
console.log('完成')
