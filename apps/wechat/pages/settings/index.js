const service = require('../../lib/service')

Page({
  data: { themeClass: '', theme: 'system', version: service.VERSION, consent: false, statusLabel: '', busy: false, error: '' },
  onShow() { this._active = true; this._generation = (this._generation || 0) + 1; this.setData({ busy: false }); getApp().syncPage(this); this.updateView() },
  onHide() { this._active = false; this._generation = (this._generation || 0) + 1 },
  onUnload() { this._active = false; this._generation = (this._generation || 0) + 1 },
  syncState() { this.updateView() },
  updateView() {
    this.setData({
      theme: getApp().globalData.theme || 'system', consent: service.state.consent,
      statusLabel: service.state.config ? '已取得服务配置' : service.state.consent ? '服务尚未就绪' : '等待隐私同意',
    })
  },
  changeTheme(event) {
    const theme = event.currentTarget.dataset.theme
    if (!['system', 'light', 'dark'].includes(theme)) return
    getApp().applyTheme(theme)
    this.updateView()
  },
  openPrivacy() { wx.navigateTo({ url: '/pages/privacy/index' }) },
  async refreshService() {
    if (!this._active || this.data.busy || !service.state.consent) return
    const generation = this._generation
    this.setData({ busy: true, error: '' })
    try { await service.refreshConfig() }
    catch (error) { if (this._active && generation === this._generation) this.setData({ error: error.message || '暂时无法连接服务，请稍后再试' }) }
    finally { if (this._active && generation === this._generation) { this.setData({ busy: false }); this.updateView() } }
  },
  withdrawConsent() {
    if (!this._active || !service.state.consent) return
    const generation = this._generation
    wx.showModal({
      title: '撤回隐私同意',
      content: '将清除本次登录、位置和推荐结果，并停止服务请求。再次同意后才能继续使用需要联网的功能。撤回同意不会注销服务端账号。',
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
