const service = require('../../lib/service')
const account = require('../../lib/account')

Page({
  data: {
    themeClass: '', method: 'PHONE', purpose: 'LOGIN', target: '', otpCode: '',
    capabilities: {}, signedIn: false, identities: [], sessions: [],
    hasChallenge: false, maskedTarget: '', resendSeconds: 0, busy: false, error: '', notice: '',
  },
  onShow() {
    this._active = true
    this._needsRestore = true
    this._generation = (this._generation || 0) + 1
    clearInterval(this._timer)
    getApp().syncPage(this)
    if (!service.state.consent) { wx.reLaunch({ url: '/pages/index/index' }); return }
    this.updateView()
    this._timer = setInterval(() => { if (this._active) this.updateView() }, 1000)
  },
  onHide() { this.leave() },
  onUnload() { this.leave() },
  syncState() { this.updateView() },
  leave() {
    this._active = false
    this._generation = (this._generation || 0) + 1
    clearInterval(this._timer)
    account.cancelPending()
    this.setData({ target: '', otpCode: '', busy: false, hasChallenge: false, maskedTarget: '' })
  },
  updateView() {
    let next = account.view()
    if (this._active && this._needsRestore && service.state.status === 'ready') {
      const form = account.resumeChallenge()
      if (form) this.setData({ ...form, otpCode: '' })
      this._needsRestore = false
    }
    if (!next.capabilities.accountsEnabled || this.data.signedIn && !next.signedIn) this.setData({ target: '', otpCode: '', notice: '' })
    if (this.data.method === 'PHONE' && !next.capabilities.phoneEnabled && next.capabilities.emailEnabled) {
      this.setData({ method: 'EMAIL', purpose: 'LOGIN', target: '', otpCode: '' })
      account.cancelChallenge()
      next = account.view()
    }
    if (this.data.purpose === 'REGISTER' && !next.capabilities.registrationEnabled) {
      this.setData({ purpose: 'LOGIN', target: '', otpCode: '' })
      account.cancelChallenge()
      next = account.view()
    }
    this.setData(next)
  },
  changeMethod(event) {
    if (!this._active || this.data.busy) return
    const method = event.currentTarget.dataset.method
    if (!['PHONE', 'EMAIL'].includes(method) || method === this.data.method) return
    account.cancelChallenge()
    this.setData({ method, purpose: 'LOGIN', target: '', otpCode: '', error: '', notice: '' })
    this.updateView()
  },
  changePurpose(event) {
    if (!this._active || this.data.busy) return
    const purpose = event.currentTarget.dataset.purpose
    if (!['REGISTER', 'LOGIN'].includes(purpose) || purpose === this.data.purpose) return
    account.cancelChallenge()
    this.setData({ purpose, target: '', otpCode: '', error: '', notice: '' })
    this.updateView()
  },
  inputTarget(event) {
    if (!this._active || this.data.busy) return
    account.cancelChallenge()
    this.setData({ target: event.detail.value, otpCode: '', hasChallenge: false, maskedTarget: '', error: '', notice: '' })
  },
  inputCode(event) { if (this._active && !this.data.busy) this.setData({ otpCode: event.detail.value }) },
  async run(action) {
    if (!this._active || this.data.busy) return
    const generation = this._generation
    this.setData({ busy: true, error: '', notice: '' })
    try {
      await action()
    } catch (error) {
      if (this._active && generation === this._generation && error.code !== 'STALE') {
        this.setData({ error: error.message || '操作未完成，请稍后再试' })
      }
    } finally {
      if (this._active && generation === this._generation) { this.setData({ busy: false }); this.updateView() }
    }
  },
  sendCode() {
    return this.run(async () => {
      await account.sendCode(this.data.method, this.data.purpose, this.data.target)
      if (this._active) this.setData({ notice: '验证码已发送，请在有效期内输入。' })
    })
  },
  login() {
    return this.run(async () => {
      await account.login(this.data.method, this.data.purpose, this.data.target, this.data.otpCode)
      if (!this._active) return
      this.setData({ target: '', otpCode: '', notice: '已登录。退出小程序后需要重新登录。' })
      this.updateView()
      await account.loadDetails()
    })
  },
  loginWithWechat() {
    return this.run(async () => {
      try {
        await account.loginWithWechat(() => new Promise((resolve, reject) => {
          wx.login({
            timeout: 10000,
            success: (result) => resolve(result.code),
            fail: () => reject(new Error('微信登录未完成，请稍后重试。')),
          })
        }))
      } catch (error) {
        if (error.statusCode === 401) throw new Error('暂时无法通过此微信登录。请使用手机号登录或注册，并确认此微信已关联吃什么账号。')
        throw error
      }
      if (!this._active) return
      this.setData({ target: '', otpCode: '', notice: '微信登录成功。当前使用服务端关联的同一账号。' })
      this.updateView()
      await account.loadDetails()
    })
  },
  refreshDetails() { return this.run(() => account.loadDetails()) },
  logout() {
    if (!this._active || this.data.busy) return
    const generation = this._generation
    wx.showModal({
      title: '退出当前账号', content: '将清除本次小程序中的登录状态。', confirmText: '退出登录',
      success: (result) => {
        if (!result.confirm || !this._active || generation !== this._generation) return
        this.run(async () => {
          try { await account.logout() } catch (_) { throw new Error('本机登录已清除，服务端退出未确认，请稍后重试登录。') }
          if (this._active) this.setData({ notice: '已退出登录。', target: '', otpCode: '' })
        })
      },
    })
  },
  openPrivacy() { wx.navigateTo({ url: '/pages/privacy/index' }) },
  openSettings() { wx.navigateTo({ url: '/pages/settings/index' }) },
})
