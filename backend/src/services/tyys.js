import { config } from '../config.js'
import { tyysFetch } from './zjuam.js'
import { pushEvent } from '../store.js'

const IS_MOCK = () => config.tyys.mock
const EP = () => config.tyys.endpoints

/* session: { id, courseId, courseName, type, title, startAt, endAt, status, signedAt,
 *            place, radius, codeLen, signOutEnabled, signOutStartAt, signOutEndAt,
 *            signOutStatus: 'none'|'pending'|'open'|'done'|'missed', signedOutAt } */

function normCourse (raw) {
  return {
    id: String(raw.id ?? raw.course_id ?? raw.courseId ?? ''),
    name: raw.name ?? raw.course_name ?? raw.title ?? '身体素质课',
    teacher: raw.teacher ?? raw.teacher_name ?? raw.created_by_name ?? '',
    department: raw.department ?? raw.department_name ?? '',
    term: raw.term ?? raw.term_name ?? raw.semester ?? '',
    location: raw.location ?? raw.place ?? ''
  }
}

/** 签退窗口：真实字段名未知，做多别名兜底 + 时间窗推断 */
function normSignOut (raw) {
  const enabled = Boolean(
    raw.sign_out_enabled ?? raw.signOutEnabled ?? raw.signout_enabled ??
    raw.out_enabled ?? raw.sign_out_start_at ?? raw.signOutStartAt ?? raw.signout_start_at
  )
  const startAt = raw.sign_out_start_at ?? raw.signOutStartAt ?? raw.signout_start_at ?? raw.out_start_at ?? null
  const endAt = raw.sign_out_end_at ?? raw.signOutEndAt ?? raw.signout_end_at ?? raw.out_end_at ?? null
  const signedOutAt = raw.sign_out_time ?? raw.signed_out_at ?? raw.signOutTime ?? raw.signout_time ?? null
  const rawStatus = raw.sign_out_status ?? raw.signOutStatus ?? raw.signout_status ?? raw.out_status ?? null
  if (!enabled) {
    return { signOutEnabled: false, signOutStartAt: null, signOutEndAt: null, signOutStatus: 'none', signedOutAt: null }
  }
  let signOutStatus = 'pending'
  if (signedOutAt || rawStatus === 'signed' || rawStatus === 'done') signOutStatus = 'done'
  else if (rawStatus === 'open') signOutStatus = 'open'
  else if (rawStatus === 'missed' || rawStatus === 'absent') signOutStatus = 'missed'
  else if (startAt && endAt) {
    const now = Date.now()
    const s = new Date(startAt).getTime()
    const e = new Date(endAt).getTime()
    signOutStatus = now >= s - 5 * 60000 && now <= e ? 'open' : (now > e ? 'missed' : 'pending')
  }
  return { signOutEnabled: true, signOutStartAt: startAt, signOutEndAt: endAt, signOutStatus, signedOutAt }
}

function normSession (raw, course) {
  const startAt = raw.start_at ?? raw.startAt ?? raw.begin_time ?? raw.start_time ?? null
  const endAt = raw.end_at ?? raw.endAt ?? raw.end_time ?? raw.deadline ?? null
  const status = raw.status ?? raw.attendance_status ?? raw.state ?? 'closed'
  return {
    id: String(raw.id ?? raw.attendance_id ?? raw.session_id ?? ''),
    courseId: String(raw.course_id ?? course?.id ?? ''),
    courseName: raw.course_name ?? course?.name ?? '身体素质课',
    type: raw.type ?? raw.sign_type ?? 'location',
    title: raw.title ?? raw.name ?? '身体素质课考勤',
    startAt,
    endAt,
    status: ['open', 'closed', 'signed', 'absent'].includes(status) ? status : 'closed',
    signedAt: raw.signed_at ?? raw.sign_time ?? null,
    place: raw.place ?? raw.location ?? course?.location ?? '',
    radius: Number(raw.radius ?? raw.distance ?? 500),
    codeLen: Number(raw.code_len ?? raw.codeLen ?? 4),
    ...normSignOut(raw)
  }
}

/* ---------------------------- 真实模式 ---------------------------- */

export async function realCourses (token) {
  const data = await tyysFetch(token, EP().courseList, { method: 'GET' })
  const list = data?.data ?? data?.list ?? data?.courses ?? (Array.isArray(data) ? data : [])
  return list.map(normCourse).filter(c => c.id)
}

export async function realSessions (token, course) {
  const data = await tyysFetch(token, EP().attendanceList, {
    method: 'GET',
    query: course?.id ? { course_id: course.id } : undefined
  })
  const list = data?.data ?? data?.list ?? data?.attendances ?? (Array.isArray(data) ? data : [])
  return list.map(s => normSession(s, course)).filter(s => s.id)
}

function basePayload (session, opts = {}) {
  return {
    attendance_id: session.id,
    course_id: session.courseId,
    ...(opts.longitude !== undefined ? { longitude: opts.longitude, latitude: opts.latitude } : {}),
    ...(opts.code ? { code: opts.code } : {})
  }
}

export async function realCheckin (token, session, opts = {}) {
  const target = EP()
  const payload = basePayload(session, opts)
  if (session.type === 'qr') return tyysFetch(token, target.attendanceSignQr, { method: 'POST', body: payload })
  if (session.type === 'code') return tyysFetch(token, target.attendanceSignCode, { method: 'POST', body: payload })
  let point = null
  try {
    point = await tyysFetch(token, target.attendanceLocation, { method: 'POST', body: { attendance_id: session.id } })
  } catch { /* 有些场次不返回点位，交给 sign 判定 */ }
  const geo = point?.data ?? point ?? {}
  return tyysFetch(token, target.attendanceSign, {
    method: 'POST',
    body: {
      ...basePayload(session, {
        ...opts,
        longitude: opts.longitude ?? geo.longitude ?? geo.lng,
        latitude: opts.latitude ?? geo.latitude ?? geo.lat
      }),
      place: session.place
    }
  })
}

export async function realSignOut (token, session, opts = {}) {
  const target = EP()
  const payload = basePayload(session, opts)
  if (session.type === 'qr') return tyysFetch(token, target.attendanceSignOutQr, { method: 'POST', body: payload })
  if (session.type === 'code') return tyysFetch(token, target.attendanceSignOutCode, { method: 'POST', body: payload })
  let point = null
  try {
    point = await tyysFetch(token, target.attendanceSignOutLocation, { method: 'POST', body: { attendance_id: session.id } })
  } catch { /* 复用签到点位 */ }
  const geo = point?.data ?? point ?? {}
  return tyysFetch(token, target.attendanceSignOut, {
    method: 'POST',
    body: {
      ...basePayload(session, {
        ...opts,
        longitude: opts.longitude ?? geo.longitude ?? geo.lng,
        latitude: opts.latitude ?? geo.latitude ?? geo.lat
      }),
      place: session.place
    }
  })
}

/* ----------------------------- Mock 模式 ----------------------------- */
/* 一个学期的身体素质课：1 个当前开放签到 + 1 个已签到且签退窗口开放，
 * 每 90 秒推进一次，便于观察 10s 轮询 → 自动签到 / 自动签退。 */

const mockUsers = new Map()
const minutes = n => n * 60000

function mkSession (username, course, i, { offsetMin, status, signOut = null }) {
  const now = Date.now()
  return {
    id: `att-${username}-${i}`,
    courseId: course.id,
    courseName: course.name,
    type: i % 3 === 0 ? 'location' : i % 3 === 1 ? 'qr' : 'code',
    title: `第 ${i} 周 身体素质课考勤`,
    startAt: new Date(now + minutes(offsetMin)).toISOString(),
    endAt: new Date(now + minutes(offsetMin + 20)).toISOString(),
    status,
    signedAt: status === 'signed' ? new Date(now + minutes(offsetMin + 2)).toISOString() : null,
    place: course.location,
    radius: 500,
    codeLen: 4,
    signOutEnabled: false,
    signOutStartAt: null,
    signOutEndAt: null,
    signOutStatus: 'none',
    signedOutAt: null,
    ...(signOut
      ? {
          signOutEnabled: true,
          signOutStartAt: new Date(now + minutes(signOut.from)).toISOString(),
          signOutEndAt: new Date(now + minutes(signOut.to)).toISOString(),
          signOutStatus: signOut.status,
          signedOutAt: null
        }
      : {})
  }
}

function mockUser (username) {
  if (mockUsers.has(username)) return mockUsers.get(username)
  const course = {
    id: 'szt-2026-autumn-01',
    name: '身体素质课（篮球）',
    teacher: '王建国',
    department: '公共体育与艺术部',
    term: '2026-2027 秋冬',
    location: '紫金港校区西区体育馆 3 号场'
  }
  const sessions = [
    mkSession(username, course, 1, { offsetMin: -3, status: 'open' }),
    mkSession(username, course, 2, { offsetMin: 42, status: 'closed' }),
    mkSession(username, course, 3, { offsetMin: 3 * 1440, status: 'closed' }),
    mkSession(username, course, 4, { offsetMin: -1440, status: 'signed' }),
    mkSession(username, course, 5, {
      offsetMin: -50,
      status: 'signed',
      signOut: { from: -10, to: 8, status: 'open' }
    })
  ]
  const state = { course, sessions, nextOpenAt: Date.now() + 90000 }
  mockUsers.set(username, state)
  return state
}

function refreshMock (state) {
  const now = Date.now()
  if (now < state.nextOpenAt) return
  const outReady = state.sessions.find(s =>
    s.status === 'signed' && s.signOutEnabled && s.signOutStatus !== 'done' && s.signOutStatus !== 'open'
  )
  if (outReady) {
    outReady.signOutStartAt = new Date(now - 60000).toISOString()
    outReady.signOutEndAt = new Date(now + 9 * 60000).toISOString()
    outReady.signOutStatus = 'open'
    pushEvent('info', 'session', `[mock] 老师开启签退：${outReady.title}`)
    state.nextOpenAt = now + 90000
    return
  }
  const closed = state.sessions
    .filter(s => s.status === 'closed')
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))[0]
  if (closed) {
    closed.status = 'open'
    closed.startAt = new Date(now - 60000).toISOString()
    closed.endAt = new Date(now + 19 * 60000).toISOString()
    pushEvent('info', 'session', `[mock] 新场次开放：${closed.title}`)
  }
  state.nextOpenAt = now + 90000
}

export async function mockCourses (username) { return [mockUser(username).course] }
export async function mockSessions (username) {
  const s = mockUser(username)
  refreshMock(s)
  return s.sessions
}

export async function mockCheckin (username, session) {
  const target = mockUser(username).sessions.find(x => x.id === session.id)
  await new Promise(r => setTimeout(r, 400 + Math.random() * 500))
  if (!target) throw new Error('场次不存在或已失效')
  if (target.status === 'signed') return { code: 0, msg: '已签到', data: { sign_time: target.signedAt } }
  if (target.status !== 'open') throw new Error('该场次未开放签到')
  target.status = 'signed'
  target.signedAt = new Date().toISOString()
  return { code: 0, msg: '签到成功', data: { sign_time: target.signedAt, attendance_id: target.id } }
}

export async function mockSignOut (username, session) {
  const target = mockUser(username).sessions.find(x => x.id === session.id)
  await new Promise(r => setTimeout(r, 400 + Math.random() * 500))
  if (!target) throw new Error('场次不存在或已失效')
  if (!target.signOutEnabled) throw new Error('老师未开启签退')
  if (target.signOutStatus === 'done') return { code: 0, msg: '已签退', data: { sign_out_time: target.signedOutAt } }
  if (target.signOutStatus !== 'open') throw new Error('签退窗口未开放')
  if (target.status !== 'signed') throw new Error('尚未签到，无法签退')
  target.signOutStatus = 'done'
  target.signedOutAt = new Date().toISOString()
  return { code: 0, msg: '签退成功', data: { sign_out_time: target.signedOutAt, attendance_id: target.id } }
}

/* ------------------------------ 对外门面 ------------------------------ */

export async function getCourses (username, token) {
  if (IS_MOCK()) return mockCourses(username)
  return realCourses(token)
}

export async function listSessions (username, token) {
  if (IS_MOCK()) return mockSessions(username)
  const courses = await realCourses(token)
  const all = []
  for (const c of courses) all.push(...await realSessions(token, c))
  return all
}

export async function submitCheckin (username, token, session, opts = {}) {
  if (IS_MOCK()) return mockCheckin(username, session)
  return realCheckin(token, session, opts)
}

export async function submitSignOut (username, token, session, opts = {}) {
  if (IS_MOCK()) return mockSignOut(username, session)
  return realSignOut(token, session, opts)
}

export function isMock () { return IS_MOCK() }
