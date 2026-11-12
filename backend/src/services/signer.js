// 签名机桥接：把 ARM64 上跑出来的 cgapiEnrypt 结果接进 Node。
//
// 两种后端形态，按环境变量择一：
//   1) HTTP 桥（推荐，服务常驻、快）
//        ARM_SIGN_URL=http://127.0.0.1:8791
//        ARM_SIGN_TOKEN=xxxx（可选）
//   2) 直接起进程（简单，每次 ~200ms）
//        ARM_SIGN_CMD=/opt/armsign/arm_sign.py
//
// 都没配时 available() === false，调用方应回退到手机 worker 路径。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CMD = process.env.ARM_SIGN_CMD || '';
const URL = process.env.ARM_SIGN_URL || '';
const TOKEN = process.env.ARM_SIGN_TOKEN || '';

export function available() {
  return Boolean(CMD || URL);
}

export function describe() {
  if (URL) return { mode: 'http', url: URL, token: Boolean(TOKEN) };
  if (CMD) return { mode: 'exec', cmd: CMD };
  return { mode: 'off' };
}

/**
 * @param {string} path   接口路径，例如 '/api/l/v6/attendance/attendancelist'
 * @param {string} query  已拼好的 query（顺序要与真实请求一致），例如 'timestamp=1700000000&uid=3260103483'
 * @returns {Promise<string>} 签名串
 */
export async function sign(path, query) {
  if (URL) {
    const res = await fetch(new URL('/sign', URL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: JSON.stringify({ path, query }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      throw new Error(`签名机返回失败: ${body.error || res.status}`);
    }
    return body.result;
  }

  if (CMD) {
    const { stdout } = await run('python3', [CMD, path, query, '--json'], { timeout: 15_000 });
    const out = JSON.parse(stdout);
    if (!out.ok) throw new Error(`签名机返回失败: ${out.error || 'unknown'}`);
    return out.result;
  }

  throw new Error('签名机未配置（设 ARM_SIGN_URL 或 ARM_SIGN_CMD）');
}

/** 健康检查：确认签名机在线且 cert 指纹正确 */
export async function health() {
  const info = describe();
  if (info.mode === 'http') {
    const res = await fetch(new URL('/health', URL), { signal: AbortSignal.timeout(3000) });
    return await res.json();
  }
  if (info.mode === 'exec') {
    const { stdout } = await run('python3', [CMD, '--json'], { timeout: 10_000 }).catch((e) => ({
      stdout: e.stdout || '',
    }));
    try {
      return JSON.parse(stdout);
    } catch {
      return { ok: false, error: '无法解析签名机输出' };
    }
  }
  return { ok: false, error: 'off' };
}
