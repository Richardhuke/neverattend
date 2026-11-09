/** 进程内状态：会话、自动签到运行态、事件流。重启即清空（与 NeverRun 的"无账号体系"一致） */
const MAX_EVENTS = 200

const sessions = new Map() // username -> { username, xh, xm, xymc, token, tokenExp, createdAt, mock }
const events = []

export const watch = {
  running: false,
  intervalMs: 10000,
  autoCheckin: true,
  startedAt: null,
  lastPollAt: null,
  nextPollAt: null,
  polls: 0,
  checkins: 0,
  signouts: 0,
  lastError: null,
  inflight: new Set() // 正在处理的 sessionId，防重复提交
}

export function pushEvent (level, step, message, extra = {}) {
  const ev = {
    id: events.length ? events[events.length - 1].id + 1 : 1,
    at: new Date().toISOString(),
    level, // info | success | warn | error
    step: step || 'misc',
    message,
    ...extra
  }
  events.push(ev)
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
  return ev
}

export function listEvents (sinceId = 0, limit = 80) {
  return events.filter(e => e.id > sinceId).slice(-limit)
}

export const sessionStore = {
  save (rec) {
    sessions.set(rec.username, { ...rec, updatedAt: Date.now() })
    return sessions.get(rec.username)
  },
  get (username) {
    return username ? sessions.get(username) : null
  },
  list () {
    return [...sessions.values()]
  },
  remove (username) {
    return sessions.delete(username)
  },
  /** 异地模式：把该账号使用的坐标记在会话上，守护进程直接复用（无需开着浏览器） */
  setCoords (username, coords) {
    const rec = sessions.get(username)
    if (!rec) return null
    rec.coords = coords ? { ...coords, updatedAt: Date.now() } : null
    rec.updatedAt = Date.now()
    return rec
  }
}
