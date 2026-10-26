const decision = require('../../lib/decision/service');
const { createResultPresenter } = require('../../lib/decision/result-presenter');
const motion = require('../../lib/decision-motion');
const { TIMING, EASE } = motion;
const presenter = createResultPresenter({
  beforeNavigate: owner => owner.closeSheet(true),
  onStateApplied: (owner, view, markRendered) => owner.applyMotionResult(view, markRendered),
});
const { themeClass: _themeClass, ...resultData } = presenter.data;
const visualData = {
  mounted: false, entered: false, closing: false, contentReady: false, phase: 'closed',
  displayCard: null, displayTarget: 'PACKAGE', displayReason: '', outgoingCard: null,
  outgoingTarget: 'PACKAGE', outgoingReason: '', previewCount: 0,
  cardStyle: '', outgoingStyle: '', revealStyle: 'opacity:0;', artworkStyle: '', informationStyle: '',
  panelDragStyle: '', dragging: false, interactionLocked: true,
  confirmPhase: 'idle', whyMounted: false, whyStyle: 'height:0;opacity:0;',
};

Component({
  options: { styleIsolation: 'isolated' },
  properties: {
    visible: { type: Boolean, value: false },
    themeClass: { type: String, value: 'theme-light' },
    revealOrigin: { type: Object, value: null },
    sourceRect: { type: Object, value: null },
    reducedMotion: { type: Boolean, value: false },
  },
  data: { ...resultData, ...visualData },
  observers: {
    visible(value) { this.setVisible(value); },
    reducedMotion(value) {
      if (!value || !this._attached || !this.data.mounted) return;
      this.stopSpring();
      this._dragX = 0;
      this.setData({ cardStyle: '', artworkStyle: '', informationStyle: '', panelDragStyle: '' });
    },
  },
  lifetimes: {
    attached() {
      this._attached = true;
      this._pageVisible = true;
      this._sheetGeneration = 0;
      this._motionGeneration = 0;
      this._timers = new Set();
      this._enterTimer = null;
      this._leaveTimer = null;
      this._opening = false;
      this._dragX = 0;
      this._springVelocity = 0;
      this._lastStateKey = '';
      this.initializeResult();
      this._desiredVisible = this.properties.visible === true;
      if (this._desiredVisible) this.openSheet();
    },
    ready() { if (this._desiredVisible && !this._active && !this._opening) this.openSheet(); },
    detached() {
      this._attached = false;
      this._pageVisible = false;
      this._desiredVisible = false;
      this._sheetGeneration += 1;
      this._opening = false;
      this.clearSheetTimers();
      this.deactivateResult();
    },
  },
  pageLifetimes: {
    show() { this._pageVisible = true; if (this._desiredVisible) this.openSheet(); },
    hide() { this._pageVisible = false; this.closeSheet(true, true); },
  },
  methods: {
    ...presenter.methods,
    reduceMotion() { return this.properties.reducedMotion === true; },
    duration(name) { return this.reduceMotion() ? TIMING.reduced : TIMING[name]; },
    schedule(callback, delay, checkMotion = true) {
      const generation = this._sheetGeneration, motionGeneration = this._motionGeneration;
      const timer = setTimeout(() => {
        this._timers.delete(timer);
        if (!this._attached || generation !== this._sheetGeneration || (checkMotion && motionGeneration !== this._motionGeneration)) return;
        callback();
      }, delay);
      this._timers.add(timer);
      return timer;
    },
    clearSheetTimers() {
      if (this._timers) for (const timer of this._timers) clearTimeout(timer);
      this._timers = new Set();
      this._enterTimer = null;
      this._leaveTimer = null;
      this._springTimer = null;
      this._whyTimer = null;
      this._gesture = null;
      this._headerGesture = null;
      this._changing = null;
      this._confirming = null;
      this._markVisible = null;
      this._motionGeneration += 1;
    },
    viewport() {
      let info = {};
      try { if (typeof wx.getWindowInfo === 'function') info = wx.getWindowInfo(); } catch (_) {}
      return { width: info.windowWidth || this.properties.revealOrigin?.width || 375,
        height: info.windowHeight || this.properties.revealOrigin?.height || 667 };
    },
    setVisible(value) {
      this._desiredVisible = value === true;
      if (!this._attached) return;
      if (this._desiredVisible) this.openSheet();
      else this.closeSheet();
    },
    openSheet() {
      if (!this._attached || !this._pageVisible || !this._desiredVisible) return;
      if (this.data.mounted && !this.data.closing && (this._active || this._opening)) return;
      this.clearSheetTimers();
      const generation = ++this._sheetGeneration;
      this._opening = true;
      this._dragX = 0;
      this._springVelocity = 0;
      this._suppressTapUntil = 0;
      this._revealPlayed = false;
      this._lastStateKey = '';
      this.deactivateResult();
      if (!getApp().ensureTasteProfile()) { this.closeSheet(true, true); return; }
      this.setData({ ...resultData, ...visualData, mounted: true, phase: 'loading' }, () => {
        if (!this.liveGeneration(generation)) return;
        this._enterTimer = this.schedule(() => {
          this._enterTimer = null;
          this.setData({ entered: true }, () => {
            if (!this.liveGeneration(generation)) return;
            if (!this.activateResult()) this.closeSheet(true, true);
          });
        }, TIMING.frame);
      });
    },
    liveGeneration(generation) {
      return this._attached && this._pageVisible && this._desiredVisible && generation === this._sheetGeneration;
    },
    readPreviewCount() {
      try { return typeof decision.previewCandidates === 'function' ? Math.min(2, decision.previewCandidates(3).cards.length) : 0; }
      catch (_) { return 0; }
    },
    displayValues(view) {
      return { displayCard: view.current || null, displayTarget: view.target || 'PACKAGE',
        displayReason: view.briefReason || '', previewCount: this.readPreviewCount() };
    },
    applyMotionResult(view, markRendered) {
      if (!this._attached || !this._active || !this._pageVisible || !this._desiredVisible || this.data.closing) return;
      // activateResult can first report idle, before the real synchronous engine
      // returns. That frame stays a skeleton and does not consume the reveal.
      if (this._opening && view.status === 'idle' && !this.data.error) return;
      this._markVisible = markRendered;
      if (this._changing) { this.receiveChangedCard(view, markRendered); return; }
      const generation = this._sheetGeneration;
      if (!this.data.contentReady) {
        this.setData({ ...this.displayValues(view), contentReady: true, phase: 'entering',
          confirmPhase: view.confirmed ? 'done' : 'idle', revealStyle: 'opacity:0;' }, () => {
          if (this.liveGeneration(generation)) this.revealResult(markRendered);
        });
        return;
      }
      this.setData(this.displayValues(view), () => {
        if (!this.liveGeneration(generation)) return;
        markRendered();
        if (this._confirming) {
          const binding = this._confirming;
          this._confirming = null;
          if (view.confirmed && view.current?.id === binding.candidateId && view.current?.revision === binding.revision) this.confirmSuccess();
          else this.setData({ confirmPhase: 'idle', interactionLocked: false, phase: 'idle' });
        } else {
          this.setData({ confirmPhase: view.confirmed ? 'done' : 'idle', interactionLocked: false, phase: view.confirmed ? 'confirmed' : 'idle' });
        }
        this.emitState();
      });
    },
    queryReveal(callback) {
      const viewport = this.viewport();
      const fallback = { stage: { left: 0, top: viewport.height * .14 + 56, width: viewport.width, height: viewport.height * .86 - 56 }, art: null };
      try {
        if (typeof this.createSelectorQuery !== 'function') { callback(fallback); return; }
        this.createSelectorQuery().select('.sheet-reveal').boundingClientRect().select('.meal-art').boundingClientRect().exec(rects => {
          callback({ stage: rects?.[0] || fallback.stage, art: rects?.[1] || null });
        });
      } catch (_) { callback(fallback); }
    },
    revealResult(markRendered) {
      const generation = this._sheetGeneration, motionGeneration = this._motionGeneration;
      this.queryReveal(({ stage, art }) => {
        if (!this.liveGeneration(generation) || motionGeneration !== this._motionGeneration) return;
        const reduced = this.reduceMotion();
        const circle = reduced || this._revealPlayed ? null : motion.revealGeometry(this.properties.revealOrigin, stage);
        this._revealPlayed = true;
        const source = reduced ? null : motion.sourceTransform(this.properties.sourceRect, art);
        const startClip = circle ? 'clip-path:circle(18px at ' + circle.x + 'px ' + circle.y + 'px);opacity:1;' : 'opacity:0;';
        const startArt = source ? 'transform:translate3d(' + source.x + 'px,' + source.y + 'px,0) scale(' + source.scaleX + ',' + source.scaleY + ');opacity:.72;'
          : reduced ? 'opacity:0;' : 'transform:scale(.96);opacity:0;';
        this.setData({ revealStyle: startClip, artworkStyle: startArt,
          informationStyle: reduced ? 'opacity:0;' : 'transform:translate3d(0,22px,0);opacity:0;' }, () => {
          if (!this.liveGeneration(generation)) return;
          this.schedule(() => {
            const length = this.duration('sheet'), delay = reduced ? 0 : 40;
            const clip = circle ? 'clip-path:circle(' + circle.radius + 'px at ' + circle.x + 'px ' + circle.y + 'px);' : '';
            this.setData({ revealStyle: clip + 'opacity:1;transition:clip-path ' + length + 'ms ' + EASE.out + ',opacity ' + length + 'ms ' + EASE.out + ';',
              artworkStyle: 'transform:translate3d(0,0,0) scale(1);opacity:1;transition:transform ' + length + 'ms ' + EASE.drawer + ',opacity ' + length + 'ms ' + EASE.out + ';',
              informationStyle: 'transform:translate3d(0,0,0);opacity:1;transition:transform ' + length + 'ms ' + EASE.drawer + ' ' + delay + 'ms,opacity ' + length + 'ms ' + EASE.out + ' ' + delay + 'ms;' });
            this.schedule(() => {
              this._opening = false;
              this.setData({ revealStyle: '', artworkStyle: '', informationStyle: '', interactionLocked: false,
                phase: this.data.confirmed ? 'confirmed' : 'idle' }, () => {
                if (!this.liveGeneration(generation)) return;
                markRendered();
                this.emitState();
              });
            }, length + delay);
          }, TIMING.frame);
        });
      });
    },
    emitState() {
      const stateKey = [this.data.status, this.data.current?.id, this.data.current?.revision, this.data.error].join(':');
      if (stateKey === this._lastStateKey) return;
      this._lastStateKey = stateKey;
      this.triggerEvent('statechange', { status: this.data.status, candidateId: this.data.current?.id || null,
        revision: this.data.current?.revision ?? null, confirmed: this.data.confirmed });
    },
    canInteract(event) {
      if (this.data.interactionLocked || this._opening || this.data.closing || this._gesture?.axis === 'x'
        || !['idle', 'settling', 'confirmed'].includes(this.data.phase) || Date.now() < (this._suppressTapUntil || 0)) return false;
      return !!this.currentBinding(event);
    },
    next(event) {
      if (!this.canInteract(event) || this.data.confirmed) return;
      this.changeCard(event, -1, 'button');
    },
    changeCard(event, direction, source, strategy) {
      const binding = this.currentBinding(event);
      if (!binding || this._changing || this._confirming || this.data.confirmed) return;
      this.stopSpring();
      this._motionGeneration += 1;
      const width = this.viewport().width;
      this._changing = { direction, binding, source };
      this.setData({ outgoingCard: this.data.displayCard, outgoingTarget: this.data.displayTarget, outgoingReason: this.data.displayReason,
        outgoingStyle: motion.cardTransform(this._dragX || 0, width, this.reduceMotion()) + 'opacity:1;',
        cardStyle: 'opacity:0;', dragging: false, phase: 'changing', interactionLocked: true,
        whyMounted: false, showWhy: false, whyStyle: 'height:0;opacity:0;' });
      this.schedule(() => {
        const length = this.duration('card');
        this.setData({ outgoingStyle: motion.cardTransform(direction * width * 1.1, width, this.reduceMotion())
          + 'opacity:0;transition:transform ' + length + 'ms ' + EASE.out + ',opacity ' + length + 'ms ' + EASE.out + ';' });
      }, TIMING.frame);
      const actionEvent = { currentTarget: { dataset: { id: binding.candidateId, revision: binding.revision } } };
      if (strategy) presenter.methods.chooseStrategy.call(this, { currentTarget: { dataset: { strategy } } });
      else presenter.methods.next.call(this, actionEvent);
    },
    receiveChangedCard(view, markRendered) {
      const direction = this._changing.direction, generation = this._sheetGeneration, width = this.viewport().width;
      const length = this.duration('card');
      const values = this.displayValues(view), empty = !view.current;
      // Keep the old card's layout space while its visual copy exits. An empty
      // response never becomes a fabricated incoming restaurant.
      if (empty) values.displayCard = this.data.displayCard;
      this.setData({ ...values, confirmPhase: 'idle',
        cardStyle: motion.cardTransform(-direction * width * .85, width, this.reduceMotion()) + 'opacity:' + (empty || this.reduceMotion() ? '0' : '1') + ';' }, () => {
        if (!this.liveGeneration(generation)) return;
        this.schedule(() => {
          this.setData({ cardStyle: 'transform:translate3d(0,0,0) rotate(0deg);opacity:' + (empty ? '0' : '1') + ';transition:transform ' + length + 'ms ' + EASE.drawer + ',opacity ' + length + 'ms ' + EASE.out + ';' });
          this.schedule(() => {
            this._changing = null;
            this._dragX = 0;
            this._springVelocity = 0;
            this.setData({ displayCard: view.current || null, outgoingCard: null, outgoingStyle: '', cardStyle: '', phase: 'idle', interactionLocked: false }, () => {
              if (!this.liveGeneration(generation)) return;
              markRendered();
              this.emitState();
            });
          }, length);
        }, TIMING.frame);
      });
    },
    confirm(event) {
      if (!this.canInteract(event) || this.data.confirmed || this._confirming) return;
      this.stopSpring();
      const binding = this.currentBinding(event);
      if (!binding) return;
      this._confirming = binding;
      this.setData({ interactionLocked: true, confirmPhase: 'pending', phase: 'confirming', cardStyle: '' });
      presenter.methods.confirm.call(this, event);
    },
    confirmSuccess() {
      this.setData({ confirmPhase: 'shrinking', phase: 'confirming', interactionLocked: true });
      this.schedule(() => {
        this.setData({ confirmPhase: 'drawing' });
        this.schedule(() => this.setData({ confirmPhase: 'done', phase: 'confirmed', interactionLocked: false }), this.duration('check'));
      }, this.duration('shrink'));
    },
    primaryAction(event) {
      if (this.data.confirmed && this.data.confirmPhase === 'done') this.close();
      else this.confirm(event);
    },
    secondaryAction(event) { if (this.data.confirmed) this.restart(); else this.next(event); },
    restart() {
      if (this.data.interactionLocked || !this.ensureResultAccess()) return;
      this.stopSpring();
      this._motionGeneration += 1;
      this.setData({ confirmPhase: 'idle', phase: 'loading', interactionLocked: true, showWhy: false, whyMounted: false });
      presenter.methods.restart.call(this);
    },
    chooseStrategy(event) {
      if (!this.canInteract() || this.data.confirmed) return;
      const strategy = event.currentTarget.dataset.strategy;
      if (strategy !== 'uniform' && strategy !== 'weighted') return;
      this.changeCard(null, -1, 'strategy', strategy);
    },
    detail(event) { if (this.canInteract(event)) presenter.methods.detail.call(this, event); },
    location() { if (!this.data.interactionLocked) presenter.methods.location.call(this); },
    adjust() {
      if (this.data.interactionLocked || !this.ensureResultAccess()) return;
      this.closeSheet(true);
      this.triggerEvent('adjust');
    },
    emptyAction() {
      if (this.data.interactionLocked || !this.ensureResultAccess()) return;
      if (this.data.error) {
        this.setData({ error: '', contentReady: false, phase: 'loading', interactionLocked: true });
        this.load(false);
      } else if (decision.getState().status === 'idle') this.load(false);
      else this.adjust();
    },
    dragStart(event) {
      if (!this.canInteract() || this.data.confirmed) return;
      const point = motion.touch(event);
      if (!point) return;
      this.stopSpring();
      this._gesture = { start: point, last: point, startX: this._dragX || 0, axis: '', velocity: 0 };
      this.setData({ phase: 'idle', cardStyle: motion.cardTransform(this._dragX || 0, this.viewport().width, this.reduceMotion()) });
    },
    dragMove(event) {
      const drag = this._gesture;
      if (!drag) return;
      const point = motion.touch(event);
      if (!point || point.id !== drag.start.id) { this.dragCancel(); return; }
      const dx = point.x - drag.start.x, dy = point.y - drag.start.y;
      if (!drag.axis) drag.axis = motion.gestureAxis(dx, dy);
      if (drag.axis !== 'x') return;
      const dt = Math.max(1, point.time - drag.last.time);
      drag.velocity = (point.x - drag.last.x) / dt;
      drag.last = point;
      this._dragX = drag.startX + dx;
      this._springVelocity = drag.velocity * 1000;
      this.setData({ dragging: true, cardStyle: motion.cardTransform(this._dragX, this.viewport().width, this.reduceMotion()) });
    },
    dragEnd(event) {
      const drag = this._gesture;
      if (!drag) return;
      this._gesture = null;
      this.setData({ dragging: false });
      if (drag.axis !== 'x') return;
      this._suppressTapUntil = Date.now() + TIMING.state;
      const end = motion.touch(event, true);
      const velocity = end && end.time - drag.last.time < 80 ? drag.velocity : 0;
      const result = motion.swipeDecision({ x: this._dragX, velocity, width: this.viewport().width });
      if (result.commits) this.changeCard(null, result.direction, 'gesture');
      else this.settleCard(velocity * 1000);
    },
    dragCancel() {
      const horizontal = this._gesture?.axis === 'x';
      this._gesture = null;
      this.setData({ dragging: false });
      if (horizontal) {
        this._suppressTapUntil = Date.now() + TIMING.state;
        this.settleCard(0);
      }
    },
    stopSpring() {
      if (this._springTimer) { clearTimeout(this._springTimer); this._timers.delete(this._springTimer); }
      this._springTimer = null;
    },
    settleCard(velocity) {
      this.stopSpring();
      if (this.reduceMotion()) { this._dragX = 0; this.setData({ cardStyle: '', phase: 'idle' }); return; }
      this.setData({ phase: 'settling' });
      let spring = { x: this._dragX || 0, velocity }, elapsed = 0;
      const step = () => {
        spring = motion.springStep(spring, TIMING.frame / 1000);
        elapsed += TIMING.frame;
        this._dragX = spring.x;
        this._springVelocity = spring.velocity;
        if (spring.settled || elapsed >= 750) {
          this._dragX = 0;
          this._springVelocity = 0;
          this._springTimer = null;
          this.setData({ cardStyle: '', phase: 'idle' });
          return;
        }
        this.setData({ cardStyle: motion.cardTransform(spring.x, this.viewport().width) });
        this._springTimer = this.schedule(step, TIMING.frame);
      };
      this._springTimer = this.schedule(step, TIMING.frame);
    },
    headerStart(event) {
      if (this.data.closing) return;
      const point = motion.touch(event);
      if (point) this._headerGesture = { start: point, last: point, y: 0, velocity: 0 };
    },
    headerMove(event) {
      const drag = this._headerGesture, point = motion.touch(event);
      if (!drag || !point || point.id !== drag.start.id) return;
      drag.y = Math.max(0, point.y - drag.start.y);
      drag.velocity = (point.y - drag.last.y) / Math.max(1, point.time - drag.last.time);
      drag.last = point;
      if (!this.reduceMotion()) this.setData({ panelDragStyle: 'transform:translate3d(0,' + drag.y + 'px,0);transition:none;' });
    },
    headerEnd() {
      const drag = this._headerGesture;
      this._headerGesture = null;
      if (drag && (drag.y > 96 || (drag.y > 24 && drag.velocity > .55))) this.close();
      else this.setData({ panelDragStyle: '' });
    },
    headerCancel() { this._headerGesture = null; this.setData({ panelDragStyle: '' }); },
    toggleWhy() {
      if (this.data.interactionLocked || !this.ensureResultAccess()) return;
      if (this._whyTimer) { clearTimeout(this._whyTimer); this._timers.delete(this._whyTimer); }
      const opening = !this.data.showWhy, generation = (this._whyGeneration || 0) + 1;
      this._whyGeneration = generation;
      if (!opening) {
        this.setData({ showWhy: false, whyStyle: 'height:0;opacity:0;' });
        this._whyTimer = this.schedule(() => {
          if (generation === this._whyGeneration) this.setData({ whyMounted: false });
        }, this.duration('state'));
        return;
      }
      this.setData({ showWhy: true, whyMounted: true }, () => {
        if (generation !== this._whyGeneration || !this.data.showWhy || !this._desiredVisible) return;
        const reveal = height => {
          if (generation !== this._whyGeneration || !this.data.showWhy || !this._desiredVisible) return;
          this.setData({ whyStyle: 'height:' + (height > 0 ? height + 'px' : 'auto') + ';opacity:1;' });
        };
        try {
          if (typeof this.createSelectorQuery !== 'function') { reveal(0); return; }
          this.createSelectorQuery().select('.why-inner').boundingClientRect(rect => reveal(rect?.height || 0)).exec();
        } catch (_) { reveal(0); }
      });
    },
    closeSheet(notify = false, immediate = false) {
      const shouldNotify = notify && this._desiredVisible;
      this._desiredVisible = false;
      this._opening = false;
      this.deactivateResult();
      if (!immediate && this.data.closing && this._leaveTimer !== null) return;
      this.clearSheetTimers();
      const generation = ++this._sheetGeneration;
      if (this._attached) {
        if (immediate || !this.data.mounted) this.setData({ ...visualData });
        else {
          this.setData({ entered: false, closing: true, phase: 'closing', interactionLocked: true, dragging: false, panelDragStyle: '' });
          this._leaveTimer = this.schedule(() => {
            if (!this._attached || this._desiredVisible || generation !== this._sheetGeneration) return;
            this._leaveTimer = null;
            this.setData({ ...visualData });
          }, this.duration('close'), false);
        }
      }
      if (shouldNotify) this.triggerEvent('close');
    },
    close() { this.closeSheet(true); },
    swallow() {},
  },
});
