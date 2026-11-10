/**
 * autojs-ns.js —— 「浙大体艺」身体素质课签到/签退助手（AutoJS 6 / AutoX.js）
 *
 * 为什么要有它：身体素质课只能在官方 App 里签到。App 的每个接口都要求一个
 * ARM native 库（libAMapSDK_Location_v6_6_0.so）算出来的请求签名，服务端复刻不了。
 * 所以让脚本跑在手机上、真的去点那个按钮，点完把结果回报给 NeverAttend，
 * Run 页就能把「定向越野」（网页考勤）和「身体素质课」（手机上报）并在一起看。
 *
 * 用法：
 *   1. 手机上装 AutoJS（或 AutoX.js），把本文件放进脚本目录；
 *   2. 改下面 CONFIG 三行：SERVER / KEY / USERNAME；
 *   3. 打开官方「浙大体艺」App 并登录，停在能看到「签到」按钮的页面；
 *   4. 运本脚本，授权无障碍服务，点悬浮窗「开始」。
 *
 * 安全：脚本只读取当前屏幕上的按钮文字并点击，不上传密码、不截图、
 * 只把「签到/签退成功 + 时间」POST 到 SERVER，KEY 就是 NeverAttend 的访问钥。
 */

var CONFIG = {
  // 例：'https://fabric-ear-also-romantic.trycloudflare.com'
  SERVER: 'http://121.196.174.13:8000',
  // NeverAttend 的访问钥（打开网页时 ?key= 后面那串）
  KEY: 'thgc8exk73v2wy9j4pbd',
  // 你的学号（和网页上绑定的那个一致）
  USERNAME: '3260103483',
  // 轮询间隔（毫秒）
  INTERVAL: 5000,
  // 同一动作的最小间隔，避免连点（毫秒）
  COOLDOWN: 60000
}

var lastAction = { in: 0, out: 0 }
var stopped = false

function log (msg) {
  console.log('[neverattend] ' + msg)
  toast(msg)
}

function report (action, note) {
  var url = CONFIG.SERVER.replace(/\/+$/, '') + '/api/phone/report'
  try {
    var res = http.postJson(url, {
      username: CONFIG.USERNAME,
      action: action,
      at: new Date().toISOString(),
      note: note || ''
    }, {
      headers: { 'X-Access-Key': CONFIG.KEY }
    })
    var body = res && res.body ? res.body.string() : ''
    log((action === 'in' ? '签到' : '签退') + '回报 ' + (res ? res.statusCode : '?') + ' ' + body)
  } catch (e) {
    log('回报失败：' + e)
  }
}

/** 找按钮：文字里带关键词、可点击、且不是「已签到」「签到记录」这类状态文字 */
function findButton (keyword, exclude) {
  var nodes = textContains(keyword).find()
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i]
    var t = (n.text() || '').replace(/\s/g, '')
    if (!t) continue
    if (exclude && exclude.some(function (w) { return t.indexOf(w) >= 0 })) continue
    var clickable = n
    for (var d = 0; d < 3 && clickable && !clickable.clickable(); d++) clickable = clickable.parent()
    if (clickable && clickable.clickable()) return clickable
  }
  return null
}

function tick () {
  if (stopped) return
  var now = Date.now()

  // 签退优先：老师开签退时通常签到已经完成
  var outBtn = findButton('签退', ['已签退', '签退记录', '签退时间'])
  if (outBtn && now - lastAction.out > CONFIG.COOLDOWN) {
    lastAction.out = now
    log('发现「签退」，点击')
    outBtn.click()
    sleep(2500)
    report('out', 'autojs 自动点击')
    return
  }

  var inBtn = findButton('签到', ['已签到', '签到记录', '签到时间', '待签到'])
  if (inBtn && now - lastAction.in > CONFIG.COOLDOWN) {
    lastAction.in = now
    log('发现「签到」，点击')
    inBtn.click()
    sleep(2500)
    report('in', 'autojs 自动点击')
    return
  }
}

function main () {
  if (!auto.service) {
    log('请先开启无障碍服务')
    return
  }
  log('开始守护，间隔 ' + CONFIG.INTERVAL + 'ms')
  while (!stopped) {
    try { tick() } catch (e) { log('轮询出错：' + e) }
    sleep(CONFIG.INTERVAL)
  }
  log('已停止')
}

// 悬浮窗：开始 / 停止
var win = floaty.window(
  <frame gravity="center" bg="#CC111111" padding="8">
    <vertical>
      <text id="title" text="NeverAttend" textColor="#FFFFFF" textSize="12sp" />
      <button id="toggle" text="开始" w="80" h="40" />
    </vertical>
  </frame>
)

win.toggle.click(function () {
  if (stopped) {
    stopped = false
    win.toggle.setText('停止')
    threads.start(main)
  } else {
    stopped = true
    win.toggle.setText('开始')
  }
})

ui.run(function () {
  win.setPosition(40, 300)
})
