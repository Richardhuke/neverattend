<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Tabs from '../components/Tabs.vue'
import RunningStatus from '../components/RunningStatus.vue'
import { api } from '../utils/api.js'
import { useUserStore } from '../stores/user.js'

const router = useRouter()
const user = useUserStore()

const tab = ref('sessions')
const tabs = [
  { value: 'sessions', label: '考勤场次', icon: '☰' },
  { value: 'checkin', label: '立即签到', icon: '✎' },
  { value: 'auto', label: '自动签到', icon: '⟳' }
]

const loading = ref(false)
const err = ref('')
const courses = ref([])
const sessions = ref([])
const signedCount = ref(0)
const selected = ref('')
const code = ref('')
const autoCode = ref(false)
const ignorePrejudgement = ref(false)
const runKey = ref(0)
const runMode = ref(false)
const runAction = ref('in')

// 异地模式：自定义坐标 + 抖动半径，服务端只比对坐标，守护进程会复用该坐标
const awayMode = ref(false)
const lng = ref(120.089136)
const lat = ref(30.302331)
const jitter = ref(30)
const geo = ref({ venue: { name: '紫金港校区西区体育馆', longitude: 120.089136, latitude: 30.302331 }, jitterMeters: 30 })
const coordsSaving = ref(false)

const watchState = ref({ running: false, intervalMs: 10000, polls: 0, checkins: 0, signouts: 0, lastPollAt: null, nextPollAt: null, lastError: null })
const events = ref([])
const intervalSec = ref(10)
const mode = ref('mock')
let timer = null

const openSessions = computed(() => sessions.value.filter(s => s.status === 'open'))
const selectedSession = computed(() => sessions.value.find(s => s.id === selected.value) || null)
const canSubmit = computed(() => !!selected.value || openSessions.value.length > 0)

const statusText = { open: '待签到', signed: '已签到', closed: '未开始', absent: '缺勤' }
const statusClass = { open: 'ok', signed: '', closed: '', absent: 'err' }
const typeText = { location: '定位', qr: '扫码', code: '口令' }

function fmt (v) {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function loadStatus () {
  if (user.isFirstTime) return
  loading.value = true
  err.value = ''
  try {
    const data = await api.status(user.username, user.token)
    courses.value = data.courses || []
    // 待签到置顶，其余按开始时间正序
    sessions.value = (data.sessions || []).slice().sort((a, b) => {
      const ao = a.status === 'open' ? 0 : 1
      const bo = b.status === 'open' ? 0 : 1
      if (ao !== bo) return ao - bo
      return new Date(a.startAt) - new Date(b.startAt)
    })
    signedCount.value = data.signedCount || 0
    if (data.geo) geo.value = data.geo
    if (data.coords && data.coords.mode === 'custom') {
      awayMode.value = true
      lng.value = data.coords.longitude
      lat.value = data.coords.latitude
      jitter.value = data.coords.jitter ?? geo.value.jitterMeters
    }
    if (!selected.value) selected.value = openSessions.value[0]?.id || sessions.value.find(s => s.status === 'open')?.id || ''
  } catch (e) {
    err.value = e.message || String(e)
  } finally {
    loading.value = false
  }
}

async function loadWatch () {
  try {
    const s = await api.watchState(0)
    watchState.value = s
    events.value = (s.events || []).slice().reverse()
    intervalSec.value = Math.round((s.intervalMs || 10000) / 1000)
  } catch { /* 守护未启动时忽略 */ }
}

async function loadConfig () {
  try { mode.value = (await api.config()).mode } catch { /* ignore */ }
}

async function toggleWatch () {
  if (watchState.value.running) await api.watchStop()
  else await api.watchStart(intervalSec.value * 1000, true)
  await loadWatch()
}

async function pollOnce () {
  await api.watchPoll()
  await loadWatch()
  await loadStatus()
}

function startRun (action = 'in') {
  if (!canSubmit.value) return
  runAction.value = action
  runMode.value = true
  runKey.value += 1
  tab.value = 'checkin'
}

function useVenue () {
  lng.value = geo.value?.venue?.longitude ?? 120.089136
  lat.value = geo.value?.venue?.latitude ?? 30.302331
}

async function saveCoords () {
  coordsSaving.value = true
  try {
    await api.setCoords(user.username, awayMode.value
      ? { mode: 'custom', longitude: Number(lng.value), latitude: Number(lat.value), jitter: Number(jitter.value) }
      : { mode: 'venue' })
    await loadStatus()
  } catch (e) {
    err.value = e.message || String(e)
  } finally {
    coordsSaving.value = false
  }
}

async function afterRun () {
  await loadStatus()
  await loadWatch()
}

onMounted(async () => {
  if (user.isFirstTime) { router.push('/first-time'); return }
  await Promise.all([loadConfig(), loadStatus(), loadWatch()])
  timer = setInterval(loadWatch, 3000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <section>
    <div class="page-head">
      <h2>Now let's attend</h2>
      <div style="display:flex; align-items:center; gap:8px">
        <span class="chip" :class="mode === 'mock' ? 'warn' : 'ok'">{{ mode === 'mock' ? 'MOCK 模式' : '线上模式' }}</span>
        <button class="btn sm" :disabled="loading" @click="loadStatus">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
    </div>

    <div v-if="mode === 'mock'" class="alert warn" style="border-color:#b45309">
      <div>
        <div class="a-title">当前是演示数据（MOCK），不是你的真实课表</div>
        <div class="a-desc">
          下面所有场次都是按<strong>当前时间现场生成的假数据</strong>：永远有一条「待签到」，第 5 周永远在「签退中」。
          它们与浙大体艺毫无关系，不会真的提交任何签到。要看你自己的考勤，需要用自托管后端并设 <code>TYYS_MOCK=0</code>。
        </div>
      </div>
    </div>

    <p v-if="signedCount > 0" class="muted small" style="margin:-6px 0 14px">
      You have signed <strong>{{ signedCount }}</strong> times this term.
    </p>

    <div v-if="watchState.running" class="alert ok">
      <div>
        <div class="a-title">自动签到 / 签退守护中</div>
        <div class="a-desc">
          每 {{ intervalSec }} 秒轮询一次 · 已轮询 {{ watchState.polls }} 次 · 自动签到 {{ watchState.checkins }} 次 · 自动签退 {{ watchState.signouts || 0 }} 次 ·
          下次 {{ fmt(watchState.nextPollAt) }}
        </div>
      </div>
    </div>
    <div v-else class="alert warn">
      <div>
        <div class="a-title">自动签到未运行</div>
        <div class="a-desc">到「自动签到」页启动守护，10 秒一次扫描场次，发现待签到 / 老师已开签退就自动提交。</div>
      </div>
    </div>

    <div v-if="err" class="alert err">
      <div><div class="a-title">接口异常</div><div class="a-desc">{{ err }}</div></div>
    </div>

    <div class="card">
      <Tabs v-model="tab" :items="tabs" />

      <!-- 场次 -->
      <div v-show="tab === 'sessions'" class="tab-panel">
        <div v-if="!sessions.length" class="muted small">暂无场次。点右上「刷新」重试。</div>
        <div
          v-for="s in sessions"
          :key="s.id"
          class="session"
          :class="{ open: s.status === 'open' }"
        >
          <div class="s-main">
            <div class="s-title">{{ s.title }}</div>
            <div class="s-meta">
              {{ s.courseName }} · {{ typeText[s.type] || s.type }} · {{ fmt(s.startAt) }} ~ {{ fmt(s.endAt) }}
              <span v-if="s.signedAt"> · 签到于 {{ fmt(s.signedAt) }}</span>
              <span v-if="s.signedOutAt"> · 签退于 {{ fmt(s.signedOutAt) }}</span>
            </div>
          </div>
          <span class="chip" :class="statusClass[s.status]">{{ statusText[s.status] || s.status }}</span>
          <span v-if="s.signOutStatus === 'open'" class="chip ok">签退中</span>
          <span v-else-if="s.signOutStatus === 'done'" class="chip">已签退</span>
          <button
            v-if="s.status === 'open'"
            class="btn sm primary"
            @click="selected = s.id; startRun('in')"
          >签到</button>
          <button
            v-if="s.signOutStatus === 'open'"
            class="btn sm"
            @click="selected = s.id; startRun('out')"
          >签退</button>
        </div>
      </div>

      <!-- 立即签到 -->
      <div v-show="tab === 'checkin'" class="tab-panel">
        <RunningStatus
          v-if="runMode"
          :key="runKey"
          :username="user.username"
          :token="user.token"
          :session-id="selected"
          :action="runAction"
          :code="code"
          :auto-code="autoCode"
          :longitude="awayMode ? Number(lng) : null"
          :latitude="awayMode ? Number(lat) : null"
          :jitter="awayMode ? Number(jitter) : null"
          :away="awayMode"
          :ignore-prejudgement="ignorePrejudgement"
          @done="afterRun"
        />
        <template v-else>
          <p class="muted small" style="margin-top:0">选择场次与动作；异地模式会用你填的坐标代替场馆点位。</p>

          <div class="field">
            <label class="label">动作</label>
            <select v-model="runAction" class="select">
              <option value="in">签到</option>
              <option value="out">签退（老师已开启签退时）</option>
            </select>
          </div>

          <div class="field">
            <label class="label">场次</label>
            <select v-model="selected" class="select">
              <option value="">（自动选当前开放场次）</option>
              <option v-for="s in sessions" :key="s.id" :value="s.id">
                {{ s.title }} · {{ statusText[s.status] }} · {{ fmt(s.startAt) }}
              </option>
            </select>
          </div>

          <div class="field">
            <label class="switch">
              <input v-model="awayMode" type="checkbox" @change="saveCoords" />
              <span>异地模式<span class="hint">不在场馆也能签：坐标由你指定，每次自动 ±{{ jitter }}m 抖动</span></span>
            </label>
          </div>
          <template v-if="awayMode">
            <div style="display:flex; gap:8px">
              <div class="field" style="flex:1">
                <label class="label">经度</label>
                <input v-model.number="lng" class="input mono" type="number" step="0.000001" />
              </div>
              <div class="field" style="flex:1">
                <label class="label">纬度</label>
                <input v-model.number="lat" class="input mono" type="number" step="0.000001" />
              </div>
              <div class="field" style="width:110px">
                <label class="label">抖动 (m)</label>
                <input v-model.number="jitter" class="input mono" type="number" min="0" max="200" />
              </div>
            </div>
            <div style="display:flex; gap:8px; margin:-4px 0 12px">
              <button class="btn sm" @click="useVenue">用场馆坐标</button>
              <button class="btn sm" :disabled="coordsSaving" @click="saveCoords">{{ coordsSaving ? '保存中…' : '保存坐标' }}</button>
              <span class="muted small" style="align-self:center">
                场馆 {{ geo.venue?.name }} · {{ geo.venue?.longitude }}, {{ geo.venue?.latitude }}
              </span>
            </div>
          </template>

          <div class="field">
            <label class="label">口令（仅口令签到需要）</label>
            <input v-model="code" class="input" placeholder="4 位口令，留空则按 autoCode 处理" />
          </div>

          <div class="field">
            <label class="switch">
              <input v-model="autoCode" type="checkbox" />
              <span>自动尝试口令（autoCode）<span class="hint">口令签到场次下按 codeLen 枚举；可能触发风控</span></span>
            </label>
          </div>
          <div class="field">
            <label class="switch">
              <input v-model="ignorePrejudgement" type="checkbox" />
              <span>忽略预判失败<span class="hint">预判不通过（重复 / 超窗 / 缺坐标）仍继续提交</span></span>
            </label>
          </div>

          <button class="btn primary block" :disabled="!canSubmit || loading" @click="startRun">
            {{ runAction === 'out' ? '开始签退' : '开始签到' }}
          </button>
        </template>
      </div>

      <!-- 自动签到 -->
      <div v-show="tab === 'auto'" class="tab-panel">
        <div class="stat-grid" style="margin-bottom:14px">
          <div class="stat"><div class="s-k">状态</div><div class="s-v">{{ watchState.running ? 'RUNNING' : 'STOPPED' }}</div></div>
          <div class="stat"><div class="s-k">轮询间隔</div><div class="s-v">{{ intervalSec }}s</div></div>
          <div class="stat"><div class="s-k">轮询次数</div><div class="s-v">{{ watchState.polls }}</div></div>
          <div class="stat"><div class="s-k">自动签到</div><div class="s-v">{{ watchState.checkins }}</div></div>
          <div class="stat"><div class="s-k">自动签退</div><div class="s-v">{{ watchState.signouts || 0 }}</div></div>
        </div>

        <div class="row"><span class="k">上次轮询</span><span class="v mono">{{ fmt(watchState.lastPollAt) }}</span></div>
        <div class="row"><span class="k">下次轮询</span><span class="v mono">{{ fmt(watchState.nextPollAt) }}</span></div>
        <div class="row" v-if="watchState.lastError"><span class="k">最近错误</span><span class="v" style="color:var(--err)">{{ watchState.lastError }}</span></div>

        <div style="display:flex; gap:8px; align-items:flex-end; margin:14px 0">
          <div class="field" style="margin:0; width:150px">
            <label class="label">间隔（秒）</label>
            <input v-model.number="intervalSec" type="number" min="2" step="1" class="input" />
          </div>
          <button class="btn primary" @click="toggleWatch">{{ watchState.running ? '停止守护' : '启动守护' }}</button>
          <button class="btn" @click="pollOnce">立即轮询一次</button>
        </div>

        <div class="card-head" style="margin-top:18px"><h3>事件流</h3><span class="chip">{{ events.length }}</span></div>
        <div class="log">
          <div v-for="e in events" :key="e.id" class="log-line">
            <span class="log-time">{{ fmt(e.at) }}</span>
            <span class="log-lv" :class="e.level">{{ e.level }}</span>
            <span>[{{ e.step }}] {{ e.message }}</span>
          </div>
          <div v-if="!events.length" class="muted small">暂无事件。</div>
        </div>
      </div>
    </div>
  </section>
</template>
