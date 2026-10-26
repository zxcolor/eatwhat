const service = require('../../lib/service');
const tasteProfile = require('../../lib/taste-profile');
const takeout = require('../../lib/takeout');
const { createImageProcessor } = require('../../lib/takeout-images');
const { createRound } = require('../../lib/takeout-round');
const { validPreferences } = require('../../lib/takeout-contract');
const imageCleanup = require('../../lib/takeout-cleanup');
const sourceNotes = {
  SINGLE_CANDIDATE: '当前只剩这一个已确认候选。',
  CAPACITY: 'MiMo暂忙，本次由服务器在合法剩余候选中随机选择。',
  UNAVAILABLE: 'MiMo暂不可用，本次由服务器在合法剩余候选中随机选择。',
  INVALID_MODEL_RESULT: 'MiMo未返回可用选择，本次使用服务器规则。',
};
Page({
  data: { themeClass: '', reducedMotion: false, phase: 'empty', busy: false, statusText: '', error: '', notice: '',
    globalConsent: false, uploadConsent: false, previews: [], candidates: [], result: null,
    resultSource: '', resultNote: '', keptCount: 0, remainingCount: 0, seenCount: 0, revision: 0,
    canRecognize: false, canDecide: false, canRestart: false, decisionLabel: '确认候选，帮我选',
    showPlatformPrivacy: false, privacyName: '小程序用户隐私保护指引', serviceReady: false, serviceStatus: 'idle', cleanupNeeded: false },
  onLoad() {
    this._active = false; this._disposed = false; this._visit = 1; this._work = 0; this._nativeSequence = 0;
    this._sources = []; this._tiles = []; this._payload = null; this._nativeOperation = null;
    this._round = createRound();
    this._processor = createImageProcessor({ component: this, getCanvas: () => this.getCanvas(), onCleanupFailure: () => this.reportCleanupFailure() });
    this._unsubscribe = takeout.subscribe(kind => this.stopped(kind));
  },
  async onShow() {
    this._active = true;
    getApp().syncPage(this); wx.hideShareMenu();
    if (!getApp().ensureTasteProfile()) { this.clearContent(); return; }
    this.syncState();
    // Begin reconnection before a native return resumes image inspection;
    // local preparation must not prevent the capability refresh it needs.
    const reconnect = service.state.consent && !['ready', 'loading'].includes(service.state.status) ? this.retryService(true) : null;
    this.resumeNative(true);
    if (reconnect) await reconnect;
  },
  onHide() {
    this._active = false;
    if (this._nativeOperation) this._nativeOperation.hidden = true;
    takeout.cancel();
    // A native editor/preview belongs to this visit. Other background visits
    // retain only the preview files, not a receipt or a prior selection.
    if (!this._nativeOperation) this.resetCatalog();
  },
  onUnload() {
    this._disposed = true; this._active = false; this._visit += 1; this._nativeSequence += 1;
    this._nativeOperation = null; this._unsubscribe?.(); takeout.cancel();
    this.releasePayload(); clearTimeout(this._expiryTimer); this._round.clear();
    this._sources = []; this._tiles = [];
    this.setData({ previews: [], candidates: [], result: null, uploadConsent: false, busy: false, showPlatformPrivacy: false });
    this.cleanup(this._processor.dispose());
  },
  cleanup(promise) {
    Promise.resolve(promise).then(results => {
      if (Array.isArray(results) && results.some(value => value === false)) this.reportCleanupFailure();
    }, () => this.reportCleanupFailure());
  },
  reportCleanupFailure() {
    const message = imageCleanup.CLEANUP_MESSAGE;
    try {
      const app = getApp();
      if (app.globalData) {
        const previous = typeof app.globalData.localDataError === 'string' ? app.globalData.localDataError : '';
        if (!previous.includes(message)) app.globalData.localDataError = previous ? `${previous}；${message}` : message;
      }
    } catch (_) { /* No native/private error text is exposed. */ }
    if (this._active) this.setData({ notice: message, cleanupNeeded: true });
  },
  async retryCleanup() {
    if (!this._active || this.data.busy) return;
    try {
      await takeout.clear();
      try {
        const data = getApp().globalData;
        if (data && typeof data.localDataError === 'string') data.localDataError = data.localDataError.split(imageCleanup.CLEANUP_MESSAGE).join('').replace(/^；|；$/g, '');
      } catch (_) { /* Only this feature's fixed notice may be removed. */ }
      if (this._active) this.setData({ notice: '本次截图信息与已登记临时副本已清理。', cleanupNeeded: false });
    } catch (_) { this.reportCleanupFailure(); }
    if (this._active) this.render();
  },
  releasePayload() {
    if (this._payload) { this._payload.forEach(image => { image.base64 = ''; }); this._payload.length = 0; }
    this._payload = null;
  },
  stopped(kind) {
    this._work += 1; this._processor?.cancel(); this.releasePayload();
    if (kind === 'clear') { this.clearContent(); return; }
    if (!this._disposed) this.setData({ busy: false, statusText: '' });
  },
  clearContent() {
    this._work += 1; this._nativeSequence += 1; this._nativeOperation = null;
    this.releasePayload(); clearTimeout(this._expiryTimer); this._round?.clear();
    this._sources = []; this._tiles = [];
    this.cleanup(this._processor?.clear());
    if (!this._disposed) this.setData({ phase: 'empty', previews: [], candidates: [], result: null,
      resultSource: '', resultNote: '', uploadConsent: false, busy: false, statusText: '', error: '', notice: '',
      canRecognize: false, canDecide: false, canRestart: false, keptCount: 0, remainingCount: 0,
      seenCount: 0, showPlatformPrivacy: false, revision: this.data.revision + 1 });
  },
  resetCatalog() {
    clearTimeout(this._expiryTimer); this._round.clear();
    const paths = this._tiles.map(tile => tile.path); this._tiles = [];
    this.cleanup(this._processor.release(paths));
    if (!this._disposed) this.setData({ candidates: [], result: null, resultSource: '', resultNote: '',
      keptCount: 0, remainingCount: 0, seenCount: 0, canDecide: false, canRestart: false });
  },
  current(job) { return this._active && !this._disposed && job.visit === this._visit && job.work === this._work; },
  beginWork(phase, statusText) {
    takeout.cancel(); this._work += 1;
    this.setData({ phase, busy: true, statusText, error: '', notice: '', canRecognize: false, canDecide: false, canRestart: false });
    return { visit: this._visit, work: this._work };
  },
  showFailure(error) {
    if (!this._active || error?.code === 'CANCELLED') return;
    const safeCodes = ['INVALID_INPUT', 'INVALID_IMAGE', 'IMAGE_TOO_LARGE', 'TOO_MANY_TILES', 'IMAGE_ORIENTATION',
      'IMAGE_PROCESSING', 'CLEANUP_REQUIRED', 'BUSY', 'NETWORK', 'CAPACITY', 'UNAVAILABLE', 'INVALID_RESPONSE', 'CONSENT_REQUIRED', 'RECEIPT_EXPIRED'];
    if (error?.code === 'CLEANUP_REQUIRED') this.setData({ cleanupNeeded: true });
    this.setData({ error: safeCodes.includes(error?.code) ? error.message : '本次处理未完成，请重新选择截图后重试。' });
  },
  syncState() {
    if (!this._active || this._disposed) return;
    if (!service.state.consent && this._round.snapshot().ready) this.clearContent();
    if (['recognizing', 'choosing'].includes(this.data.phase) && !this.serviceReady()) takeout.cancel();
    this.render();
  },
  serviceReady() { return service.state.consent && service.state.status === 'ready' && service.state.config?.serviceCapabilities?.takeoutScreenshotsEnabled === true; },
  render() {
    if (this._disposed) return;
    const state = this._round.snapshot();
    const source = state.current?.source;
    const phase = this.data.busy ? this.data.phase : state.current ? 'result' : state.ready ? 'review'
      : this._sources.length ? 'preview' : 'empty';
    const idle = !this.data.busy && !this._nativeOperation;
    const cleanupState = imageCleanup.state();
    this.setData({ phase, globalConsent: service.state.consent === true, serviceReady: Boolean(this.serviceReady()), serviceStatus: service.state.status,
      previews: this._sources.map((item, index) => ({ path: item.path, label: `截图 ${index + 1}`, dimensions: `${item.width} × ${item.height}` })),
      candidates: state.candidates, result: state.current, keptCount: state.keptCount,
      remainingCount: state.remainingCount, seenCount: state.seenCount, revision: this.data.revision + 1,
      resultSource: source === 'MIMO' ? 'MiMo建议' : source === 'LOCAL' ? '规则选择' : '',
      resultNote: source === 'MIMO' ? '根据你确认的候选与口味偏好建议；图片文字仍请自行核对。'
        : state.current ? sourceNotes[state.current.fallbackReason] || '本次使用服务器规则选择。' : '',
      canRecognize: idle && this._sources.length > 0 && this.serviceReady() && this.data.uploadConsent,
      canDecide: idle && state.ready && state.remainingCount > 0 && this.serviceReady() && this.data.uploadConsent,
      canRestart: idle && state.ready && state.keptCount > 0 && state.remainingCount === 0,
      decisionLabel: state.seenCount ? '换一个' : '确认候选，帮我选',
      cleanupNeeded: cleanupState.failed > 0 || cleanupState.capacityReached || this.data.cleanupNeeded,
      ...(state.expiryHint ? { notice: '本次识别已接近有效期；能否继续选择以服务器校验结果为准。' } : {}),
    });
  },
  getCanvas() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(takeout.failure('IMAGE_PROCESSING', '图片画布未准备好，请重试。')), 5000);
      try {
        this.createSelectorQuery().select('#takeout-processing-canvas').fields({ node: true, size: true }).exec(results => {
          clearTimeout(timer);
          if (this._disposed || !results?.[0]?.node) reject(takeout.failure('IMAGE_PROCESSING', '当前微信不能处理截图，请更新微信后重试。'));
          else resolve(results[0].node);
        });
      } catch (_) { clearTimeout(timer); reject(takeout.failure('IMAGE_PROCESSING', '当前微信不能处理截图，请更新微信后重试。')); }
    });
  },
  releasePreviewLease() {
    if (this._nativeOperation?.completed && ['preview', 'privacy'].includes(this._nativeOperation.kind)) this._nativeOperation = null;
  },
  startNative(kind, start, apply, protectedPath, reservation) {
    this.releasePreviewLease();
    if (!this._active || this._nativeOperation || this.data.busy) return;
    const operation = { id: ++this._nativeSequence, visit: this._visit, kind, apply, protectedPath, reservation,
      hidden: false, completed: false, result: null, error: null };
    this._nativeOperation = operation;
    if (!['preview', 'privacy'].includes(kind)) this.setData({ busy: true, phase: kind === 'choose' ? 'selecting' : 'editing', statusText: '', canRecognize: false, canDecide: false, canRestart: false });
    const valid = () => !this._disposed && this._nativeOperation === operation && operation.visit === this._visit && operation.id === this._nativeSequence;
    try {
      start({ success: result => {
        if (kind === 'edit') {
          try {
            if (result?.tempFilePath !== protectedPath && !this._processor.registerEdited(result?.tempFilePath, protectedPath, reservation)) throw takeout.failure('INVALID_IMAGE', '未取得编辑后的图片。');
            if (result?.tempFilePath === protectedPath) this._processor.abandonGenerated(reservation);
          } catch (error) {
            this._processor.abandonGenerated(reservation);
            if (valid()) { operation.completed = true; operation.error = error; this.resumeNative(false); }
            return;
          }
        }
        if (!valid()) {
          if (kind === 'edit') this.cleanup(this._processor.release([result?.tempFilePath]));
          return;
        }
        operation.completed = true; operation.result = result; this.resumeNative(false);
      }, fail: error => {
        if (kind === 'edit') this._processor.abandonGenerated(reservation);
        if (!valid()) return;
        operation.completed = true;
        operation.error = /cancel/i.test(error?.errMsg || '') ? takeout.failure('CANCELLED', '已取消。')
          : takeout.failure('IMAGE_PROCESSING', '未能打开图片，请重试或更新微信。');
        this.resumeNative(false);
      } });
    } catch (_) {
      if (kind === 'edit') this._processor.abandonGenerated(reservation);
      operation.completed = true; operation.error = takeout.failure('IMAGE_PROCESSING', '当前微信暂不支持该图片操作。'); this.resumeNative(false);
    }
  },
  resumeNative(fromShow) {
    const operation = this._nativeOperation;
    if (!this._active || !operation?.completed) return;
    if (['preview', 'privacy'].includes(operation.kind) && !operation.hidden && !fromShow && !operation.error) return;
    this._nativeOperation = null; this.setData({ busy: false, statusText: '' });
    if (operation.error) { this.showFailure(operation.error); this.render(); return; }
    const current = () => !this._disposed && operation.visit === this._visit && operation.id === this._nativeSequence;
    Promise.resolve(operation.apply?.(operation.result)).catch(error => { if (current()) this.showFailure(error); })
      .finally(() => { if (this._active && current()) this.render(); });
  },
  chooseImages() {
    this.releasePreviewLease();
    if (!this._active || this.data.busy || this._nativeOperation) return;
    if (typeof wx.getPrivacySetting !== 'function' || typeof wx.chooseMedia !== 'function') {
      this.showFailure(takeout.failure('IMAGE_PROCESSING', '请更新微信后选择截图。')); return;
    }
    const intent = ++this._nativeSequence, visit = this._visit;
    wx.getPrivacySetting({ success: result => {
      if (!this._active || this._disposed || visit !== this._visit || intent !== this._nativeSequence) return;
      if (result.needAuthorization) {
        this.setData({ showPlatformPrivacy: true, privacyName: result.privacyContractName || '小程序用户隐私保护指引' });
      } else this.openPicker();
    }, fail: () => { if (this._active && intent === this._nativeSequence) this.showFailure(takeout.failure('IMAGE_PROCESSING', '暂时无法确认微信照片隐私授权，请稍后重试。')); } });
  },
  agreePlatformPrivacy() {
    if (!this._active || !this.data.showPlatformPrivacy) return;
    this.setData({ showPlatformPrivacy: false }); this.openPicker();
  },
  dismissPlatformPrivacy() { this._nativeSequence += 1; this.setData({ showPlatformPrivacy: false }); },
  openPlatformPrivacy() {
    this.startNative('privacy', callbacks => wx.openPrivacyContract(callbacks));
  },
  openPicker() {
    if (!this._active || this.data.busy) return;
    takeout.cancel(); this.clearContent();
    this.startNative('choose', callbacks => wx.chooseMedia({ count: 3, mediaType: ['image'], sourceType: ['album'],
      sizeType: ['original'], ...callbacks }), async result => {
      if (!Array.isArray(result?.tempFiles) || !result.tempFiles.length || result.tempFiles.length > 3 ||
        result.tempFiles.some(file => file.fileType && file.fileType !== 'image')) throw takeout.failure('INVALID_IMAGE', '请选择1至3张截图。');
      const job = this.beginWork('preparing', '检查截图…');
      try {
        const sources = [];
        for (const file of result.tempFiles) {
          this._processor.registerOriginal(file.tempFilePath);
          sources.push(await this._processor.inspect(file.tempFilePath, () => this.current(job)));
        }
        if (this.current(job)) { this._sources = sources; this.setData({ uploadConsent: false }); }
      } finally { if (this.current(job)) { this.setData({ busy: false, statusText: '' }); this.render(); } }
    });
  },
  editImage(event) {
    this.releasePreviewLease();
    const index = Number(event.currentTarget.dataset.index), source = this._sources[index];
    if (!this._active || this.data.busy || this._nativeOperation || !Number.isInteger(index) || !source) return;
    if (typeof wx.editImage !== 'function') { this.showFailure(takeout.failure('IMAGE_PROCESSING', '当前微信不支持编辑，请在相册裁剪后重新选择。')); return; }
    takeout.cancel(); this.resetCatalog(); this.setData({ uploadConsent: false });
    let reservation;
    try { reservation = this._processor.reserveGenerated(); }
    catch (error) { this.showFailure(error); return; }
    this.startNative('edit', callbacks => wx.editImage({ src: source.path, ...callbacks }), async result => {
      const path = result?.tempFilePath;
      const job = this.beginWork('preparing', '检查编辑后的截图…');
      try {
        const edited = await this._processor.inspect(path, () => this.current(job));
        if (this.current(job)) { this._sources[index] = edited; if (path !== source.path) this.cleanup(this._processor.release([source.path])); }
      } catch (error) { if (path !== source.path) this.cleanup(this._processor.release([path])); throw error; }
      finally { if (this.current(job)) { this.setData({ busy: false, statusText: '' }); this.render(); } }
    }, source.path, reservation);
  },
  previewImage(event) {
    const index = Number(event.currentTarget.dataset.index), source = this._sources[index];
    if (!Number.isInteger(index) || !source) return;
    this.startNative('preview', callbacks => wx.previewImage({ current: source.path, urls: this._sources.map(item => item.path), ...callbacks }));
  },
  previewCandidate(event) {
    const item = this._round.snapshot().candidates.find(value => value.id === event.currentTarget.dataset.id);
    const tile = item && this._tiles.find(value => value.imageId === item.imageId);
    if (!tile) return;
    this.startNative('preview', callbacks => wx.previewImage({ current: tile.path, urls: this._tiles.map(value => value.path), ...callbacks }));
  },
  async acceptGlobalPrivacy() {
    if (!this._active || this.data.busy) return;
    const job = this.beginWork('preview', '保存隐私选择…');
    try { await getApp().acceptConsent(); }
    catch (_) { if (this.current(job)) this.setData({ error: '隐私选择或服务连接未完成，请重试。' }); }
    finally { if (this.current(job)) { this.setData({ busy: false, statusText: '' }); this.render(); } }
  },
  openAppPrivacy() {
    if (!this._active) return;
    takeout.cancel(); this.clearContent(); wx.navigateTo({ url: '/pages/privacy/index' });
  },
  async retryService(lifecycle = false) {
    if (!this._active || !service.state.consent || this.data.busy && lifecycle !== true || service.state.status === 'loading') return;
    const visit = this._visit;
    try { await getApp().checkService(); }
    catch (_) { if (this._active && visit === this._visit) this.setData({ error: '截图服务未连接，请稍后重新检查。' }); }
    if (this._active && visit === this._visit) this.render();
  },
  changeUploadConsent(event) {
    if (!this._active) return;
    const accepted = Array.isArray(event.detail.value) && event.detail.value.length === 1 && event.detail.value[0] === 'agree';
    if (!accepted) { takeout.cancel(); this.clearContent(); return; }
    if (!this._sources.length) return;
    this.setData({ uploadConsent: true }); this.render();
  },
  cancelWork() {
    takeout.cancel(); this.resetCatalog();
    this.setData({ busy: false, statusText: '', notice: '本次请求已取消；已经发给供应商的请求无法撤回。' }); this.render();
  },
  async recognize() {
    this.releasePreviewLease(); this.render();
    if (!this._active || !this.data.canRecognize) return;
    this.resetCatalog();
    const job = this.beginWork('preparing', '整理清晰的截图片段…');
    let prepared;
    try {
      prepared = await this._processor.prepare(this._sources.map(item => item.path), () => this.current(job) && this.data.uploadConsent);
      if (!this.current(job)) return;
      this._payload = prepared.images; this._tiles = prepared.tiles;
      this.setData({ phase: 'recognizing', statusText: 'MiMo正在识别截图…' });
      const result = await takeout.extract({ images: this._payload, consentVersion: takeout.CONSENT_VERSION,
        isCurrent: () => this.current(job) && this.data.uploadConsent });
      if (!this.current(job)) return;
      if (result.status === 'NO_CANDIDATES') {
        this.resetCatalog(); this.setData({ error: '没有识别到清楚的商家或菜品。请裁掉无关区域、保留完整名称后重试。' });
      } else {
        this._round.load(result);
        clearTimeout(this._expiryTimer);
        this._expiryTimer = setTimeout(() => { this._round.snapshot(); if (this._active) this.render(); }, Math.max(1, this._round.snapshot().expiresAt - Date.now() + 1));
        this.setData({ notice: '请逐项核对名称和原始标价，取消勾选不准确或不想选的项目。' });
      }
    } catch (error) { if (this.current(job)) { this.resetCatalog(); this.showFailure(error); } }
    finally {
      if (prepared?.images) { prepared.images.forEach(image => { image.base64 = ''; }); prepared.images.length = 0; }
      if (this._payload === prepared?.images) this.releasePayload();
      if (prepared?.tiles && this._tiles !== prepared.tiles) this.cleanup(this._processor.release(prepared.tiles.map(tile => tile.path)));
      if (this.current(job)) { this.setData({ busy: false, statusText: '' }); this.render(); }
    }
  },
  changeCandidates(event) {
    if (!this._active || this.data.busy || Number(event.currentTarget.dataset.revision) !== this.data.revision) return;
    const state = this._round.snapshot(), ids = event.detail.value;
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !state.candidates.some(item => item.id === id))) return;
    try { this._round.setExcluded(state.candidates.filter(item => !ids.includes(item.id)).map(item => item.id)); }
    catch (error) { this.showFailure(error); }
    this.render();
  },
  async decide(event) {
    if (!this._active || Number(event.currentTarget.dataset.revision) !== this.data.revision) return;
    this.releasePreviewLease(); this.render();
    if (!this.data.canDecide) return;
    const preferences = tasteProfile.getProfile(), preferenceRevision = tasteProfile.getState().revision;
    if (!validPreferences(preferences)) { getApp().ensureTasteProfile(); this.clearContent(); return; }
    let input;
    try { input = this._round.request(); }
    catch (error) { this.showFailure(error); this.render(); return; }
    const key = JSON.stringify({ preferences, preferenceRevision });
    const job = this.beginWork('choosing', '正在帮你选择…');
    const current = () => this.current(job) && this.data.uploadConsent && input.revision === this._round.snapshot().revision &&
      key === JSON.stringify({ preferences: tasteProfile.getProfile(), preferenceRevision: tasteProfile.getState().revision });
    try {
      const result = await takeout.decide({ ...input, preferences, preferenceRevision, candidatesConfirmed: true,
        consentVersion: takeout.CONSENT_VERSION, isCurrent: current });
      if (current()) this._round.accept(result, input.revision);
    } catch (error) {
      if (this.current(job)) { if (error.code === 'RECEIPT_EXPIRED') this.resetCatalog(); this.showFailure(error); }
    } finally { if (this.current(job)) { this.setData({ busy: false, statusText: '' }); this.render(); } }
  },
  restart(event) {
    if (!this._active || this.data.busy || Number(event.currentTarget.dataset.revision) !== this.data.revision) return;
    try { this._round.restart(); this.setData({ notice: '已重新开始这一轮，仍只从你保留的候选中选择。' }); }
    catch (error) { this.showFailure(error); }
    this.render();
  },
  removeImages() { if (this._active) { takeout.cancel(); this.clearContent(); this.render(); } },
});
