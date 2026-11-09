/**
 * 手写 SSE 读取器（与 NeverRun 的 utils/sse 同思路）：
 * 不依赖 EventSource，因为签到接口是 POST + JSON body。
 */
export async function streamSSE (url, body, onEvent, { signal } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`
    try { detail = (await res.json()).detail || detail } catch { /* ignore */ }
    onEvent({ type: 'error', step: 'http', message: detail })
    onEvent({ type: 'done', step: 'http', message: '已结束' })
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() ?? ''
      for (const chunk of chunks) {
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            onEvent(JSON.parse(line.slice(6)))
          } catch { /* 跳过非法帧 */ }
        }
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* ignore */ }
  }
}
