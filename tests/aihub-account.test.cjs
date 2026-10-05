const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const base = require('../src/providers/base');

const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const fixedTime = '2026-10-05T18:30:00Z';
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedTime])); }
}
function json(body, status = 200) { return new Response(JSON.stringify(body), { status }); }
function record() {
  return { id: 'test-account', name: 'test', loginUrl: 'https://account.test/keys',
    requestUrl: 'https://models.test/v1', balanceAdapter: 'new-api', accountToken: 'test-account-access-token' };
}
function loadAdapter(fetch) {
  const context = vm.createContext({ module: { exports: {} }, URL, AbortController,
    Date: FixedDate, setTimeout, clearTimeout, require: () => ({ ...base, accountFetch: fetch }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/providers/aihub.js'), 'utf8'), context);
  return context.module.exports;
}
function missingAdapter(id) {
  return { id, label: id, detect: async () => { throw Object.assign(new Error('404 page not found'), { status: 404 }); } };
}
function loadMain(adapters) {
  const context = vm.createContext({ URL, balanceAdapters: adapters });
  vm.runInContext(source.slice(source.indexOf('function isJwt('), source.indexOf("ipcMain.handle('connect-provider-account'")), context);
  return context;
}

test('account detection uses the login origin and Bearer without New API headers or refresh requests', async () => {
  let calls = 0;
  const adapter = loadAdapter(async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://account.test/api/users/me');
    assert.equal(options.headers.Authorization, 'Bearer test-account-access-token');
    assert.equal(options.headers['New-Api-User'], undefined);
    assert.equal(options.headers.Cookie, undefined);
    assert.ok(options.signal);
    return json({ id: 17, email: 'user@example.test' });
  });
  assert.equal((await adapter.detect({ ...record(), accountToken: 'Bearer test-account-access-token', accountUserId: '99' })).profile.id, 17);
  assert.equal(calls, 1);
});

test('balance converts micro dollars exactly and requests only the current UTC day statistics', async () => {
  const calls = [];
  const adapter = loadAdapter(async url => {
    const request = new URL(url);
    calls.push(request.pathname);
    if (request.pathname === '/api/billing/balance') return json({ balance_micro: '1234567' });
    assert.equal(request.pathname, '/api/usage/aggregate');
    assert.equal(request.searchParams.get('since'), String(Date.parse('2026-10-05T00:00:00Z') / 1000));
    return json({ summary: { cost_micro: 42, requests: 3, total_tokens: 1200, avg_latency_ms: 271.5 } });
  });
  const result = await adapter.getBalance(record());
  assert.equal(result.balance, 1.234567);
  assert.equal(result.currency, '$');
  assert.equal(result.accountStats.todayCost, 0.000042);
  assert.equal(result.accountStats.todayRequests, 3);
  assert.equal(result.accountStats.todayTokens, 1200);
  assert.equal(result.accountStats.averageDurationMs, 271.5);
  assert.deepEqual(calls, ['/api/billing/balance', '/api/usage/aggregate']);
});

test('zero, small, negative and large balances retain the documented unit', async () => {
  for (const [micro, expected] of [[0, 0], [1, 0.000001], [-1000, -0.001], [1000000000000, 1000000]]) {
    const adapter = loadAdapter(async url => String(url).includes('/billing/balance')
      ? json({ data: { balance_micro: micro } }) : json({ summary: { cost_micro: 0, requests: 0, total_tokens: 0 } }));
    const result = await adapter.getBalance(record());
    assert.equal(result.balance, expected);
    assert.equal(result.accountStats.todayCost, 0);
    assert.equal(result.accountStats.todayRequests, 0);
    assert.equal(result.accountStats.averageDurationMs, null);
  }
});

test('missing or invalid balances and HTML responses cannot be recognized as a connected account', async () => {
  for (const value of [undefined, null, '', ' ', 'invalid', true, {}, [], 'Infinity']) {
    const adapter = loadAdapter(async () => json({ balance_micro: value }));
    await assert.rejects(adapter.getBalance(record()), /balance_micro/);
  }
  for (const body of [{}, { id: {} }, { id: '' }, []]) {
    const adapter = loadAdapter(async () => json(body));
    await assert.rejects(adapter.detect(record()), /账户资料响应格式无效/);
  }
  const adapter = loadAdapter(async () => new Response('<html>Sign in</html>'));
  await assert.rejects(adapter.detect(record()), /响应无效/);
});

test('unavailable or incomplete usage statistics preserve balance and do not invent spending', async () => {
  for (const reply of [() => json({ error: { message: 'not found' } }, 404), () => { throw new Error('timeout'); },
    () => json({}), () => json({ summary: { requests: 2 } })]) {
    const adapter = loadAdapter(async url => String(url).includes('/billing/balance') ? json({ balance_micro: 1234 }) : reply());
    const result = await adapter.getBalance(record());
    assert.equal(result.balance, 0.001234);
    assert.ok(result.accountStats == null || result.accountStats.todayCost == null);
  }
});

test('expired credentials and rate limits return meaningful errors without login or refresh attempts', async () => {
  for (const status of [401, 429]) {
    let calls = 0;
    const adapter = loadAdapter(async () => { calls += 1; return json({ error: { message: 'login required' } }, status); });
    await assert.rejects(adapter.getBalance(record()), error => error.status === status
      && error.rateLimited === (status === 429) && (status !== 401 || /重新连接账户/.test(error.message)));
    assert.equal(calls, 1);
  }
  const adapter = loadAdapter(() => { throw new Error('must not send a request'); });
  await assert.rejects(adapter.detect({ ...record(), accountToken: '' }), error => error.code === 'balance_adapter_not_configured');
});

test('key import reads full keys and names directly without prefix changes or reveal requests', async () => {
  let calls = 0;
  const adapter = loadAdapter(async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://account.test/api/keys');
    assert.ok(options.method == null || options.method === 'GET');
    assert.equal(options.headers.Authorization, 'Bearer test-account-access-token');
    return json({ data: [{ id: 1, name: '绘图', key: 'sk-test-drawing-key' },
      { id: 2, name: '文本', key: 'opaque-test-text-key' },
      { id: 3, name: 'masked', prefix: 'sk-partial' },
      { id: 4, name: 'masked', key: 'sk-test••••' }, { key: 'sk-test...'}, { key: 'sk-test****' }] });
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await adapter.getApiKeys(record()))), [
    { name: '绘图', key: 'sk-test-drawing-key' }, { name: '文本', key: 'opaque-test-text-key' }
  ]);
  assert.equal(calls, 1);
  for (const body of [{ data: [] }, { data: [{ prefix: 'sk-masked' }] }, { items: [] }]) {
    await assert.rejects(loadAdapter(async () => json(body)).getApiKeys(record()), /密钥/);
  }
});

test('captures the console storage token, falls back from old adapters and stops probing on 429', async () => {
  const adapter = loadAdapter(async url => {
    if (String(url).endsWith('/users/me')) return json({ id: 17 });
    if (String(url).endsWith('/billing/balance')) return json({ balance_micro: 1234567 });
    return json({ summary: { cost_micro: 100 } });
  });
  const context = loadMain({ 'new-api': missingAdapter('new-api'), sub2api: missingAdapter('sub2api'), aihub: adapter });
  const credentials = await context.readSub2apiCredentials({ webContents: {
    session: { cookies: { get: async () => [] } },
    executeJavaScript: async () => [{ key: 'aihub_lang', value: 'zh' }, { key: 'aihub_token', value: record().accountToken }]
  } }, 'https://account.test');
  assert.equal(credentials.accountToken, record().accountToken);
  assert.equal(credentials.accountRefreshToken, '');
  const detected = await context.detectAccountAdapter(record(), credentials);
  assert.equal(detected.adapter.id, 'aihub');
  assert.equal(detected.accountData.balance, 1.234567);
  assert.equal(detected.credentials.accountToken, record().accountToken);
  context.balanceAdapters['new-api'].detect = async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); };
  context.balanceAdapters.aihub.detect = () => { throw new Error('must not continue probing'); };
  await assert.rejects(context.detectAccountAdapter(record(), credentials), error => error.status === 429);
});

test('connecting saves the detected adapter and allows balance refresh and imports for saved accounts and drafts', async () => {
  const adapter = loadAdapter(async url => {
    if (String(url).endsWith('/users/me')) return json({ id: 17 });
    if (String(url).endsWith('/billing/balance')) return json({ balance_micro: 1234567 });
    if (String(url).endsWith('/keys')) return json({ data: [{ name: '文本', key: 'test-key' }] });
    return json({ summary: { cost_micro: 123 } });
  });
  const context = loadMain({ 'new-api': missingAdapter('new-api'), sub2api: missingAdapter('sub2api'), aihub: adapter });
  const handlers = {};
  let persisted = 0;
  let closed = 0;
  class LoginWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.session = { cookies: { get: async () => [] } };
      this.webContents.executeJavaScript = async () => [{ key: 'aihub_token', value: record().accountToken }];
    }
    isDestroyed() { return this.destroyed || false; }
    loadURL() { setImmediate(() => this.webContents.emit('did-finish-load')); }
    setTitle() {}
    close() { this.destroyed = true; closed += 1; this.emit('closed'); }
  }
  Object.assign(context, {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, BrowserWindow: LoginWindow,
    mainWindow: null, state: { providers: [record()], balanceSettings: { lowThreshold: 0.1 } },
    normalizeProvider: value => ({ ...value }), cleanBaseUrl: value => String(value || ''),
    sub2apiOrigin: value => new URL(value.loginUrl).origin,
    getProviderAdapter: value => context.balanceAdapters[value.balanceAdapter],
    safeState: () => context.state, persist: () => { persisted += 1; },
    balanceStatus: () => 'normal', setInterval: () => 1, clearInterval: () => {},
    setTimeout: fn => setTimeout(fn, 0)
  });
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('connect-provider-account'"), source.indexOf('function makeWindow(')), context);
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('import-provider-tokens'"), source.indexOf("ipcMain.handle('chat-request'")), context);
  const saved = await handlers['connect-provider-account'](null, record().id);
  await new Promise(setImmediate);
  assert.equal(saved.ok, true);
  assert.equal(saved.state.providers[0].balanceAdapter, 'aihub');
  assert.equal(saved.state.providers[0].balance.balance, 1.234567);
  assert.equal(saved.state.providers[0].accountStats.todayCost, 0.000123);
  assert.equal(persisted, 1);
  assert.equal((await adapter.getBalance(saved.state.providers[0])).balance, 1.234567);
  const imported = await handlers['import-provider-tokens'](null, record().id);
  assert.equal(imported.ok, true);
  assert.equal(imported.tokens[0].key, 'test-key');
  assert.equal(persisted, 2);
  const draft = await handlers['connect-provider-account'](null, { provider: record() });
  await new Promise(setImmediate);
  assert.equal(draft.ok, true);
  assert.equal(draft.provider.balanceAdapter, 'aihub');
  assert.equal(draft.provider.balance.balance, 1.234567);
  const draftImported = await handlers['import-provider-tokens'](null, { provider: { ...record(), ...draft.provider } });
  assert.equal(draftImported.ok, true);
  assert.equal(draftImported.tokens[0].name, '文本');
  assert.equal(persisted, 2);
  assert.equal(closed, 2);
});
