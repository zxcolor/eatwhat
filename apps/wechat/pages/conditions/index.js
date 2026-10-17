const service = require('../../lib/service');
const decisionUi = require('../../lib/decision-ui');
const CUISINES = ['中式快餐', '面食', '米饭', '火锅', '川湘菜', '清真', '素食', '西餐'];
const BASE_OPTIONS = {
  decisionMode: [{ value: 'QUICK', label: '帮我决定' }, { value: 'GUIDED', label: '按条件选' }],
  budgetMaxYuan: [{ value: 15, label: '15 元内' }, { value: 25, label: '25 元内' }, { value: 40, label: '40 元内' }, { value: null, label: '不限' }],
  availableMinutes: [30, 45, 60, 90].map((value) => ({ value, label: `${value} 分钟` })),
  travelMode: [{ value: 'WALK', label: '步行' }, { value: 'BIKE', label: '骑行' }, { value: 'TRANSIT', label: '公交 / 地铁' }],
  explorationMode: [{ value: 'SAFE', label: '稳妥吃' }, { value: 'BALANCED', label: '平衡' }, { value: 'ADVENTUROUS', label: '换个口味' }],
};
const WEATHER = [{ value: 'NONE', label: '不使用' }, { value: 'MINIMIZE_EXPOSURE', label: '少在户外停留' }, { value: 'WARMING', label: '想吃喝暖一点' }, { value: 'COOLING', label: '想吃喝清凉一点' }];

Page({
  data: { themeClass: '', filters: {}, options: {}, cuisines: [], preferredCuisines: [], preferences: [], aiAvailable: false, locationLabel: '', hasLocation: false, canRecommend: false, softPreferences: false, showWeather: false, summary: '', error: '', selectionError: '', connecting: false },
  onShow() {
    getApp().syncPage(this);
    if (!service.state.consent) return wx.reLaunch({ url: '/pages/index/index' });
    this._draft = JSON.parse(JSON.stringify(service.state.filters));
    this.syncState();
    wx.hideShareMenu();
  },
  syncState() {
    if (!service.state.consent) this._draft = JSON.parse(JSON.stringify(service.state.filters));
    this.sync();
  },
  sync() {
    const state = service.state;
    const config = state.consent && state.status === 'ready' ? state.config : null;
    const recommendationsEnabled = !!(config?.serviceCapabilities && config.serviceCapabilities.recommendationsEnabled === true);
    const capabilities = recommendationsEnabled && config.specialtyCapabilities || {};
    const filters = this._draft || state.filters;
    const options = Object.assign({}, BASE_OPTIONS);
    options.mealPeriod = [];
    if (capabilities.breakfastProfileEnabled === true) options.mealPeriod.push({ value: 'BREAKFAST', label: '早餐' });
    options.mealPeriod.push({ value: 'LUNCH', label: '午餐' });
    if (capabilities.dinnerProfileEnabled === true) options.mealPeriod.push({ value: 'DINNER', label: '晚餐' });
    options.target = [{ value: 'MEAL', label: '普通用餐' }];
    [['milkTeaEnabled', 'MILK_TEA', '奶茶'], ['coffeeEnabled', 'COFFEE', '咖啡'], ['dessertEnabled', 'DESSERT', '甜品']].forEach(([flag, value, label]) => { if (capabilities[flag] === true) options.target.push({ value, label }); });
    options.weather = capabilities.userReportedWeatherEnabled === true ? WEATHER : WEATHER.slice(0, 1);
    const defaults = config?.recommendationDefaults;
    const maximum = defaults ? defaults.maximumRadiusMeters : 10000;
    const radii = [1000, 1500, 3000, 5000, filters.radiusMeters];
    if (defaults) radii.push(defaults.defaultRadiusMeters, defaults.maximumRadiusMeters);
    options.radiusMeters = Array.from(new Set(radii)).filter((value) => Number.isInteger(value) && value >= 200 && value <= maximum).sort((a, b) => a - b).map((value) => ({ value, label: value < 1000 ? `${value} 米` : `${value / 1000} 公里` }));
    const selectionError = !recommendationsEnabled ? ''
      : !options.target.some((option) => option.value === filters.target) ? '已选推荐目标当前未开放，请重新选择。'
        : filters.target === 'MEAL' && !options.mealPeriod.some((option) => option.value === filters.mealPeriod) ? '已选餐次当前未开放，请重新选择。'
          : filters.weatherContext.kind !== 'NONE' && capabilities.userReportedWeatherEnabled !== true ? '手动体感当前未开放，请选择「不使用」。'
            : filters.radiusMeters > maximum ? '已选距离超过当前服务范围，请调整距离。' : '';
    Object.keys(options).forEach((key) => { options[key] = options[key].map((item, index) => Object.assign({}, item, { index, selected: key === 'weather' ? item.value === (filters.weatherContext?.preference || 'NONE') : filters[key] === item.value })); });
    this._options = options;
    const travel = BASE_OPTIONS.travelMode.find((option) => option.value === filters.travelMode);
    this.setData({
      filters, options, locationLabel: state.locationLabel || '先选一个出发地点', hasLocation: !!state.location,
      canRecommend: recommendationsEnabled, selectionError,
      softPreferences: !!(recommendationsEnabled && config.dataRightsMode === 'LICENSED_ENRICHMENT'),
      showWeather: capabilities.userReportedWeatherEnabled === true || (filters.weatherContext && filters.weatherContext.kind !== 'NONE'),
      cuisines: CUISINES.map((name) => ({ name, selected: (filters.excludedCuisines || []).includes(name) })),
      preferredCuisines: CUISINES.map((name) => ({ name, selected: (filters.preferredCuisines || []).includes(name) })),
      preferences: [['quality', '品质'], ['time', '时间'], ['budget', '预算'], ['mealMatch', '餐次适合'], ['diversity', '多样性']].map(([key, label]) => ({ key, label, value: filters.preferenceVector[key] })),
      aiAvailable: !!(recommendationsEnabled && config.aiEnabled && filters.target === 'MEAL' && filters.mealPeriod === 'LUNCH' && filters.weatherContext.kind === 'NONE'),
      summary: `${filters.budgetMaxYuan == null ? '预算不限' : `${filters.budgetMaxYuan} 元内`} · ${filters.availableMinutes} 分钟 · ${travel ? travel.label : '步行'} · ${filters.radiusMeters / 1000} 公里`,
    });
  },
  select(event) {
    const key = event.currentTarget.dataset.key;
    const option = this._options[key]?.[Number(event.currentTarget.dataset.index)];
    if (!option) return;
    if (key === 'weather') this._draft.weatherContext = option.value === 'NONE' ? { kind: 'NONE' } : { kind: 'USER_REPORTED', preference: option.value };
    else this._draft[key] = option.value;
    this.setData({ error: '' });
    this.sync();
  },
  scenario(event) { this._draft = decisionUi.scenario(this._draft, event.currentTarget.dataset.value); this.sync(); },
  preference(event) {
    const key = event.currentTarget.dataset.key;
    const value = Number(event.detail.value);
    if (!this.data.softPreferences || !Object.keys(this._draft.preferenceVector).includes(key) || !Number.isInteger(value) || value < 0 || value > 100) return;
    this._draft.preferenceVector = { ...this._draft.preferenceVector, [key]: value }; this.sync();
  },
  ai(event) { this._draft.aiAssistanceEnabled = this.data.aiAvailable && event.detail.value === true; this.sync(); },
  toggleCuisine(event) {
    const name = event.currentTarget.dataset.name;
    const preferred = event.currentTarget.dataset.preferred === 'yes';
    if (!CUISINES.includes(name) || (preferred && !this.data.softPreferences)) return;
    const key = preferred ? 'preferredCuisines' : 'excludedCuisines';
    const other = preferred ? 'excludedCuisines' : 'preferredCuisines';
    const selected = this._draft[key] || [];
    this._draft[key] = selected.includes(name) ? selected.filter((item) => item !== name) : selected.concat(name);
    this._draft[other] = (this._draft[other] || []).filter((item) => item !== name);
    this.sync();
  },
  location() {
    try { service.setFilters(this._draft); } catch (_) { /* Unsupported drafts can be corrected on return. */ }
    wx.navigateTo({ url: '/pages/location/index' });
  },
  async refresh() {
    this.setData({ connecting: true, error: '' });
    try { await service.refreshConfig(); } catch (error) { this.setData({ error: error.message || '暂时无法连接服务。' }); }
    this.setData({ connecting: false });
    this.sync();
  },
  submit() {
    if (!service.state.consent) return wx.reLaunch({ url: '/pages/index/index' });
    this.sync();
    if (!service.state.location) return this.location();
    if (!this.data.canRecommend) return this.setData({ error: '推荐服务尚未连接或未开放，请重新连接。' });
    if (this.data.selectionError) return this.setData({ error: this.data.selectionError });
    try {
      service.setFilters(this._draft);
      wx.navigateTo({ url: '/pages/results/index' });
    } catch (error) { this.setData({ error: error.message || '请检查当前选择的条件。' }); }
  },
});
