const BASE = 'http://localhost:8000'
const post = (p, body) => fetch(BASE + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
})
const { encodePassword } = await import('file:///C:/Users/Richa/Documents/deepseek-harness/default-workspace/neverattend/backend/src/services/zjuam.js')

const username = process.argv[2] || '3240100001'
const enc = encodePassword('demo_pass')

const tk = await post('/api/getToken', { username, password: enc })
const tkj = await tk.json()
console.log('getToken', tk.status, JSON.stringify(tkj).slice(0, 160))

const st = await fetch(`${BASE}/api/attendance/status?username=${tkj.username}&token=${tkj.token}`)
const stj = await st.json()
console.log('status', st.status, 'courses=', stj.courses?.length, 'sessions=', stj.sessions?.length, 'open=', stj.openCount, 'signed=', stj.signedCount)
console.log('first session', JSON.stringify(stj.sessions?.[0]))

const open = stj.sessions.find(s => s.status === 'open')
if (open) {
  const res = await post('/api/checkin', { username: tkj.username, token: tkj.token, sessionId: open.id })
  console.log('checkin HTTP', res.status, res.headers.get('content-type'))
  const text = await res.text()
  const frames = text.split('\n\n').filter(Boolean).map(b => b.replace(/^data: /, ''))
  console.log(`SSE frames (${frames.length}):`)
  for (const f of frames) console.log('  ', f)
}

const w = await (await fetch(`${BASE}/api/watch/state`)).json()
console.log('watch', JSON.stringify({ running: w.running, intervalMs: w.intervalMs, polls: w.polls, checkins: w.checkins }))
console.log('events tail', JSON.stringify(w.events.slice(-4), null, 0))
