/** 会话、自动签到运行态、事件流。会话落盘到 data/sessions.json，重启后不必重新绑定（不存密码） */
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

const MAX_EVENTS = 200
const DATA_FILE = path.join(config.dataDir, 'sessions.json')

const PERSIST_FIELDS = ['username', 'xh', 'xm', 'xymc', 'token', 'tokenExp', 'createdAt', 'mock', 'coords', 'jar', 'mode']

const sessions = new Map() // username -> { username, xh, xm, xymc, token, tokenExp, createdAt, mock, coords }
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

function persist () {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true })
    const list = [...sessions.values()].map(rec => {
      const out = {}
      for (const k of PERSIST_FIELDS) if (rec[k] !== undefined) out[k] = rec[k]
      return out
    })
    fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf8')
    return true
  } catch (e) {
    pushEvent('warn', 'misc', `会话落盘失败：${e?.message || e}`)
    return false
  }
}

function restore () {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    const list = Array.isArray(raw) ? raw : []
    let n = 0
    for (const rec of list) {
      if (!rec || !rec.username || !rec.token) continue
      sessions.set(rec.username, { ...rec })
      n += 1
    }
    if (n) pushEvent('info', 'misc', `已从磁盘恢复 ${n} 个账号会话`)
    return n
  } catch {
    return 0
  }
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
    persist()
    return sessions.get(rec.username)
  },
  get (username) {
    return username ? sessions.get(username) : null
  },
  list () {
    return [...sessions.values()]
  },
  remove (username) {
    const ok = sessions.delete(username)
    if (ok) persist()
    return ok
  },
  /** 异地模式：把该账号使用的坐标记在会话上，守护进程直接复用（无需开着浏览器） */
  setCoords (username, coords) {
    const rec = sessions.get(username)
    if (!rec) return null
    rec.coords = coords ? { ...coords, updatedAt: Date.now() } : null
    rec.updatedAt = Date.now()
    persist()
    return rec
  }
}

restore()
