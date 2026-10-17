const service = require('../../lib/service')
const account = require('../../lib/account')

Page({
  data: {
    themeClass: '', method: 'PHONE', purpose: 'LOGIN', target: '', otpCode: '',
    capabilities: {}, signedIn: false, identities: [], sessions: [],
    hasChallenge: false, maskedTarget: '', resendSeconds: 0, busy: false, error: '', notice: '',
    detailsReady: false, canBindEmail: false, bindingTarget: '', bindingCode: '',
    hasBindingChallenge: false, bindingMaskedTarget: '', bindingResendSeconds: 0,
    includeBehaviorHistory: true, exportStatus: null, exportPage: null,
    showDelete: false, deleteConfirmation: '', deletionReceipt: null,
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
    this.setData({ target: '', otpCode: '', bindingTarget: '', bindingCode: '', busy: false, hasChallenge: false, maskedTarget: '', hasBindingChallenge: false, bindingMaskedTarget: '', exportPage: null, showDelete: false, deleteConfirmation: '', deletionReceipt: null, notice: '' })
  },
  updateView() {
    let next = account.view()
    if (this._authenticationRevision !== next.authenticationRevision) {
      this._authenticationRevision = next.authenticationRevision
      this.setData({ bindingTarget: '', bindingCode: '', showDelete: false, deleteConfirmation: '', deletionReceipt: null, exportPage: null, notice: '' })
    }
    if (this._active && this._needsRestore && service.state.status === 'ready') {
      const form = account.resumeChallenge()
      if (form) this.setData({ ...form, otpCode: '' })
      this._needsRestore = false
    }
    if (!next.capabilities.accountsEnabled || this.data.signedIn && !next.signedIn) this.setData({ target: '', otpCode: '', notice: '' })
    if (!next.canBindEmail) this.setData({ bindingTarget: '', bindingCode: '' })
    if (!next.capabilities.dataExportEnabled) this.setData({ includeBehaviorHistory: true, exportPage: null })
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
      await action(() => this._active && generation === this._generation)
    } catch (error) {
      if (this._active && generation === this._generation && error.code !== 'STALE') {
        this.setData({ error: error.message || '操作未完成，请稍后再试' })
      }
    } finally {
      if (this._active && generation === this._generation) { this.setData({ busy: false }); this.updateView() }
    }
  },
  sendCode() {
    return this.run(async (current) => {
      await account.sendCode(this.data.method, this.data.purpose, this.data.target)
      if (current()) this.setData({ notice: '验证码已发送，请在有效期内输入。' })
    })
  },
  login() {
    return this.run(async (current) => {
      await account.login(this.data.method, this.data.purpose, this.data.target, this.data.otpCode)
      if (!current()) return
      this.updateView()
      this.setData({ target: '', otpCode: '', notice: '已登录。退出小程序后需要重新登录。' })
      await account.loadDetails()
    })
  },
  loginWithWechat() {
    return this.run(async (current) => {
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
      if (!current()) return
      this.updateView()
      this.setData({ target: '', otpCode: '', notice: '微信登录成功。当前使用服务端关联的同一账号。' })
      await account.loadDetails()
    })
  },
  refreshDetails() { return this.run(() => account.loadDetails()) },
  inputBindingTarget(event) {
    if (!this._active || this.data.busy) return
    account.cancelBinding()
    this.setData({ bindingTarget: event.detail.value, bindingCode: '', error: '', notice: '' })
    this.updateView()
  },
  inputBindingCode(event) { if (this._active && !this.data.busy) this.setData({ bindingCode: event.detail.value }) },
  sendBindingCode() {
    return this.run(async (current) => {
      await account.sendBindingCode(this.data.bindingTarget)
      if (current()) this.setData({ notice: '绑定验证码已发送至当前邮箱。' })
    })
  },
  bindEmail() {
    return this.run(async (current) => {
      await account.bindEmail(this.data.bindingTarget, this.data.bindingCode)
      if (current()) this.setData({ bindingTarget: '', bindingCode: '', notice: '邮箱已绑定到当前账号。' })
    })
  },
  confirmAction(title, content, confirmText, action) {
    if (!this._active || this.data.busy || !account.view().signedIn) return
    const generation = this._generation
    const revision = account.view().authenticationRevision
    wx.showModal({
      title, content, confirmText,
      success: (result) => {
        if (!result.confirm || !this._active || generation !== this._generation || revision !== account.view().authenticationRevision) return
        this.run(action)
      },
    })
  },
  unbindIdentity(event) {
    const id = event.currentTarget.dataset.id
    const identity = account.view().identities.find(item => item.id === id && item.canUnbind)
    if (!identity) return
    this.confirmAction(`解绑${identity.label}`, `解绑后不能再用 ${identity.maskedValue} 登录。不会合并或转移到其他账号。`, '确认解绑', async (current) => {
      await account.unbindIdentity(id)
      if (current()) this.setData({ notice: '已解绑所选登录身份。' })
    })
  },
  revokeSession(event) {
    const id = event.currentTarget.dataset.id
    const selected = account.view().sessions.find(item => item.id === id)
    if (!selected) return
    this.confirmAction('撤销登录设备', selected.current ? '这将立即结束本次小程序登录。' : `撤销“${selected.label}”的登录后，该设备需要重新登录。`, '确认撤销', async (current) => {
      await account.revokeSession(id)
      if (!current()) return
      this.updateView()
      this.setData({ notice: selected.current ? '当前设备已退出登录。' : '已撤销所选设备的登录。' })
    })
  },
  changeExportScope(event) {
    if (this._active && !this.data.busy && this.data.capabilities.dataExportEnabled) this.setData({ includeBehaviorHistory: event.detail.value === true })
  },
  requestExport() {
    return this.run(async (current) => {
      await account.requestExport(this.data.includeBehaviorHistory)
      if (current()) this.setData({ notice: '导出申请已受理，可手动刷新生成状态。' })
    })
  },
  refreshExport() { return this.run(() => account.refreshExport()) },
  readExport() {
    return this.run(async (current) => {
      await account.readExport()
      if (current()) this.setData({ notice: '内容已通过长度、SHA-256 和账号归属校验。离开此页后清除。' })
    })
  },
  changeExportPage(event) {
    if (!this._active || this.data.busy || !this.data.exportPage) return
    const offset = Number(event.currentTarget.dataset.offset)
    if (![-1, 1].includes(offset)) return
    this.run(() => account.changeExportPage(this.data.exportPage.number - 1 + offset))
  },
  closeExport() { if (this._active && !this.data.busy) { account.closeExport(); this.updateView() } },
  openDelete() { if (this._active && !this.data.busy && this.data.signedIn) this.setData({ showDelete: true, deleteConfirmation: '', error: '', notice: '' }) },
  cancelDelete() { if (this._active && !this.data.busy) this.setData({ showDelete: false, deleteConfirmation: '' }) },
  inputDeleteConfirmation(event) { if (this._active && !this.data.busy) this.setData({ deleteConfirmation: event.detail.value }) },
  deleteAccount() {
    if (this.data.deleteConfirmation !== '注销账号') return
    this.confirmAction('注销当前账号', '注销后所有登录令牌立即失效，个人信息按隐私政策清理，滚动备份最迟 30 天清除。此操作不能撤销。', '确认注销', async (current) => {
      let receipt
      try { receipt = await account.deleteAccount('DELETE_MY_ACCOUNT') }
      catch (error) {
        if (error.code === 'STALE') throw error
        throw new Error('本机登录已清除，服务端注销结果未确认。请重新登录检查账号状态。')
      }
      if (!current()) return
      this.updateView()
      this.setData({ deletionReceipt: receipt, showDelete: false, deleteConfirmation: '', notice: '账号已停用，所有登录令牌已失效。' })
    })
  },
  logout() {
    this.confirmAction('退出当前账号', '将清除本次小程序中的登录状态。', '退出登录', async (current) => {
      try { await account.logout() } catch (_) { throw new Error('本机登录已清除，服务端退出未确认，请稍后重试登录。') }
      if (!current()) return
      this.updateView()
      this.setData({ notice: '已退出登录。', target: '', otpCode: '' })
    })
  },
  openPrivacy() { wx.navigateTo({ url: '/pages/privacy/index' }) },
  openSettings() { wx.navigateTo({ url: '/pages/settings/index' }) },
})
