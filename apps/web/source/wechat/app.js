const service = require('./lib/service');
const account = require('./lib/account');
const localRecords = require('./lib/local-records');
const canteenRecords = require('./lib/canteen-records');
const canteenAI = require('./lib/canteen-ai');
const canteenSession = require('./lib/canteen-session');
const takeout = require('./lib/takeout');
const nearby = require('./lib/nearby');
const saved = require('./lib/saved');
const tasteProfile = require('./lib/taste-profile');
const CONSENT_KEY = 'eatwhat.wechat.consent.v2';
const THEME_KEY = 'eatwhat.wechat.theme';
const MOTION_KEY = 'eatwhat.wechat.reduced-motion';
App({
  globalData: { theme: 'system', systemTheme: 'light', reducedMotion: false, localDataError: '', canteenEpoch: 0 },
  onLaunch() {
    service.clearRestaurantDecisionPool();
    canteenSession.clear();
    this.clearTakeoutState();
    tasteProfile.load();
    const theme = wx.getStorageSync(THEME_KEY);
    this.globalData.theme = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
    this.globalData.reducedMotion = wx.getStorageSync(MOTION_KEY) === true;
    this.globalData.systemTheme = wx.getAppBaseInfo().theme || 'light';
    service.setConsent(wx.getStorageSync(CONSENT_KEY) === true);
    nearby.subscribe(() => {
      const origin = nearby.state.location;
      if (origin && service.state.consent && service.state.status === 'ready' && !service.state.location) {
        const location = { latitude: origin.latitude, longitude: origin.longitude, crs: origin.crs };
        if (Number.isFinite(origin.accuracyMeters) && origin.accuracyMeters >= 0 && origin.accuracyMeters <= 10000) location.accuracyMeters = origin.accuracyMeters;
        try { service.setLocation(location, '当前位置'); } catch (_) { /* Collection remains independent of recommendation availability. */ }
      }
      this.updatePages();
    });
    try { localRecords.prune(); } catch (error) { this.globalData.localDataError = error.message; }
    try { canteenRecords.prune(); } catch (error) { this.globalData.localDataError = [this.globalData.localDataError, error.message].filter(Boolean).join('；'); }
    if (!service.state.consent) { try { nearby.withdraw(); } catch (error) { this.globalData.localDataError = error.message; } }
    wx.onThemeChange(({ theme: value }) => {
      this.globalData.systemTheme = value;
      this.updatePages();
    });
  },
  onShow() {
    const pages = getCurrentPages();
    const route = pages.length ? pages[pages.length - 1].route : '';
    if (route === 'pages/canteen/index' && !this.ensureTasteProfile({ returnTo: 'canteen' })) return;
    if (['pages/index/index', 'pages/conditions/index', 'pages/results/index', 'pages/detail/index', 'pages/location/index', 'pages/takeout/index'].includes(route)
      && !this.ensureTasteProfile()) return;
    if (service.state.consent && ['pages/account/index', 'pages/saved/index', 'pages/support/index', 'pages/nearby/index'].includes(route)) {
      if (route === 'pages/nearby/index') nearby.open();
      this.checkService();
    }
  },
  onHide() { nearby.stop(); account.suspend(); saved.invalidate(); canteenAI.cancel(); takeout.cancel(); service.invalidate(); this.updatePages(); },
  clearTakeoutState() {
    const reportFailure = () => {
      this.globalData.localDataError = [...new Set([...(this.globalData.localDataError || '').split('；').filter(Boolean),
        '截图处理副本清理未完成，请在设置中重试'])].join('；');
      try { this.updatePages(); } catch (_) { /* Keep the cleanup failure available for the next visible page. */ }
    };
    try {
      const pending = takeout.clear();
      if (pending && typeof pending.catch === 'function') pending.catch(reportFailure);
      return true;
    } catch (_) { reportFailure(); return false; }
  },
  async checkService() {
    const pending = service.refreshConfig();
    nearby.syncCapabilities();
    this.updatePages();
    try { await pending; } catch (_) { /* Pages render the safe service error. */ }
    nearby.syncCapabilities();
    this.updatePages();
  },
  acceptConsent() {
    wx.setStorageSync(CONSENT_KEY, true);
    service.setConsent(true);
    return this.checkService();
  },
  withdrawConsent() {
    canteenSession.clear();
    this.globalData.canteenEpoch += 1;
    account.clear();
    saved.invalidate();
    service.setConsent(false);
    const failures = [];
    if (!this.clearTakeoutState()) failures.push('截图处理副本清理未完成，请重试');
    try { canteenAI.withdraw(); } catch (error) { failures.push(error.message); }
    try { tasteProfile.clear(); } catch (error) { failures.push(error.message); }
    let consentRevoked = false;
    try { wx.setStorageSync(CONSENT_KEY, false); consentRevoked = true; } catch (_) { /* Removing the key is an independent fallback. */ }
    try { wx.removeStorageSync(CONSENT_KEY); consentRevoked = true; } catch (_) { /* A stored false also prevents restoration. */ }
    if (!consentRevoked) failures.push('隐私选择保存失败，请重试清理后再关闭小程序');
    try { localRecords.clear(); } catch (error) { failures.push(error.message); }
    try { canteenRecords.withdraw(); } catch (error) { failures.push(error.message); }
    try { nearby.withdraw(); } catch (error) { failures.push(error.message); }
    this.globalData.localDataError = failures.join('；');
    this.updatePages();
    wx.reLaunch({ url: '/pages/preferences/index' });
    if (failures.length) wx.showToast({ title: '服务已停止，部分本机数据清理失败，请在设置中重试', icon: 'none' });
  },
  recordDecision(response) {
    if (!service.state.consent || response !== service.state.results || service.state.status !== 'ready') return;
    try { localRecords.recordDecision(service.state.filters, response.results.length); }
    catch (error) { this.globalData.localDataError = error.message; }
  },
  applyTheme(value) {
    if (!['light', 'dark', 'system'].includes(value)) return;
    this.globalData.theme = value;
    wx.setStorageSync(THEME_KEY, value);
    this.updatePages();
  },
  applyReducedMotion(value) {
    if (typeof value !== 'boolean') return;
    try { wx.setStorageSync(MOTION_KEY, value); }
    catch (_) { wx.showToast({ title: '动态效果设置未保存，请重试', icon: 'none' }); return; }
    this.globalData.reducedMotion = value;
    this.updatePages();
  },
  ensureTasteProfile({ returnTo = 'home' } = {}) {
    if (tasteProfile.isReady()) {
      const pending = this._preferenceRedirect;
      if (pending) clearTimeout(pending.timer);
      this._preferenceRedirect = null;
      this._openingPreferences = false;
      return true;
    }
    canteenSession.clear();
    this.clearTakeoutState();
    service.clearRestaurantDecisionPool();
    const pages = getCurrentPages();
    if (pages[pages.length - 1]?.route === 'pages/preferences/index' || this._preferenceRedirect) return false;
    const pending = { attempts: 0, timer: null, returnTo: returnTo === 'canteen' ? 'canteen' : 'home' };
    this._preferenceRedirect = pending;
    this._openingPreferences = true;
    const finish = () => {
      if (this._preferenceRedirect !== pending) return;
      this._preferenceRedirect = null;
      this._openingPreferences = false;
    };
    const openPreferences = () => {
      if (this._preferenceRedirect !== pending) return;
      pending.timer = null;
      const current = getCurrentPages();
      if (tasteProfile.isReady() || current[current.length - 1]?.route === 'pages/preferences/index') {
        finish();
        return;
      }
      pending.attempts += 1;
      let settled = false;
      const failed = () => {
        if (settled || this._preferenceRedirect !== pending) return;
        settled = true;
        // A native navigation may still be completing after onShow returns.
        // Retry only reported failures, finitely; never re-enter synchronously.
        if (pending.attempts < 3) pending.timer = setTimeout(openPreferences, 50);
        else {
          finish();
          wx.showToast({ title: '暂时无法打开口味偏好，请重新进入小程序', icon: 'none' });
        }
      };
      try {
        wx.reLaunch({ url: pending.returnTo === 'canteen' ? '/pages/preferences/index?returnTo=canteen' : '/pages/preferences/index',
          success: () => { if (!settled) { settled = true; finish(); } }, fail: failed });
      } catch (_) { failed(); }
    };
    // Protected Pages call this from onShow. Leave the current navigation's
    // lifecycle stack before starting another native navigation operation.
    pending.timer = setTimeout(openPreferences, 0);
    return false;
  },
  completeTasteProfile(revision, returnTo = 'home') {
    tasteProfile.confirm(revision);
    canteenSession.clear();
    this.clearTakeoutState();
    this.globalData.canteenEpoch += 1;
    service.clearRestaurantDecisionPool();
    this._openingPreferences = false;
    return new Promise((resolve, reject) => {
      wx.reLaunch({ url: returnTo === 'canteen' ? '/pages/canteen/index' : '/pages/index/index',
        success: resolve,
        fail: () => {
          const error = new Error('口味已保存，暂时无法进入页面，请重试。');
          error.code = 'TASTE_NAVIGATION_ERROR';
          reject(error);
        } });
    });
  },
  clearTasteProfile() {
    canteenSession.clear();
    this.clearTakeoutState();
    this.globalData.canteenEpoch += 1;
    canteenAI.cancel();
    service.clearRestaurantDecisionPool();
    try {
      tasteProfile.clear();
      this.globalData.localDataError = '';
    } catch (error) {
      this.globalData.localDataError = error.message;
    }
    this._openingPreferences = false;
    wx.reLaunch({ url: '/pages/preferences/index' });
  },
  syncPage(page) {
    const dark = this.globalData.theme === 'dark' ||
      (this.globalData.theme === 'system' && this.globalData.systemTheme === 'dark');
    page.setData({ themeClass: dark ? 'theme-dark' : 'theme-light', reducedMotion: this.globalData.reducedMotion === true });
    wx.setNavigationBarColor({ frontColor: dark ? '#ffffff' : '#000000', backgroundColor: dark ? '#0d1c2b' : '#edf3f5' });
  },
  updatePages() {
    saved.syncCapabilities();
    getCurrentPages().forEach(page => {
      this.syncPage(page);
      if (typeof page.syncState === 'function') page.syncState();
    });
  }
});
