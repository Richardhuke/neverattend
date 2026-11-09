/**
 * 本地凭据混淆（与后端 src/services/zjuam.js 完全同源）
 * PBKDF2(passphrase, salt, 100000, SHA-256) -> AES-256-CBC，16B IV 前置，整包 base64。
 * 注意：这是可逆混淆，不是"安全存储"——密钥就在前端包里，只为避免明文落盘。
 */
const PASSPHRASE = 'neverattend__'
const SALT = new TextEncoder().encode('neverattend')

const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))

let keyPromise = null
async function getKey () {
  if (!keyPromise) {
    keyPromise = (async () => {
      const base = await crypto.subtle.importKey('raw', enc.encode(PASSPHRASE), 'PBKDF2', false, ['deriveKey'])
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: SALT, iterations: 100000, hash: 'SHA-256' },
        base,
        { name: 'AES-CBC', length: 256 },
        false,
        ['encrypt', 'decrypt']
      )
    })()
  }
  return keyPromise
}

export async function encode (plain) {
  const key = await getKey()
  const iv = crypto.getRandomValues(new Uint8Array(16))
  const ct = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, enc.encode(plain))
  const out = new Uint8Array(16 + ct.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ct), 16)
  return b64(out)
}

export async function decode (payload) {
  const key = await getKey()
  const raw = unb64(payload)
  const iv = raw.slice(0, 16)
  const data = raw.slice(16)
  const pt = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, data)
  return dec.decode(pt)
}
