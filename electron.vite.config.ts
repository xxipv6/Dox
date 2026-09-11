import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    // ssh2 / electron-store 保持外部依赖，其余由 electron-vite 打包
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      // 之前没显式开：产物 2.38MB 单 chunk、连 region 注释都在，
      // 首屏要全文解析完才能跑 main.ts。用 rolldown 自带的 oxc 压缩
      // （'esbuild' 在 vite 8 里要额外装 esbuild，oxc 效果同级）
      minify: 'oxc'
    },
    plugins: [vue()]
  }
})
