const service = require('../../lib/service');
const support = require('../../lib/support-feedback');
Page({
  data: { themeClass: '', categories: support.CATEGORIES, category: 'PRODUCT', message: '', length: 0, busy: false, enabled: false, canSubmit: false, guestConfirmationRequired: false, result: null, error: '' },
  onLoad() { this._form = support.create(); },
  async onShow() {
    this._active = true;
    this._generation = (this._generation || 0) + 1;
    getApp().syncPage(this); this.syncState(); wx.hideShareMenu();
    if (!service.state.consent || ['ready', 'loading'].includes(service.state.status)) return;
    const generation = this._generation;
    try { await getApp().checkService(); } catch (_) { /* The form stays disabled until configuration is ready. */ }
    if (this._active && generation === this._generation && service.state.consent) this.syncState();
  },
  onHide() { this.leave(); this.sync(); },
  onUnload() { this.leave(); },
  leave() { this._active = false; this._generation += 1; this._form.clear(); },
  syncState() {
    if (!this._active || !this._form) return;
    if (!support.enabled() || this._epoch !== service.state.epoch) this._form.clear();
    this._epoch = service.state.epoch; this.sync();
  },
  sync() { this.setData(this._form.view()); },
  category(event) { this._form.edit(event.currentTarget.dataset.value, this.data.message); this.sync(); },
  input(event) { this._form.edit(this.data.category, event.detail.value); this.sync(); },
  async submit() { if (!this._active) return; const generation = this._generation; const pending = this._form.submit(); this.sync(); await pending; if (this._active && generation === this._generation) this.sync(); },
  confirmGuest() { this._form.confirmGuest(); this.sync(); },
  login() { wx.navigateTo({ url: '/pages/account/index' }); },
});
