const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function loadNetwork(electron, netFetch, nodeFetch) {
  const source = fs.readFileSync(path.join(__dirname, '../src/providers/base.js'), 'utf8');
  const context = vm.createContext({
    module: { exports: {} },
    process: { versions: electron ? { electron: '31' } : {} },
    require: name => {
      if (name === '../provider-currency') return require('../src/provider-currency');
      if (name === '../account-session-context') return require('../src/account-session-context');
      assert.equal(name, 'electron');
      return { net: { fetch: netFetch } };
    },
    fetch: nodeFetch
  });
  vm.runInContext(source, context);
  return context.module.exports.accountFetch;
}

test('desktop account requests use Chromium networking with explicit provider cookies only', async () => {
  const options = { method: 'POST', headers: { Cookie: 'test_session=value', Authorization: 'Bearer test-token' },
    body: '{"refresh_token":"test"}', signal: new AbortController().signal, credentials: 'include' };
  let calls = 0;
  const fetchAccount = loadNetwork(true, async (url, actual) => {
    calls += 1;
    assert.equal(url, 'https://account.test/api/v1/auth/refresh');
    assert.equal(actual.credentials, 'omit');
    assert.equal(actual.bypassCustomProtocolHandlers, true);
    assert.equal(actual.headers, options.headers);
    assert.equal(actual.body, options.body);
    assert.equal(actual.method, 'POST');
    assert.equal(actual.signal, options.signal);
    return new Response('ok');
  }, () => { throw new Error('Node networking must not be used in Electron'); });
  assert.equal(await (await fetchAccount('https://account.test/api/v1/auth/refresh', options)).text(), 'ok');
  assert.equal(calls, 1);
});

test('non-desktop adapter tests and tools retain native fetch', async () => {
  const options = { headers: { Accept: 'application/json' } };
  const fetchAccount = loadNetwork(false, () => { throw new Error('Electron must not be loaded'); }, async (url, actual) => {
    assert.equal(url, 'https://account.test');
    assert.equal(actual, options);
    return new Response('ok');
  });
  assert.equal(await (await fetchAccount('https://account.test', options)).text(), 'ok');
});

test('New API balance and token imports also use the account network transport', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/providers/new-api.js'), 'utf8');
  const calls = [];
  const context = vm.createContext({
    module: { exports: {} }, URL, AbortController, setTimeout, clearTimeout,
    require: () => ({ ...require('../src/providers/base'), accountFetch: async (url, options) => {
      const pathname = new URL(url).pathname;
      calls.push(pathname);
      assert.equal(options.headers.Authorization, 'Bearer test-account-token');
      assert.equal(options.headers['New-Api-User'], '123');
      const data = pathname === '/api/user/self' ? { quota: 500000 }
        : pathname === '/api/token/' ? { items: [{ id: 1, name: 'test', key: 'sk-te********st' }] }
          : pathname === '/api/token/1/key' ? { key: 'test-key' } : {};
      if (pathname.endsWith('/key')) assert.equal(options.method, 'POST');
      return new Response(JSON.stringify({ success: true, data }));
    } })
  });
  vm.runInContext(source, context);
  const adapter = context.module.exports;
  const record = { loginUrl: 'https://account.test', accountToken: 'test-account-token', accountUserId: '123' };
  assert.equal((await adapter.getBalance(record)).balance, 1);
  assert.equal((await adapter.getApiKeys(record))[0].key, 'sk-test-key');
  assert.equal(calls.length, 5);
});

test('New API user logs provide today usage when performance stats are admin-only', async () => {
  const now = Math.floor(Date.now() / 1000);
  const adapterSource = fs.readFileSync(path.join(__dirname, '../src/providers/new-api.js'), 'utf8');
  const items = [
    { type: 2, created_at: now, quota: 28125, prompt_tokens: 5, completion_tokens: 2048, use_time: 15 },
    { type: 2, created_at: now, quota: 28125, prompt_tokens: 582, completion_tokens: 2048, use_time: 18 },
    { type: 2, created_at: now, quota: 28125, prompt_tokens: 649, completion_tokens: 2048, use_time: 15 },
    { type: 2, created_at: now, quota: 25000, prompt_tokens: 649, completion_tokens: 2048, use_time: 26 },
    { type: 2, created_at: now, quota: 5000, prompt_tokens: 639, completion_tokens: 1158, use_time: 21 },
    { type: 5, created_at: now, quota: 0, prompt_tokens: 0, completion_tokens: 0, use_time: 0 }
  ];
  const context = vm.createContext({
    module: { exports: {} }, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, Date,
    require: () => ({ ...require('../src/providers/base'), accountFetch: async (url, options) => {
      const request = new URL(url);
      const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
      if (request.pathname === '/api/user/self') return reply({ success: true, data: { quota: 500000 } });
      if (request.pathname.startsWith('/api/performance/')) return reply({ message: 'admin only' }, 403);
      if (request.pathname === '/api/log/self') return reply({ success: true, data: { page: 1, page_size: 100, total: items.length, items } });
      throw new Error(`unexpected request: ${request.pathname}`);
    } })
  });
  vm.runInContext(adapterSource, context);
  const result = await context.module.exports.getBalance({ loginUrl: 'https://account.test', accountToken: 'test-token', accountUserId: '123' });
  assert.equal(result.accountStats.todayRequests, 5);
  assert.equal(result.accountStats.todayTokens, 11874);
  assert.equal(result.accountStats.todayCost, 0.22875);
  assert.equal(result.accountStats.averageDurationMs, 19000);
});

test('New API overlapping balance queries and key imports share refresh cookie rotation', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/providers/new-api.js'), 'utf8');
  let refreshCount = 0;
  const context = vm.createContext({
    module: { exports: {} }, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    require: () => ({ ...require('../src/providers/base'), accountFetch: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/user/auth/refresh') {
        refreshCount += 1;
        assert.equal(options.headers.Cookie, 'new_api_refresh=old-cookie');
        await new Promise(setImmediate);
        return new Response(JSON.stringify({ success: true, data: { access_token: 'fresh-account-access-token' } }), {
          headers: { 'Set-Cookie': 'new_api_refresh=rotated-cookie; Path=/; HttpOnly' }
        });
      }
      if (options.headers.Authorization !== 'Bearer fresh-account-access-token') {
        await new Promise(setImmediate);
        return new Response('{"message":"expired"}', { status: 401 });
      }
      assert.equal(options.headers.Cookie, 'new_api_refresh=rotated-cookie');
      const data = pathname === '/api/user/self' ? { quota: 500000 }
        : pathname === '/api/token/' ? { items: [{ name: 'test', key: 'sk-test' }] } : {};
      return new Response(JSON.stringify({ success: true, data }));
    } })
  });
  vm.runInContext(source, context);
  const record = { id: 'site', loginUrl: 'https://account.test', accountToken: 'expired-account-access-token', accountCookie: 'new_api_refresh=old-cookie' };
  const [balance, keys] = await Promise.all([context.module.exports.getBalance(record), context.module.exports.getApiKeys(record)]);
  assert.equal(balance.balance, 1);
  assert.equal(keys.length, 1);
  assert.equal(record.accountCookie, 'new_api_refresh=rotated-cookie');
  assert.equal(refreshCount, 1);
});
