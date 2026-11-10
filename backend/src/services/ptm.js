/**
 * ptm（《体育教学管理系统》/ptm/*）适配层。
 * 网页端是 JSP + JSESSIONID，没有 JWT；登录态就是登录链拿到的 cookie jar。
 * 先用 /ptm/studentAttendance 把考勤页抓回来落盘，再按表格尽力解析。
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

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

/** 从任意表格里抠出「时间窗 + 状态」的行；解析不出来就返回空数组（不编造） */
export function parseAttendance (html) {
  const out = []
  const rows = String(html || '').match(/<tr[\s\S]*?<\/tr>/gi) || []
  for (const row of rows) {
    const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripTags)
    const text = cells.join(' | ')
    const win = text.match(/(\d{2,4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2})\s*[~-]\s*(\d{1,2}:\d{2})/)
    if (!win) continue
    const status = /已签到|已签退/.test(text) ? 'signed' : /待签到|签到中|进行中/.test(text) ? 'open' : 'closed'
    out.push({
      id: `ptm-${out.length + 1}`,
      title: cells.find(c => c && !/^\d+$/.test(c) && !c.includes(':')) || '体育课考勤',
      raw: text.slice(0, 300),
      startAt: win[1].replace(/\//g, '-'),
      endAt: win[2],
      status,
      source: 'ptm'
    })
  }
  return out
}

/** 用会话抓考勤页；返回前端要的形状（courses/sessions/各计数） */
export async function ptmStatus (rec) {
  const page = await ptmFetch(rec.jar, '/ptm/studentAttendance')
  const file = dump('attendance', page.html)
  const sessions = parseAttendance(page.html)
  pushEvent('info', 'ptm', `考勤页 ${page.status}（${page.html.length} 字，解析 ${sessions.length} 条）${file ? `，已落盘 ${file}` : ''}`)
  return {
    courses: [],
    sessions,
    openCount: sessions.filter(s => s.status === 'open').length,
    signedCount: sessions.filter(s => s.status === 'signed').length,
    signOutOpenCount: 0,
    signOutDoneCount: 0,
    mode: 'ptm',
    note: sessions.length ? '' : `考勤页已读取（${page.status}，${page.html.length} 字），表格结构还没对上；原文见 logs/ptm-attendance.html`
  }
}

export const __test = { parseAttendance }
