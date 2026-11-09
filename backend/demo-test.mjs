// 验证 GitHub Pages 演示构建：首屏绑定 → 签到 8 步 → 守护轮询，全程无后端
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9334
const URL = process.env.DEMO_URL || 'http://localhost:8088/'
const OUT = '../shots'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/Richa/AppData/Local/Temp/na-cdp-demo',
  '--window-size=1280,1800',
  'about:blank'
], { stdio: 'ignore' })

const targets = async () => {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json() } catch { await sleep(300) }
  }
  throw new Error('CDP 未就绪')
}

const list = await targets()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id
  pending.set(mid, res)
  ws.send(JSON.stringify({ id: mid, method, params }))
})
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) return 'EXC: ' + r.result.exceptionDetails.text
  return r.result?.result?.value
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'))
  console.log('saved', name)
}
const setInput = (selector, value) => evalJs(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'missing ' + ${JSON.stringify(selector)};
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`)

await send('Page.enable')
await send('Runtime.enable')

// 收集控制台错误，确认没有未捕获异常
const errors = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text)
})

await send('Page.navigate', { url: URL + '#/first-time' })
await sleep(2200)
await shot('09-demo-first-time')

console.log('fill user:', await setInput('input.input[type="text"], input.input', '32401000001'))
const passSel = await evalJs(`(() => { const xs=[...document.querySelectorAll('input')]; const p=xs.find(i=>i.type==='password'); return p ? 'found' : 'no-password' })()`)
console.log('password input:', passSel)
console.log('fill pass:', await evalJs(`(() => {
  const p = [...document.querySelectorAll('input')].find(i => i.type === 'password');
  if (!p) return 'no-password';
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(p, 'demo1234');
  p.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`))
await sleep(300)
console.log('click bind:', await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(n => n.innerText.includes('登录并绑定')); if (!b) return 'no-button'; b.click(); return 'clicked' })()`))
await sleep(1800)
await shot('10-demo-bound')

await send('Page.navigate', { url: URL + '#/' })
await sleep(2200)
await shot('11-demo-run')

console.log('click signin:', await evalJs(`(() => { const b = document.querySelector('.session.open .btn'); if (!b) return 'no-button'; b.click(); return 'clicked' })()`))
await sleep(4600)
await shot('12-demo-checkin-done')

console.log('start watch:', await evalJs(`(() => {
  const t = [...document.querySelectorAll('.tab')].find(n => n.innerText.includes('自动签到'));
  t && t.click();
  return 'tab';
})()`))
await sleep(500)
console.log('watch button:', await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(n => n.innerText.includes('启动守护')); if (!b) return 'no-start-button'; b.click(); return 'clicked' })()`))
await sleep(7000)
await shot('13-demo-watch')

console.log('result:', await evalJs(`JSON.stringify({
  demo: document.body.innerText.includes('MOCK 模式'),
  done: document.body.innerText.includes('签到完成'),
  watch: document.body.innerText.match(/自动签到 \\d+ 次/)?.[0] || null,
  errors: ${JSON.stringify(errors)}
})`))

ws.close()
child.kill()
process.exit(0)
