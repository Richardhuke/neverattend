<script setup>
import { reactive, ref, computed } from 'vue'
import { streamSSE } from '../utils/sse.js'

const props = defineProps({
  username: { type: String, required: true },
  token: { type: String, required: true },
  sessionId: { type: String, default: '' },
  code: { type: String, default: '' },
  autoCode: { type: Boolean, default: false },
  ignorePrejudgement: { type: Boolean, default: false },
  longitude: { type: Number, default: null },
  latitude: { type: Number, default: null },
  jitter: { type: Number, default: null },
  action: { type: String, default: 'in' },
  away: { type: Boolean, default: false },
  autoStart: { type: Boolean, default: true }
})
const emit = defineEmits(['done'])

const STEPS = [
  { key: 'auth', title: 'Authenticating' },
  { key: 'course', title: 'Fetching course info' },
  { key: 'session', title: 'Locating session' },
  { key: 'term', title: 'Checking term & window' },
  { key: 'locate', title: 'Resolving target' },
  { key: 'prejudge', title: 'Prejudgment [1/3]' },
  { key: 'submit', title: 'Submitting [2/3]' },
  { key: 'verify', title: 'Verifying [3/3]' }
]

const steps = reactive(Object.fromEntries(STEPS.map(s => [s.key, { status: 'idle', message: '' }])))
const running = ref(false)
const done = ref(false)
const errorMsg = ref('')
const result = ref(null)
const ctrl = ref(null)

const iconOf = s => (s.status === 'ok' ? '✓' : s.status === 'err' ? '✕' : s.status === 'running' ? '·' : '○')

async function start () {
  if (running.value) return
  running.value = true
  done.value = false
  errorMsg.value = ''
  result.value = null
  for (const k of Object.keys(steps)) { steps[k].status = 'idle'; steps[k].message = '' }
  ctrl.value = new AbortController()
  await streamSSE('./api/checkin', {
    username: props.username,
    token: props.token,
    sessionId: props.sessionId || undefined,
    code: props.code || undefined,
    action: props.action,
    autoCode: props.autoCode,
    longitude: props.longitude ?? undefined,
    latitude: props.latitude ?? undefined,
    jitter: props.jitter ?? undefined,
    away: props.away,
    ignorePrejudgement: props.ignorePrejudgement
  }, ev => {
    if (ev.type === 'info') {
      for (const k of Object.keys(steps)) if (steps[k].status === 'running') steps[k].status = 'idle'
      if (steps[ev.step]) { steps[ev.step].status = 'running'; steps[ev.step].message = ev.message }
    } else if (ev.type === 'success') {
      if (steps[ev.step]) { steps[ev.step].status = 'ok'; steps[ev.step].message = ev.message }
    } else if (ev.type === 'error') {
      errorMsg.value = ev.message
      for (const k of Object.keys(steps)) if (steps[k].status === 'running') steps[k].status = 'err'
      if (ev.step === 'error') {
        const last = [...STEPS].reverse().find(s => steps[s.key].status !== 'ok')
        if (last) { steps[last.key].status = 'err'; steps[last.key].message = ev.message }
      }
    } else if (ev.type === 'done') {
      done.value = true
      running.value = false
      result.value = ev.data || null
      emit('done', ev.data || null)
    }
  }, { signal: ctrl.value.signal })
  running.value = false
  done.value = true
}

if (props.autoStart) start()

const verb = computed(() => (props.action === 'out' ? '签退' : '签到'))
const headline = computed(() => {
  if (running.value) return `正在${verb.value}…`
  if (errorMsg.value) return `${verb.value}失败`
  if (done.value) return `${verb.value}完成`
  return '等待开始'
})
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h3>{{ headline }}</h3>
      <span class="chip" :class="running ? 'warn' : errorMsg ? 'err' : done ? 'ok' : ''">
        {{ STEPS.filter(s => steps[s.key].status === 'ok').length }}/{{ STEPS.length }}
      </span>
    </div>

    <div class="timeline">
      <div v-for="s in STEPS" :key="s.key" class="tl-item" :class="steps[s.key].status">
        <div class="tl-dot">{{ iconOf(steps[s.key]) }}</div>
        <div>
          <div class="tl-title">{{ s.title }}</div>
          <div v-if="steps[s.key].message" class="tl-msg">{{ steps[s.key].message }}</div>
        </div>
      </div>
    </div>

    <div v-if="errorMsg" class="alert err" style="margin-top:14px">
      <div>
        <div class="a-title">出错</div>
        <div class="a-desc">{{ errorMsg }}</div>
      </div>
    </div>

    <div style="display:flex; gap:8px; margin-top:14px">
      <button class="btn primary" :disabled="running" @click="start">{{ running ? '进行中…' : `再${verb}一次` }}</button>
      <slot name="extra" />
    </div>
  </div>
</template>
