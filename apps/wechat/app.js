const service = require('./lib/service');
const account = require('./lib/account');
const localRecords = require('./lib/local-records');
const nearby = require('./lib/nearby');
const saved = require('./lib/saved');
const CONSENT_KEY = 'eatwhat.wechat.consent.v2';
const THEME_KEY = 'eatwhat.wechat.theme';
App({
  globalData: { theme: 'system', systemTheme: 'light', localDataError: '' },
  onLaunch() {
    const theme = wx.getStorageSync(THEME_KEY);
    this.globalData.theme = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
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
    if (!service.state.consent) { try { nearby.withdraw(); } catch (error) { this.globalData.localDataError = error.message; } }
    wx.onThemeChange(({ theme: value }) => {
      this.globalData.systemTheme = value;
      this.updatePages();
    });
  },
  onShow() { nearby.open(); if (service.state.consent) this.checkService(); },
  onHide() { nearby.stop(); account.suspend(); saved.invalidate(); service.invalidate(); this.updatePages(); },
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
    account.clear();
    saved.invalidate();
    service.setConsent(false);
    const failures = [];
    let consentRevoked = false;
    try { wx.setStorageSync(CONSENT_KEY, false); consentRevoked = true; } catch (_) { /* Removing the key is an independent fallback. */ }
    try { wx.removeStorageSync(CONSENT_KEY); consentRevoked = true; } catch (_) { /* A stored false also prevents restoration. */ }
    if (!consentRevoked) failures.push('隐私选择保存失败，请重试清理后再关闭小程序');
    try { localRecords.clear(); } catch (error) { failures.push(error.message); }
    try { nearby.withdraw(); } catch (error) { failures.push(error.message); }
    this.globalData.localDataError = failures.join('；');
    this.updatePages();
    wx.reLaunch({ url: '/pages/index/index' });
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
  syncPage(page) {
    const dark = this.globalData.theme === 'dark' ||
      (this.globalData.theme === 'system' && this.globalData.systemTheme === 'dark');
    page.setData({ themeClass: dark ? 'theme-dark' : 'theme-light' });
    wx.setNavigationBarColor({ frontColor: dark ? '#ffffff' : '#000000', backgroundColor: dark ? '#181a20' : '#f3f3f8' });
  },
  updatePages() {
    saved.syncCapabilities();
    getCurrentPages().forEach(page => {
      this.syncPage(page);
      if (typeof page.syncState === 'function') page.syncState();
    });
  }
});
