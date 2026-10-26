const { TIMING } = require('../../lib/decision-motion');
const MOVE_THRESHOLD = 6;
let nextControl = 0;
const PARTICLES = Array.from({ length: 14 }, (_, index) => {
  const duration = Math.round(1900 / (.8 + (index % 7) / 15));
  const phase = (index + .5) / 14;
  return {
    id: index, top: 12 + (index * 29) % 77, duration,
    delay: -Math.round(duration * phase), start: (1 - phase) * 100,
    opacity: .4 + (index * 7 % 11) / 20,
    size: 1.5 + (index * 3 % 7) / 5,
  };
});
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
  if (list?.length !== 1 || !list[0]) return null;
  const point = list[0];
  if (identifier !== undefined && point.identifier !== undefined && point.identifier !== identifier) return null;
  const x = finite(point.clientX) ? point.clientX : point.pageX;
  const y = finite(point.clientY) ? point.clientY : point.pageY;
  return finite(x) && finite(y) ? { x, y, clientX: point.clientX, pageX: point.pageX, identifier: point.identifier } : null;
}
function viewportX(point, geometry) {
  return finite(point.clientX) ? point.clientX : point.pageX - geometry.scrollLeft;
}
Component({
  options: { styleIsolation: 'isolated' },
  properties: {
    field: { type: String, value: '' }, label: { type: String, value: '' },
    value: { type: Number, value: 0 }, revision: { type: Number, value: 0 },
    min: { type: Number, value: 0 }, max: { type: Number, value: 100 }, step: { type: Number, value: 1 },
    labels: { type: Array, value: [] }, defaultValue: { type: Number, value: 0 },
    disabled: { type: Boolean, value: false }, reducedMotion: { type: Boolean, value: false },
    themeClass: { type: String, value: 'theme-light' },
  },
  data: {
    displayValue: 0, displayLabel: '0', percent: 0, isDiscrete: false, isUltra: false,
    activeSide: '', fillStyle: 'width:0;', ticks: [], particles: PARTICLES, particleRuns: [{ id: 0 }],
    controlDisabled: false, dragging: false, pageVisible: true, pressMs: TIMING.press,
  },
  observers: {
    'value, revision, min, max, step, labels, label, field, disabled'() {
      if (this._attached) this.syncProperties();
    },
    reducedMotion() { if (this._attached) this.restartParticles(true); },
  },
  lifetimes: {
    attached() {
      this._attached = true;
      this._pageVisible = true;
      this._viewReady = false;
      this._particleGeneration = 0;
      this._particlesStarted = false;
      this._controlId = ++nextControl;
      this._serial = 0;
      this._measureSequence = 0;
      this._measureTimer = null;
      this._gesture = null;
      this._geometry = null;
      this.syncProperties();
    },
    ready() {
      this._viewReady = true;
      this.restartParticles();
      this.measureTrack();
    },
    detached() {
      const gesture = this._gesture;
      this.clearMeasurementTimer();
      this._attached = false;
      this._pageVisible = false;
      this._viewReady = false;
      this._particleGeneration += 1;
      this._measureSequence += 1;
      this._gesture = null;
      this._geometry = null;
      if (gesture) this.endNotice(gesture);
    },
  },
  pageLifetimes: {
    show() {
      this._pageVisible = true;
      this._geometry = null;
      this.setData({ pageVisible: true });
      this.syncProperties();
      this.measureTrack();
      this.restartParticles();
    },
    hide() {
      this._pageVisible = false;
      this._particleGeneration += 1;
      this._particlesStarted = false;
      this._measureSequence += 1;
      this._geometry = null;
      this.setData({ pageVisible: false });
      this.cancelGesture();
    },
    resize() {
      this._measureSequence += 1;
      this._geometry = null;
      this.cancelGesture();
      this.measureTrack();
      this.restartParticles(true);
    },
  },
  methods: {
    restartParticles(force = false) {
      if (!this._attached || !this._viewReady || !this._pageVisible) return;
      if (this.properties.reducedMotion) {
        this._particlesStarted = false;
        this._particleGeneration += 1;
        this.setData({ particleRuns: [] });
        return;
      }
      if (this._particlesStarted && !force) return;
      this._particlesStarted = true;
      const generation = ++this._particleGeneration;
      const start = () => {
        if (!this._attached || !this._viewReady || !this._pageVisible ||
          generation !== this._particleGeneration || this.properties.reducedMotion) return;
        // Recreate only the decorative stream after the first layout. The
        // input surface and active gesture are never remounted by animation.
        this.setData({ particleRuns: [{ id: generation }] });
      };
      if (typeof wx.nextTick === 'function') wx.nextTick(start);
      else setTimeout(start, 0);
    },
    clearMeasurementTimer() {
      clearTimeout(this._measureTimer);
      this._measureTimer = null;
    },
    live() { return this._attached && this._pageVisible && !this.data.controlDisabled; },
    current(gesture) {
      return this.live() && this._gesture === gesture && gesture.configuration === this._configuration
        && gesture.revision === this.properties.revision;
    },
    detail(gesture, value) { return { field: gesture.field, revision: gesture.revision, gestureId: gesture.id, value }; },
    endNotice(gesture) { this.triggerEvent('dragstate', { ...this.detail(gesture), dragging: false }); },
    syncProperties() {
      const range = bounds(this.properties);
      const key = JSON.stringify([this.properties.field, this.properties.revision, this.properties.label,
        range, this.properties.labels, this.properties.disabled]);
      if (this._gesture && key === this._configuration) return;
      const cancelled = this._gesture;
      if (cancelled) this.clearMeasurementTimer();
      this._gesture = null;
      this._configuration = key;
      this._range = range;
      this.setData({ controlDisabled: this.properties.disabled || !range.valid, dragging: false, activeSide: '' });
      this.present(this.properties.value);
      // Notify only after all internal writes: a parent can synchronously echo
      // a newer revision from this event and must never be overwritten here.
      if (cancelled) this.endNotice(cancelled);
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
      this.setData({ displayValue: value, displayLabel: label, percent, fillStyle, isDiscrete,
        isUltra: this.properties.field === 'spicyLevel' && isDiscrete && value === range.max,
        ticks: isDiscrete ? labels.map((_, i) => ({ id: i, value: range.min + i * range.step,
          percent: i / Math.max(1, labels.length - 1) * 100 })) : [] });
      return value;
    },
    measureTrack(gesture = this._gesture) {
      if (!this._attached || !this._pageVisible) return;
      const sequence = ++this._measureSequence;
      this.clearMeasurementTimer();
      if (gesture && !gesture.geometry) this._measureTimer = setTimeout(() => {
        if (sequence === this._measureSequence && this.current(gesture) && !gesture.geometry) this.cancelGesture();
      }, 1000);
      const failed = () => {
        if (sequence === this._measureSequence) this.clearMeasurementTimer();
        if (gesture && this.current(gesture) && sequence === this._measureSequence && !gesture.geometry) this.cancelGesture();
      };
      try {
        const query = this.createSelectorQuery();
        query.select('.taste-travel').boundingClientRect();
        query.selectViewport().scrollOffset();
        query.exec(result => {
          if (!this._attached || !this._pageVisible || sequence !== this._measureSequence ||
            (gesture && !this.current(gesture))) return;
          this.clearMeasurementTimer();
          const rect = result?.[0];
          const scroll = result?.[1];
          if (!rect || !finite(rect.left) || !finite(rect.width) || rect.width <= 0) { failed(); return; }
          const geometry = { left: rect.left, width: rect.width, scrollLeft: finite(scroll?.scrollLeft) ? scroll.scrollLeft : 0 };
          this._geometry = geometry;
          if (!gesture) return;
          this.bindGeometry(gesture, geometry);
          this.updateGesture(gesture);
          if (gesture.released && this.current(gesture)) this.finishGesture(gesture);
        });
      } catch (_) { failed(); }
    },
    bindGeometry(gesture, geometry) {
      gesture.geometry = geometry;
      const range = this._range;
      const center = geometry.left + (gesture.startValue - range.min) / (range.max - range.min) * geometry.width;
      const offset = viewportX(gesture.startPoint, geometry) - center;
      gesture.grabOffset = Math.abs(offset) <= 26 ? offset : 0;
    },
    touchStart(event) {
      if (!this.live()) return;
      const point = pointOf(event.touches);
      if (!point) { this.cancelGesture(); return; }
      this.cancelGesture();
      if (!this.live()) return;
      const gesture = { id: `${this._controlId}:${++this._serial}`, field: this.properties.field,
        revision: this.properties.revision, configuration: this._configuration,
        identifier: point.identifier, startPoint: point, point, lastX: point.x,
        startValue: this._value, axis: '', moved: false, released: false, geometry: null, grabOffset: 0 };
      this._gesture = gesture;
      if (this._geometry) this.bindGeometry(gesture, this._geometry);
      this.setData({ dragging: true, activeSide: '' });
      this.triggerEvent('dragstate', { ...this.detail(gesture), dragging: true });
      if (this.current(gesture)) this.measureTrack(gesture);
    },
    moveTo(gesture, point) {
      const dx = Math.abs(point.x - gesture.startPoint.x);
      const dy = Math.abs(point.y - gesture.startPoint.y);
      if (!gesture.axis) {
        if (dx >= MOVE_THRESHOLD && dx > dy) gesture.axis = 'x';
        else if (dy >= MOVE_THRESHOLD && dy >= dx) gesture.axis = 'y';
      }
      gesture.point = point;
      if (gesture.axis === 'x') {
        gesture.moved = true;
        const delta = point.x - gesture.lastX;
        if (!this.data.isDiscrete && Math.abs(delta) > .5) this.setData({ activeSide: delta < 0 ? 'left' : 'right' });
        this.updateGesture(gesture);
      }
      gesture.lastX = point.x;
    },
    updateGesture(gesture) {
      if (!this.current(gesture) || !gesture.moved || !gesture.geometry) return;
      const range = this._range;
      const ratio = Math.min(1, Math.max(0,
        (viewportX(gesture.point, gesture.geometry) - gesture.grabOffset - gesture.geometry.left) / gesture.geometry.width));
      const before = this._value;
      const value = this.present(range.min + ratio * (range.max - range.min));
      if (value !== before) this.triggerEvent('input', this.detail(gesture, value));
    },
    touchMove(event) {
      const gesture = this._gesture;
      if (!gesture || !this.current(gesture) || gesture.released) return;
      const point = pointOf(event.touches, gesture.identifier);
      if (!point) { this.cancelGesture(); return; }
      this.moveTo(gesture, point);
    },
    touchEnd(event) {
      const gesture = this._gesture;
      if (!gesture || !this.current(gesture)) return;
      if (event.touches?.length) { this.cancelGesture(); return; }
      const point = pointOf(event.changedTouches, gesture.identifier);
      if (point) this.moveTo(gesture, point);
      gesture.released = true;
      if (!gesture.moved || gesture.axis !== 'x') { this.cancelGesture(); return; }
      if (gesture.geometry) this.finishGesture(gesture);
      // An outstanding measurement retains the last touch point and finishes
      // this same gesture once its callback provides the track bounds.
    },
    finishGesture(gesture) {
      if (!this.current(gesture) || !gesture.released || !gesture.moved || !gesture.geometry) return;
      this.updateGesture(gesture);
      if (!this.current(gesture)) return;
      const value = this._value;
      this.clearMeasurementTimer();
      this._gesture = null;
      this.setData({ dragging: false, activeSide: '' });
      this.triggerEvent('commit', { ...this.detail(gesture, value), dragged: true });
      // commit may synchronously advance the parent's revision. Only the
      // matching gesture is ended; never write the old value after commit.
      this.endNotice(gesture);
    },
    touchCancel() { this.cancelGesture(); },
    cancelGesture() {
      this.clearMeasurementTimer();
      const gesture = this._gesture;
      if (!gesture) return;
      this._gesture = null;
      const value = this.present(gesture.startValue);
      this.setData({ dragging: false, activeSide: '' });
      this.triggerEvent('input', this.detail(gesture, value));
      this.endNotice(gesture);
    },
  },
});
