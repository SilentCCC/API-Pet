const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const currency = require('../src/provider-currency');

function adapter(name, fetch) {
  const filename = path.join(__dirname, `../src/providers/${name}.js`);
  const realRequire = createRequire(filename);
  const context = vm.createContext({ module: { exports: {} }, URL, AbortController, setTimeout, clearTimeout,
    fetch, require: name => name === './base' ? { ...realRequire(name), accountFetch: fetch } : realRequire(name) });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
  return context.module.exports;
}

test('currency settings migrate existing symbols, detect explicit fields and retain manual overrides', () => {
  assert.equal(currency.currencySettings({ currency: '$' }).currencyMode, 'auto');
  assert.equal(currency.currencySettings({ currency: '￥' }).currencyMode, 'manual');
  assert.equal(currency.detectCurrency({ data: { currency_code: 'CNY' } }), '￥');
  assert.equal(currency.detectCurrency({ currency: 'not a currency', data: { currency_symbol: '€' } }), '€');
  assert.equal(currency.detectCurrency({ name: 'USD', country: 'CN', balance: 1 }), '');
  assert.equal(currency.detectCurrency({ currency: 'XYZ' }), '');
  const provider = { currencyMode: 'auto' };
  currency.rememberCurrency(provider, currency.balanceCurrency(provider, [{ currency: 'EUR' }]));
  assert.equal(provider.currency, '€');
  currency.rememberCurrency(provider, currency.balanceCurrency(provider, [{}]));
  assert.equal(provider.currency, '€');
  assert.equal(provider.currencyDetection, 'failed');
  provider.currencyMode = 'manual'; provider.currency = '积分';
  currency.rememberCurrency(provider, currency.balanceCurrency(provider, [{ currency: 'USD' }]));
  assert.equal(provider.currency, '积分');
  assert.equal(provider.detectedCurrency, '$');
});

test('Sub2API detects profile currency, headers and failure without inventing a successful detection', async () => {
  const provider = { loginUrl: 'https://example.invalid', accountToken: 'test', currencyMode: 'auto', currency: '$' };
  for (const [body, header, expected] of [
    [{ data: { balance: 7, currency: 'CNY' } }, '', '￥'],
    [{ data: { balance: 7 } }, 'EUR', '€'],
    [{ currency_code: 'GBP', data: { balance: 7 } }, '', '£'],
    [{ data: { balance: 7 } }, '', '']
  ]) {
    const sub = adapter('sub2api', async url => Response.json(String(url).includes('/user/profile') ? body : {}, { headers: { 'x-currency': header } }));
    const result = await sub.getBalance(provider);
    assert.equal(result.balance, 7);
    assert.equal(result.detectedCurrency, expected);
    assert.equal(result.currencyDetection, expected ? 'detected' : 'failed');
    assert.equal(result.currency, expected || '$');
  }
});

test('New API and AIHub keep numeric scaling and known currency; custom detects response currency', async () => {
  const provider = { loginUrl: 'https://example.invalid', accountToken: 'test', currencyMode: 'auto' };
  const newApi = adapter('new-api', async url => Response.json({ success: true, data: String(url).endsWith('/api/user/self') ? { quota: 500000 } : {} }));
  const converted = await newApi.getBalance(provider);
  assert.equal(converted.balance, 1); assert.equal(converted.detectedCurrency, '$');
  const hub = adapter('aihub', async url => Response.json(String(url).includes('/billing/balance') ? { balance_micro: 1000000 } : {}));
  assert.equal((await hub.getBalance(provider)).detectedCurrency, '$');
  const custom = adapter('custom', async () => Response.json({ data: { balance: 8, currency_code: 'EUR' } }));
  assert.equal((await custom.getBalance({ balanceUrl: 'https://example.invalid/balance', currencyMode: 'auto' })).currency, '€');
  assert.equal((await hub.getBalance({ ...provider, currencyMode: 'manual', currency: '￥' })).currency, '￥');
});

test('balance refresh persists detected currency and preserves explicit manual currency across reload', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const provider = { id: 'test', balanceAdapter: 'sub2api', currencyMode: 'auto', currency: '$', balance: {} };
  let result = { balance: 8, ...currency.balanceCurrency(provider, [{ currency: 'EUR' }]) };
  let persisted;
  const state = { providers: [provider], balanceSettings: { lowThreshold: 1 } };
  const context = vm.createContext({ ...currency, state, activeBalanceQueries: 0, mainWindow: null,
    selectProviderApiKey() {}, normalizeProvider: value => ({ ...value, ...currency.currencySettings(value) }),
    getProviderAdapter: () => ({ getBalance: async () => result }), balanceStatus: () => 'online',
    safeState: () => state, persist: () => { persisted = JSON.stringify(state); } });
  vm.runInContext(source.slice(source.indexOf('async function queryProviderBalance('), source.indexOf('async function refreshAllBalances(')), context);
  await context.queryProviderBalance('test');
  assert.equal(provider.currency, '€'); assert.equal(provider.balance.currency, '€');
  assert.equal(currency.currencySettings(JSON.parse(persisted).providers[0]).currency, '€');
  provider.currencyMode = 'manual'; provider.currency = '积分';
  result = { balance: 8, ...currency.balanceCurrency(provider, [{ currency: 'USD' }]) };
  await context.queryProviderBalance('test');
  assert.equal(provider.currency, '积分'); assert.equal(provider.balance.currency, '积分');
});

test('draft currency detection isolates unsaved settings and persists only original account token rotations', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const original = { id: 'test', loginUrl: 'https://example.invalid', balanceAdapter: 'sub2api',
    accountToken: 'old', accountRefreshToken: 'refresh', currencyMode: 'manual', currency: '积分', balance: { balance: 1 } };
  let provider = { ...original, balance: { ...original.balance } };
  const state = { providers: [provider] };
  const handlers = {};
  let saves = 0;
  let rotate = false;
  let fail = false;
  let concurrentUpdate = false;
  const context = vm.createContext({ ...currency, state,
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
    normalizeProvider: value => ({ ...value, ...currency.currencySettings(value) }),
    getProviderAdapter: () => ({ getBalance: async draft => {
      if (rotate) { draft.accountToken = 'rotated'; draft.accountRefreshToken = 'rotated-refresh'; }
      if (concurrentUpdate) provider.accountToken = 'new-login';
      if (fail) throw new Error('unavailable');
      return { balance: 99, ...currency.balanceCurrency(draft, [{ currency: 'EUR' }]) };
    } }), persist: () => { saves += 1; } });
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('detect-provider-currency'"), source.indexOf("ipcMain.handle('get-chat-models'")), context);
  const detect = handlers['detect-provider-currency'];
  const detected = await detect(null, { id: 'test' });
  assert.equal(detected.detectedCurrency, '€');
  assert.equal(provider.currency, '积分'); assert.equal(provider.balance.balance, 1); assert.equal(saves, 0);
  await detect(null, { id: 'test', accountToken: 'draft-token', currency: '£' });
  assert.equal(provider.accountToken, 'old'); assert.equal(saves, 0);
  rotate = true;
  await detect(null, { id: 'test', loginUrl: 'https://other.invalid' });
  assert.equal(provider.accountToken, 'old'); assert.equal(saves, 0);
  await detect(null, { id: 'test', accountUserId: 'different-account' });
  assert.equal(provider.accountToken, 'old'); assert.equal(saves, 0);
  const rotated = await detect(null, { id: 'test' });
  assert.equal(rotated.credentials.accountToken, 'rotated');
  assert.equal(provider.accountToken, 'rotated'); assert.equal(saves, 1);
  provider = { ...original }; state.providers[0] = provider;
  fail = true;
  const failed = await detect(null, { id: 'test' });
  assert.equal(failed.ok, false); assert.equal(failed.credentials.accountToken, 'rotated');
  assert.equal(provider.accountToken, 'rotated'); assert.equal(saves, 2);
  provider = { ...original }; state.providers[0] = provider;
  fail = false; concurrentUpdate = true;
  await detect(null, { id: 'test' });
  assert.equal(provider.accountToken, 'new-login'); assert.equal(saves, 2);
  assert.equal((await detect(null, { id: 'test', balanceAdapter: 'none' })).ok, false);
});
