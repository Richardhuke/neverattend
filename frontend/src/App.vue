<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from './stores/user.js'
import { api } from './utils/api.js'

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const nav = [
  { to: '/', label: 'Run', icon: '▶' },
  { to: '/queue', label: '排队', icon: '⧗' },
  { to: '/manage', label: 'Manage', icon: '☰' },
  { to: '/about', label: 'About', icon: '?' }
]
const active = path => (path === '/' ? route.path === '/' : route.path.startsWith(path))
const initials = computed(() => (user.username ? user.username.slice(-4) : '----'))

// 退出登录 = 清掉 localStorage 里的学号/token/密码密文，再回绑定页
async function logout () {
  const username = user.username
  user.clear()                       // 先清本机，界面立刻回到未接入
  router.replace('/first-time')
  try { await api.logout(username) } catch { /* 纯静态演示没有后端，忽略 */ }
}
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <router-link to="/" class="brand">
        <span class="brand-mark">NA</span>
        <span class="brand-text">NeverAttend</span>
        <span class="brand-sub">浙大体艺 · 身体素质课考勤</span>
      </router-link>

      <nav class="nav">
        <router-link v-for="n in nav" :key="n.to" :to="n.to" class="nav-link" :class="{ active: active(n.to) }">
          <span class="nav-icon">{{ n.icon }}</span>{{ n.label }}
        </router-link>
        <router-link to="/config" class="nav-link ghost" :class="{ active: route.path === '/config' }">Config</router-link>
      </nav>

      <div class="who">
        <span class="dot" :class="user.isFirstTime ? 'off' : 'on'"></span>
        <span class="who-id">{{ user.username || '未接入' }}</span>
        <button v-if="!user.isFirstTime" class="who-out" title="退出登录：清除本机保存的学号与凭据" @click="logout">退出</button>
      </div>
    </header>

    <main class="main">
      <router-view />
    </main>

    <footer class="foot">
      <span>NeverAttend · 本地凭据 · 10s 轮询自动签到</span>
      <span class="mono">{{ initials }}</span>
    </footer>
  </div>
</template>
