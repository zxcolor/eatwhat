const service = require('../../lib/service');
const decisionUi = require('../../lib/decision-ui');
const OPEN_LABELS = { OPEN: '营业中', CLOSED: '已休息', UNKNOWN: '营业状态未知' };
const TARGET_LABELS = { MEAL: '这餐的候选', MILK_TEA: '奶茶候选', COFFEE: '咖啡候选', DESSERT: '甜品候选' };

Page({
  data: { themeClass: '', headline: '这餐的候选', loading: false, items: [], totalCount: 0, filter: { openNowOnly: false, knownPriceOnly: false, query: '' }, hasResponse: false, notice: '', error: '', showWhy: false, liveOnly: true, profileLabel: '', canOpen: false, canRetry: false, unavailableNotice: '', summary: '' },
  onLoad() { this._sequence = 0; this._started = false; },
  onShow() {
    getApp().syncPage(this);
    this._active = true;
    if (!service.state.consent) return wx.reLaunch({ url: '/pages/index/index' });
    wx.hideShareMenu();
    this.syncState();
  },
  onHide() { this._active = false; },
  onUnload() { this._active = false; this._sequence += 1; },
  syncState() {
    if (!service.state.consent || this._epoch !== service.state.epoch) {
      this._sequence = (this._sequence || 0) + 1;
      this.setData({ loading: false, error: '', showWhy: false });
    }
    this._epoch = service.state.epoch;
    this.sync();
    if (this._active && !this._started && !service.state.results && this.data.canRetry) this.load();
  },
  sync() {
    const state = service.state;
    const stored = state.results;
    const filters = state.filters;
    const generatedAt = stored && Date.parse(stored.generatedAt);
    const age = Date.now() - generatedAt;
    const available = !!(state.consent && state.status === 'ready' && state.config?.serviceCapabilities && state.config.serviceCapabilities.recommendationsEnabled === true);
    const current = !!(available && stored && Number.isFinite(generatedAt) && age >= -60000 && age < 7200000);
    const response = current ? stored : null;
    if (response !== this._filterResponse) {
      this._filterResponse = response;
      this.setData({ filter: { openNowOnly: false, knownPriceOnly: false, query: '' } });
    }
    const liveOnly = !response || response.dataRightsMode === 'LIVE_DISPLAY_ONLY';
    const unavailableNotice = !state.consent ? '请先阅读并同意隐私政策。'
      : state.status === 'loading' ? '正在重新确认云端服务，请稍候。'
        : !available ? state.error || '推荐服务尚未连接，请返回首页重新连接。'
          : !state.location ? '请先选择出发地点，再重新获取推荐。'
            : stored && !current ? '本次结果已失效，请重新获取。' : '';
    this.setData({
      headline: TARGET_LABELS[filters.target] || TARGET_LABELS.MEAL,
      hasResponse: !!response, liveOnly, canOpen: current, canRetry: !!(available && state.location), unavailableNotice,
      totalCount: response ? response.results.length : 0,
      items: response ? response.results.map((result, index) => ({ result, index })).filter(({ result }) => decisionUi.visible(result, filters.budgetMaxYuan, this.data.filter)).map(({ result, index }) => ({
        index, name: result.name, rank: result.rank,
        mode: result.dataMode === 'LIVE' ? '实时结果' : '演示结果',
        price: result.averageCostYuan === null ? '人均未知' : `约 ¥${Math.round(result.averageCostYuan)} / 人`,
        distance: result.distanceMeters < 1000 ? `${Math.round(result.distanceMeters)} 米` : `${(result.distanceMeters / 1000).toFixed(1)} 公里`,
        travel: `${Math.round(result.estimatedTravelMinutes)} 分钟`,
        openLabel: OPEN_LABELS[result.openStatus] || OPEN_LABELS.UNKNOWN,
        sourceRating: result.sourceRating === null ? '' : result.sourceRating.toFixed(1),
        fitLabel: !liveOnly && result.dataMode !== 'LIVE' && result.fitScore !== null ? `${Math.round(result.fitScore)}% 适合` : '',
        address: result.address, tags: result.tags, reasons: result.reasons,
        warnings: result.warnings, sourceAttribution: result.sourceAttribution,
      })) : [],
      notice: response ? response.notice || '' : '',
      profileLabel: response?.profile ? response.profile.version : '',
      summary: `${state.locationLabel || '已选地点'} · ${filters.budgetMaxYuan == null ? '预算不限' : `${filters.budgetMaxYuan} 元内`} · ${filters.availableMinutes} 分钟`,
    });
  },
  async load() {
    if (this.data.loading) return;
    this.sync();
    if (!this.data.canRetry) return;
    this._started = true;
    const sequence = ++this._sequence;
    this.setData({ loading: true, error: '', items: [], hasResponse: false, canOpen: false, notice: '' });
    try {
      const response = await service.recommend();
      if (this._active && sequence === this._sequence) {
        this.sync();
        response.results.forEach((_, index) => { service.recordEvent(index, 'IMPRESSION', response); });
        if (getApp().recordDecision) getApp().recordDecision(response);
      }
    } catch (error) {
      if (this._active && sequence === this._sequence) this.setData({ error: error.message || '暂时没有获取到结果，请重试。', items: [], hasResponse: false });
    } finally {
      if (sequence === this._sequence) this.setData({ loading: false });
    }
  },
  retry() { if (service.state.results?.results.length) service.recordEvent(0, 'REROLL', service.state.results); this.load(); },
  toggleFilter(event) { const key = event.currentTarget.dataset.key; if (!['openNowOnly', 'knownPriceOnly'].includes(key)) return; this.setData({ filter: { ...this.data.filter, [key]: !this.data.filter[key] } }); this.sync(); },
  queryFilter(event) { this.setData({ filter: { ...this.data.filter, query: String(event.detail.value).slice(0, 40) } }); this.sync(); },
  clearFilters() { this.setData({ filter: { openNowOnly: false, knownPriceOnly: false, query: '' } }); this.sync(); },
  adjust() {
    const pages = getCurrentPages();
    if (pages.length > 1 && pages[pages.length - 2].route === 'pages/conditions/index') wx.navigateBack();
    else wx.redirectTo({ url: '/pages/conditions/index' });
  },
  toggleWhy() { this.setData({ showWhy: !this.data.showWhy }); },
  detail(event) {
    this.sync();
    if (!this.data.canOpen) return this.setData({ error: '本次结果已失效或数据授权尚未确认，请重新获取。' });
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || !service.state.results.results[index]) return;
    service.recordEvent(index, 'DETAIL', service.state.results);
    wx.navigateTo({ url: `/pages/detail/index?index=${index}` });
  },
});
