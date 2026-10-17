const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createAccountClient } = require('../lib/account')
const artifact = require('../lib/account-export')

// All data, credentials and byte streams here are synthetic; no network or file export runs.
const NOW = Date.parse('2026-10-17T02:00:00Z')
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const iso = seconds => new Date(NOW + seconds * 1000).toISOString()
const phone = '+8613800000000'
const phoneIdentity = () => ({ bindingId: id(4), type: 'PHONE', maskedValue: '+86138****0000', boundAt: iso(-60), primary: true, canUnbind: false })
const emailIdentity = () => ({ bindingId: id(5), type: 'EMAIL', maskedValue: 's***@example.test', boundAt: iso(0), primary: false, canUnbind: true })
const challenge = type => ({ challengeId: id(type === 'PHONE' ? 10 : 11), targetType: type, maskedTarget: type === 'PHONE' ? '+86138****0000' : 's***@example.test', expiresAt: iso(600), resendAvailableAt: iso(60) })
const queued = include => ({ exportId: id(20), status: 'QUEUED', requestedAt: iso(0), expiresAt: iso(604800), includeBehaviorHistory: include })
const snapshot = () => ({ schemaVersion: 1, generatedAt: iso(0), account: { accountId: id(2), status: 'ACTIVE', createdAt: iso(-60) }, identities: [], favorites: [], recommendationHistory: [], privateFeedback: [], supportFeedback: [], preferences: {} })
function content(value = snapshot()) {
  const source = Buffer.from(JSON.stringify(value))
  const sha256 = crypto.createHash('sha256').update(source).digest('hex')
  const status = { ...queued(true), status: 'READY', downloadAvailable: true, readyAt: iso(1), sizeBytes: source.length, sha256, contentType: 'application/json' }
  const headers = {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(source.length),
    'X-Content-SHA256': sha256, Digest: `sha-256=${Buffer.from(sha256, 'hex').toString('base64')}`,
    'Content-Disposition': 'attachment; filename="chi-shen-me-account-export.json"', 'Cache-Control': 'private, no-store',
  }
  return { source, status, response: () => ({ bytes: Uint8Array.from(source).buffer, headers: { ...headers } }) }
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function setup() {
  let clock = NOW, userId = id(2), sessionId = id(3)
  const calls = [], overrides = new Map()
  const currentToken = () => ({ userId, sessionId, tokenType: 'Bearer', accessToken: 'a'.repeat(43), accessTokenExpiresAt: iso(900), refreshToken: 'b'.repeat(43), refreshTokenExpiresAt: iso(86400) })
  const rows = () => ({ items: [
    { sessionId, deviceLabel: '微信小程序', platform: 'MINIPROGRAM', current: true, createdAt: iso(-60), lastActiveAt: iso(0), expiresAt: iso(86400) },
    { sessionId: id(9), deviceLabel: '合成 Android', platform: 'ANDROID', current: false, createdAt: iso(-60), lastActiveAt: iso(0), expiresAt: iso(86400) },
  ] })
  const service = {
    VERSION: '0.1.11-alpha',
    state: { consent: true, status: 'ready', epoch: 1, config: { accountsEnabled: true, authCapabilities: { accountsEnabled: true, phoneEnabled: true, emailEnabled: true, registrationEnabled: true, dataExportEnabled: true } } },
    async request(route, options = {}) {
      calls.push({ route, options })
      const override = overrides.get(route)
      if (override) return override(options)
      if (route === '/v1/auth/phone/request-code') return challenge('PHONE')
      if (route === '/v1/auth/email/request-code') return challenge('EMAIL')
      if (route === '/v1/auth/login') return currentToken()
      if (route === '/v1/auth/identities') return options.method === 'POST' ? { binding: emailIdentity() } : { items: [phoneIdentity()] }
      if (route === '/v1/auth/sessions?includePlatforms=ALL') return rows()
      if (route.startsWith('/v1/auth/identities/')) return { bindingId: route.split('/').at(-1), unboundAt: iso(0) }
      if (route.startsWith('/v1/auth/sessions/')) return { sessionId: route.split('/').at(-1), revokedAt: iso(0) }
      if (route === '/v1/account/export') return queued(options.data.includeBehaviorHistory)
      if (route === '/v1/account/exports/latest') return { item: content().status }
      if (route === '/v1/account') return { deletionId: id(30), userId, status: 'DEACTIVATED', invalidatedAt: iso(0), backupDeletionDeadline: iso(2592000) }
      if (route === '/v1/favorites') return { items: [] }
      throw new Error(`Unexpected synthetic route: ${route}`)
    },
    async requestBytes(route, options) { calls.push({ route, options, binary: true }); return content().response() },
  }
  const client = createAccountClient(service, { now: () => clock })
  return { service, client, calls, overrides, advance(seconds) { clock += seconds * 1000 }, changeUser() { userId = id(40); sessionId = id(41) } }
}
async function signIn(h, details = true) {
  await h.client.sendCode('PHONE', 'LOGIN', phone)
  await h.client.login('PHONE', 'LOGIN', phone, '123456')
  if (details) await h.client.loadDetails()
}
function noCredentials(value) { assert.doesNotMatch(JSON.stringify(value), /accessToken|refreshToken|"token"|installationId|"userId"|"sessionId"/) }

test('authorizedRequest keeps credentials private and allows parallel callers without cancelling each other', async () => {
  const h = setup()
  await assert.rejects(h.client.authorizedRequest('/v1/favorites'), { code: 'SESSION_EXPIRED' })
  await signIn(h)
  const before = h.client.view().authenticationRevision
  const first = deferred(), second = deferred(); let n = 0
  h.overrides.set('/v1/favorites', () => (++n === 1 ? first.promise : second.promise))
  const one = h.client.authorizedRequest('/v1/favorites'), two = h.client.authorizedRequest('/v1/favorites')
  second.resolve({ marker: 2 }); first.resolve({ marker: 1 })
  assert.deepEqual(await one, { marker: 1 }); assert.deepEqual(await two, { marker: 2 })
  assert.equal(h.calls.at(-1).options.token, 'a'.repeat(43))
  assert.equal(h.client.view().authenticationRevision, before)
  noCredentials(h.client.view())
  await assert.rejects(h.client.authorizedRequest('https://untrusted.test'), { code: 'INPUT' })
  await assert.rejects(h.client.authorizedRequest('/v1/favorites', { token: 'injected' }), { code: 'INPUT' })
})

test('authorized requests reject delayed results after page cancellation, epoch changes and account replacement', async () => {
  for (const invalidate of [h => h.client.cancelPending(), h => h.client.clear(), h => { h.service.state.epoch += 1 }, h => { h.service.state.consent = false }]) {
    const h = setup(); await signIn(h)
    const waiting = deferred(); h.overrides.set('/v1/favorites', () => waiting.promise)
    const request = h.client.authorizedRequest('/v1/favorites')
    invalidate(h); waiting.resolve({ items: ['old account'] })
    await assert.rejects(request, { code: 'STALE' })
  }
})

test('an old request 401 cannot sign out a newer account, while a current 401 clears all data', async () => {
  const h = setup(); await signIn(h)
  const revision = h.client.view().authenticationRevision
  const waiting = deferred(); h.overrides.set('/v1/favorites', () => waiting.promise)
  const old = h.client.authorizedRequest('/v1/favorites')
  h.client.clear(); h.changeUser(); await signIn(h)
  waiting.reject(Object.assign(new Error('expired'), { statusCode: 401 }))
  await assert.rejects(old, { code: 'STALE' })
  assert.equal(h.client.view().signedIn, true)
  assert.ok(h.client.view().authenticationRevision > revision)
  h.overrides.set('/v1/favorites', async () => { throw Object.assign(new Error('expired'), { statusCode: 401 }) })
  await assert.rejects(h.client.authorizedRequest('/v1/favorites'))
  assert.equal(h.client.view().signedIn, false)
  assert.equal(h.client.view().detailsReady, false)
})

test('email binding requires verified identities, EMAIL capability and a challenge for the current session and target', async () => {
  const h = setup(); await signIn(h, false)
  await assert.rejects(h.client.sendBindingCode('synthetic@example.test'), { code: 'INPUT' })
  await h.client.loadDetails()
  await h.client.sendBindingCode('synthetic@example.test')
  const sent = h.calls.at(-1)
  assert.equal(sent.options.data.purpose, 'BIND')
  assert.equal(sent.options.token, 'a'.repeat(43))
  assert.equal(sent.options.data.installationId, h.calls[0].options.data.installationId)
  await assert.rejects(h.client.bindEmail('other@example.test', '123456'), { code: 'INPUT' })
  await h.client.bindEmail('synthetic@example.test', '123456')
  assert.deepEqual(h.calls.at(-1).options.data, { type: 'EMAIL', challengeId: id(11), otpCode: '123456' })
  assert.equal(h.client.view().canBindEmail, false)
  assert.equal(h.client.view().identities.at(-1).maskedValue, 's***@example.test')
  assert.equal(h.client.view().hasBindingChallenge, false)
  noCredentials(h.client.view())
})

test('binding code cooldown survives edited input but the proof cannot be restored after leaving', async () => {
  const h = setup(); await signIn(h)
  await h.client.sendBindingCode('synthetic@example.test')
  h.client.cancelBinding()
  await assert.rejects(h.client.sendBindingCode('other@example.test'), { code: 'COOLDOWN' })
  h.advance(61); await h.client.sendBindingCode('synthetic@example.test')
  h.client.cancelPending()
  await assert.rejects(h.client.bindEmail('synthetic@example.test', '123456'), { code: 'INPUT' })
  assert.equal(h.client.view().hasBindingChallenge, false)
})

test('a delayed binding proof or accepted binding cannot cross a revoked capability or hidden page', async () => {
  for (const stage of ['code', 'bind']) {
    const h = setup(); await signIn(h)
    if (stage === 'bind') await h.client.sendBindingCode('synthetic@example.test')
    const waiting = deferred()
    h.overrides.set(stage === 'code' ? '/v1/auth/email/request-code' : '/v1/auth/identities', () => waiting.promise)
    const request = stage === 'code' ? h.client.sendBindingCode('synthetic@example.test') : h.client.bindEmail('synthetic@example.test', '123456')
    h.service.state.config.authCapabilities.emailEnabled = false
    waiting.resolve(stage === 'code' ? challenge('EMAIL') : { binding: emailIdentity() })
    await assert.rejects(request, { code: 'UNAVAILABLE' })
    assert.equal(h.client.view().identities.length, 1)
    assert.equal(h.client.view().hasBindingChallenge, false)
  }
})

test('malformed binding response is rejected without exposing a different identity', async () => {
  for (const change of [{ type: 'QQ', maskedValue: 'QQ 账号' }, { maskedValue: 'raw@example.test' }, { primary: true }, { bindingId: id(4) }, { maskedValue: 's***@other.test' }]) {
    const h = setup(); await signIn(h); await h.client.sendBindingCode('synthetic@example.test')
    h.overrides.set('/v1/auth/identities', async () => ({ binding: { ...emailIdentity(), ...change } }))
    await assert.rejects(h.client.bindEmail('synthetic@example.test', '123456'), { code: 'INVALID_RESPONSE' })
    assert.equal(h.client.view().identities.length, 1)
  }
})

test('only confirmed eligible EMAIL or WECHAT identities can be unbound; PHONE and QQ remain protected', async () => {
  const h = setup(); await signIn(h)
  h.overrides.set('/v1/auth/identities', async () => ({ items: [phoneIdentity(), emailIdentity(), { ...emailIdentity(), bindingId: id(6), type: 'QQ', maskedValue: 'QQ 账号' }] }))
  await h.client.loadDetails()
  const count = h.calls.length
  for (const selected of [id(4), id(6), id(99)]) await assert.rejects(h.client.unbindIdentity(selected), { code: 'INPUT' })
  assert.equal(h.calls.length, count)
  assert.equal(h.client.view().identities.find(item => item.type === 'QQ').canUnbind, false)
  await h.client.unbindIdentity(id(5))
  assert.equal(h.calls.at(-1).options.method, 'DELETE')
  assert.equal(h.client.view().identities.some(item => item.type === 'EMAIL'), false)
})

test('revocation validates the selected session receipt and clears local credentials for the current device', async () => {
  const h = setup(); await signIn(h)
  await assert.rejects(h.client.revokeSession(id(99)), { code: 'INPUT' })
  await h.client.revokeSession(id(9))
  assert.equal(h.client.view().sessions.length, 1)
  assert.equal(h.client.view().signedIn, true)
  const revision = h.client.view().authenticationRevision
  await h.client.revokeSession(id(3))
  assert.equal(h.client.view().signedIn, false)
  assert.ok(h.client.view().authenticationRevision > revision)
  assert.equal(h.client.view().identities.length, 0)
})

test('a mismatched device receipt never removes a different session', async () => {
  const h = setup(); await signIn(h)
  h.overrides.set(`/v1/auth/sessions/${id(9)}`, async () => ({ sessionId: id(3), revokedAt: iso(0) }))
  await assert.rejects(h.client.revokeSession(id(9)), { code: 'INVALID_RESPONSE' })
  assert.equal(h.client.view().sessions.length, 2)
})

test('export requests require capability and preserve the exact chosen scope; pending work cannot be duplicated', async () => {
  const h = setup(); await signIn(h)
  h.service.state.config.authCapabilities.dataExportEnabled = false
  const count = h.calls.length
  await assert.rejects(h.client.requestExport(true), { code: 'UNAVAILABLE' })
  assert.equal(h.calls.length, count)
  h.service.state.config.authCapabilities.dataExportEnabled = true
  await h.client.requestExport(false)
  assert.deepEqual(h.calls.at(-1).options.data, { format: 'JSON', includeBehaviorHistory: false })
  assert.equal(h.client.view().exportStatus.status, 'QUEUED')
  await assert.rejects(h.client.requestExport(false), { code: 'BUSY' })
})

test('export status accepts only bounded schema and refuses unexpected links or mismatched scope receipts', async () => {
  const h = setup(); await signIn(h)
  h.overrides.set('/v1/account/export', async () => queued(true))
  await assert.rejects(h.client.requestExport(false), { code: 'INVALID_RESPONSE' })
  for (const change of [{ downloadUrl: 'https://untrusted.test' }, { sizeBytes: artifact.MAX_BYTES + 1 }, { expiresAt: iso(604900) }, { readyAt: iso(-1) }, { sha256: 'bad' }, { contentType: 'text/html' }]) {
    h.overrides.set('/v1/account/exports/latest', async () => ({ item: { ...content().status, ...change } }))
    await assert.rejects(h.client.refreshExport(), { code: 'INVALID_RESPONSE' })
  }
  h.overrides.set('/v1/account/exports/latest', async () => ({ item: null }))
  await h.client.refreshExport(); assert.equal(h.client.view().exportStatus, null)
})

test('SHA-256 matches independent crypto across empty, UTF-8, padding and multi-chunk boundaries', async () => {
  for (const data of [Buffer.alloc(0), Buffer.from('abc'), Buffer.from('合成内容 🍜'), Buffer.alloc(55, 1), Buffer.alloc(56, 2), Buffer.alloc(64, 3), Buffer.alloc(300001, 4)]) {
    assert.equal(await artifact.sha256(data), crypto.createHash('sha256').update(data).digest('hex'))
  }
})

test('UTF-8 rejects overlong, truncated, surrogate and out-of-range encodings', () => {
  assert.equal(artifact.decodeUtf8(Buffer.from('合成内容 🍜')), '合成内容 🍜')
  for (const bytes of [[0xc0, 0x80], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0x80]]) assert.throws(() => artifact.decodeUtf8(Uint8Array.from(bytes)), { code: 'INVALID_RESPONSE' })
})

test('verified export downloads only the authorized content route, validates its account, and erases byte buffers', async () => {
  const h = setup(); await signIn(h); await h.client.refreshExport()
  let response
  h.service.requestBytes = async (route, options) => {
    assert.equal(route, `/v1/account/exports/${id(20)}/content`)
    assert.equal(options.token, 'a'.repeat(43)); assert.equal(options.maxBytes, content().source.length)
    response = content().response(); return response
  }
  await h.client.readExport()
  assert.equal(JSON.parse(h.client.view().exportPage.text).account.accountId, id(2))
  assert.ok(new Uint8Array(response.bytes).every(value => value === 0))
  h.client.cancelPending()
  assert.equal(h.client.view().exportPage, null)
})

test('altered content, forbidden headers, wrong account and internal fields are never rendered', async () => {
  for (const alter of [
    response => { new Uint8Array(response.bytes)[10] ^= 1 },
    response => { response.headers['Content-Length'] = '1' },
    response => { response.headers['content-type'] = 'application/json; charset=utf-8' },
    response => { response.headers['Content-Encoding'] = 'gzip' },
    response => { response.headers.Digest = 'sha-256=wrong' },
  ]) {
    const h = setup(); await signIn(h); await h.client.refreshExport()
    const response = content().response(); alter(response)
    h.service.requestBytes = async () => response
    await assert.rejects(h.client.readExport(), { code: 'INVALID_RESPONSE' })
    assert.equal(h.client.view().exportPage, null)
    assert.ok(new Uint8Array(response.bytes).every(value => value === 0))
  }
  for (const value of [{ ...snapshot(), account: { ...snapshot().account, accountId: id(99) } }, { ...snapshot(), accessToken: 'forbidden' }]) {
    const bad = content(value), h = setup(); await signIn(h)
    h.overrides.set('/v1/account/exports/latest', async () => ({ item: bad.status }))
    h.service.requestBytes = async () => bad.response()
    await h.client.refreshExport()
    await assert.rejects(h.client.readExport(), { code: 'INVALID_RESPONSE' })
    assert.equal(h.client.view().exportPage, null)
  }
})

test('download cancellation and capability loss reject late bytes and clear content', async () => {
  for (const invalidate of [h => h.client.cancelPending(), h => h.client.clear(), h => { h.service.state.config.authCapabilities.dataExportEnabled = false }]) {
    const h = setup(); await signIn(h); await h.client.refreshExport()
    const waiting = deferred(); h.service.requestBytes = () => waiting.promise
    const request = h.client.readExport(), response = content().response()
    invalidate(h); waiting.resolve(response)
    await assert.rejects(request)
    assert.equal(h.client.view().exportPage, null)
    assert.ok(new Uint8Array(response.bytes).every(value => value === 0))
  }
})

test('long export text is paginated below setData limits without splitting surrogate pairs', () => {
  const text = `${'x'.repeat(15999)}🍜${'y'.repeat(16001)}`
  const pages = [0, 1, 2].map(index => artifact.page(text, index))
  assert.equal(pages.map(value => value.text).join(''), text)
  assert.ok(pages.every(value => value.text.length <= 16001))
})

test('deletion requires explicit confirmation and removes local credentials before awaiting its receipt', async () => {
  const h = setup(); await signIn(h)
  const count = h.calls.length
  await assert.rejects(h.client.deleteAccount('yes'), { code: 'INPUT' })
  assert.equal(h.calls.length, count)
  h.overrides.set('/v1/account', async options => {
    assert.equal(h.client.view().signedIn, false)
    assert.equal(options.data.confirmation, 'DELETE_MY_ACCOUNT')
    return { deletionId: id(30), userId: id(2), status: 'DEACTIVATED', invalidatedAt: iso(0), backupDeletionDeadline: iso(2592000) }
  })
  assert.deepEqual(await h.client.deleteAccount('DELETE_MY_ACCOUNT'), { status: 'DEACTIVATED', invalidatedAt: iso(0), backupDeletionDeadline: iso(2592000) })
  assert.equal(h.client.view().signedIn, false)
})

test('a malformed, wrong-account or lost deletion receipt is never presented as confirmed', async () => {
  for (const change of [{ userId: id(99) }, { backupDeletionDeadline: iso(2592001) }, { status: 'PENDING' }, { extra: 'unexpected' }]) {
    const h = setup(); await signIn(h)
    h.overrides.set('/v1/account', async () => ({ deletionId: id(30), userId: id(2), status: 'DEACTIVATED', invalidatedAt: iso(0), backupDeletionDeadline: iso(2592000), ...change }))
    await assert.rejects(h.client.deleteAccount('DELETE_MY_ACCOUNT'), { code: 'INVALID_RESPONSE' })
    assert.equal(h.client.view().signedIn, false)
  }
  const h = setup(); await signIn(h)
  h.overrides.set('/v1/account', async () => { throw new Error('synthetic network loss') })
  await assert.rejects(h.client.deleteAccount('DELETE_MY_ACCOUNT'))
  assert.equal(h.client.view().signedIn, false)
})

function pageHarness(h) {
  let page, modal
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/account/index.js'), 'utf8'), {
    Page(value) { page = value }, require(name) { return name.endsWith('/account') ? h.client : h.service },
    getApp() { return { syncPage() {} } }, setInterval() { return 1 }, clearInterval() {},
    wx: { showModal(value) { modal = value } },
  })
  page.data = JSON.parse(JSON.stringify(page.data))
  page.setData = function (value) { Object.assign(this.data, value) }
  page.onShow()
  return { page, modal: () => modal }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('destructive UI confirms the exact account visit and rejects stale or cancelled confirmations', async () => {
  const h = setup(); await signIn(h)
  const { page, modal } = pageHarness(h)
  page.revokeSession({ currentTarget: { dataset: { id: id(9) } } })
  const count = h.calls.length
  modal().success({ confirm: false }); await tick(); assert.equal(h.calls.length, count)
  page.openDelete(); page.deleteAccount(); assert.equal(h.calls.length, count)
  page.inputDeleteConfirmation({ detail: { value: '注销账号' } }); page.deleteAccount()
  const old = modal()
  h.client.clear(); h.changeUser(); await signIn(h)
  old.success({ confirm: true }); await tick()
  assert.equal(h.client.view().signedIn, true)
  assert.equal(h.calls.some(call => call.route === '/v1/account'), false)
})

test('account page clears binding input and export body on leave and requires a fresh confirmation after reentry', async () => {
  const h = setup(); await signIn(h); await h.client.refreshExport(); await h.client.readExport()
  const { page, modal } = pageHarness(h)
  page.setData({ bindingTarget: 'synthetic@example.test', bindingCode: '123456' })
  page.logout(); const old = modal()
  page.onHide(); page.onShow()
  old.success({ confirm: true }); await tick()
  assert.equal(page.data.bindingTarget, ''); assert.equal(page.data.bindingCode, '')
  assert.equal(page.data.exportPage, null); assert.equal(h.client.view().signedIn, true)
})

test('the account page renders a confirmed deletion deadline without retaining user identifiers', async () => {
  const h = setup(); await signIn(h)
  const { page, modal } = pageHarness(h)
  page.openDelete(); page.inputDeleteConfirmation({ detail: { value: '注销账号' } }); page.deleteAccount()
  modal().success({ confirm: true }); await tick()
  assert.equal(page.data.signedIn, false)
  assert.equal(page.data.deletionReceipt.status, 'DEACTIVATED')
  assert.equal(page.data.deletionReceipt.backupDeletionDeadline, iso(2592000))
  noCredentials(page.data)
})
