const decision = require('./service');

const EMPTY = {
  needs_information: { title: '还差一点信息', description: '当前样例有条件信息未知，暂时不能可靠决定。', action: '调整条件' },
  no_feasible_candidate: { title: '这次没有合适的', description: '没有同时满足这顿条件的虚拟结果。你可以调整条件，再决定一次。', action: '调整条件' },
  exhausted: { title: '这轮已经换完了', description: '符合本轮条件的结果已经展示完，不会重复展示刚才的选择。', action: '调整条件，再决定' },
  idle: { title: '准备好替你决定', description: '从虚拟样例中，为这顿给出一个答案。', action: '开始决定' },
};

function lines(value) {
  return Array.isArray(value) ? value.map(item => typeof item === 'string' ? item : item?.text || '').filter(Boolean) : [];
}
function card(value) {
  return value ? {
    id: value.id, revision: value.revision, name: value.name,
    restaurantName: value.restaurantName || '', mealName: value.mealName || '',
    priceText: value.priceText || '价格未知', distanceText: value.distanceText || '虚拟距离未知',
    roleText: value.roleText || '', factsSummary: lines(value.factsSummary),
    reasons: lines(value.reasons), uncertainties: lines(value.uncertainties),
  } : null;
}

// The Page and native sheet share the same result lifecycle and binding guards.
// Neither owner duplicates a result, resets a session on open, nor stores data.
function createResultPresenter({ syncTheme = false, beforeNavigate = null, onStateApplied = null } = {}) {
  return {
    data: {
      themeClass: '', preferenceReady: false, status: 'idle', target: 'PACKAGE', current: null,
      summary: '', originLabel: '', empty: { ...EMPTY.idle }, error: '', confirmed: false,
      showWhy: false, strategy: 'explicit', reasons: [], uncertainties: [], briefReason: '',
    },
    methods: {
      initializeResult() { this._renderGeneration = 0; this._shown = null; this._active = false; },
      activateResult() {
        this._active = getApp().ensureTasteProfile();
        this.setData({ preferenceReady: false });
        if (!this._active) return false;
        if (syncTheme) getApp().syncPage(this);
        wx.hideShareMenu();
        this.syncState();
        if (decision.getState().status === 'idle') this.load(false);
        return this._active;
      },
      deactivateResult() {
        this._active = false;
        this._renderGeneration = (this._renderGeneration || 0) + 1;
        this._shown = null;
      },
      ensureResultAccess() {
        if (!this._active) return false;
        if (getApp().ensureTasteProfile()) return true;
        this.deactivateResult();
        this.setData({ preferenceReady: false, current: null });
        if (beforeNavigate) beforeNavigate(this, '/pages/preferences/index');
        return false;
      },
      syncState() {
        if (!this.ensureResultAccess()) return;
        const state = decision.getState();
        const current = card(state.current);
        const reasons = lines(state.reasons);
        const generation = ++this._renderGeneration;
        this._shown = null;
        const view = {
          preferenceReady: true, status: state.status, target: state.target, current, summary: state.summary || '',
          originLabel: state.origin ? state.origin.label : '尚未选择虚拟地点',
          empty: EMPTY[state.status] || EMPTY.idle, confirmed: state.status === 'confirmed', strategy: state.strategy,
          reasons, uncertainties: lines(state.uncertainties), briefReason: current?.reasons[0] || reasons[0] || '',
        };
        this.setData(view, () => {
          if (!this._active || generation !== this._renderGeneration || !this.ensureResultAccess()) return;
          const rendered = () => {
            if (!this._active || generation !== this._renderGeneration || !current || !this.ensureResultAccess()
              || !decision.resolve(current.id, current.revision)) return false;
            try {
              decision.markRendered({ candidateId: current.id, revision: current.revision });
              this._shown = { candidateId: current.id, revision: current.revision };
              return true;
            } catch (_) { this._shown = null; return false; }
          };
          // A motion owner marks the new binding only after that card is visible.
          // The independent results Page keeps the immediate native-render path.
          if (onStateApplied) onStateApplied(this, view, rendered);
          else rendered();
        });
      },
      load(reroll) {
        if (!this.ensureResultAccess()) return;
        try {
          decision.recommend({ reroll: reroll === true });
          this.setData({ error: '', showWhy: false });
          this.syncState();
        } catch (error) {
          this._shown = null;
          this._renderGeneration += 1;
          const generation = this._renderGeneration;
          this.setData({ current: null, confirmed: false, error: error.message || '这次决定暂未完成，请调整条件重试。' }, () => {
            if (onStateApplied && this._active && generation === this._renderGeneration) onStateApplied(this, this.data, () => false);
          });
        }
      },
      currentBinding(event) {
        if (!this.ensureResultAccess() || !this._shown) return null;
        const dataset = event?.currentTarget?.dataset;
        if (dataset && (dataset.id !== this._shown.candidateId || Number(dataset.revision) !== this._shown.revision)) return null;
        return decision.resolve(this._shown.candidateId, this._shown.revision) ? { ...this._shown } : null;
      },
      confirm(event) {
        const binding = this.currentBinding(event);
        if (!binding || decision.getState().status !== 'recommended') return;
        try { decision.confirm(binding); this.syncState(); }
        catch (error) { this.setData({ error: error.message || '这份选择已变化，请重新决定。' }); this.syncState(); }
      },
      next(event) {
        if (this.currentBinding(event) && decision.getState().status === 'recommended') this.load(true);
      },
      chooseStrategy(event) {
        if (!this.currentBinding() || decision.getState().status !== 'recommended') return;
        const strategy = event.currentTarget.dataset.strategy;
        if (!['explicit', 'uniform', 'weighted'].includes(strategy)) return;
        try { decision.configure({ strategy }); this.load(true); }
        catch (error) { this.setData({ error: error.message || '暂时无法切换决定方式。' }); }
      },
      navigateResult(url) {
        if (!this.ensureResultAccess()) return;
        if (beforeNavigate) beforeNavigate(this, url);
        wx.navigateTo({ url });
      },
      detail(event) {
        const binding = this.currentBinding(event);
        if (binding) this.navigateResult(`/pages/detail/index?id=${encodeURIComponent(binding.candidateId)}&revision=${binding.revision}`);
      },
      adjust() { this.navigateResult('/pages/conditions/index'); },
      location() { this.navigateResult('/pages/location/index'); },
      emptyAction() {
        if (!this.ensureResultAccess()) return;
        if (decision.getState().status === 'idle') this.load(false);
        else this.adjust();
      },
      restart() {
        if (!this.ensureResultAccess()) return;
        decision.reset(); this.load(false);
      },
      toggleWhy() { if (this.ensureResultAccess()) this.setData({ showWhy: !this.data.showWhy }); },
    },
  };
}

function createResultsPage() {
  const presenter = createResultPresenter({ syncTheme: true });
  return {
    data: presenter.data,
    onLoad() { this.initializeResult(); },
    onShow() { this.activateResult(); },
    onHide() { this.deactivateResult(); },
    onUnload() { this.deactivateResult(); },
    ...presenter.methods,
  };
}

module.exports = { createResultPresenter, createResultsPage };
