const service = require('../../lib/service');

Page({
  data: { themeClass: '', query: '', places: [], notice: '', error: '', busy: false, locating: false, canSearch: false, locationLabel: '' },
  onLoad() { this._sequence = 0; this._places = []; },
  onShow() {
    getApp().syncPage(this);
    this._active = true;
    if (!service.state.consent) return wx.reLaunch({ url: '/pages/index/index' });
    this.syncState();
    wx.hideShareMenu();
  },
  onHide() { this._active = false; this._sequence += 1; },
  onUnload() { this._active = false; this._sequence += 1; this._places = []; },
  syncState() {
    if (!service.state.consent || this._epoch !== service.state.epoch) {
      this._sequence = (this._sequence || 0) + 1;
      this._places = [];
      this.setData({ query: '', places: [], notice: '', error: '', busy: false, locating: false });
    }
    this._epoch = service.state.epoch;
    this.sync();
  },
  sync() {
    const state = service.state;
    this.setData({
      canSearch: !!(state.consent && state.status === 'ready' && state.config?.serviceCapabilities && state.config.serviceCapabilities.locationSearchEnabled === true),
      locationLabel: state.locationLabel || '',
    });
  },
  inputQuery(event) { this.setData({ query: event.detail.value, error: '' }); },
  async refresh() {
    this.setData({ error: '' });
    try { await service.refreshConfig(); } catch (error) { this.setData({ error: error.message }); }
    if (this._active) this.sync();
  },
  async search() {
    if (this.data.busy || this.data.locating) return;
    this.sync();
    if (!this.data.canSearch) return this.setData({ error: '地点搜索当前不可用，请重新连接服务。' });
    const sequence = ++this._sequence;
    this._places = [];
    this.setData({ busy: true, error: '', places: [], notice: '' });
    try {
      const response = await service.searchLocations(this.data.query);
      if (!this._active || sequence !== this._sequence || !service.state.consent) return;
      this._places = response.results;
      this._epoch = service.state.epoch;
      this.setData({
        places: response.results.map((place, index) => ({ index, name: place.name, address: place.address || '', sourceLabel: place.sourceLabel, mode: response.dataMode === 'LIVE' ? '实时地点' : '演示地点' })),
        notice: response.notice || (response.results.length ? '' : '没有找到匹配地点，请加入城市名或换个关键词。'),
      });
    } catch (error) {
      if (this._active && sequence === this._sequence) this.setData({ error: error.message || '搜索暂时失败，请稍后重试。' });
    } finally {
      if (this._active && sequence === this._sequence) this.setData({ busy: false });
    }
  },
  choose(event) {
    const place = this._places[Number(event.currentTarget.dataset.index)];
    if (!place || this._epoch !== service.state.epoch || !service.state.consent) return;
    try {
      service.setLocation(place.location, place.name.slice(0, 80));
      this.done();
    } catch (error) { this.setData({ error: error.message || '地点信息无效，请重新搜索。' }); }
  },
  locate() {
    if (this.data.locating || this.data.busy || !service.state.consent) return;
    const sequence = ++this._sequence;
    const epoch = service.state.epoch;
    this.setData({ locating: true, error: '' });
    wx.getLocation({
      type: 'wgs84',
      success: (value) => {
        if (!this._active || sequence !== this._sequence || epoch !== service.state.epoch || !service.state.consent) return;
        const location = { latitude: value.latitude, longitude: value.longitude, crs: 'WGS84' };
        if (Number.isFinite(value.accuracy) && value.accuracy >= 0 && value.accuracy <= 10000) location.accuracyMeters = value.accuracy;
        try {
          service.setLocation(location, '当前位置');
          this.done();
        } catch (error) { this.setData({ error: error.message || '定位结果不可用，请手动选择地点。' }); }
        finally { if (this._active && sequence === this._sequence) this.setData({ locating: false }); }
      },
      fail: () => {
        if (this._active && sequence === this._sequence) this.setData({ locating: false, error: '未能获取位置。你可以在微信权限设置中允许定位，或通过地点名称手动选择。' });
      },
    });
  },
  done() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.redirectTo({ url: '/pages/conditions/index' });
  },
});
