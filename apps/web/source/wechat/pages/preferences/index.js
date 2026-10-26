const profile = require('../../lib/taste-profile');
const { SPICY_LEVELS, SPICY_VALUES, DEFAULT_SPICY_LEVEL, DEFAULT_FLAVOR_INTENSITY, normalizeAnswers, missingFields } = require('../../lib/taste-model');
const { getHomeTitle } = require('../../lib/home-title');

const FIELDS = ['spicyLevel', 'flavorIntensity'];
const VALUE_KEYS = { spicyLevel: 'spicyValue', flavorIntensity: 'intensityValue' };
const DEFAULT_SPICY_INDEX = SPICY_VALUES.indexOf(DEFAULT_SPICY_LEVEL);

Page({
  data: {
    themeClass: 'theme-light', reducedMotion: false,
    spicyLevels: SPICY_LEVELS, spicyValue: DEFAULT_SPICY_INDEX, intensityValue: DEFAULT_FLAVOR_INTENSITY,
    defaultSpicy: DEFAULT_SPICY_INDEX,
    revision: 0, showEnter: false, dragging: false, busy: false, error: '',
  },
  onLoad(query = {}) {
    this._editRequested = query.edit === '1';
    this._editInitialized = false;
    this._active = false;
    this._generation = 0;
    this._finishing = false;
    this._touched = { spicyLevel: false, flavorIntensity: false };
    this._draggingFields = new Map();
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
    if (!this._draggingFields.has('spicyLevel')) values.spicyValue = answers.spicyLevel === undefined
      ? DEFAULT_SPICY_INDEX : SPICY_VALUES.indexOf(answers.spicyLevel);
    values.intensityValue = answers.flavorIntensity ?? DEFAULT_FLAVOR_INTENSITY;
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
    const { field, value, revision, gestureId } = event.detail || {};
    if (field !== 'spicyLevel' || this._draggingFields.get(field) !== gestureId || typeof gestureId !== 'string') return null;
    if (revision !== this.data.revision || revision !== profile.getState().revision) {
      this.syncState();
      return null;
    }
    if (!Number.isInteger(value) || value < 0 || value >= SPICY_VALUES.length) return null;
    const canonicalValue = SPICY_VALUES[value];
    try { normalizeAnswers({ [field]: canonicalValue }); }
    catch (_) { return null; }
    return { field, value, canonicalValue };
  },
  onSliderDragState(event) {
    if (!this._active || event.detail?.field !== 'spicyLevel') return;
    const { field, dragging, gestureId, revision } = event.detail;
    if (typeof gestureId !== 'string') return;
    if (dragging) {
      if (this._finishing || revision !== this.data.revision || revision !== profile.getState().revision) return;
      this._draggingFields.set(field, gestureId);
    } else {
      if (this._draggingFields.get(field) !== gestureId) return;
      this._draggingFields.delete(field);
    }
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
    this.saveValue(detail.field, detail.canonicalValue, true);
  },
  onSliderReset(event) {
    const detail = this.validDetail(event);
    if (!detail) return;
    this._touched[detail.field] = false;
    this.setData({ showEnter: false, [VALUE_KEYS[detail.field]]: detail.value });
    this.saveValue(detail.field, detail.canonicalValue, false);
  },
  selectFlavor(event) {
    if (!this._active || this._finishing || this.data.dragging || this._draggingFields.size > 0) return;
    const { value, revision } = event.currentTarget?.dataset || {};
    if (![0, 100, '0', '100'].includes(value)) return;
    if (Number(revision) !== this.data.revision || Number(revision) !== profile.getState().revision) {
      this.syncState();
      return;
    }
    this.saveValue('flavorIntensity', Number(value), true);
  },
  saveValue(field, value, explicitlySelected) {
    if (!this._active || this._finishing || !FIELDS.includes(field)) return;
    try {
      // Persist only canonical values. The spice slider always renders 0..4.
      normalizeAnswers({ [field]: value });
      let state = profile.getState();
      if (this._observedRevision !== null && state.revision !== this._observedRevision) {
        this._touched = { spicyLevel: false, flavorIntensity: false };
      }
      if (!state.started) state = state.ready ? profile.beginEdit() : profile.start();
      const updated = profile.answer(field, value, state.revision);
      this._observedRevision = updated.revision;
      this._touched[field] = explicitlySelected;
      this.setData({ [VALUE_KEYS[field]]: field === 'spicyLevel' ? SPICY_VALUES.indexOf(value) : value, error: '' });
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
    if (error?.code === 'STALE_TASTE_PROFILE') message = '口味已更新，请重新选择辣度和口味轻重。';
    if (error?.code === 'TASTE_NAVIGATION_ERROR') message = '口味已保存，暂时无法进入首页，请重试。';
    this.setData({ error: message });
  },
});
