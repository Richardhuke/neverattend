import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { config } from './config.js'
import apiRouter from './routes/api.js'
import { watcher } from './services/watcher.js'
import { pushEvent } from './store.js'

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))

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
