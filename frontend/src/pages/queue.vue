<script setup>
/**
 * 独立的排队页（#/queue）
 * 不依赖登录绑定：任何人打开就能提交任务、看任务与在线执行机。
 * 网页只负责排队；真正的点击由连着手机/模拟器的执行机（deploy/device-worker.mjs）完成。
 */
import { ref, onMounted, onUnmounted } from 'vue'
import { api } from '../utils/api.js'

const username = ref('')
const action = ref('in')
const lat = ref(30.302331)
const lng = ref(120.089136)
const note = ref('')
const jobs = ref([])
const devices = ref([])
const msg = ref('')
const busy = ref(false)
const state = ref({ queued: 0, running: 0, done: 0, failed: 0, devices: 0, online: 0 })

const jobText = { queued: '排队中', running: '执行中', done: '成功', failed: '失败', canceled: '已取消' }
const jobClass = { queued: 'warn', running: '', done: 'ok', failed: 'err', canceled: '' }

const fmt = (t) => {
  if (!t) return '—'
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function load () {
  try {
    const [j, d] = await Promise.all([api.jobs(username.value ? username.value : '', 20), api.devices()])
    jobs.value = j.jobs || []
    state.value = j.state || state.value
    devices.value = d.devices || []
  } catch (e) {
    msg.value = `读取队列失败：${e.message || e}`
  }
}

async function submit (act) {
  if (!username.value.trim()) { msg.value = '先填学号'; return }
  busy.value = true
  msg.value = ''
  try {
    const out = await api.createJob({
      username: username.value.trim(),
      action: act || action.value,
      lat: Number(lat.value),
      lng: Number(lng.value),
      note: note.value || '网页提交'
    })
    msg.value = `已入队：${out.job.id}（${jobText[out.job.status] || out.job.status}）— 执行机会在几秒内接手`
    await load()
  } catch (e) {
    msg.value = `提交失败：${e.message || e}`
  } finally {
    busy.value = false
  }
}

async function cancel (id) {
  try { await api.cancelJob(id); await load() } catch (e) { msg.value = `取消失败：${e.message || e}` }
}

let timer = null
onMounted(async () => { await load(); timer = setInterval(load, 3000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="page-head">
    <h1>远程签到（设备队列）</h1>
    <span class="chip" :class="state.online ? 'ok' : 'warn'">在线执行机 {{ state.online }} / {{ state.devices }}</span>
  </div>

  <div class="alert">
    这个页面不需要登录。填学号 → 排队 → 一台连着手机（或模拟器）的执行机领取任务，进「浙大体艺」点签到/签退，结果回填。
    队列里现在：排队 {{ state.queued }} · 执行 {{ state.running }} · 成功 {{ state.done }} · 失败 {{ state.failed }}。
  </div>

  <div class="card">
    <div class="card-head">
      <span>提交任务</span>
      <span class="chip" :class="state.online ? 'ok' : 'warn'">{{ state.online ? '执行机在线' : '无执行机在线' }}</span>
    </div>

    <div class="row">
      <div class="field">
        <div class="label">学号</div>
        <input v-model="username" class="input" placeholder="3260103483" @keyup.enter="submit('in')">
      </div>
      <div class="field">
        <div class="label">纬度</div>
        <input v-model="lat" class="input" type="number" step="0.000001">
      </div>
      <div class="field">
        <div class="label">经度</div>
        <input v-model="lng" class="input" type="number" step="0.000001">
      </div>
    </div>

    <div class="row">
      <div class="field" style="flex: 2">
        <div class="label">备注（可选，写进结果里）</div>
        <input v-model="note" class="input" placeholder="例如：第 8 次课">
      </div>
      <div class="field" style="flex: 0 0 auto; align-self: end">
        <button class="btn" :disabled="busy" @click="submit('in')">排队签到</button>
        <button class="btn" :disabled="busy" @click="submit('out')">排队签退</button>
        <button class="btn" :disabled="busy" @click="load">刷新</button>
      </div>
    </div>

    <div v-if="msg" class="hint">{{ msg }}</div>
  </div>

  <div class="card">
    <div class="card-head"><span>任务</span><span class="mono small">{{ jobs.length }}</span></div>
    <div v-if="!jobs.length" class="muted small">还没有任务。填学号后点「排队签到」。</div>
    <div v-for="j in jobs" :key="j.id" class="session">
      <div>
        <div>{{ j.username }} · {{ j.action === 'out' ? '签退' : '签到' }}</div>
        <div class="muted small">{{ fmt(j.createdAt) }} · {{ j.deviceId || '未分配' }} · {{ j.message || '—' }}</div>
      </div>
      <div style="display: flex; gap: 8px; align-items: center">
        <span class="chip" :class="jobClass[j.status]">{{ jobText[j.status] || j.status }}</span>
        <button v-if="j.status === 'queued'" class="btn" @click="cancel(j.id)">取消</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><span>执行机</span><span class="mono small">{{ devices.length }}</span></div>
    <div v-if="!devices.length" class="muted small">
      没有执行机。在插着手机的电脑上跑：<code>node deploy/device-worker.mjs --serial &lt;serial&gt;</code>
    </div>
    <div v-for="d in devices" :key="d.deviceId" class="session">
      <div>
        <div>{{ d.label || d.deviceId }}</div>
        <div class="muted small">{{ d.serial || '—' }} · 心跳 {{ fmt(d.lastSeen) }}</div>
      </div>
      <span class="chip" :class="d.online ? 'ok' : 'warn'">{{ d.online ? '在线' : '离线' }}</span>
    </div>
  </div>
</template>
