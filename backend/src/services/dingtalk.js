import { config } from '../config.js'

export async function notify (title, text) {
  const hook = config.dingtalkWebhook
  if (!hook) return false
  try {
    await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: `【NeverAttend】${title}\n${text}` } }),
      signal: AbortSignal.timeout(8000)
    })
    return true
  } catch {
    return false
  }
}
