const service = require('../../lib/service');
Page({
  data: {
    tab:0, themeClass:'theme-light', consent:false, status:'idle', error:'',
    city:'当前位置', historyEnabled:false, historyMessage:'请先在首页阅读并同意隐私说明。', version:service.VERSION,
    tabs:[{label:'首页',icon:'home'},{label:'历史',icon:'history'},{label:'个人',icon:'person'}]
  },
  onLoad() { this._citySequence = 0; },
  onShow() { this._active = true; getApp().syncPage(this); this.syncState(); },
  onHide() { this._active = false; this._citySequence += 1; this._cityLocation = null; },
  onUnload() { this._active = false; this._citySequence += 1; this._cityLocation = null; },
  syncState() {
    const { consent,status,error,config,location,epoch } = service.state;
    const historyEnabled = !!config?.persistenceCapabilities?.historyEnabled;
    this.setData({consent,status,error,historyEnabled,
      historyMessage:!consent ? '请先在首页阅读并同意隐私说明。'
        : status !== 'ready' ? '服务状态尚未确认，可在设置中重新检查。'
        : historyEnabled ? '登录后查看跨设备账号记录，或查看本机最近决策摘要。'
        : '当前服务未开放账号历史。仍可查看不含餐厅和位置的本机决策摘要。'});
    if (!consent || !location) {
      this._citySequence += 1; this._cityLocation = null;
      this.setData({city:'当前位置'});
    } else if (this._active && status === 'ready' && (location !== this._cityLocation || epoch !== this._cityEpoch)) {
      this._cityLocation = location; this._cityEpoch = epoch;
      const sequence = ++this._citySequence;
      this.setData({city:'正在获取城市…'});
      service.cityFor(location).then(city => {
        if (this._active && sequence === this._citySequence && epoch === service.state.epoch && location === service.state.location && service.state.consent) this.setData({city:city || '城市暂未获取'});
      }).catch(() => {
        if (this._active && sequence === this._citySequence && epoch === service.state.epoch) this.setData({city:'城市暂未获取'});
      });
    }
  },
  switchTab(event) { this.setData({tab:Number(event.currentTarget.dataset.tab)}); },
  async accept() { const pending = getApp().acceptConsent(); this.syncState(); await pending; this.syncState(); },
  async retry() { await getApp().checkService(); this.syncState(); },
  privacy() { wx.navigateTo({url:'/pages/privacy/index'}); },
  open(event) {
    const page = event.currentTarget.dataset.page;
    if (!['account','settings','conditions','location','saved','local-records','nearby','support'].includes(page)) return;
    if (page !== 'settings' && !service.state.consent) {
      this.setData({tab:0});
      wx.showToast({title:'请先阅读并同意隐私说明',icon:'none'});
      return;
    }
    wx.navigateTo({url:`/pages/${page}/index`});
  },
  decide() {
    if (!service.state.consent || service.state.status !== 'ready') return;
    wx.navigateTo({url:service.state.location ? '/pages/results/index' : '/pages/location/index'});
  }
});
