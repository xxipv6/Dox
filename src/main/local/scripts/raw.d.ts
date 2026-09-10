/** Vite 的 ?raw 导入：把脚本文件内容作为字符串内联进产物 */
declare module '*.ps1?raw' {
  const content: string
  export default content
}

declare module '*.sh?raw' {
  const content: string
  export default content
}

declare module '*.zsh?raw' {
  const content: string
  export default content
}

declare module '*.fish?raw' {
  const content: string
  export default content
}
