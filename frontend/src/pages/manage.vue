<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../utils/api.js'
import { useUserStore } from '../stores/user.js'

const router = useRouter()
const user = useUserStore()

const reveal = ref(false)
const busy = ref(false)
const msg = ref('')
const signedCount = ref(0)
const total = ref(0)

const masked = token => (!token ? '(not set)' : token.length <= 24 ? token : `${token.slice(0, 10)}[...]${token.slice(-10)}`)

async function refresh () {
  busy.value = true
  msg.value = ''
  try {
    const me = await user.refreshToken()
    msg.value = `已续期：${me.xh}`
  } catch (e) {
    msg.value = e.message || String(e)
  } finally {
    busy.value = false
  }
}

function clearAll () {
  user.clear()
  router.push('/first-time')
}

onMounted(async () => {
  if (user.isFirstTime) return
  try {
    const s = await api.status(user.username, user.token)
    signedCount.value = s.signedCount || 0
    total.value = (s.sessions || []).length
  } catch { /* ignore */ }
})
</script>

<template>
  <section>
    <div class="page-head"><h2>Manage stored info</h2></div>

    <div class="card">
      <div class="card-head"><h3>Auth</h3><span class="chip" :class="user.isFirstTime ? 'warn' : 'ok'">{{ user.isFirstTime ? '未绑定' : '已绑定' }}</span></div>
      <div class="rows">
        <div class="row"><span class="k">Username</span><span class="v mono">{{ user.username || '(not set)' }}</span></div>
        <div class="row"><span class="k">Password</span><span class="v">{{ user.hasPassword ? '*****' : '(not offered)' }}</span></div>
        <div class="row">
          <span class="k">JWT Token</span>
          <span class="v mono small" style="cursor:pointer" @click="reveal = !reveal">{{ reveal ? (user.token || '(not set)') : masked(user.token) }}</span>
        </div>
      </div>

      <div v-if="msg" class="hint">{{ msg }}</div>

      <div style="display:flex; gap:8px; margin-top:14px">
        <button v-if="user.hasPassword" class="btn" :disabled="busy" @click="refresh">{{ busy ? '续期中…' : 'Refetch token' }}</button>
        <button class="btn danger" @click="clearAll">Remove all my information</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>考勤概览</h3></div>
      <div class="stat-grid">
        <div class="stat"><div class="s-k">已签到</div><div class="s-v">{{ signedCount }}</div></div>
        <div class="stat"><div class="s-k">场次总数</div><div class="s-v">{{ total }}</div></div>
        <div class="stat"><div class="s-k">轮询间隔</div><div class="s-v">10s</div></div>
      </div>
    </div>
  </section>
</template>
