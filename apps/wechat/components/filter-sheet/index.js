const decision = require('../../lib/decision/service');
const { createFilterDraft, filterStateKey, filterBounds, presentFilters, evaluateFilters } = require('../../lib/filter-view');

const TRANSITION_MS = 300;
const PREVIEW_INTERVAL_MS = 64;
const copy = value => JSON.parse(JSON.stringify(value));
const touch = event => event.touches?.length === 1 ? event.touches[0] : null;
const eventTime = event => Number.isFinite(event.timeStamp) ? event.timeStamp : Date.now();

Component({
  options: { styleIsolation: 'isolated' },
  properties: { visible: { type: Boolean, value: false }, themeClass: { type: String, value: 'theme-light' }, reducedMotion: { type: Boolean, value: false } },
  data: {
    mounted: false, entered: false, closing: false, dragging: false, dragY: 0, session: 0,
    prepared: false, countPending: true, count: null, counts: null, applying: false, error: '', stale: false,
    target: 'PACKAGE', targetUnit: '份套餐', originLabel: '', budget: {}, distance: {},
    spicyChoices: [], vegetarianOnly: false, preferMain: true, priorities: [], summary: [],
  },
  observers: { visible(value) { this.setVisible(value); } },
  lifetimes: {
    attached() {
      this._attached = true; this._pageVisible = true; this._generation = 0;
      this._active = false; this._opening = false; this._applying = false; this._drag = null;
      this._enterTimer = null; this._leaveTimer = null; this._countTimer = null;
      this._base = null; this._draft = null; this._desiredVisible = this.properties.visible === true;
      if (this._desiredVisible) this.openSheet();
    },
    detached() {
      this._attached = false; this._pageVisible = false; this._desiredVisible = false;
      this._active = false; this._opening = false; this._generation += 1; this._base = null; this._draft = null; this._drag = null;
      this.clearTimers();
    },
  },
  pageLifetimes: {
    show() { this._pageVisible = true; if (this._desiredVisible) this.openSheet(); },
    hide() { this._pageVisible = false; this.closeSheet(true, true); },
  },
  methods: {
    clearTimers() {
      for (const key of ['_enterTimer', '_leaveTimer', '_countTimer']) {
        if (this[key] !== null) clearTimeout(this[key]);
        this[key] = null;
      }
    },
    live(generation = this._generation) {
      return this._attached && this._pageVisible && this._desiredVisible && generation === this._generation;
    },
    setVisible(value) {
      this._desiredVisible = value === true;
      if (!this._attached) return;
      if (this._desiredVisible) this.openSheet();
      else this.closeSheet();
    },
    openSheet() {
      if (!this.live() || ((this._active || this._opening) && !this.data.closing)) return;
      this.clearTimers();
      const generation = ++this._generation;
      this._active = false; this._opening = true; this._applying = false; this._drag = null;
      if (!getApp().ensureTasteProfile()) { this.closeSheet(true, true); return; }
      try {
        this._base = decision.getState();
        this._baseKey = filterStateKey(this._base);
        this._draft = createFilterDraft(this._base);
        this._bounds = filterBounds(this._base);
        const alreadyMounted = this.data.mounted;
        this.setData({ ...presentFilters(this._base, this._draft, this._bounds),
          mounted: true, entered: alreadyMounted || this.properties.reducedMotion, closing: false, dragging: false, dragY: 0,
          session: generation, prepared: true, countPending: true, count: null, counts: null,
          applying: false, error: '', stale: false,
        }, () => {
          if (!this.live(generation)) return;
          this._active = true; this._opening = false;
          this.schedulePreview(true);
          if (!alreadyMounted && !this.properties.reducedMotion) this._enterTimer = setTimeout(() => {
            this._enterTimer = null;
            if (this.live(generation)) this.setData({ entered: true });
          }, 16);
        });
      } catch (_) {
        this._opening = false; this._base = null; this._draft = null;
        this.setData({ mounted: true, entered: true, closing: false, prepared: false,
          session: generation, count: null, counts: null, countPending: false, applying: false,
          error: '暂时无法读取条件，请关闭后重新打开筛选。' });
      }
    },
    closeSheet(notify = false, immediate = false) {
      const shouldNotify = notify && this._desiredVisible;
      this._desiredVisible = false; this._active = false; this._opening = false; this._applying = false; this._drag = null;
      this._base = null; this._draft = null;
      if (!immediate && this.data.closing && this._leaveTimer !== null) return;
      this.clearTimers();
      const generation = ++this._generation;
      if (this._attached) {
        if (immediate || !this.data.mounted) this.setData({ mounted: false, entered: false, closing: false, dragging: false, dragY: 0, applying: false });
        else {
          this.setData({ entered: false, closing: true, dragging: false, applying: false });
          this._leaveTimer = setTimeout(() => {
            this._leaveTimer = null;
            if (this._attached && !this._desiredVisible && generation === this._generation) this.setData({ mounted: false, closing: false, dragY: 0 });
          }, this.properties.reducedMotion ? 0 : TRANSITION_MS);
        }
      }
      if (shouldNotify) this.triggerEvent('close');
    },
    close(event) {
      if (event && Number(event.currentTarget?.dataset?.session) !== this._generation) return;
      this.closeSheet(true);
    },
    checkContext() {
      if (!getApp().ensureTasteProfile()) { this.closeSheet(true, true); return false; }
      if (!this._base || filterStateKey(decision.getState()) !== this._baseKey) {
        if (this._countTimer !== null) clearTimeout(this._countTimer);
        this._countTimer = null;
        this.setData({ stale: true, count: null, counts: null, countPending: false,
          error: '本次条件已变化，请关闭后重新打开筛选。' });
        return false;
      }
      return true;
    },
    current(event) {
      if (!this.live() || !this._active || this._applying || !this._draft || this.data.stale) return false;
      if (Number(event?.currentTarget?.dataset?.session) !== this._generation) return false;
      return this.checkContext();
    },
    schedulePreview(immediate = false) {
      if (this._countTimer !== null || !this.live() || !this._draft) return;
      const generation = this._generation;
      this._countTimer = setTimeout(() => {
        this._countTimer = null;
        if (!this.live(generation) || !this._draft) return;
        try {
          if (!this.checkContext()) return;
          const counts = evaluateFilters(this._base, this._draft);
          if (this.live(generation)) this.setData({ counts, count: counts.feasible, countPending: false });
        } catch (_) {
          if (this.live(generation)) this.setData({ counts: null, count: null, countPending: false, error: '暂时无法核对这些条件，请关闭后重新打开筛选。' });
        }
      }, immediate ? 0 : PREVIEW_INTERVAL_MS);
    },
    updateDraft() {
      this.setData({ ...presentFilters(this._base, this._draft, this._bounds), countPending: true, error: '' });
      this.schedulePreview();
    },
    rangeChanging(event) {
      if (!this.current(event)) return;
      const key = event.currentTarget.dataset.key;
      const value = Number(event.detail.value);
      const max = key === 'budgetCents' ? this._bounds.budgetMax : key === 'maxDistanceUnits' ? this._bounds.distanceMax : -1;
      if (!Number.isFinite(value) || value < 0 || value > max) return;
      this._draft[key] = key === 'budgetCents' ? Math.round(value * 100) : value;
      this.updateDraft();
    },
    clearLimit(event) {
      if (!this.current(event)) return;
      const key = event.currentTarget.dataset.key;
      if (!['budgetCents', 'maxDistanceUnits'].includes(key)) return;
      this._draft[key] = null;
      this.updateDraft();
    },
    selectSpicy(event) {
      if (!this.current(event)) return;
      const index = Number(event.currentTarget.dataset.index);
      const option = Number.isInteger(index) ? this.data.spicyChoices[index] : null;
      if (!option) return;
      this._draft.maxSpicy = option.value;
      this.updateDraft();
    },
    toggle(event) {
      if (!this.current(event)) return;
      const key = event.currentTarget.dataset.key;
      if (!['vegetarianOnly', 'preferMain'].includes(key) || (key === 'preferMain' && this._base.target !== 'PACKAGE')) return;
      this._draft[key] = event.detail.value === true;
      this.updateDraft();
    },
    priorityChanging(event) {
      if (!this.current(event)) return;
      const key = event.currentTarget.dataset.key;
      const value = Number(event.detail.value);
      if (!['price', 'distance', 'main'].includes(key) || !Number.isInteger(value) || value < 0 || value > 6
        || (key === 'main' && (this._base.target !== 'PACKAGE' || !this._draft.preferMain))) return;
      this._draft.weights[key] = value;
      this.updateDraft();
    },
    apply(event) {
      if (!this.current(event) || this.data.countPending || this.data.count === null) return;
      try {
        const latest = decision.getState();
        if (filterStateKey(latest) !== this._baseKey) {
          this.setData({ stale: true, count: null, counts: null, error: '本次条件已变化，请关闭后重新打开筛选。' });
          return;
        }
        const counts = evaluateFilters(latest, this._draft);
        if (!getApp().ensureTasteProfile()) { this.closeSheet(true, true); return; }
        this._applying = true;
        this.setData({ applying: true, error: '' });
        const state = decision.configure({ options: copy(this._draft), strategy: 'explicit' });
        this.closeSheet();
        this.triggerEvent('apply', { state, count: counts.feasible, counts });
        this.triggerEvent('close');
      } catch (_) {
        this._applying = false;
        if (this.live()) this.setData({ applying: false, error: '无法应用这些条件，请调整后重试。' });
      }
    },
    dragStart(event) {
      if (!this.current(event)) return;
      const point = touch(event);
      if (!point) return;
      this._drag = { x: point.clientX, y: point.clientY, at: eventTime(event), distance: 0, horizontal: false };
      this.setData({ dragging: true });
    },
    dragMove(event) {
      if (!this._drag || !this.current(event)) return;
      const point = touch(event);
      if (!point) { this.dragCancel(); return; }
      const dy = point.clientY - this._drag.y;
      const dx = Math.abs(point.clientX - this._drag.x);
      if (dx > 12 && dx > Math.abs(dy)) this._drag.horizontal = true;
      if (this._drag.horizontal) return;
      this._drag.distance = Math.max(0, Math.min(400, dy));
      this.setData({ dragY: this.properties.reducedMotion ? 0 : this._drag.distance });
    },
    dragEnd(event) {
      if (!this._drag || !this.current(event)) return;
      const { distance, at, horizontal } = this._drag;
      const velocity = distance / Math.max(1, eventTime(event) - at);
      this._drag = null;
      if (!horizontal && (distance >= 90 || (distance >= 30 && velocity >= 0.55))) this.close();
      else this.setData({ dragging: false, dragY: 0 });
    },
    dragCancel(event) {
      if (event && !this.current(event)) return;
      this._drag = null;
      if (this._attached) this.setData({ dragging: false, dragY: 0 });
    },
    swallow() {},
  },
});
