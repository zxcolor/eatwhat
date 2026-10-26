const service = require('../../lib/service');
const restaurants = require('../../lib/restaurant-presenter');
const routes = require('../../lib/restaurant-route');
const tasteProfile = require('../../lib/taste-profile');
const { openRestaurantLocation } = require('../../lib/restaurant-navigation');
const coordinate = value => ({ latitude: value.latitude, longitude: value.longitude, crs: value.crs });
const emptyMap = () => ({ hasRoute: false, center: null, markers: [], polylines: [], includePoints: [], steps: [], selectedStep: -1, distanceLabel: '', durationLabel: '', sourceAttribution: '', mapNotice: '' });
Page({
  data: { themeClass: '', reducedMotion: false, preferenceReady: false, current: false, loading: false, actionBusy: false,
    revision: 0, mode: 'WALK', modes: [{ value: 'WALK', label: '步行' }, { value: 'BIKE', label: '骑行' }], unsupportedMode: false,
    destinationName: '', originLabel: '', error: '', ...emptyMap() },
  onLoad(options = {}) {
    const selection = restaurants.takeSelection(options.selection), result = selection?.response?.results[selection.index];
    this._binding = result ? { requestId: selection.response.requestId, resultToken: result.resultToken,
      epoch: selection.epoch, tasteRevision: selection.tasteRevision, index: selection.index } : null;
    this._mode = service.state.filters.travelMode;
    this._generation = 0; this._operation = 0; this._revision = 0;
  },
  onShow() {
    this._active = getApp().ensureTasteProfile();
    this.setData({ preferenceReady: this._active });
    if (!this._active) return;
    this._generation += 1; this._started = false;
    const response = service.state.results, binding = this._binding;
    this._response = binding && response?.requestId === binding.requestId && response.results[binding.index]?.resultToken === binding.resultToken ? response : null;
    this._originReference = service.state.location;
    this._origin = this._originReference ? coordinate(this._originReference) : null;
    getApp().syncPage(this); wx.hideShareMenu(); this.syncState();
  },
  onHide() { this.leave(); },
  onUnload() { this.leave(); this._binding = null; },
  leave() {
    this._active = false; this._generation += 1; this.cancel(); clearTimeout(this._expiryTimer);
    this._response = null; this._origin = null; this._originReference = null; this._route = null; this._renderedRevision = null;
    this.setData({ current: false, loading: false, actionBusy: false, error: '', originLabel: '', destinationName: '', ...emptyMap() });
  },
  cancel() { this._operation += 1; this._pending = null; routes.cancelRoute(); },
  currentResult() {
    const binding = this._binding, taste = tasteProfile.getState();
    if (!this._active || !binding || service.state.epoch !== binding.epoch || !taste.ready || taste.revision !== binding.tasteRevision ||
      this._originReference !== service.state.location || !this._origin || restaurants.currentResponse(service.state, this._response) !== this._response || !this._response) return null;
    const result = this._response.results[binding.index];
    return result?.resultToken === binding.resultToken && result.provider === 'AMAP' && restaurants.actionsFor(result).canNavigate ? result : null;
  },
  updateView(changes) {
    const revision = ++this._revision, generation = this._generation;
    this._renderedRevision = null;
    this.setData({ revision, ...changes }, () => {
      if (this._active && generation === this._generation && revision === this._revision) this._renderedRevision = revision;
    });
  },
  syncState() {
    if (!this._active) return;
    clearTimeout(this._expiryTimer);
    const result = this.currentResult();
    if (!result) {
      this.cancel(); this._route = null;
      this.updateView({ current: false, loading: false, actionBusy: false, destinationName: '', originLabel: '', ...emptyMap(), error: '本次餐厅结果已失效，请返回重新获取。' });
      return;
    }
    this.updateView({ current: true, mode: this._mode, unsupportedMode: !['WALK', 'BIKE'].includes(this._mode),
      destinationName: restaurants.inline(result.name), originLabel: service.state.locationLabel || '已选出发地点' });
    const generation = this._generation;
    this._expiryTimer = setTimeout(() => { if (this._active && generation === this._generation) this.syncState(); },
      Math.max(1, Date.parse(this._response.generatedAt) + restaurants.RESULT_TTL_MS - Date.now()));
    if (!this._started && ['WALK', 'BIKE'].includes(this._mode)) this.loadRoute(this._mode);
  },
  accepts(event) { return !!(this.currentResult() && !this.data.actionBusy && this._renderedRevision === this._revision && Number(event?.currentTarget?.dataset?.revision) === this._revision); },
  async loadRoute(mode) {
    const result = this.currentResult();
    if (!result || !['WALK', 'BIKE'].includes(mode) || this.data.actionBusy) return;
    this.cancel(); this._route = null; this._mode = mode; this._started = true;
    const attempt = { generation: this._generation, operation: this._operation, response: this._response, result };
    this._pending = attempt;
    this.updateView({ mode, unsupportedMode: false, loading: true, error: '', ...emptyMap() });
    try {
      const route = await routes.fetchRoute({ requestId: this._binding.requestId, resultToken: result.resultToken,
        origin: coordinate(this._origin), destination: coordinate(result.location), travelMode: mode });
      if (!this.matches(attempt)) { if (this._active && this._pending === attempt) this.syncState(); return; }
      this._pending = null; this._route = route;
      const markers = [this.marker(1, route.origin, '起点', '/assets/route-start.png'), this.marker(2, route.destination, '餐厅', '/assets/route-end.png')];
      this.updateView({ loading: false, hasRoute: true, markers,
        ...routes.bounds([...route.points, route.origin, route.destination]), polylines: this.polylines(-1),
        steps: route.steps.map((step, index) => ({ index, instruction: step.instruction, roadName: step.roadName || '', action: step.action || '', distance: routes.distanceLabel(step.distanceMeters) })),
        distanceLabel: routes.distanceLabel(route.distanceMeters), durationLabel: routes.durationLabel(route.durationSeconds), sourceAttribution: route.sourceAttribution });
    } catch (error) {
      if (!this.matches(attempt)) { if (this._active && this._pending === attempt) this.syncState(); return; }
      this._pending = null;
      this.updateView({ loading: false, ...emptyMap(), error: error.code === 'CANCELLED' ? ''
        : [409, 410].includes(error.statusCode) ? '本次餐厅已失效，请返回重新获取。'
          : error.statusCode === 429 ? '路线查询已受限，请稍后再试，或返回重新收集餐厅。'
            : '暂时未能取得完整路线，请重试或打开微信地图。' });
    }
  },
  matches(attempt) { return this._active && this._pending === attempt && attempt.generation === this._generation && attempt.operation === this._operation && attempt.response === this._response && this.currentResult() === attempt.result; },
  marker(id, point, label, iconPath) { return { id, latitude: point.latitude, longitude: point.longitude, iconPath, width: 26, height: 34,
    callout: { content: label, display: 'ALWAYS', padding: 7, borderRadius: 8, bgColor: '#FFFFFF', color: '#172B3C', fontSize: 12 } }; },
  polylines(selected) { return this._route.steps.map((step, index) => ({ points: this._route.points.slice(step.startPointIndex, step.endPointIndex + 1),
    color: selected < 0 || selected === index ? '#246FE8' : '#8799AF99', width: selected === index ? 7 : 5, arrowLine: true, borderColor: '#FFFFFF', borderWidth: 1 })); },
  mapError(event) {
    if (!this.accepts(event) || !this._route || this.data.mapNotice) return;
    this.updateView({ mapNotice: '地图暂时无法显示，仍可查看分步说明或打开微信地图。' });
  },
  retry(event) { if (this.accepts(event) && !this._pending) this.loadRoute(this._mode); },
  changeMode(event) { const mode = event?.currentTarget?.dataset?.mode; if (this.accepts(event) && mode !== this._mode && ['WALK', 'BIKE'].includes(mode)) this.loadRoute(mode); },
  selectStep(event) {
    if (!this.accepts(event) || !this._route) return;
    const index = Number(event?.currentTarget?.dataset?.index), step = this._route.steps[index];
    if (!Number.isInteger(index) || !step) return;
    this.updateView({ selectedStep: index, ...routes.bounds(this._route.points.slice(step.startPointIndex, step.endPointIndex + 1)), polylines: this.polylines(index) });
  },
  showAll(event) { if (this.accepts(event) && this._route) this.updateView({ selectedStep: -1, ...routes.bounds([...this._route.points, this._route.origin, this._route.destination]), polylines: this.polylines(-1) }); },
  openMap(event) {
    if (!this.accepts(event)) return;
    this.cancel();
    const result = this.currentResult(), generation = this._generation, response = this._response;
    this.updateView({ actionBusy: true, loading: false, error: '' });
    openRestaurantLocation(result, (successful, message) => {
      if (!this._active || generation !== this._generation || response !== this._response || this.currentResult() !== result) return;
      this.updateView({ actionBusy: false, error: message });
      if (successful) service.recordEvent(this._binding.index, 'NAVIGATION', response);
    });
  },
  back() { if (!this._active) return; if (getCurrentPages().length > 1) wx.navigateBack(); else wx.redirectTo({ url: '/pages/results/index' }); },
});
