import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * `dox` 命令安装器（CLI 伴侣的壳）。
 *
 * 命令本体是个小脚本：解析参数 → 直接用 app 二进制带 `--cli` 参数启动。
 * 没在跑 = 冷启动带参；在跑 = 单实例锁把参数转交给在跑的实例。
 * 不注册 URL scheme，不在系统里留任何痕迹。
 */

function shScript(execPath: string, appPath: string): string {
  return `#!/bin/sh
# Dox CLI 伴侣 —— 由 Dox 设置页安装；卸载 Dox 后可手动删除本文件
#   dox                      把 Dox 窗口带到前面
#   dox .                    新开本地终端标签，落在这个目录
#   dox root@1.2.3.4:2222    连接设备（已保存的直接连，没存过预填表单）
if [ $# -eq 0 ]; then
  set -- "--cli=focus"
elif [ -d "$1" ]; then
  set -- "--cli=local" "--cwd=$(cd "$1" && pwd)"
else
  set -- "--cli=connect" "--target=$1"
fi
"${execPath}"${appPath} "$@" >/dev/null 2>&1 &
`
}

function cmdScript(execPath: string, appPath: string): string {
  return `@echo off
rem Dox CLI 伴侣 —— 由 Dox 设置页安装
if "%~1"=="" (
  start "" "${execPath}"${appPath} --cli=focus
  exit /b 0
)
if exist "%~1\\" (
  for %%I in ("%~1") do start "" "${execPath}"${appPath} --cli=local "--cwd=%%~fI"
) else (
  start "" "${execPath}"${appPath} --cli=connect "--target=%~1"
)
`
}

/**
 * 二进制后面要不要跟 app 路径：打包后二进制自己就是 app（Dox.app/.../Dox），
 * 裸跑就对；dev/未打包是裸 electron 二进制，不带路径它是「Electron」这个
 * 另一个应用（独立单实例锁、打印 usage 后干等），CLI 会静默打不到 Dox 上。
 */
function appPathArg(): string {
  return app.isPackaged ? '' : ` "${app.getAppPath()}"`
}

export interface CliInstallResult {
  path: string
  /** 需要用户收尾的提示（比如把目录加进 PATH） */
  note?: string
}

export function installCli(): CliInstallResult {
  if (process.platform === 'win32') {
    const dir = path.join(process.env['LOCALAPPDATA'] ?? os.homedir(), 'dox', 'bin')
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, 'dox.cmd')
    fs.writeFileSync(target, cmdScript(process.execPath, appPathArg()))
    return { path: target, note: `把 ${dir} 加进 PATH 后即可在任意终端使用 dox 命令` }
  }

  const home = os.homedir()
  // /usr/local/bin 在大多数 Mac（Homebrew 惯例）上当前用户可写；
  // 不可写就退到用户自己的 bin 并提示 PATH
  const candidates = [
    { dir: '/usr/local/bin', needsPath: false },
    { dir: path.join(home, '.local', 'bin'), needsPath: true },
    { dir: path.join(home, 'bin'), needsPath: true }
  ]
  let lastErr: unknown = null
  for (const c of candidates) {
    try {
      fs.mkdirSync(c.dir, { recursive: true })
      const target = path.join(c.dir, 'dox')
      fs.writeFileSync(target, shScript(process.execPath, appPathArg()), { mode: 0o755 })
      return {
        path: target,
        note: c.needsPath ? `把 ${c.dir} 加进 PATH 后即可在任意终端使用 dox 命令` : undefined
      }
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`没有可写的安装位置：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
}
