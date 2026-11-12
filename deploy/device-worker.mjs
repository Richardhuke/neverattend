#!/usr/bin/env node
/**
 * 执行面 worker：把「网页上点的签到」变成手机上真实的点击。
 *
 * 一台执行机 = 一台连着（或模拟出来的）Android + 这个脚本。
 * 网页只负责排队，账号密码只在校验/绑定那一步用过；这里不碰密码，
 * 它驱动的是**已经登录好的浙大体艺**。
 *
 * 用法（真机）：
 *   node deploy/device-worker.mjs --serial 10AG1H0QJE004HC
 * 用法（模拟器，需 KVM 主机）：
 *   node deploy/device-worker.mjs --serial emulator-5554 --label emu-1
 *
 * 可选环境变量：
 *   NA_SERVER        后端地址（默认 CONFIG.server）
 *   NA_KEY           访问密钥 X-Access-Key
 *   NA_INTERVAL      空闲轮询间隔 ms（默认 5000）
 *   NA_LABEL         给这台执行机起个名（默认 <hostname>-<serial>）
 */
import { execFile, spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ADB = process.env.NA_ADB || 'C:\\Users\\Richa\\adbdl\\platform-tools\\adb.exe'
const DRIVER = path.join(HERE, 'adb-ns.mjs')

const arg = (name, def) => {
  const i = process.argv.indexOf(name)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const has = (name) => process.argv.includes(name)

const SERVER = String(process.env.NA_SERVER || arg('--server', 'https://fields-shame-enhanced-adding.trycloudflare.com')).replace(/\/+$/, '')
const KEY = process.env.NA_KEY || arg('--key', 'thgc8exk73v2wy9j4pbd')
const INTERVAL = Number(process.env.NA_INTERVAL || arg('--interval', 5000))
const ONCE = has('--once')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pexec (file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout, stderr }))
      resolve({ stdout, stderr })
    })
  })
}

async function pickSerial () {
  const want = arg('--serial', process.env.NA_SERIAL || '')
  const { stdout } = await pexec(ADB, ['devices'])
  const list = stdout
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p[0] && p[1] === 'device')
    .map((p) => p[0])
  if (want) {
    if (!list.includes(want)) throw new Error(`设备 ${want} 不在线（在线：${list.join(', ') || '无'}）`)
    return want
  }
  if (!list.length) throw new Error('没有可用的 Android 设备：插数据线并允许 USB 调试，或先启动模拟器')
  return list[0]
}

async function api (p, body) {
  const res = await fetch(SERVER + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Access-Key': KEY },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) throw new Error(`${p} → ${res.status} ${json.detail || text.slice(0, 120)}`)
  return json
}

/** 跑一次 adb-ns --once，把 job 变成环境变量；返回 { ok, action, message } */
function runDriver (serial, job) {
  const env = {
    ...process.env,
    NA_SERIAL: serial,
    NA_ACTION: job.action,
    NA_SERVER: SERVER,
    NA_KEY: KEY,
    NA_SKIP_WINDOW: '1' // 时间窗由服务端按课表判定
  }
  if (job.lat != null && job.lng != null) env.NA_MOCK = `${job.lat},${job.lng}`
  if (job.date) env.NA_DATE = job.date
  if (job.time) env.NA_TIME = job.time

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DRIVER, '--once'], { env, cwd: path.dirname(HERE) })
    const lines = []
    const onData = (buf) => {
      const s = buf.toString('utf8')
      for (const line of s.split(/\r?\n/)) {
        if (!line.trim()) continue
        lines.push(line)
        console.log('  ' + line)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => {
      console.log('[worker] 单次执行超过 3 分钟，杀掉')
      child.kill()
    }, 3 * 60 * 1000)
    child.on('close', (code) => {
      clearTimeout(timer)
      const hit = lines.filter((l) => l.startsWith('[result] ')).pop()
      let out = { ok: false, action: job.action, message: `执行机退出码 ${code}` }
      if (hit) {
        try { out = { ...out, ...JSON.parse(hit.slice('[result] '.length)) } } catch { /* 保留默认 */ }
      } else {
        const warn = lines.filter((l) => /^\[(warn|skip|idle|fatal)\]/.test(l)).pop()
        if (warn) out.message = warn.replace(/^\[\w+\]\s*/, '').slice(0, 200)
      }
      out.log = lines.slice(-12)
      resolve(out)
    })
  })
}

async function main () {
  const serial = await pickSerial()
  const deviceId = arg('--device-id', process.env.NA_DEVICE_ID || serial)
  const label = process.env.NA_LABEL || arg('--label', `${os.hostname()}-${serial}`)
  if (has('--plan')) {
    console.log(`[worker] serial=${serial} deviceId=${deviceId} server=${SERVER}`)
    return
  }
  console.log(`[worker] 执行机 ${deviceId}（${label}）→ ${SERVER}`)

  for (;;) {
    try {
      const hb = await api('/api/device/heartbeat', { deviceId, serial, label, note: `${os.platform()} ${os.release()}` })
      if (hb.queued || hb.state?.queued) {
        const claim = await api('/api/device/claim', { deviceId })
        const job = claim.job
        if (job) {
          console.log(`[worker] 接到任务 ${job.id}：${job.username} ${job.action === 'in' ? '签到' : '签退'}${job.lat != null ? ` @${job.lat},${job.lng}` : ''}`)
          const result = await runDriver(serial, job)
          console.log(`[worker] 回报 ${result.ok ? '成功' : '失败'}：${result.message}`)
          await api('/api/device/report', {
            deviceId,
            jobId: job.id,
            ok: result.ok,
            message: result.message,
            action: result.action || job.action,
            log: result.log
          })
          if (ONCE) return
          continue // 队列里可能还有
        }
      }
    } catch (err) {
      console.log(`[worker] ${err instanceof Error ? err.message : String(err)}`)
      if (ONCE) process.exitCode = 1
    }
    if (ONCE) return
    await sleep(INTERVAL)
  }
}

main().catch((err) => {
  console.error(`[fatal] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
