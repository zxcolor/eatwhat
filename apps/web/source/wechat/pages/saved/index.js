const service = require('../../lib/service');
const saved = require('../../lib/saved');

Page({
  data: { themeClass: '', section: 'FAVORITES', sectionLabel: '收藏', sections: [], rows: [], busy: false, enabled: false, signedIn: false, hasMore: false, loaded: false, notice: '', error: '', detail: null, detailContent: null },
  onLoad(options) { this._generation = 0; this._detailId = null; if (Object.hasOwn(saved.SECTIONS, options.section)) this.setData({ section: options.section, sectionLabel: saved.SECTIONS[options.section] }); },
  onShow() {
    this._visible = true; this._generation += 1;
    getApp().syncPage(this); wx.hideShareMenu();
    if (!service.state.consent) return wx.reLaunch({ url: '/pages/index/index' });
    this.sync();
    if (this.data.enabled && this.data.signedIn) this.reload();
  },
  onHide() { this.leave(); },
  onUnload() { this.leave(); },
  leave() { this._visible = false; this._generation += 1; this._detailId = null; saved.invalidate(); this.setData({ rows: [], detail: null, detailContent: null, busy: false, error: '' }); },
  syncState() { this._generation += 1; saved.syncCapabilities(); this.sync(); },
  sync() {
    let state = saved.view(this.data.section);
    if (!state.enabled && state.sections.length) {
      const section = state.sections[0].id;
      this._detailId = null; this.setData({ section, sectionLabel: saved.SECTIONS[section] });
      state = saved.view(section);
    }
    const detail = this._detailId ? state.rows.find(item => item.id === this._detailId) || null : null;
    if (!detail) this._detailId = null;
    this.setData({ ...state, detail, detailContent: detail });
  },
  async run(operation, success) {
    this.sync();
    if (this.data.busy || !this.data.enabled || !this.data.signedIn) return;
    const attempt = this._generation;
    const epoch = service.state.epoch;
    this.setData({ busy: true, error: '' });
    try {
      await operation();
      if (!this._visible || attempt !== this._generation || epoch !== service.state.epoch) return;
      if (success) wx.showToast({ title: success, icon: 'success' });
    } catch (error) {
      if (this._visible && attempt === this._generation && epoch === service.state.epoch && error.code !== 'STALE') this.setData({ error: error.message || '操作未完成，请重试。' });
    } finally { if (this._visible) this.sync(); }
  },
  reload() { return this.run(() => saved.load(this.data.section)); },
  loadMore() { if (this.data.hasMore) return this.run(() => saved.load(this.data.section, true)); },
  select(event) {
    const section = event.currentTarget.dataset.section;
    if (this.data.busy || !this.data.sections.some(item => item.id === section)) return;
    this._generation += 1; this._detailId = null;
    this.setData({ section, sectionLabel: saved.SECTIONS[section], error: '', detail: null });
    this.sync(); this.reload();
  },
  showDetail(event) {
    this.sync();
    const id = event.currentTarget.dataset.id;
    if (!this.data.rows.some(item => item.id === id)) return;
    this._detailId = id; this.sync();
  },
  // Keep only the existing safe display projection while CSS finishes the exit.
  // Leaving the page or changing account capabilities clears both projections.
  closeDetail() { this._detailId = null; this.setData({ detail: null }); },
  noop() {},
  move(event) { const id = event.currentTarget.dataset.id; return this.run(() => saved.moveFavorite(id), '已移动收藏'); },
  remove(event) {
    const id = event.currentTarget.dataset.id;
    const section = this.data.section;
    if (this.data.busy || !this.data.rows.some(item => item.id === id)) return;
    this.confirm(section === 'FAVORITES' ? '删除这条收藏？' : '删除这条私有反馈？', '删除后不能在小程序内撤销。', () => saved.remove(section, id), '已删除');
  },
  clearAll() {
    const section = this.data.section;
    if (!['HISTORY', 'PRIVATE_FEEDBACK'].includes(section) || !this.data.enabled || this.data.busy) return;
    this.confirm(section === 'HISTORY' ? '清空账号历史？' : '清空全部私有反馈？', section === 'HISTORY' ? '只清空服务器账号中的推荐操作历史，不影响本机最近决策。' : '全部私有反馈将从当前账号删除，此操作不能在小程序内撤销。', () => saved.clear(section), '已清空');
  },
  confirm(title, content, operation, success) {
    const attempt = this._generation;
    const revision = saved.revision();
    wx.showModal({ title, content, confirmText: '确认删除', confirmColor: '#c43333', success: result => {
      if (!result.confirm || !this._visible || attempt !== this._generation || saved.revision() !== revision) return;
      this.run(operation, success);
    } });
  },
  login() { wx.navigateTo({ url: '/pages/account/index' }); },
});
