const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const mainSource = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');

test('登录站点复用账户连接流程并保留登录窗口', () => {
  assert.match(mainSource, /ipcMain\.handle\('open-provider-login',\s*\(_e, input\) => connectProviderAccount\(input, \{ keepWindowOpen: true \}\)\)/);
  assert.match(mainSource, /async function connectProviderAccount\(input, \{ keepWindowOpen = false \} = \{\}\)/);
  assert.match(mainSource, /if \(settled && !keepWindowOpen && !loginWindow\.isDestroyed\(\)\) loginWindow\.close\(\);/);
  assert.match(rendererSource, /connectProviderAccount\(provider\.id, provider\.loginUrl \|\| provider\.baseUrl \|\| provider\.requestUrl \|\| '', \{ keepWindowOpen: true \}\)/);
});

function savedSiteLogin({ provider = {}, loadError } = {}) {
  const record = { id: 'saved-site', name: 'Saved site', balanceAdapter: 'none', loginUrl: 'https://site.invalid/login', ...provider };
  const windows = [];
  const unexpected = () => { throw new Error('Saved-only sites must not capture accounts or query balances'); };
  const context = vm.createContext({ URL, state: { providers: [record] }, mainWindow: null,
    safeState: () => ({ providers: [record] }), persist() {},
    accountSessions: { prepare: async () => ({ partition: 'persist:test-saved-site' }), attach: unexpected, run: unexpected },
    getProviderAdapter: unexpected, setInterval: unexpected,
    BrowserWindow: class {
      constructor(options) { this.options = options; windows.push(this); }
      async loadURL(url) { this.url = url; if (loadError) throw new Error(loadError); }
      isDestroyed() { return Boolean(this.closed); }
      close() { this.closed = true; }
    }
  });
  for (const name of ['cleanBaseUrl', 'sub2apiOrigin', 'connectProviderAccount']) {
    const start = mainSource.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    const rest = mainSource.slice(start);
    const end = rest.slice(1).search(/^(?:async )?function |^ipcMain\./m);
    vm.runInContext(rest.slice(0, end + 1), context);
  }
  return { windows, record, open: () => context.connectProviderAccount({ id: record.id }, { keepWindowOpen: true }),
    connect: () => context.connectProviderAccount(record.id) };
}

test('仅保存站点在内置窗口打开登录地址，不执行账户检测或查询', async () => {
  const fixture = savedSiteLogin();
  const before = JSON.stringify(fixture.record);
  const result = await fixture.open();
  assert.equal(result.ok, true);
  assert.equal(result.openedOnly, true);
  assert.equal(fixture.windows.length, 1);
  const window = fixture.windows[0];
  assert.equal(window.url, 'https://site.invalid/login');
  assert.equal(window.options.webPreferences.partition, 'persist:test-saved-site');
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.preload, undefined);
  assert.equal(window.isDestroyed(), false);
  assert.equal(JSON.stringify(fixture.record), before);
  assert.equal((await fixture.connect()).ok, false, 'Account connection remains unavailable');
  assert.equal(fixture.windows.length, 1);
});

test('仅保存站点缺少登录地址时使用请求地址，无效地址不会打开窗口', async () => {
  const fallback = savedSiteLogin({ provider: { loginUrl: '', requestUrl: 'https://models.invalid/v1' } });
  assert.equal((await fallback.open()).ok, true);
  assert.equal(fallback.windows[0].url, 'https://models.invalid/v1');
  for (const loginUrl of ['', 'invalid', 'file:///test', 'ftp://site.invalid']) {
    const fixture = savedSiteLogin({ provider: { loginUrl } });
    assert.equal((await fixture.open()).ok, false);
    assert.equal(fixture.windows.length, 0);
  }
});

test('仅保存站点加载失败时返回错误并关闭空窗口', async () => {
  const fixture = savedSiteLogin({ loadError: 'net::ERR_NAME_NOT_RESOLVED' });
  const result = await fixture.open();
  assert.equal(result.ok, false);
  assert.match(result.error, /登录页面加载失败.*ERR_NAME_NOT_RESOLVED/);
  assert.equal(fixture.windows[0].closed, true);
});
