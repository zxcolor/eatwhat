const profile = require('../../lib/taste-profile');
const { SPICY_LEVELS, DEFAULT_SPICY_LEVEL, DEFAULT_FLAVOR_INTENSITY, normalizeAnswers, missingFields } = require('../../lib/decision/taste-profile');
const { getHomeTitle } = require('../../lib/home-title');

const FIELDS = ['spicyLevel', 'flavorIntensity'];
const VALUE_KEYS = { spicyLevel: 'spicyValue', flavorIntensity: 'intensityValue' };

Page({
  data: {
    themeClass: 'theme-light', reducedMotion: false,
    spicyLevels: SPICY_LEVELS, spicyValue: DEFAULT_SPICY_LEVEL, intensityValue: DEFAULT_FLAVOR_INTENSITY,
    defaultSpicy: DEFAULT_SPICY_LEVEL, defaultIntensity: DEFAULT_FLAVOR_INTENSITY,
    revision: 0, showEnter: false, dragging: false, busy: false, error: '',
  },
  onLoad(query = {}) {
    this._editRequested = query.edit === '1';
    this._editInitialized = false;
    this._active = false;
    this._generation = 0;
    this._finishing = false;
    this._touched = { spicyLevel: false, flavorIntensity: false };
    this._draggingFields = new Set();
    this._observedRevision = null;
  },
  onShow() {
    this._active = true;
    this._generation += 1;
    getApp().syncPage(this);
    this.stopTitleClock();
    this.updateTitle(this._titleGeneration);
    wx.hideShareMenu();
    try {
      if (this._editRequested && !this._editInitialized) {
        this._editInitialized = true;
        profile.beginEdit();
      }
      this.syncState();
    } catch (error) { this.showError(error); }
  },
  onHide() { this.suspend(); },
  onUnload() { this.suspend(); },
  suspend() {
    this._active = false;
    this._generation += 1;
    this._draggingFields.clear();
    clearTimeout(this._redirectTimer);
    this.stopTitleClock();
    this.setData({ dragging: false });
  },
  stopTitleClock() {
    clearTimeout(this._titleTimer);
    this._titleGeneration = (this._titleGeneration || 0) + 1;
    this._navigationTitle = '';
  },
  updateTitle(generation) {
    if (!this._active || generation !== this._titleGeneration) return;
    const now = Date.now();
    const title = getHomeTitle(now);
    if (title !== this._navigationTitle) {
      this._navigationTitle = title;
      wx.setNavigationBarTitle({ title, fail: () => {
        if (this._active && generation === this._titleGeneration) this._navigationTitle = '';
      } });
    }
    this._titleTimer = setTimeout(() => this.updateTitle(generation), 60000 - now % 60000);
  },
  syncState() {
    if (!this._active) return;
    const state = profile.getState();
    if (state.ready && !state.started && !this._editRequested) {
      this.queueHome();
      return;
    }
    // An external edit or expired draft cannot reuse this visit's gestures.
    if (this._observedRevision !== null && this._observedRevision !== state.revision) {
      this._touched = { spicyLevel: false, flavorIntensity: false };
    }
    this._observedRevision = state.revision;
    const answers = state.answers || {};
    const values = {};
    if (!this._draggingFields.has('spicyLevel')) values.spicyValue = answers.spicyLevel ?? DEFAULT_SPICY_LEVEL;
    if (!this._draggingFields.has('flavorIntensity')) values.intensityValue = answers.flavorIntensity ?? DEFAULT_FLAVOR_INTENSITY;
    this.setData({ ...values, revision: state.revision,
      showEnter: this._touched.spicyLevel && this._touched.flavorIntensity && missingFields(answers).length === 0,
      busy: this._finishing });
  },
  queueHome() {
    clearTimeout(this._redirectTimer);
    const generation = this._generation;
    this._redirectTimer = setTimeout(() => {
      if (!this._active || generation !== this._generation) return;
      const state = profile.getState();
      if (!state.ready || state.started || this._editRequested) { this.syncState(); return; }
      const fail = () => {
        if (this._active && generation === this._generation) this.setData({ error: '暂时无法进入首页，请重试。' });
      };
      try { wx.reLaunch({ url: '/pages/index/index', fail }); }
      catch (_) { fail(); }
    }, 0);
  },
  validDetail(event) {
    if (!this._active || this._finishing) return null;
    const { field, value, revision } = event.detail || {};
    if (!FIELDS.includes(field)) return null;
    if (revision !== this.data.revision || revision !== profile.getState().revision) {
      this.syncState();
      return null;
    }
    try { normalizeAnswers({ [field]: value }); }
    catch (_) { return null; }
    return { field, value };
  },
  onSliderDragState(event) {
    if (!this._active || !FIELDS.includes(event.detail?.field)) return;
    const { field, dragging } = event.detail;
    if (dragging) this._draggingFields.add(field);
    else this._draggingFields.delete(field);
    this.setData({ dragging: this._draggingFields.size > 0 });
    if (!dragging) this.syncState();
  },
  onSliderInput(event) {
    const detail = this.validDetail(event);
    if (detail) this.setData({ [VALUE_KEYS[detail.field]]: detail.value });
  },
  onSliderCommit(event) {
    const detail = this.validDetail(event);
    if (!detail || event.detail.dragged !== true) return;
    this.saveValue(detail.field, detail.value, true);
  },
  onSliderReset(event) {
    const detail = this.validDetail(event);
    if (!detail) return;
    this._touched[detail.field] = false;
    this.setData({ showEnter: false, [VALUE_KEYS[detail.field]]: detail.value });
    this.saveValue(detail.field, detail.value, false);
  },
  saveValue(field, value, dragged) {
    try {
      let state = profile.getState();
      if (this._observedRevision !== null && state.revision !== this._observedRevision) {
        this._touched = { spicyLevel: false, flavorIntensity: false };
      }
      if (!state.started) state = state.ready ? profile.beginEdit() : profile.start();
      const updated = profile.answer(field, value, state.revision);
      this._observedRevision = updated.revision;
      this._touched[field] = dragged;
      this.setData({ [VALUE_KEYS[field]]: value, error: '' });
      this.syncState();
    } catch (error) {
      this._touched[field] = false;
      this.setData({ showEnter: false });
      this.showError(error);
    }
  },
  async finish(event) {
    if (!this._active || this._finishing || this.data.dragging || !this.data.showEnter) return;
    const state = profile.getState();
    if (Number(event.currentTarget.dataset.revision) !== state.revision || !this._touched.spicyLevel || !this._touched.flavorIntensity) {
      this.syncState();
      return;
    }
    try {
      if (!profile.assess().ready) { this.syncState(); return; }
      this._finishing = true;
      const generation = this._generation;
      this.setData({ busy: true, error: '' });
      try { await getApp().completeTasteProfile(state.revision, 'home'); }
      catch (error) { if (this._active && generation === this._generation) this.showError(error); }
      finally {
        this._finishing = false;
        if (this._active && generation === this._generation) this.setData({ busy: false });
      }
    } catch (error) { this.showError(error); }
  },
  showError(error) {
    if (!this._active) return;
    let message = '暂时无法保存口味，请重试。';
    try { message = profile.getState().error || message; } catch (_) { /* Keep the local fallback. */ }
    if (error?.code === 'STALE_TASTE_PROFILE') message = '口味已更新，请重新拖动两个滑条。';
    if (error?.code === 'TASTE_NAVIGATION_ERROR') message = '口味已保存，暂时无法进入首页，请重试。';
    this.setData({ error: message });
  },
});
