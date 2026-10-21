const service = require('../../lib/service')
const tasteProfile = require('../../lib/taste-profile')

Page({
  data: { themeClass: '', theme: 'system', reducedMotion: false, version: service.VERSION, consent: false, serviceReady: false, statusLabel: '', busy: false, error: '', localDataError: '', tasteReady: false, tasteStarted: false },
  onShow() { this._active = true; this._generation = (this._generation || 0) + 1; this.setData({ busy: false }); getApp().syncPage(this); this.updateView() },
  onHide() { this._active = false; this._generation = (this._generation || 0) + 1 },
  onUnload() { this._active = false; this._generation = (this._generation || 0) + 1 },
  syncState() { if (this._active) this.updateView() },
  updateView(fallbackError = '') {
    const taste = tasteProfile.getState()
    this.setData({
      tasteReady: taste.ready, tasteStarted: taste.started,
      theme: getApp().globalData.theme || 'system', consent: service.state.consent,
      serviceReady: service.state.status === 'ready' && !!service.state.config,
      statusLabel: service.state.status === 'ready' && service.state.config ? '已取得服务配置' : service.state.status === 'loading' ? '正在连接服务' : service.state.consent ? '服务尚未就绪' : '等待隐私同意',
      error: service.state.consent ? service.state.error || fallbackError : '',
      localDataError: getApp().globalData.localDataError || '',
    })
  },
  changeTheme(event) {
    const theme = event.currentTarget.dataset.theme
    if (!['system', 'light', 'dark'].includes(theme)) return
    getApp().applyTheme(theme)
    this.updateView()
  },
  changeReducedMotion(event) {
    if (!this._active || typeof event.detail?.value !== 'boolean') return
    getApp().applyReducedMotion(event.detail.value)
  },
  openPrivacy() { wx.navigateTo({ url: '/pages/privacy/index' }) },
  editTaste() { if (this._active) wx.navigateTo({ url: '/pages/preferences/index?edit=1' }) },
  clearTaste() {
    if (!this._active) return
    const generation = this._generation
    wx.showModal({ title: '清除口味偏好', content: '将清除本机保存的口味偏好与未完成选择，并返回问题页重新填写。', confirmText: '清除并重选',
      success: result => { if (result.confirm && this._active && generation === this._generation) getApp().clearTasteProfile() } })
  },
  retryCleanup() { if (this._active && getApp().globalData.localDataError) getApp().withdrawConsent() },
  open(event) { const page = event.currentTarget.dataset.page; if (['support', 'local-records', 'nearby'].includes(page)) wx.navigateTo({ url: `/pages/${page}/index` }) },
  async refreshService() {
    if (!this._active || this.data.busy || !service.state.consent) return
    const generation = this._generation
    let fallbackError = ''
    this.setData({ busy: true, error: '' })
    try { await getApp().checkService() }
    catch (_) { fallbackError = '暂时无法连接服务，请稍后再试' }
    finally { if (this._active && generation === this._generation) { this.setData({ busy: false }); this.updateView(fallbackError) } }
  },
  withdrawConsent() {
    if (!this._active || !service.state.consent) return
    const generation = this._generation
    wx.showModal({
      title: '撤回隐私同意',
      content: '将停止服务请求，清除本次登录、位置、推荐结果，以及本机口味偏好、决策摘要和附近缓存。撤回同意不会注销服务端账号。',
      confirmText: '撤回同意',
      success: (result) => {
        if (!result.confirm || !this._active || generation !== this._generation) return
        getApp().withdrawConsent()
        this.setData({ busy: false, error: '' })
        this.updateView()
      },
    })
  },
})
