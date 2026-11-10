
// 后端地址可以在运行时指定：GitHub Pages 这种纯静态托管把地址填上就能连自建后端。
// 优先级：localStorage > 构建期 VITE_API_BASE > 同源 ./api
const KEY = 'neverattend-api-base'
// 后端设了 ACCESS_KEY 时，前端要带上同样的密钥才能调接口
const AKEY = 'neverattend-access-key'

// 也支持 ?api=https://backend 一次性带上（方便分享到手机直接打开）
function fromQuery () {
  try {
    const v = new URLSearchParams(location.search).get('api')
    return v ? v.trim().replace(/\/+$/, '') : ''
  } catch { return '' }
}

export function getApiBase () {
  const q = fromQuery()
  if (q) { setApiBase(q); return q }
  let v = ''
  try { v = localStorage.getItem(KEY) || '' } catch {}
  if (!v) v = import.meta.env.VITE_API_BASE || ''
  return String(v).trim().replace(/\/+$/, '')
}

export function getAccessKey () {
  try {
    const q = new URLSearchParams(location.search).get('key')
    if (q) { setAccessKey(q); return q }
  } catch {}
  try { return localStorage.getItem(AKEY) || '' } catch { return '' }
}

export function setAccessKey (key) {
  const v = String(key || '').trim()
  try { v ? localStorage.setItem(AKEY, v) : localStorage.removeItem(AKEY) } catch {}
}

export function setApiBase (url) {
  const v = String(url || '').trim().replace(/\/+$/, '')
  try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY) } catch {}
}

function base () {
  const b = getApiBase()
  return b ? b + '/api' : './api'
}

async function request (path, { method = 'POST', body } = {}) {
  const headers = {}
  if (body) headers['Content-Type'] = 'application/json'
  const akey = getAccessKey()
  if (akey) headers['X-Access-Key'] = akey
  const res = await fetch(base() + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (!res.ok) throw new Error(data?.detail || data?.msg || `请求失败 (${res.status})`)
  return data
}

export const api = {
  config: () => request('/config', { method: 'GET' }),
  getToken: (username, password) => request('/getToken', { body: { username, password } }),
  verifyToken: (username, token) => request('/verifyToken', { body: { username, token } }),
  parseToken: (text) => request('/parse-token', { body: { text } }),
  status: (username, token) => request(`/attendance/status?username=${encodeURIComponent(username)}&token=${encodeURIComponent(token)}`, { method: 'GET' }),
  alreadySigns: (username, token) => request('/alreadySigns', { body: { username, token } }),
  inWindow: (username, token) => request('/inCheckinWindow', { body: { username, token } }),
  watchState: (since = 0) => request(`/watch/state?since=${since}`, { method: 'GET' }),
  watchStart: (intervalMs, autoCheckin) => request('/watch/start', { body: { intervalMs, autoCheckin } }),
  watchStop: () => request('/watch/stop', { body: {} }),
  watchPoll: () => request('/watch/poll', { body: {} }),
  logout: (username) => request('/logout', { body: { username } }),
  setCoords: (username, { mode = 'custom', longitude, latitude, jitter } = {}) =>
    request('/coords', { body: { username, mode, longitude, latitude, jitter } })
}
