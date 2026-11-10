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
 * loginSvc 有时只返回一段「落地地址文本」（例如
 * http://www.tyys.zju.edu.cn/cgapp-server/cas/appLogin?ticket=ST-xxx ），
 * 真正带 token 的页面要再请求一次。这里把它跟到底。
 */
async function resolveLanding (text, am) {
  const raw = String(text || '').trim()
  let target = ''
  if (/^https?:\/\/\S+$/i.test(raw)) target = raw
  else {
    const rel = raw.match(/location(?:\.href)?\s*=\s*['"](https?:\/\/[^'"]+)['"]/i)
      || raw.match(/['"](https?:\/\/[^'"]*[?&]ticket=[^'"]+)['"]/i)
    if (rel) target = rel[1]
  }
  if (!target) return { body: raw, url: '' }
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
  // 必须复用 login-zju 内部的 cookie jar：tyys 落地页靠 JSESSIONID 认会话，
  // 裸 fetch 会丢 cookie，只能拿到 400 Invalid request。
  const pick = (url) => (am && typeof am.fetch === 'function'
    ? am.fetch(url, { redirect: 'follow' })
    : fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA } }))
  try {
    let url = target
    let html = ''
    // 落地页可能是 302 链，也可能是 meta refresh / JS 跳转，最多跟 4 跳
    for (let hop = 0; hop < 4; hop += 1) {
      const res = await pick(url)
      html = await res.text()
      url = res.url || url
      pushEvent('info', 'auth', `落地页 hop${hop} ${res.status}（${html.length} 字节）：${url}`)
      if (extractToken(html)) break
      const refresh = html.match(/http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/i)
      const jsLoc = html.match(/location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i)
      const next = (refresh && refresh[1]) || (jsLoc && jsLoc[1])
      if (!next) break
      try { url = new URL(next, url).toString() } catch { break }
    }
    return { body: html, url }
  } catch (e) {
    pushEvent('warn', 'auth', `跟随落地页失败：${e?.message || e}`)
    return { body: raw, url: target }
  }
}

export async function loginWithPassword (username, plainPassword) {
  if (IS_MOCK()) {
    pushEvent('info', 'auth', `[mock] 使用模拟账号 ${username} 通过 ZJUAM 登录`)
    return { username, token: mockToken(username), xh: username, xm: '模拟用户', xymc: '求是学院' }
  }
  const { ZJUAM } = await import('login-zju')
  const am = new ZJUAM(username, plainPassword)
  const service = config.tyys.casService || `${config.tyys.base}${config.tyys.endpoints.casLogin}`
  const first = await am.loginSvc(service)
  const landing = await resolveLanding(first, am)
  const hit = extractToken(landing.body) || extractToken(first)
  if (!hit) {
    const saved = dumpHtml(`<!-- landing url: ${landing.url} -->
<!-- loginSvc: -->
${first}
<!-- landing body: -->
${landing.body}`)
    throw new Error(`CAS 登录成功，但未能在返回页面中提取 token（落地页 ${landing.url || '未知'}，${landing.body.length} 字节）${saved ? `；已存到 ${saved}` : ''}`)
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
