Page({
  data: { themeClass: '' },
  onShow() { getApp().syncPage(this) },
  openSettings() { wx.navigateTo({ url: '/pages/settings/index' }) },
})
