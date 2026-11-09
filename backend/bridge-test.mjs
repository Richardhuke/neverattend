// 验证：静态站（dist-demo）配置外部后端后，是否真的直连后端、且不再走 mock
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9339
const PROFILE = 'C:/Users/Richa/AppData/Local/Temp/na-cdp-bridge-q'
const SITE = "https://richardhuke.github.io/neverattend/?api=https://reservation-prime-keys-stops.trycloudflare.com"
const BACKEND = "https://reservation-prime-keys-stops.trycloudflare.com"
const shots = path.resolve('shots')

const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--window-size=1280,1705', 'about:blank'])

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function target () {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find(t => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(250)
  }
  throw new Error('no target')
}

const ws = new WebSocket(await target())
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || ''))
  return r.result?.result?.value
}
const shot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(r.result.data, 'base64'))
}

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: SITE })
await sleep(2500)
await evalJs(`localStorage.setItem('neverattend-username','32401000001'); localStorage.setItem('neverattend-token','demo.MzI4MDEwMDAwMDE=.sig'); localStorage.setItem('neverattend-setup','1'); 1`)
await send('Page.reload', { ignoreCache: true })
await sleep(3000)

const state = await evalJs(`(async () => {
  const cfg = await (await fetch(${JSON.stringify(BACKEND)} + '/api/config')).json()
  return { hash: location.hash, cfgMode: cfg.mode, hasBanner: !!document.body.innerText.includes('当前是演示数据'), text: document.body.innerText.slice(0, 400) }
})()`)
console.log('state', JSON.stringify(state))

await send('Page.navigate', { url: SITE + '#/config' })
await sleep(2500)
const cfgText = await evalJs(`document.body.innerText`)
console.log('config page has Backend card:', cfgText.includes('后端地址'), '| chip:', (cfgText.match(/Backend[\s\S]{0,40}/) || [''])[0].replace(/\n/g, ' '))
await shot('16-backend-config')

// 清掉地址，回到演示
await evalJs(`localStorage.removeItem('neverattend-api-base'); 1`)
await send('Page.reload', { ignoreCache: true })
await sleep(2500)
const demo = await evalJs(`({ hash: location.hash, banner: document.body.innerText.includes('当前是演示数据') })`)
console.log('after clear', JSON.stringify(demo))
await shot('17-back-to-demo')

ws.close(); edge.kill()
process.exit(0)
