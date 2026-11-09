import { getCourses, listSessions, submitCheckin, submitSignOut } from './tyys.js'
import { verifyToken } from './zjuam.js'
import { pushEvent } from '../store.js'
import { jitterPoint, distanceMeters } from '../utils/geo.js'
import { config } from '../config.js'

/** 与 NeverRun 的 8 步时间轴同构：key 固定，标题按 签到 / 签退 切换 */
export const STEPS = [
  { key: 'auth', title: 'Authenticating' },
  { key: 'course', title: 'Fetching course info' },
  { key: 'session', title: 'Locating session' },
  { key: 'term', title: 'Checking term & window' },
  { key: 'locate', title: 'Resolving target' },
  { key: 'prejudge', title: 'Prejudgment [1/3]' },
  { key: 'submit', title: 'Submitting [2/3]' },
  { key: 'verify', title: 'Verifying [3/3]' }
]

const TYPE_TEXT = { location: '定位', qr: '扫码', code: '口令' }
const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 签到 / 签退流水线（异步生成器，逐步 yield SSE 事件）
 * @param {{username:string, token:string, sessionId?:string, action?:'in'|'out',
 *          code?:string, longitude?:number, latitude?:number, jitter?:number,
 *          autoCode?:boolean, ignorePrejudgement?:boolean}} opts
 */
export async function * runCheckin (opts) {
  const { username, token } = opts
  const isOut = opts.action === 'out'
  const verb = isOut ? '签退' : '签到'
  const eventStep = isOut ? 'signout' : 'checkin'
  const startedAt = Date.now()
  const t = (k, m) => ({ type: 'info', step: k, message: m })

  try {
    yield t('auth', '正在认证浙体艺 JWT ...')
    const me = await verifyToken(username, token)
    yield { type: 'success', step: 'auth', message: `已认证：${me.xm || username}（${me.xh}）` }

    yield t('course', '拉取身体素质课教学班 ...')
    const courses = await getCourses(username, token)
    if (!courses.length) throw new Error('未找到身体素质课教学班')
    const course = courses[0]
    yield { type: 'success', step: 'course', message: `${course.name} · ${course.teacher} · ${course.term}` }

    yield t('session', '拉取考勤场次 ...')
    const sessions = await listSessions(username, token)
    const session = opts.sessionId
      ? sessions.find(s => s.id === opts.sessionId)
      : sessions.find(s => isOut ? s.signOutStatus === 'open' : s.status === 'open')
    if (!session) throw new Error(isOut ? '没有找到可签退的场次' : '没有找到可签到的场次')
    yield { type: 'success', step: 'session', message: `${session.title}（${session.id}）` }

    yield t('term', `校验学期与${verb}时间窗 ...`)
    const now = Date.now()
    const start = isOut
      ? (session.signOutStartAt ? new Date(session.signOutStartAt).getTime() : now)
      : (session.startAt ? new Date(session.startAt).getTime() : now)
    const end = isOut
      ? (session.signOutEndAt ? new Date(session.signOutEndAt).getTime() : now + 20 * 60000)
      : (session.endAt ? new Date(session.endAt).getTime() : now + 20 * 60000)
    const inWindow = isOut
      ? session.signOutStatus === 'open'
      : now >= start - 5 * 60000 && now <= end
    yield {
      type: inWindow ? 'success' : 'info',
      step: 'term',
      message: `${course.term} · ${verb}窗口 ${fmt(start)} ~ ${fmt(end)}${inWindow ? '（在窗口内）' : '（不在窗口内）'}`
    }

    yield t('locate', `解析${verb}目标 ...`)
    let code = opts.code
    if (session.type === 'code' && !code && opts.autoCode) code = '0000'

    // 异地模式：给了坐标就在其上做半径抖动，避免每次经纬度完全一致
    let coords = null
    if (opts.longitude != null && opts.latitude != null) {
      coords = jitterPoint(opts.longitude, opts.latitude, opts.jitter ?? config.geo.jitterMeters)
    }
    const venue = config.geo.venue
    const away = distanceMeters(coords, venue)
    yield {
      type: 'success',
      step: 'locate',
      message: `${verb}方式：${TYPE_TEXT[session.type] || session.type}` +
        (session.type === 'location' ? ` · ${session.place}` : '') +
        (code ? ` · 口令 ${code}` : '') +
        (coords ? ` · 坐标 ${coords.longitude},${coords.latitude}${away != null ? `（距场馆约 ${away} m）` : ''}` : '') +
        (opts.away ? ' · 异地模式（跳过距离预判）' : '')
    }

    yield t('prejudge', `预判：重复${verb} / 时间窗 / 距离 ...`)
    const problems = []
    if (isOut) {
      if (!session.signOutEnabled) problems.push('老师未开启签退')
      if (session.signOutStatus === 'done') problems.push('该场次已签退')
      if (session.status !== 'signed') problems.push('尚未签到')
    } else if (session.status === 'signed') {
      problems.push('该场次已签到')
    }
    if (!inWindow) problems.push(`不在${verb}时间窗内`)
    if (session.type === 'location' && !coords) problems.push('缺少定位坐标（将使用场地点位）')
    if (session.radius && away != null && away > session.radius && !opts.away) {
      problems.push(`距场馆 ${away} m，超出 ${session.radius} m（异地模式可跳过）`)
    }
    if (problems.length && !opts.ignorePrejudgement) {
      throw new Error(`预判未通过：${problems.join('；')}`)
    }
    yield { type: 'success', step: 'prejudge', message: problems.length ? `带警告继续：${problems.join('；')}` : '预判通过' }

    yield t('submit', `提交${verb} ...`)
    const submit = isOut ? submitSignOut : submitCheckin
    const res = await submit(username, token, session, {
      code,
      longitude: coords?.longitude,
      latitude: coords?.latitude
    })
    const stamp = res?.data?.sign_time || res?.data?.sign_out_time || res?.sign_time || new Date().toISOString()
    yield { type: 'success', step: 'submit', message: `服务端已受理 · ${fmt(new Date(stamp).getTime())}` }

    yield t('verify', '回查考勤状态 ...')
    const after = await listSessions(username, token)
    const me2 = after.find(s => s.id === session.id)
    const ok = isOut ? me2?.signOutStatus === 'done' : me2?.status === 'signed'
    if (!ok) throw new Error(`复核失败：场次状态仍为 ${isOut ? me2?.signOutStatus : me2?.status || 'unknown'}`)
    yield { type: 'success', step: 'verify', message: `复核通过 · ${session.title} 已${verb}` }

    const summary = {
      ok: true, action: isOut ? 'out' : 'in', sessionId: session.id,
      course: course.name, stamp, coords, awayMeters: away, elapsedMs: Date.now() - startedAt
    }
    pushEvent('success', eventStep, `${verb}成功：${session.title}`, summary)
    yield { type: 'done', step: 'verify', message: '已完成', data: summary }
    return summary
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    pushEvent('error', eventStep, `${verb}失败：${message}`)
    yield { type: 'error', step: 'error', message }
    yield { type: 'done', step: 'error', message: '已结束', data: { ok: false, action: isOut ? 'out' : 'in', error: message } }
    return { ok: false, error: message }
  }
}

/** 供 watcher 使用：跑完流水线并收集事件 */
export async function runCheckinCollect (opts) {
  const out = []
  let result = { ok: false }
  for await (const ev of runCheckin(opts)) {
    out.push(ev)
    if (ev.type === 'done') result = ev.data || result
  }
  return { events: out, result }
}

function fmt (ts) {
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export { sleep }
