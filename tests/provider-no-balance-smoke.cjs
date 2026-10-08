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
const accountConnectionInputs = [];
const accountImportInputs = [];
let timerCallback;
let window;
let detectedCurrency = '';
let detectionFails = false;
let rotatedCredentials;
let batchQueryHold;
let releaseBatchQuery;
let batchIpcFails = false;
let batchIpcCalls = 0;
const context = vm.createContext({
  accountSessions: { restore() {} },
  ...require('../src/provider-currency'),
  state, app, ipcMain, crypto, AbortController, setTimeout, clearTimeout,
  setInterval: callback => { timerCallback = callback; return 1; }, clearInterval: () => {},
  mainWindow: { isDestroyed: () => false, webContents: { send: (_event, active) => activity.push(active) } },
  activeBalanceQueries: 0, balanceTimer: null,
  balanceAdapters: { custom: { getBalance: async provider => {
    balanceCalls.push(provider.id);
    if (batchQueryHold) await batchQueryHold;
    if (provider.id === 'batch-failed') throw new Error('Test balance failure');
    return { balance: 42 };
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
  'unifiedRouteKey', 'normalizeUnifiedRoute',
  'testProvider', 'balanceStatus', 'getProviderAdapter', 'queryProviderBalance',
  'refreshAllBalances', 'scheduleBalanceRefresh'
].forEach(includeFunction);
vm.runInContext(source.slice(source.indexOf("ipcMain.handle('save-provider'"), source.indexOf("ipcMain.handle('delete-provider'")), context);
ipcMain.handle('get-state', () => context.safeState());
ipcMain.handle('detect-provider-currency', async () => {
  const currentCredentials = rotatedCredentials;
  await new Promise(resolve => setTimeout(resolve, 30));
  return detectionFails ? { ok: false, error: 'Test currency failure' }
    : { ok: true, detectedCurrency, currencyDetection: detectedCurrency ? 'detected' : 'failed', credentials: currentCredentials };
});
ipcMain.handle('get-balance-activity', () => false);
ipcMain.handle('set-panel-open', () => true);
ipcMain.handle('test-provider', (_event, id) => context.testProvider(id));
ipcMain.handle('refresh-provider-balance', (_event, id) => context.queryProviderBalance(id));
ipcMain.handle('refresh-all-balances', () => {
  batchIpcCalls += 1;
  if (batchIpcFails) throw new Error('Test batch IPC failure');
  return context.refreshAllBalances();
});
ipcMain.handle('connect-provider-account', (_event, input) => {
  accountConnectionInputs.push(input);
  if (!['sub2api', 'new-api', 'aihub'].includes(input.provider?.balanceAdapter)) {
    return { ok: false, error: '当前站点类型不支持账户登录', state: context.safeState() };
  }
  return { ok: true, state: context.safeState(), provider: {
    ...input.provider, accountToken: 'connected-token', accountRefreshToken: 'connected-refresh',
    accountUserId: '17', accountStats: { todayCost: 0.5 },
    balance: { balance: 12.34, currency: '€', configured: true, status: 'normal' },
    currencyMode: 'auto', currency: '€', detectedCurrency: '€', currencyDetection: 'detected'
  } };
});
ipcMain.handle('import-provider-tokens', (_event, input) => {
  accountImportInputs.push(input);
  assert.equal(input.provider.accountToken, 'connected-token');
  assert.ok(['sub2api', 'new-api', 'aihub'].includes(input.provider.balanceAdapter));
  return { ok: true, tokens: [{ key: 'imported-key', name: 'Connected account' }] };
});

async function run() {
  const defaultProvider = context.normalizeProvider({ loginUrl: 'https://example.invalid',
    balance: { balance: 99 }, accountStats: { todayCost: 99 } });
  assert.equal(defaultProvider.balanceAdapter, 'none');
  assert.equal(defaultProvider.balance.balance, null);
  assert.equal(defaultProvider.accountStats, null);
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
    throw new Error('Condition timeout: ' + ${JSON.stringify(expression)} + '; currency=' + $('currencyStatus').textContent + '; dialog=' + $('providerDialog').open);
  })()`);
  await waitFor("document.querySelector('.provider-card .edit')");
  await execute(`document.querySelector('#openSettings').click(); document.querySelector('.provider-card .edit').click()`);
  assert.equal(await execute(`document.querySelector('#balanceAdapter').value`), 'none', 'Legacy custom sites use a supported choice when editing');
  assert.equal(await execute(`document.querySelector('.app').classList.contains('provider-dialog-open') && getComputedStyle(document.querySelector('#pet')).display !== 'none' && getComputedStyle(document.querySelector('#pet')).pointerEvents === 'none' && getComputedStyle(document.querySelector('.pet-image')).webkitAppRegion !== 'drag'`), true, 'Provider dialog keeps the pet visible without its draggable hit region');
  await execute(`document.querySelector('#balanceAdapter').value = 'none'; document.querySelector('#balanceAdapter').dispatchEvent(new Event('change'))`);
  const fields = ['balanceUrlField', 'balanceMethodField', 'balancePathField', 'accountTokenField', 'accountUserIdField', 'connectAccountInDialog', 'importProviderTokens'];
  const hidden = async () => execute(`(${JSON.stringify(fields)}).every(id => getComputedStyle(document.getElementById(id)).display === 'none') && getComputedStyle(document.getElementById('currency').closest('label')).display === 'none'`);
  assert.equal(await hidden(), true);
  assert.equal(await execute(`document.querySelector('#balanceAdapter').value`), 'none');
  await execute(`document.querySelector('.add-token').click()`);
  assert.equal(await hidden(), true, 'Adding a Key must keep account import hidden');
  assert.deepEqual(await execute(`Array.from(document.querySelector('#balanceAdapter').options, option => option.value)`), ['none', 'sub2api', 'new-api', 'aihub']);
  await execute(`document.querySelector('#balanceAdapter').value = 'new-api'; document.querySelector('#balanceAdapter').dispatchEvent(new Event('change'))`);
  await waitFor(`$('currencyMode').value === 'auto' && $('currencyStatus').textContent.includes('未检测到币种')`);
  assert.equal(await execute(`$('currencyMode').value === 'auto' && getComputedStyle($('currency')).display === 'none'`), true);
  detectedCurrency = '€';
  await execute(`detectProviderCurrency()`);
  assert.equal(await execute(`$('currencyStatus').textContent`), '已检测：€');
  await execute(`$('currencyField').scrollIntoView({block:'center'})`);
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 150));
  fs.writeFileSync(path.join(output, 'currency-auto.png'), (await window.webContents.capturePage()).toPNG());
  rotatedCredentials = { accountToken: 'rotated-during-detection', accountRefreshToken: 'rotated-refresh' };
  detectedCurrency = '$';
  await execute(`window.currencyPendingTest = detectProviderCurrency(); $('currencyMode').value = 'manual'; $('currencyMode').onchange(); $('currency').value = '积分';`);
  await execute(`window.currencyPendingTest`);
  assert.equal(await execute(`$('currency').value`), '积分', 'Late detection cannot replace the manual input');
  assert.equal(await execute(`draftDetectedCurrency`), '€', 'Late detection cannot change detected currency after switching to manual');
  assert.equal(await execute(`$('accountToken').value`), 'rotated-during-detection', 'Token rotations are retained even after switching to manual');
  rotatedCredentials = undefined; detectedCurrency = '€';
  await execute(`$('currencyMode').value = 'manual'; $('currencyMode').onchange(); $('currency').value = '积分';`);
  assert.equal(await execute(`getComputedStyle($('currency')).display !== 'none' && $('currency').required`), true);
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 150));
  fs.writeFileSync(path.join(output, 'currency-manual.png'), (await window.webContents.capturePage()).toPNG());
  await execute(`$('saveProvider').click()`);
  await waitFor(`!$('providerDialog').open && !appRoot.classList.contains('provider-dialog-open')`);
  assert.equal(state.providers[0].currencyMode, 'manual');
  assert.equal(state.providers[0].currency, '积分');
  assert.equal(state.providers[0].detectedCurrency, '€');
  await execute(`openEdit(appState.providers[0])`);
  assert.equal(await execute(`$('currencyMode').value === 'manual' && $('currency').value === '积分'`), true);
  detectionFails = true;
  await execute(`$('currencyMode').value = 'auto'; $('currencyMode').onchange();`);
  await waitFor(`$('currencyStatus').textContent.includes('未检测到币种')`);
  assert.equal(await execute(`$('currencyStatus').textContent.includes('保留 €')`), true);
  detectionFails = false;
  await execute(`(async () => { await detectProviderCurrency(); $('saveProvider').click(); })()`);
  await waitFor(`!$('providerDialog').open && !appRoot.classList.contains('provider-dialog-open')`);
  assert.equal(state.providers[0].currencyMode, 'auto');
  assert.equal(state.providers[0].currency, '€');
  await execute(`openEdit(appState.providers[0])`);
  assert.equal(await execute(`getComputedStyle(document.querySelector('#accountUserIdField')).display !== 'none' && getComputedStyle(document.querySelector('#connectAccountInDialog')).display !== 'none' && getComputedStyle(document.querySelector('#balanceUrlField')).display === 'none'`), true);
  await execute(`document.querySelector('#balanceAdapter').value = 'none'; document.querySelector('#balanceAdapter').dispatchEvent(new Event('change')); document.querySelector('#saveProvider').click()`);
  await waitFor("!document.querySelector('#providerDialog').open && !document.querySelector('.app').classList.contains('provider-dialog-open') && document.querySelector('.provider-card .badge.online')");
  assert.equal(await execute(`getComputedStyle(document.querySelector('#pet')).display !== 'none' && getComputedStyle(document.querySelector('#pet')).pointerEvents !== 'none'`), true, 'Closing Provider dialog restores the pet interaction');
  assert.equal(state.providers[0].balanceAdapter, 'none');
  assert.equal(state.providers[0].balance.balance, null, 'Editing must discard old balance');
  assert.equal(modelCalls.length, 3, 'Saving still tests the model endpoint');
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
  assert.equal(await execute(`$('refreshAllAccounts').textContent`), '一键刷新账户');
  assert.equal(await execute(`$('refreshAllProviderBalances').textContent`), '一键刷新余额');
  const balanceCallsBeforeBatchButton = balanceCalls.length;
  await execute(`$('refreshAllProviderBalances').click()`);
  await waitFor(`!refreshingAllBalances`);
  assert.equal(balanceCalls.length, balanceCallsBeforeBatchButton + 1, 'Batch balance button refreshes queryable sites');
  assert.equal(await execute(`$('toast').textContent.includes('跳过 1 个')`), true);
  assert.equal(await execute(`document.querySelector('.provider-compact-balance').textContent`), '€-.----');
  assert.equal(await execute(`document.querySelector('.provider-card-compact .edit') === null`), true, 'Compact provider cards keep the original controls');
  await execute(`document.querySelector('.provider-card-compact .compact-toggle').click(); document.querySelector('.provider-card:not(.provider-card-compact) .edit').click()`);
  assert.equal(await execute(`document.querySelector('#providerDialog').open`), true, 'Editing works in expanded provider cards');
  await execute(`document.querySelector('#providerDialog .dialog-actions .ghost').click()`);
  await execute(`window.apiPet.refreshProviderBalance('saved'); window.apiPet.refreshAllBalances()`);
  assert.ok(balanceCalls.every(id => id === 'regular'));
  await execute(`document.querySelector('#addProvider').click()`);
  assert.equal(await execute(`document.querySelector('#balanceAdapter').value`), 'none', 'New sites default to saving only');
  assert.equal(await hidden(), true, 'New sites hide balance and account fields');
  assert.equal(await execute(`getComputedStyle(document.querySelector('#quickEntryField')).display !== 'none' && Boolean(document.querySelector('#quickEntryField').compareDocumentPosition(document.querySelector('#providerName')) & Node.DOCUMENT_POSITION_FOLLOWING)`), true);
  await execute(`document.querySelector('#quickEntry').value = 'sk-xxxxxxxxxxxxxxxxxxx [https://xxx.xxxr.xxx/](https://xxx.xxxr.xxx/)'; document.querySelector('#recognizeProvider').click()`);
  assert.deepEqual(await execute(`['providerName', 'loginUrl', 'token-key-0'].map(id => document.getElementById(id).value)`), ['xxxr', 'https://xxx.xxxr.xxx', 'sk-xxxxxxxxxxxxxxxxxxx']);
  assert.equal(state.providers.length, 2, 'Recognition must not save or test');
  assert.equal(modelCalls.length, 3);
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
  await execute(`document.querySelector('#saveProvider').click()`);
  await waitFor("document.querySelectorAll('.provider-card').length === 3 && !document.querySelector('#providerDialog').open");
  assert.equal(state.providers[2].name, '快速站点');
  assert.equal(state.providers[2].balanceAdapter, 'none', 'Saving without changing the type skips balance queries');
  assert.equal(state.providers[2].loginUrl, 'https://api.example.invalid');
  assert.equal(state.providers[2].apiKeys[0].key, 'sk-new-key');
  await execute(`document.querySelector('#addProvider').click()`);
  assert.equal(await execute(`document.querySelector('#quickEntry').value`), '', 'New dialogs clear the pasted text');
  await execute(`dialog.close('cancel')`);
  for (const type of ['sub2api', 'new-api', 'aihub']) {
    await execute(`openEdit(appState.providers[0]); $('balanceAdapter').value = '${type}'; $('balanceAdapter').dispatchEvent(new Event('change'));`);
    await execute(`$('connectAccountInDialog').onclick()`);
    assert.equal(accountConnectionInputs.at(-1).id, 'saved');
    assert.equal(accountConnectionInputs.at(-1).provider.balanceAdapter, type);
    assert.equal(await execute(`$('accountToken').value`), 'connected-token');
    assert.equal(await execute(`draftAccountData.balance.balance`), 12.34);
    assert.equal(state.providers[0].balanceAdapter, 'none', 'Connection in edit dialog remains a draft');
    await execute(`$('importProviderTokens').click()`);
    await waitFor(`!$('importProviderTokens').disabled`);
    assert.equal(accountImportInputs.at(-1).provider.balanceAdapter, type);
    assert.equal(await execute(`providerTokenRows[0].key`), 'imported-key');
    await execute(`dialog.close('cancel')`);
    assert.equal(state.providers[0].balanceAdapter, 'none', 'Cancel keeps the original saved-only type');
    assert.equal(state.providers[0].balance.balance, null);
    assert.equal(state.providers[0].apiKeys[0].key, 'test-key');
  }
  await execute(`openEdit(appState.providers[0]); $('balanceAdapter').value = 'aihub'; $('balanceAdapter').dispatchEvent(new Event('change'));`);
  await execute(`$('connectAccountInDialog').onclick()`);
  await execute(`$('saveProvider').click()`);
  await waitFor(`!dialog.open && document.querySelector('.provider-card .badge.online')`);
  assert.equal(state.providers[0].balanceAdapter, 'aihub');
  assert.equal(state.providers[0].accountToken, 'connected-token');
  assert.equal(state.providers[0].accountRefreshToken, 'connected-refresh');
  assert.equal(state.providers[0].balance.balance, 12.34, 'Saving retains newly connected account balance');
  assert.equal(state.providers[0].accountStats.todayCost, 0.5);
  assert.equal(context.normalizeProvider(JSON.parse(fs.readFileSync(path.join(output, 'state.json'), 'utf8')).providers[0]).balance.balance, 12.34);
  state.providers = [context.normalizeProvider({id:'batch-skipped',name:'Saved only',balanceAdapter:'none'}),
    context.normalizeProvider({id:'batch-failed',name:'Failed balance',balanceAdapter:'custom'}),
    context.normalizeProvider({id:'batch-success',name:'Good balance',balanceAdapter:'custom'})];
  await execute(`(async()=>{appState=await window.apiPet.getState();render();$('panel').querySelector('.panel-scroll').scrollTop=0;})()`);
  for (const width of [400, 500]) {
    await execute(`$('panel').style.width='${width}px'`);
    const heading = await execute(`(()=>{const account=$('refreshAllAccounts').getBoundingClientRect(),balance=$('refreshAllProviderBalances').getBoundingClientRect(),title=$('providers').previousElementSibling;return {right:account.right<=balance.left,sameRow:account.top===balance.top,overflow:title.scrollWidth>title.clientWidth,buttonOverflow:$('refreshAllProviderBalances').scrollWidth>$('refreshAllProviderBalances').clientWidth};})()`);
    assert.deepEqual(heading,{right:true,sameRow:true,overflow:false,buttonOverflow:false});
    await new Promise(resolve=>setTimeout(resolve,100));
    window.webContents.invalidate();
    fs.writeFileSync(path.join(output,`balance-heading-${width}.png`),(await window.webContents.capturePage()).toPNG());
  }
  batchQueryHold = new Promise(resolve=>{releaseBatchQuery=resolve;});
  const ipcBefore = batchIpcCalls;
  const queryBefore = balanceCalls.length;
  await execute(`window.batchPending=$('refreshAllProviderBalances').onclick();void 0;`);
  assert.equal(await execute(`$('refreshAllProviderBalances').disabled && $('refreshAllBalances').disabled && manualBalanceQueries===1`),true);
  await execute(`render();$('refreshAllBalances').onclick()`);
  assert.equal(batchIpcCalls,ipcBefore+1,'Both controls share the running lock even after render');
  releaseBatchQuery();batchQueryHold=null;
  await execute(`window.batchPending`);
  assert.deepEqual(balanceCalls.slice(queryBefore),['batch-failed','batch-success'],'A failed site does not stop later queries');
  assert.equal(await execute(`$('toast').textContent`),'余额刷新完成：成功 1 个，失败 1 个，跳过 1 个');
  assert.equal(await execute(`manualBalanceQueries===0 && !$('refreshAllProviderBalances').disabled && !$('refreshAllBalances').disabled`),true);
  assert.equal(state.providers[1].balance.apiStatus,'error');
  assert.equal(state.providers[2].balance.balance,42);
  batchIpcFails=true;
  await execute(`$('refreshAllProviderBalances').onclick()`);
  assert.equal(await execute(`$('toast').textContent.includes('Test batch IPC failure') && !refreshingAllBalances && manualBalanceQueries===0`),true);
  batchIpcFails=false;
  state.providers=state.providers.slice(0,1);
  await execute(`(async()=>{appState=await window.apiPet.getState();render();})()`);
  assert.equal(await execute(`$('refreshAllProviderBalances').disabled && $('refreshAllBalances').disabled`),true);
  fs.writeFileSync(resultPath, JSON.stringify({ passed: true, output, checks: [
    'manual and periodic balance skip', 'regular balance query', 'stale cache cleared',
    'hidden fields and Key edits', 'type switching', 'save and reload', 'model test retained',
    'automatic currency detection', 'failed detection fallback', 'manual currency save and reopen', 'late detection and token rotation isolation',
    'saved-only site switches to all three account types', 'draft token import', 'cancel preserves original site', 'save retains connected credentials and balance',
    'expanded and collapsed cards', 'quick entry recognition and layout', 'multiline paste and Enter', 'quick entry save and reset',
    'batch button placement at both widths', 'batch query skip and partial failure', 'batch controls share execution lock', 'batch error recovery and empty targets'
  ] }, null, 2));
}
const timeout = setTimeout(() => {
  fs.writeFileSync(resultPath, JSON.stringify({ passed: false, error: 'timeout' })); app.exit(1);
}, 25000);
run().then(() => { clearTimeout(timeout); window?.destroy(); app.exit(0); }).catch(error => {
  fs.writeFileSync(resultPath, JSON.stringify({ passed: false, error: error.stack }));
  clearTimeout(timeout); window?.destroy(); app.exit(1);
});
