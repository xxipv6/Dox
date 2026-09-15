import { execFile } from 'node:child_process'
import { mergeEnv, resolveShellEnv } from './shellEnv'

/*
 * 解析本机可执行文件的真实路径（which/where），带缓存。
 *
 * 从 ContainerManager 挪到这里的理由：搜索功能（SearchService 探测 rg/grep）
 * 也要用，而它的依赖（mergeEnv/resolveShellEnv）本来就在 local/ 同城，
 * 不该让 search → ContainerManager 产生重依赖。
 *
 * Windows 的坑（原注释，必须保留）：Docker Desktop 在 bin 目录里
 * 也放了一个**同样叫 `docker`、没有扩展名的 1359 字节 POSIX shell 脚本**
 * （内容是 `#!/usr/bin/env sh` + 一堆 case 分支）。而 `where docker` 把那个
 * 脚本排在 `.exe` 前面 —— 直接取第一行就等于把 sh 脚本交给 CreateProcess，
 * 报 `Cannot create process, error code: 193`（ERROR_BAD_EXE_FORMAT）。
 *
 * 只认 `.exe`：`.cmd`/`.bat` 同样不能直接被 CreateProcess 执行（要经 cmd.exe）。
 * 一个 `.exe` 都找不到就退回裸名字，让 CreateProcess 自己按 PATH 找 ——
 * 那是这一层存在之前的行为，不会比它更差。
 */
export async function resolveExecutable(binary: string): Promise<string> {
  const cached = resolvedBinaryCache.get(binary)
  if (cached) return cached
  const finder = process.platform === 'win32' ? 'where' : 'which'
  // GUI 启动只有 launchd 最小 PATH，which 要带 login shell 环境才找得到
  // /opt/homebrew/bin 里的 docker/podman（与 runLocal 同一个缺口的另一半）
  const env = mergeEnv(
    process.env as Record<string, string>,
    (await resolveShellEnv()) ?? {}
  )
  const found = await new Promise<string[]>((resolve) => {
    execFile(finder, [binary], { windowsHide: true, env }, (err, stdout) => {
      resolve(
        err
          ? []
          : stdout
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean)
      )
    })
  })

  let resolved: string
  if (!found.length) resolved = binary
  // POSIX 下 execvp 认 shebang 脚本，哪个在前就用哪个
  else if (process.platform !== 'win32') resolved = found[0]
  else resolved = found.find((p) => /\.exe$/i.test(p)) ?? binary
  resolvedBinaryCache.set(binary, resolved)
  return resolved
}

/*
 * 解析结果缓存：本机 PATH 在应用活着期间不会变，之前每次开容器终端
 * 都 spawn 一次 which/where 是白送的进程开销。不设上限 —— binary
 * 名字就那几个（docker/podman/rg/grep）。
 */
const resolvedBinaryCache = new Map<string, string>()
