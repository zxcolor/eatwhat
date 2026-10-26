Page({
  data: { themeClass: '' },
  onShow() { getApp().syncPage(this) },
  openSettings() { wx.navigateTo({ url: '/pages/settings/index' }) },
  copyMimoPrivacy() { wx.setClipboardData({ data: 'https://privacy.mi.com/XiaomiMiMoPlatform/zh_CN/' }) },
})
