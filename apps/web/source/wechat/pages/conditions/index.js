const service = require('../../lib/service');
const tasteProfile = require('../../lib/taste-profile');
const FIELDS = ['budgetMaxYuan', 'radiusMeters', 'mealPeriod', 'travelMode', 'availableMinutes'];
const MEALS = [{ value: 'BREAKFAST', label: '早餐' }, { value: 'LUNCH', label: '午餐' }, { value: 'DINNER', label: '晚餐' }];
const TRAVEL = [{ value: 'WALK', label: '步行' }, { value: 'BIKE', label: '骑行' }, { value: 'TRANSIT', label: '公共交通' }];
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function ready() {
  return !!(service.state.consent && service.state.status === 'ready' &&
    service.state.config?.serviceCapabilities.recommendationsEnabled);
}
function maximumRadius(config) { return config.recommendationDefaults?.maximumRadiusMeters || 10000; }
function meals(config) {
  return MEALS.filter(item => item.value === 'LUNCH' ||
    config.specialtyCapabilities[item.value === 'BREAKFAST' ? 'breakfastProfileEnabled' : 'dinnerProfileEnabled']);
}
function normalize(filters, config) {
  const draft = copy(filters);
  draft.target = 'MEAL';
  draft.weatherContext = { kind: 'NONE' };
  draft.aiAssistanceEnabled = false;
  draft.decisionMode = 'QUICK';
  draft.explorationMode = 'BALANCED';
  // Retain explicit exclusions when editing unrelated visible conditions.
  draft.preferredCuisines = [];
  draft.preferenceVector = copy(service.DEFAULT_FILTERS.preferenceVector);
  draft.radiusMeters = Math.min(draft.radiusMeters, maximumRadius(config));
  if (!meals(config).some(item => item.value === draft.mealPeriod)) draft.mealPeriod = 'LUNCH';
  return draft;
}
function values(base, current, label) {
  return [...new Set(base.concat(current))].sort((a, b) => a - b).map(value => ({ value, label: label(value) }));
}

Page({
  data: {
    themeClass: '', preferenceReady: false, consent: false, status: 'idle', canSubmit: false,
    choices: {}, locationLabel: '', error: '', serviceMessage: '', opening: false, refreshing: false,
  },
  onLoad() { this._generation = 0; this._operation = 0; this._draft = null; this._options = {}; },
  onShow() {
    this._generation += 1;
    this._active = getApp().ensureTasteProfile();
    this.setData({ preferenceReady: this._active });
    if (!this._active) return;
    this._opening = false;
    getApp().syncPage(this);
    wx.hideShareMenu();
    this.syncState();
  },
  onHide() { this.leave(); },
  onUnload() { this.leave(); this._draft = null; this._context = null; },
  leave() {
    this._active = false;
    this._generation += 1;
    this._operation += 1;
    this._opening = false;
    this._refreshing = null;
  },
  context() {
    const state = service.state;
    return { epoch: state.epoch, config: state.config, filters: state.filters, profileRevision: tasteProfile.getState().revision };
  },
  matches(context) {
    const state = service.state;
    return !!(context && ready() && tasteProfile.isReady() && context.epoch === state.epoch &&
      context.config === state.config && context.filters === state.filters &&
      context.profileRevision === tasteProfile.getState().revision);
  },
  syncState() {
    if (!this._active) return;
    const state = service.state;
    const preferenceReady = tasteProfile.isReady();
    if (!this.matches(this._context)) {
      this._operation += 1;
      this._opening = false;
      this._draft = preferenceReady && ready() ? normalize(state.filters, state.config) : null;
      this._context = this.context();
      this.setData({ error: '' });
    }
    this._options = {};
    if (this._draft && ready() && preferenceReady) {
      const draft = this._draft;
      const maximum = maximumRadius(state.config);
      this._options = {
        budgetMaxYuan: [{ value: null, label: '不限' }].concat(values([20, 25, 30, 50],
          draft.budgetMaxYuan === null ? [] : [draft.budgetMaxYuan], value => `${value} 元内`)),
        radiusMeters: values([500, 1000, 1500, 3000, 5000, maximum].filter(value => value <= maximum),
          draft.radiusMeters, value => `${value} 米内`),
        mealPeriod: meals(state.config),
        travelMode: TRAVEL,
        availableMinutes: values([30, 45, 60, 90, 120], draft.availableMinutes, value => `${value} 分钟`),
      };
    }
    const choices = {};
    Object.keys(this._options).forEach(key => {
      choices[key] = this._options[key].map((option, index) => ({ ...option, index, revision: this._operation, selected: this._draft[key] === option.value }));
    });
    this.setData({ preferenceReady, consent: state.consent, status: state.status, choices,
      opening: this._opening === true, refreshing: !!this._refreshing,
      canSubmit: !!(preferenceReady && ready() && this._draft && !this._opening && !this._refreshing),
      locationLabel: state.location ? state.locationLabel || '已选地点' : '选择出发地点',
      serviceMessage: !state.consent ? '请先返回首页，在个人页阅读并同意隐私说明。'
        : state.status === 'loading' ? '正在连接餐厅服务，请稍候。'
          : !ready() ? state.error || '餐厅推荐暂不可用，请重新连接后再试。' : '',
    });
  },
  available() {
    if (!this._active || !getApp().ensureTasteProfile() || this._opening || this._refreshing) return false;
    if (!this.matches(this._context)) { this.syncState(); return false; }
    return !!this._draft;
  },
  select(event) {
    if (!this.available()) return;
    const key = event.currentTarget?.dataset?.key;
    const index = Number(event.currentTarget?.dataset?.index);
    const revision = Number(event.currentTarget?.dataset?.revision);
    if (!FIELDS.includes(key) || !Number.isInteger(index) || index < 0 || revision !== this._operation) return;
    const option = this._options[key]?.[index];
    if (!option) return;
    this._draft[key] = option.value;
    this.setData({ error: '' });
    this.syncState();
  },
  open(url) {
    const generation = this._generation;
    const operation = ++this._operation;
    const context = this.context();
    const location = service.state.location;
    this._opening = true;
    this.setData({ opening: true, canSubmit: false, error: '' });
    const fail = () => {
      if (!this._active || generation !== this._generation || operation !== this._operation) return;
      this._opening = false;
      if (!this.matches(context) || location !== service.state.location) { this.syncState(); return; }
      this.syncState();
      this.setData({ error: '暂时无法打开页面，请重试。' });
    };
    try { wx.navigateTo({ url, fail }); } catch (_) { fail(); }
  },
  location() { if (this.available()) this.open('/pages/location/index'); },
  submit() {
    if (!this.available()) return;
    try {
      service.setFilters(normalize(this._draft, service.state.config));
      this._context = this.context();
      this.open(service.state.location ? '/pages/results/index' : '/pages/location/index?returnTo=results');
    } catch (error) { this.setData({ error: error.message || '请检查这次的推荐条件。' }); }
  },
  async refresh() {
    if (!this._active || !getApp().ensureTasteProfile() || !service.state.consent || this._refreshing || this._opening) return;
    const refresh = { generation: this._generation };
    this._refreshing = refresh;
    try {
      const pending = getApp().checkService();
      this.syncState();
      await pending;
    } catch (_) { /* The service supplies a safe connection status. */ }
    finally {
      if (this._active && this._refreshing === refresh && refresh.generation === this._generation) {
        this._refreshing = null;
        this.syncState();
      }
    }
  },
  home() { if (this._active) wx.reLaunch({ url: '/pages/index/index' }); },
});
