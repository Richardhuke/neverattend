import fs from 'node:fs'
import path from 'node:path'
import { Jar, cachedAm } from './zjuam.js'
import { pushEvent } from '../store.js'

/**
 * 手机 App（浙大体艺 net.crigh.mysport）的接口层。
 *
 * 从 APK（assets/csn-enc.data 里切出来的 payload1.dex）里拿到的常量：
 *   base        http://www.tyys.zju.edu.cn/cgapp-server
 *   App 登录     /cgapp-server/cas/appLogin   （CAS service，浏览器直接打会 302 到 zjuam）
 *   签到         /app/signToGrant
 *   我的签到     /app/mySignList
 *   我的考勤     /app/v2/myattendance
 *   我的管理     /app/v2/mymanage
 * 常量池里跟凭据有关的裸串只有 `token` / `Token` 两种写法，
 * 没有 Authorization / X-Token / appToken，所以凭据走 `token` 头（或同名 query）。
 */

export const APP_BASE = 'http://www.tyys.zju.edu.cn/cgapp-server'
/** 安卓 UA：App 侧的接口对桌面 UA 未必同待遇，统一按手机报头 */
const UA_MOBILE = 'okhttp/3.12.13'
const UA_WEB = 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

function dump (name, text) {
  const target = path.join(process.cwd(), 'logs', `${name}.txt`)
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, String(text))
    return target
  } catch {
    return ''
  }
}

/** 从 appLogin 的响应里挖 token：JSON 优先，其次 query/location 上的 token */
export function extractAppToken (text) {
  const t = String(text || '')
  let json = null
  try {
    json = JSON.parse(t)
  } catch {}
  const pick = (o) => {
    if (!o || typeof o !== 'object') return ''
    for (const k of ['token', 'Token', 'access_token', 'accessToken', 'jwt']) {
      if (typeof o[k] === 'string' && o[k].length >= 8) return o[k]
    }
    for (const k of ['data', 'result', 'obj', 'user']) {
      const v = pick(o[k])
      if (v) return v
    }
    return ''
  }
  const fromJson = pick(json)
  if (fromJson) return fromJson
  const q = t.match(/[?&](?:token|access_token)=([A-Za-z0-9._%\-]{8,})/)
  if (q) return decodeURIComponent(q[1])
  const kv = t.match(/["']?(?:token|accessToken)["']?\s*[:=]\s*["']([A-Za-z0-9._\-]{8,})["']/i)
  if (kv) return kv[1]
  return ''
}

/**
 * 用已缓存的 ZJUAM 会话换一张 App 票据，换完拿到 /cgapp-server 自己的会话与 token。
 * 返回 { location, status, body, url, jar, token, hops[] }
 */
export async function appLogin (username) {
  const am = cachedAm(username)
  if (!am) throw new Error('没有可复用的登录会话：请先在页面上用学号密码登录一次（服务重启后需要重新登录）')

  const service = `${APP_BASE}/cas/appLogin`
  let loc
  try {
    loc = await am.loginSvc(service)
  } catch (e) {
    throw new Error(`换 App 票据失败：${e?.message || e}`)
  }
  if (typeof loc !== 'string' || !loc) throw new Error(`换 App 票据失败：CAS 没有返回跳转地址（${JSON.stringify(loc)}）`)
  pushEvent('info', 'app', `App 票据已签发：${loc.slice(0, 120)}${loc.length > 120 ? '…' : ''}`)

  const jar = new Jar()
  const hops = []
  let url = loc
  let body = ''
  let status = 0
  for (let i = 0; i < 10; i += 1) {
    const headers = {
      'User-Agent': UA_MOBILE,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: `${APP_BASE}/`
    }
    const cookie = jar.header(url)
    if (cookie) headers.Cookie = cookie
    let res
    try {
      res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(25000) })
    } catch (e) {
      hops.push({ url, error: String(e?.message || e) })
      break
    }
    jar.absorb(res, url)
    status = res.status
    const next = res.headers.get('location') || ''
    hops.push({ url, status, location: next, setCookie: jar.size() })
    if (status >= 300 && status < 400 && next) {
      url = next.startsWith('http') ? next : new URL(next, url).toString()
      continue
    }
    body = await res.text()
    break
  }

  const token = extractAppToken(body) || extractAppToken(url)
  const jarDump = jar.dump()
  const saved = dump('applogin', `# ${loc}\n# hops\n${JSON.stringify(hops, null, 2)}\n\n${body}`)
  pushEvent(
    token ? 'success' : 'warn',
    'app',
    `App 登录结束：${status} ${body.length} 字，cookie ${jarDump.length} 条，token ${token ? `已拿到（${token.slice(0, 12)}…）` : '未找到'}${saved ? `，原文 ${saved}` : ''}`
  )
  return { location: loc, status, body, url, jar: jarDump, token, hops }
}

/** 带 App 凭据请求 /app/**：token 头 + cookie 同时带，兼容服务端两种取法 */
export async function appFetch (rec, p, opts = {}) {
  const jar = Jar.load(rec?.jar)
  const url = /^https?:\/\//i.test(p) ? p : `${APP_BASE}${String(p).startsWith('/') ? '' : '/'}${p}`
  const headers = {
    'User-Agent': opts.mobile ? UA_MOBILE : UA_WEB,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: `${APP_BASE}/`
  }
  if (rec?.token && opts.auth !== 'none') {
    const name = opts.tokenHeader || 'token'
    headers[name] = rec.token
    if (name === 'Authorization') headers[name] = `Bearer ${rec.token}`
  }
  const cookie = jar.header(url)
  if (cookie) headers.Cookie = cookie
  if (opts.contentType) headers['Content-Type'] = opts.contentType
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(25000)
  })
  jar.absorb(res, url)
  const text = await res.text()
  return {
    status: res.status,
    location: res.headers.get('location') || '',
    body: text,
    url,
    jar: jar.dump()
  }
}

/**
 * 用几种常见凭据形态轮流打同一个接口，看服务端认哪一种。
 * 返回 [{ variant, status, len, land, head }]，land 是 302 时的落点。
 */
export async function probeToken (rec, p) {
  const variants = [
    { name: 'no-auth', auth: 'none' },
    { name: 'token-header', tokenHeader: 'token' },
    { name: 'Token-header', tokenHeader: 'Token' },
    { name: 'Authorization-Bearer', tokenHeader: 'Authorization' },
    { name: 'cookie-only', auth: 'none' }
  ]
  const out = []
  for (const v of variants) {
    const use = v.name === 'cookie-only' ? { jar: rec?.jar, token: '' } : res0(rec, v)
    try {
      const r = await appFetch(use, p, v)
      out.push({
        variant: v.name,
        status: r.status,
        len: r.body.length,
        land: r.location,
        head: r.body.slice(0, 300)
      })
    } catch (e) {
      out.push({ variant: v.name, error: String(e?.message || e) })
    }
  }
  return out
}

function res0 (rec, v) {
  return { jar: rec?.jar, token: v.auth === 'none' ? '' : rec?.token }
}
