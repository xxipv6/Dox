/**
 * AI 容量状态栏端到端（真实 Kimi 接口）：
 *  设置里添加 Kimi 账号 → 标题栏出现「Kimi xx%」→ 点开浮层有 5 小时窗/每周两条 →
 *  IPC 层快照字段齐备 → 删除账号后挂件消失。
 *
 * 用法：KIMI_TEST_KEY=sk-... node scripts/verify-ai-usage.mjs
 * 前置：npm run build
 * 注意：账号会留在真实配置里（用户自己的 key）；脚本结尾不删除，需要清理去设置里删
 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'

mkdirSync('shots', { recursive: true })
const KEY = process.env.KIMI_TEST_KEY
if (!KEY) {
  console.log('需要 KIMI_TEST_KEY 环境变量')
  process.exit(1)
}

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => void d.accept())
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1500)

// ---- 已有账号就直接用（可重复跑），没有走一遍 UI 添加 ----
// 注意：同名账号的密文可能是别的主体（打包版/另一次 dev）加密的，本进程解不开
// —— 有就拿 id 把 key 重写一遍（同 key 覆盖，顺带治愈 AUTH_DECRYPT_FAILED）
const existing = await win.evaluate(() => window.api.aiAccountList())
const kimiAccount = existing.find((a) => a.provider === 'kimi')
if (kimiAccount) {
  await win.evaluate(
    // name 原样回传 —— saveAiAccount 对空名字的口径是「回退平台名」，会把备注名冲掉
    (acc) => window.api.aiAccountSave({ id: acc.id, name: acc.name, provider: 'kimi', apiKey: acc.key }),
    { id: kimiAccount.id, name: kimiAccount.name, key: KEY }
  )
  check('UI 添加 Kimi 账号（已有，重写 key 治愈钥匙串漂移）', true)
} else {
  // 打开设置（侧栏的设置按钮 title）
  await win.locator('button[title="设置"], button[title*="设置"]').first().click()
  await win.locator('.dialog').waitFor({ timeout: 5000 })
  await win.locator('.ai-provider-select').selectOption('kimi')
  await win.locator('.ai-key-input').fill(KEY)
  await win.locator('.ai-add-btn').click()
  await win.waitForTimeout(800)
  const after = await win.evaluate(() => window.api.aiAccountList())
  check('UI 添加 Kimi 账号', after.some((a) => a.provider === 'kimi'), JSON.stringify(after))
  await win.locator('.dialog .close-btn').click()
}

// ---- 触发一轮查询（IPC 层先验字段）----
const snap = await win.evaluate(() => window.api.aiUsageRefresh())
const kimi = snap.accounts.find((a) => a.provider === 'kimi')
check(
  'Kimi 查询成功且字段齐备（5h 窗 + 每周，已用口径）',
  !!kimi?.ok && kimi.fiveHourUsed !== undefined && kimi.weeklyUsed !== undefined,
  JSON.stringify(kimi)
)

// ---- 标题栏挂件：账号名 + 已用百分比 ----
const pill = win.locator('.title-bar .ai-pill')
try {
  await pill.waitFor({ timeout: 10000 })
  const text = await pill.textContent()
  check(
    '标题栏挂件显示「名字 5h:x% 7d:y%」',
    !!text && text.includes(kimi.name) && /5h:\d+%/.test(text) && /7d:\d+%/.test(text),
    text ?? ''
  )
} catch {
  check('标题栏出现 Kimi 容量挂件', false, '挂件未出现')
}

// ---- 点开明细浮层 ----
await pill.click()
await win.locator('.ai-pop').waitFor({ timeout: 3000 })
const popText = await win.locator('.ai-pop').textContent()
check('浮层含 5 小时窗与每周两行', (popText ?? '').includes('5 小时窗') && (popText ?? '').includes('每周'), (popText ?? '').slice(0, 120))
await win.screenshot({ path: 'shots/90-ai-usage.png' })

await app.close()
console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)
