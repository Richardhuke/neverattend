import { config } from '../config.js'
import { listSessions } from './tyys.js'
import { runCheckinCollect } from './pipeline.js'
import { notify } from './dingtalk.js'
import { watch, sessionStore, pushEvent } from '../store.js'

let timer = null

function tickMs () { return watch.intervalMs || config.watch.intervalMs }

/** 挑出本轮要处理的动作：待签到 + 老师已开启的签退 */
function tasksOf (sessions) {
  const tasks = []
  for (const s of sessions) {
    if (s.status === 'open') tasks.push({ action: 'in', session: s })
    if (s.signOutStatus === 'open') tasks.push({ action: 'out', session: s })
  }
  return tasks
}

async function tick () {
  watch.lastPollAt = Date.now()
  watch.nextPollAt = watch.lastPollAt + tickMs()
  watch.polls += 1

  const accounts = sessionStore.list()
  if (!accounts.length) {
    if (watch.polls % 6 === 1) pushEvent('info', 'poll', '自动签到守护中：尚无已登录账号')
    return
  }

  for (const acc of accounts) {
    let sessions
    try {
      sessions = await listSessions(acc.username, acc.token)
      watch.lastError = null
    } catch (err) {
      watch.lastError = err instanceof Error ? err.message : String(err)
      pushEvent('warn', 'poll', `轮询失败（${acc.username}）：${watch.lastError}`)
      continue
    }

    const tasks = tasksOf(sessions)
    if (!tasks.length) {
      if (watch.polls % 6 === 1) {
        pushEvent('info', 'poll', `第 ${watch.polls} 次轮询：暂无待办（共 ${sessions.length} 个场次）`)
      }
      continue
    }

    for (const { action, session } of tasks) {
      const isOut = action === 'out'
      const verb = isOut ? '签退' : '签到'
      const key = `${acc.username}:${session.id}:${action}`
      if (watch.inflight.has(key)) continue
      if (!watch.autoCheckin) {
        pushEvent('warn', 'poll', `发现待${verb}场次 ${session.title}（自动${verb}已关闭）`, { sessionId: session.id })
        continue
      }
      watch.inflight.add(key)
      pushEvent('info', 'poll', `发现待${verb}场次 ${session.title}，开始自动${verb}`)
      try {
        const { result } = await runCheckinCollect({
          username: acc.username,
          token: acc.token,
          sessionId: session.id,
          action,
          // 异地模式：用户在前端设置过坐标就复用它（守护进程无需开着浏览器）
          longitude: acc.coords?.longitude,
          latitude: acc.coords?.latitude,
          jitter: acc.coords?.jitter,
          away: acc.coords?.mode === 'custom',
          ignorePrejudgement: true
        })
        if (result.ok) {
          if (isOut) watch.signouts += 1
          else watch.checkins += 1
          await notify(`自动${verb}成功`, `${session.title}\n${new Date().toLocaleString('zh-CN')}`)
        } else {
          pushEvent('error', 'poll', `自动${verb}失败：${result.error || '未知错误'}`)
          await notify(`自动${verb}失败`, `${session.title}\n${result.error || '未知错误'}`)
        }
      } catch (err) {
        pushEvent('error', 'poll', `自动${verb}异常：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        watch.inflight.delete(key)
      }
    }
  }
}

export async function tickOnce () { await tick() }

export const watcher = {
  start ({ intervalMs, autoCheckin } = {}) {
    if (intervalMs && Number(intervalMs) >= 2000) watch.intervalMs = Number(intervalMs)
    if (typeof autoCheckin === 'boolean') watch.autoCheckin = autoCheckin
    watch.running = true
    watch.startedAt = watch.startedAt || Date.now()
    watch.nextPollAt = Date.now() + tickMs()
    if (timer) clearInterval(timer)
    timer = setInterval(() => { tick().catch(() => {}) }, tickMs())
    pushEvent('success', 'watch', `自动签到/签退已启动：每 ${Math.round(tickMs() / 1000)} 秒轮询一次`)
    tick().catch(() => {})
    return this.state()
  },
  stop () {
    watch.running = false
    if (timer) { clearInterval(timer); timer = null }
    watch.nextPollAt = null
    pushEvent('warn', 'watch', '自动签到/签退已停止')
    return this.state()
  },
  state () {
    return {
      running: watch.running,
      intervalMs: watch.intervalMs,
      autoCheckin: watch.autoCheckin,
      startedAt: watch.startedAt,
      lastPollAt: watch.lastPollAt,
      nextPollAt: watch.nextPollAt,
      polls: watch.polls,
      checkins: watch.checkins,
      signouts: watch.signouts,
      lastError: watch.lastError
    }
  }
}
