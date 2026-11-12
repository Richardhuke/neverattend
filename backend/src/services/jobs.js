/**
 * 设备任务队列（控制面 ↔ 执行面）。
 *
 * 为什么要队列：身体素质课的签到只能在「浙大体艺」App 里点，而 App 的 /app/** 每个请求
 * 都要 ARM native 签名（见 docs/APP-SIGNING.md），服务端没法直接调接口。所以站点只做
 * 控制面——网页上点「签到」，落一条任务；真正干活的「执行面」是任意一台能跑 adb 的机器：
 *
 *   真机（USB 插在一台电脑上）   → deploy/device-worker.mjs --serial <serial>
 *   Android 模拟器（KVM 主机）    → deploy/device-worker.mjs --serial emulator-5554
 *
 * 执行面只做三件事：claim 一条任务 → 用 adb 注入坐标并点签到 → report 结果。
 * 这样同一套网页在「只有一台手机」和「一堆模拟器」两种规模下都能用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { reportPhone } from './phone.js'
import { pushEvent } from '../store.js'

const MAX_JOBS = 500
const OFFLINE_MS = 90 * 1000

const jobs = new Map() // id -> job
const devices = new Map() // deviceId -> { deviceId, serial, label, lastSeen, currentJob, note }

const jobFile = () => path.join(config.dataDir, 'jobs.json')
const deviceFile = () => path.join(config.dataDir, 'devices.json')

function readJson (file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson (file, value) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  } catch (err) {
    pushEvent('warn', 'jobs', `队列落盘失败：${err?.message || err}`)
  }
}

function persistJobs () {
  const list = [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_JOBS)
  writeJson(jobFile(), list)
}

function persistDevices () {
  writeJson(deviceFile(), [...devices.values()])
}

function restore () {
  for (const j of readJson(jobFile(), [])) {
    if (!j || !j.id) continue
    // 重启前还在 running 的，标记失败，避免永久占位
    if (j.status === 'running' || j.status === 'claimed') {
      j.status = 'failed'
      j.message = '服务重启，任务中断'
    }
    jobs.set(j.id, j)
  }
  for (const d of readJson(deviceFile(), [])) {
    if (d && d.deviceId) devices.set(d.deviceId, { ...d, currentJob: null })
  }
  if (jobs.size) pushEvent('info', 'jobs', `已从磁盘恢复 ${jobs.size} 条任务、${devices.size} 台执行机`)
}

restore()

const rid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4)

function normAction (a) {
  const v = String(a || '').toLowerCase()
  if (v !== 'in' && v !== 'out') throw new Error("action 只能是 in（签到）或 out（签退）")
  return v
}

/** 网页侧调用：入队一条签到/签退任务 */
export function createJob ({ username, action, lat, lng, date, time, note } = {}) {
  if (!username) throw new Error('username 必填')
  const act = normAction(action)
  const job = {
    id: rid(),
    username: String(username).trim(),
    action: act,
    lat: lat == null || lat === '' ? null : Number(lat),
    lng: lng == null || lng === '' ? null : Number(lng),
    date: date ? String(date) : null, // YYYY-MM-DD，默认执行机当天
    time: time ? String(time) : null, // HH:MM，默认执行机当前时间
    note: note ? String(note).slice(0, 200) : '',
    status: 'queued',
    deviceId: null,
    message: '',
    log: [],
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null
  }
  jobs.set(job.id, job)
  persistJobs()
  pushEvent('info', 'jobs', `新任务 ${job.id}：${job.username} ${act === 'in' ? '签到' : '签退'}`, { username: job.username })
  return job
}

/** 执行面调用：认领最早的一条排队任务 */
export function claimJob (deviceId) {
  if (!deviceId) throw new Error('deviceId 必填')
  const now = new Date().toISOString()
  const next = [...jobs.values()]
    .filter((j) => j.status === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
  if (!next) return null
  next.status = 'running'
  next.deviceId = String(deviceId)
  next.startedAt = now
  const dev = devices.get(String(deviceId))
  if (dev) dev.currentJob = next.id
  persistJobs()
  persistDevices()
  pushEvent('info', 'jobs', `任务 ${next.id} 由 ${deviceId} 认领`)
  return next
}

/** 执行面调用：回报结果；成功则顺带记进「手机上报」通道，Run 页立即可见 */
export function finishJob (id, { ok, message, action, log } = {}) {
  const job = jobs.get(String(id))
  if (!job) throw new Error('任务不存在：' + id)
  job.status = ok ? 'done' : 'failed'
  job.message = message ? String(message).slice(0, 400) : ''
  job.finishedAt = new Date().toISOString()
  if (Array.isArray(log)) job.log = job.log.concat(log.map((x) => String(x).slice(0, 200))).slice(-40)

  const dev = job.deviceId ? devices.get(job.deviceId) : null
  if (dev) dev.currentJob = null

  if (ok) {
    try {
      reportPhone(job.username, {
        action: action || job.action,
        note: job.message || `设备 ${job.deviceId || '未知'} 执行`
      })
    } catch (err) {
      pushEvent('warn', 'jobs', `写入手机上报失败：${err?.message || err}`)
    }
  }
  persistJobs()
  persistDevices()
  pushEvent(ok ? 'success' : 'warn', 'jobs', `任务 ${job.id} ${ok ? '成功' : '失败'}：${job.message}`)
  return job
}

export function cancelJob (id) {
  const job = jobs.get(String(id))
  if (!job) throw new Error('任务不存在：' + id)
  if (job.status === 'queued') {
    job.status = 'canceled'
    job.finishedAt = new Date().toISOString()
    job.message = '手动取消'
    persistJobs()
  }
  return job
}

/** 执行面心跳：注册设备 + 上报在线状态，返回是否有排队任务（免空转） */
export function heartbeat ({ deviceId, serial, label, note } = {}) {
  if (!deviceId) throw new Error('deviceId 必填')
  const prev = devices.get(String(deviceId)) || {}
  const dev = {
    ...prev,
    deviceId: String(deviceId),
    serial: serial ? String(serial) : (prev.serial || ''),
    label: label ? String(label) : (prev.label || ''),
    note: note ? String(note).slice(0, 200) : (prev.note || ''),
    currentJob: prev.currentJob || null,
    lastSeen: new Date().toISOString()
  }
  devices.set(dev.deviceId, dev)
  persistDevices()
  return {
    device: dev,
    queued: [...jobs.values()].filter((j) => j.status === 'queued').length
  }
}

export function listDevices () {
  const now = Date.now()
  return [...devices.values()].map((d) => ({
    ...d,
    online: now - new Date(d.lastSeen).getTime() < OFFLINE_MS
  }))
}

export function listJobs ({ username, limit = 30 } = {}) {
  let list = [...jobs.values()]
  if (username) list = list.filter((j) => j.username === String(username))
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
}

export function jobState () {
  const all = [...jobs.values()]
  return {
    queued: all.filter((j) => j.status === 'queued').length,
    running: all.filter((j) => j.status === 'running').length,
    done: all.filter((j) => j.status === 'done').length,
    failed: all.filter((j) => j.status === 'failed').length,
    devices: listDevices().length,
    online: listDevices().filter((d) => d.online).length
  }
}
