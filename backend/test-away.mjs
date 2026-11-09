const B = 'http://localhost:8000/api'
const post = async (p, body) => {
  const r = await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const t = await r.text(); let j = null
  try { j = JSON.parse(t) } catch { j = { raw: t } }
  return { status: r.status, j }
}
const stream = async (body) => {
  const r = await fetch(B + '/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const ct = r.headers.get('content-type'); const reader = r.body.getReader(); const dec = new TextDecoder()
  let buf = ''; const evs = []
  while (true) {
    const { value, done } = await reader.read(); if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n'); buf = lines.pop()
    for (const l of lines) if (l.startsWith('data: ')) evs.push(JSON.parse(l.slice(6)))
  }
  return { status: r.status, ct, evs }
}

const U = '32401' + String(Date.now()).slice(-6)
const { j: tok } = await post('/getToken', { username: U, password: 'x' })
console.log('1 getToken', tok.username, tok.token.slice(0, 12) + '…')
const st = await (await fetch(`${B}/attendance/status?username=${U}&token=${tok.token}`)).json()
console.log('2 status', st.courses.length, 'courses', st.sessions.length, 'sessions, open=', st.openCount, 'signed=', st.signedCount, 'signOutOpen=', st.signOutOpenCount)
console.log('  sessions:', st.sessions.map(s => `${s.id.split('-').pop()}:${s.status}/${s.signOutStatus}`).join(' '))

const co = await post('/coords', { username: U, longitude: 120.123456, latitude: 30.456789, jitter: 25 })
console.log('3 coords', co.status, JSON.stringify(co.j.coords))
const st2 = await (await fetch(`${B}/attendance/status?username=${U}&token=${tok.token}`)).json()
console.log('  coords echoed:', JSON.stringify(st2.coords))

const inRun = await stream({ username: U, token: tok.token, action: 'in', longitude: 120.123456, latitude: 30.456789, jitter: 25, away: true })
console.log('4 signin SSE', inRun.status, inRun.ct, inRun.evs.length, 'frames')
for (const e of inRun.evs) console.log('   ', e.type, e.step, '|', e.message)
const doneIn = inRun.evs.at(-1)
console.log('  done:', JSON.stringify(doneIn?.data))

const st3 = await (await fetch(`${B}/attendance/status?username=${U}&token=${tok.token}`)).json()
const outSess = st3.sessions.find(s => s.signOutStatus === 'open')
console.log('5 signout target', outSess?.id)
const outRun = await stream({ username: U, token: tok.token, action: 'out', sessionId: outSess?.id })
console.log('6 signout SSE', outRun.status, outRun.evs.length, 'frames')
for (const e of outRun.evs) console.log('   ', e.type, e.step, '|', e.message)
console.log('  done:', JSON.stringify(outRun.evs.at(-1)?.data))
const st4 = await (await fetch(`${B}/attendance/status?username=${U}&token=${tok.token}`)).json()
console.log('7 after:', st4.sessions.map(s => `${s.id.split('-').pop()}:${s.status}/${s.signOutStatus}`).join(' '), 'signOutDone=', st4.signOutDoneCount)
