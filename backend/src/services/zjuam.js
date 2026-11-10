import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { pushEvent } from '../store.js'

const IS_MOCK = () => config.tyys.mock

/** 解密前端送来的密码（AES-256-CBC，IV 前置，整包 base64） */
export function decodePassword (encoded) {
  const { passphrase, salt } = config.codec
  const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256')
  const buf = Buffer.from(encoded, 'base64')
  if (buf.length <= 16) throw new Error('密码密文格式不正确')
  const iv = buf.subarray(0, 16)
  const data = buf.subarray(16)
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([d.update(data), d.final()]).toString('utf8')
}

export function encodePassword (plain) {
  const { passphrase, salt } = config.codec
  const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256')
  const iv = crypto.randomBytes(16)
  const c = crypto.createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([iv, c.update(plain, 'utf8'), c.final()]).toString('base64')
}

// 从 tyys 首屏 HTML 里抽 (学号, JWT)：先按已知的 window.app.getUserName 形态，
// 再退化为「JWT 形态串 + 学号」扫描，最后退化 key=value。任何一步命中即可。
export function extractToken (html) {
  const text = String(html || '')
  const pairs = [
    /window\.app\.getUserName\(\s*['"](\d{6,})['"]\s*,\s*['"]([^'"]+)['"]\s*\)/,
    /getUserName\(\s*['"](\d{6,})['"]\s*,\s*['"]([^'"]+)['"]/,
    /getUserInfo\(\s*['"](\d{6,})['"]\s*,\s*['"]([^'"]+)['"]/
  ]
  for (const re of pairs) {
    const m = text.match(re)
    if (m) return { xh: m[1], token: m[2], via: 'app-call' }
  }
  const jwt = text.match(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/)
  const xh = text.match(/\b(3\d{9})\b/)
  if (jwt) return { xh: xh ? xh[1] : '', token: jwt[0], via: 'jwt-scan' }
  const kv = text.match(/["']?token["']?\s*[:=]\s*["']([A-Za-z0-9._-]{20,})["']/i)
  if (kv) return { xh: xh ? xh[1] : '', token: kv[1], via: 'token-kv' }
  return null
}

/** 登录失败时把首屏 HTML 落盘，供 /api/debug/login-html 取回分析 */
function dumpHtml (html) {
  const target = process.env.DUMP_HTML || path.join(process.cwd(), 'logs', 'last-login.html')
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, String(html))
    pushEvent('info', 'auth', `已把 tyys 首屏 HTML 落盘：${target}`)
    return target
  } catch (e) {
    pushEvent('warn', 'auth', `HTML 落盘失败：${e?.message || e}`)
    return ''
  }
}

/**
 * 账密模式：服务端走 ZJUAM CAS 登录 tyys，拿到 H5 首屏里内联下发的 JWT。
 * 与 NeverRun 的 api/getToken 等价。
 */

/**
 * tyys 的登录不是一次跳转。实测链路：
 *   /cgapp-server/loginto            → 302 /ggtypt/login?service=…/toSysLogin
 *   /ggtypt/login?service=…          → 200 <script>location='…cas/login?service=…/ggtypt/dologin'
 *   cas/login?service=…/dologin      → 302 /ggtypt/dologin?ticket=ST-…      （CAS 发 ST）
 *   /ggtypt/dologin?ticket=ST-…      → 302 /cgapp-server/toSysLogin?ticket=… （换成业务 ticket）
 *   /cgapp-server/toSysLogin?ticket=…→ 302 H5 首屏（内含 window.app.getUserName('xh','JWT')）
 * 每一跳都可能下发新的 JSESSIONID（/ggtypt 与 /cgapp-server 各一套 Cookie 路径），
 * 所以必须 redirect:'manual' 逐跳走，让 login-zju 的 cookie jar 收齐；跟随后再取 body。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0'

/**
 * 极简 cookie jar。必须按 (host, path, name) 存：整条链上 tyys.zju.edu.cn 和
 * www.tyys.zju.edu.cn 会各下发一个同名 JSESSIONID（路径分别是 /cgapp-server 和 /ggtypt），
 * 任何按「名字」去重的 jar 都会互相覆盖，导致最后访问 /cgapp-server/home 时带错会话，
 * 服务端就回「对不起，您暂时没有权限访问此系统…-2」。
 */
function defaultPath (url) {
  const p = new URL(url).pathname
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

function parseSetCookie (line, url) {
  const parts = String(line).split(';')
  const pair = parts.shift() || ''
  const eq = pair.indexOf('=')
  if (eq < 0) return null
  const host = new URL(url).hostname.toLowerCase()
  let domain = host
  let hostOnly = true
  let path = defaultPath(url)
  for (const attr of parts) {
    const [k, ...rest] = attr.split('=')
    const key = k.trim().toLowerCase()
    const val = rest.join('=').trim()
    if (key === 'domain' && val) { domain = val.replace(/^\./, '').toLowerCase(); hostOnly = false }
    else if (key === 'path' && val) path = val
  }
  return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain, hostOnly, path }
}

class Jar {
  items = []

  set (cookie) {
    this.items = this.items.filter((c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path))
    this.items.push(cookie)
  }

  absorb (res, url) {
    let list = []
    if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie()
    const single = res.headers.get('set-cookie')
    if (!list.length && single) list = [single]
    for (const line of list) {
      const c = parseSetCookie(line, url)
      if (c) this.set(c)
    }
  }

  header (url) {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    return this.items
      .filter((c) => (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`)))
      .filter((c) => u.pathname.startsWith(c.path) || c.path === '/')
      .map((c) => `${c.name}=${c.value}`)
      .join('; ')
  }

  size () { return this.items.length }
}

async function hop (jar, url) {
  const headers = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Upgrade-Insecure-Requests': '1'
  }
  const cookie = jar.header(url)
  if (cookie) headers.Cookie = cookie
  const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(25000) })
  jar.absorb(res, url)
  return res
}

async function walkLoginChain (am, maxHops = 14) {
  // 整条链都走非 www 域：/cgapp-server 的会话 cookie 只落在 tyys.zju.edu.cn 上
  const jar = new Jar()
  let url = 'http://tyys.zju.edu.cn/cgapp-server/loginto'
  let body = ''
  let landed = url
  for (let hopNo = 0; hopNo < maxHops; hopNo += 1) {
    let res
    try {
      res = await hop(jar, url)
    } catch (e) {
      pushEvent('warn', 'auth', `登录链 hop${hopNo} 请求失败：${e?.message || e}`)
      break
    }
    const text = await res.text()
    const loc = res.headers.get('location')
    pushEvent('info', 'auth', `登录链 hop${hopNo} ${res.status}（${text.length} 字节，cookie ${jar.size()}）${loc ? ` → ${loc}` : ''}`)
    landed = url
    let next = ''
    if (res.status >= 300 && res.status < 400 && loc) {
      next = new URL(loc, url).toString()
    } else {
      body = text
      if (extractToken(body)) break
      const js = body.match(/location(?:\.href)?\s*=\s*['"](https?:\/\/[^'"]+)['"]/i)
      if (res.status === 200 && js) next = js[1]
    }
    if (!next) break
    // 到 CAS 了：不跟着页面里的 service 猜，直接用已登录的 CAS 会话换一张该 service 的 ticket
    if (next.includes('zjuam.zju.edu.cn/cas/')) {
      const svc = new URL(next).searchParams.get('service')
      if (!svc) { pushEvent('warn', 'auth', 'CAS 跳转里没有 service 参数'); break }
      let ticketUrl = ''
      try {
        ticketUrl = await am.loginSvc(svc)
      } catch (e) {
        pushEvent('warn', 'auth', `换 ticket 失败：${e?.message || JSON.stringify(e)}`)
        break
      }
      if (!ticketUrl) { pushEvent('warn', 'auth', 'CAS 没返回带 ticket 的地址'); break }
      pushEvent('info', 'auth', `CAS 已签发 → ${ticketUrl.replace(/ticket=[^&]+/, 'ticket=***')}`)
      url = ticketUrl
      continue
    }
    url = next
  }
  if (!extractToken(body)) {
    pushEvent('info', 'auth', '登录链终点没有 token，改用同一会话探测 H5 入口')
    const probe = await probeTokenPages(jar)
    for (const line of probe.report) pushEvent('info', 'auth', `探测 ${line}`)
    if (probe.body) return { body: probe.body, url: probe.url }
    body = `${body}\n\n<!-- 探测报告 -->\n${probe.report.join('\n')}`
  }
  return { body, url: landed }
}

/**
 * 票据登录成功不等于拿到了 H5 首屏：/home 在部分账号上只回「没有权限」页。
 * 这里拿同一个已认证会话，把可能的 H5 入口都试一遍，谁吐出 window.app.getUserName 就用谁。
 */
async function probeTokenPages (jar) {
  const hosts = ['http://tyys.zju.edu.cn', 'http://www.tyys.zju.edu.cn']
  const paths = [
    '/cgapp-server/app/index.html',
    '/cgapp-server/index.html',
    '/cgapp-server/home',
    '/cgapp-server/',
    '/cgapp-server/toIndex',
    '/cgapp-server/app/'
  ]
  const report = []
  for (const host of hosts) {
    for (const p of paths) {
      const u = host + p
      let res
      try {
        res = await hop(jar, u)
      } catch (e) {
        report.push(`${u} 请求失败 ${e?.message || e}`)
        continue
      }
      if (res.status >= 300 && res.status < 400) {
        report.push(`${u} ${res.status} → ${res.headers.get('location') || ''}`)
        continue
      }
      const text = await res.text()
      const hit = extractToken(text)
      report.push(`${u} ${res.status} ${text.length} 字${hit ? ' HIT' : ''}`)
      if (hit) return { body: text, url: u, report }
    }
  }
  return { body: '', url: '', report }
}

export async function loginWithPassword (username, plainPassword) {
  if (IS_MOCK()) {
    pushEvent('info', 'auth', `[mock] 使用模拟账号 ${username} 通过 ZJUAM 登录`)
    return { username, token: mockToken(username), xh: username, xm: '模拟用户', xymc: '求是学院' }
  }
  const { ZJUAM } = await import('login-zju')
  const am = new ZJUAM(username, plainPassword)
  // 先建立 ZJUAM 会话（CASTGC），再沿 tyys 自己的跳转链走到底
  await am.login()
  const chain = await walkLoginChain(am)
  const hit = extractToken(chain.body)
  if (!hit) {
    const saved = dumpHtml(`<!-- chain landed: ${chain.url} -->
<!-- chain body: -->
${chain.body}`)
    const hint = /没有权限/.test(chain.body)
      ? '（链尾是 cgapp 的「没有权限」页：这张票据对应的会话没被认成该子系统的用户，通常是 cookie 串了域）'
      : ''
    throw new Error(`CAS 登录成功，但登录链终点没有 token（落点 ${chain.url || '未知'}，${chain.body.length} 字节）${hint}${saved ? `；已存到 ${saved}` : ''}`)
  }
  pushEvent('info', 'auth', `已从首屏提取 token（${hit.via}）`)
  const xh = hit.xh || username
  return { username: xh, token: hit.token, xh }
}

/**
 * Token 模式：用户自己在浏览器登录后把页面源码贴回来，前端已用同一正则抽出 (学号, token)。
 * 这里只做一次真实校验：带 token 拉一次用户信息。
 */
export async function verifyToken (username, token) {
  if (IS_MOCK()) {
    return { xh: username, xm: '模拟用户', xymc: '求是学院', token }
  }
  const info = await tyysFetch(token, config.tyys.endpoints.userInfo, { method: 'GET' })
  const xh = info?.xh || info?.data?.xh || username
  return { xh: String(xh), xm: info?.xm || info?.data?.xm || '', xymc: info?.xymc || info?.data?.xymc || '', token }
}

/** 带 JWT 访问 tyys 接口；token 同时放 header 与 query，兼容不同网关实现 */
export async function tyysFetch (token, endpoint, { method = 'POST', body, query } = {}) {
  const url = new URL(`${config.tyys.base}${endpoint}`)
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      token,
      Authorization: token,
      Accept: 'application/json, text/plain, */*'
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  })
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (!res.ok) {
    const detail = data?.msg || data?.message || data?.detail || text.slice(0, 200)
    throw new Error(`tyys ${endpoint} ${res.status}: ${detail}`)
  }
  return data
}

export function mockToken (username) {
  const payload = Buffer.from(JSON.stringify({ sub: username, iat: Date.now() })).toString('base64url')
  return `mock.${payload}.sig`
}

// 仅用于本地联调：验证跨域同名 JSESSIONID 不会被互相覆盖
export const __test = { Jar, hop, walkLoginChain }
