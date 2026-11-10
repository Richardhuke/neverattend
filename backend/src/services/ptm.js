/**
 * ptm（《体育教学管理系统》/ptm/*）适配层。
 * 网页端是 JSP + JSESSIONID，没有 JWT；登录态就是登录链拿到的 cookie jar。
 *
 * /ptm/studentAttendance 是「我的考勤」查询页，真实结构（2026-11 实测）：
 *   学期下拉 + 课程名 + 出勤统计（应出勤/实出勤/缺勤/迟到/病假/事假/早退）
 *   + 一张表：课次 | 考勤状态 | 考勤方式 | 考勤时间
 *   考勤状态取值只有「到 / 缺 / 停课」，考勤方式「手动 / GPS / 无」。
 * 这一页是**查询结果**，不含任何签到入口；签到在手机 App（/cgapp-server/app/* + JWT）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ptmFetch } from './zjuam.js'
import { pushEvent } from '../store.js'

function dumpDir () {
  return path.dirname(process.env.DUMP_HTML || path.join(process.cwd(), 'logs', 'last-login.html'))
}

function dump (name, html) {
  try {
    const dir = dumpDir()
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `ptm-${name}.html`)
    fs.writeFileSync(file, html, 'utf8')
    return file
  } catch {
    return ''
  }
}

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

/** 去标签 + 解实体，压成一行；表格单元格和整页正文都用它 */
const stripTags = (s) => String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => ENTITIES[m] || ' ')
  .replace(/\s+/g, ' ')
  .trim()

/** 考勤状态中文 → 前端状态键 */
const STATUS_MAP = { 到: 'signed', 缺: 'absent', 停课: 'off' }
/** 考勤方式中文 → 前端类型键 */
const METHOD_MAP = { 手动: 'manual', GPS: 'gps', gps: 'gps', 无: '' }
/** 出勤统计标签 → 字段名 */
const STAT_FIELDS = [
  ['应出勤', 'expected'],
  ['实出勤', 'actual'],
  ['缺勤', 'absent'],
  ['迟到', 'late'],
  ['病假', 'sick'],
  ['事假', 'personal'],
  ['早退', 'early']
]

function grabStat (flat, label) {
  const m = flat.match(new RegExp(`${label}\\s*[:：]?\\s*(\\d+)`))
  return m ? Number(m[1]) : 0
}

/**
 * 解析「我的考勤」页。
 * 解析不出来就给空值/空数组，绝不编造场次。
 */
export function parseAttendance (html) {
  const page = String(html || '')
  const withoutCode = page
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  const flat = stripTags(withoutCode)

  // 学期取下拉里 selected 的那一项（页面里还有 2015 年以来的全部学期，不能取第一个）
  let term = ''
  const selHtml = (page.match(/<select[^>]*\bid\s*=\s*["']termid["'][\s\S]*?<\/select>/i) || [''])[0]
  const selOpt = selHtml.match(/<option[^>]*selected[\s\S]*?<\/option>/i)
  if (selOpt) term = stripTags(selOpt[0])
  if (!term) {
    const t = flat.match(/(\d{4}-\d{4}学年(?:秋冬|春夏)学期)/)
    term = t ? t[1] : ''
  }

  // 课程名在 widget-header 的 h4 里
  let courseName = ''
  const h4 = page.match(/<h4[^>]*\bclass\s*=\s*["'][^"']*widget-title[^"']*["'][^>]*>([\s\S]*?)<\/h4>/i)
  if (h4) courseName = stripTags(h4[1])
  if (!courseName) {
    const c = flat.match(/学年(?:秋冬|春夏)学期\s+(.{2,40}?)\s+应出勤/)
    courseName = c ? c[1].trim() : ''
  }

  const stats = {}
  for (const [label, key] of STAT_FIELDS) stats[key] = grabStat(flat, label)

  const lessons = []
  const tables = page.match(/<table[\s\S]*?<\/table>/gi) || []
  for (const table of tables) {
    const head = (table.match(/<thead[\s\S]*?<\/thead>/i) || [''])[0]
    if (!/课次/.test(stripTags(head))) continue
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || []
    for (const row of rows) {
      const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripTags)
      if (cells.length < 4) continue
      const lesson = Number((cells[0].match(/\d+/) || [])[0])
      if (!lesson) continue
      const statusCn = cells[1]
      const methodCn = cells[2]
      const at = /\d{2,4}-\d{1,2}-\d{1,2}/.test(cells[3]) ? cells[3] : ''
      lessons.push({
        lesson,
        statusCn,
        methodCn,
        status: STATUS_MAP[statusCn] || 'closed',
        method: METHOD_MAP[methodCn] ?? '',
        at
      })
    }
  }

  return { term, courseName, stats, lessons }
}

/** 把一条 ptm 课次记录换成前端 session 的形状 */
function toSession (lesson, courseName, prefix) {
  return {
    id: `${prefix}-${lesson.lesson}`,
    title: `第 ${lesson.lesson} 次课`,
    courseName: courseName || '体育课',
    type: lesson.method,
    startAt: lesson.at,
    endAt: '',
    status: lesson.status,
    signedAt: lesson.status === 'signed' ? lesson.at : '',
    signOutStatus: '',
    raw: `${lesson.statusCn} / ${lesson.methodCn} / ${lesson.at || '无'}`,
    source: 'ptm'
  }
}

/** 用会话抓考勤页；返回前端要的形状（courses/sessions/计数 + ptm 附加信息） */
export async function ptmStatus (rec) {
  const page = await ptmFetch(rec.jar, '/ptm/studentAttendance')
  const file = dump('attendance', page.html)
  const parsed = parseAttendance(page.html)
  const sessions = parsed.lessons.map((l) => toSession(l, parsed.courseName, `ptm${rec.username || ''}`))

  const counts = { signed: 0, absent: 0, off: 0, closed: 0 }
  for (const l of parsed.lessons) counts[l.status] = (counts[l.status] || 0) + 1

  pushEvent('info', 'ptm', `考勤页 ${page.status}（${page.html.length} 字，解析 ${sessions.length} 条${
    parsed.courseName ? `，课程「${parsed.courseName}」` : ''
  }${parsed.term ? `，${parsed.term}` : ''}）${file ? `，已落盘 ${file}` : ''}`)

  const redirected = /\/ptm\/login/.test(page.location || '')
  return {
    courses: parsed.courseName
      ? [{ id: 'ptm', name: parsed.courseName, teacher: '', term: parsed.term }]
      : [],
    sessions,
    openCount: counts.closed || 0,
    signedCount: counts.signed || 0,
    absentCount: counts.absent || 0,
    offCount: counts.off || 0,
    signOutOpenCount: 0,
    signOutDoneCount: 0,
    mode: 'ptm',
    term: parsed.term,
    courseName: parsed.courseName,
    stats: parsed.stats,
    note: sessions.length
      ? ''
      : redirected
        ? 'ptm 会话已过期（考勤页被踢回登录页），请重新用学号密码绑定一次'
        : `考勤页已读取（${page.status}，${page.html.length} 字），但表格里没有课次行；原文见 logs/ptm-attendance.html`
  }
}

export const __test = { parseAttendance }
