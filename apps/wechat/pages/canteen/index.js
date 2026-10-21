const decision = require('../../lib/canteen-decision');
const records = require('../../lib/canteen-records');
const { TIMING } = require('../../lib/decision-motion');

// Parse the decimal text directly so a strict budget is always integer fen.
function budgetFen(text) {
  const value = text.trim();
  if (!value) return null;
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) throw new Error('请输入有效预算，最多两位小数；留空为不限。');
  const [yuan, decimals = ''] = value.split('.');
  const amount = Number(yuan) * 100 + Number(decimals.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount)) throw new Error('预算金额过大，请重新输入。');
  return amount;
}

Page({
  data: {
    themeClass: '', reducedMotion: false, filtersOpen: false, budgetText: '',
    categories: ['全部分类', ...decision.getCategories()], categoryIndex: 0,
    filterSummary: '预算不限 · 全部分类', filterError: '', error: '', recordError: '',
    totalCount: 0, remainingCount: 0, seenCount: 0, weightedExcludedCount: 0,
    status: 'idle', cards: [], revision: 0, busy: false, confirmed: false,
    confirmationText: '', recordsEnabled: false, storageChecked: false, cleanupNeeded: false,
  },
  onLoad() {
    this._round = decision.createRound();
    this._revision = 0;
    this._generation = 0;
    this._filtersValid = true;
  },
  onShow() {
    this._active = true;
    getApp().syncPage(this);
    wx.hideShareMenu();
    this.syncState();
  },
  onHide() { this.suspend(); },
  onUnload() { this.suspend(); this._round = null; this._receipt = null; },
  suspend() {
    this._active = false;
    this._generation += 1;
    clearTimeout(this._motionTimer);
    this.setData({ busy: false });
  },
  syncState() {
    if (!this._active || !this._round) return;
    const epoch = getApp().globalData.canteenEpoch || 0;
    if (this._epoch !== undefined && this._epoch !== epoch) {
      this._round.restart();
      this.clearConfirmation();
    }
    this._epoch = epoch;
    this.readStorageChoice();
    this.render();
  },
  readStorageChoice() {
    const cleanupError = records.getCleanupError();
    try {
      const enabled = records.isEnabled();
      if (this._savedChoice) {
        const retained = enabled && records.list().some(entry => entry.recordedAtEpochMillis >= this._confirmedAt &&
          entry.itemId === this._receipt?.itemId && entry.variantId === this._receipt?.variantId);
        if (!retained) {
          this._savedChoice = false;
          this.setData({ confirmationText: '已确认，仅保留本次选择。' });
        }
      }
      this.setData({ recordsEnabled: enabled, storageChecked: true, cleanupNeeded: !!cleanupError, recordError: cleanupError });
    }
    catch (error) { this.setData({ recordsEnabled: false, storageChecked: false, cleanupNeeded: !!cleanupError, recordError: cleanupError || error.message }); }
  },
  render() {
    const state = this._round.snapshot();
    const candidate = this._filtersValid ? state.current : null;
    const item = candidate?.item;
    const selected = candidate?.variants.find(variant => variant.id === state.selectedVariantId);
    this.setData({
      revision: ++this._revision,
      totalCount: this._filtersValid ? state.totalCount : 0,
      remainingCount: this._filtersValid ? state.remainingCount : 0,
      seenCount: this._filtersValid ? state.seenCount : 0,
      weightedExcludedCount: this._filtersValid ? state.weightedExcludedCount : 0,
      status: this._filtersValid ? state.status : 'invalid',
      cards: item ? [{
        id: item.id, name: item.name, stallName: candidate.stall.name, category: item.category,
        priceKind: item.price.kind, originalPriceText: item.originalPriceText,
        priceLabel: item.price.kind === 'weight' ? '称重计价' : item.price.kind === 'variants' ? selected?.originalPriceText || '请选择规格' : item.originalPriceText,
        notes: item.notes.filter(note => !item.originalPriceText.includes(note)),
        variants: item.price.kind === 'variants' ? item.price.variants.map(variant => ({
          ...variant, allowed: candidate.variants.some(allowed => allowed.id === variant.id),
          selected: variant.id === state.selectedVariantId,
          budgetLabel: state.filters.budgetMaxFen === null ? '' : candidate.variants.some(allowed => allowed.id === variant.id) ? '预算内可选' : '超出预算',
        })) : [],
        canConfirm: item.price.kind !== 'variants' || !!selected,
      }] : [],
    });
  },
  accepts(event) {
    const revision = event?.currentTarget?.dataset?.revision;
    return this._active && this._round && !this.data.busy &&
      (revision === undefined || Number(revision) === this._revision);
  },
  clearConfirmation() {
    this._generation += 1;
    clearTimeout(this._motionTimer);
    this._receipt = null;
    this._savedChoice = false;
    this.setData({ busy: false, confirmed: false, confirmationText: '', error: '' });
  },
  toggleFilters() { if (this._active) this.setData({ filtersOpen: !this.data.filtersOpen }); },
  openFilters() { if (this._active) this.setData({ filtersOpen: true }); },
  inputBudget(event) {
    if (!this._active) return;
    this.setData({ budgetText: String(event.detail.value).slice(0, 10) });
    this.applyFilters();
  },
  changeCategory(event) {
    if (!this._active) return;
    const index = Number(event.detail.value);
    if (!Number.isInteger(index) || index < 0 || index >= this.data.categories.length) return;
    this.setData({ categoryIndex: index });
    this.applyFilters();
  },
  applyFilters() {
    this.clearConfirmation();
    try {
      const budgetMaxFen = budgetFen(this.data.budgetText);
      const category = this.data.categoryIndex ? this.data.categories[this.data.categoryIndex] : null;
      this._round.configure({ budgetMaxFen, category });
      // An input gesture starts a fresh round even if the parsed value is unchanged.
      this._round.restart();
      this._filtersValid = true;
      this.setData({ filterError: '', filterSummary: `${budgetMaxFen === null ? '预算不限' : `${budgetMaxFen / 100} 元以内`} · ${category || '全部分类'}` });
    } catch (error) {
      this._round.restart();
      this._filtersValid = false;
      this.setData({ filterError: error.message, filterSummary: '请完成预算输入' });
    }
    this.render();
  },
  clearFilters() {
    if (!this._active) return;
    this.setData({ budgetText: '', categoryIndex: 0 });
    this.applyFilters();
  },
  next(event) {
    if (!this.accepts(event) || !this._filtersValid) return;
    const before = this._round.snapshot();
    if (before.current && !before.remainingCount) return;
    try {
      this.clearConfirmation();
      this._round.next();
      this.render();
      if (!this.data.cards.length) return;
      const generation = this._generation;
      this.setData({ busy: true });
      this._motionTimer = setTimeout(() => {
        if (this._active && generation === this._generation) this.setData({ busy: false });
      }, TIMING.press);
    } catch (error) { this.setData({ error: error.message, busy: false }); }
  },
  restart(event) {
    if (!this.accepts(event) || !this._filtersValid) return;
    this.clearConfirmation();
    this._round.restart();
    this.render();
  },
  selectVariant(event) {
    if (!this.accepts(event) || !this._filtersValid || this.data.confirmed) return;
    try { this._round.selectVariant(event.currentTarget.dataset.id); this.setData({ error: '' }); this.render(); }
    catch (error) { this.setData({ error: error.message }); }
  },
  confirm(event) {
    if (!this.accepts(event) || !this._filtersValid || this.data.confirmed) return;
    let receipt;
    try { receipt = this._round.confirmation(); }
    catch (error) { this.setData({ error: error.message }); return; }
    this._receipt = receipt;
    this._confirmedAt = Date.now();
    this.setData({ confirmed: true, error: '', confirmationText: '这一餐，就吃这个。' });
    try {
      const saved = records.recordChoice(receipt);
      this._savedChoice = saved;
      this.setData({ confirmationText: saved ? '已确认，并记在本机。' : '已确认，仅保留本次选择。', recordError: this.data.cleanupNeeded ? this.data.recordError : '' });
    } catch (error) {
      this.setData({ confirmationText: '已确认，本机记录未保存。', recordError: error.message });
    }
    this.render();
  },
  changeRemember(event) {
    if (!this._active || typeof event.detail?.value !== 'boolean') return;
    try { records.setEnabled(event.detail.value); this.setData({ cleanupNeeded: false, recordError: '' }); this.readStorageChoice(); }
    catch (error) {
      const cleanupError = records.getCleanupError();
      this.setData({ recordsEnabled: false, storageChecked: false, cleanupNeeded: !!cleanupError, recordError: cleanupError || error.message });
    }
  },
  retryCleanup() {
    if (!this._active) return;
    try { records.withdraw(); this.setData({ cleanupNeeded: false, recordError: '' }); this.readStorageChoice(); }
    catch (error) { this.setData({ recordsEnabled: false, cleanupNeeded: true, recordError: error.message }); }
  },
  openRecords() { if (this._active) wx.navigateTo({ url: '/pages/canteen-records/index' }); },
});
