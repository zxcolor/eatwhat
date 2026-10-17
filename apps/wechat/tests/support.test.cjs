const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ID = '11111111-2222-4333-8444-555555555555';
function harness(signedIn = false) {
  const calls = [];
  const state = { consent: true, status: 'ready', config: { supportFeedbackEnabled: true }, epoch: 1 };
  const auth = { signedIn, authenticationRevision: 1 };
  let resolve, reject;
  const transport = (route, options) => { calls.push({ route, options }); return new Promise((yes, no) => { resolve = yes; reject = no; }); };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/support-feedback.js'), 'utf8'), {
    module, require(name) {
      if (name === './service') return { state, request: transport };
      if (name === './account') return { view: () => auth, authorizedRequest: (route, options) => { calls.push({ authenticated: true }); return transport(route, options); } };
      if (name === './random') return { uuid: async () => ID };
      throw new Error(name);
    },
  });
  const api = module.exports;
  const form = api.create();
  form.edit('PRODUCT', '这是用于反馈流程的合成测试内容。');
  return { api, form, state, auth, calls, resolve: value => resolve(value), reject: value => reject(value) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('feedback validates Unicode codepoints, line endings and control characters', () => {
  const { api } = harness();
  assert.equal(api.valid('😀'.repeat(10)), true); assert.equal(api.valid('😀'.repeat(2001)), false);
  assert.equal(api.valid(`${'正常文字'.repeat(10)}\u0001`), false);
  assert.equal(api.normalize(' \r\n正文\r下一行 \n'), '正文\n下一行');
});
test('feedback capability and consent gates send no network', async () => {
  const h = harness(); h.state.config.supportFeedbackEnabled = false; await h.form.submit();
  h.state.config.supportFeedbackEnabled = true; h.state.consent = false; await h.form.submit();
  assert.equal(h.calls.length, 0);
});
test('network retry reuses submission id; success must bind to the same id', async () => {
  const h = harness(); let pending = h.form.submit(); await tick(); h.reject(new Error('网络失败')); await pending;
  const id = h.calls[0].options.data.submissionId;
  pending = h.form.submit(); await tick(); assert.equal(h.calls[1].options.data.submissionId, id);
  h.resolve({ feedbackId: 'different', accepted: true, retentionAfterClosureDays: 180 }); await pending;
  assert.equal(h.form.view().result, null); assert.notEqual(h.form.view().message, '');
});
test('signed-in failure never silently retries as guest', async () => {
  const h = harness(true); const pending = h.form.submit(); await tick(); h.auth.signedIn = false;
  h.reject(Object.assign(new Error('expired'), { statusCode: 401 })); await pending;
  assert.equal(h.form.view().guestConfirmationRequired, true); assert.equal(h.calls.length, 2);
  await h.form.submit(); assert.equal(h.calls.length, 2);
  h.form.confirmGuest(); const retry = h.form.submit(); await tick();
  assert.equal(h.calls.length, 3); h.resolve({ feedbackId: ID, accepted: true, retentionAfterClosureDays: 180 }); await retry;
  assert.equal(h.form.view().message, ''); assert.equal(h.form.view().result.feedbackId, ID);
});
test('clearing or revoking the form suppresses late response and draft resurrection', async () => {
  const h = harness(); const pending = h.form.submit(); await tick(); h.form.clear(); h.state.epoch += 1;
  h.resolve({ feedbackId: ID, accepted: true, retentionAfterClosureDays: 180 }); await pending;
  assert.equal(h.form.view().message, ''); assert.equal(h.form.view().result, null); assert.equal(h.form.view().busy, false);
});

test('a late response cannot be displayed after the account revision changes', async () => {
  const h = harness(true); const pending = h.form.submit(); await tick(); h.auth.authenticationRevision += 1;
  h.resolve({ feedbackId: ID, accepted: true, retentionAfterClosureDays: 180 }); await pending;
  assert.equal(h.form.view().result, null); assert.equal(h.form.view().guestConfirmationRequired, true);
});
