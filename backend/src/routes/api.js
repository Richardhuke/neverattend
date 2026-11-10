import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { loginWithPassword, verifyToken, decodePassword, extractToken } from '../services/zjuam.js'
import { getCourses, listSessions, isMock } from '../services/tyys.js'
import { runCheckin, STEPS } from '../services/pipeline.js'
import { watcher, tickOnce } from '../services/watcher.js'
import { sessionStore, listEvents, pushEvent } from '../store.js'

const router = express.Router()

const bad = (res, code, detail) => res.status(code).json({ detail })

/** 运行态 / 配置面板（对应 NeverRun 的 /config） */
router.get('/config', (req, res) => {
  res.json({
    mode: isMock() ? 'mock' : 'live',
    tyysBase: config.tyys.base,
    endpoints: config.tyys.endpoints,
    watch: watcher.state(),
    geo: config.geo,
    steps: STEPS,
    sessions: sessionStore.list().map(s => ({
      username: s.username, xh: s.xh, xm: s.xm, createdAt: s.createdAt
    }))
  })
})

/** 账密登录：前端已用 AES 加密 password，服务端解密后走 ZJUAM CAS */
router.post('/getToken', async (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) return bad(res, 400, 'username / password 必填')
  try {
    // mock 模式不校验密码，方便本地演示；live 模式按前端 AES 密文解出明文再登 CAS
    const plain = isMock() ? 'mock-password' : decodePassword(String(password))
    const me = await loginWithPassword(String(username).trim(), plain)
    sessionStore.save({
      username: me.xh || me.username,
      xh: me.xh || me.username,
      xm: me.xm || '',
      xymc: me.xymc || '',
      token: me.token,
      tokenExp: Date.now() + 2 * 3600 * 1000,
      createdAt: Date.now(),
      mock: isMock()
    })
    pushEvent('success', 'auth', `账号已接入：${me.xh || me.username}`)
    res.json({ username: me.xh || me.username, token: me.token })
  } catch (err) {
    bad(res, 401, `CAS 登录失败：${err?.message || String(err)}`)
  }
})

/** Token 模式第一步：把用户粘回来的整页源码交给后端解析（正则比前端宽容） */
router.post('/parse-token', (req, res) => {
  const { text } = req.body || {}
  if (!text || String(text).length < 20) return bad(res, 400, '请粘贴登录后的整页源码（Ctrl+U 全选复制）')
  const hit = extractToken(String(text))
  if (!hit) return bad(res, 422, '没能从这段源码里找到学号 + token，请确认复制的是登录成功后的页面（含 window.app.getUserName 或 eyJ 开头的 JWT）')
  res.json({ xh: hit.xh, token: hit.token, via: hit.via })
})

/** Token 模式校验：用户自己在浏览器登录后贴回的 JWT */
router.post('/verifyToken', async (req, res) => {
  const { username, token } = req.body || {}
  if (!username || !token) return bad(res, 400, 'username / token 必填')
  try {
    const me = await verifyToken(String(username), String(token))
    sessionStore.save({
      username: me.xh || String(username),
      xh: me.xh,
      xm: me.xm,
      xymc: me.xymc,
      token: me.token,
      tokenExp: Date.now() + 2 * 3600 * 1000,
      createdAt: Date.now(),
      mock: isMock()
    })
    pushEvent('success', 'auth', `token 已校验：${me.xh}`)
    res.json(me)
  } catch (err) {
    bad(res, 401, `token 校验失败：${err instanceof Error ? err.message : String(err)}`)
  }
})

/** 异地模式：登记该账号使用的坐标（含抖动半径），守护进程会复用 */
// 调试：取回上一次登录失败时落盘的 tyys 首屏 HTML（只读，受 ACCESS_KEY 保护）
router.get('/debug/login-html', (req, res) => {
  const file = process.env.DUMP_HTML || path.join(process.cwd(), 'logs', 'last-login.html')
  if (!fs.existsSync(file)) return res.status(404).json({ detail: `还没有落盘文件：${file}` })
  const text = fs.readFileSync(file, 'utf8')
  res.json({ file, bytes: Buffer.byteLength(text), html: text.slice(0, 400000) })
})

// 调试：最近事件（登录链每跳的日志都在这里，受 ACCESS_KEY 保护）
router.get('/debug/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 200)
  res.json({ events: listEvents(0, limit) })
})

router.post('/coords', (req, res) => {
  const { username, longitude, latitude, jitter, mode } = req.body || {}
  if (!username) return bad(res, 400, 'username 必填')
  const rec = sessionStore.get(username)
  if (!rec) return bad(res, 404, '账号尚未接入，请先登录')
  if (mode === 'venue' || longitude == null || latitude == null) {
    sessionStore.setCoords(username, null)
    return res.json({ ok: true, coords: null, geo: config.geo })
  }
  const coords = {
    mode: 'custom',
    longitude: Number(longitude),
    latitude: Number(latitude),
    jitter: Number(jitter ?? config.geo.jitterMeters)
  }
  sessionStore.setCoords(username, coords)
  pushEvent('info', 'geo', `异地模式已登记：${coords.longitude},${coords.latitude} ±${coords.jitter}m`)
  res.json({ ok: true, coords, geo: config.geo })
})

/** 教学班 + 场次总览 */
router.get('/attendance/status', async (req, res) => {
  const { username, token } = req.query
  if (!username || !token) return bad(res, 400, 'username / token 必填')
  try {
    const [courses, sessions] = await Promise.all([
      getCourses(username, token),
      listSessions(username, token)
    ])
    res.json({
      courses,
      sessions: sessions.sort((a, b) => new Date(b.startAt || 0) - new Date(a.startAt || 0)),
      openCount: sessions.filter(s => s.status === 'open').length,
      signedCount: sessions.filter(s => s.status === 'signed').length,
      signOutOpenCount: sessions.filter(s => s.signOutStatus === 'open').length,
      signOutDoneCount: sessions.filter(s => s.signOutStatus === 'done').length,
      geo: config.geo,
      coords: sessionStore.get(username)?.coords || null
    })
  } catch (err) {
    bad(res, 502, err instanceof Error ? err.message : String(err))
  }
})

router.post('/alreadySigns', async (req, res) => {
  const { username, token } = req.body || {}
  try {
    const sessions = await listSessions(username, token)
    res.json({ count: sessions.filter(s => s.status === 'signed').length })
  } catch {
    res.json({ count: 0 })
  }
})

router.post('/inCheckinWindow', async (req, res) => {
  const { username, token } = req.body || {}
  try {
    const sessions = await listSessions(username, token)
    res.json({ data: sessions.some(s => s.status === 'open') })
  } catch {
    res.json({ data: false })
  }
})

/** 签到：SSE 逐步推送 8 步流水线 */
router.post('/checkin', async (req, res) => {
  const { username, token, sessionId, action, code, longitude, latitude, jitter, away, autoCode, ignorePrejudgement } = req.body || {}
  if (!username || !token) return bad(res, 400, 'username / token 必填')
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  const send = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`)
  try {
    for await (const ev of runCheckin({
      username, token, sessionId,
      action: action === 'out' ? 'out' : 'in',
      code, longitude, latitude, jitter, away: away === true,
      autoCode: !!autoCode, ignorePrejudgement: !!ignorePrejudgement
    })) send(ev)
  } catch (err) {
    send({ type: 'error', step: 'http', message: err instanceof Error ? err.message : String(err) })
  } finally {
    res.end()
  }
})

/** 退出登录：删掉服务端会话（含凭据），没有账号了就顺手停守护 */
router.post('/logout', (req, res) => {
  const username = String((req.body || {}).username || '').trim()
  const removed = username ? sessionStore.remove(username) : false
  let stopped = false
  if (!sessionStore.list().length && watcher.state().running) {
    watcher.stop()
    stopped = true
  }
  pushEvent('info', 'auth', `账号已退出：${username || '(未知)'}`, { username })
  res.json({ ok: true, removed, stopped, remaining: sessionStore.list().length })
})

/** 自动签到守护状态 + 事件流（前端 8s 轮询） */
router.get('/watch/state', (req, res) => {
  const since = Number(req.query.since || 0)
  res.json({
    ...watcher.state(),
    events: listEvents(since, Number(req.query.limit || 80))
  })
})

router.post('/watch/start', (req, res) => {
  const { intervalMs, autoCheckin } = req.body || {}
  res.json(watcher.start({ intervalMs, autoCheckin }))
})

router.post('/watch/stop', (req, res) => {
  res.json(watcher.stop())
})

/** 手动触发一次轮询（调试用，不必等 10s） */
router.post('/watch/poll', async (req, res) => {
  try {
    await tickOnce()
    res.json({ ...watcher.state(), events: listEvents(0, 40) })
  } catch (err) {
    bad(res, 500, err instanceof Error ? err.message : String(err))
  }
})

export default router
