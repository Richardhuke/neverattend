import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { config } from './config.js'
import apiRouter from './routes/api.js'
import { watcher } from './services/watcher.js'
import { pushEvent } from './store.js'

const app = express()
app.disable('x-powered-by')
// GitHub Pages 等静态托管会从别的源来调接口，放开 CORS（本项目自己用，不设白名单）
// 想锁定只允许某个前端来源时设 CORS_ORIGIN（默认回显请求来源）
const CORS_ORIGIN = String(process.env.CORS_ORIGIN || '').trim()

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN || req.headers.origin || '*')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Access-Key')
  res.setHeader('Access-Control-Max-Age', '600')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})
app.use(express.json({ limit: '1mb' }))

// 可选访问密钥：公网部署建议设置 ACCESS_KEY，除 /api/config（只读元信息）外都要带 X-Access-Key
const ACCESS_KEY = String(process.env.ACCESS_KEY || '').trim()
if (ACCESS_KEY) {
  app.use('/api', (req, res, next) => {
    if (req.path === '/config') return next()
    if (String(req.headers['x-access-key'] || '').trim() === ACCESS_KEY) return next()
    res.status(401).json({ detail: '需要访问密钥：在 Config 页填 Access Key（后端环境变量 ACCESS_KEY）' })
  })
  console.log('[neverattend] ACCESS_KEY 已启用：/api/* 需要 X-Access-Key')
}

app.use('/api', apiRouter)

app.get('/healthz', (req, res) => {
  res.json({ ok: true, mode: config.tyys.mock ? 'mock' : 'live', watch: watcher.state() })
})

const staticDir = config.staticDir
const indexFile = path.join(staticDir, 'index.html')

// 每次都按磁盘现状判断：先构建前端再启动/热更都能立刻生效
app.use(express.static(staticDir, { index: false, maxAge: '1h' }))
app.get('*', (req, res) => {
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile)
  res.type('html').send(
    '<!doctype html><meta charset="utf-8"><title>NeverAttend</title>' +
    '<body style="font:16px/1.6 system-ui;max-width:720px;margin:12vh auto;padding:0 24px">' +
    '<h1>NeverAttend</h1><p>后端已启动，前端尚未构建。</p>' +
    '<pre style="background:#f4f4f5;padding:16px;border-radius:8px">cd frontend\nnpm install\nnpm run build</pre>' +
    `<p>当前模式：<b>${config.tyys.mock ? 'mock' : 'live'}</b>，轮询间隔 ${config.watch.intervalMs} ms。</p></body>`
  )
})

const server = app.listen(config.port, () => {
  pushEvent('success', 'boot', `NeverAttend 启动于 http://localhost:${config.port}（${config.tyys.mock ? 'mock' : 'live'} 模式）`)
  console.log(`[neverattend] listening on http://localhost:${config.port}  mode=${config.tyys.mock ? 'mock' : 'live'}`)
  // 守护进程常驻：每 10s 轮询一次，发现待签到即自动签到
  watcher.start({ intervalMs: config.watch.intervalMs, autoCheckin: config.watch.autoCheckin })
  console.log(`[neverattend] watcher started, interval=${config.watch.intervalMs}ms autoCheckin=${config.watch.autoCheckin}`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    watcher.stop()
    server.close(() => process.exit(0))
  })
}
