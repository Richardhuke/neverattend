import { spawn } from 'node:child_process'
import fs from 'node:fs'

const URL_BASE = process.argv[2] || 'https://fabric-ear-also-romantic.trycloudflare.com'
const KEY = process.argv[3] || 'thgc8exk73v2wy9j4pbd'
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PROFILE = 'C:/Users/Richa/AppData/Local/Temp/na-pub-' + Date.now()
const PORT = 9411

const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1280,1500', 'about:blank'], { stdio: 'ignore' })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function wsUrl () {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find(t => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(400)
  }
  throw new Error('no cdp')
}

const ws = new WebSocket(await wsUrl())
await new Promise(r => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id
  pending.set(mid, res)
  ws.send(JSON.stringify({ id: mid, method, params }))
})

await send('Page.enable')
await send('Runtime.enable')
const target = `${URL_BASE}/?key=${KEY}#/`
await send('Page.navigate', { url: target })
await sleep(9000)

const probe = await send('Runtime.evaluate', {
  expression: `JSON.stringify({hash: location.hash, text: document.body.innerText.slice(0,600), hasMockBanner: document.body.innerText.includes('演示数据'), cfg: localStorage.getItem('neverattend-api-base')})`,
  returnByValue: true
})
console.log('PROBE', probe.result?.result?.value)

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
if (shot.result?.data) {
  fs.writeFileSync('shots/18-public-live.png', Buffer.from(shot.result.data, 'base64'))
  console.log('SHOT shots/18-public-live.png')
}
ws.close()
proc.kill()
