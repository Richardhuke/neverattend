<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { api } from '../utils/api.js'

const data = ref(null)
const err = ref('')
const loading = ref(false)
let timer = null

const fmt = v => {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN')
}

async function load () {
  loading.value = true
  err.value = ''
  try { data.value = await api.config() } catch (e) { err.value = e.message || String(e) } finally { loading.value = false }
}

onMounted(async () => { await load(); timer = setInterval(load, 8000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <section>
    <div class="page-head">
      <h2>Config</h2>
      <button class="btn sm" :disabled="loading" @click="load">{{ loading ? '刷新中…' : 'Refresh' }}</button>
    </div>

    <div v-if="err" class="alert err"><div><div class="a-title">加载失败</div><div class="a-desc">{{ err }}</div></div></div>

    <template v-if="data">
      <div class="card">
        <div class="card-head"><h3>Runtime</h3><span class="chip" :class="data.mode === 'mock' ? 'warn' : 'ok'">{{ data.mode }}</span></div>
        <div class="rows">
          <div class="row"><span class="k">TYYS Base</span><span class="v mono small">{{ data.tyysBase }}</span></div>
          <div class="row"><span class="k">守护</span><span class="v">{{ data.watch.running ? 'RUNNING' : 'STOPPED' }} · {{ Math.round(data.watch.intervalMs / 1000) }}s · 轮询 {{ data.watch.polls }} · 签到 {{ data.watch.checkins }}</span></div>
          <div class="row"><span class="k">上次轮询</span><span class="v mono">{{ fmt(data.watch.lastPollAt) }}</span></div>
          <div class="row"><span class="k">已接入</span><span class="v">{{ data.sessions.length }} 个账号</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Endpoint Map</h3><span class="chip">可被 config/tyys.endpoints.json 覆盖</span></div>
        <table class="table">
          <thead><tr><th>Key</th><th>Path</th></tr></thead>
          <tbody>
            <tr v-for="(v, k) in data.endpoints" :key="k"><td class="mono">{{ k }}</td><td class="mono small">{{ v }}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-head"><h3>Pipeline Steps</h3><span class="chip">{{ data.steps.length }}</span></div>
        <div class="rows">
          <div v-for="(s, i) in data.steps" :key="s.key" class="row">
            <span class="k mono">#{{ i }} {{ s.key }}</span><span class="v">{{ s.title }}</span>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>
