const decision = require('../../lib/canteen-decision');
const { TIMING } = require('../../lib/decision-motion');
const tasteProfile = require('../../lib/taste-profile');
const canteenAI = require('../../lib/canteen-ai');

Page({
  data: {
    themeClass: '', reducedMotion: false, error: '',
    status: 'idle', cards: [], revision: 0, busy: false,
    decisionLabel: '帮我决定', motionPhase: 'rest',
    decisionSource: '', decisionNote: '',
    motionStyle: `--result-enter:${TIMING.check}ms;--result-exit:${TIMING.reduced}ms;--result-detail:${TIMING.reduced}ms;`,
  },
  onLoad() {
    this._round = null;
    this._revision = 0;
    this._generation = 0;
    this._profileKey = null;
  },
  onShow() {
    this._active = true;
    getApp().syncPage(this);
    wx.hideShareMenu();
    this.syncState();
  },
  onHide() { this.suspend(); },
  onUnload() { this.suspend(); this._round = null; },
  suspend() {
    this._active = false;
    this._generation += 1;
    clearTimeout(this._motionTimer);
    canteenAI.cancel();
    this.setData({ busy: false, motionPhase: 'rest' });
  },
  syncState() {
    if (!this._active || !this.refreshProfile()) return;
    const epoch = getApp().globalData.canteenEpoch || 0;
    if (this._epoch !== undefined && this._epoch !== epoch) {
      this._round.restart();
      this.resetMotion();
    }
    this._epoch = epoch;
    this.render();
  },
  refreshProfile() {
    const profileState = tasteProfile.getState();
    const profile = tasteProfile.getProfile();
    if (!profile) {
      this.resetMotion();
      this._round = null;
      this._profileKey = null;
      this.setData({ cards: [], status: 'profile-required',
        decisionLabel: '帮我决定', revision: ++this._revision });
      getApp().ensureTasteProfile({ returnTo: 'canteen' });
      return false;
    }
    // The menu has no declared spicyLevel or flavorIntensity data. Keep the
    // legacy grouping interface neutral instead of inventing dish attributes.
    const preferences = { likedGroupIds: [], avoidedGroupIds: [] };
    const key = JSON.stringify({ revision: profileState.revision,
      spicyLevel: profile.spicyLevel, flavorIntensity: profile.flavorIntensity });
    if (key !== this._profileKey) {
      this.resetMotion();
      this._round = decision.createRound({ tastePreferences: preferences });
      this._round.configure({}, preferences);
      this._profileKey = key;
      this.setData({ decisionSource: '', decisionNote: '' });
    }
    return true;
  },
  render(animate = false) {
    const state = this._round.snapshot();
    const candidate = state.current;
    const item = candidate?.item;
    // Split only the typography of a complete fixed-price label; keep its
    // original number, currency and suffix. Other price forms stay verbatim.
    const fixedPrice = item?.price.kind === 'fixed' ? /^(\d+(?:\.\d+)?)元(.*)$/.exec(item.originalPriceText) : null;
    const view = {
      revision: ++this._revision,
      status: state.status,
      decisionLabel: state.status === 'empty' ? '暂无可选菜品'
        : item ? state.remainingCount ? '换一个' : '重新决定' : '帮我决定',
      cards: item ? [{
        slot: 'result', id: item.id, name: item.name, stallName: candidate.stall.name,
        priceKind: item.price.kind, originalPriceText: item.originalPriceText,
        priceNumber: fixedPrice ? fixedPrice[1] : '',
        priceSuffix: fixedPrice ? `元${fixedPrice[2]}` : '',
        notes: item.notes.filter(note => !item.originalPriceText.includes(note)),
      }] : [],
    };
    if (!animate || this.data.reducedMotion || !item) {
      this.resetMotion();
      this.setData({ ...view, motionPhase: 'rest' });
      return;
    }
    const generation = this._generation;
    const round = this._round;
    const profileKey = this._profileKey;
    const enter = () => {
      if (!this.motionCurrent(generation, round, profileKey)) return;
      this.setData({ ...view, motionPhase: 'entering' }, () => {
        if (!this.motionCurrent(generation, round, profileKey)) return;
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
    if (!this._active || generation !== this._generation || round !== this._round || profileKey !== this._profileKey) return false;
    if (!this.refreshProfile()) return false;
    if (round !== this._round || profileKey !== this._profileKey) { this.render(); return false; }
    return generation === this._generation;
  },
  accepts(event) {
    if (!this._active || this.data.busy) return false;
    const previousKey = this._profileKey;
    if (!this.refreshProfile()) return false;
    // A new confirmation invalidates gestures from the previous preference round.
    if (previousKey !== this._profileKey) { this.render(); return false; }
    const revision = event?.currentTarget?.dataset?.revision;
    return revision === undefined || Number(revision) === this._revision;
  },
  resetMotion() {
    this._generation += 1;
    clearTimeout(this._motionTimer);
    canteenAI.cancel();
    this.setData({ busy: false, error: '', motionPhase: 'rest' });
  },
  async decide(event) {
    if (!this.accepts(event)) return;
    const before = this._round.snapshot();
    this.resetMotion();
    if (before.current && !before.remainingCount) this._round.restart();
    const generation = this._generation;
    const round = this._round;
    const key = this._profileKey;
    const isCurrent = () => this._active && generation === this._generation && round === this._round && key === this._profileKey;
    this.setData({ busy: true, decisionLabel: '准备决定…' });
    try {
      const preferences = tasteProfile.getProfile();
      const result = await canteenAI.choose({ preferences,
        preferenceRevision: tasteProfile.getState().revision, excludedItemIds: round.snapshot().seenIds,
        isCurrent, onRequest: () => { if (isCurrent()) this.setData({ decisionLabel: 'MiMo选择中…' }); } });
      if (!isCurrent() || !this.refreshProfile() || round !== this._round) return;
      if (result?.selectedItemId) round.choose(result.selectedItemId);
      else round.next();
      this.setData({ decisionSource: result?.source === 'MIMO' ? 'MiMo建议' : '规则推荐',
        decisionNote: result?.source === 'MIMO' ? '基于菜单名称提出建议，菜品辣度与口味轻重尚未核实。'
          : result?.fallbackReason === 'DISABLED' ? 'MiMo服务尚未启用，本次使用规则决定。'
            : result?.fallbackReason === 'SINGLE_CANDIDATE' ? '本轮只剩这一道。'
              : result ? 'MiMo未返回可用建议，本次使用规则决定。' : '本次在本机决定。' });
      this.render(true);
    } catch (error) {
      if (!isCurrent() || error?.code === 'CANCELLED') return;
      if (!this.refreshProfile() || round !== this._round) return;
      round.next();
      this.setData({ decisionSource: '规则推荐', decisionNote: 'MiMo暂不可用，已用本机规则决定。' });
      this.render(true);
    }
  },
});
