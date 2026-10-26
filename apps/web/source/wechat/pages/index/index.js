const service = require('../../lib/service');
const { getHomeTitle } = require('../../lib/home-title');
Page({
  data: {
    tab:0, themeClass:'theme-light', reducedMotion:false, consent:false, status:'idle', error:'', preferenceReady:false,
    filterSummary:'', city:'选择地点', historyEnabled:false, historyMessage:'', version:service.VERSION,
    tabs:[{label:'首页',icon:'home'},{label:'历史',icon:'history'},{label:'个人',icon:'person'}]
  },
  onLoad() { this._openGeneration = 0; this._scrollTop = 0; },
  onPageScroll(event) { this._scrollTop = event.scrollTop || 0; },
  onShow() {
    this.stopTitleClock();
    this._active = getApp().ensureTasteProfile();
    this.setData({preferenceReady:this._active});
    if (!this._active) return;
    getApp().syncPage(this); this.syncState();
    this.updateTitle(this._titleGeneration);
  },
  onHide() { this._active = false; this._openGeneration += 1; this.stopTitleClock();  },
  onUnload() { this._active = false; this._openGeneration += 1; this.stopTitleClock();  },
  stopTitleClock() {
    clearTimeout(this._titleTimer);
    this._titleTimer = undefined;
    this._titleGeneration = (this._titleGeneration || 0) + 1;
    this._navigationTitle = '';
  },
  updateTitle(generation) {
    if (!this._active || generation !== this._titleGeneration) return;
    const now = Date.now();
    const title = getHomeTitle(now);
    if (title !== this._navigationTitle) {
      this._navigationTitle = title;
      wx.setNavigationBarTitle({title, fail:() => {
        if (this._active && generation === this._titleGeneration) this._navigationTitle = '';
      }});
    }
    // Recheck on each clock minute, including after a device-clock correction.
    this._titleTimer = setTimeout(() => this.updateTitle(generation), 60000 - now % 60000);
  },
  syncState() {
    const { consent,status,error,config,locationLabel,filters = service.DEFAULT_FILTERS || {} } = service.state;
    const budget = filters.budgetMaxYuan == null ? '人均预算不限' : '人均 ' + filters.budgetMaxYuan + ' 元内';
    const radius = Number.isFinite(filters.radiusMeters) ? '从 ' + (filters.radiusMeters / 1000) + ' km 开始' : '按服务范围';
    const historyEnabled = !!config?.persistenceCapabilities?.historyEnabled;
    this.setData({consent,status,error,historyEnabled,city:locationLabel || '选择地点',filterSummary:budget + ' · ' + radius,
      historyMessage:!consent ? '请先在个人页阅读并同意隐私说明。'
        : status !== 'ready' ? '服务状态尚未确认，可在设置中重新检查。'
        : historyEnabled ? '登录后查看跨设备账号记录，或查看本机最近决策摘要。'
        : '当前服务未开放账号历史。仍可查看不含餐厅和位置的本机决策摘要。'});
  },
  switchTab(event) { this._openGeneration += 1; this.setData({tab:Number(event.currentTarget.dataset.tab)}); },
  async accept() { const pending = getApp().acceptConsent(); this.syncState(); try { await pending; } catch (_) { /* Render the service error. */ } if (this._active) this.syncState(); },
  async retry() { await getApp().checkService(); if (this._active) this.syncState(); },
  privacy() { wx.navigateTo({url:'/pages/privacy/index'}); },
  async open(event) {
    if (!this._active || !getApp().ensureTasteProfile()) return;
    const page = event.currentTarget.dataset.page;
    if (['canteen','takeout','canteen-records','settings'].includes(page)) {
      this._openGeneration += 1;
      return wx.navigateTo({url:'/pages/' + page + '/index'});
    }
    if (page === 'preferences') {
      this._openGeneration += 1;
      return wx.navigateTo({url:'/pages/preferences/index?edit=1'});
    }
    if (!['account','conditions','location','results','saved','local-records','nearby','support'].includes(page)) return;
    if (!service.state.consent) {
      this.setData({tab:2});
      wx.showToast({title:'请先阅读并同意隐私说明',icon:'none'});
      return;
    }
    const generation = ++this._openGeneration;
    if (service.state.status !== 'ready') {
      try { await getApp().checkService(); } catch (_) { /* The service state controls the safe failure below. */ }
      if (!this._active || generation !== this._openGeneration || !service.state.consent) return;
      this.syncState();
      if (service.state.status !== 'ready') return wx.showToast({title:service.state.error || '服务暂未连接，请稍后重试',icon:'none'});
    }
    if (!getApp().ensureTasteProfile()) return;
    const needsLocation = page === 'results' && !service.state.location;
    wx.navigateTo({url:needsLocation ? '/pages/location/index?returnTo=results' : '/pages/' + page + '/index'});
  },
  decide() { return this.open({currentTarget:{dataset:{page:'results'}}}); },
  openFilter() { return this.open({currentTarget:{dataset:{page:'conditions'}}}); }
});
