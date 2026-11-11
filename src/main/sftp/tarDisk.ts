import fs from 'node:fs'
import { dirname } from 'node:path'
import { safeLocalJoin, type TarParsedEntry } from './tarStream.ts'

/** raw tar 与 agent 归档共用的硬链接材料化：复制已解出的目标，失败不留假文件。 */
export async function materializeHardlink(
  localDir: string,
  entry: Pick<TarParsedEntry, 'name' | 'linkName'>
): Promise<void> {
  const targetPath = safeLocalJoin(localDir, entry.name)
  if (!targetPath) return
  const sourcePath = entry.linkName ? safeLocalJoin(localDir, entry.linkName) : null
  if (!sourcePath) throw new Error(`硬链接目标越界或缺失：${entry.linkName ?? entry.name}`)
  await fs.promises.mkdir(dirname(targetPath), { recursive: true })
  try {
    await fs.promises.copyFile(sourcePath, targetPath)
  } catch (err) {
    await fs.promises.unlink(targetPath).catch(() => undefined)
    throw err
  }
}
