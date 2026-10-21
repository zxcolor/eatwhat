const records = require('../../lib/canteen-records');

function timeLabel(value) {
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

Page({
  data: { themeClass: '', reducedMotion: false, entries: [], enabled: false, error: '', cleanupNeeded: false },
  onShow() {
    this._active = true;
    this._generation = (this._generation || 0) + 1;
    getApp().syncPage(this);
    wx.hideShareMenu();
    this.syncState();
  },
  onHide() { this._active = false; this._generation += 1; this.setData({ entries: [] }); },
  onUnload() { this._active = false; this._generation += 1; },
  syncState() {
    if (!this._active) return;
    const epoch = getApp().globalData.canteenEpoch || 0;
    if (this._epoch !== epoch) this._generation += 1;
    this._epoch = epoch;
    const cleanupError = records.getCleanupError();
    try {
      const enabled = records.isEnabled();
      const entries = records.list().map((entry, index) => ({
        id: index, ...records.describeChoice(entry),
        time: timeLabel(entry.recordedAtEpochMillis), priceText: entry.priceText,
        variantName: entry.variantName, weighted: entry.priceKind === 'weight',
      }));
      this.setData({ enabled, entries, cleanupNeeded: !!cleanupError, error: cleanupError });
    } catch (error) { this.setData({ entries: [], enabled: false, cleanupNeeded: !!cleanupError, error: cleanupError || error.message }); }
  },
  changeRemember(event) {
    if (!this._active || typeof event.detail?.value !== 'boolean') return;
    try { records.setEnabled(event.detail.value); this.setData({ cleanupNeeded: false, error: '' }); this.syncState(); }
    catch (error) {
      const cleanupError = records.getCleanupError();
      this.setData({ enabled: false, entries: [], cleanupNeeded: !!cleanupError, error: cleanupError || error.message });
    }
  },
  clearRecords() {
    if (!this._active || !this.data.entries.length) return;
    const generation = this._generation;
    wx.showModal({ title: '清空食堂选择记录', content: '只清除本机保存的食堂菜品选择。清除后无法恢复。', confirmText: '清空', success: result => {
      if (!result.confirm || !this._active || generation !== this._generation) return;
      try { records.clear(); this.setData({ error: '', cleanupNeeded: false }); this.syncState(); }
      catch (error) { this.setData({ error: error.message }); }
    } });
  },
  retryCleanup() {
    if (!this._active) return;
    try { records.withdraw(); this.setData({ cleanupNeeded: false, error: '' }); this.syncState(); }
    catch (error) { this.setData({ enabled: false, entries: [], cleanupNeeded: true, error: error.message }); }
  },
  openCanteen() { if (this._active) wx.navigateTo({ url: '/pages/canteen/index' }); },
});
