const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');

function loadAdapter(fetch) {
  const source = fs.readFileSync(path.join(__dirname, '../src/providers/sub2api.js'), 'utf8');
  const adapterRequire = createRequire(path.join(__dirname, '../src/providers/sub2api.js'));
  const context = vm.createContext({ module: { exports: {} }, require: adapterRequire, fetch, URL, AbortController, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  return context.module.exports;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function provider() {
  return {
    loginUrl: 'https://sub.test/keys',
    accountToken: 'test-expired-access-token',
    accountRefreshToken: 'test-valid-refresh-token',
    accountCookie: 'server_session_test=test-cookie'
  };
}

test('imports four keys after refreshing an expired access token with JSON', async () => {
  const calls = [];
  const record = provider();
  const adapter = loadAdapter(async (url, options) => {
    const request = { url: String(url), ...options, headers: { ...options.headers } };
    calls.push(request);
    if (request.url.endsWith('/auth/refresh')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.equal(options.headers.Cookie, record.accountCookie);
      assert.equal(JSON.parse(options.body).refresh_token, 'test-valid-refresh-token');
      return json({ code: 0, data: {
        access_token: 'test-fresh-access-token', refresh_token: 'test-rotated-refresh-token'
      } });
    }
    const parsed = new URL(request.url);
    assert.equal(parsed.pathname, '/api/v1/keys');
    assert.equal(parsed.searchParams.get('page'), '1');
    assert.equal(parsed.searchParams.get('page_size'), '100');
    assert.equal(options.headers['X-User-UI-Request'], '1');
    if (options.headers.Authorization !== 'Bearer test-fresh-access-token') {
      return json({ code: 401, message: 'Token has expired' }, 401);
    }
    return json({ code: 0, data: { total: 4, items: Array.from({ length: 4 }, (_, id) => ({
      id, name: `key ${id}`, key: `sk-test-key-${id}`
    })) } });
  });
  const keys = await adapter.getApiKeys(record);
  assert.equal(keys.length, 4);
  assert.equal(keys[3].name, 'key 3');
  assert.equal(record.accountToken, 'test-fresh-access-token');
  assert.equal(record.accountRefreshToken, 'test-rotated-refresh-token');
  assert.equal(calls.length, 3);
});

test('concurrent profile and balance statistics share one refresh request', async () => {
  let refreshCount = 0;
  const record = provider();
  const adapter = loadAdapter(async (url, options) => {
    if (String(url).endsWith('/auth/refresh')) {
      refreshCount += 1;
      await new Promise(resolve => setImmediate(resolve));
      return json({ code: 0, data: { access_token: 'test-fresh-access-token', refresh_token: 'test-rotated-refresh-token' } });
    }
    if (options.headers.Authorization !== 'Bearer test-fresh-access-token') {
      return json({ code: 401, message: 'Token has expired' }, 401);
    }
    return json({ code: 0, data: String(url).endsWith('/user/profile')
      ? { balance: 0.78 }
      : { today_actual_cost: 0.01, today_requests: 3 } });
  });
  const balance = await adapter.getBalance(record);
  assert.equal(balance.balance, 0.78);
  assert.equal(balance.accountStats.todayRequests, 3);
  assert.equal(refreshCount, 1);
});

test('expired refresh token reports reconnect and never retries indefinitely', async () => {
  let calls = 0;
  const record = provider();
  const adapter = loadAdapter(async () => {
    calls += 1;
    return json({ code: 401, message: 'Token has expired' }, 401);
  });
  await assert.rejects(adapter.getApiKeys(record), error => error.status === 401 && /重新连接账户/.test(error.message));
  assert.equal(calls, 2);
  assert.equal(record.accountRefreshToken, 'test-valid-refresh-token');
});

test('overlapping balance queries and imports share refresh token rotation', async () => {
  let refreshCount = 0;
  const record = provider();
  const adapter = loadAdapter(async (url, options) => {
    if (String(url).endsWith('/auth/refresh')) {
      refreshCount += 1;
      await new Promise(resolve => setImmediate(resolve));
      return json({ code: 0, data: { access_token: 'test-fresh-access-token', refresh_token: 'test-rotated-refresh-token' } });
    }
    if (options.headers.Authorization !== 'Bearer test-fresh-access-token') return json({ message: 'Token has expired' }, 401);
    return json({ code: 0, data: String(url).includes('/keys?')
      ? { total: 1, items: [{ key: 'sk-test', name: 'test' }] }
      : String(url).endsWith('/user/profile') ? { balance: 0.78 }
        : { today_actual_cost: 0.01, today_requests: 3 } });
  });
  const [balance, keys] = await Promise.all([adapter.getBalance(record), adapter.getApiKeys(record)]);
  assert.equal(balance.balance, 0.78);
  assert.equal(keys.length, 1);
  assert.equal(refreshCount, 1);
});

test('existing Sub2API accounts without refresh tokens retain pagination and names', async () => {
  const record = provider();
  delete record.accountRefreshToken;
  let pages = 0;
  const adapter = loadAdapter(async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    pages += 1;
    return json({ code: 0, data: { total: 2, items: [{ key: `sk-test-${page}`, name: `key ${page}` }] } });
  });
  const keys = await adapter.getApiKeys(record);
  assert.equal(keys.length, 2);
  assert.equal(keys[1].name, 'key 2');
  assert.equal(pages, 2);
});

test('capture separates refresh_token from the Bearer token and prefers auth_token', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const helpers = source.slice(source.indexOf('function isJwt('), source.indexOf("ipcMain.handle('connect-provider-account'"));
  const context = vm.createContext({ URL });
  vm.runInContext(helpers, context);
  const loginWindow = { webContents: {
    session: { cookies: { get: async () => [{ name: 'server_session_test', value: 'test-session-cookie', path: '/', domain: 'sub.test' }] } },
    executeJavaScript: async () => [
      { key: 'refresh_token', value: 'test-valid-refresh-token' },
      { key: 'auth_user', value: JSON.stringify({ id: 123 }) },
      { key: 'auth_token', value: 'test-fresh-access-token' }
    ]
  } };
  const credentials = await context.readSub2apiCredentials(loginWindow, 'https://sub.test');
  assert.equal(credentials.accountToken, 'test-fresh-access-token');
  assert.equal(credentials.accountRefreshToken, 'test-valid-refresh-token');
  assert.equal(credentials.accountUserId, '123');
  assert.equal(credentials.accountCookie, 'server_session_test=test-session-cookie');
});

test('import returns rotated refresh tokens for the editor and persists saved accounts', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const handlerSource = source.slice(source.indexOf("ipcMain.handle('import-provider-tokens'"), source.indexOf("ipcMain.handle('chat-request'"));
  const record = { ...provider(), id: 'test-id', balanceAdapter: 'sub2api' };
  let handler;
  let persisted = 0;
  const context = vm.createContext({
    ipcMain: { handle: (_name, fn) => { handler = fn; } },
    state: { providers: [record] },
    normalizeProvider: value => ({ ...value }),
    persist: () => { persisted += 1; },
    getProviderAdapter: () => ({ getApiKeys: async value => {
      value.accountRefreshToken = 'test-rotated-refresh-token';
      value.accountToken = 'test-fresh-access-token';
      return [{ key: 'sk-test', name: 'test' }];
    } })
  });
  vm.runInContext(handlerSource, context);
  const result = await handler(null, record.id);
  assert.equal(result.ok, true);
  assert.equal(result.credentials.accountRefreshToken, 'test-rotated-refresh-token');
  assert.equal(persisted, 1);
  const draft = await handler(null, { provider: record });
  assert.equal(draft.credentials.accountRefreshToken, 'test-rotated-refresh-token');
  assert.equal(persisted, 1);
});
