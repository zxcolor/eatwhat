const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createAccountClient, normalizeTarget, validIdentities, validSessions } = require('../lib/account')

// These are synthetic contract fixtures; tests never send a verification code.
const NOW = Date.parse('2026-10-17T02:00:00Z')
const id = (suffix) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
const iso = (seconds) => new Date(NOW + seconds * 1000).toISOString()
const phone = '+8613800000000'
const phoneChallenge = () => ({ challengeId: id(1), targetType: 'PHONE', maskedTarget: '+86138****0000', expiresAt: iso(600), resendAvailableAt: iso(60) })
const emailChallenge = () => ({ ...phoneChallenge(), targetType: 'EMAIL', maskedTarget: 't***@example.test' })
const tokens = () => ({ userId: id(2), sessionId: id(3), tokenType: 'Bearer', accessToken: 'a'.repeat(43), accessTokenExpiresAt: iso(900), refreshToken: 'b'.repeat(43), refreshTokenExpiresAt: iso(86400) })
const identities = () => ({ items: [{ bindingId: id(4), type: 'PHONE', maskedValue: '+86138****0000', boundAt: iso(-60), primary: true, canUnbind: false }] })
const sessions = () => ({ items: [{ sessionId: id(3), deviceLabel: '微信小程序', platform: 'MINIPROGRAM', current: true, createdAt: iso(-60), lastActiveAt: iso(0), expiresAt: iso(86400) }] })
function setup() {
  let clock = NOW
  const calls = []
  const service = {
    VERSION: '0.1.11-alpha',
    state: { consent: true, status: 'ready', epoch: 1, config: { accountsEnabled: true, authCapabilities: { accountsEnabled: true, phoneEnabled: true, emailEnabled: true, registrationEnabled: true } } },
    async request(route, options) {
      calls.push({ route, options })
      if (route.includes('phone/request-code')) return phoneChallenge()
      if (route.includes('email/request-code')) return emailChallenge()
      if (route === '/v1/auth/login' || route === '/v1/auth/wechat-miniprogram/login') return tokens()
      if (route === '/v1/auth/identities') return identities()
      if (route === '/v1/auth/sessions?includePlatforms=ALL') return sessions()
      if (route === '/v1/auth/logout') return { sessionId: id(3), loggedOutAt: iso(0) }
      throw new Error('Unexpected test route')
    },
  }
  return { service, calls, client: createAccountClient(service, { now: () => clock }), advance: (seconds) => { clock += seconds * 1000 } }
}
async function signIn(context, method = 'PHONE', purpose = 'LOGIN', target = phone) {
  await context.client.sendCode(method, purpose, target)
  await context.client.login(method, purpose, target, '123456')
}
function pending(context) {
  let resolve
  context.service.request = () => new Promise((done) => { resolve = done })
  return (result) => resolve(result)
}

test('normalizes supported targets and rejects malformed personal fields locally', () => {
  assert.equal(normalizeTarget('PHONE', '13800000000'), phone)
  assert.equal(normalizeTarget('EMAIL', ' TEST@Example.Test '), 'test@example.test')
  for (const value of ['', '12', '13800000000?token=bad']) assert.throws(() => normalizeTarget('PHONE', value))
  assert.throws(() => normalizeTarget('EMAIL', 'x@x'))
})
test('phone registration has explicit purpose and MINIPROGRAM device context', async () => {
  const context = setup()
  await signIn(context, 'PHONE', 'REGISTER')
  assert.equal(context.calls[0].options.data.purpose, 'REGISTER')
  assert.equal(context.calls[1].options.data.phoneNumber, phone)
  assert.equal(context.calls[1].options.data.device.platform, 'MINIPROGRAM')
  assert.equal(context.calls[1].options.data.device.appVersion, '0.1.11-alpha')
  assert.equal(context.calls[0].options.data.installationId, context.calls[1].options.data.device.installationId)
  assert.equal(context.client.view().signedIn, true)
  assert.doesNotMatch(JSON.stringify(context.client.view()), /accessToken|refreshToken|"token"/)
})
test('email login does not invent registration or send phone fields', async () => {
  const context = setup()
  await assert.rejects(context.client.sendCode('EMAIL', 'REGISTER', 'test@example.test'), { code: 'UNAVAILABLE' })
  await signIn(context, 'EMAIL', 'LOGIN', 'test@example.test')
  assert.equal(context.calls[0].options.data.email, 'test@example.test')
  assert.equal(context.calls[1].options.data.method, 'EMAIL')
  assert.equal(Object.hasOwn(context.calls[1].options.data, 'phoneNumber'), false)
})
test('missing capability or consent blocks all auth network requests', async () => {
  for (const field of ['consent', 'config', 'top-level', 'accountsEnabled', 'phoneEnabled', 'registrationEnabled']) {
    const context = setup()
    if (field === 'consent') context.service.state.consent = false
    else if (field === 'config') context.service.state.config = null
    else if (field === 'top-level') context.service.state.config.accountsEnabled = false
    else delete context.service.state.config.authCapabilities[field]
    await assert.rejects(context.client.sendCode('PHONE', 'REGISTER', phone))
    assert.equal(context.calls.length, 0)
  }
})
test('native OAuth and unsupported purposes never reach the network', async () => {
  const context = setup()
  for (const [method, purpose] of [['WECHAT', 'LOGIN'], ['QQ', 'LOGIN'], ['PHONE', 'BIND'], ['EMAIL', 'BIND']]) {
    await assert.rejects(context.client.sendCode(method, purpose, phone))
  }
  assert.equal(context.calls.length, 0)
})
test('a challenge is bound to its original target and purpose', async () => {
  const context = setup()
  await context.client.sendCode('PHONE', 'LOGIN', phone)
  await assert.rejects(context.client.login('PHONE', 'REGISTER', phone, '123456'), { code: 'INPUT' })
  await assert.rejects(context.client.login('PHONE', 'LOGIN', '+8613900000000', '123456'), { code: 'INPUT' })
  await assert.rejects(context.client.login('PHONE', 'LOGIN', phone, '12345'), { code: 'INPUT' })
  assert.equal(context.calls.length, 1)
})
test('resend respects server deadline even if target field is edited', async () => {
  const context = setup()
  await context.client.sendCode('PHONE', 'LOGIN', phone)
  context.client.cancelChallenge()
  await assert.rejects(context.client.sendCode('PHONE', 'LOGIN', phone), { code: 'COOLDOWN' })
  assert.equal(context.calls.length, 1)
  context.advance(61)
  assert.equal(context.client.view().resendSeconds, 0)
})
test('expired OTP cannot authenticate', async () => {
  const context = setup()
  await context.client.sendCode('PHONE', 'LOGIN', phone)
  context.advance(601)
  await assert.rejects(context.client.login('PHONE', 'LOGIN', phone, '123456'), { code: 'INPUT' })
  assert.equal(context.calls.length, 1)
})
test('a configuration refresh invalidates an earlier OTP even before the UI reads state', async () => {
  const context = setup()
  await context.client.sendCode('PHONE', 'LOGIN', phone)
  context.service.state.epoch += 1
  await assert.rejects(context.client.login('PHONE', 'LOGIN', phone, '123456'), { code: 'INPUT' })
  assert.equal(context.calls.length, 1)
  assert.equal(context.client.view().hasChallenge, false)
})
test('failed resend cannot leave the previous challenge available for login', async () => {
  const context = setup()
  await context.client.sendCode('PHONE', 'LOGIN', phone)
  context.advance(61)
  context.service.request = async () => { throw new Error('synthetic network failure') }
  await assert.rejects(context.client.sendCode('PHONE', 'LOGIN', phone))
  assert.equal(context.client.view().hasChallenge, false)
})
test('malformed or unmasked challenge responses fail closed', async () => {
  for (const alteration of [{ maskedTarget: phone }, { maskedTarget: '+86139****0000' }, { targetType: 'EMAIL' }, { expiresAt: iso(3600) }, { resendAvailableAt: iso(601) }, { extra: 'unexpected' }]) {
    const context = setup()
    context.service.request = async () => ({ ...phoneChallenge(), ...alteration })
    await assert.rejects(context.client.sendCode('PHONE', 'LOGIN', phone), { code: 'INVALID_RESPONSE' })
    assert.equal(context.client.view().hasChallenge, false)
  }
})
test('consent withdrawal, epoch invalidation and edited input reject delayed challenges', async () => {
  for (const invalidate of [(context) => context.client.clear(), (context) => { context.service.state.epoch += 1 }, (context) => { context.service.state.consent = false }, (context) => context.client.cancelChallenge()]) {
    const context = setup()
    const resolve = pending(context)
    const promise = context.client.sendCode('PHONE', 'LOGIN', phone)
    invalidate(context)
    resolve(phoneChallenge())
    await assert.rejects(promise, { code: 'STALE' })
    assert.equal(context.client.view().hasChallenge, false)
  }
})
test('cleared session cannot be resurrected by delayed login', async () => {
  const context = setup()
  await context.client.sendCode('PHONE', 'LOGIN', phone)
  const resolve = pending(context)
  const promise = context.client.login('PHONE', 'LOGIN', phone, '123456')
  context.client.clear()
  resolve(tokens())
  await assert.rejects(promise, { code: 'STALE' })
  assert.equal(context.client.view().signedIn, false)
})
test('capability disabled during login rejects its late response', async () => {
  const context = setup()
  await context.client.sendCode('PHONE', 'LOGIN', phone)
  const resolve = pending(context)
  const promise = context.client.login('PHONE', 'LOGIN', phone, '123456')
  context.service.state.config.authCapabilities.phoneEnabled = false
  resolve(tokens())
  await assert.rejects(promise, { code: 'UNAVAILABLE' })
  assert.equal(context.client.view().signedIn, false)
})
test('token response must be strictly shaped with distinct, unexpired credentials', async () => {
  for (const alteration of [{ accessToken: 'short' }, { accessTokenExpiresAt: iso(-1) }, { refreshToken: 'a'.repeat(43) }, { accessTokenExpiresAt: iso(3600) }, { tokenType: 'Other' }, { extra: 'secret' }]) {
    const context = setup()
    await context.client.sendCode('PHONE', 'LOGIN', phone)
    context.service.request = async () => ({ ...tokens(), ...alteration })
    await assert.rejects(context.client.login('PHONE', 'LOGIN', phone, '123456'), { code: 'INVALID_RESPONSE' })
    assert.equal(context.client.view().signedIn, false)
  }
})
test('identity and session readers request all platforms and return presentation fields only', async () => {
  const context = setup()
  await signIn(context)
  await context.client.loadDetails()
  const view = context.client.view()
  assert.equal(view.identities[0].maskedValue, '+86138****0000')
  assert.equal(view.sessions[0].platform, '小程序')
  assert.equal(context.calls[3].route, '/v1/auth/sessions?includePlatforms=ALL')
  assert.equal(context.calls[2].options.token, 'a'.repeat(43))
  assert.doesNotMatch(JSON.stringify(view), /accessToken|refreshToken|installationId/)
})
test('identity reader rejects raw phone values, duplicate IDs and inconsistent primary identities', () => {
  assert.equal(validIdentities(identities()), true)
  for (const alteration of [{ maskedValue: phone }, { primary: false }, { canUnbind: true }, { type: 'EMAIL' }, { boundAt: 'invalid' }]) {
    const response = identities()
    Object.assign(response.items[0], alteration)
    assert.equal(validIdentities(response), false)
  }
  const duplicate = identities()
  duplicate.items.push({ ...duplicate.items[0] })
  assert.equal(validIdentities(duplicate), false)
})
test('QQ remains a read-only existing identity without any mini-program login affordance', async () => {
  const context = setup()
  await signIn(context)
  const request = context.service.request
  context.service.request = async (route, options) => {
    if (route === '/v1/auth/identities') {
      const value = identities()
      value.items.push({ bindingId: id(8), type: 'QQ', maskedValue: 'QQ 账号', boundAt: iso(-60), primary: false, canUnbind: true })
      return value
    }
    return request(route, options)
  }
  await context.client.loadDetails()
  assert.equal(context.client.view().identities[1].label, 'QQ')
  assert.equal(context.client.view().identities[1].maskedValue, 'QQ 账号')
  const markup = fs.readFileSync(path.join(__dirname, '../pages/account/index.wxml'), 'utf8')
  assert.doesNotMatch(markup, /QQ|[Qq][Qq]|qqEnabled/)
})
test('session reader rejects a different current account session and invalid time order', () => {
  assert.equal(validSessions(sessions(), id(3)), true)
  assert.equal(validSessions(sessions(), id(9)), false)
  for (const alteration of [{ platform: 'WEB' }, { current: false }, { deviceLabel: '' }, { lastActiveAt: iso(-120) }, { expiresAt: iso(-120) }]) {
    const response = sessions()
    Object.assign(response.items[0], alteration)
    assert.equal(validSessions(response, id(3)), false)
  }
})
test('late identity data cannot return after local logout/clear', async () => {
  const context = setup()
  await signIn(context)
  let resolveIdentities, resolveSessions
  context.service.request = (route) => new Promise((resolve) => { if (route.includes('identities')) resolveIdentities = resolve; else resolveSessions = resolve })
  const promise = context.client.loadDetails()
  context.client.clear()
  resolveIdentities(identities()); resolveSessions(sessions())
  await assert.rejects(promise, { code: 'STALE' })
  assert.equal(context.client.view().identities.length, 0)
})
test('logout clears local credential before any network result, including failure', async () => {
  const context = setup()
  await signIn(context)
  context.service.request = async () => { assert.equal(context.client.view().signedIn, false); throw new Error('offline') }
  await assert.rejects(context.client.logout())
  assert.equal(context.client.view().signedIn, false)
})
test('expired access credential is discarded without silent refresh', async () => {
  const context = setup()
  await signIn(context)
  context.advance(901)
  assert.equal(context.client.view().signedIn, false)
  await assert.rejects(context.client.loadDetails(), { code: 'SESSION_EXPIRED' })
  assert.equal(context.calls.length, 2)
})
test('account code never persists credentials or invokes Android OAuth', () => {
  for (const relative of ['lib/account.js', 'pages/account/index.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8')
    assert.doesNotMatch(source, /setStorage|writeFile|\/oauth\/state|authorizationCode|oauthState/)
  }
})
test('WeChat invokes its code callback only with explicit mini-program capability', async () => {
  const context = setup()
  context.service.state.config.authCapabilities.wechatEnabled = true
  let invoked = false
  await assert.rejects(context.client.loginWithWechat(() => { invoked = true; return 'synthetic-code' }), { code: 'UNAVAILABLE' })
  assert.equal(invoked, false)
  assert.equal(context.calls.length, 0)
})
test('WeChat login uses only the distinct mini-program endpoint and transient code', async () => {
  const context = setup()
  context.service.state.config.authCapabilities.wechatMiniProgramEnabled = true
  await context.client.loginWithWechat(async () => 'synthetic-code')
  assert.equal(context.calls.length, 1)
  assert.equal(context.calls[0].route, '/v1/auth/wechat-miniprogram/login')
  assert.deepEqual(Object.keys(context.calls[0].options.data).sort(), ['code', 'device'])
  assert.equal(context.calls[0].options.data.device.platform, 'MINIPROGRAM')
  assert.equal(context.client.view().signedIn, true)
  assert.doesNotMatch(JSON.stringify(context.client.view()), /synthetic-code|accessToken|refreshToken/)
})
test('a delayed wx.login callback cannot start auth after the user leaves', async () => {
  const context = setup()
  context.service.state.config.authCapabilities.wechatMiniProgramEnabled = true
  let resolve
  const promise = context.client.loginWithWechat(() => new Promise((done) => { resolve = done }))
  context.client.clear()
  resolve('synthetic-code')
  await assert.rejects(promise, { code: 'STALE' })
  assert.equal(context.calls.length, 0)
  assert.equal(context.client.view().signedIn, false)
})
test('invalid WeChat credentials and revoked capability fail before sending a code', async () => {
  const context = setup()
  context.service.state.config.authCapabilities.wechatMiniProgramEnabled = true
  await assert.rejects(context.client.loginWithWechat(async () => ''), { code: 'INVALID_RESPONSE' })
  await assert.rejects(context.client.loginWithWechat(async () => { context.service.state.config.authCapabilities.wechatMiniProgramEnabled = false; return 'synthetic-code' }), { code: 'UNAVAILABLE' })
  assert.equal(context.calls.length, 0)
})
test('expired server session is removed on an authenticated 401 response', async () => {
  const context = setup()
  await signIn(context)
  context.service.request = async () => { const error = new Error('登录已失效'); error.statusCode = 401; throw error }
  await assert.rejects(context.client.loadDetails())
  assert.equal(context.client.view().signedIn, false)
})
test('configuration refresh invalidates the previous in-memory session', async () => {
  const context = setup()
  await signIn(context)
  context.service.state.epoch += 1
  assert.equal(context.client.view().signedIn, false)
  assert.equal(context.client.view().identities.length, 0)
})
function loadPage(relative, context) {
  let definition
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), {
    Page(value) { definition = value }, require(name) {
      if (name.endsWith('/canteen-ai')) return { preference: () => 'disabled' }
      if (name.endsWith('/taste-profile')) return { getState: () => ({ ready: true, started: false }) }
      return name.endsWith('/account') ? context.account : context.service
    },
    getApp() { return context.app }, wx: context.wx, setInterval() { return 1 }, clearInterval() {},
  })
  definition.data = JSON.parse(JSON.stringify(definition.data))
  definition.setData = function (value) { Object.assign(this.data, value) }
  return definition
}
test('opening the account page does not call wx.login; the explicit button uses its callback only', async () => {
  let wxLoginCalls = 0
  let receivedCode
  const context = setup()
  context.service.state.config.authCapabilities.wechatMiniProgramEnabled = true
  context.account = context.client
  context.app = { syncPage() {} }
  context.wx = { login(options) { wxLoginCalls += 1; options.success({ code: 'synthetic-code' }) } }
  const request = context.service.request
  context.service.request = async (route, options) => { if (route.includes('wechat-miniprogram')) receivedCode = options.data.code; return request(route, options) }
  const page = loadPage('pages/account/index.js', context)
  page.onShow()
  assert.equal(wxLoginCalls, 0)
  await page.loginWithWechat()
  assert.equal(wxLoginCalls, 1)
  assert.equal(receivedCode, 'synthetic-code')
  assert.equal(page.data.signedIn, true)
  assert.doesNotMatch(JSON.stringify(page.data), /synthetic-code|accessToken|refreshToken/)
})
test('settings withdraws consent only after an explicit confirmation', () => {
  let modal
  let withdrawals = 0
  const context = setup()
  context.app = { globalData: { theme: 'system' }, syncPage() {}, withdrawConsent() { withdrawals += 1; context.service.state.consent = false } }
  context.wx = { showModal(options) { modal = options } }
  const page = loadPage('pages/settings/index.js', context)
  page.onShow()
  page.withdrawConsent()
  assert.equal(withdrawals, 0)
  modal.success({ confirm: false })
  assert.equal(withdrawals, 0)
  page.withdrawConsent()
  modal.success({ confirm: true })
  assert.equal(withdrawals, 1)
  assert.equal(page.data.consent, false)
})
test('a stale account event cannot start wx.login after leaving the page', async () => {
  const context = setup()
  context.service.state.config.authCapabilities.wechatMiniProgramEnabled = true
  context.account = context.client
  context.app = { syncPage() {} }
  context.wx = { login() { assert.fail('Hidden account must not call wx.login') } }
  const page = loadPage('pages/account/index.js', context)
  page.onShow()
  page.onHide()
  await page.loginWithWechat()
  assert.equal(context.calls.length, 0)
})
test('a confirmation from an old settings visit cannot withdraw a later consent state', () => {
  let modal
  const context = setup()
  context.app = { globalData: { theme: 'system' }, syncPage() {}, withdrawConsent() { assert.fail('Stale confirmation must be ignored') } }
  context.wx = { showModal(options) { modal = options } }
  const page = loadPage('pages/settings/index.js', context)
  page.onShow()
  page.withdrawConsent()
  page.onHide()
  page.onShow()
  modal.success({ confirm: true })
  assert.equal(context.service.state.consent, true)
})
test('background SMS switching retains only the completed OTP and restores its original device after fresh config', async () => {
  const context = setup()
  await context.client.sendCode('PHONE', 'REGISTER', phone)
  const installationId = context.calls[0].options.data.installationId
  context.client.suspend()
  context.service.state.epoch += 1
  context.service.state.status = 'loading'
  assert.equal(context.client.view().hasChallenge, false)
  assert.equal(context.client.resumeChallenge(), null)
  context.service.state.status = 'ready'
  assert.deepEqual(context.client.resumeChallenge(), { method: 'PHONE', purpose: 'REGISTER', target: phone })
  await context.client.login('PHONE', 'REGISTER', phone, '123456')
  assert.equal(context.client.view().signedIn, true)
  assert.equal(context.calls[1].options.data.device.installationId, installationId)
})
test('expired, disabled and withdrawn background OTP challenges cannot resume', async () => {
  for (const invalidate of [
    (context) => context.advance(601),
    (context) => { context.service.state.config.authCapabilities.phoneEnabled = false },
    (context) => { context.service.state.config.authCapabilities.registrationEnabled = false },
    (context) => { context.service.state.consent = false },
    (context) => context.client.clear(),
  ]) {
    const context = setup()
    await context.client.sendCode('PHONE', 'REGISTER', phone)
    context.client.suspend()
    context.service.state.epoch += 1
    invalidate(context)
    assert.equal(context.client.resumeChallenge(), null)
    assert.equal(context.client.view().hasChallenge, false)
  }
})
test('background never restores a login credential or a code already submitted for login', async () => {
  const signedIn = setup()
  await signIn(signedIn)
  signedIn.client.suspend()
  assert.equal(signedIn.client.view().signedIn, false)
  assert.equal(signedIn.client.resumeChallenge(), null)
  const context = setup()
  await context.client.sendCode('PHONE', 'LOGIN', phone)
  const resolve = pending(context)
  const promise = context.client.login('PHONE', 'LOGIN', phone, '123456')
  context.client.suspend()
  resolve(tokens())
  await assert.rejects(promise, { code: 'STALE' })
  assert.equal(context.client.resumeChallenge(), null)
  assert.equal(context.client.view().signedIn, false)
})
test('a rejected OTP can be corrected without sending another verification message', async () => {
  const context = setup()
  await context.client.sendCode('PHONE', 'LOGIN', phone)
  const request = context.service.request
  context.service.request = async () => { const error = new Error('synthetic incorrect OTP'); error.statusCode = 401; throw error }
  await assert.rejects(context.client.login('PHONE', 'LOGIN', phone, '000000'))
  assert.equal(context.client.view().hasChallenge, true)
  context.service.request = request
  await context.client.login('PHONE', 'LOGIN', phone, '123456')
  assert.equal(context.client.view().signedIn, true)
  assert.equal(context.calls.filter((call) => call.route.includes('request-code')).length, 1)
})
test('both app/page background callback orders clear form inputs then restore a usable target', async () => {
  for (const appFirst of [true, false]) {
    const context = setup()
    context.account = context.client
    context.app = { syncPage() {} }
    context.wx = {}
    const page = loadPage('pages/account/index.js', context)
    page.onShow()
    page.setData({ target: phone })
    await page.sendCode()
    page.setData({ otpCode: '123' })
    const suspendApp = () => { context.client.suspend(); context.service.state.epoch += 1; context.service.state.status = 'loading'; page.syncState() }
    if (appFirst) { suspendApp(); page.onHide() }
    else { page.onHide(); suspendApp() }
    assert.equal(page.data.target, '')
    assert.equal(page.data.otpCode, '')
    page.onShow()
    assert.equal(page.data.hasChallenge, false)
    context.service.state.status = 'ready'
    page.syncState()
    assert.equal(page.data.target, phone)
    assert.equal(page.data.otpCode, '')
    assert.equal(page.data.hasChallenge, true)
    page.setData({ otpCode: '123456' })
    await page.login()
    assert.equal(page.data.signedIn, true)
  }
})
