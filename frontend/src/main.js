import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router/index.js'
import './styles.css'

async function boot () {
  // 纯静态托管（GitHub Pages）时用浏览器内 mock，不需要后端进程
  if (import.meta.env.VITE_DEMO === '1') {
    const { getApiBase } = await import('./utils/api.js')
    // 只有在没有配置外部后端时才启用浏览器内 mock；连了真后端就直连
    if (!getApiBase()) {
      const { installDemo } = await import('./demo/mock-api.js')
      installDemo()
    }
  }
  createApp(App).use(createPinia()).use(router).mount('#app')
}

boot()
