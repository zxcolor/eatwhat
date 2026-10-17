const service = require('./lib/service');
const account = require('./lib/account');
const CONSENT_KEY = 'eatwhat.wechat.consent.v1';
const THEME_KEY = 'eatwhat.wechat.theme';
App({
  globalData: { theme: 'system', systemTheme: 'light' },
  onLaunch() {
    const theme = wx.getStorageSync(THEME_KEY);
    this.globalData.theme = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
    this.globalData.systemTheme = wx.getAppBaseInfo().theme || 'light';
    service.setConsent(wx.getStorageSync(CONSENT_KEY) === true);
    wx.onThemeChange(({ theme: value }) => {
      this.globalData.systemTheme = value;
      this.updatePages();
    });
  },
  onShow() { if (service.state.consent) this.checkService(); },
  onHide() { account.suspend(); service.invalidate(); this.updatePages(); },
  async checkService() {
    const pending = service.refreshConfig();
    this.updatePages();
    try { await pending; } catch (_) { /* Pages render the safe service error. */ }
    this.updatePages();
  },
  acceptConsent() {
    wx.setStorageSync(CONSENT_KEY, true);
    service.setConsent(true);
    return this.checkService();
  },
  withdrawConsent() {
    wx.removeStorageSync(CONSENT_KEY);
    account.clear();
    service.setConsent(false);
    this.updatePages();
    wx.reLaunch({ url: '/pages/index/index' });
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
    getCurrentPages().forEach(page => {
      this.syncPage(page);
      if (typeof page.syncState === 'function') page.syncState();
    });
  }
});
