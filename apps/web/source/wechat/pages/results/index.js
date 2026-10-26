const service = require('../../lib/service');
const restaurants = require('../../lib/restaurant-presenter');
const { openRestaurantLocation } = require('../../lib/restaurant-navigation');
const tasteProfile = require('../../lib/taste-profile');
function radiusLabel(value) { return value >= 1000 ? `${value / 1000}公里` : `${value}米`; }
function collectionNotice(pool) {
  if (!pool) return '';
  const count = pool.totalCount;
  if (pool.stopReason === 'TIME_LIMIT') return count ? `收集时间较长，先从已取得的${count}家中选择。` : '本次收集超时，尚未取得餐厅，请稍后重新收集。';
  if (pool.stopReason === 'UPSTREAM_UNAVAILABLE') return count ? `来源暂时不可用，先从已收集的${count}家中选择。` : '餐厅来源暂时不可用，请稍后重新收集。';
  if (pool.stopReason === 'PAGE_LIMIT') return `本轮查询已达到上限，收集到${count}家，未满100家；可先选或稍后重新收集。`;
  return count === 100 ? '已收集100家，按来源顺序逐家展示。' : `本次找到${count}家符合条件的餐厅，按实际数量展示。`;
}

Page({
  data: {
    themeClass: '', reducedMotion: false, preferenceReady: false, loading: false, items: [], hasResponse: false,
    revision: 0, totalCount: 0, notice: '', error: '', unavailableNotice: '',
    canRequest: false, consent: false, locationLabel: '', summary: '', liveOnly: true,
    collectedCount: 0, seenCount: 0, remainingCount: 0, canNext: false,
    roundComplete: false, collectionNotice: '', rangeLabel: '', actionBusy: false,
  },
  onLoad() {
    this._generation = 0;
    this._revision = 0;
    this._pending = null;
    this._response = null;
    this._impressedResponse = null;
    this._recordResponse = null;
    this._started = false;
    this._imageResponse = null;
    this._imageFailures = new Set();
    this._navigationAttempt = null;
  },
  onShow() {
    this._active = getApp().ensureTasteProfile();
    this.setData({ preferenceReady: this._active });
    if (!this._active) return;
    this._tasteRevision = tasteProfile.getState().revision;
    this._generation += 1;
    this._started = false;
    this._opening = false;
    this._epoch = service.state.epoch;
    getApp().syncPage(this);
    wx.hideShareMenu();
    this.syncState();
  },
  onHide() { this.leave(); },
  onUnload() { this.leave(); this._response = null; this._recordResponse = null; this._imageResponse = null; this._imageFailures.clear(); },
  leave() {
    this._active = false;
    this._generation += 1;
    this._renderedRevision = null;
    this._opening = false;
    clearTimeout(this._expiryTimer);
    if (this._pending) service.cancelRecommendation();
    this._pending = null;
    this._navigationAttempt = null;
    this.setData({ loading: false, items: [], hasResponse: false, error: '', actionBusy: false });
  },
  syncState() {
    if (!this._active) return;
    if (!this.hasTaste()) {
      this.leave();
      this.setData({ preferenceReady: false });
      getApp().ensureTasteProfile();
      return;
    }
    if (this._epoch !== service.state.epoch || !restaurants.available(service.state, true)) {
      this._generation += 1;
      if (this._pending) service.cancelRecommendation();
      this._pending = null;
      this._started = false;
      this._epoch = service.state.epoch;
    }
    this.render();
    const round = service.getRestaurantDecisionPoolState();
    if (!this._started && !this._pending && !round.hasPool && round.invalidReason !== 'expired' && this.data.canRequest) this.load();
  },
  render() {
    if (!this._active) return;
    clearTimeout(this._expiryTimer);
    const state = service.state;
    const round = service.getRestaurantDecisionPoolState();
    const response = this.hasTaste() && round.hasPool && !this._pending ? restaurants.currentResponse(state, round.response) : null;
    const ready = restaurants.available(state, true);
    const generation = this._generation;
    const revision = ++this._revision;
    this._renderedRevision = null;
    this._response = response;
    if (!response || this._navigationAttempt?.response !== response || this._navigationAttempt?.generation !== generation) this._navigationAttempt = null;
    if (this._imageResponse !== response) {
      this._imageResponse = response;
      this._imageFailures.clear();
    }
    const unavailableNotice = !state.consent ? '请先在首页阅读并同意隐私政策。'
      : state.status === 'loading' ? '正在连接餐厅服务，请稍候。'
        : !ready ? state.error || '餐厅收集服务尚未就绪，请返回首页重新连接。'
          : !restaurants.hasLocation(state) ? '请先选择出发地点。'
            : round.invalidReason === 'expired' ? '本轮餐厅结果已过期，请重新收集。'
              : state.results && !response ? '本轮餐厅结果已失效，请重新收集。' : '';
    this.setData({
      revision, consent: state.consent, canRequest: !!(ready && restaurants.hasLocation(state) && this.hasTaste()),
      loading: !!this._pending, unavailableNotice, actionBusy: !!this._navigationAttempt,
      hasResponse: !!response, items: response ? response.results.map((result, index) => {
        const item = restaurants.presentRestaurant(result, index);
        item.canNavigate = restaurants.actionsFor(result).canNavigate;
        item.canViewRoute = item.canNavigate && result.provider === 'AMAP';
        item.navigationNotice = item.canNavigate ? '打开微信地图后，可选择路线与导航方式。'
          : result.actions?.navigate ? '目的地位置信息不完整，暂时无法导航。' : '当前餐厅暂不支持导航。';
        // Recreate image nodes for each rendered binding, so an old request's
        // error event cannot inherit a newer restaurant's dataset.
        item.viewKey = `${revision}:${index}`;
        if (this._imageFailures.has(index)) item.imageUrl = '';
        return item;
      }) : [],
      totalCount: response ? response.results.length : 0,
      collectedCount: response ? round.totalCount : 0, seenCount: response ? round.seenCount : 0,
      remainingCount: response ? round.remainingCount : 0,
      canNext: !!(response && round.remainingCount > 0 && !this._pending), roundComplete: !!(response && round.exhausted),
      collectionNotice: response ? collectionNotice(round.collection) : '',
      rangeLabel: response && round.collection ? round.collection.pagesFetched > 0
        ? `${round.collection.searchedRadiusMeters > round.collection.initialRadiusMeters ? '已扩大至' : '已搜索'}${radiusLabel(round.collection.searchedRadiusMeters)}范围`
        : '本次尚未取得有效来源结果' : '',
      notice: response?.notice || '', liveOnly: !response || response.dataRightsMode === 'LIVE_DISPLAY_ONLY',
      locationLabel: state.locationLabel || (restaurants.hasLocation(state) ? '已选地点' : '选择地点'),
      summary: `${state.filters.budgetMaxYuan === null ? '人均预算不限' : `人均 ${state.filters.budgetMaxYuan} 元以内`} · 起始范围${radiusLabel(state.filters.radiusMeters)}`,
    }, () => {
      if (!this._active || generation !== this._generation || revision !== this._revision) return;
      this._renderedRevision = revision;
      if (!this.hasTaste() || !response || restaurants.currentResponse(service.state, response) !== response) return;
      if (this._impressedResponse !== response) {
        this._impressedResponse = response;
        if (response.results[0]) service.recordEvent(0, 'IMPRESSION', response);
      }
      if (this._recordResponse === response) {
        this._recordResponse = null;
        if (getApp().recordDecision) getApp().recordDecision(response);
      }
    });
    if (response) {
      const remaining = Date.parse(response.generatedAt) + restaurants.RESULT_TTL_MS - Date.now();
      this._expiryTimer = setTimeout(() => {
        if (this._active && generation === this._generation && this._response === response) this.render();
      }, Math.max(1, remaining));
    }
  },
  accepts(event) {
    return !!(this._active && this.hasTaste() && !this._pending && !this._opening && !this._navigationAttempt &&
      service.state.epoch === this._epoch && restaurants.currentResponse(service.state) === this._response &&
      this._renderedRevision === this._revision && Number(event?.currentTarget?.dataset?.revision) === this._revision);
  },
  imageError(event) {
    const dataset = event?.currentTarget?.dataset;
    if (!this._active || this._pending || !this.hasTaste() || service.state.epoch !== this._epoch ||
      Number(dataset?.revision) !== this._revision || !this._response ||
      restaurants.currentResponse(service.state, this._response) !== this._response) return;
    const index = Number(dataset.index);
    if (!Number.isInteger(index) || !this._response.results[index] || !this.data.items[index]?.imageUrl) return;
    this._imageFailures.add(index);
    this.setData({ [`items[${index}].imageUrl`]: '' });
  },
  hasTaste() {
    const taste = tasteProfile.getState();
    return taste.ready && taste.revision === this._tasteRevision;
  },
  async load() {
    if (!this._active || !this.hasTaste() || this._pending || !restaurants.available(service.state, true) || !restaurants.hasLocation(service.state)) return;
    this._started = true;
    const attempt = { generation: this._generation };
    this._pending = attempt;
    this._renderedRevision = null;
    this.setData({ loading: true, items: [], hasResponse: false, error: '', notice: '',
      canNext: false, roundComplete: false, collectionNotice: '', rangeLabel: '' });
    try {
      const response = await service.collectRestaurantDecisionPool();
      if (!this._active || this._pending !== attempt || attempt.generation !== this._generation) return;
      this._pending = null;
      if (!this.hasTaste()) { this.syncState(); return; }
      if (restaurants.currentResponse(service.state, response) !== response) {
        this.setData({ error: '未取得可展示的实时餐厅结果，请重试。' });
      } else this._recordResponse = response;
      this.render();
    } catch (error) {
      if (!this._active || this._pending !== attempt || attempt.generation !== this._generation) return;
      this._pending = null;
      if (!this.hasTaste()) { this.syncState(); return; }
      if (error.code !== 'CANCELLED') this.setData({ error: error.message || '暂时无法获取餐厅，请稍后重试。' });
      this.render();
    }
  },
  retry(event) {
    if (!this.accepts(event) || !this.data.canRequest) return;
    this.load();
  },
  next(event) {
    if (!this.accepts(event) || !this.data.canNext) return;
    const previous = this._response;
    if (previous?.results[0]) service.recordEvent(0, 'REROLL', previous);
    try { this._recordResponse = service.nextRestaurant(previous); }
    catch (error) { if (error.code !== 'CANCELLED') this.setData({ error: error.message || '本轮餐厅已失效，请重新收集。' }); }
    this.render();
  },
  navigate(event) {
    if (!this.accepts(event)) return;
    const response = restaurants.currentResponse(service.state, this._response);
    const index = Number(event?.currentTarget?.dataset?.index);
    const result = Number.isInteger(index) ? response?.results[index] : null;
    if (!result || !restaurants.actionsFor(result).canNavigate) return;
    const attempt = { response, generation: this._generation };
    this._navigationAttempt = attempt;
    this.setData({ actionBusy: true, error: '' });
    openRestaurantLocation(result, (successful, message) => {
      if (this._navigationAttempt !== attempt) return;
      this._navigationAttempt = null;
      if (!this._active || attempt.generation !== this._generation) return;
      if (!this.hasTaste() || service.state.epoch !== this._epoch ||
        restaurants.currentResponse(service.state, response) !== response || this._response !== response) {
        this.render();
        return;
      }
      this.setData({ actionBusy: false, error: message });
      if (successful) service.recordEvent(index, 'NAVIGATION', response);
    });
  },
  detail(event) { this.openRestaurantPage(event, 'detail'); },
  openRoute(event) { this.openRestaurantPage(event, 'route'); },
  openRestaurantPage(event, page) {
    if (!this.accepts(event) || !['detail', 'route'].includes(page)) return;
    const response = restaurants.currentResponse(service.state, this._response);
    const index = Number(event.currentTarget.dataset.index);
    if (!response || !Number.isInteger(index) || !response.results[index]) { this.render(); return; }
    if (page === 'route' && (response.results[index].provider !== 'AMAP' || !restaurants.actionsFor(response.results[index]).canNavigate)) return;
    const selection = restaurants.selectionFor(response, index, service.state.epoch, this._tasteRevision);
    if (!selection) return;
    const generation = this._generation;
    this._opening = true;
    const failed = () => {
      restaurants.discardSelection(selection);
      if (this._active && generation === this._generation) {
        this._opening = false;
        this.setData({ error: page === 'route' ? '暂时无法打开到店路线，请重试。' : '暂时无法打开餐厅详情，请重试。' });
      }
    };
    try { wx.navigateTo({ url: `/pages/${page}/index?selection=${selection}`, fail: failed }); }
    catch (_) { failed(); }
  },
  adjust() { if (this._active && !this.data.actionBusy && this.hasTaste()) wx.navigateTo({ url: '/pages/conditions/index' }); },
  location() { if (this._active && !this.data.actionBusy && this.hasTaste()) wx.navigateTo({ url: '/pages/location/index?returnTo=results' }); },
  home() { if (this._active) wx.reLaunch({ url: '/pages/index/index' }); },
});
