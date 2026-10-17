const service = require('../../lib/service')

Page({
  data: { themeClass: '', theme: 'system', version: service.VERSION, consent: false, statusLabel: '', busy: false, error: '', localDataError: '' },
  onShow() { this._active = true; this._generation = (this._generation || 0) + 1; this.setData({ busy: false }); getApp().syncPage(this); this.updateView() },
  onHide() { this._active = false; this._generation = (this._generation || 0) + 1 },
  onUnload() { this._active = false; this._generation = (this._generation || 0) + 1 },
  syncState() { this.updateView() },
  updateView() {
    this.setData({
      theme: getApp().globalData.theme || 'system', consent: service.state.consent,
      statusLabel: service.state.config ? '已取得服务配置' : service.state.consent ? '服务尚未就绪' : '等待隐私同意',
      localDataError: getApp().globalData.localDataError || '',
    })
  },
  changeTheme(event) {
    const theme = event.currentTarget.dataset.theme
    if (!['system', 'light', 'dark'].includes(theme)) return
    getApp().applyTheme(theme)
    this.updateView()
  },
  openPrivacy() { wx.navigateTo({ url: '/pages/privacy/index' }) },
  retryCleanup() { if (this._active && getApp().globalData.localDataError) getApp().withdrawConsent() },
  open(event) { const page = event.currentTarget.dataset.page; if (['support', 'local-records', 'nearby'].includes(page)) wx.navigateTo({ url: `/pages/${page}/index` }) },
  async refreshService() {
    if (!this._active || this.data.busy || !service.state.consent) return
    const generation = this._generation
    this.setData({ busy: true, error: '' })
    try { await getApp().checkService() }
    catch (error) { if (this._active && generation === this._generation) this.setData({ error: error.message || '暂时无法连接服务，请稍后再试' }) }
    finally { if (this._active && generation === this._generation) { this.setData({ busy: false }); this.updateView() } }
  },
  withdrawConsent() {
    if (!this._active || !service.state.consent) return
    const generation = this._generation
    wx.showModal({
      title: '撤回隐私同意',
      content: '将停止服务请求，清除本次登录、位置、推荐结果，以及本机决策摘要和附近缓存。撤回同意不会注销服务端账号。',
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
