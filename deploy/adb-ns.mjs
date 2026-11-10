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
 *   node deploy/adb-ns.mjs --dump            # 只打印当前界面上所有可点节点（定位按钮用）
 *   node deploy/adb-ns.mjs --shot out.png    # 截一张图
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
  courseName: process.env.NA_COURSE || '身体素质课'
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

async function tick () {
  await wake()
  const pkg = await focusedPackage()
  if (!pkg.includes(APP_PKG)) {
    console.log(`[skip] 前台是 ${pkg || '未知'}，不是浙大体艺`)
    return
  }

  const xml = await dumpUi()
  const nodes = parseNodes(xml)

  // 先签退（老师下课后才出现），再签到
  for (const [keyword, action] of [['签退', 'out'], ['签到', 'in']]) {
    const btn = findButton(nodes, keyword)
    if (!btn) continue
    if (Date.now() - lastFired[action] < CONFIG.cooldown) {
      console.log(`[cool] ${keyword} 距上次 ${Math.round((Date.now() - lastFired[action]) / 1000)}s，跳过`)
      continue
    }
    console.log(`[tap] ${keyword} @ (${btn.x},${btn.y}) text="${btn.text || btn.desc}"`)
    await adb(['shell', 'input', 'tap', String(btn.x), String(btn.y)])
    await sleep(2500)

    const after = parseNodes(await dumpUi())
    const stillThere = findButton(after, keyword)
    const okText = after.some((n) => /(成功|已签|签到成功|签退成功)/.test((n.text || '') + (n.desc || '')))
    lastFired[action] = Date.now()

    if (okText || !stillThere) {
      await report(action, `adb 点击「${keyword}」`)
    } else {
      console.log(`[warn] 点了「${keyword}」但界面没变化，不回报`)
    }
    return
  }

  const pending = nodes.filter((n) => /签到|签退/.test((n.text || '') + (n.desc || ''))).map((n) => n.text || n.desc)
  console.log(`[idle] 界面上没有可点的签到/签退${pending.length ? `（候选：${pending.slice(0, 5).join(' | ')}）` : ''}`)
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

  if (has('--once')) {
    await tick()
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
