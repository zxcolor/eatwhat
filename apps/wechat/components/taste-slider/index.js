const { TIMING } = require('../../lib/decision-motion');
const MOVE_THRESHOLD = 6;
const END_FRAME_MS = TIMING.frame;
// Independent, staggered paths give the stream depth without frame-by-frame JS.
const PARTICLES = Array.from({ length: 14 }, (_, index) => ({
  id: index, top: 12 + (index * 29) % 77,
  duration: Math.round(1900 / (.8 + (index % 7) / 15)),
  delay: -Math.round(index * 1900 / 14),
  opacity: .4 + (index * 7 % 11) / 20,
  size: 1.5 + (index * 3 % 7) / 5,
}));

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }

function bounds(properties) {
  const valid = finite(properties.min) && finite(properties.max) && properties.max > properties.min &&
    finite(properties.step) && properties.step > 0 && properties.step <= properties.max - properties.min;
  return valid ? { min: properties.min, max: properties.max, step: properties.step, valid }
    : { min: 0, max: 1, step: 1, valid: false };
}

function snapped(value, range) {
  const raw = finite(value) ? value : range.min;
  const bounded = Math.min(range.max, Math.max(range.min, raw));
  const tick = range.min + Math.round((bounded - range.min) / range.step) * range.step;
  return Number(Math.min(range.max, Math.max(range.min, tick)).toFixed(6));
}

function pointOf(list, identifier) {
  if (!Array.isArray(list) || list.length !== 1) return null;
  const point = list[0];
  if (identifier !== undefined && point.identifier !== identifier) return null;
  const x = finite(point.clientX) ? point.clientX : point.pageX;
  const y = finite(point.clientY) ? point.clientY : point.pageY;
  return finite(x) && finite(y) ? { x, y, identifier: point.identifier } : null;
}

Component({
  options: { styleIsolation: 'isolated' },
  properties: {
    field: { type: String, value: '' },
    label: { type: String, value: '' },
    value: { type: Number, value: 0 },
    revision: { type: Number, value: 0 },
    min: { type: Number, value: 0 },
    max: { type: Number, value: 100 },
    step: { type: Number, value: 1 },
    labels: { type: Array, value: [] },
    defaultValue: { type: Number, value: 0 },
    disabled: { type: Boolean, value: false },
    reducedMotion: { type: Boolean, value: false },
    themeClass: { type: String, value: 'theme-light' },
  },
  data: {
    displayValue: 0, displayLabel: '0', percent: 0,
    isDiscrete: false, isUltra: false, activeSide: '', fillStyle: 'width:0;', ticks: [], particles: PARTICLES,
    nativeMin: 0, nativeMax: 100, nativeStep: 1,
    controlDisabled: false, dragging: false, pageVisible: true, pressMs: TIMING.press,
  },
  observers: {
    'value, revision, min, max, step, labels, label, field, defaultValue, disabled'() {
      if (this._attached) this.syncProperties();
    },
  },
  lifetimes: {
    attached() {
      this._attached = true;
      this._pageVisible = true;
      this._gesture = null;
      this._endTimer = null;
      this.syncProperties();
    },
    detached() {
      const field = this._gesture?.field;
      this._attached = false;
      this._pageVisible = false;
      this.clearEndTimer();
      this._gesture = null;
      if (field !== undefined) this.triggerEvent('dragstate', { field, dragging: false });
    },
  },
  pageLifetimes: {
    show() {
      this._pageVisible = true;
      this.setData({ pageVisible: true });
      this.syncProperties();
    },
    hide() {
      this.cancelGesture(true);
      this._pageVisible = false;
      this.setData({ pageVisible: false });
    },
  },
  methods: {
    live() { return this._attached && this._pageVisible && !this.data.controlDisabled; },
    clearEndTimer() {
      if (this._endTimer !== null) clearTimeout(this._endTimer);
      this._endTimer = null;
    },
    syncProperties() {
      const range = bounds(this.properties);
      const key = JSON.stringify([this.properties.field, this.properties.revision, this.properties.label, range,
        this.properties.labels, this.properties.defaultValue, this.properties.disabled]);
      const value = snapped(this.properties.value, range);
      // Input echoes can cross the native bridge after a newer move. While the
      // same gesture owns the control, even a lagging echo must not rewind it.
      if (this._gesture && key === this._configuration) return;
      if (this._gesture) this.cancelGesture(false);
      this._configuration = key;
      this._range = range;
      this.setData({ nativeMin: range.min, nativeMax: range.max, nativeStep: range.step,
        controlDisabled: this.properties.disabled || !range.valid });
      this.present(value);
    },
    present(rawValue) {
      const range = this._range || bounds(this.properties);
      const value = snapped(rawValue, range);
      const labels = this.properties.labels;
      const index = Math.round((value - range.min) / range.step);
      const label = Array.isArray(labels) && typeof labels[index] === 'string' ? labels[index] : String(value);
      const percent = (value - range.min) / (range.max - range.min) * 100;
      const offset = 21 - percent * .42;
      const fillStyle = percent <= 0 ? 'width:0;' : percent >= 100 ? 'width:100%;'
        : `width:calc(${percent}% ${offset < 0 ? '-' : '+'} ${Math.abs(offset)}px);`;
      const isDiscrete = Array.isArray(labels) && labels.length > 0;
      this._value = value;
      this.setData({ displayValue: value, displayLabel: label,
        percent, fillStyle, isDiscrete,
        isUltra: this.properties.field === 'spicyLevel' && isDiscrete && value === range.max,
        ticks: isDiscrete ? labels.map((_, i) => ({ id: i, value: range.min + i * range.step,
          percent: i / Math.max(1, labels.length - 1) * 100 })) : [] });
      return value;
    },
    preview(value, force = false) {
      const before = this._value;
      const next = this.present(value);
      if (force || next !== before) this.triggerEvent('input', {
        field: this._gesture ? this._gesture.field : this.properties.field,
        revision: this._gesture ? this._gesture.revision : this.properties.revision,
        value: next,
      });
    },
    touchStart(event) {
      if (!this.live()) return;
      const point = pointOf(event.touches);
      if (!point) { this.cancelGesture(true); return; }
      if (this._gesture?.released) this.finishGesture();
      else if (this._gesture) this.cancelGesture(true);
      this.clearEndTimer();
      this._gesture = {
        field: this.properties.field, revision: this.properties.revision, identifier: point.identifier,
        x: point.x, y: point.y, lastX: point.x, startValue: this._value, nativeValue: this._value,
        axis: '', moved: false, released: false, nativeFinalSeen: false,
      };
      this.setData({ dragging: true, activeSide: '' });
      this.triggerEvent('dragstate', { field: this.properties.field, dragging: true });
    },
    observeMovement(point) {
      const gesture = this._gesture;
      if (!gesture || !point || gesture.axis === 'y') return;
      const dx = Math.abs(point.x - gesture.x);
      const dy = Math.abs(point.y - gesture.y);
      if (!gesture.axis) {
        // Once a scroll wins, this touch cannot later masquerade as a drag.
        if (dy >= MOVE_THRESHOLD && dy >= dx) gesture.axis = 'y';
        else if (dx >= MOVE_THRESHOLD && dx > dy * 1.25) gesture.axis = 'x';
      }
      if (gesture.axis === 'x') {
        gesture.moved = true;
        const delta = point.x - gesture.lastX;
        if (!this.data.isDiscrete && Math.abs(delta) > .5) this.setData({ activeSide: delta < 0 ? 'left' : 'right' });
        this.preview(gesture.nativeValue);
      }
      gesture.lastX = point.x;
    },
    touchMove(event) {
      if (!this.live() || !this._gesture || this._gesture.released) return;
      const point = pointOf(event.touches, this._gesture.identifier);
      if (!point) { this.cancelGesture(true); return; }
      this.observeMovement(point);
    },
    nativeChanging(event) {
      if (!this.live() || !this._gesture || !finite(event.detail?.value)) return;
      this._gesture.nativeValue = snapped(event.detail.value, this._range);
      if (this._gesture.axis === 'x') this.preview(this._gesture.nativeValue);
    },
    nativeChange(event) {
      if (!this.live() || !finite(event.detail?.value)) return;
      const gesture = this._gesture;
      if (!gesture) {
        // A delayed native callback cannot replace the controlled draft after
        // its gesture has ended, been cancelled or changed revision.
        this.present(this.properties.value);
        return;
      }
      gesture.nativeValue = snapped(event.detail.value, this._range);
      gesture.nativeFinalSeen = true;
      if (gesture.axis === 'x') this.preview(gesture.nativeValue);
      if (gesture.released) this.finishGesture();
    },
    touchEnd(event) {
      if (!this._gesture) return;
      const gesture = this._gesture;
      const point = pointOf(event.changedTouches, gesture.identifier);
      if (!this.live() || !point || event.touches?.length) { this.cancelGesture(true); return; }
      this.observeMovement(point);
      gesture.released = true;
      if (gesture.axis !== 'x' || !gesture.moved) { this.cancelGesture(false); return; }
      if (gesture.nativeFinalSeen) { this.finishGesture(); return; }
      // Native change and touchend can arrive in either order. The fallback
      // also commits a real out-and-back drag whose final value is unchanged.
      this.clearEndTimer();
      this._endTimer = setTimeout(() => {
        this._endTimer = null;
        if (this._gesture === gesture) this.finishGesture();
      }, END_FRAME_MS);
    },
    finishGesture() {
      const gesture = this._gesture;
      if (!gesture || !gesture.released) return;
      if (!this.live() || gesture.axis !== 'x' || !gesture.moved) { this.cancelGesture(true); return; }
      this.clearEndTimer();
      const value = this.present(gesture.nativeValue);
      this._gesture = null;
      this.setData({ dragging: false, activeSide: '' });
      this.triggerEvent('commit', { field: gesture.field, revision: gesture.revision, value, dragged: true });
      this.triggerEvent('dragstate', { field: gesture.field, dragging: false });
    },
    touchCancel() { this.cancelGesture(true); },
    cancelGesture(rollbackInput) {
      const gesture = this._gesture;
      this.clearEndTimer();
      if (!gesture) return;
      this._gesture = null;
      const value = this.present(gesture.startValue);
      this.setData({ dragging: false, activeSide: '' });
      if (rollbackInput) this.triggerEvent('input', { field: gesture.field, revision: gesture.revision, value });
      this.triggerEvent('dragstate', { field: gesture.field, dragging: false });
    },
    reset() {
      if (!this.live()) return;
      const revision = this.properties.revision;
      this.cancelGesture(false);
      const value = this.present(this.properties.defaultValue);
      this.triggerEvent('reset', { field: this.properties.field, revision, value });
    },
  },
});
