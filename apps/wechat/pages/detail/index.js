const service = require('../../lib/service');
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
  data: { themeClass: '', result: null, current: false, canNavigate: false, canCall: false, canCopy: false, actionNotice: '', error: '' },
  onLoad(options) {
    this._index = /^\d+$/.test(options.index || '') ? Number(options.index) : -1;
    this._response = service.state.results;
    this._epoch = service.state.epoch;
  },
  onShow() {
    getApp().syncPage(this);
    if (!service.state.consent) return wx.reLaunch({ url: '/pages/index/index' });
    wx.hideShareMenu();
    this.sync();
  },
  onUnload() { this._response = null; },
  syncState() {
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
    if (!result) return this.setData({ result: null, current: false, canNavigate: false, canCall: false, canCopy: false, actionNotice: '本次结果已失效，请返回重新获取。' });
    const canNavigate = result.actions.navigate === true && mapCoordinate(result.location) && !!(inline(result.name) || inline(result.address));
    const canCall = result.actions.call === true && !!phoneNumber(result.phone);
    const canCopy = result.actions.copyAddress === true && !!inline(result.address);
    const messages = [];
    if (!result.actions.navigate || !result.actions.call || !result.actions.copyAddress) messages.push('当前数据来源尚未开放部分操作。');
    if (result.actions.navigate && !mapCoordinate(result.location)) messages.push('地图坐标不可直接使用，地图操作暂不可用。');
    if (result.actions.call && !canCall) messages.push('暂无可靠电话。');
    if (result.actions.copyAddress && !canCopy) messages.push('暂无可靠地址。');
    this.setData({
      current: true, canNavigate, canCall, canCopy, actionNotice: messages.join(' '),
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
    wx.openLocation({ latitude: result.location.latitude, longitude: result.location.longitude, name: inline(result.name), address: inline(result.address), scale: 16, fail: () => this.setData({ error: '暂时无法打开地图，请稍后重试。' }) });
  },
  call() {
    this.sync();
    const result = this.currentResult();
    if (!result || !this.data.canCall) return;
    wx.makePhoneCall({ phoneNumber: phoneNumber(result.phone), fail: () => this.setData({ error: '未完成拨号，可稍后重试。' }) });
  },
  copyAddress() {
    this.sync();
    const result = this.currentResult();
    if (!result || !this.data.canCopy) return;
    wx.setClipboardData({ data: inline(result.address), fail: () => this.setData({ error: '暂时无法复制地址。' }) });
  },
  back() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.redirectTo({ url: '/pages/results/index' });
  },
});
