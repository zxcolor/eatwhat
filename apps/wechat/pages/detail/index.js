const service = require('../../lib/service');
const saved = require('../../lib/saved');
const OPEN_LABELS = { OPEN: '营业中', CLOSED: '已休息', UNKNOWN: '营业状态未知' };

function inline(value) { return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim() : ''; }
function phoneNumber(value) {
  const text = inline(value);
  if (!/^[+\d\s()（）-]+$/.test(text)) return '';
  const normalized = text.replace(/[\s()（）-]/g, '');
  return /^\+?\d{5,20}$/.test(normalized) ? normalized : '';
}
function mapCoordinate(location) {
  return !!(location && location.crs === 'GCJ02' && Number.isFinite(location.latitude) && Number.isFinite(location.longitude) && Math.abs(location.latitude) <= 90 && Math.abs(location.longitude) <= 180);
}

Page({
  data: { themeClass: '', result: null, current: false, canNavigate: false, canCall: false, canCopy: false, actionNotice: '', error: '', canFavorite: false, canFeedback: false, favoriteSaved: false, feedbackTypes: [], saveBusy: false, saveNotice: '' },
  onLoad(options) {
    this._saveGeneration = 0;
    this._index = /^\d+$/.test(options.index || '') ? Number(options.index) : -1;
    this._response = service.state.results;
    this._epoch = service.state.epoch;
  },
  onShow() {
    this._visible = true;
    this._saveGeneration += 1;
    getApp().syncPage(this);
    if (!service.state.consent) return wx.reLaunch({ url: '/pages/index/index' });
    wx.hideShareMenu();
    this.sync();
  },
  onHide() { this._visible = false; this._saveGeneration += 1; this.setData({ saveBusy: false, error: '' }); },
  onUnload() { this._visible = false; this._saveGeneration += 1; this._response = null; },
  syncState() {
    this._saveGeneration += 1;
    if (!service.state.consent || service.state.epoch !== this._epoch || service.state.results !== this._response) this._response = null;
    this.sync();
  },
  currentResult() {
    const state = service.state;
    const response = state.results;
    if (!state.consent || state.status !== 'ready' || !state.config || !state.config.serviceCapabilities || !state.config.serviceCapabilities.recommendationsEnabled || !response || response !== this._response || state.epoch !== this._epoch) return null;
    const timestamp = Date.parse(response.generatedAt);
    const age = Date.now() - timestamp;
    if (!Number.isFinite(timestamp) || age < -60000 || age >= 7200000) return null;
    return response.results[this._index] || null;
  },
  sync() {
    const result = this.currentResult();
    if (!result) return this.setData({ result: null, current: false, canNavigate: false, canCall: false, canCopy: false, canFavorite: false, canFeedback: false, favoriteSaved: false, feedbackTypes: [], saveBusy: false, saveNotice: '', actionNotice: '本次结果已失效，请返回重新获取。' });
    const canNavigate = result.actions.navigate === true && mapCoordinate(result.location) && !!(inline(result.name) || inline(result.address));
    const canCall = result.actions.call === true && !!phoneNumber(result.phone);
    const canCopy = result.actions.copyAddress === true && !!inline(result.address);
    const messages = [];
    if (!result.actions.navigate || !result.actions.call || !result.actions.copyAddress) messages.push('当前数据来源尚未开放部分操作。');
    if (result.actions.navigate && !mapCoordinate(result.location)) messages.push('地图坐标不可直接使用，地图操作暂不可用。');
    if (result.actions.call && !canCall) messages.push('暂无可靠电话。');
    if (result.actions.copyAddress && !canCopy) messages.push('暂无可靠地址。');
    const persistence = saved.creationView(this._response, result);
    this.setData({
      current: true, canNavigate, canCall, canCopy, actionNotice: messages.join(' '),
      canFavorite: persistence.canFavorite, canFeedback: persistence.canFeedback,
      favoriteSaved: persistence.favoriteSaved, feedbackTypes: persistence.feedbackTypes,
      saveBusy: persistence.busy, saveNotice: persistence.notice,
      result: {
        name: result.name, address: result.address, sourceAttribution: result.sourceAttribution,
        mode: result.dataMode === 'LIVE' ? '实时结果' : '演示结果',
        openLabel: OPEN_LABELS[result.openStatus] || OPEN_LABELS.UNKNOWN,
        price: result.averageCostYuan === null ? '人均未知' : `约 ¥${Math.round(result.averageCostYuan)} / 人`,
        distance: result.distanceMeters < 1000 ? `${Math.round(result.distanceMeters)} 米` : `${(result.distanceMeters / 1000).toFixed(1)} 公里`,
        travel: `${Math.round(result.estimatedTravelMinutes)} 分钟`, meal: `${Math.round(result.estimatedMealMinutes)} 分钟`,
        sourceRating: result.sourceRating === null ? '' : result.sourceRating.toFixed(1),
        tags: result.tags, reasons: result.reasons, warnings: result.warnings,
      },
    });
  },
  navigate() {
    this.sync();
    const result = this.currentResult();
    if (!result || !this.data.canNavigate) return;
    const response = this._response;
    wx.openLocation({ latitude: result.location.latitude, longitude: result.location.longitude, name: inline(result.name), address: inline(result.address), scale: 16, success: () => { service.recordEvent(this._index, 'NAVIGATION', response); }, fail: () => this.actionError(response, '暂时无法打开地图，请稍后重试。') });
  },
  call() {
    this.sync();
    const result = this.currentResult();
    if (!result || !this.data.canCall) return;
    const response = this._response;
    wx.makePhoneCall({ phoneNumber: phoneNumber(result.phone), success: () => { service.recordEvent(this._index, 'CALL', response); }, fail: () => this.actionError(response, '未完成拨号，可稍后重试。') });
  },
  copyAddress() {
    this.sync();
    const result = this.currentResult();
    if (!result || !this.data.canCopy) return;
    const response = this._response;
    wx.setClipboardData({ data: inline(result.address), fail: () => this.actionError(response, '暂时无法复制地址。') });
  },
  actionError(response, message) { if (this._visible && response === this._response && this.currentResult()) this.setData({ error: message }); },
  saveFavorite() {
    this.sync();
    if (!this.data.canFavorite || this.data.favoriteSaved || this.data.saveBusy) return;
    const attempt = this._saveGeneration;
    const revision = saved.revision();
    wx.showActionSheet({ itemList: ['想去', '常吃'], success: result => {
      if (!this._visible || attempt !== this._saveGeneration || saved.revision() !== revision || ![0, 1].includes(result.tapIndex)) return;
      this.persist('FAVORITES', result.tapIndex === 0 ? 'WANT_TO_GO' : 'REGULAR');
    } });
  },
  feedback(event) { return this.persist('PRIVATE_FEEDBACK', event.currentTarget.dataset.type); },
  async persist(section, choice) {
    this.sync();
    const result = this.currentResult();
    if (!result || this.data.saveBusy || section === 'FAVORITES' && (!this.data.canFavorite || this.data.favoriteSaved) || section === 'PRIVATE_FEEDBACK' && (!this.data.canFeedback || !this.data.feedbackTypes.some(item => item.type === choice && !item.submitted))) return;
    const attempt = ++this._saveGeneration;
    const epoch = service.state.epoch;
    this.setData({ saveBusy: true, error: '' });
    try {
      if (section === 'FAVORITES') await saved.createFavorite(this._response, result, choice);
      else await saved.createFeedback(this._response, result, choice);
      if (this._visible && attempt === this._saveGeneration && epoch === service.state.epoch && this.currentResult()) wx.showToast({ title: section === 'FAVORITES' ? '已收藏' : '已记录私有反馈', icon: 'success' });
    } catch (error) {
      if (this._visible && attempt === this._saveGeneration && epoch === service.state.epoch && this.currentResult()) this.setData({ error: error.message || '保存未完成，请重试。' });
    } finally { if (this._visible) this.sync(); }
  },
  openSaved() { wx.navigateTo({ url: '/pages/saved/index' }); },
  back() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.redirectTo({ url: '/pages/results/index' });
  },
});
