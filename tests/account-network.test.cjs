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
    require: () => ({ accountFetch: async (url, options) => {
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
