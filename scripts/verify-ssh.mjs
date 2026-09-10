/**
 * 直连测试 SSH 握手链路，定位「连不上」卡在哪一步。
 * 用法：node scripts/verify-ssh.mjs <host> <port> <username>
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Client } = require('ssh2')

// 不再硬编码测试主机：公开仓库里写死自己的服务器地址，等于公开
// 「这台机器开着 22 端口」，改用参数或环境变量传入。
const host = process.argv[2] ?? process.env.DOX_TEST_HOST
if (!host) {
  console.error('用法: node scripts/verify-ssh.mjs <host> [port] [user]，或设置 DOX_TEST_HOST')
  process.exit(2)
}
const port = Number(process.argv[3] ?? 22)
const username = process.argv[4] ?? 'root'

const t0 = Date.now()
const client = new Client()

client.on('banner', (msg) => console.log(`  收到 banner: ${msg.trim().slice(0, 60)}`))

client.connect({
  host,
  port,
  username,
  // 故意用错密码：能走到 "认证失败" 说明 TCP/握手/主机指纹都正常
  password: '__dox_diagnostic_wrong_password__',
  readyTimeout: 20000,
  keepaliveInterval: 10000,
  hostHash: 'sha256',
  hostVerifier: (hash, verify) => {
    console.log(`  主机指纹校验回调 (sha256: ${hash}) — 用时 ${Date.now() - t0}ms`)
    verify(true)
    return true
  }
})

client.on('ready', () => {
  console.log('  意外成功（不应该，密码是假的）')
  client.end()
})

client.on('error', (err) => {
  console.log(`\n结果: ${err.level ?? ''} ${err.message}`)
  if (/authentication/i.test(err.message)) {
    console.log('=> 链路完全正常，问题在密码/用户名/密钥等认证信息')
  } else if (/handshake|banner|timeout|ETIMEDOUT/i.test(err.message)) {
    console.log('=> 握手阶段失败，可能是服务器端限制或网络中间设备拦截')
  } else {
    console.log('=> 其他错误，见上方 message')
  }
  process.exit(0)
})

setTimeout(() => {
  console.log('=> 20 秒仍未返回，连接被挂起')
  process.exit(1)
}, 22000)
