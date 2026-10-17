const records = require('../../lib/local-records');
const service = require('../../lib/service');
const MEALS = { BREAKFAST: '早餐', LUNCH: '午餐', DINNER: '晚餐' };
const TRAVEL = { WALK: '步行', BIKE: '骑行', TRANSIT: '公交' };
function timeLabel(value) {
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
Page({
  data: { themeClass: '', entries: [], error: '' },
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
    if (!service.state.consent) { this.setData({ entries: [] }); return; }
    try {
      this.setData({ error: '', entries: records.list().map((entry, index) => ({
        id: index, title: `${timeLabel(entry.recordedAtEpochMillis)} · ${MEALS[entry.mealPeriod]}`,
        summary: `${entry.decisionMode === 'QUICK' ? '快速决策' : '引导决策'} · ${entry.budgetMaxYuan === null ? '预算不限' : `预算 ¥${entry.budgetMaxYuan}/人`} · ${entry.availableMinutes} 分钟 · ${TRAVEL[entry.travelMode]}`,
        count: entry.resultCount,
      })) });
    } catch (_) { this.setData({ entries: [], error: '本机记录暂时无法读取，请重试。' }); }
  },
  clearRecords() {
    if (!this._active || !this.data.entries.length) return;
    const generation = this._generation;
    wx.showModal({ title: '清空最近决策', content: '只清除本机的决策摘要。清除后无法恢复。', confirmText: '清空', success: result => {
      if (!result.confirm || !this._active || generation !== this._generation) return;
      try { records.clear(); this.syncState(); }
      catch (_) { this.setData({ error: '本机记录清除失败，请重试。' }); }
    } });
  },
});
