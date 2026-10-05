const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const os = require('node:os');
const crypto = require('node:crypto');

const output = fs.mkdtempSync(path.join(os.tmpdir(), 'api-pet-no-balance-'));
app.setPath('userData', path.join(output, 'browser'));
const resultPath = path.join(os.tmpdir(), 'api-pet-no-balance-result.json');
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const state = {
  unifiedKey: 'test-only', routingEnabled: false, routes: {}, unifiedRoute: {},
  balanceSettings: { lowThreshold: 5, refreshMinutes: 10 }, providers: []
};
const balanceCalls = [];
const modelCalls = [];
const activity = [];
let timerCallback;
let window;
const context = vm.createContext({
  state, ipcMain, crypto, AbortController, setTimeout, clearTimeout,
  setInterval: callback => { timerCallback = callback; return 1; }, clearInterval: () => {},
  mainWindow: { isDestroyed: () => false, webContents: { send: (_event, active) => activity.push(active) } },
  activeBalanceQueries: 0, balanceTimer: null,
  balanceAdapters: { custom: { getBalance: async provider => {
    balanceCalls.push(provider.id); return { balance: 42 };
  } } },
  providerBaseUrls: provider => [provider.requestUrl || provider.loginUrl],
  fetch: async url => {
    modelCalls.push(url); return { ok: true, text: async () => JSON.stringify({ data: [{ id: 'test-model' }] }) };
  },
  providerModels: provider => provider.models || [],
  persist: () => fs.writeFileSync(path.join(output, 'state.json'), JSON.stringify(state))
});
function includeFunction(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing function ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(1).search(/^(?:async )?function |^let |^ipcMain\./m);
  vm.runInContext(next < 0 ? rest : rest.slice(0, next + 1), context);
}
[
  'safeState', 'cleanBaseUrl', 'todayKey', 'normalizeDailyStats', 'cleanSessionToken',
  'cleanAccountUserId', 'normalizeProvider', 'selectProviderApiKey', 'modelFetch', 'fetchModels',
  'testProvider', 'balanceStatus', 'getProviderAdapter', 'queryProviderBalance',
  'refreshAllBalances', 'scheduleBalanceRefresh'
].forEach(includeFunction);
vm.runInContext(source.slice(source.indexOf("ipcMain.handle('save-provider'"), source.indexOf("ipcMain.handle('delete-provider'")), context);
ipcMain.handle('get-state', () => context.safeState());
ipcMain.handle('get-balance-activity', () => false);
ipcMain.handle('set-panel-open', () => true);
ipcMain.handle('test-provider', (_event, id) => context.testProvider(id));
ipcMain.handle('refresh-provider-balance', (_event, id) => context.queryProviderBalance(id));
ipcMain.handle('refresh-all-balances', () => context.refreshAllBalances());

async function run() {
  const draft = { name: 'Saved site', loginUrl: 'https://example.invalid', apiKey: 'test-key', balanceAdapter: 'none',
    accountStats: { todayCost: 99, todayRequests: 9 }, balance: { balance: 99, status: 'low', error: 'stale error' } };
  state.providers.push(context.normalizeProvider({ ...draft, id: 'saved', models: ['test-model'], status: 'online' }));
  state.providers.push(context.normalizeProvider({ ...draft, name: 'Balance site', id: 'regular', balanceAdapter: 'custom' }));
  assert.equal(state.providers[0].balance.balance, null);
  assert.equal(state.providers[0].balance.error, '');
  assert.equal(state.providers[0].accountStats, null);
  await context.queryProviderBalance('saved');
  assert.equal(balanceCalls.length, 0);
  assert.equal(activity.length, 0);
  await context.refreshAllBalances();
  assert.deepEqual(balanceCalls, ['regular']);
  context.scheduleBalanceRefresh();
  await timerCallback();
  // The interval callback starts an async refresh without returning its promise.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(balanceCalls, ['regular', 'regular']);
  // Exercise changing an existing balance-enabled site, including its cached data.
  state.providers[0] = context.normalizeProvider({ ...state.providers[0], balanceAdapter: 'custom',
    balance: { balance: 99, status: 'low', error: 'stale error' },
    accountStats: { todayCost: 99, todayRequests: 9 } });

  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 490, height: 650, webPreferences: {
    preload: path.join(__dirname, '../src/preload.js'), partition: `no-balance-${Date.now()}`,
    contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false
  } });
  await window.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  const execute = code => window.webContents.executeJavaScript(code);
  const waitFor = expression => execute(`(async () => {
    for (let i = 0; i < 100; i++) { if (${expression}) return true; await new Promise(r => setTimeout(r, 20)); }
    throw new Error('Condition timeout: ' + ${JSON.stringify(expression)});
  })()`);
  await waitFor("document.querySelector('.provider-card .edit')");
  await execute(`document.querySelector('#openSettings').click(); document.querySelector('.provider-card .edit').click()`);
  assert.equal(await execute(`document.querySelector('.app').classList.contains('provider-dialog-open') && getComputedStyle(document.querySelector('#pet')).display !== 'none' && getComputedStyle(document.querySelector('#pet')).pointerEvents === 'none' && getComputedStyle(document.querySelector('.pet-image')).webkitAppRegion !== 'drag'`), true, 'Provider dialog keeps the pet visible without its draggable hit region');
  await execute(`document.querySelector('#balanceAdapter').value = 'none'; document.querySelector('#balanceAdapter').dispatchEvent(new Event('change'))`);
  const fields = ['balanceUrlField', 'balanceMethodField', 'balancePathField', 'remainingPathField', 'accountTokenField', 'accountUserIdField', 'connectAccountInDialog', 'importProviderTokens'];
  const hidden = async () => execute(`(${JSON.stringify(fields)}).every(id => getComputedStyle(document.getElementById(id)).display === 'none') && getComputedStyle(document.getElementById('currency').closest('label')).display === 'none'`);
  assert.equal(await hidden(), true);
  assert.equal(await execute(`document.querySelector('#balanceAdapter').value`), 'none');
  await execute(`document.querySelector('.add-token').click()`);
  assert.equal(await hidden(), true, 'Adding a Key must keep account import hidden');
  await execute(`document.querySelector('#balanceAdapter').value = 'custom'; document.querySelector('#balanceAdapter').dispatchEvent(new Event('change'))`);
  assert.equal(await execute(`getComputedStyle(document.querySelector('#balanceUrlField')).display !== 'none' && getComputedStyle(document.querySelector('#currency').closest('label')).display !== 'none'`), true);
  await execute(`document.querySelector('#balanceAdapter').value = 'new-api'; document.querySelector('#balanceAdapter').dispatchEvent(new Event('change'))`);
  assert.equal(await execute(`getComputedStyle(document.querySelector('#accountUserIdField')).display !== 'none' && getComputedStyle(document.querySelector('#connectAccountInDialog')).display !== 'none' && getComputedStyle(document.querySelector('#balanceUrlField')).display === 'none'`), true);
  await execute(`document.querySelector('#balanceAdapter').value = 'none'; document.querySelector('#balanceAdapter').dispatchEvent(new Event('change')); document.querySelector('#saveProvider').click()`);
  await waitFor("!document.querySelector('#providerDialog').open && document.querySelector('.provider-card .badge.online')");
  assert.equal(await execute(`getComputedStyle(document.querySelector('#pet')).display !== 'none' && getComputedStyle(document.querySelector('#pet')).pointerEvents !== 'none'`), true, 'Closing Provider dialog restores the pet interaction');
  assert.equal(state.providers[0].balanceAdapter, 'none');
  assert.equal(state.providers[0].balance.balance, null, 'Editing must discard old balance');
  assert.equal(modelCalls.length, 1, 'Saving still tests the model endpoint');
  assert.deepEqual(Array.from(state.providers[0].models), ['test-model']);
  const persisted = JSON.parse(fs.readFileSync(path.join(output, 'state.json'), 'utf8'));
  const reloaded = context.normalizeProvider(persisted.providers[0]);
  assert.equal(reloaded.balanceAdapter, 'none');
  assert.equal(reloaded.balance.status, 'disabled');
  assert.equal(await execute(`!document.querySelector('.provider-card').querySelector('.balance-line, .balance-meta, .refresh-balance, .connect-account')`), true);
  assert.equal(await execute(`!!document.querySelectorAll('.provider-card')[1].querySelector('.refresh-balance')`), true);
  await execute(`document.querySelector('.provider-card .edit').click()`);
  assert.equal(await hidden(), true, 'Reopening must restore hidden fields');
  assert.equal(await execute(`getComputedStyle(document.querySelector('#quickEntryField')).display`), 'none', 'Quick entry is for adding sites');
  await execute(`document.querySelector('#providerDialog .dialog-actions .ghost').click(); document.querySelector('#toggleProviders').click()`);
  assert.equal(await execute(`document.querySelector('.provider-compact-balance').textContent`), '$-.----');
  assert.equal(await execute(`document.querySelector('.provider-card-compact .edit') === null`), true, 'Compact provider cards keep the original controls');
  await execute(`document.querySelector('.provider-card-compact .compact-toggle').click(); document.querySelector('.provider-card:not(.provider-card-compact) .edit').click()`);
  assert.equal(await execute(`document.querySelector('#providerDialog').open`), true, 'Editing works in expanded provider cards');
  await execute(`document.querySelector('#providerDialog .dialog-actions .ghost').click()`);
  await execute(`window.apiPet.refreshProviderBalance('saved'); window.apiPet.refreshAllBalances()`);
  assert.ok(balanceCalls.every(id => id === 'regular'));
  await execute(`document.querySelector('#addProvider').click()`);
  assert.equal(await execute(`getComputedStyle(document.querySelector('#quickEntryField')).display !== 'none' && Boolean(document.querySelector('#quickEntryField').compareDocumentPosition(document.querySelector('#providerName')) & Node.DOCUMENT_POSITION_FOLLOWING)`), true);
  await execute(`document.querySelector('#quickEntry').value = 'sk-xxxxxxxxxxxxxxxxxxx [https://xxx.xxxr.xxx/](https://xxx.xxxr.xxx/)'; document.querySelector('#recognizeProvider').click()`);
  assert.deepEqual(await execute(`['providerName', 'loginUrl', 'token-key-0'].map(id => document.getElementById(id).value)`), ['xxxr', 'https://xxx.xxxr.xxx', 'sk-xxxxxxxxxxxxxxxxxxx']);
  assert.equal(state.providers.length, 2, 'Recognition must not save or test');
  assert.equal(modelCalls.length, 1);
  const quickLayout = await execute(`(() => {
    const row = document.querySelector('.quick-entry-row');
    const input = document.querySelector('#quickEntry').getBoundingClientRect();
    const button = document.querySelector('#recognizeProvider').getBoundingClientRect();
    return { overflow: row.scrollWidth > row.clientWidth, overlaps: input.right > button.left };
  })()`);
  assert.deepEqual(quickLayout, { overflow: false, overlaps: false });
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 200));
  fs.writeFileSync(path.join(output, 'quick-entry.png'), (await window.webContents.capturePage()).toPNG());
  await execute(`document.querySelector('#quickEntry').value = '无法识别'; document.querySelector('#recognizeProvider').click()`);
  assert.equal(await execute(`document.querySelector('#token-key-0').value`), 'sk-xxxxxxxxxxxxxxxxxxx', 'Invalid input keeps recognized fields');
  await execute(`(() => {
    const input = document.querySelector('#quickEntry'); input.value = ''; input.focus();
    const data = new DataTransfer(); data.setData('text/plain', '**站点名称**：快速站点\\n**Endpoint**：https://api.example.invalid/\\n**API Key**：sk-new-key');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);
  assert.deepEqual(await execute(`['providerName', 'loginUrl', 'token-key-0'].map(id => document.getElementById(id).value)`), ['快速站点', 'https://api.example.invalid', 'sk-new-key']);
  await execute(`document.querySelector('#balanceAdapter').value = 'none'; document.querySelector('#balanceAdapter').dispatchEvent(new Event('change')); document.querySelector('#saveProvider').click()`);
  await waitFor("document.querySelectorAll('.provider-card').length === 3 && !document.querySelector('#providerDialog').open");
  assert.equal(state.providers[2].name, '快速站点');
  assert.equal(state.providers[2].loginUrl, 'https://api.example.invalid');
  assert.equal(state.providers[2].apiKeys[0].key, 'sk-new-key');
  await execute(`document.querySelector('#addProvider').click()`);
  assert.equal(await execute(`document.querySelector('#quickEntry').value`), '', 'New dialogs clear the pasted text');
  fs.writeFileSync(resultPath, JSON.stringify({ passed: true, output, checks: [
    'manual and periodic balance skip', 'regular balance query', 'stale cache cleared',
    'hidden fields and Key edits', 'type switching', 'save and reload', 'model test retained',
    'expanded and collapsed cards', 'quick entry recognition and layout', 'multiline paste and Enter', 'quick entry save and reset'
  ] }, null, 2));
}
const timeout = setTimeout(() => {
  fs.writeFileSync(resultPath, JSON.stringify({ passed: false, error: 'timeout' })); app.exit(1);
}, 25000);
run().then(() => { clearTimeout(timeout); window?.destroy(); app.exit(0); }).catch(error => {
  fs.writeFileSync(resultPath, JSON.stringify({ passed: false, error: error.stack }));
  clearTimeout(timeout); window?.destroy(); app.exit(1);
});
