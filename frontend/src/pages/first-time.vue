<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import Tabs from '../components/Tabs.vue'
import { api } from '../utils/api.js'
import { encode } from '../utils/codec.js'
import { useUserStore } from '../stores/user.js'

const router = useRouter()
const user = useUserStore()

const tab = ref('password')
const tabs = [
  { value: 'password', label: 'Username & Password', icon: '◍' },
  { value: 'token', label: 'Token', icon: '⌘' }
]

const form = reactive({ username: '', password: '' })
const raw = ref('')
const busy = ref(false)
const err = ref('')
const me = ref(null)

const CAS_URL = 'https://zjuam.zju.edu.cn/cas/login?service=http://www.tyys.zju.edu.cn/ggtypt/dologin'
const TOKEN_RE = /window\.app\.getUserName\(\s*['"](\d{6,})['"]\s*,\s*['"]([^'"]+)['"]\s*\)/

async function submitPassword () {
  err.value = ''
  if (!form.username.trim() || !form.password) { err.value = '学号与密码必填'; return }
  busy.value = true
  try {
    const enc = await encode(form.password)
    const data = await api.getToken(form.username.trim(), enc)
    // ptm 模式：网页端是 JSP 会话（cookie），没有 JWT，不需要也不能再拿 token 去校验
    const info = data.mode === 'ptm'
      ? { xh: data.username, xm: '', xymc: '', token: data.token, mode: 'ptm' }
      : await api.verifyToken(data.username, data.token)
    await user.savePassword(form.password)
    user.setCredentials(info.xh || data.username, info.token)
    me.value = info
  } catch (e) {
    err.value = e.message || String(e)
  } finally {
    busy.value = false
  }
}

async function submitToken () {
  err.value = ''
  const text = String(raw.value || '').trim()
  if (text.length < 20) { err.value = '请粘贴登录成功后的整页源码（Ctrl+U → Ctrl+A → Ctrl+C）'; return }
  busy.value = true
  try {
    // 先交给后端解析（正则更宽容，能兜住各种页面结构），失败再退回本地正则
    let xh = ''
    let token = ''
    try {
      const hit = await api.parseToken(text)
      xh = hit.xh
      token = hit.token
    } catch (e) {
      const m = text.match(TOKEN_RE)
      if (!m) throw e
      xh = m[1]
      token = m[2]
    }
    if (!xh) throw new Error('源码里没有学号，无法绑定')
    const info = await api.verifyToken(xh, token)
    user.setCredentials(info.xh || xh, info.token)
    me.value = info
  } catch (e) {
    err.value = e.message || String(e)
  } finally {
    busy.value = false
  }
}

function goHome () { router.push('/') }

onMounted(async () => {
  if (user.hasPassword) form.password = await user.loadPassword()
  if (user.username) form.username = user.username
})
</script>

<template>
  <section>
    <div class="page-head">
      <h2>First Time Setup</h2>
    </div>

    <div v-if="me" class="card">
      <div class="card-head"><h3>接入成功</h3><span class="chip ok">{{ me.xh }}</span></div>
      <div class="rows">
        <div class="row"><span class="k">学号</span><span class="v mono">{{ me.xh }}</span></div>
        <div class="row"><span class="k">姓名</span><span class="v">{{ me.xm || '—' }}</span></div>
        <div class="row"><span class="k">学院</span><span class="v">{{ me.xymc || '—' }}</span></div>
        <div class="row"><span class="k">Token</span><span class="v mono small">{{ me.token }}</span></div>
      </div>
      <p class="hint">凭据只保存在本机浏览器（密码经 AES 混淆），可随时在 Manage 页清除。</p>
      <button class="btn primary block" @click="goHome">进入 Run</button>
    </div>

    <div v-else class="card">
      <p class="muted small" style="margin-top:0">
        Welcome to NeverAttend. 接入浙大体艺前需要先绑定一次凭据：账密由后端走 ZJUAM CAS 换成 JWT，或自己登录后把页面源码贴回来。
      </p>

      <Tabs v-model="tab" :items="tabs" />

      <div v-if="err" class="alert err">
        <div><div class="a-title">失败</div><div class="a-desc">{{ err }}</div></div>
      </div>

      <!-- 账密 -->
      <div v-show="tab === 'password'">
        <p class="hint" style="margin-top:0">
          账密会发送到后端，用于向 ZJUAM 换取浙体艺 JWT；后端不落库，密码在本机以 AES 密文保存，仅用于续期。
        </p>

        <div class="field">
          <label class="label">ZJU Username（学号）</label>
          <input v-model="form.username" class="input" placeholder="3240109999" autocomplete="username" :disabled="busy" />
        </div>
        <div class="field">
          <label class="label">Password</label>
          <input v-model="form.password" type="password" class="input" placeholder="your_passw0rd" autocomplete="current-password" :disabled="busy" />
        </div>

        <button class="btn primary block" :disabled="busy" @click="submitPassword">
          {{ busy ? '登录中…' : '登录并绑定' }}
        </button>
      </div>

      <!-- Token -->
      <div v-show="tab === 'token'">
        <p class="hint" style="margin-top:0">
          1. 在新标签页打开下面这个 CAS 链接，用统一身份认证登录；<br />
          2. 登录完成后会停在一个空白页；<br />
          3. 右键「查看网页源代码」，把整份 HTML 粘到下面，前端会抽出学号与 JWT。
        </p>

        <p style="margin:0 0 14px">
          <a :href="CAS_URL" target="_blank" rel="noopener" class="mono small">{{ CAS_URL }}</a>
        </p>

        <div class="field">
          <label class="label">页面源码</label>
          <textarea v-model="raw" class="textarea" rows="8" placeholder="<html>… window.app.getUserName('3240109999', 'eyJ…') …</html>" :disabled="busy"></textarea>
        </div>

        <button class="btn primary block" :disabled="busy" @click="submitToken">
          {{ busy ? '校验中…' : '提取并绑定' }}
        </button>
      </div>
    </div>
  </section>
</template>
