/**
 * 手机端上报通道。
 *
 * 为什么需要它：身体素质课的签到/签退只存在于「浙大体艺」App 里——
 *   - 网页门户 /ptm/* 只有定向越野的考勤表，没有签到入口（已实测：签到/扫码计数为 0）；
 *   - App 的 /app/** 每个请求都要 ARM native 库 libAMapSDK_Location_v6_6_0.so 里的
 *     cgapiEnrypt(secret, path) 生成头签名，本机是 Windows、包里只有 armeabi-v7a，
 *     无法在服务端复刻（详见 docs/APP-SIGNING.md）。
 * 所以正确分工是：手机上的脚本（AutoJS/无障碍）真正去点「签到」，点完把结果 POST 回来，
 * 本站负责汇总展示 + 记录，Run 页就能同时看到「定向越野」（ptm）和「身体素质课」（手机）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { pushEvent } from '../store.js'

const MAX_EVENTS = 200
const cache = new Map() // username -> { username, courseName, events: [{action, at, note}] }

const fileOf = (username) =>
  path.join(config.dataDir, `phone-${String(username).replace(/[^\w.-]/g, '_')}.json`)

function load (username) {
  if (cache.has(username)) return cache.get(username)
  let rec = { username, courseName: '身体素质课', events: [] }
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(username), 'utf8'))
    if (raw && Array.isArray(raw.events)) rec = { courseName: '身体素质课', ...raw, username }
  } catch {
    /* 首次上报，没有文件是正常的 */
  }
  cache.set(username, rec)
  return rec
}

function persist (rec) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true })
    fs.writeFileSync(fileOf(rec.username), JSON.stringify(rec, null, 2), 'utf8')
    return true
  } catch (err) {
    pushEvent('warn', 'phone', `手机上报落盘失败：${err?.message || err}`)
    return false
  }
}

/** 手机脚本调用：action = 'in'（签到）/ 'out'（签退） */
export function reportPhone (username, { action, at, note, courseName } = {}) {
  if (!username) throw new Error('username 必填')
  const act = String(action || '').toLowerCase()
  if (act !== 'in' && act !== 'out') throw new Error("action 只能是 in 或 out")

  const rec = load(String(username))
  if (courseName) rec.courseName = String(courseName)
  const when = at ? new Date(at) : new Date()
  const atIso = Number.isNaN(when.getTime()) ? new Date().toISOString() : when.toISOString()

  rec.events.push({ action: act, at: atIso, note: note ? String(note).slice(0, 200) : '' })
  if (rec.events.length > MAX_EVENTS) rec.events = rec.events.slice(-MAX_EVENTS)
  persist(rec)

  pushEvent('success', 'phone', `手机上报${act === 'in' ? '签到' : '签退'}：${rec.courseName} ${atIso}${note ? `（${note}）` : ''}`, { username })
  return { ok: true, action: act, at: atIso, courseName: rec.courseName, total: rec.events.length }
}

/** 供 /attendance/status 用：最近一次签到/签退 + 全部事件 */
export function phoneStatus (username) {
  if (!username) return { courseName: '身体素质课', events: [], lastIn: null, lastOut: null }
  const rec = load(String(username))
  const findLast = (a) => {
    for (let i = rec.events.length - 1; i >= 0; i--) if (rec.events[i].action === a) return rec.events[i]
    return null
  }
  return {
    courseName: rec.courseName,
    events: rec.events.slice(-50),
    lastIn: findLast('in'),
    lastOut: findLast('out')
  }
}

/**
 * 把手机上报折叠成 Run 页能渲染的 session。
 * 今天的签到 → 一条「已签到」；今天还没签到 → 一条「待签到」，提醒去手机点。
 * 和 ptm 的定向越野互不影响，两边都显示。
 */
export function phoneSessions (username) {
  const st = phoneStatus(username)
  if (!username) return []
  const today = new Date()
  const isToday = (iso) => {
    if (!iso) return false
    const d = new Date(iso)
    return d.toDateString() === today.toDateString()
  }

  const out = []
  const lastIn = st.lastIn
  const lastOut = st.lastOut
  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0).toISOString()
  const dayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59).toISOString()

  if (lastIn && isToday(lastIn.at)) {
    out.push({
      id: `phone-${username}-in-${lastIn.at}`,
      title: '身体素质课 签到',
      courseName: st.courseName,
      type: 'phone',
      startAt: dayStart,
      endAt: dayEnd,
      status: 'signed',
      signedAt: lastIn.at,
      source: 'phone',
      note: lastIn.note || ''
    })
    if (lastOut && isToday(lastOut.at) && new Date(lastOut.at) >= new Date(lastIn.at)) {
      out.push({
        id: `phone-${username}-out-${lastOut.at}`,
        title: '身体素质课 签退',
        courseName: st.courseName,
        type: 'phone',
        startAt: dayStart,
        endAt: dayEnd,
        status: 'signed',
        signedAt: lastOut.at,
        source: 'phone',
        note: lastOut.note || ''
      })
    }
  } else {
    out.push({
      id: `phone-${username}-pending`,
      title: '身体素质课 待签到',
      courseName: st.courseName,
      type: 'phone',
      startAt: dayStart,
      endAt: dayEnd,
      status: 'open',
      signedAt: null,
      source: 'phone',
      note: '手机上运行 autojs-ns.js，检测到「签到」会自动点并回报到这里'
    })
  }
  return out
}

export const __test = { load, phoneStatus, phoneSessions }
