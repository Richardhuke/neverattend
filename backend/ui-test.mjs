// Edge headless + CDP：注入凭据 → 点「签到」→ 截 8 步时间轴
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9333
const OUT = '../shots'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/Richa/AppData/Local/Temp/na-cdp-profile2',
  '--window-size=1280,1800',
  'about:blank'
], { stdio: 'ignore' })

async function targets () {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json() } catch { await sleep(300) }
  }
  throw new Error('CDP 未就绪')
}

const list = await targets()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))

let id = 0
const pending = new Map()
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}) => new Promise(res => {
  const mid = ++id
  pending.set(mid, res)
  ws.send(JSON.stringify({ id: mid, method, params }))
})
const evalJs = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}
const shot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  fs.writeFileSync(OUT + '/' + name + '.png', Buffer.from(r.result.data, 'base64'))
  console.log('saved', name)
}

// 先停守护，避免轮询把待签到场次抢走（截图要看手动签到的 8 步）
await fetch('http://localhost:8000/api/watch/stop', { method: 'POST' })
await sleep(500)

await send('Page.enable')
await send('Runtime.enable')

// 拿一个 mock token
const U = '32401' + String(Date.now()).slice(-6)
const tok = await (await fetch('http://localhost:8000/api/getToken', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: U, password: 'x' })
})).json()
console.log('token ok:', String(tok.token).slice(0, 18) + '...')

await send('Page.navigate', { url: 'http://localhost:8000/#/first-time' })
await sleep(1500)
await evalJs(`localStorage.setItem('neverattend-username','${tok.username}');localStorage.setItem('neverattend-token','${tok.token}');localStorage.setItem('neverattend-setup','1');'ok'`)
await send('Page.navigate', { url: 'http://localhost:8000/#/' })
await send('Page.reload', { ignoreCache: true })
await sleep(3000)
await shot('03-run-sorted')

console.log('click:', await evalJs(`(() => { const b = document.querySelector('.session.open .btn'); if (!b) return 'no-button'; b.click(); return 'clicked' })()`))

await sleep(600)
await shot('04-checkin-progress')
await sleep(2600)
await shot('05-checkin-done')

// 签退：回到场次列表，点「签退」
await evalJs(`(() => { const t = [...document.querySelectorAll('.tab')].find(n => n.innerText.includes('考勤场次')); t && t.click(); return 'tab' })()`)
await sleep(900)
console.log('signout click:', await evalJs(`(() => { const b = [...document.querySelectorAll('.session button')].find(n => n.innerText.trim() === '签退'); if (!b) return 'no-signout-button'; b.click(); return 'clicked' })()`))
await sleep(3200)
await shot('06-signout-done')

// 异地模式面板（先 reload 退出 runMode）
await send('Page.reload', { ignoreCache: true })
await sleep(2600)
await evalJs(`(() => { const t = [...document.querySelectorAll('.tab')].find(n => n.innerText.includes('立即签到')); t && t.click(); return 'tab' })()`)
await sleep(700)
console.log('away toggle:', await evalJs(`(() => { const c = document.querySelector('.switch input'); if (!c) return 'no-switch'; if (!c.checked) c.click(); return 'on:' + c.checked })()`))
await sleep(1200)
await shot('07-away-mode')

// 自动签到 / 签退面板
await fetch('http://localhost:8000/api/watch/start', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ intervalMs: 4000 })
})
await evalJs(`(() => { const t = [...document.querySelectorAll('.tab')].find(n => n.innerText.includes('自动签到')); t && t.click(); return 'tab' })()`)
await sleep(4500)
await shot('08-auto-watch')

console.log('state:', await evalJs(`JSON.stringify({
  done: document.body.innerText.includes('已完成'),
  body: document.body.innerText.slice(0, 260)
})`))

await fetch('http://localhost:8000/api/watch/start', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ intervalMs: 10000 })
})
ws.close()
child.kill()
process.exit(0)
