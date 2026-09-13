import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * `dox` 命令安装器（CLI 伴侣的壳）。
 *
 * 命令本体是个小脚本：解析参数 → 直接用 app 二进制带 `--cli` 参数启动。
 * 没在跑 = 冷启动带参；在跑 = 单实例锁把参数转交给在跑的实例。
 * 不注册 URL scheme。
 *
 * PATH：macOS/Linux 写进本来就在 PATH 的目录（/usr/local/bin），写不进才
 * 提示手动加；Windows 没有这种目录，直接改用户 PATH 注册表（HKCU\
 * Environment，无需管理员）——让用户手动加 PATH 是装了个寂寞。
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
  // 注释只能 ASCII：cmd 按系统 OEM 代码页（中文机 GBK）读批处理，UTF-8 的
  // 中文注释会被错配成可执行垃圾（报「'荆' 不是内部或外部命令」）；
  // 换行必须 CRLF：LF-only 的批处理带括号块在 cmd 里有解析坑
  return `@echo off
rem Dox CLI companion - installed from Dox settings page
if "%~1"=="" (
  start "" "${execPath}"${appPath} --cli=focus
  exit /b 0
)
if exist "%~1\\" (
  for %%I in ("%~1") do start "" "${execPath}"${appPath} --cli=local "--cwd=%%~fI"
) else (
  start "" "${execPath}"${appPath} --cli=connect "--target=%~1"
)
`.replace(/\n/g, '\r\n')
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

/** 读用户 PATH 注册表原值（不展开 %VAR%）；没有就是空串 */
function readUserPath(): string {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const m = out.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/m)
    return m?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

/**
 * 广播 WM_SETTINGCHANGE：资源管理器收到后才把新环境传给由它启动的进程。
 * 已经开着的终端环境是启动时快照，怎么都救不了，只能提示重开。
 */
function broadcastEnvironmentChange(): void {
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Add-Type -Namespace W -Name S -MemberDefinition ' +
          '\'[System.Runtime.InteropServices.DllImport("user32.dll",CharSet=System.Runtime.InteropServices.CharSet.Auto)]' +
          ' public static extern System.IntPtr SendMessageTimeout(System.IntPtr h,uint m,System.UIntPtr w,string l,uint f,uint t,out System.UIntPtr r);\';' +
          '$r=[System.UIntPtr]::Zero;' +
          '[W.S]::SendMessageTimeout([System.IntPtr]0xffff,0x1A,[System.UIntPtr]::Zero,"Environment",2,5000,[ref]$r) | Out-Null'
      ],
      { stdio: 'ignore' }
    )
  } catch {
    /* 广播失败只是 Explorer 不刷新，注册表已经改好了 */
  }
}

/**
 * 把目录加进用户 PATH（HKCU\Environment，无需管理员）。返回是否真有改动。
 *
 * 不能用 setx：它把 REG_EXPAND_SZ 压成 REG_SZ（里面的 %VAR% 引用全废），
 * 还有 1024 字符截断。reg add 保留类型、不动原值里的变量引用。
 */
function addToUserPath(dir: string): boolean {
  const norm = (s: string): string => s.replace(/[\\/]+$/, '').toLowerCase()
  const current = readUserPath()
  const parts = current.split(';').map((p) => p.trim()).filter(Boolean)
  if (parts.some((p) => norm(p) === norm(dir))) return false
  const next = parts.length ? `${parts.join(';')};${dir}` : dir
  execFileSync(
    'reg',
    ['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', next, '/f'],
    { stdio: 'ignore' }
  )
  broadcastEnvironmentChange()
  return true
}

export function installCli(): CliInstallResult {
  if (process.platform === 'win32') {
    const dir = path.join(process.env['LOCALAPPDATA'] ?? os.homedir(), 'dox', 'bin')
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, 'dox.cmd')
    fs.writeFileSync(target, cmdScript(process.execPath, appPathArg()))
    return {
      path: target,
      note: addToUserPath(dir)
        ? '已自动加进用户 PATH；新开的终端即可使用 dox（已经开着的终端要重开才生效）'
        : undefined
    }
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
