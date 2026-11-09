/**
 * GitHub Pages 演示模式：把 ./api/* 全流程拦在浏览器里跑。
 * 只用于静态托管预览（没有后端进程），行为对齐 backend/src/services/{tyys,pipeline}.js：
 * 同一套 8 步文案、同一套场次结构、同一套模拟抖动坐标。
 */

const VENUE = { name: '紫金港校区西区体育馆', longitude: 120.089136, latitude: 30.302331 }
const GEO = { venue: VENUE, jitterMeters: 30 }

const now = () => Date.now()
const iso = (t) => new Date(t).toISOString()
const min = (n) => n * 60_000

const course = {
  id: 'szt-2026-autumn-01',
  name: '身体素质课（篮球）',
  teacher: '王建国',
  department: '公共体育与艺术部',
  term: '2026-2027 秋冬',
  location: '紫金港校区西区体育馆 3 号场'
}

const state = {
  user: null,
  coords: null,
  sessions: [],
  events: [],
  watch: { running: false, intervalMs: 10000, polls: 0, checkins: 0, signouts: 0, timer: null, lastPollAt: null }
}

function baseSessions () {
  const t = now()
  const mk = (week, offsetMin, endMin, status, type, extra = {}) => ({
    id: `att-demo-${week}`,
    courseId: course.id,
    courseName: course.name,
    type,
    title: `第 ${week} 周 身体素质课考勤`,
    startAt: iso(t + min(offsetMin)),
    endAt: iso(t + min(endMin)),
    status,
    signedAt: status === 'signed' ? iso(t + min(offsetMin) + min(2)) : null,
    place: course.location,
    radius: 500,
    codeLen: 4,
    signOutEnabled: false,
    signOutStartAt: null,
    signOutEndAt: null,
    signOutStatus: 'none',
    signedOutAt: null,
    ...extra
  })
  return [
    mk(1, -3, 17, 'open', 'qr'),
    mk(2, 42, 62, 'closed', 'code'),
    mk(3, 3 * 1440, 3 * 1440 + 20, 'closed', 'location'),
    mk(4, -1440, -1420, 'signed', 'qr', { signedAt: iso(t - min(1438)) }),
    mk(5, -50, -30, 'signed', 'code', {
      signedAt: iso(t - min(45)),
      signOutEnabled: true,
      signOutStartAt: iso(t - min(10)),
      signOutEndAt: iso(t + min(8)),
      signOutStatus: 'open'
    })
  ]
}

const push = (level, step, message) => {
  state.events.unshift({ at: new Date().toISOString(), level, step, message })
  if (state.events.length > 200) state.events.pop()
}

const jitter = (lon, lat, meters) => {
  const r = meters * Math.sqrt(Math.random())
  const th = Math.random() * Math.PI * 2
  const dLat = (r * Math.cos(th)) / 111320
  const dLon = (r * Math.sin(th)) / (111320 * Math.cos((lat * Math.PI) / 180))
  return { longitude: Number((lon + dLon).toFixed(6)), latitude: Number((lat + dLat).toFixed(6)) }
}

const dist = (a, b) => {
  const R = 6371000
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.latitude * Math.PI) / 180) * Math.cos((b.latitude * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)))
}

const fmt = (t) => {
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const pick = (sessions, { sessionId, action }) =>
  sessions.find((s) => s.id === sessionId) ||
  sessions.find((s) => (action === 'out' ? s.signOutStatus === 'open' : s.status === 'open')) ||
  sessions.find((s) => s.status === 'open') ||
  sessions[0]

/** 8 步流水线，和 backend/src/services/pipeline.js 的 STEPS 一一对应 */
function* pipeline (body) {
  const action = body.action === 'out' ? 'out' : 'in'
  const verb = action === 'out' ? '签退' : '签到'
  const session = pick(state.sessions, { sessionId: body.sessionId, action })

  yield ['info', 'auth', `正在认证浙体艺 JWT ...`]
  yield ['success', 'auth', `已认证：演示账号（${body.username}）`]
  yield ['info', 'course', '拉取身体素质课教学班 ...']
  yield ['success', 'course', `${course.name} · ${course.teacher} · ${course.term}`]
  if (!session) {
    yield ['error', 'session', `没有可${verb}的场次`]
    return { ok: false, error: `没有可${verb}的场次` }
  }
  yield ['info', 'session', `拉取考勤场次 ...`]
  yield ['success', 'session', `${session.title}（${session.id}）`]

  yield ['info', 'term', `校验学期与${verb}时间窗 ...`]
  const from = action === 'out' ? session.signOutStartAt : session.startAt
  const to = action === 'out' ? session.signOutEndAt : session.endAt
  const inWindow = now() >= Date.parse(from) && now() <= Date.parse(to)
  yield ['success', 'term', `${course.term} · ${verb}窗口 ${fmt(from)} ~ ${fmt(to)}（${inWindow ? '在窗口内' : '不在窗口内'}）`]

  const custom = state.coords?.mode === 'custom' ? state.coords : null
  const coords = custom ? jitter(custom.longitude, custom.latitude, custom.jitter ?? GEO.jitterMeters) : null
  const away = coords ? dist(coords, VENUE) : null
  yield ['info', 'locate', `解析${verb}目标 ...`]
  yield ['success', 'locate',
    `${verb}方式：${{ qr: '扫码', code: '口令', location: '定位' }[session.type] || session.type}` +
    (coords ? ` · 坐标 ${coords.longitude},${coords.latitude}（距场馆约 ${away} m）` : '') +
    (body.away ? ' · 异地模式（跳过距离预判）' : '')]

  yield ['info', 'prejudge', `预判：重复${verb} / 时间窗 / 距离 ...`]
  const problems = []
  if (!inWindow) problems.push(`不在${verb}窗口内`)
  if (action === 'out') {
    if (!session.signOutEnabled) problems.push('老师未开启签退')
    if (session.signOutStatus === 'done') problems.push('已经签退过了')
    if (session.status !== 'signed') problems.push('尚未签到，无法签退')
  } else if (session.status === 'signed') {
    problems.push('已经签到过了')
  }
  if (!body.away && away != null && session.radius && away > session.radius) {
    problems.push(`距场馆 ${away} m，超出 ${session.radius} m（异地模式可跳过）`)
  }
  if (problems.length) {
    yield ['error', 'error', `预判未通过：${problems.join('；')}`]
    return { ok: false, error: `预判未通过：${problems.join('；')}`, action, session }
  }
  yield ['success', 'prejudge', '预判通过']

  yield ['info', 'submit', `提交${verb} ...`]
  if (action === 'out') {
    session.signOutStatus = 'done'
    session.signedOutAt = new Date().toISOString()
    state.watch.signouts += 0
  } else {
    session.status = 'signed'
    session.signedAt = new Date().toISOString()
  }
  yield ['success', 'submit', `服务端已受理 · ${fmt(Date.now())}`]

  yield ['info', 'verify', '回查考勤状态 ...']
  yield ['success', 'verify', `复核通过 · ${session.title} 已${verb}`]
  return { ok: true, action, session, coords, away }
}

function sse (body) {
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    async start (ctrl) {
      const gen = pipeline(body)
      let last = null
      for (;;) {
        const { value, done } = gen.next()
        if (done) { last = value; break }
        const [type, step, message] = value
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ type, step, message })}\n\n`))
        await new Promise((r) => setTimeout(r, 260))
      }
      const verb = body.action === 'out' ? '签退' : '签到'
      const frame = last?.ok
        ? { type: 'done', step: 'verify', message: '已完成', data: { ok: true, action: last.action, sessionId: last.session?.id, awayMeters: last.away } }
        : { type: 'done', step: last ? 'error' : 'done', message: last?.error ? '已结束' : `${verb}失败`, data: { ok: false, error: last?.error } }
      if (frame.data.ok) {
        const s = last.session
        push('success', body.action === 'out' ? 'signout' : 'checkin', `${verb}成功：${s.title}`)
      }
      ctrl.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`))
      ctrl.close()
    }
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } })

const statusBody = () => ({
  username: state.user,
  courses: [course],
  sessions: state.sessions,
  openCount: state.sessions.filter((s) => s.status === 'open').length,
  signedCount: state.sessions.filter((s) => s.status === 'signed').length,
  signOutOpenCount: state.sessions.filter((s) => s.signOutStatus === 'open').length,
  signOutDoneCount: state.sessions.filter((s) => s.signOutStatus === 'done').length,
  geo: GEO,
  coords: state.coords
})

function tick () {
  state.watch.polls += 1
  state.watch.lastPollAt = new Date().toISOString()
  const tasks = []
  for (const s of state.sessions) {
    if (s.status === 'open') tasks.push({ s, action: 'in' })
    else if (s.signOutStatus === 'open') tasks.push({ s, action: 'out' })
  }
  for (const { s, action } of tasks) {
    const verb = action === 'out' ? '签退' : '签到'
    push('info', 'poll', `发现待${verb}场次 ${s.title}，开始自动${verb}`)
    if (action === 'out') { s.signOutStatus = 'done'; s.signedOutAt = new Date().toISOString(); state.watch.signouts += 1 } else { s.status = 'signed'; s.signedAt = new Date().toISOString(); state.watch.checkins += 1 }
    push('success', action === 'out' ? 'signout' : 'checkin', `${verb}成功：${s.title}`)
  }
}

function handle (url, init) {
  const path = url.replace(/^.*?\/api/, '').split('?')[0]
  const qs = new URLSearchParams(url.split('?')[1] || '')
  const body = init?.body ? JSON.parse(init.body) : {}

  if (path === '/config') {
    return json({
      mode: 'mock',
      tyysBase: '(demo · 浏览器内模拟)',
      endpoints: {},
      demo: true,
      watch: { intervalMs: state.watch.intervalMs, autoCheckin: true },
      geo: GEO
    })
  }
  if (path === '/getToken') {
    if (!body.username) return json({ detail: '缺少学号' }, 400)
    state.user = String(body.username)
    state.sessions = baseSessions()
    push('info', 'auth', `[demo] 使用演示账号 ${state.user} 通过 ZJUAM 登录`)
    push('success', 'auth', `账号已接入：${state.user}`)
    return json({ username: state.user, token: `demo.${btoa(state.user)}.sig` })
  }
  if (path === '/verifyToken') {
    return json({ xh: body.username, xm: '演示用户', xymc: '公共体育与艺术部', token: body.token })
  }
  if (path === '/attendance/status') return json(statusBody())
  if (path === '/alreadySigns') return json({ count: state.sessions.filter((s) => s.status === 'signed').length })
  if (path === '/inCheckinWindow') return json({ inWindow: true })
  if (path === '/coords') {
    state.coords = body.mode === 'custom'
      ? { mode: 'custom', longitude: body.longitude, latitude: body.latitude, jitter: body.jitter, updatedAt: Date.now() }
      : null
    if (state.coords) push('info', 'geo', `异地模式已登记：${state.coords.longitude},${state.coords.latitude} ±${state.coords.jitter}m`)
    return json({ ok: true, coords: state.coords, geo: GEO })
  }
  if (path === '/checkin') return sse(body)
  if (path === '/watch/state') {
    const since = Number(qs.get('since') || 0)
    return json({
      running: state.watch.running,
      intervalMs: state.watch.intervalMs,
      autoCheckin: true,
      polls: state.watch.polls,
      checkins: state.watch.checkins,
      signouts: state.watch.signouts,
      lastPollAt: state.watch.lastPollAt,
      events: since ? state.events.slice(0, 40) : state.events.slice(0, 40)
    })
  }
  if (path === '/watch/start') {
    state.watch.intervalMs = Number(body.intervalMs) || state.watch.intervalMs
    if (!state.watch.running) {
      state.watch.running = true
      push('success', 'watch', `自动签到/签退已启动：每 ${Math.round(state.watch.intervalMs / 1000)} 秒轮询一次`)
      state.watch.timer = setInterval(tick, state.watch.intervalMs)
      tick()
    }
    return json({ ok: true, running: true, intervalMs: state.watch.intervalMs })
  }
  if (path === '/watch/stop') {
    state.watch.running = false
    if (state.watch.timer) clearInterval(state.watch.timer)
    state.watch.timer = null
    push('warn', 'watch', '自动签到/签退已停止')
    return json({ ok: true, running: false })
  }
  if (path === '/watch/poll') {
    tick()
    return json({ ok: true, polls: state.watch.polls, checkins: state.watch.checkins, signouts: state.watch.signouts })
  }
  return json({ detail: `demo 未实现：${path}` }, 404)
}

export function installDemo () {
  const realFetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? ''
    if (/\/api\//.test(url) || /^\.\/api\//.test(url)) {
      try { return Promise.resolve(handle(url, init)) } catch (e) { return Promise.reject(e) }
    }
    return realFetch(input, init)
  }
  state.sessions = baseSessions()
  push('info', 'boot', '[demo] 静态演示模式：所有接口在浏览器内模拟，不会访问浙大体艺')
}
