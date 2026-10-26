const decision = require('../../lib/canteen-decision');
const { TIMING } = require('../../lib/decision-motion');
const tasteProfile = require('../../lib/taste-profile');
const canteenAI = require('../../lib/canteen-ai');
const service = require('../../lib/service');
const account = require('../../lib/account');
const ratings = require('../../lib/canteen-ratings');
const dishAttributes = require('../../lib/canteen-attributes');
const canteenSession = require('../../lib/canteen-session');
const STALL_OPTIONS = [{ id: '', name: '全部档口' }, ...decision.getStalls()];
const DISH_FILTER_ROWS = [{ key: 'stapleType', label: '主食类型' },
  { key: 'hasSoup', label: '是否带汤' }, { key: 'temperature', label: '温度' }]
  .map(field => ({ ...field, options: dishAttributes.FILTER_OPTIONS[field.key], index: 0 }));

Page({
  data: {
    themeClass: '', reducedMotion: false, error: '',
    status: 'idle', cards: [], revision: 0, busy: false,
    decisionLabel: '帮我决定', motionPhase: 'rest',
    decisionSource: '', decisionNote: '',
    stallOptions: STALL_OPTIONS, stallIndex: 0, fixedStall: false,
    dishFilterRows: DISH_FILTER_ROWS, filtersExpanded: false, poolCount: 0,
    ratingStatus: 'idle', ratingCount: 0, averageScore: '', myScore: null,
    draftScore: 0, ratingBusy: false, ratingError: '', ratingNotice: '', signedIn: false,
    stars: [1, 2, 3, 4, 5],
    motionStyle: `--result-enter:${TIMING.check}ms;--result-exit:${TIMING.reduced}ms;--result-detail:${TIMING.reduced}ms;`,
  },
  onLoad() {
    this._round = null;
    this._revision = 0;
    this._generation = 0;
    this._profileKey = null;
    this._sessionLease = null;
    this._stallId = null;
    this._dishFilters = { stapleType: null, hasSoup: null, temperature: null };
    this._ratingRequest = 0;
    this._ratingScope = '';
    this._ratingNavigation = 0;
  },
  onShow() {
    this._active = true;
    getApp().syncPage(this);
    wx.hideShareMenu();
    this.syncState(true);
  },
  onHide() { this.suspend(); },
  onUnload() { this.suspend(); this._round = null; },
  suspend() {
    const ownsSession = canteenSession.owns(this._sessionLease);
    this._active = false;
    this._generation += 1;
    clearTimeout(this._motionTimer);
    if (ownsSession) canteenAI.cancel();
    this.clearRating();
    canteenSession.release(this._sessionLease);
    this._sessionLease = null;
    this.setData({ busy: false, motionPhase: 'rest' });
  },
  syncState(claimSession = false) {
    if (!this._active || !this.refreshProfile(claimSession)) return;
    this.render();
  },
  refreshProfile(claimSession = false) {
    if (!this._active) return false;
    const profileState = tasteProfile.getState();
    const profile = tasteProfile.getProfile();
    if (!profile) {
      this.resetMotion();
      this.clearRating();
      canteenSession.clear();
      this._round = null;
      this._profileKey = null;
      this._sessionLease = null;
      this._stallId = null;
      this._dishFilters = { stapleType: null, hasSoup: null, temperature: null };
      this.setData({ cards: [], status: 'profile-required',
        decisionLabel: '帮我决定', revision: ++this._revision,
        stallIndex: 0, fixedStall: false, dishFilterRows: DISH_FILTER_ROWS, filtersExpanded: false,
        decisionSource: '', decisionNote: '' });
      getApp().ensureTasteProfile({ returnTo: 'canteen' });
      return false;
    }
    // Taste ranks typical-recipe references; explicit dish filters stay strict.
    const preferences = { likedGroupIds: [], avoidedGroupIds: [],
      spicyLevel: profile.spicyLevel, flavorIntensity: profile.flavorIntensity };
    const key = JSON.stringify({ revision: profileState.revision,
      spicyLevel: profile.spicyLevel, flavorIntensity: profile.flavorIntensity });
    const epoch = getApp().globalData.canteenEpoch || 0;
    // Only onShow may claim a round owned/released by another page. A late
    // event on an older page cannot take ownership back from the visible page.
    if (!claimSession && !canteenSession.owns(this._sessionLease)) return false;
    if (claimSession || key !== this._profileKey || epoch !== this._epoch) {
      const session = canteenSession.claim(key, epoch, selection => {
        const round = decision.createRound({ tastePreferences: preferences });
        round.configure({ ...selection.dishFilters, stallId: selection.stallId }, preferences);
        return round;
      });
      this._sessionLease = session.lease;
      this._round = session.round;
      this._profileKey = session.profileKey;
      this._epoch = session.epoch;
      this._stallId = session.stallId;
      this._dishFilters = session.dishFilters;
      this.resetMotion();
      this.clearRating();
      this.setData({
        stallIndex: Math.max(0, STALL_OPTIONS.findIndex(option => (option.id || null) === this._stallId)),
        fixedStall: Boolean(this._stallId),
        filtersExpanded: !this._stallId && this.data.filtersExpanded,
        dishFilterRows: DISH_FILTER_ROWS.map(row => ({ ...row,
          index: Math.max(0, row.options.findIndex(option => option.value === this._dishFilters[row.key])) })),
        decisionSource: session.decisionSource, decisionNote: session.decisionNote,
      });
    }
    return true;
  },
  ownsSession() {
    return canteenSession.current(this._sessionLease, this._round, this._profileKey, this._epoch) &&
      this._epoch === (getApp().globalData.canteenEpoch || 0);
  },
  replaceRound(round, filters, stallId = this._stallId) {
    if (!this.ownsSession() || !canteenSession.replace(this._sessionLease, this._round, round, stallId, filters)) return false;
    this._round = round;
    this._stallId = stallId;
    this._dishFilters = { ...filters };
    return true;
  },
  setDecisionSource(source, note) {
    if (!this.ownsSession() || !canteenSession.setSource(this._sessionLease, this._round, source, note)) return;
    this.setData({ decisionSource: source, decisionNote: note });
  },
  changeStall(event) {
    if (!this._active || Number(event?.currentTarget?.dataset?.revision) !== this._revision) return;
    const previousKey = this._profileKey;
    const previousRound = this._round;
    if (!this.refreshProfile()) return;
    if (previousKey !== this._profileKey || previousRound !== this._round) { this.render(); return; }
    const value = event?.detail?.value;
    if (!/^(0|[1-9][0-9]*)$/.test(String(value))) return;
    const index = Number(value);
    const selected = STALL_OPTIONS[index];
    if (!selected || (selected.id || null) === this._stallId) return;
    const filters = { stapleType: null, hasSoup: null, temperature: null };
    const round = this.configuredRound(filters, selected.id || null);
    if (!round) return;
    this.resetMotion();
    this.clearRating();
    if (!this.replaceRound(round, filters, selected.id || null)) return;
    this.setData({ stallIndex: index, fixedStall: Boolean(this._stallId),
      dishFilterRows: DISH_FILTER_ROWS, filtersExpanded: false, decisionSource: '', decisionNote: '' });
    this.render();
  },
  configuredRound(filters, stallId = this._stallId) {
    const profile = tasteProfile.getProfile();
    if (!profile) { this.refreshProfile(); return null; }
    const preferences = { likedGroupIds: [], avoidedGroupIds: [],
      spicyLevel: profile.spicyLevel, flavorIntensity: profile.flavorIntensity };
    const round = decision.createRound({ tastePreferences: preferences });
    round.configure({ ...filters, stallId }, preferences);
    return round;
  },
  toggleDishFilters() {
    if (this._active && !this._stallId && this.ownsSession()) this.setData({ filtersExpanded: !this.data.filtersExpanded });
  },
  changeDishFilter(event) {
    if (!this._active || this._stallId || Number(event?.currentTarget?.dataset?.revision) !== this._revision) return;
    const keyBefore = this._profileKey;
    const roundBefore = this._round;
    if (!this.refreshProfile()) return;
    if (keyBefore !== this._profileKey || roundBefore !== this._round) { this.render(); return; }
    const field = event.currentTarget.dataset.field;
    if (!Object.keys(dishAttributes.FILTER_OPTIONS).includes(field) ||
      !/^(0|[1-9][0-9]*)$/.test(String(event?.detail?.value))) return;
    const index = Number(event.detail.value);
    const option = dishAttributes.FILTER_OPTIONS[field][index];
    if (!option || this._dishFilters[field] === option.value) return;
    const filters = { ...this._dishFilters, [field]: option.value };
    const round = this.configuredRound(filters);
    if (!round) return;
    this.resetMotion();
    this.clearRating();
    if (!this.replaceRound(round, filters)) return;
    this.setData({ dishFilterRows: this.data.dishFilterRows.map(row => row.key === field ? { ...row, index } : row),
      decisionSource: '', decisionNote: '' });
    this.render();
  },
  clearDishFilters(event) {
    if (!this._active || this._stallId || Number(event?.currentTarget?.dataset?.revision) !== this._revision) return;
    const keyBefore = this._profileKey;
    const roundBefore = this._round;
    if (!this.refreshProfile()) return;
    if (keyBefore !== this._profileKey || roundBefore !== this._round) { this.render(); return; }
    if (Object.values(this._dishFilters).every(value => value === null)) return;
    const filters = { stapleType: null, hasSoup: null, temperature: null };
    const round = this.configuredRound(filters);
    if (!round) return;
    this.resetMotion();
    this.clearRating();
    if (!this.replaceRound(round, filters)) return;
    this.setData({ dishFilterRows: DISH_FILTER_ROWS, decisionSource: '', decisionNote: '' });
    this.render();
  },
  render(animate = false) {
    if (!this._active || !this.ownsSession()) return;
    const state = this._round.snapshot();
    const candidate = state.current;
    const item = candidate?.item;
    // Split only the typography of a complete fixed-price label; keep its
    // original number, currency and suffix. Other price forms stay verbatim.
    const fixedPrice = item?.price.kind === 'fixed' ? /^(\d+(?:\.\d+)?)元(.*)$/.exec(item.originalPriceText) : null;
    const view = {
      revision: ++this._revision,
      status: state.status,
      poolCount: state.totalCount,
      decisionLabel: state.status === 'empty' ? '暂无可选菜品'
        : item ? state.remainingCount ? '换一道' : this._stallId ? '重新随机' : '重新决定'
          : this._stallId ? '随机一道菜' : '帮我决定',
      cards: item ? [{
        slot: 'result', id: item.id, name: item.name, stallName: candidate.stall.name,
        category: item.category || '', attributeLabels: dishAttributes.labels(item.id),
        priceKind: item.price.kind, originalPriceText: item.originalPriceText,
        priceNumber: fixedPrice ? fixedPrice[1] : '',
        priceSuffix: fixedPrice ? `元${fixedPrice[2]}` : '',
        notes: item.notes.filter(note => !item.originalPriceText.includes(note)),
      }] : [],
    };
    if (!animate || this.data.reducedMotion || !item) {
      this.resetMotion();
      const lease = this._sessionLease;
      const round = this._round;
      this.setData({ ...view, motionPhase: 'rest' }, () => {
        if (this._active && this.ownsSession() && lease === this._sessionLease &&
          round === this._round && view.revision === this._revision) this.loadRating();
      });
      return;
    }
    const generation = this._generation;
    const round = this._round;
    const profileKey = this._profileKey;
    const enter = () => {
      if (!this.motionCurrent(generation, round, profileKey)) return;
      this.setData({ ...view, motionPhase: 'entering' }, () => {
        if (!this.motionCurrent(generation, round, profileKey)) return;
        this.loadRating();
        this._motionTimer = setTimeout(() => {
          if (!this.motionCurrent(generation, round, profileKey)) return;
          this.setData({ motionPhase: 'rest' });
          this._motionTimer = setTimeout(() => {
            if (this.motionCurrent(generation, round, profileKey)) this.setData({ busy: false });
          }, TIMING.check);
        }, TIMING.frame);
      });
    };
    this.setData({ busy: true });
    if (this.data.cards.length) {
      this.setData({ motionPhase: 'leaving' });
      this._motionTimer = setTimeout(enter, TIMING.reduced);
    } else enter();
  },
  motionCurrent(generation, round, profileKey) {
    if (!this._active || !this.ownsSession() || generation !== this._generation || round !== this._round || profileKey !== this._profileKey) return false;
    if (!this.refreshProfile()) return false;
    if (round !== this._round || profileKey !== this._profileKey) { this.render(); return false; }
    return generation === this._generation;
  },
  accepts(event) {
    if (!this._active || this.data.busy || !canteenSession.owns(this._sessionLease)) return false;
    const previousKey = this._profileKey;
    const previousRound = this._round;
    if (!this.refreshProfile()) return false;
    // A new confirmation invalidates gestures from the previous preference round.
    if (previousKey !== this._profileKey || previousRound !== this._round) { this.render(); return false; }
    const revision = event?.currentTarget?.dataset?.revision;
    return revision === undefined || Number(revision) === this._revision;
  },
  resetMotion() {
    this._generation += 1;
    clearTimeout(this._motionTimer);
    if (canteenSession.owns(this._sessionLease)) canteenAI.cancel();
    this.setData({ busy: false, error: '', motionPhase: 'rest' });
  },
  async decide(event) {
    if (!this.accepts(event)) return;
    const before = this._round.snapshot();
    if (!before.totalCount) { this.render(); return; }
    this.resetMotion();
    this.clearRating();
    if (before.current && !before.remainingCount) {
      this._round.restart();
      this.setDecisionSource('', '');
    }
    if (this._stallId) {
      this._round.next();
      this.setDecisionSource('档口内随机', '固定档口内优先换主食类型，本轮不重复菜品。');
      this.render(true);
      return;
    }
    const generation = this._generation;
    const round = this._round;
    const key = this._profileKey;
    const lease = this._sessionLease;
    const isCurrent = () => this._active && this.ownsSession() && lease === this._sessionLease &&
      generation === this._generation && round === this._round && key === this._profileKey;
    this.setData({ busy: true, decisionLabel: '准备决定…' });
    try {
      const preferences = tasteProfile.getProfile();
      const result = await canteenAI.choose({ preferences,
        preferenceRevision: tasteProfile.getState().revision, excludedItemIds: round.getRequestExcludedIds(),
        isCurrent, onRequest: () => { if (isCurrent()) this.setData({ decisionLabel: 'MiMo选择中…' }); } });
      if (!isCurrent() || !this.refreshProfile() || round !== this._round) return;
      if (result?.selectedItemId) round.choose(result.selectedItemId);
      else round.next();
      this.setDecisionSource(result?.source === 'MIMO' ? 'MiMo建议' : '规则推荐',
        result?.source === 'MIMO' ? '参考常见做法与口味偏好，在本轮候选中选择。'
          : result?.fallbackReason === 'DISABLED' ? 'MiMo服务尚未启用，本次使用规则决定。'
            : result?.fallbackReason === 'SINGLE_CANDIDATE' ? '按当前条件优先选这道。'
              : result ? 'MiMo未返回可用建议，本次使用规则决定。' : '本次在本机决定。');
      this.render(true);
    } catch (error) {
      if (!isCurrent() || error?.code === 'CANCELLED') return;
      if (!this.refreshProfile() || round !== this._round) return;
      round.next();
      this.setDecisionSource('规则推荐', 'MiMo暂不可用，已用本机规则决定。');
      this.render(true);
    }
  },
  clearRating() {
    this._ratingRequest += 1;
    this._ratingNavigation += 1;
    this._ratingScope = '';
    if (canteenSession.owns(this._sessionLease)) ratings.cancel();
    this.setData({ ratingStatus: 'idle', ratingCount: 0, averageScore: '', myScore: null,
      draftScore: 0, ratingBusy: false, ratingError: '', ratingNotice: '', signedIn: false });
  },
  ratingCurrent(context) {
    return this._active && this.ownsSession() && context.sessionLease === this._sessionLease && context.request === this._ratingRequest &&
      context.itemId === this._round?.snapshot().current?.item.id &&
      context.itemId === this.data.cards[0]?.id && context.epoch === service.state.epoch &&
      context.authenticationRevision === account.view().authenticationRevision && service.state.consent;
  },
  async loadRating(force = false) {
    if (!this._active || !this.ownsSession()) return;
    const itemId = this._round?.snapshot().current?.item.id;
    if (!itemId || this.data.cards[0]?.id !== itemId) return;
    const auth = account.view();
    const scope = `${itemId}:${service.state.epoch}:${auth.authenticationRevision}:${service.state.consent}`;
    if (!force && scope === this._ratingScope) return;
    this._ratingScope = scope;
    const context = { itemId, sessionLease: this._sessionLease, request: ++this._ratingRequest, epoch: service.state.epoch,
      authenticationRevision: auth.authenticationRevision };
    ratings.cancel();
    this.setData({ signedIn: auth.signedIn, ratingBusy: false, ratingError: '', ratingNotice: '',
      myScore: null, draftScore: 0, ratingCount: 0, averageScore: '',
      ratingStatus: service.state.consent ? 'loading' : 'privacy' });
    if (!service.state.consent) return;
    try {
      const summary = await ratings.read(itemId);
      if (!this.ratingCurrent(context)) {
        if (this._active && context.request === this._ratingRequest) this.loadRating(true);
        return;
      }
      this.showRating(summary);
    } catch (_) {
      if (!this.ratingCurrent(context)) {
        if (this._active && context.request === this._ratingRequest) this.loadRating(true);
        return;
      }
      this.setData({ ratingStatus: 'error', ratingError: '公共评分暂未加载，请重试。' });
    }
  },
  showRating(summary, notice = '') {
    this.setData({ ratingStatus: 'ready', ratingCount: summary.ratingCount,
      averageScore: summary.averageScore === null ? '' : summary.averageScore.toFixed(1),
      myScore: summary.myScore, draftScore: summary.myScore || 0,
      ratingBusy: false, ratingError: '', ratingNotice: notice });
  },
  acceptsRating(event) {
    if (!this.accepts(event) || this.data.ratingBusy ||
      Number(event?.currentTarget?.dataset?.revision) !== this._revision ||
      event?.currentTarget?.dataset?.itemId !== this._round?.snapshot().current?.item.id) return false;
    const auth = account.view();
    const scope = `${this.data.cards[0]?.id}:${service.state.epoch}:${auth.authenticationRevision}:${service.state.consent}`;
    if (!service.state.consent || scope !== this._ratingScope) { this.loadRating(true); return false; }
    return true;
  },
  selectRating(event) {
    if (!this.acceptsRating(event) || !account.view().signedIn) return;
    const score = Number(event.currentTarget.dataset.score);
    if (!Number.isInteger(score) || score < 1 || score > 5) return;
    this.setData({ draftScore: score, ratingNotice: '', ratingError: '' });
  },
  async saveRating(event) { return this.mutateRating(event, false); },
  async removeRating(event) { return this.mutateRating(event, true); },
  async mutateRating(event, remove) {
    if (!this.acceptsRating(event) || !account.view().signedIn || this.data.ratingStatus !== 'ready') return;
    const score = this.data.draftScore;
    if (remove ? this.data.myScore === null : !Number.isInteger(score) || score < 1 || score > 5) return;
    if (!remove && score === this.data.myScore) return;
    const context = { itemId: this.data.cards[0].id, sessionLease: this._sessionLease, request: ++this._ratingRequest,
      epoch: service.state.epoch, authenticationRevision: account.view().authenticationRevision };
    this.setData({ ratingBusy: true, ratingError: '', ratingNotice: '' });
    try {
      const summary = await (remove ? ratings.remove(context.itemId) : ratings.rate(context.itemId, score));
      if (!this.ratingCurrent(context)) {
        if (this._active && context.request === this._ratingRequest) this.loadRating(true);
        return;
      }
      this.showRating(summary, remove ? '已撤回评分' : '评分已提交');
    } catch (_) {
      if (!this.ratingCurrent(context)) {
        if (this._active && context.request === this._ratingRequest) this.loadRating(true);
        return;
      }
      this.setData({ ratingBusy: false, ratingStatus: 'error', ratingError: '提交结果尚未确认，请刷新评分后重试。' });
    }
  },
  retryRating(event) {
    if (!this.accepts(event) || this.data.ratingBusy || Number(event?.currentTarget?.dataset?.revision) !== this._revision) return;
    return this.loadRating(true);
  },
  async openRatingAccount(event) {
    if (!this.acceptsRating(event)) return;
    const navigation = ++this._ratingNavigation;
    if (service.state.status !== 'ready') {
      try { await getApp().checkService(); } catch (_) { /* Show the actual connection state. */ }
      if (!this._active || !this.ownsSession() || navigation !== this._ratingNavigation || !service.state.consent) return;
    }
    if (service.state.status !== 'ready') {
      this.setData({ ratingError: '账号服务暂未连接，请稍后重试。' });
      return;
    }
    wx.navigateTo({ url: '/pages/account/index' });
  },
  openRatingPrivacy() {
    if (this._active && this.ownsSession()) wx.navigateTo({ url: '/pages/privacy/index' });
  },
  async acceptRatingPrivacy() {
    if (!this._active || !this.ownsSession() || this.data.ratingStatus !== 'privacy' || this.data.busy || this.data.ratingBusy) return;
    const navigation = ++this._ratingNavigation;
    this.setData({ ratingBusy: true, ratingError: '' });
    try { await getApp().acceptConsent(); }
    catch (_) {
      if (this._active && this.ownsSession() && navigation === this._ratingNavigation) {
        this.setData({ ratingBusy: false, ratingError: '隐私选择未保存，请重试。' });
      }
      return;
    }
    if (!this._active || !this.ownsSession() || navigation !== this._ratingNavigation) return;
    this.setData({ ratingBusy: false });
    return this.loadRating(true);
  },
});
