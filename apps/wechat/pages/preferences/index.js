const profile = require('../../lib/taste-profile');
const { GROUPS, BUDGET_OPTIONS, SPICY_OPTIONS, PRIORITIES, normalizeAnswers } = require('../../lib/decision/taste-profile');

const FIELDS = ['likedGroups', 'avoidedGroups', 'budgetCents', 'maxSpicy', 'priority'];
const FIELD_LABELS = { likedGroups: '常想吃的类型', avoidedGroups: '避开的类型', budgetCents: '预算', maxSpicy: '辣度', priority: '决定时的取舍' };
const STEP_TITLES = ['常想吃的类型', '避开的类型', '预算与辣度', '决定时更看重'];
const SAFE_ERRORS = new Set([
  '同一种类型不能同时喜欢和避开。',
  '请至少保留一种可选的餐厅类型。',
  '喜欢优先需要至少选择一种喜欢的餐厅类型。',
  '请先完成每一项偏好选择。',
]);
function has(answers, field) { return Object.keys(answers).includes(field); }
function firstStep(answers) {
  if (!has(answers, 'likedGroups')) return 1;
  if (!has(answers, 'avoidedGroups')) return 2;
  if (!has(answers, 'budgetCents') || !has(answers, 'maxSpicy')) return 3;
  return has(answers, 'priority') ? 5 : 4;
}
function stepComplete(answers, step) {
  if (step === 1) return has(answers, 'likedGroups');
  if (step === 2) return has(answers, 'avoidedGroups');
  if (step === 3) return has(answers, 'budgetCents') && has(answers, 'maxSpicy');
  return has(answers, 'priority');
}
function groupSummary(answers, field, none) {
  if (!has(answers, field)) return '尚未选择';
  return answers[field].length ? GROUPS.filter(group => answers[field].includes(group.id)).map(group => group.label).join('、') : none;
}
function optionSummary(answers, field, options) {
  return has(answers, field) ? options.find(option => option.value === answers[field])?.label || '尚未选择' : '尚未选择';
}

Page({
  data: {
    themeClass: 'theme-light', started: false, editing: false, step: 1, revision: 0,
    progressStep: 1, stepTitle: STEP_TITLES[0], coverage: 0, steps: [],
    groups: [], budgets: [], spicyOptions: [], priorities: [], summary: [],
    likedNone: false, avoidedNone: false, canNext: false, ready: false,
    readinessMessage: '', missingSummary: '', busy: false, error: '',
  },
  onLoad(query = {}) {
    this._editRequested = query.edit === '1';
    this._editInitialized = false;
    this._step = null;
    this._generation = 0;
    this._finishing = false;
    this._redirecting = false;
    this._homeTimer = null;
  },
  onShow() {
    this.cancelHomeRedirect();
    this._active = true;
    this._generation += 1;
    this._redirecting = false;
    getApp().syncPage(this);
    try {
      if (this._editRequested && !this._editInitialized) {
        this._editInitialized = true;
        profile.beginEdit();
      }
      this.syncState();
    } catch (error) { this.showError(error); }
    wx.hideShareMenu();
  },
  onHide() { this._active = false; this._generation += 1; this.cancelHomeRedirect(); },
  onUnload() { this._active = false; this._generation += 1; this.cancelHomeRedirect(); },
  cancelHomeRedirect() {
    if (this._homeTimer !== null) clearTimeout(this._homeTimer);
    this._homeTimer = null;
    this._redirecting = false;
  },
  queueHomeRedirect() {
    if (this._redirecting) return;
    this._redirecting = true;
    const generation = this._generation;
    const failed = () => {
      if (!this._active || generation !== this._generation) return;
      this._redirecting = false;
      this.setData({ error: '暂时无法打开首页，请重新进入小程序。' });
    };
    const timer = setTimeout(() => {
      if (this._homeTimer !== timer || !this._active || generation !== this._generation) return;
      this._homeTimer = null;
      let state;
      try { state = profile.getState(); }
      catch (error) { this._redirecting = false; this.showError(error); return; }
      if (!state.ready || state.started || state.editing || this._editRequested) {
        this._redirecting = false;
        this.syncState();
        return;
      }
      try { wx.reLaunch({ url: '/pages/index/index', fail: failed }); }
      catch (_) { failed(); }
    }, 0);
    this._homeTimer = timer;
  },
  syncState() {
    try { this.renderState(); }
    catch (error) { this.showError(error); }
  },
  renderState() {
    if (!this._active) return;
    const state = profile.getState();
    if (state.ready && !state.started && !state.editing && !this._editRequested) {
      this.queueHomeRedirect();
      return;
    }
    this.cancelHomeRedirect();
    const answers = state.answers || {};
    const assessment = profile.assess();
    const started = state.started;
    const step = this._step || firstStep(answers);
    this._step = step;
    const groupField = step === 2 ? 'avoidedGroups' : 'likedGroups';
    this.setData({
      started, editing: !!state.editing, step, revision: state.revision,
      progressStep: Math.min(step, 4), stepTitle: STEP_TITLES[Math.min(step, 4) - 1],
      coverage: FIELDS.filter(field => has(answers, field)).length,
      steps: STEP_TITLES.map((label, index) => ({ label, number: index + 1, complete: stepComplete(answers, index + 1), current: step === index + 1 })),
      groups: GROUPS.map(group => ({ id: group.id, label: group.label, selected: !!answers[groupField]?.includes(group.id) })),
      budgets: BUDGET_OPTIONS.map((option, index) => ({ ...option, index, selected: has(answers, 'budgetCents') && option.value === answers.budgetCents })),
      spicyOptions: SPICY_OPTIONS.map((option, index) => ({ ...option, index, selected: has(answers, 'maxSpicy') && option.value === answers.maxSpicy })),
      priorities: PRIORITIES.map(option => ({ ...option, selected: option.id === answers.priority })),
      likedNone: has(answers, 'likedGroups') && answers.likedGroups.length === 0,
      avoidedNone: has(answers, 'avoidedGroups') && answers.avoidedGroups.length === 0,
      summary: [
        { step: 1, label: '常想吃', value: groupSummary(answers, 'likedGroups', '暂时没有特别偏好') },
        { step: 2, label: '想避开', value: groupSummary(answers, 'avoidedGroups', '没有要避开的类型') },
        { step: 3, label: '日常预算', value: optionSummary(answers, 'budgetCents', BUDGET_OPTIONS) },
        { step: 3, label: '能接受的辣度', value: optionSummary(answers, 'maxSpicy', SPICY_OPTIONS) },
        { step: 4, label: '更看重', value: PRIORITIES.find(option => option.id === answers.priority)?.label || '尚未选择' },
      ],
      canNext: started && stepComplete(answers, step), ready: assessment.ready === true,
      readinessMessage: assessment.message || '', busy: this._finishing,
      missingSummary: assessment.missingFields?.length ? `还需选择：${assessment.missingFields.map(field => FIELD_LABELS[field]).filter(Boolean).join('、')}` : '',
      error: state.error || this.data.error,
    });
  },
  showError(error) {
    if (!this._active) return;
    let message = '暂时无法保存偏好，请重试。';
    if (error?.code === 'INVALID_TASTE_PROFILE' && SAFE_ERRORS.has(error.message)) message = error.message;
    else { try { message = profile.getState().error || message; } catch (_) { /* Keep the fixed local message. */ } }
    this.setData({ error: message });
  },
  current(event) {
    if (!this._active || this._finishing || this._redirecting) return false;
    try {
      const revision = Number(event?.currentTarget?.dataset?.revision);
      if (Number.isInteger(revision) && revision === this.data.revision && revision === profile.getState().revision) return true;
      this.syncState(); this.setData({ error: '偏好已更新，请按当前页面继续。' });
      return false;
    } catch (error) { this.showError(error); return false; }
  },
  start() {
    if (!this._active || this._finishing || this.data.started) return;
    try {
      if (this._editRequested) profile.beginEdit();
      else profile.start();
      this._step = null;
      this.setData({ error: '' });
      this.syncState();
    } catch (error) { this.showError(error); }
  },
  saveAnswer(field, value) {
    try {
      normalizeAnswers({ ...profile.getState().answers, [field]: value });
      profile.answer(field, value, this.data.revision);
      this.setData({ error: '' });
      this.syncState();
    } catch (error) { this.showError(error); }
  },
  toggleGroup(event) {
    if (!this.current(event) || !this.data.started || ![1, 2].includes(this.data.step)) return;
    const id = event.currentTarget.dataset.id;
    if (!GROUPS.some(group => group.id === id)) return;
    const field = this.data.step === 1 ? 'likedGroups' : 'avoidedGroups';
    const otherField = field === 'likedGroups' ? 'avoidedGroups' : 'likedGroups';
    const answers = profile.getState().answers;
    if (answers[otherField]?.includes(id)) {
      this.setData({ error: field === 'likedGroups' ? '这个类型已选为避开，请到“避开的类型”中先修改。' : '这个类型已选为常想吃，请返回上一步修改。' });
      return;
    }
    const selected = answers[field] || [];
    this.saveAnswer(field, selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]);
  },
  chooseNone(event) {
    if (!this.current(event) || !this.data.started || ![1, 2].includes(this.data.step)) return;
    this.saveAnswer(this.data.step === 1 ? 'likedGroups' : 'avoidedGroups', []);
  },
  selectOption(event) {
    if (!this.current(event) || !this.data.started || this.data.step !== 3) return;
    const { field, index: rawIndex } = event.currentTarget.dataset;
    const options = field === 'budgetCents' ? BUDGET_OPTIONS : field === 'maxSpicy' ? SPICY_OPTIONS : null;
    const index = Number(rawIndex);
    if (!options || !Number.isInteger(index) || !options[index]) return;
    this.saveAnswer(field, options[index].value);
  },
  selectPriority(event) {
    if (!this.current(event) || !this.data.started || this.data.step !== 4) return;
    const id = event.currentTarget.dataset.id;
    if (!PRIORITIES.some(option => option.id === id)) return;
    this.saveAnswer('priority', id);
  },
  next(event) {
    if (!this.current(event) || !this.data.started || !this.data.canNext || this.data.step >= 5) return;
    this._step = this.data.step + 1;
    this.setData({ error: '' });
    this.syncState();
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  previous(event) {
    if (!this.current(event) || !this.data.started || this.data.step <= 1) return;
    this._step = this.data.step - 1;
    this.setData({ error: '' });
    this.syncState();
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  editStep(event) {
    if (!this.current(event) || !this.data.started) return;
    const step = Number(event.currentTarget.dataset.step);
    if (!Number.isInteger(step) || step < 1 || step > 4) return;
    this._step = step;
    this.setData({ error: '' });
    this.syncState();
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  async finish(event) {
    if (!this.current(event) || !this.data.started || this.data.step !== 5) return;
    try {
      if (!profile.assess().ready) { this.syncState(); return; }
      this._finishing = true;
      const generation = this._generation;
      this.setData({ busy: true, error: '' });
      try { await getApp().completeTasteProfile(this.data.revision); }
      catch (error) { if (this._active && generation === this._generation) this.showError(error); }
      finally {
        this._finishing = false;
        if (this._active && generation === this._generation) this.setData({ busy: false });
      }
    } catch (error) { this.showError(error); }
  },
  privacy() { if (this._active && !this._finishing) wx.navigateTo({ url: '/pages/privacy/index' }); },
});
