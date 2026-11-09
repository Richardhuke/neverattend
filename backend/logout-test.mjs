// 验证：登录后点「退出」→ 回到 #/first-time 且 localStorage 凭据清空
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9336
const URL = process.env.DEMO_URL || 'http://localhost:8088/'
const OUT = '../shots'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/Richa/AppData/Local/Temp/na-cdp-out2',
  '--window-size=1280,1200', 'about:blank'], { stdio: 'ignore' })

const targets = async () => {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json() } catch { await sleep(300) }
  }
  throw new Error('CDP 未就绪')
}
console.log('edge spawned, waiting cdp...')
const page = (await targets()).find((t) => t.type === 'page')
console.log('cdp page ok')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params }))
})
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'))
  console.log('saved', name)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: URL + '#/first-time' })
await sleep(2600)

// 绑定一个账号
const fill = async (selector, val) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'no-input';
  const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  d.set.call(el, ${JSON.stringify(val)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`)
console.log('fill user:', await fill('input:not([type=password])', '32401000002'))
console.log('fill pass:', await fill('input[type=password]', 'demo1234'))
console.log('click bind:', await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(n=>n.innerText.includes('登录并绑定')); if(!b) return 'no-button'; b.click(); return 'clicked' })()`))
await sleep(2400)
console.log('hash after bind:', await evaluate('location.hash'))
console.log('enter run:', await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(n=>n.innerText.includes('进入 Run')); if(!b) return 'no-enter'; b.click(); return 'clicked' })()`))
await sleep(2000)
await shot('14-logout-button')

const before = await evaluate(`JSON.stringify({hash: location.hash, hasBtn: !!document.querySelector('.who-out'), ls: Object.keys(localStorage)})`)
await evaluate(`document.querySelector('.who-out').click()`)
await sleep(1200)
const after = await evaluate(`JSON.stringify({hash: location.hash, hasBtn: !!document.querySelector('.who-out'), who: document.querySelector('.who-id')?.textContent, ls: Object.keys(localStorage)})`)
await shot('15-after-logout')
console.log('before', before)
console.log('after ', after)
ws.close()
