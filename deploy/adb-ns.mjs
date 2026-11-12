#!/usr/bin/env node
/**
 * adb-ns.mjs — 用数据线（adb）驱动手机在「浙大体艺」App 里点签到/签退，并把结果回报给 NeverAttend。
 *
 * 与 autojs-ns.js 的区别：逻辑跑在电脑上，手机不用装任何脚本、不用开无障碍。
 * 前提：手机已开「开发者选项 → USB 调试」，插线后手机上点了「允许」。
 *
 * 用法：
 *   node deploy/adb-ns.mjs --once            # 只扫一次（调试）
 *   node deploy/adb-ns.mjs                   # 常驻轮询
 *   node deploy/adb-ns.mjs --plan            # 只走到课程排课并打印今天的计划，不点
 *   node deploy/adb-ns.mjs --dump            # 只打印当前界面上所有可点节点（定位按钮用）
 *   node deploy/adb-ns.mjs --shot out.png    # 截一张图
 *
 * 环境变量（都可不设）：
 *   NA_DATE=2026-11-12     假装今天是这天（干跑用）
 *   NA_TIME=17:12          假装现在是这个点（干跑用）
 *   NA_START_FROM=17:00    动作时间窗起点，之前只 idle
 *   NA_OUT_FROM=17:50      到这个点后改为点「签退」
 *   NA_END_AT=18:20        时间窗终点，之后 idle
 *   NA_COURSE=身体素质课    课程名
 *   NA_MOCK=30.302331,120.089136  开跑前把 GPS 覆盖到这个坐标（纬度,经度）
 *   NA_MOCK_ACC=5          模拟定位的精度（米）
 *
 * 依赖：adb.exe（默认 C:\Users\Richa\adbdl\platform-tools\adb.exe，可用 --adb 覆盖）
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const pexec = promisify(execFile)

const APP_PKG = 'net.crigh.mysport'

const CONFIG = {
  server: process.env.NA_SERVER || 'https://fabric-ear-also-romantic.trycloudflare.com',
  key: process.env.NA_KEY || 'thgc8exk73v2wy9j4pbd',
  username: process.env.NA_USER || '3260103483',
  adb: process.env.NA_ADB || 'C:\\Users\\Richa\\adbdl\\platform-tools\\adb.exe',
  serial: process.env.NA_SERIAL || '',
  interval: Number(process.env.NA_INTERVAL || 8000),
  cooldown: Number(process.env.NA_COOLDOWN || 90000),
  courseName: process.env.NA_COURSE || '身体素质课',
  outFrom: process.env.NA_OUT_FROM || '17:50',
  startFrom: process.env.NA_START_FROM || '17:00',
  endAt: process.env.NA_END_AT || '18:20',
  mock: process.env.NA_MOCK || ''
}

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const arg = (f, d) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}

function adbArgs (rest) {
  return CONFIG.serial ? ['-s', CONFIG.serial, ...rest] : rest
}

async function adb (rest, opts = {}) {
  const { stdout } = await pexec(CONFIG.adb, adbArgs(rest), {
    maxBuffer: 32 * 1024 * 1024,
    timeout: opts.timeout || 30000,
    encoding: 'utf8'
  })
  return stdout
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- 设备 ---------- */

async function devices () {
  const out = await adb(['devices'])
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, state] = l.split(/\s+/)
      return { serial, state }
    })
}

async function requireDevice () {
  const list = await devices()
  const ok = list.filter((d) => d.state === 'device')
  if (!ok.length) {
    const unauthorized = list.filter((d) => d.state === 'unauthorized')
    throw new Error(
      unauthorized.length
        ? '手机已插上但还没授权：请解锁手机，在「允许 USB 调试吗？」弹窗点「允许」（勾上"一律允许"）'
        : '没检测到设备：检查数据线是否支持传输、手机是否开了「开发者选项 → USB 调试」'
    )
  }
  if (!CONFIG.serial) CONFIG.serial = ok[0].serial
  return ok[0].serial
}

async function wake () {
  try { await adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']) } catch {}
  try { await adb(['shell', 'wm', 'dismiss-keyguard']) } catch {}
}

/* 不在前台就把 App 拉到前台（等价于点桌面图标） */
async function launchApp () {
  try {
    await adb(['shell', 'monkey', '-p', APP_PKG, '-c', 'android.intent.category.LAUNCHER', '1'])
    return true
  } catch {
    return false
  }
}

/* ---------- 模拟定位：用系统测试 provider 覆盖 GPS，不需要第三方 App ---------- */
const MOCK_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/
let mockReady = false

async function ensureMockProvider () {
  if (mockReady) return
  try { await adb(['shell', 'appops', 'set', 'com.android.shell', 'android:mock_location', 'allow']) } catch {}
  try { await adb(['shell', 'cmd', 'location', 'providers', 'add-test-provider', 'gps']) } catch {}
  try { await adb(['shell', 'cmd', 'location', 'providers', 'set-test-provider-enabled', 'gps', 'true']) } catch {}
  mockReady = true
}

async function setMockLocation (lat, lng, acc) {
  await ensureMockProvider()
  // 反检测：真人 GPS 不会每次都在同一个点、精度也不会恒为 5 m
  // NA_JITTER = 抖动半径（米，默认 8，设 0 关闭）；NA_MOCK_ACC = 固定精度（不给就 6-18 随机）
  const jitter = Number(process.env.NA_JITTER ?? 8)
  let la = Number(lat)
  let ln = Number(lng)
  if (jitter > 0) {
    const r = jitter * Math.sqrt(Math.random())
    const th = Math.random() * Math.PI * 2
    la += (r * Math.cos(th)) / 111320
    ln += (r * Math.sin(th)) / (111320 * Math.cos((la * Math.PI) / 180))
  }
  const fixedAcc = Number(process.env.NA_MOCK_ACC || 0)
  const accuracy = acc || fixedAcc || Math.round(6 + Math.random() * 12)
  await adb(['shell', 'cmd', 'location', 'providers', 'set-test-provider-location', 'gps',
    '--location', la.toFixed(6) + ',' + ln.toFixed(6), '--accuracy', String(accuracy)])
  return { lat: la, lng: ln, accuracy }
}

/* ---------- 导航：首页 → 身体素质课考勤 → 课程列表 → 课程排课 ---------- */

/* 文本归一化：去掉 uiautomator 的 &#10; 换行实体与所有空白 */
function norm (t) {
  return String(t || '').replace(/&#10;|&#13;|\n/g, '').replace(/[\s　]+/g, '')
}

function tapAt (n, label) {
  console.log(`[nav] 点「${label}」 @ (${n.x},${n.y})`)
  return adb(['shell', 'input', 'tap', String(n.x), String(n.y)])
}

function findByText (nodes, keyword, { minW = 0, minH = 0, exact = false } = {}) {
  const hit = nodes.find((n) => {
    const t = norm((n.text || '') + (n.desc || ''))
    if (exact ? t === keyword : !t.includes(keyword)) return false
    return n.w >= minW && n.h >= minH
  })
  return hit || null
}

/* 判断当前在哪一页 */
function pageOf (nodes) {
  const t = norm(nodes.map((n) => (n.text || '') + (n.desc || '')).join('\n'))
  if (/课程排课/.test(t) && /第\d+次课/.test(t)) return 'schedule'
  if (/签到时间/.test(t) && /GPS考勤|二维码/.test(t)) return 'sign'
  if (/我的记录/.test(t)) return 'record'
  if (/课程列表/.test(t) && t.includes(CONFIG.courseName)) return 'list'
  if (t.includes(`${CONFIG.courseName}考勤`) || /修学记录/.test(t)) return 'home'
  return 'other'
}

/* 把界面推进到「课程排课」，返回最后的节点表 */
async function gotoSchedule (nodes) {
  for (let step = 0; step < 6; step++) {
    const page = pageOf(nodes)
    if (page === 'schedule') return nodes
    if (page === 'record') {
      const tab = findByText(nodes, '课程排课', { minW: 80 })
      if (tab) {
        await tapAt(tab, '课程排课 tab')
      } else {
        console.log('[nav] 在「我的记录」页，返回上一层')
        await adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
      }
      await sleep(1800)
      nodes = parseNodes(await dumpUi())
      continue
    } else if (page === 'list') {
      const row = findByText(nodes, CONFIG.courseName, { minW: 400 })
      if (row) { await tapAt(row, CONFIG.courseName); await sleep(2000); nodes = parseNodes(await dumpUi()); continue }
    } else if (page === 'home') {
      const entry = findByText(nodes, `${CONFIG.courseName}考勤`, { minW: 80 })
      if (entry) { await tapAt(entry, `${CONFIG.courseName}考勤`); await sleep(2500); nodes = parseNodes(await dumpUi()); continue }
    }
    // 兜底：退一层再看（最多 3 次，避免退到桌面）
    if (step < 3) {
      console.log(`[nav] 认不出页面（${page}），退一层`)
      await adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
      await sleep(1500)
      nodes = parseNodes(await dumpUi())
      continue
    }
    break
  }
  return nodes
}

/* 从「第N次课 YYYY-MM-DD」里挑今天的课次 */
const ROW_RE = /第(\d+)次课(\d{4}-\d{2}-\d{2})/

function todayStr () {
  if (process.env.NA_DATE) return process.env.NA_DATE
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function findTodayRow (nodes) {
  const today = todayStr()
  for (const n of nodes) {
    const t = norm(n.text)
    const m = t.match(ROW_RE)
    if (m && m[2] === today) return { no: Number(m[1]), date: m[2], y: n.y, node: n }
  }
  return null
}

/* 取同一行上的「签到」/「签退」按钮 */
function rowButton (nodes, row, keyword) {
  const cands = nodes.filter((n) => {
    const t = norm((n.text || '') + (n.desc || ''))
    return t === keyword && n.w > 40 && n.h > 20 && Math.abs(n.y - row.y) <= 70
  })
  if (!cands.length) return null
  // 同一按钮常有 desc 与 text 两个节点，取可点击的
  cands.sort((a, b) => Number(b.clickable) - Number(a.clickable))
  return cands[0]
}

async function focusedPackage () {
  try {
    const out = await adb(['shell', 'dumpsys', 'window'])
    const m = out.match(/mCurrentFocus=Window\{[^}]*\s([\w.]+)\/[\w.$]+/)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

/* ---------- UI 解析 ---------- */

const BOUNDS_RE = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/

export function parseNodes (xml) {
  const nodes = []
  const re = /<node\b[^>]*\/?>/g
  let m
  while ((m = re.exec(xml))) {
    const tag = m[0]
    const attr = (name) => {
      const a = tag.match(new RegExp(`${name}="([^"]*)"`))
      return a ? a[1] : ''
    }
    const b = tag.match(BOUNDS_RE)
    if (!b) continue
    const [x1, y1, x2, y2] = b.slice(1).map(Number)
    nodes.push({
      text: attr('text'),
      desc: attr('content-desc'),
      id: attr('resource-id'),
      cls: attr('class'),
      clickable: attr('clickable') === 'true',
      enabled: attr('enabled') !== 'false',
      x: Math.round((x1 + x2) / 2),
      y: Math.round((y1 + y2) / 2),
      w: x2 - x1,
      h: y2 - y1,
      raw: tag
    })
  }
  return nodes
}

async function dumpUi () {
  await adb(['shell', 'uiautomator', 'dump', '/sdcard/na-ui.xml'], { timeout: 20000 })
  const xml = await adb(['exec-out', 'cat', '/sdcard/na-ui.xml'], { timeout: 20000 })
  return xml
}

/* 找「签到 / 签退」按钮：文案包含关键词、可见、有尺寸、不是"已签到/签到记录/待签到" */
const EXCLUDE = ['已签到', '已签退', '签到记录', '待签到', '签到成功', '签退成功', '签到时间', '签退时间']

export function findButton (nodes, keyword) {
  const cands = nodes.filter((n) => {
    const t = (n.text || '') + (n.desc || '')
    if (!t.includes(keyword)) return false
    if (EXCLUDE.some((e) => t.includes(e))) return false
    if (n.w < 40 || n.h < 20) return false
    return true
  })
  if (!cands.length) return null
  // 优先可点击的、文字短的（"签退" 比 "第 5 周 身体素质课 签退" 更像按钮）
  cands.sort((a, b) => {
    if (a.clickable !== b.clickable) return a.clickable ? -1 : 1
    return (a.text || '').length - (b.text || '').length
  })
  return cands[0]
}

/* ---------- 回报 ---------- */

async function report (action, note) {
  const res = await fetch(`${CONFIG.server}/api/phone/report`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Access-Key': CONFIG.key
    },
    body: JSON.stringify({
      username: CONFIG.username,
      action,
      at: new Date().toISOString(),
      note,
      courseName: CONFIG.courseName
    })
  })
  const text = await res.text()
  console.log(`[report] ${action} -> ${res.status} ${text.slice(0, 160)}`)
  return res.ok
}

/* ---------- 主循环 ---------- */

const lastFired = { in: 0, out: 0 }

/* 这一轮的机器可读结果：worker 用它决定回报什么 */
let RESULT = { ok: false, action: null, message: '未执行' }
function setResult (ok, action, message) {
  RESULT = { ok: !!ok, action: action || null, message: String(message || '').slice(0, 300) }
}

/* 这节课该签到还是签退：下课时间（默认 17:50）之后算签退 */
function pickAction () {
  // 任务队列会显式指定动作（服务端已按课表算好），优先于按时间推断
  const forced = String(process.env.NA_ACTION || '').toLowerCase()
  if (forced === 'in' || forced === 'out') return forced
  const m = String(CONFIG.outFrom).match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return 'in'
  const cut = Number(m[1]) * 60 + Number(m[2])
  return curMinutes() >= cut ? 'out' : 'in'
}

function curMinutes () {
  const o = String(process.env.NA_TIME || '').match(/^(\d{1,2}):(\d{2})$/)
  if (o) return Number(o[1]) * 60 + Number(o[2])
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

function hhmm (t) {
  const m = String(t).match(/^(\d{1,2}):(\d{2})$/)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

function clockStr () {
  const c = curMinutes()
  return String(Math.floor(c / 60)).padStart(2, '0') + ':' + String(c % 60).padStart(2, '0')
}

/* 只在课次时间窗内动作，避免全天乱点 */
function inWindow () {
  // 队列模式：时间由服务端判定，执行机不再自我限制
  if (String(process.env.NA_SKIP_WINDOW || '') === '1') return true
  const a = hhmm(CONFIG.startFrom)
  const b = hhmm(CONFIG.endAt)
  const cur = curMinutes()
  if (a === null || b === null) return true
  return cur >= a && cur <= b
}

function textsOf (nodes) {
  return nodes.map((n) => (n.text || '') + (n.desc || '')).join(' | ')
}

/* 系统提示弹窗（未发现考勤地点等）点掉 */
async function dismissDialog (nodes) {
  const btn = nodes.find((n) => n.clickable && /^(确定|取消|知道了|关闭)$/.test(norm(n.text || n.desc)))
  if (btn) {
    console.log(`[nav] 关掉提示「${norm(btn.text || btn.desc)}」`)
    await tapAt(btn, norm(btn.text || btn.desc))
    await sleep(800)
  }
}

/* 签到页：点中间的大圆按钮才算提交 */
async function submitOnSignPage ({ dry, no, action }) {
  const act = action || pickAction()
  const nodes = parseNodes(await dumpUi())
  const big = nodes.find((n) => /ll_attendance$/.test(n.id) && n.w > 200 && n.h > 200)
  if (!big) {
    console.log('[warn] 签到页没找到中间的签到圆钮')
    return
  }
  if (dry) {
    console.log(`[plan] 签到页圆钮 @ (${big.x},${big.y})`)
    return
  }
  await tapAt(big, '签到圆钮')
  await sleep(3500)
  const after = parseNodes(await dumpUi())
  const all = textsOf(after)
  const ok = /(已签到|签到成功|签退成功|已签退)/.test(all) && !/未签到/.test(all)
  const bad = all.match(/(未发现考勤地点|不在考勤范围|超出[^|]{0,8}|距离[^|]{0,12}|未到[^|]{0,8}|已结束|过期)/)
  if (ok) {
    console.log(`[ok] 第${no}次课 签到成功`)
    setResult(true, act, `第${no}次课 签到成功`)
    await report(act, `adb 第${no}次课 签到成功`)
  } else if (bad) {
    console.log(`[warn] 被拒：${bad[0]}`)
    setResult(false, act, `被拒：${bad[0]}`)
    await dismissDialog(after)
  } else {
    console.log(`[warn] 点完圆钮无明确结果：${all.slice(0, 160)}`)
    setResult(false, act, '点完圆钮无明确结果')
    await dismissDialog(after)
  }
}

async function tick (opts = {}) {
  const dry = !!opts.dry
  await wake()
  let pkg = await focusedPackage()
  if (!pkg.includes(APP_PKG)) {
    console.log(`[nav] 前台是 ${pkg || '未知'}，拉起浙大体艺`)
    if (!(await launchApp())) {
      console.log('[skip] 拉不起 App，跳过这一轮')
      setResult(false, null, '拉不起 App')
      return
    }
    await sleep(3000)
    pkg = await focusedPackage()
    if (!pkg.includes(APP_PKG)) {
      console.log(`[skip] 拉起后前台仍是 ${pkg || '未知'}，跳过`)
      setResult(false, null, '拉起后前台不是浙大体艺')
      return
    }
  }

  let nodes = await gotoSchedule(parseNodes(await dumpUi()))
  const page = pageOf(nodes)
  if (page !== 'schedule') {
    console.log(`[skip] 没走到「课程排课」页（当前 ${page}）`)
    setResult(false, null, `没走到课程排课页（当前 ${page}）`)
    return
  }

  const row = findTodayRow(nodes)
  if (!row) {
    console.log(`[idle] 今天（${todayStr()}）没有课次`)
    setResult(false, null, `今天（${todayStr()}）没有课次`)
    return
  }

  const mock = String(CONFIG.mock).match(MOCK_RE)
  if (mock) {
    try {
      const put = await setMockLocation(mock[1], mock[2])
      console.log(`[mock] GPS 已覆盖到 ${put.lat.toFixed(6)},${put.lng.toFixed(6)}（±${put.accuracy}m）`)
      await sleep(1500)
    } catch (e) {
      console.log(`[warn] 设置模拟定位失败：${e.message}`)
    }
  }

  // 反检测：真人不会在开窗第 0 秒就点。NA_DELAY_MAX = 最多随机等多少秒（默认 0，队列模式由外部控制）
  const delayMax = Number(process.env.NA_DELAY_MAX || 0)
  if (delayMax > 0) {
    const wait = Math.round(Math.random() * delayMax * 1000)
    console.log(`[delay] 随机等待 ${(wait / 1000).toFixed(1)}s（上限 ${delayMax}s）`)
    await sleep(wait)
  }

  if (!inWindow()) {
    console.log(`[idle] 现在 ${clockStr()}，不在动作时间窗 ${CONFIG.startFrom}-${CONFIG.endAt}`)
    setResult(false, null, `不在动作时间窗 ${CONFIG.startFrom}-${CONFIG.endAt}`)
    return
  }

  const action = pickAction()
  const keyword = action === 'out' ? '签退' : '签到'
  const btn = rowButton(nodes, row, keyword)
  if (!btn) {
    console.log(`[idle] 第${row.no}次课 没有「${keyword}」按钮（可能老师还没开场或已结束）`)
    setResult(false, action, `第${row.no}次课 没有「${keyword}」按钮`)
    return
  }
  if (Date.now() - lastFired[action] < CONFIG.cooldown) {
    console.log(`[cool] ${keyword} 距上次 ${Math.round((Date.now() - lastFired[action]) / 1000)}s，跳过`)
    setResult(false, action, `冷却中，${keyword}跳过`)
    return
  }

  if (dry) {
    console.log(`[plan] 第${row.no}次课（${row.date}）→ 点「${keyword}」@ (${btn.x},${btn.y})`)
    return
  }

  console.log(`[tap] 第${row.no}次课「${keyword}」@ (${btn.x},${btn.y})`)
  await tapAt(btn, `${row.no} ${keyword}`)
  await sleep(3000)

  let after = parseNodes(await dumpUi())
  if (pageOf(after) === 'sign') {
    lastFired[action] = Date.now()
    await submitOnSignPage({ dry, no: row.no, action })
    return
  }
  const all = textsOf(after)
  const ok = /(成功|已签到|已签退|签到完成|签退完成)/.test(all)
  const bad = all.match(/(失败|不在|未到|范围|超出|过期|超时|未开始|已结束|不能|无法)[^|]{0,24}/)
  lastFired[action] = Date.now()

  if (ok) {
    console.log(`[ok] ${keyword} 成功`)
    setResult(true, action, `第${row.no}次课 ${keyword} 成功`)
    await report(action, `adb 第${row.no}次课 ${keyword} 成功`)
  } else if (bad) {
    console.log(`[warn] ${keyword} 被拒：${bad[0]}`)
    setResult(false, action, `被拒：${bad[0]}`)
  } else {
    console.log(`[warn] 点了「${keyword}」但界面无成功提示，不回报。界面片段：${all.slice(0, 180)}`)
    setResult(false, action, '界面无成功提示')
  }
}

async function main () {
  const serial = await requireDevice()
  console.log(`[adb] 设备 ${serial}`)

  if (has('--dump')) {
    const nodes = parseNodes(await dumpUi())
    console.log(`共 ${nodes.length} 个节点，可点击的：`)
    for (const n of nodes.filter((n) => n.clickable && (n.text || n.desc))) {
      console.log(`  (${n.x},${n.y}) ${n.cls} :: "${n.text || n.desc}"`)
    }
    return
  }

  if (has('--shot')) {
    const p = arg('--shot', 'shot.png')
    const { stdout } = await pexec(CONFIG.adb, adbArgs(['exec-out', 'screencap', '-p']), {
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'buffer'
    })
    await writeFile(p, stdout)
    console.log(`[shot] ${p} (${stdout.length} 字节)`)
    return
  }

  if (has('--plan')) {
    await tick({ dry: true })
    return
  }

  if (has('--once')) {
    await tick()
    console.log('[result] ' + JSON.stringify(RESULT))
    return
  }

  console.log(`[run] 每 ${CONFIG.interval / 1000}s 扫一次，回报到 ${CONFIG.server}`)
  for (;;) {
    try {
      await tick()
    } catch (e) {
      console.log(`[err] ${e.message}`)
      if (/没检测到设备|还没授权/.test(e.message)) {
        try { await requireDevice() } catch { /* 下一轮再试 */ }
      }
    }
    await sleep(CONFIG.interval)
  }
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirect) {
  main().catch((e) => {
    console.error(`[fatal] ${e.message}`)
    process.exit(1)
  })
}
