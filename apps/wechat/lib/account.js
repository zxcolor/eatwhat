// Account credentials and OTP challenges deliberately live in memory only.
const exportContent = require('./account-export')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const PHONE_MASK = /^\+861\d{2}\*{4}\d{4}$/
const EMAIL_MASK = /^[^@\s]*\*+[^@\s]*@[A-Za-z0-9.-]{1,190}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

function fail(code, message) { const error = new Error(message); error.code = code; throw error }
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.keys(value).includes(key))
}
function instant(value) { return typeof value === 'string' && ISO.test(value) ? Date.parse(value) : NaN }
function uuid() {
  // This is a temporary device correlation label, never an authentication secret.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16)
    return (char === 'x' ? value : (value & 3) | 8).toString(16)
  })
}
function normalizeTarget(method, value) {
  const target = typeof value === 'string' ? value.trim() : ''
  if (method === 'PHONE') {
    const phone = /^1[3-9]\d{9}$/.test(target) ? `+86${target}` : target
    if (!/^\+861[3-9]\d{9}$/.test(phone)) fail('INPUT', '请输入有效的中国大陆手机号')
    return phone
  }
  if (method === 'EMAIL' && target.length <= 254 && /^[^\s@]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(target)) return target.toLowerCase()
  fail('INPUT', '请输入有效的邮箱地址')
}
function capabilities(service) {
  const config = service.state.config
  const auth = config?.authCapabilities
  const enabled = service.state.consent === true && service.state.status === 'ready' && config && config.accountsEnabled === true && auth && auth.accountsEnabled === true
  return {
    accountsEnabled: Boolean(enabled),
    phoneEnabled: Boolean(enabled && auth.phoneEnabled === true),
    emailEnabled: Boolean(enabled && auth.emailEnabled === true),
    registrationEnabled: Boolean(enabled && auth.phoneEnabled === true && auth.registrationEnabled === true),
    wechatMiniProgramEnabled: Boolean(enabled && auth.wechatMiniProgramEnabled === true),
    dataExportEnabled: Boolean(enabled && auth.dataExportEnabled === true),
  }
}
function validChallenge(value, method, target, now) {
  if (!exact(value, ['challengeId', 'targetType', 'maskedTarget', 'expiresAt', 'resendAvailableAt'])) return false
  const expires = instant(value.expiresAt)
  const resend = instant(value.resendAvailableAt)
  const maskValid = method === 'PHONE'
    ? PHONE_MASK.test(value.maskedTarget) && value.maskedTarget === `${target.slice(0, 6)}****${target.slice(-4)}`
    : typeof value.maskedTarget === 'string' && value.maskedTarget.length <= 254 && EMAIL_MASK.test(value.maskedTarget) && value.maskedTarget.split('@')[1].toLowerCase() === target.split('@')[1]
  return UUID.test(value.challengeId) && value.targetType === method && maskValid &&
    expires > now && expires <= now + 630000 && resend >= now - 30000 && resend <= expires
}
function validTokens(value, now) {
  if (!exact(value, ['userId', 'sessionId', 'tokenType', 'accessToken', 'accessTokenExpiresAt', 'refreshToken', 'refreshTokenExpiresAt'])) return false
  const access = instant(value.accessTokenExpiresAt)
  const refresh = instant(value.refreshTokenExpiresAt)
  return UUID.test(value.userId) && UUID.test(value.sessionId) && value.tokenType === 'Bearer' &&
    TOKEN.test(value.accessToken) && TOKEN.test(value.refreshToken) && value.accessToken !== value.refreshToken &&
    access > now && access <= now + 1830000 && refresh > access && refresh <= now + 2592030000
}
function validIdentities(value) {
  if (!exact(value, ['items']) || !Array.isArray(value.items) || value.items.length > 8) return false
  return value.items.filter((item) => item && item.primary === true).length === 1 &&
    new Set(value.items.map((item) => item?.bindingId)).size === value.items.length && value.items.every(validIdentity)
}
function validIdentity(item) {
  if (!exact(item, ['bindingId', 'type', 'maskedValue', 'boundAt', 'primary', 'canUnbind'])) return false
  const maskValid = item.type === 'PHONE' ? PHONE_MASK.test(item.maskedValue)
    : item.type === 'EMAIL' ? typeof item.maskedValue === 'string' && item.maskedValue.length <= 254 && EMAIL_MASK.test(item.maskedValue)
      : item.type === 'WECHAT' ? item.maskedValue === '微信账号' : item.type === 'QQ' && item.maskedValue === 'QQ 账号'
  return UUID.test(item.bindingId) && maskValid && Number.isFinite(instant(item.boundAt)) &&
    typeof item.primary === 'boolean' && typeof item.canUnbind === 'boolean' &&
    (!item.primary || item.type === 'PHONE') && (!item.canUnbind || item.type !== 'PHONE')
}
function validBinding(value, type) {
  return validIdentity(value) && value.type === type && value.primary === false
}
function validSessions(value, sessionId) {
  if (!exact(value, ['items']) || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 50) return false
  return new Set(value.items.map((item) => item?.sessionId)).size === value.items.length &&
    value.items.filter((item) => item && item.current === true).length === 1 && value.items.every((item) => {
      if (!exact(item, ['sessionId', 'deviceLabel', 'platform', 'current', 'createdAt', 'lastActiveAt', 'expiresAt'])) return false
      const created = instant(item.createdAt)
      const active = instant(item.lastActiveAt)
      const expires = instant(item.expiresAt)
      return UUID.test(item.sessionId) && typeof item.deviceLabel === 'string' && item.deviceLabel.trim().length > 0 && item.deviceLabel.length <= 80 &&
        ['ANDROID', 'MINIPROGRAM'].includes(item.platform) && typeof item.current === 'boolean' &&
        item.current === (item.sessionId === sessionId) && active >= created && expires > created
    })
}

function createAccountClient(service, options) {
  const now = options?.now || Date.now
  let generation = 0
  let authenticationRevision = 0
  let installationId = null
  let session = null
  let challenge = null
  let suspendedChallenge = null
  let submittingCode = false
  let cooldownUntil = 0
  let identities = []
  let sessions = []
  let detailsReady = false
  let bindingChallenge = null
  let bindingCooldownUntil = 0
  let mutationBusy = false
  let latestExport = null
  let exportText = null
  let exportPage = 0
  function clearAccountData() {
    identities = []
    sessions = []
    detailsReady = false
    bindingChallenge = null
    bindingCooldownUntil = 0
    latestExport = null
    exportText = null
    exportPage = 0
    mutationBusy = false
  }
  function clear() {
    generation += 1
    authenticationRevision += 1
    installationId = null
    session = null
    challenge = null
    suspendedChallenge = null
    submittingCode = false
    cooldownUntil = 0
    clearAccountData()
  }
  function cancelChallenge() { generation += 1; challenge = null; suspendedChallenge = null; submittingCode = false }
  function cancelPending() {
    generation += 1
    if (submittingCode) challenge = null
    submittingCode = false
    bindingChallenge = null
    exportText = null
    exportPage = 0
    mutationBusy = false
  }
  function suspend() {
    const held = submittingCode ? null : challenge || suspendedChallenge
    generation += 1
    authenticationRevision += 1
    submittingCode = false
    session = null
    clearAccountData()
    challenge = null
    suspendedChallenge = service.state.consent && held && held.expiresAt > now() ? held : null
    if (!suspendedChallenge) { installationId = null; cooldownUntil = 0 }
  }
  function available(method, purpose) {
    const caps = capabilities(service)
    return caps.accountsEnabled && (method === 'PHONE' && caps.phoneEnabled && (purpose === 'LOGIN' || purpose === 'REGISTER' && caps.registrationEnabled) || method === 'EMAIL' && purpose === 'LOGIN' && caps.emailEnabled)
  }
  function gate() {
    if (!capabilities(service).accountsEnabled) {
      if (!service.state.consent || service.state.status === 'ready') clear()
      fail('UNAVAILABLE', '账号服务暂未开放，请稍后重新检查')
    }
  }
  function assertCurrent(attempt, epoch) {
    if (attempt !== generation || epoch !== service.state.epoch || !service.state.consent) fail('STALE', '操作已取消，请重新操作')
    gate()
  }
  function activeSession() {
    gate()
    if (!session || session.expiresAt <= now() || session.epoch !== service.state.epoch) { clear(); fail('SESSION_EXPIRED', '登录已过期，请重新登录') }
    return session
  }
  function assertSession(current, attempt, epoch, revision) {
    assertCurrent(attempt, epoch)
    if (session !== current || revision !== authenticationRevision) fail('STALE', '登录状态已变化，请重新操作')
    activeSession()
  }
  // Consumers get the response body only. Credentials, headers and session IDs
  // remain private, and parallel callers share no mutable request options.
  async function authorizedRequest(path, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['method', 'data'].includes(key))) fail('INPUT', '请求参数无效')
    if (typeof path !== 'string' || !path.startsWith('/v1/') || path.includes('://') || path.includes('#')) fail('INPUT', '请求地址无效')
    const current = activeSession()
    const attempt = generation, epoch = service.state.epoch, revision = authenticationRevision
    let result
    try { result = await service.request(path, { ...options, token: current.token }) }
    catch (error) {
      if (error.statusCode === 401 && session === current && epoch === service.state.epoch && revision === authenticationRevision) { clear(); throw error }
      if (session !== current || attempt !== generation || epoch !== service.state.epoch || revision !== authenticationRevision || !service.state.consent) fail('STALE', '操作已取消，请重新操作')
      throw error
    }
    assertSession(current, attempt, epoch, revision)
    return result
  }
  function view() {
    const caps = capabilities(service)
    if (suspendedChallenge && suspendedChallenge.expiresAt <= now()) {
      suspendedChallenge = null
      if (!session && !challenge) { installationId = null; cooldownUntil = 0 }
    }
    if (!service.state.consent && (session || challenge || suspendedChallenge || bindingChallenge || latestExport)) clear()
    else if (!caps.accountsEnabled) {
      if (session || challenge) {
        generation += 1
        authenticationRevision += 1
        session = null
        challenge = null
        clearAccountData()
      }
      // A background OTP may wait for fresh configuration, but a confirmed
      // disabled account service must discard it. No credential is restored.
      if (service.state.status === 'ready' && suspendedChallenge) clear()
    }
    if (session && (session.expiresAt <= now() || session.epoch !== service.state.epoch)) {
      generation += 1
      authenticationRevision += 1
      session = null
      clearAccountData()
    }
    if (caps.accountsEnabled && suspendedChallenge) {
      if (suspendedChallenge.expiresAt > now() && available(suspendedChallenge.method, suspendedChallenge.purpose)) {
        challenge = { ...suspendedChallenge, epoch: service.state.epoch }
      }
      suspendedChallenge = null
    }
    if (challenge && (challenge.expiresAt <= now() || challenge.epoch !== service.state.epoch || !available(challenge.method, challenge.purpose))) challenge = null
    if (bindingChallenge && (!session || bindingChallenge.session !== session || bindingChallenge.epoch !== service.state.epoch || bindingChallenge.expiresAt <= now() || !caps.emailEnabled)) bindingChallenge = null
    if (!caps.dataExportEnabled) { latestExport = null; exportText = null; exportPage = 0 }
    if (latestExport && instant(latestExport.expiresAt) <= now()) {
      latestExport = { exportId: latestExport.exportId, status: 'EXPIRED', requestedAt: latestExport.requestedAt, expiresAt: latestExport.expiresAt, includeBehaviorHistory: latestExport.includeBehaviorHistory, downloadAvailable: false }
      exportText = null
    }
    const exportLabels = { QUEUED: '排队中', PROCESSING: '生成中', READY: '可读取', FAILED: '生成失败', EXPIRED: '已过期' }
    return {
      capabilities: caps,
      signedIn: Boolean(session),
      authenticationRevision,
      detailsReady,
      canBindEmail: Boolean(session && detailsReady && caps.emailEnabled && !identities.some(item => item.type === 'EMAIL')),
      identities: identities.map((item) => ({ ...item })),
      sessions: sessions.map((item) => ({ ...item })),
      hasChallenge: Boolean(challenge),
      maskedTarget: challenge ? challenge.maskedTarget : '',
      resendSeconds: Math.max(0, Math.ceil((cooldownUntil - now()) / 1000)),
      hasBindingChallenge: Boolean(bindingChallenge),
      bindingMaskedTarget: bindingChallenge ? bindingChallenge.maskedTarget : '',
      bindingResendSeconds: Math.max(0, Math.ceil((bindingCooldownUntil - now()) / 1000)),
      exportStatus: latestExport ? { status: latestExport.status, label: exportLabels[latestExport.status], requestedAt: latestExport.requestedAt, expiresAt: latestExport.expiresAt, includeBehaviorHistory: latestExport.includeBehaviorHistory, sizeLabel: latestExport.status === 'READY' ? `${latestExport.sizeBytes} 字节` : '', downloadAvailable: latestExport.downloadAvailable } : null,
      exportPage: exportText === null ? null : exportContent.page(exportText, exportPage),
    }
  }
  function resumeChallenge() {
    if (!view().hasChallenge) return null
    return { method: challenge.method, purpose: challenge.purpose, target: challenge.target }
  }
  async function sendCode(method, purpose, rawTarget) {
    gate()
    if (session) fail('INPUT', '请先退出当前账号')
    if (!available(method, purpose)) fail('UNAVAILABLE', '该登录方式暂未开放')
    if (cooldownUntil > now()) fail('COOLDOWN', '请等待倒计时结束后再发送验证码')
    const target = normalizeTarget(method, rawTarget)
    if (!installationId) installationId = uuid()
    const attempt = ++generation
    const epoch = service.state.epoch
    challenge = null
    suspendedChallenge = null
    const data = { purpose, installationId }
    data[method === 'PHONE' ? 'phoneNumber' : 'email'] = target
    const result = await service.request(`/v1/auth/${method === 'PHONE' ? 'phone' : 'email'}/request-code`, { method: 'POST', data })
    assertCurrent(attempt, epoch)
    if (!available(method, purpose)) fail('UNAVAILABLE', '该登录方式暂未开放')
    if (!validChallenge(result, method, target, now())) fail('INVALID_RESPONSE', '账号服务响应异常，请稍后重试')
    challenge = { id: result.challengeId, method, purpose, target, maskedTarget: result.maskedTarget, expiresAt: instant(result.expiresAt), epoch }
    cooldownUntil = instant(result.resendAvailableAt)
    return view()
  }
  async function login(method, purpose, rawTarget, otpCode) {
    gate()
    if (submittingCode) fail('BUSY', '正在验证，请稍候')
    const target = normalizeTarget(method, rawTarget)
    if (!available(method, purpose)) fail('UNAVAILABLE', '该登录方式暂未开放')
    if (!challenge || challenge.epoch !== service.state.epoch || challenge.method !== method || challenge.purpose !== purpose || challenge.target !== target || challenge.expiresAt <= now()) fail('INPUT', '请先为当前账号获取有效验证码')
    if (typeof otpCode !== 'string' || !/^\d{6}$/.test(otpCode)) fail('INPUT', '请输入 6 位验证码')
    const attempt = ++generation
    const epoch = service.state.epoch
    const data = { method, challengeId: challenge.id, otpCode, device: { installationId, label: '微信小程序', platform: 'MINIPROGRAM', appVersion: service.VERSION } }
    if (method === 'PHONE') data.phoneNumber = target
    // A failed attempt may be retried while the page stays open. Suspension
    // discards this challenge because an in-flight code may be consumed remotely.
    submittingCode = true
    suspendedChallenge = null
    try {
      const result = await service.request('/v1/auth/login', { method: 'POST', data })
      assertCurrent(attempt, epoch)
      if (!available(method, purpose)) fail('UNAVAILABLE', '该登录方式暂未开放')
      if (!validTokens(result, now())) fail('INVALID_RESPONSE', '账号服务响应异常，请重新登录')
      session = { token: result.accessToken, userId: result.userId, sessionId: result.sessionId, expiresAt: instant(result.accessTokenExpiresAt), epoch }
      authenticationRevision += 1
      challenge = null
      cooldownUntil = 0
      clearAccountData()
      return view()
    } finally { if (attempt === generation) submittingCode = false }
  }
  async function loginWithWechat(getCode) {
    gate()
    if (session) fail('INPUT', '请先退出当前账号')
    if (!capabilities(service).wechatMiniProgramEnabled) fail('UNAVAILABLE', '微信小程序登录暂未开放')
    if (typeof getCode !== 'function') fail('INPUT', '请从微信登录按钮重试')
    if (!installationId) installationId = uuid()
    const attempt = ++generation
    const epoch = service.state.epoch
    challenge = null
    suspendedChallenge = null
    const code = await getCode()
    assertCurrent(attempt, epoch)
    if (!capabilities(service).wechatMiniProgramEnabled) fail('UNAVAILABLE', '微信小程序登录暂未开放')
    if (typeof code !== 'string' || code.length < 8 || code.length > 2048 || !/^[A-Za-z0-9._~+/=-]+$/.test(code)) fail('INVALID_RESPONSE', '未取得有效的微信登录凭证，请重试')
    const result = await service.request('/v1/auth/wechat-miniprogram/login', {
      method: 'POST', data: { code, device: { installationId, label: '微信小程序', platform: 'MINIPROGRAM', appVersion: service.VERSION } },
    })
    assertCurrent(attempt, epoch)
    if (!capabilities(service).wechatMiniProgramEnabled) fail('UNAVAILABLE', '微信小程序登录暂未开放')
    if (!validTokens(result, now())) fail('INVALID_RESPONSE', '账号服务响应异常，请重新登录')
    session = { token: result.accessToken, userId: result.userId, sessionId: result.sessionId, expiresAt: instant(result.accessTokenExpiresAt), epoch }
    authenticationRevision += 1
    cooldownUntil = 0
    clearAccountData()
    return view()
  }
  async function loadDetails() {
    const current = activeSession()
    if (mutationBusy) fail('BUSY', '正在处理账号操作，请稍候')
    const attempt = ++generation
    const epoch = service.state.epoch
    detailsReady = false
    identities = []
    sessions = []
    let responses
    try {
      responses = await Promise.all([
        authorizedRequest('/v1/auth/identities'),
        authorizedRequest('/v1/auth/sessions?includePlatforms=ALL'),
      ])
    } catch (error) {
      if (error.statusCode === 401 && session === current) clear()
      throw error
    }
    assertCurrent(attempt, epoch)
    activeSession()
    if (!validIdentities(responses[0]) || !validSessions(responses[1], current.sessionId)) fail('INVALID_RESPONSE', '账号信息响应异常，请稍后重试')
    const labels = { PHONE: '手机号', EMAIL: '邮箱', WECHAT: '微信', QQ: 'QQ' }
    identities = responses[0].items.map((item) => ({ id: item.bindingId, type: item.type, label: labels[item.type], maskedValue: item.maskedValue, primary: item.primary, canUnbind: item.canUnbind && ['EMAIL', 'WECHAT'].includes(item.type) && !item.primary }))
    sessions = responses[1].items.map((item) => ({ id: item.sessionId, label: item.deviceLabel, platform: item.platform === 'MINIPROGRAM' ? '小程序' : 'Android', current: item.current, lastActive: item.lastActiveAt.replace('T', ' ').replace(/(?:\.\d+)?Z$/, ' UTC') }))
    detailsReady = true
    return view()
  }
  function requireBinding(type) {
    const current = activeSession()
    const state = view()
    if (!detailsReady) fail('INPUT', '请先刷新并核对账号身份')
    if (type !== 'EMAIL' || !state.canBindEmail) fail('UNAVAILABLE', '该绑定方式当前不可用')
    return current
  }
  function cancelBinding() { generation += 1; bindingChallenge = null; mutationBusy = false }
  async function sendBindingCode(rawTarget) {
    const current = requireBinding('EMAIL')
    if (mutationBusy) fail('BUSY', '正在处理账号操作，请稍候')
    if (bindingCooldownUntil > now()) fail('COOLDOWN', '请等待倒计时结束后再发送验证码')
    const target = normalizeTarget('EMAIL', rawTarget)
    const attempt = ++generation, epoch = service.state.epoch
    bindingChallenge = null
    mutationBusy = true
    try {
      const result = await authorizedRequest('/v1/auth/email/request-code', { method: 'POST', data: { email: target, purpose: 'BIND', installationId } })
      requireBinding('EMAIL')
      if (!validChallenge(result, 'EMAIL', target, now())) fail('INVALID_RESPONSE', '邮箱验证码响应异常，请稍后重试')
      bindingChallenge = { id: result.challengeId, target, maskedTarget: result.maskedTarget, expiresAt: instant(result.expiresAt), epoch, session: current }
      bindingCooldownUntil = instant(result.resendAvailableAt)
      return view()
    } finally { if (attempt === generation) mutationBusy = false }
  }
  function acceptBinding(result, type, target) {
    if (!exact(result, ['binding']) || !validBinding(result.binding, type) || identities.some(item => item.id === result.binding.bindingId)) fail('INVALID_RESPONSE', '绑定结果响应异常，请刷新账号身份确认')
    if (type === 'EMAIL' && result.binding.maskedValue.split('@')[1].toLowerCase() !== target.split('@')[1]) fail('INVALID_RESPONSE', '绑定结果响应异常，请刷新账号身份确认')
    const binding = result.binding
    identities.push({ id: binding.bindingId, type, label: type === 'EMAIL' ? '邮箱' : '微信', maskedValue: binding.maskedValue, primary: false, canUnbind: binding.canUnbind })
    bindingChallenge = null
    return view()
  }
  async function bindEmail(rawTarget, otpCode) {
    const current = requireBinding('EMAIL')
    if (mutationBusy) fail('BUSY', '正在处理账号操作，请稍候')
    const target = normalizeTarget('EMAIL', rawTarget)
    if (!bindingChallenge || bindingChallenge.session !== current || bindingChallenge.epoch !== service.state.epoch || bindingChallenge.target !== target || bindingChallenge.expiresAt <= now()) fail('INPUT', '请先为当前邮箱获取有效验证码')
    if (typeof otpCode !== 'string' || !/^\d{6}$/.test(otpCode)) fail('INPUT', '请输入 6 位验证码')
    const proof = bindingChallenge
    const attempt = ++generation
    mutationBusy = true
    try {
      const result = await authorizedRequest('/v1/auth/identities', { method: 'POST', data: { type: 'EMAIL', challengeId: proof.id, otpCode } })
      requireBinding('EMAIL')
      return acceptBinding(result, 'EMAIL', target)
    } finally { if (attempt === generation) mutationBusy = false }
  }
  async function unbindIdentity(id) {
    activeSession()
    const selected = detailsReady && identities.find(item => item.id === id)
    if (!selected || !UUID.test(id) || !selected.canUnbind || selected.primary || !['EMAIL', 'WECHAT'].includes(selected.type)) fail('INPUT', '当前身份不可解绑，请先刷新账号信息')
    if (mutationBusy) fail('BUSY', '正在处理账号操作，请稍候')
    const attempt = ++generation
    mutationBusy = true
    try {
      const result = await authorizedRequest(`/v1/auth/identities/${id}`, { method: 'DELETE' })
      if (!exact(result, ['bindingId', 'unboundAt']) || result.bindingId !== id || !Number.isFinite(instant(result.unboundAt))) fail('INVALID_RESPONSE', '解绑结果未确认，请刷新账号身份')
      identities = identities.filter(item => item.id !== id)
      bindingChallenge = null
      return view()
    } finally { if (attempt === generation) mutationBusy = false }
  }
  async function revokeSession(id) {
    const current = activeSession()
    const selected = detailsReady && sessions.find(item => item.id === id)
    if (!selected || !UUID.test(id)) fail('INPUT', '请先刷新并选择当前账号的登录设备')
    if (mutationBusy) fail('BUSY', '正在处理账号操作，请稍候')
    const attempt = ++generation
    mutationBusy = true
    try {
      const result = await authorizedRequest(`/v1/auth/sessions/${id}`, { method: 'DELETE' })
      if (!exact(result, ['sessionId', 'revokedAt']) || result.sessionId !== id || !Number.isFinite(instant(result.revokedAt))) {
        if (id === current.sessionId) clear()
        fail('INVALID_RESPONSE', '设备撤销结果未确认，请重新检查账号')
      }
      if (id === current.sessionId) clear()
      else sessions = sessions.filter(item => item.id !== id)
      return view()
    } finally { if (attempt === generation) mutationBusy = false }
  }
  function requireExport() {
    const current = activeSession()
    if (!view().capabilities.dataExportEnabled) { latestExport = null; exportText = null; fail('UNAVAILABLE', '数据导出当前未开放') }
    return current
  }
  async function requestExport(includeBehaviorHistory) {
    requireExport()
    if (typeof includeBehaviorHistory !== 'boolean') fail('INPUT', '请选择导出范围')
    if (mutationBusy || latestExport && ['QUEUED', 'PROCESSING'].includes(latestExport.status)) fail('BUSY', '当前导出正在处理，请刷新状态')
    const attempt = ++generation
    mutationBusy = true
    exportText = null
    try {
      const result = await authorizedRequest('/v1/account/export', { method: 'POST', data: { format: 'JSON', includeBehaviorHistory } })
      requireExport()
      if (!exportContent.validReceipt(result, now(), includeBehaviorHistory)) fail('INVALID_RESPONSE', '导出申请响应异常，请刷新导出状态')
      latestExport = { ...result, downloadAvailable: false }
      return view()
    } finally { if (attempt === generation) mutationBusy = false }
  }
  async function refreshExport() {
    requireExport()
    if (mutationBusy) fail('BUSY', '正在处理账号操作，请稍候')
    ++generation
    exportText = null
    const result = await authorizedRequest('/v1/account/exports/latest')
    requireExport()
    if (!exact(result, ['item']) || result.item !== null && !exportContent.validStatus(result.item, now())) { latestExport = null; fail('INVALID_RESPONSE', '导出状态响应异常，请稍后重试') }
    latestExport = result.item === null ? null : { ...result.item }
    return view()
  }
  async function readExport() {
    const current = requireExport()
    if (mutationBusy) fail('BUSY', '正在处理账号操作，请稍候')
    if (latestExport?.status !== 'READY' || !exportContent.validStatus(latestExport, now())) fail('INPUT', '导出尚未准备好或已过期，请刷新状态')
    if (typeof service.requestBytes !== 'function') fail('UNAVAILABLE', '安全读取服务暂不可用')
    const expected = { ...latestExport }
    const attempt = ++generation, epoch = service.state.epoch, revision = authenticationRevision
    const check = () => {
      assertSession(current, attempt, epoch, revision)
      requireExport()
      if (!latestExport || latestExport.exportId !== expected.exportId || !exportContent.validStatus(expected, now())) fail('STALE', '导出状态已变化，请刷新后重试')
    }
    exportText = null
    mutationBusy = true
    let result
    try {
      result = await service.requestBytes(`/v1/account/exports/${expected.exportId}/content`, { token: current.token, maxBytes: expected.sizeBytes })
      check()
      const text = await exportContent.verifyContent(result, expected, current.userId, check)
      check()
      exportText = text
      exportPage = 0
      return view()
    } catch (error) {
      if (error.statusCode === 401 && session === current && epoch === service.state.epoch && revision === authenticationRevision) { clear(); throw error }
      if (session !== current || attempt !== generation || epoch !== service.state.epoch || revision !== authenticationRevision) fail('STALE', '操作已取消，请重新操作')
      throw error
    } finally {
      if (Object.prototype.toString.call(result?.bytes) === '[object ArrayBuffer]') new Uint8Array(result.bytes).fill(0)
      if (attempt === generation) mutationBusy = false
    }
  }
  function changeExportPage(index) {
    requireExport()
    if (!Number.isInteger(index) || index < 0 || exportText === null) fail('INPUT', '导出内容已清除，请重新读取')
    exportPage = index
    return view()
  }
  function closeExport() { exportText = null; exportPage = 0; return view() }
  async function deleteAccount(confirmation) {
    const current = activeSession()
    if (confirmation !== 'DELETE_MY_ACCOUNT') fail('INPUT', '请明确确认注销当前账号')
    if (mutationBusy) fail('BUSY', '正在处理账号操作，请稍候')
    // The confirmed request immediately removes local credentials. A lost or
    // malformed receipt must never be presented as a confirmed deletion.
    clear()
    const attempt = generation, epoch = service.state.epoch, revision = authenticationRevision
    let result
    try { result = await service.request('/v1/account', { method: 'DELETE', data: { confirmation }, token: current.token }) }
    catch (error) {
      if (attempt !== generation || epoch !== service.state.epoch || revision !== authenticationRevision || session) fail('STALE', '登录状态已变化，请重新操作')
      throw error
    }
    assertCurrent(attempt, epoch)
    if (session || revision !== authenticationRevision) fail('STALE', '登录状态已变化，请重新操作')
    const invalidated = instant(result?.invalidatedAt), deadline = instant(result?.backupDeletionDeadline)
    if (!exact(result, ['deletionId', 'userId', 'status', 'invalidatedAt', 'backupDeletionDeadline']) || !UUID.test(result.deletionId) || result.userId !== current.userId || result.status !== 'DEACTIVATED' || !(invalidated <= now() + 30000 && deadline > invalidated && deadline <= invalidated + 2592000000)) fail('INVALID_RESPONSE', '本机登录已清除，服务端注销结果未确认')
    return { status: 'DEACTIVATED', invalidatedAt: result.invalidatedAt, backupDeletionDeadline: result.backupDeletionDeadline }
  }
  async function logout() {
    const current = activeSession()
    clear()
    const attempt = generation, epoch = service.state.epoch
    const result = await service.request('/v1/auth/logout', { method: 'POST', data: {}, token: current.token })
    assertCurrent(attempt, epoch)
    if (!exact(result, ['sessionId', 'loggedOutAt']) || result.sessionId !== current.sessionId || !Number.isFinite(instant(result.loggedOutAt))) fail('INVALID_RESPONSE', '本机登录已清除，服务端退出结果未确认')
    return view()
  }
  return { clear, cancelChallenge, cancelPending, suspend, resumeChallenge, view, authorizedRequest, sendCode, login, loginWithWechat, loadDetails, cancelBinding, sendBindingCode, bindEmail, unbindIdentity, revokeSession, requestExport, refreshExport, readExport, changeExportPage, closeExport, deleteAccount, logout }
}

let singleton
function defaultClient() {
  if (!singleton) singleton = createAccountClient(require('./service'))
  return singleton
}
module.exports = { createAccountClient, normalizeTarget, validChallenge, validTokens, validIdentities, validSessions }
;['clear', 'cancelChallenge', 'cancelPending', 'suspend', 'resumeChallenge', 'view', 'authorizedRequest', 'sendCode', 'login', 'loginWithWechat', 'loadDetails', 'cancelBinding', 'sendBindingCode', 'bindEmail', 'unbindIdentity', 'revokeSession', 'requestExport', 'refreshExport', 'readExport', 'changeExportPage', 'closeExport', 'deleteAccount', 'logout'].forEach((name) => {
  module.exports[name] = (...args) => defaultClient()[name](...args)
})
