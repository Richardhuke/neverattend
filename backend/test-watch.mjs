const B = 'http://localhost:8000/api'
const post = async (p, body) => (await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()
const get = async p => (await fetch(B + p)).json()
const sleep = ms => new Promise(r => setTimeout(r, ms))

await post('/watch/stop', {})
const U = '32401' + String(Date.now()).slice(-6)
const tok = await post('/getToken', { username: U, password: 'x' })
await post('/coords', { username: U, longitude: 120.0895, latitude: 30.3025, jitter: 30 })
const before = (await get('/watch/state?since=0')).events || []
await post('/watch/start', { intervalMs: 5000, autoCheckin: true })
await sleep(16000)
const st = await get('/watch/state?since=0')
console.log('user', U)
console.log('polls', st.polls, 'checkins', st.checkins, 'signouts', st.signouts ?? '(missing)')
const mine = (st.events || []).filter(e => e.message.includes(U) || e.message.includes('第 1 周') || e.message.includes('第 5 周') || e.step === 'checkin' || e.step === 'signout')
for (const e of mine.slice(-8)) console.log(' ', e.level, `[${e.step}]`, e.message)
const s = await get(`/attendance/status?username=${U}&token=${tok.token}`)
console.log('after:', s.sessions.map(x => `${x.id.split('-').pop()}:${x.status}/${x.signOutStatus}`).join(' '))
const pid = process.pid
