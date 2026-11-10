import fs from 'node:fs'
import path from 'node:path'
import 'dotenv/config'

const ROOT = path.resolve(process.cwd())

/** tyys（浙大体艺）接口路径表：真实环境可按 H5 抓包结果覆盖 */
const DEFAULT_ENDPOINTS = {
  // CAS：浏览器模式下访问 https://zjuam.zju.edu.cn/cas/login?service=${TYYS_BASE}/cas/appLogin
  casLogin: '/cas/appLogin',
  userInfo: '/app/user/getUserInfo',
  // 身体素质课：教学班 + 考勤场次
  courseList: '/app/course/student/list',
  attendanceList: '/app/attendance/list',
  attendanceDetail: '/app/attendance/detail',
  // 签到的三种形态：定位签到 / 扫码 / 口令
  attendanceLocation: '/app/attendance/location',
  attendanceSign: '/app/attendance/sign',
  attendanceSignQr: '/app/attendance/sign/qr',
  attendanceSignCode: '/app/attendance/sign/code',
  // 签退：老师在下课前开启，形式和签到一致（定位 / 扫码 / 口令）
  attendanceSignOut: '/app/attendance/signOut',
  attendanceSignOutQr: '/app/attendance/signOut/qr',
  attendanceSignOutCode: '/app/attendance/signOut/code',
  attendanceSignOutLocation: '/app/attendance/signOut/location'
}

function loadEndpoints () {
  const file = process.env.TYYS_ENDPOINTS_FILE
  if (!file) return { ...DEFAULT_ENDPOINTS }
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file)
  try {
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8'))
    return { ...DEFAULT_ENDPOINTS, ...raw }
  } catch {
    return { ...DEFAULT_ENDPOINTS }
  }
}

export const config = {
  port: Number(process.env.PORT || 8000),
  staticDir: path.resolve(ROOT, process.env.STATIC_DIR || './static'),
  tyys: {
    base: (process.env.TYYS_BASE || 'http://www.tyys.zju.edu.cn/cgapp-server').replace(/\/$/, ''),
    // CAS 的 service 参数：实测 /cgapp-server/cas/appLogin 验证 ticket 后只会落到
    // zfsoft 的「浏览器版本过低」错误页，真正的业务入口是 /ggtypt/dologin
    casService: (process.env.TYYS_CAS_SERVICE || 'http://www.tyys.zju.edu.cn/ggtypt/dologin').trim(),
    mock: String(process.env.TYYS_MOCK ?? '1') !== '0',
    endpoints: loadEndpoints()
  },
  // 会话落盘目录：重启后不必让所有人重新绑定（只存 token/坐标，不存密码）
  dataDir: path.resolve(ROOT, process.env.DATA_DIR || './data'),
  watch: {
    intervalMs: Number(process.env.WATCH_INTERVAL_MS || 10000),
    autoCheckin: String(process.env.WATCH_AUTO_CHECKIN ?? '1') !== '0'
  },
  // 异地模式：默认场馆坐标（紫金港西区体育馆），抖动半径默认 30m
  geo: {
    venue: {
      name: '紫金港校区西区体育馆',
      longitude: Number(process.env.VENUE_LNG || 120.089136),
      latitude: Number(process.env.VENUE_LAT || 30.302331)
    },
    jitterMeters: Number(process.env.GEO_JITTER_METERS || 30)
  },
  dingtalkWebhook: process.env.DINGTALK_WEBHOOK || '',
  // 与前端 codec.js 严格同源：PBKDF2(passphrase, salt) -> AES-256-CBC
  codec: {
    passphrase: 'neverattend__',
    salt: Buffer.from('neverattend', 'utf8')
  }
}
