const service = require('../../lib/service');
const decision = require('../../lib/decision/service');
const { getHomeTitle } = require('../../lib/home-title');
Page({
  data: {
    tab:0, themeClass:'theme-light', reducedMotion:false, consent:false, status:'idle', error:'', preferenceReady:false, decisionOpen:false, filterOpen:false,
    filterSummary:'按已确认的口味偏好', previews:[], candidateCount:null, previewIndex:0, compareOpen:false,
    previewError:'', confirmedChoice:false, revealOrigin:null, sourceRect:null, ripple:null,
    city:'虚拟广场', target:'PACKAGE', decisionSummary:'', historyEnabled:false, historyMessage:'请先在首页阅读并同意隐私说明。', version:service.VERSION,
    tabs:[{label:'首页',icon:'home'},{label:'历史',icon:'history'},{label:'个人',icon:'person'}]
  },
  onLoad() { this._openGeneration = 0; this._scrollTop = 0; },
  onPageScroll(event) { this._scrollTop = event.scrollTop || 0; },
  onShow() {
    this.stopTitleClock();
    this._active = getApp().ensureTasteProfile();
    this.setData({preferenceReady:this._active,decisionOpen:false,filterOpen:false});
    if (!this._active) return;
    getApp().syncPage(this); this.syncState();
    this.updateTitle(this._titleGeneration);
  },
  onHide() { this._active = false; this._openGeneration += 1; this.stopTitleClock(); this.closeDecision(); this.closeFilter(); clearTimeout(this._rippleTimer); },
  onUnload() { this._active = false; this._openGeneration += 1; this.stopTitleClock(); this.closeDecision(); this.closeFilter(); clearTimeout(this._rippleTimer); },
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
    const { consent,status,error,config } = service.state;
    const virtual = decision.getState();
    const options = virtual.options || {};
    const filterSummary = [options.budgetCents == null ? '预算不限' : `${options.budgetCents / 100} 元内`,
      options.maxDistanceUnits == null ? '距离不限' : `${options.maxDistanceUnits} 虚拟单位内`,
      options.maxSpicy == null ? '辣度不限' : options.maxSpicy === 0 ? '不辣' : `辣度 ≤ ${options.maxSpicy}`,
      options.vegetarianOnly ? '只看素食' : ''].filter(Boolean).join(' · ');
    let preview = null, previewError = '';
    try { if (typeof decision.previewCandidates === 'function') preview = decision.previewCandidates(3); }
    catch (_) { previewError = '暂时无法读取候选，请重试。'; }
    const historyEnabled = !!config?.persistenceCapabilities?.historyEnabled;
    this.setData({consent,status,error,historyEnabled,city:virtual.origin ? virtual.origin.label : '选择虚拟地点',target:virtual.target,decisionSummary:virtual.summary || '',
      filterSummary, confirmedChoice:virtual.status === 'confirmed', previewError,
      previews:preview ? preview.cards : [], candidateCount:preview ? preview.counts.feasible : null, previewIndex:0,
      historyMessage:!consent ? '请先在个人页阅读并同意隐私说明。'
        : status !== 'ready' ? '服务状态尚未确认，可在设置中重新检查。'
        : historyEnabled ? '登录后查看跨设备账号记录，或查看本机最近决策摘要。'
        : '当前服务未开放账号历史。仍可查看不含餐厅和位置的本机决策摘要。'});
  },
  switchTab(event) { this._openGeneration += 1; this.setData({tab:Number(event.currentTarget.dataset.tab),decisionOpen:false,filterOpen:false}); },
  async accept() { const pending = getApp().acceptConsent(); this.syncState(); await pending; this.syncState(); },
  async retry() { await getApp().checkService(); this.syncState(); },
  privacy() { wx.navigateTo({url:'/pages/privacy/index'}); },
  async open(event) {
    if (!this._active) return;
    const page = event.currentTarget.dataset.page;
    if (['canteen','canteen-records'].includes(page)) {
      this.closeDecision(); this.closeFilter();
      return wx.navigateTo({url:`/pages/${page}/index`});
    }
    if (!getApp().ensureTasteProfile()) return;
    if (page === 'preferences') return wx.navigateTo({url:'/pages/preferences/index?edit=1'});
    if (!['account','settings','conditions','location','saved','local-records','nearby','support','canteen','canteen-records'].includes(page)) return;
    if (!['settings','conditions','location','canteen','canteen-records'].includes(page) && !service.state.consent) {
      this.setData({tab:2});
      wx.showToast({title:'请先阅读并同意隐私说明',icon:'none'});
      return;
    }
    if (['account','saved','nearby','support'].includes(page) && service.state.status !== 'ready') {
      const generation = ++this._openGeneration;
      try { await getApp().checkService(); }
      catch (_) { /* The service state controls the safe failure below. */ }
      if (!this._active || generation !== this._openGeneration || !service.state.consent) return;
      this.syncState();
      if (service.state.status !== 'ready') return wx.showToast({title:service.state.error || '账号服务暂未连接，请稍后重试',icon:'none'});
    }
    wx.navigateTo({url:`/pages/${page}/index`});
  },
  selectTarget(event) {
    if (!this._active || !getApp().ensureTasteProfile()) return;
    const target = event.currentTarget.dataset.target;
    if (!['PACKAGE','RESTAURANT'].includes(target)) return;
    this.closeDecision(); this.closeFilter(); decision.configure({target}); this.syncState();
  },
  openFilter() {
    if (!this._active || !getApp().ensureTasteProfile()) return;
    this.closeDecision(); this.setData({filterOpen:true});
  },
  closeFilter() { if (this.data.filterOpen) this.setData({filterOpen:false}); },
  applyFilters() { this.closeFilter(); this.syncState(); },
  previewChanged(event) { this.setData({previewIndex:event.detail.current}); },
  toggleCompare() { this.setData({compareOpen:!this.data.compareOpen}); },
  retryPreview() { this.syncState(); },
  decide(event) {
    if (!this._active || !getApp().ensureTasteProfile()) return;
    if (this.data.decisionOpen) return;
    if (!decision.getState().origin) return wx.navigateTo({url:'/pages/location/index'});
    this.closeFilter();
    const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : null;
    const point = event?.changedTouches?.[0] || event?.touches?.[0];
    const x = point?.clientX ?? event?.detail?.x;
    const y = point?.clientY ?? (event?.detail?.y - (this._scrollTop || 0));
    const revealOrigin = Number.isFinite(x) && Number.isFinite(y)
      ? {x,y,width:info?.windowWidth || 375,height:info?.windowHeight || 700} : null;
    const generation = ++this._openGeneration;
    const enter = rect => {
      if (!this._active || generation !== this._openGeneration) return;
      this.setData({decisionOpen:true,revealOrigin,sourceRect:rect || null,ripple:null});
    };
    const query = typeof this.createSelectorQuery === 'function' ? this.createSelectorQuery() : null;
    if (query) query.select('.decision-card').boundingClientRect(enter).exec();
    else enter(null);
  },
  pressDecision(event) {
    if (this.data.reducedMotion) return;
    const point = event.touches?.[0];
    if (!point || typeof this.createSelectorQuery !== 'function') return;
    this.createSelectorQuery().select('.decision-card').boundingClientRect(rect => {
      if (!this._active || !rect) return;
      clearTimeout(this._rippleTimer);
      this.setData({ripple:{x:point.clientX - rect.left,y:point.clientY - rect.top,id:Date.now()}});
      this._rippleTimer = setTimeout(() => { if (this._active) this.setData({ripple:null}); }, 320);
    }).exec();
  },
  decisionChanged() { if (this._active) this.syncState(); },
  closeDecision() {
    this._openGeneration = (this._openGeneration || 0) + 1;
    if (this.data.decisionOpen) { this.setData({decisionOpen:false}); if (this._active) this.syncState(); }
  }
});
