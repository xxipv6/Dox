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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const TARGETS = process.argv[2]
  ? [process.argv[2]]
  : ['linux/amd64', 'linux/arm64']

// 输出要用绝对路径：go build 的 cwd 是 agent/，相对路径会落到那里面去
const outDir = resolve('build/agent')
mkdirSync(outDir, { recursive: true })

// 版本双写守卫：agent/main.go 与 src/shared/agentVersion.ts 靠人工同步，
// 一旦 drift，新版应用会认不出「远端是旧 agent」（没有升级按钮）——
// 这里是两处唯一的会合点，直接拦下。
const goVersion = readFileSync('agent/main.go', 'utf8').match(/var version = "([^"]+)"/)?.[1]
const bundledVersion = readFileSync('src/shared/agentVersion.ts', 'utf8')
  .match(/BUNDLED_AGENT_VERSION = '([^']+)'/)?.[1]
if (!goVersion || !bundledVersion) {
  throw new Error('读不到 agent 版本（agent/main.go 或 src/shared/agentVersion.ts 格式变了）')
}
if (goVersion !== bundledVersion) {
  throw new Error(
    `agent 版本不同步：main.go 是 ${goVersion}，agentVersion.ts 是 ${bundledVersion} —— 两边一起改`
  )
}
// version.txt 随 extraResources 进安装包：运行时用它校验 resources/agent
// 与 app.asar 是同一次打包（Windows 覆盖安装的「新旧混合」会在这里现形）
writeFileSync(`${outDir}/version.txt`, `${goVersion}\n`)

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
