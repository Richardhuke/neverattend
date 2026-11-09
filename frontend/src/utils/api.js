const BASE = './api'

async function request (path, { method = 'POST', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
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
  status: (username, token) => request(`/attendance/status?username=${encodeURIComponent(username)}&token=${encodeURIComponent(token)}`, { method: 'GET' }),
  alreadySigns: (username, token) => request('/alreadySigns', { body: { username, token } }),
  inWindow: (username, token) => request('/inCheckinWindow', { body: { username, token } }),
  watchState: (since = 0) => request(`/watch/state?since=${since}`, { method: 'GET' }),
  watchStart: (intervalMs, autoCheckin) => request('/watch/start', { body: { intervalMs, autoCheckin } }),
  watchStop: () => request('/watch/stop', { body: {} }),
  watchPoll: () => request('/watch/poll', { body: {} }),
  setCoords: (username, { mode = 'custom', longitude, latitude, jitter } = {}) =>
    request('/coords', { body: { username, mode, longitude, latitude, jitter } })
}
