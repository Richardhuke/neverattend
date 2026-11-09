import { defineStore } from 'pinia'
import { decode, encode } from '../utils/codec.js'
import { api } from '../utils/api.js'

const K = {
  username: 'neverattend-username',
  token: 'neverattend-token',
  password: 'neverattend-password',
  setup: 'neverattend-setup'
}

/**
 * 凭据只存在浏览器本地（与 NeverRun 同策略）：
 * - token 明文存 localStorage（本来就是短期 JWT）
 * - password 加密后存 localStorage，仅用于"一键续期 token"
 */
export const useUserStore = defineStore('user', {
  state: () => ({
    username: localStorage.getItem(K.username) || '',
    token: localStorage.getItem(K.token) || '',
    passwordCipher: localStorage.getItem(K.password) || '',
    setup: localStorage.getItem(K.setup) === '1'
  }),
  getters: {
    hasPassword: s => !!s.passwordCipher,
    isFirstTime: s => !s.username || !s.token
  },
  actions: {
    setCredentials (username, token) {
      this.username = username
      this.token = token
      localStorage.setItem(K.username, username)
      localStorage.setItem(K.token, token)
      this.setup = true
      localStorage.setItem(K.setup, '1')
    },
    async savePassword (plain) {
      this.passwordCipher = await encode(plain)
      localStorage.setItem(K.password, this.passwordCipher)
    },
    loadPassword () {
      return this.passwordCipher ? decode(this.passwordCipher) : Promise.resolve('')
    },
    async refreshToken () {
      const plain = await this.loadPassword()
      if (!plain) throw new Error('本地没有保存密码，无法自动续期')
      const data = await api.getToken(this.username, await encode(plain))
      const me = await api.verifyToken(data.username, data.token)
      this.setCredentials(me.xh || data.username, me.token)
      return me
    },
    clear () {
      this.username = ''
      this.token = ''
      this.passwordCipher = ''
      this.setup = false
      for (const k of Object.values(K)) localStorage.removeItem(k)
    }
  }
})
