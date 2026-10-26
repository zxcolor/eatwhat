const service = require('../../lib/service');
const saved = require('../../lib/saved');
const restaurants = require('../../lib/restaurant-presenter');
const { openRestaurantLocation } = require('../../lib/restaurant-navigation');
const tasteProfile = require('../../lib/taste-profile');

Page({
  data: {
    themeClass: '', reducedMotion: false, preferenceReady: false, result: null, current: false, revision: 0,
    canNavigate: false, canViewRoute: false, canCall: false, canCopy: false, actionBusy: false,
    actionNotice: '', error: '', canFavorite: false, canFeedback: false,
    favoriteSaved: false, feedbackTypes: [], saveBusy: false, saveNotice: '',
  },
  onLoad(options = {}) {
    const selection = restaurants.takeSelection(options.selection);
    this._response = selection?.response || null;
    this._index = selection?.index ?? -1;
    this._epoch = selection?.epoch ?? -1;
    this._tasteRevision = selection?.tasteRevision ?? -1;
    this._generation = 0;
    this._revision = 0;
    this._saveGeneration = 0;
    this._imageFailed = false;
  },
  onShow() {
    this._active = getApp().ensureTasteProfile();
    this.setData({ preferenceReady: this._active });
    if (!this._active) return;
    this._generation += 1;
    getApp().syncPage(this);
    wx.hideShareMenu();
    this.render();
  },
  onHide() { this.leave(); },
  onUnload() { this.leave(); this._response = null; },
  leave() {
    this._active = false;
    this._generation += 1;
    this._saveGeneration += 1;
    this._renderedRevision = null;
    clearTimeout(this._expiryTimer);
    this.setData({ current: false, result: null, actionBusy: false, saveBusy: false, error: '' });
  },
  syncState() {
    if (!this._active) return;
    this._saveGeneration += 1;
    if (service.state.epoch !== this._epoch || service.state.results !== this._response || !service.state.consent) this._response = null;
    this.render();
  },
  currentResult() {
    const taste = tasteProfile.getState();
    if (!this._active || !taste.ready || taste.revision !== this._tasteRevision ||
      service.state.epoch !== this._epoch || !restaurants.currentResponse(service.state, this._response)) return null;
    return this._response.results[this._index] || null;
  },
  render() {
    if (!this._active) return;
    clearTimeout(this._expiryTimer);
    this._renderedRevision = null;
    const result = this.currentResult();
    const generation = this._generation;
    const revision = ++this._revision;
    if (!result) {
      this.setData({ revision, current: false, result: null, canNavigate: false, canViewRoute: false, canCall: false, canCopy: false,
        canFavorite: false, canFeedback: false, favoriteSaved: false, feedbackTypes: [],
        actionBusy: false, saveBusy: false, saveNotice: '', actionNotice: '本次餐厅结果已失效，请返回重新获取。' });
      return;
    }
    const response = this._response;
    const persistence = saved.creationView(response, result);
    const presentation = restaurants.presentRestaurant(result, this._index);
    if (this._imageFailed) presentation.imageUrl = '';
    this.setData({
      revision, current: true, result: presentation,
      ...restaurants.actionsFor(result),
      canViewRoute: result.provider === 'AMAP' && restaurants.actionsFor(result).canNavigate,
      canFavorite: persistence.canFavorite, canFeedback: persistence.canFeedback,
      favoriteSaved: persistence.favoriteSaved, feedbackTypes: persistence.feedbackTypes,
      saveBusy: persistence.busy, saveNotice: persistence.notice,
    }, () => {
      if (!this._active || generation !== this._generation || revision !== this._revision || this.currentResult() !== result) return;
      this._renderedRevision = revision;
      if (this._detailRecorded !== response) {
        this._detailRecorded = response;
        service.recordEvent(this._index, 'DETAIL', response);
      }
    });
    const remaining = Date.parse(response.generatedAt) + restaurants.RESULT_TTL_MS - Date.now();
    this._expiryTimer = setTimeout(() => {
      if (this._active && generation === this._generation && this._response === response) this.render();
    }, Math.max(1, remaining));
  },
  accepts(event) {
    return !!(this._active && !this.data.actionBusy && !this.data.saveBusy && this.currentResult() &&
      this._renderedRevision === this._revision && Number(event?.currentTarget?.dataset?.revision) === this._revision);
  },
  imageError(event) {
    if (!this.currentResult() || Number(event?.currentTarget?.dataset?.revision) !== this._revision ||
      !this.data.result?.imageUrl) return;
    this._imageFailed = true;
    this.setData({ 'result.imageUrl': '' });
  },
  runAction(event, type) {
    if (!this.accepts(event)) return;
    const result = this.currentResult();
    const access = restaurants.actionsFor(result);
    if (type === 'navigate' && !access.canNavigate || type === 'call' && !access.canCall || type === 'copy' && !access.canCopy) return;
    const response = this._response;
    const generation = this._generation;
    let settled = false;
    const complete = (successful, message = '') => {
      if (settled) return;
      settled = true;
      if (!this._active || generation !== this._generation || response !== this._response || this.currentResult() !== result) return;
      this.setData({ actionBusy: false, error: successful ? '' : message });
      if (successful && type !== 'copy') service.recordEvent(this._index, type === 'navigate' ? 'NAVIGATION' : 'CALL', response);
    };
    this.setData({ actionBusy: true, error: '' });
    try {
      if (type === 'navigate') openRestaurantLocation(result, complete);
      else if (type === 'call') wx.makePhoneCall({ phoneNumber: restaurants.phoneNumber(result.phone),
        success: () => complete(true), fail: () => complete(false, '未完成拨号，可稍后重试。') });
      else wx.setClipboardData({ data: restaurants.inline(result.address),
        success: () => complete(true), fail: () => complete(false, '暂时无法复制地址，请重试。') });
    } catch (_) { complete(false, '暂时无法完成操作，请重试。'); }
  },
  openRoute(event) {
    if (!this.accepts(event) || !this.data.canViewRoute) return;
    const result = this.currentResult();
    if (result.provider !== 'AMAP' || !restaurants.actionsFor(result).canNavigate) return;
    const selection = restaurants.selectionFor(this._response, this._index, this._epoch, this._tasteRevision);
    if (!selection) return;
    const generation = this._generation;
    this.setData({ actionBusy: true, error: '' });
    const failed = () => {
      restaurants.discardSelection(selection);
      if (this._active && generation === this._generation && this.currentResult() === result) this.setData({ actionBusy: false, error: '暂时无法打开到店路线，请重试。' });
    };
    try { wx.navigateTo({ url: `/pages/route/index?selection=${selection}`, fail: failed }); }
    catch (_) { failed(); }
  },
  navigate(event) { this.runAction(event, 'navigate'); },
  call(event) { this.runAction(event, 'call'); },
  copyAddress(event) { this.runAction(event, 'copy'); },
  saveFavorite(event) {
    if (!this.accepts(event) || !this.data.canFavorite || this.data.favoriteSaved) return;
    const result = this.currentResult();
    const generation = this._generation;
    const revision = this._revision;
    const savedRevision = saved.revision();
    wx.showActionSheet({ itemList: ['想去', '常吃'], success: choice => {
      if (!this._active || generation !== this._generation || revision !== this._revision || this.currentResult() !== result ||
        saved.revision() !== savedRevision || ![0, 1].includes(choice.tapIndex)) return;
      this.persist('FAVORITES', choice.tapIndex === 0 ? 'WANT_TO_GO' : 'REGULAR');
    } });
  },
  feedback(event) { if (this.accepts(event)) this.persist('PRIVATE_FEEDBACK', event.currentTarget.dataset.type); },
  async persist(section, choice) {
    const result = this.currentResult();
    if (!result || this.data.saveBusy) return;
    const access = saved.creationView(this._response, result);
    if (access.busy || section === 'FAVORITES' && (!access.canFavorite || access.favoriteSaved) ||
      section === 'PRIVATE_FEEDBACK' && (!access.canFeedback || !access.feedbackTypes.some(item => item.type === choice && !item.submitted))) return;
    const attempt = ++this._saveGeneration;
    const generation = this._generation;
    this.setData({ saveBusy: true, error: '' });
    try {
      if (section === 'FAVORITES') await saved.createFavorite(this._response, result, choice);
      else await saved.createFeedback(this._response, result, choice);
      if (this._active && generation === this._generation && attempt === this._saveGeneration && this.currentResult() === result) {
        wx.showToast({ title: section === 'FAVORITES' ? '已收藏' : '已记录私有反馈', icon: 'success' });
      }
    } catch (error) {
      if (this._active && generation === this._generation && attempt === this._saveGeneration && this.currentResult() === result) {
        this.setData({ error: error.message || '保存未完成，请重试。' });
      }
    } finally { if (this._active && generation === this._generation && attempt === this._saveGeneration) this.render(); }
  },
  openSaved() { if (this.currentResult()) wx.navigateTo({ url: '/pages/saved/index' }); },
  back() {
    if (!this._active) return;
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.redirectTo({ url: '/pages/results/index' });
  },
});
