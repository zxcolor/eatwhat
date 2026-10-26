const service = require('../../lib/service');
const tasteProfile = require('../../lib/taste-profile');

function ready() { return service.state.consent && service.state.status === 'ready' && !!service.state.config; }
function validLocation(value) {
  return value && Number.isFinite(value.latitude) && value.latitude >= -90 && value.latitude <= 90 &&
    Number.isFinite(value.longitude) && value.longitude >= -180 && value.longitude <= 180 &&
    ['WGS84', 'GCJ02'].includes(value.crs);
}

Page({
  data: {
    themeClass: '', preferenceReady: false, consent: false, status: 'idle', canSearch: false, canLocate: false,
    query: '', places: [], selectionLabel: '', selectionSource: '', notice: '', error: '', serviceMessage: '',
    busy: false, locating: false, refreshing: false, saving: false, canConfirm: false,
  },
  onLoad(options) {
    this._generation = 0;
    this._operation = 0;
    this._returnTo = options?.returnTo === 'results' ? 'results' : '';
    this._places = [];
    this._draft = null;
  },
  onShow() {
    this._generation += 1;
    this._active = getApp().ensureTasteProfile();
    this.setData({ preferenceReady: this._active });
    if (!this._active) return;
    getApp().syncPage(this);
    wx.hideShareMenu();
    this._environment = null;
    this.syncState();
  },
  onHide() { this.leave(); },
  onUnload() { this.leave(); },
  leave() {
    this._active = false;
    this._generation += 1;
    this._refreshing = null;
    this.clearSelection();
    this._environment = null;
  },
  environment() {
    const state = service.state;
    return { epoch: state.epoch, config: state.config, location: state.location, profileRevision: tasteProfile.getState().revision };
  },
  matches(environment) {
    const state = service.state;
    return !!(environment && ready() && tasteProfile.isReady() && environment.epoch === state.epoch &&
      environment.config === state.config && environment.location === state.location &&
      environment.profileRevision === tasteProfile.getState().revision);
  },
  clearSelection() {
    this._operation += 1;
    this._places = [];
    this._placesContext = null;
    this._draft = null;
    this._opening = false;
    this.setData({ places: [], selectionLabel: '', selectionSource: '', notice: '', error: '',
      busy: false, locating: false, saving: false, canConfirm: false });
  },
  syncState() {
    if (!this._active) return;
    const preferenceReady = tasteProfile.isReady();
    if (!preferenceReady || !this.matches(this._environment)) {
      this.clearSelection();
      this.setData({ query: '' });
      this._environment = this.environment();
      if (preferenceReady && ready() && validLocation(service.state.location)) {
        this._draft = { location: service.state.location, label: service.state.locationLabel || '已选地点', context: this.context() };
        this.setData({ selectionLabel: this._draft.label, selectionSource: '当前出发地点' });
      }
    }
    const state = service.state;
    this.setData({ preferenceReady, consent: state.consent, status: state.status,
      refreshing: !!this._refreshing,
      canSearch: !!(preferenceReady && ready() && state.config.serviceCapabilities.locationSearchEnabled),
      canLocate: !!(preferenceReady && ready()),
      canConfirm: !!(preferenceReady && ready() && this._draft && !this.data.busy && !this.data.locating && !this._opening),
      serviceMessage: !state.consent ? '请先返回首页，在个人页阅读并同意隐私说明。'
        : state.status === 'loading' ? '正在连接地点服务，请稍候。'
          : !ready() ? state.error || '地点服务尚未连接，请重新连接后选择。' : '',
    });
  },
  context() { return { ...this.environment(), generation: this._generation, operation: this._operation }; },
  current(context) {
    if (!this._active || !context || context.generation !== this._generation || context.operation !== this._operation) return false;
    if (!this.matches(context)) { this.syncState(); return false; }
    return true;
  },
  available() {
    if (!this._active || !getApp().ensureTasteProfile()) return false;
    if (!this.matches(this._environment)) { this.syncState(); return false; }
    this.syncState();
    return ready() && tasteProfile.isReady() && !this._opening && !this._refreshing;
  },
  inputQuery(event) {
    if (!this.available() || typeof event.detail?.value !== 'string') return;
    // Editing invalidates native permission, GPS, city and search callbacks alike.
    this.clearSelection();
    this.setData({ query: event.detail.value.slice(0, 80) });
  },
  async search() {
    if (!this.available() || !this.data.canSearch || this.data.busy || this.data.locating) return;
    this.clearSelection();
    const context = this.context();
    this.setData({ busy: true });
    try {
      const response = await service.searchLocations(this.data.query);
      if (!this.current(context)) return;
      if (response.dataMode !== 'LIVE' || response.dataSource === 'DEMO') throw new Error('地点资料不是实时数据，请稍后重试。');
      this._places = response.results;
      this._placesContext = context;
      this.setData({
        places: response.results.map((place, index) => ({ index, revision: context.operation,
          name: place.name, address: place.address || '', sourceLabel: place.sourceLabel })),
        notice: response.results.length ? '' : '没有找到匹配地点，请加入城市名或换个关键词。',
      });
    } catch (error) {
      if (this.current(context)) this.setData({ error: error.message || '搜索暂时失败，请稍后重试。' });
    } finally {
      if (this.current(context)) this.setData({ busy: false });
    }
  },
  choose(event) {
    if (!this.available() || this.data.busy || this.data.locating || !this.current(this._placesContext)) return;
    const index = Number(event.currentTarget?.dataset?.index);
    const revision = Number(event.currentTarget?.dataset?.revision);
    if (!Number.isInteger(index) || index < 0 || revision !== this._placesContext.operation) return;
    const place = this._places[index];
    if (!place || !validLocation(place.location)) return;
    this._draft = { location: place.location, label: place.name.slice(0, 80), context: this._placesContext };
    this.setData({ selectionLabel: place.name, selectionSource: place.sourceLabel, canConfirm: true, error: '' });
  },
  locate() {
    if (!this.available() || !this.data.canLocate || this.data.locating || this.data.busy) return;
    this.clearSelection();
    const context = this.context();
    this.setData({ locating: true });
    const fail = () => {
      if (this.current(context)) this.setData({ locating: false, error: '未能获取位置。可以在微信设置中允许位置权限，或通过地点名称手动选择。' });
    };
    let privacySettled = false;
    const authorized = () => {
      if (privacySettled || !this.current(context)) return;
      privacySettled = true;
      let locationSettled = false;
      try {
        wx.getLocation({ type: 'gcj02',
          success: value => {
            if (locationSettled) return;
            locationSettled = true;
            this.located(value, context);
          },
          fail: () => { if (!locationSettled) { locationSettled = true; fail(); } },
        });
      } catch (_) { if (!locationSettled) { locationSettled = true; fail(); } }
    };
    try {
      if (typeof wx.requirePrivacyAuthorize !== 'function') return fail();
      wx.requirePrivacyAuthorize({ success: authorized,
        fail: () => { if (!privacySettled) { privacySettled = true; fail(); } },
      });
    } catch (_) { if (!privacySettled) { privacySettled = true; fail(); } }
  },
  async located(value, context) {
    if (!this.current(context)) return;
    const location = { latitude: value?.latitude, longitude: value?.longitude, crs: 'GCJ02' };
    if (!validLocation(location)) {
      this.setData({ locating: false, error: '定位结果无效，请重新定位或手动搜索地点。' });
      return;
    }
    if (Number.isFinite(value.accuracy) && value.accuracy >= 0 && value.accuracy <= 10000) location.accuracyMeters = value.accuracy;
    let city = null;
    let notice = '';
    if (service.state.config.serviceCapabilities.locationSearchEnabled) {
      try { city = await service.cityFor(location); }
      catch (_) { notice = '城市名暂未获取，可以继续使用当前位置。'; }
    }
    if (!this.current(context)) return;
    this._draft = { location, label: city || '当前位置', context };
    this.setData({ locating: false, selectionLabel: city ? `${city} · 当前位置` : '当前位置',
      selectionSource: '设备定位', canConfirm: true, notice, error: '' });
  },
  confirm() {
    if (!this.available() || this.data.busy || this.data.locating || !this._draft || !this.current(this._draft.context)) return;
    try {
      service.setLocation(this._draft.location, this._draft.label);
      this._environment = this.environment();
      this._operation += 1;
      this._draft.context = this.context();
      this._opening = true;
      const context = this.context();
      this.setData({ saving: true, canConfirm: false, error: '' });
      const fail = () => {
        if (!this.current(context)) return;
        this._opening = false;
        this.setData({ saving: false, canConfirm: true, error: '地点已选好，暂时无法打开下一页，请重试。' });
      };
      try {
        if (this._returnTo === 'results') wx.redirectTo({ url: '/pages/results/index', fail });
        else wx.navigateBack({ fail });
      } catch (_) { fail(); }
    } catch (error) { this.setData({ error: error.message || '地点不可用，请重新选择。' }); }
  },
  async refresh() {
    if (!this._active || !getApp().ensureTasteProfile() || !service.state.consent || this._refreshing || this._opening) return;
    this.clearSelection();
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
