<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useUserStore } from './stores/user.js'

const route = useRoute()
const user = useUserStore()
const nav = [
  { to: '/', label: 'Run', icon: '▶' },
  { to: '/manage', label: 'Manage', icon: '☰' },
  { to: '/about', label: 'About', icon: '?' }
]
const active = path => (path === '/' ? route.path === '/' : route.path.startsWith(path))
const initials = computed(() => (user.username ? user.username.slice(-4) : '----'))
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
