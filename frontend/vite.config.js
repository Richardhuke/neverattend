import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const demo = env.VITE_DEMO === '1'
  return {
    // Pages 部署在 /<repo>/ 下，相对路径两种部署都吃得下
    base: './',
    plugins: [vue()],
    build: {
      // 演示构建单独出目录，不覆盖后端托管的 static
      outDir: demo ? '../dist-demo' : '../backend/static',
      emptyOutDir: true
    },
    server: {
      port: 5173,
      proxy: {
        '/api': { target: 'http://localhost:8000', changeOrigin: true }
      }
    }
  }
})
