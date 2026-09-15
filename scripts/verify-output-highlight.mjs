/**
 * 输出高亮（IP / 日志级别 / error 关键字…）的验证：
 *
 *  阶段 1（纯函数，无需参数）：规则命中与优先级、格宽映射（中文/代理对）、
 *                              尾部空白裁剪、颜色混合
 *  阶段 2（端到端，需要 dev 在跑）：起隔离实例 → 本地终端打印一行含 IP 与 ERROR
 *                              的输出 → 断言 xterm 装饰真的挂上了（WebGL 渲染器
 *                              下 decoration 是 DOM 层，可数）
 *
 * 用法：node scripts/verify-output-highlight.mjs          # 只跑阶段 1
 *      node scripts/verify-output-highlight.mjs --e2e      # 阶段 1 + 阶段 2
 * 前置（阶段 2）：npm run dev（脚本用 --user-data-dir 起**独立**实例，不动你在跑的那个）
 */
import {
  HIGHLIGHT_RULES,
  buildLineText,
  cellWidthOf,
  cellXOf,
  mixHex,
  scanText
} from '../src/renderer/src/utils/outputHighlight.ts'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

/** 造的假行：cells = [[字符, 宽度], ...]，够 buildLineText 用 */
const fakeLine = (cells) => ({
  getCell: (x) => (x < cells.length ? { getWidth: () => cells[x][1], getChars: () => cells[x][0] } : undefined)
})
const ascii = (s) => fakeLine([...s].map((c) => [c, 1]))

const hits = (text) => scanText(text).map((m) => `${m.rule.id}:${text.slice(m.start, m.end)}`)

console.log('阶段 1：规则命中')

check('IPv4', hits('listen 0.0.0.0:22 from 192.168.3.5').includes('ipv4:192.168.3.5'))
check('IPv4 不吃版本号', hits('nginx/1.25.3').length === 0)
check('URL', hits('GET http://example.com/a?b=1 200').includes('url:http://example.com/a?b=1'))
check('大写 ERROR 走级别规则', hits('2026 ERROR boom').includes('level-error:ERROR'))
check(
  '同段只上一次色（级别优先，不再被 error 关键字重复命中）',
  hits('ERROR').length === 1,
  hits('ERROR').join()
)
check('小写 error 走关键字规则', hits('an error occurred').includes('error:error'))
check('大驼峰 Failed', hits('Failed to connect').includes('error:Failed'))
check('WARN 级别', hits('WARN disk low').includes('level-warn:WARN'))
check('INFO 级别', hits('INFO ready').includes('level-info:INFO'))
check('DEBUG 级别', hits('DEBUG x=1').includes('level-debug:DEBUG'))
check('timeout 关键字', hits('connection timeout').includes('warn:timeout'))
check('success 关键字', hits('success: uploaded').includes('ok:success'))

console.log('阶段 1：状态词')

// systemctl / docker / k8s 的状态列；failed 仍走 error 规则（顺序优先，不重复上色）
const sysct = hits('● myapp.service active (running)')
check('active 绿', sysct.includes('status-ok:active'))
check('running 绿', sysct.includes('status-ok:running'))
check('inactive 黄', hits('● myapp.service inactive (dead)').includes('status-warn:inactive'))
check('dead 黄', hits('inactive (dead)').includes('status-warn:dead'))
check('inactive 不误触发 active', !hits('inactive (dead)').includes('status-ok:active'))
check('deadline 不误触发 dead', !hits('deadline exceeded').includes('status-warn:dead'))
check('docker Exited 黄', hits('Exited (0) 2 min ago').includes('status-warn:Exited'))
check('k8s Pending 黄', hits('NAME READY STATUS 0/1 Pending').includes('status-warn:Pending'))
check('k8s CrashLoopBackOff 红（驼峰）', hits('pod-1 1/2 CrashLoopBackOff').includes('status-err:CrashLoopBackOff'))
check('unhealthy 红', hits('health: unhealthy').includes('status-err:unhealthy'))
check('healthy 绿', hits('health: healthy').includes('status-ok:healthy'))
check('failed 仍走 error 规则（红）', hits('status: failed').includes('error:failed'))

console.log('阶段 1：状态词第二批')

check('activating 黄（systemd 过渡态）', hits('● unit activating').includes('status-warn:activating'))
check('paused 黄', hits('CONTAINER paused').includes('status-warn:paused'))
check('zombie 黄', hits('501 90874 Z zombie / <defunct>').includes('status-warn:zombie'))
check('defunct 黄', hits('<defunct>').includes('status-warn:defunct'))
check('unknown 黄', hits('STATUS unknown').includes('status-warn:unknown'))
check('skipped 黄', hits('3 passed, 1 skipped').includes('status-warn:skipped'))
check('cancelled 黄（双 l 拼写）', hits('job cancelled').includes('status-warn:cancelled'))
check('canceled 黄（单 l 拼写）', hits('job canceled').includes('status-warn:canceled'))
check('read-only 黄（带连字符）', hits('mount: read-only').includes('status-warn:read-only'))
check('offline 黄', hits('node offline').includes('status-warn:offline'))
check('expired 黄', hits('certificate expired').includes('status-warn:expired'))
check('enabled 绿', hits('unit enabled').includes('status-ok:enabled'))
check('available 绿', hits('Deployment available').includes('status-ok:available'))
check('completed 绿', hits('job completed').includes('status-ok:completed'))
check('passed 绿', hits('3 passed, 1 skipped').includes('status-ok:passed'))
check('ErrImagePull 红（驼峰）', hits('pod-2 ErrImagePull').includes('status-err:ErrImagePull'))
check('OOMKilled 红（驼峰）', hits('LAST STATE OOMKilled').includes('status-err:OOMKilled'))
check('git conflict 红', hits('CONFLICT (content): merge conflict').includes('status-err:CONFLICT'))
check('EMERG 级别红', hits('nginx [EMERG] bind() failed').includes('level-error:EMERG'))
check('progressing 不误伤 progress', !hits('in progress').includes('status-warn:progress'))
check('available 不误伤 availability', !hits('availability: 99.9%').includes('status-ok:available'))

console.log('阶段 1：IPv6 不能误伤时间戳')

check('时间戳不算 IPv6', !hits('2026-09-14 15:11:22 INFO ok').some((h) => h.startsWith('ipv6')))
check('12:34:56 不算 IPv6', !hits('elapsed 12:34:56').some((h) => h.startsWith('ipv6')))
check('fe80::1 算 IPv6', hits('addr fe80::1 up').some((h) => h.startsWith('ipv6')))
check(
  '完整 8 组算 IPv6',
  hits('2001:0db8:85a3:0000:0000:8a2e:0370:7334').some((h) => h.startsWith('ipv6'))
)
check('带端口的 IPv6 不会把端口吃进去', !hits('[::1]:8080').some((h) => h.endsWith(':8080')))

console.log('阶段 1：格宽映射（中文/代理对）')

{
  // 「错误 」= 2+2+1 = 5 格，所以后面的 IP 从格 5 开始（按字符算是 3）
  const cells = [['错', 2], ['误', 2], [' ', 1], ...'1.1.1.1'.split('').map((c) => [c, 1])]
  const { text, widths } = buildLineText(fakeLine(cells), 40)
  const m = scanText(text).find((x) => x.rule.id === 'ipv4')
  check('中文之后仍能命中', !!m, text)
  check('IP 起点按格算（5 格，而不是字符下标 3）', m && cellXOf(widths, m.start) === 5, String(m && cellXOf(widths, m.start)))
  check('IP 宽度 = 7 格', m && cellWidthOf(widths, m.start, m.end) === 7)
}

{
  // emoji（代理对）占两格、两个 code unit：宽度数组必须按字符串下标对齐
  const cells = [['😀', 2], [' ', 1], ...'ERROR'.split('').map((c) => [c, 1])]
  const { text, widths } = buildLineText(fakeLine(cells), 40)
  const m = scanText(text).find((x) => x.rule.id === 'level-error')
  check('emoji 之后仍能命中 ERROR', !!m, JSON.stringify(text))
  check('emoji 算两格（ERROR 起点 = 3）', m && cellXOf(widths, m.start) === 3, String(m && cellXOf(widths, m.start)))
  check('emoji 的宽度数组对齐 code unit（长度 = 文本长度）', widths.length === text.length)
}

console.log('阶段 1：行文本裁剪与颜色混合')

{
  const { text, widths } = buildLineText(ascii('IP 1.1.1.1      '), 40)
  check('尾部空白被裁掉', text === 'IP 1.1.1.1', JSON.stringify(text))
  check('宽度数组跟着裁', widths.length === text.length)
}
{
  const { text } = buildLineText(ascii('   '), 40)
  check('整行空白裁成空串', text === '')
}
check('空文本不产生命中', scanText('').length === 0)
check('规则表里没有零宽正则', !HIGHLIGHT_RULES.some((r) => r.re.test('') && r.re.global && r.re.exec('')[0] === ''))
check('混色：黑底 10% 红', mixHex('#000000', '#ff0000', 0.1) === '#1a0000')
check('混色：白底 10% 红', mixHex('#ffffff', '#ff0000', 0.1) === '#ffe6e6')
check('混色：解析不出背景就退回前景色', mixHex('rgb(1,2,3)', '#00ff00', 0.1) === '#00ff00')

if (process.argv.includes('--e2e')) {
  console.log('阶段 2：端到端（隔离实例）')
  const { _electron } = await import('playwright')
  const { default: os } = await import('node:os')
  const app = await _electron.launch({
    args: ['.', `--user-data-dir=${os.tmpdir()}/dox-hl-e2e`],
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RENDERER_URL: 'http://localhost:5173/' }
  })
  await app.firstWindow().then((w) => w.waitForLoadState('domcontentloaded'))
  const win = await app.firstWindow()
  await win.waitForTimeout(3000)
  await win
    .waitForFunction(() => document.querySelector('.terminal-container')?.clientWidth > 200, undefined, {
      timeout: 20000
    })
    .catch(() => {})
  await win.waitForTimeout(2500)
  const term = win.locator('.terminal-container').first()
  await term.click()
  await win.waitForTimeout(500)
  // 一行里同时有 IP、ERROR 和普通文本
  await win.keyboard.type("echo 'connect 192.168.3.5 ERROR disk full'")
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2500)

  /*
   * 注意：WebGL 渲染器下**颜色不在 DOM 上**（decoration 元素的 style 里没有 color
   * / backgroundColor，继承的是终端前景色），真正的上色由 canvas 里的
   * CellColorResolver 按 cell 解析。所以这里断言的是 DOM 层能断言的东西 ——
   * 装饰的**数量、格子位置、行锚定**；颜色本身靠截图人工核对（shots/highlight-e2e.png：
   * IP = 青色、ERROR = 红色，命令行回显与输出行都有）。
   */
  const found = await win.evaluate(() => {
    const decos = [...document.querySelectorAll('.xterm-decoration')]
    return {
      count: decos.length,
      rows: [...new Set(decos.map((d) => d.style.top || d.offsetTop))].length,
      widths: decos.map((d) => Math.round(parseFloat(d.style.width) || 0)).filter((w) => w > 0),
      // marker 被裁/scrollback 满时的兜底：装饰必须挂在容器里，不是游离节点
      inContainer: decos.every((d) => d.closest('.xterm-decoration-container') !== null)
    }
  })
  console.log(`  装饰数：${found.count}  跨行：${found.rows}  宽度：${JSON.stringify(found.widths)}`)
  check('端到端：装饰被挂上（≥2：IP + ERROR）', found.count >= 2, JSON.stringify(found))
  check('端到端：跨两行（命令行回显 + 输出行各一组，说明 marker 锚对了行）', found.rows >= 2, String(found.rows))
  check('端到端：宽度是按格算出来的（> 0，不是 0 格）', found.widths.length >= 2, JSON.stringify(found.widths))
  check('端到端：装饰挂在容器里', found.inContainer)
  await win.screenshot({ path: 'shots/highlight-e2e.png' })
  console.log('  截图：shots/highlight-e2e.png（颜色需人工核对：IP 青、ERROR 红）')
  await app.close()
} else {
  console.log('（阶段 2 需要 dev 在跑：加 --e2e 参数）')
}

console.log(failed ? '\n结论: 存在失败项' : '\n结论: 全部通过')
process.exit(failed ? 1 : 0)
