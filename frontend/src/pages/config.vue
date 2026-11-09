<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { api, getAccessKey, getApiBase, setAccessKey, setApiBase } from '../utils/api.js'

const data = ref(null)
const err = ref('')
const loading = ref(false)
let timer = null

// 后端地址（GitHub Pages 这类静态托管靠它连自建后端；留空=同源/演示）
const apiBase = ref(getApiBase())
const accessKey = ref(getAccessKey())
const baseMsg = ref('')
const testing = ref(false)

function saveBase () {
  setApiBase(apiBase.value)
  setAccessKey(accessKey.value)
  apiBase.value = getApiBase()
  baseMsg.value = apiBase.value ? '已保存，正在重新连接…' : '已清空，回到同源（演示模式由静态站自己接管）'
  setTimeout(() => { location.reload() }, 600)
}

async function testBase () {
  testing.value = true
  baseMsg.value = ''
  const saved = getApiBase()
  const savedKey = getAccessKey()
  setApiBase(apiBase.value)
  setAccessKey(accessKey.value)
  try {
    const c = await api.config()
    baseMsg.value = `连接成功：mode=${c.mode}，tyys=${c.tyysBase}（点「保存并重载」生效）`
  } catch (e) {
    baseMsg.value = `连接失败：${e.message || e}`
    setApiBase(saved)
  } finally {
    setApiBase(saved) // 测试不改变当前生效地址
    setAccessKey(savedKey)
    testing.value = false
  }
}

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
        <div class="card-head"><h3>Backend</h3><span class="chip" :class="getApiBase() ? 'ok' : ''">{{ getApiBase() || '同源 / 浏览器内演示' }}</span></div>
        <div class="rows">
          <div class="row"><span class="k">后端地址</span><span class="v">
            <input v-model="apiBase" class="input" placeholder="https://your-backend.example.com" style="width:100%;max-width:420px" />
          </span></div>
          <div class="row"><span class="k">Access Key</span><span class="v">
            <input v-model="accessKey" class="input" type="password" placeholder="后端设了 ACCESS_KEY 才需要填" style="width:100%;max-width:420px" />
          </span></div>
          <div class="row"><span class="k">&nbsp;</span><span class="v">
            <button class="btn sm" :disabled="testing" @click="testBase">{{ testing ? '测试中…' : '测试连接' }}</button>
            <button class="btn sm" @click="saveBase" style="margin-left:8px">保存并重载</button>
          </span></div>
          <div v-if="baseMsg" class="row"><span class="k">结果</span><span class="v small">{{ baseMsg }}</span></div>
          <div class="row"><span class="k">说明</span><span class="v small">GitHub Pages 只有静态文件，必须连一个跑着本项目的后端（Render / 自建 VPS / 本机隧道）。填地址后所有 <code class="mono">/api/*</code> 请求都发到那里，演示数据自动停用。如果用自己域名部署，建议后端设 <code class="mono">ACCESS_KEY</code> 并在这里填同一个值，别人拿到地址也用不了。</span></div>
        </div>
      </div>

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
