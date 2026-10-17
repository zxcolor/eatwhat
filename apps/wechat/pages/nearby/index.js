const nearby = require('../../lib/nearby');
const service = require('../../lib/service');
const PHASES = { IDLE: '等待开启', PERMISSION: '等待定位授权', LOCATING: '正在定位', COLLECTING: '正在保存附近餐厅', DONE: '本次收集已结束', FAILED: '本次收集未完成' };
function timeLabel(value) {
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
Page({
  data: { themeClass: '', enabled: false, available: false, consent: false, busy: false, phase: 'IDLE', statusLabel: '', message: '', error: '', snapshots: [], total: 0, hasMore: false, canRetry: false },
  onShow() {
    this._active = true;
    this._generation = (this._generation || 0) + 1;
    this._limit = 20;
    this._expanded = null;
    getApp().syncPage(this);
    wx.hideShareMenu();
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = nearby.subscribe(() => this.syncState());
    this.syncState();
  },
  onHide() { this.leave(); },
  onUnload() { this.leave(); },
  leave() {
    this._active = false;
    this._generation += 1;
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
    this._expanded = null;
    this.setData({ snapshots: [], error: '' });
  },
  syncState() {
    if (!this._active) return;
    const state = nearby.state;
    const consent = service.state.consent;
    const busy = ['LOCATING', 'COLLECTING'].includes(state.phase);
    this.setData({ consent, enabled: state.enabled, available: state.available, phase: state.phase, busy,
      canRetry: consent && state.enabled && state.available && !busy,
      statusLabel: `${PHASES[state.phase]}${state.phase === 'LOCATING' ? `（第 ${state.attempt}/6 次）` : state.count ? ` · ${state.count} 家` : ''}`,
      message: state.message,
    });
    if (!consent) { this.setData({ snapshots: [], total: 0 }); return; }
    try {
      const snapshots = nearby.listSnapshots();
      this.setData({ total: snapshots.length, hasMore: snapshots.length > this._limit, snapshots: snapshots.slice(0, this._limit).map(snapshot => ({
        id: snapshot.id, time: timeLabel(snapshot.startedAtMillis), expires: timeLabel(snapshot.startedAtMillis + nearby.RETENTION_MS),
        status: { COLLECTING: '正在保存', COMPLETE: snapshot.limited ? '完成 · 已达两页上限' : '完成', PARTIAL: '部分保存' }[snapshot.status],
        count: snapshot.restaurants.length, pages: snapshot.pagesCollected,
        accuracy: snapshot.userLocation.accuracyMeters === null ? '精度未知' : `定位精度约 ${Math.round(snapshot.userLocation.accuracyMeters)} 米`,
        expanded: this._expanded === snapshot.id,
        places: this._expanded === snapshot.id ? snapshot.restaurants.map((place, index) => ({
          id: index, name: place.name, address: place.address, source: place.sourceAttribution,
          mode: place.dataMode === 'LIVE' ? '授权来源' : '演示数据',
          cost: place.averageCostYuan === null ? '价格未知' : `人均 ¥${place.averageCostYuan}`,
          rating: place.sourceRating === null ? '评分未知' : `来源评分 ${place.sourceRating}`,
          open: { OPEN: '营业中', CLOSED: '已打烊', UNKNOWN: '营业状态未知' }[place.openStatus],
        })) : [],
      })) });
    } catch (_) { this.setData({ snapshots: [], total: 0, error: '缓存读取或到期清理失败，请重试。' }); }
  },
  enableCollection() {
    if (!this._active || !service.state.consent || this.data.enabled) return;
    const generation = this._generation;
    wx.showModal({
      title: '开启附近餐厅缓存',
      content: '开启后，在服务允许且定位已授权时，每次打开小程序会获取当前位置，保存 3.5 km 内最多两页（50 家）餐厅、本次位置和精度。按本次打开时间在本机保留 90 天；空间不足时停止保存。可随时关闭或清除。',
      confirmText: '同意开启',
      success: async result => {
        if (!result.confirm || !this._active || generation !== this._generation || !service.state.consent) return;
        try { await nearby.setEnabled(true); }
        catch (_) { if (this._active && generation === this._generation) this.setData({ error: '开启失败，请重试。' }); }
        if (this._active && generation === this._generation) this.syncState();
      },
    });
  },
  async disableCollection() {
    if (!this._active) return;
    try { await nearby.setEnabled(false); this.setData({ error: '' }); }
    catch (_) { this.setData({ error: '关闭失败，请重试。' }); }
    if (this._active) this.syncState();
  },
  async retry() {
    if (!this._active || !this.data.canRetry) return;
    this.setData({ error: '' });
    const generation = this._generation;
    await nearby.retry();
    if (this._active && generation === this._generation) this.syncState();
  },
  openPermissionSettings() { if (this._active && service.state.consent) wx.openSetting({ success: () => { if (this._active) nearby.syncCapabilities(); } }); },
  dismiss() { if (this._active) nearby.dismissReminder(); },
  toggleSnapshot(event) { this._expanded = this._expanded === event.currentTarget.dataset.id ? null : event.currentTarget.dataset.id; this.syncState(); },
  loadMore() { this._limit += 20; this.syncState(); },
  clearCache() {
    if (!this._active) return;
    const generation = this._generation;
    wx.showModal({ title: '清除餐厅缓存', content: '将清除所有本机餐厅缓存及其中的位置、精度记录，并停止本次收集。', confirmText: '清除', success: result => {
      if (!result.confirm || !this._active || generation !== this._generation) return;
      try { nearby.clear(); this.setData({ error: '' }); this.syncState(); }
      catch (_) { this.setData({ error: '餐厅缓存清除失败，请重试。' }); }
    } });
  },
});
