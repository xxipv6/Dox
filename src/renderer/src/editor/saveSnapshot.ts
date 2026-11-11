export interface SnapshotSaveFile {
  content: string
  savedContent: string
  mtime: number
  size: number
}

/**
 * 写回一份文件并更新保存基线。调用期间用户仍可以继续编辑。
 */
export async function saveContentSnapshot(
  file: SnapshotSaveFile,
  write: (content: string, expectedMtime: number) => Promise<number>,
  byteLength: (content: string) => number = (content) => new TextEncoder().encode(content).length
): Promise<number> {
  const contentSnapshot = file.content
  const expectedMtime = file.mtime
  const nextMtime = await write(contentSnapshot, expectedMtime)
  file.mtime = nextMtime
  file.savedContent = contentSnapshot
  file.size = byteLength(contentSnapshot)
  return nextMtime
}
