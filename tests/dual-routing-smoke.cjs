const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'api-pet-dual-route-'));
app.setPath('userData', path.join(output, 'browser'));
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const config = id => ({ unifiedKey: 'pet-test-local-' + id, routingEnabled: true, routingMode: 'unified', routes: {},
  unifiedRoute: { providerId: id, apiKey: id + '-key', model: id + '-model', models: [id + '-model'] }, keyRoute: {} });
const state = { ...config('first'), secondaryRouting: config('second'), balanceSettings: {},
  providers: ['first', 'second'].map(id => ({ id, name: '测试站点 ' + id, loginUrl: 'https://example.invalid', models: [id + '-model'],
    apiKey: id + '-key', apiKeys: [{ key: id + '-key', remark: id + '账户', enabled: true }] })) };
let saved;
const context = vm.createContext({ state, ipcMain,
  persist: () => { saved = JSON.parse(JSON.stringify(state)); }, safeState: () => ({...JSON.parse(JSON.stringify(state)),lanUrls:['http://192.168.0.11:8787/v1']}),
  setRoutingLanAccess: async (enabled, group) => {
    if (context.lanFails) throw new Error('Test LAN bind failed');
    (group===2?state.secondaryRouting:state).lanAccess=enabled===true;
    context.persist(); return context.safeState();
  },
  providerModels: p => p.models, fetchModels: async (_provider, key) => { await new Promise(resolve => setTimeout(resolve, 30)); return [key.replace('-key', '-model')]; }
});
function include(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/^(?:async )?function |^let |^ipcMain\./m);
  vm.runInContext(end < 0 ? rest : rest.slice(0, end + 1), context);
}
['unifiedRouteKey', 'modelsForApiKey'].forEach(include);
vm.runInContext(source.slice(source.indexOf("ipcMain.handle('set-route'"), source.indexOf("ipcMain.handle('quit'")), context);
ipcMain.handle('get-state', () => context.safeState());
ipcMain.handle('get-balance-activity', () => false);
ipcMain.handle('set-panel-open', () => true);
let window;
async function run() {
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 550, height: 720, webPreferences: {
    preload: path.join(__dirname, '../src/preload.js'), offscreen: true, backgroundThrottling: false } });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
  await window.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  const execute = code => window.webContents.executeJavaScript(code);
  const capture = async filename => {
    window.webContents.invalidate();
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.writeFileSync(path.join(output, filename), (await window.webContents.capturePage()).toPNG());
  };
  const until = async code => {
    for (let i = 0; i < 120; i++) {
      if (await execute(code)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Timed out: ' + code);
  };
  await until(`$('unifiedProvider2') && $('unifiedProvider2').value === 'second'`);
  await execute(`$('panel').classList.remove('hidden'); document.querySelector('.app').classList.add('panel-open');`);
  const pageVisibility = () => execute(`({providers:$('providersPage').checkVisibility(),routing:$('routingPage').checkVisibility(),selected:document.querySelector('.panel-tab[aria-selected="true"]').id})`);
  assert.deepEqual(await pageVisibility(), {providers:true,routing:false,selected:'providersTab'});
  assert.equal(await execute(`$('providersPage').contains($('providers')) && $('providersPage').contains($('lowThreshold')) && !$('providersPage').contains($('localGateway'))`), true);
  await execute(`$('routingTab').click()`);
  assert.deepEqual(await pageVisibility(), {providers:false,routing:true,selected:'routingTab'});
  assert.equal(await execute(`['localGateway','routingGroup1','routingGroup2'].every(id=>$('routingPage').contains($(id)))`), true);
  await execute(`render()`);
  assert.deepEqual(await pageVisibility(), {providers:false,routing:true,selected:'routingTab'});
  assert.deepEqual(await execute(`Array.from(document.querySelectorAll('.routing-group>.section-title>span'), el=>el.textContent)`), ['路由设置1', '路由设置2']);
  assert.equal(await execute(`document.querySelectorAll('#unifiedUrl').length`), 1);
  assert.equal(await execute(`$('unifiedKey').textContent`), state.unifiedKey);
  assert.equal(await execute(`$('unifiedKey2').textContent`), state.secondaryRouting.unifiedKey);
  await execute(`window.copies=[]; Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.copies.push(text)}}); $('copyKey').click(); $('copyKey2').click();`);
  assert.deepEqual(await execute('window.copies'), [state.unifiedKey, state.secondaryRouting.unifiedKey]);
  assert.equal(await execute(`!$('routingLanAccess').checked && !$('routingLanAccess2').checked && $('lanAddresses').classList.contains('hidden') && $('lanAddresses2').classList.contains('hidden')`),true);
  await execute(`$('routingLanAccess2').click()`);
  await until(`!$('routingLanAccess2').disabled && appState.secondaryRouting.lanAccess===true`);
  assert.equal(state.lanAccess,undefined);
  assert.equal(saved.secondaryRouting.lanAccess,true);
  assert.equal(await execute(`$('lanAddresses2').textContent.includes('http://192.168.0.11:8787/v1') && $('lanAddresses').classList.contains('hidden')`),true);
  await execute(`$('lanAddresses2').querySelector('button').click()`);
  await until(`window.copies.at(-1)==='http://192.168.0.11:8787/v1'`);
  context.lanFails=true;
  await execute(`$('routingLanAccess').click()`);
  await until(`!$('routingLanAccess').disabled`);
  assert.equal(await execute(`$('routingLanAccess').checked`),false);
  context.lanFails=false;
  const firstBefore = JSON.stringify({ routingMode: state.routingMode, unifiedRoute: state.unifiedRoute, routes: state.routes });
  await execute(`$('routingMode2').value='key'; $('routingMode2').dispatchEvent(new Event('change'));`);
  await until(`$('keyRouteProvider2') && $('routingModeDescription2').textContent.includes('转换')`);
  await execute(`$('keyRouteProvider2').value='second'; $('keyRouteProvider2').dispatchEvent(new Event('change'));`);
  await until(`!$('keyRouteProvider2').disabled && $('keyRouteProvider2').value==='second'`);
  await execute(`$('keyRouteKey2').value='0'; $('keyRouteKey2').dispatchEvent(new Event('change'));`);
  await until(`!$('keyRouteKey2').disabled && appState.secondaryRouting.keyRoute.models.includes('second-model')`);
  assert.equal(state.secondaryRouting.keyRoute.apiKey, 'second-key');
  assert.equal(await execute(`getComputedStyle($('gatewayKeyField2')).display !== 'none'`), true);
  await execute(`$('routingMode2').value='model'; $('routingMode2').dispatchEvent(new Event('change'));`);
  await until(`$('routes2').querySelector('select') && !$('routes2').classList.contains('hidden')`);
  await execute(`const routeSelect=$('routes2').querySelector('select[data-model="second-model"]'); routeSelect.value='second'; routeSelect.dispatchEvent(new Event('change'));`);
  await until(`appState.secondaryRouting.routes['second-model']==='second'`);
  assert.equal(state.routes['second-model'], undefined);
  await execute(`$('routingMode2').value='unified'; $('routingMode2').dispatchEvent(new Event('change'));`);
  await until(`$('unifiedProvider2') && !$('unifiedRoute2').classList.contains('hidden')`);
  await execute(`$('unifiedKeySelect2').value='0'; $('unifiedKeySelect2').dispatchEvent(new Event('change'));`);
  await until(`!$('unifiedKeySelect2').disabled && $('unifiedTargetModel2').options.length===2`);
  await execute(`$('unifiedTargetModel2').value='second-model'; $('unifiedTargetModel2').dispatchEvent(new Event('change'));`);
  await until(`appState.secondaryRouting.unifiedRoute.model==='second-model'`);
  assert.equal(saved.secondaryRouting.unifiedRoute.model, 'second-model');
  assert.equal(JSON.stringify({ routingMode: state.routingMode, unifiedRoute: state.unifiedRoute, routes: state.routes }), firstBefore);
  await execute(`$('providersTab').click(); $('toggleProviders').click()`);
  const collapsedState = await execute(`$('providers').innerHTML`);
  for (const width of [400, 450, 500]) {
    await execute(`$('panel').style.width='${width}px'`);
    assert.equal(await execute(`(() => {const tabs=document.querySelector('.panel-tabs');return tabs.scrollWidth<=tabs.clientWidth && $('providersTab').getBoundingClientRect().top===$('routingTab').getBoundingClientRect().top})()`), true);
  }
  await execute(`$('panel').style.width='450px'`);
  await capture('providers-page.png');
  await execute(`$('routingTab').click(); $('providersTab').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));`);
  assert.deepEqual(await pageVisibility(), {providers:false,routing:true,selected:'routingTab'});
  await execute(`$('routingTab').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));`);
  assert.deepEqual(await pageVisibility(), {providers:true,routing:false,selected:'providersTab'});
  assert.equal(await execute(`$('providers').innerHTML`), collapsedState);
  await execute(`$('routingTab').click(); $('closePanel').click()`);
  await until(`$('panel').classList.contains('hidden')`);
  await execute(`$('openSettings').click()`);
  await until(`!$('panel').classList.contains('hidden')`);
  assert.deepEqual(await pageVisibility(), {providers:false,routing:true,selected:'routingTab'});
  assert.equal(await execute(`$('unifiedTargetModel2').value`), 'second-model');
  await capture('routing-page.png');
  for (const width of [400, 450, 500]) {
    await execute(`$('panel').style.width='${width}px'; $('routingGroup2').scrollIntoView({block:'end'});`);
    assert.equal(await execute(`(() => { const group=$('routingGroup2'); const description=$('routingModeDescription2').getBoundingClientRect(); const checkbox=$('routingEnabled2').getBoundingClientRect(); return group.scrollWidth<=group.clientWidth && Math.abs(description.left-checkbox.left)<2; })()`), true);
  }
  await execute(`$('routingEnabled2').checked=false; $('routingEnabled2').dispatchEvent(new Event('change'));`);
  await until(`appState.secondaryRouting.routingEnabled===false`);
  assert.equal(state.routingEnabled, true);
  assert.equal(await execute(`$('unifiedKey2').textContent`), 'pet-test-local-second');
  await execute(`$('panel').style.width='450px'; $('routingGroup2').scrollIntoView({block:'end'});`);
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 150));
  fs.writeFileSync(path.join(output, 'two-route-groups.png'), (await window.webContents.capturePage()).toPNG());
  assert.deepEqual(errors, []);
  console.log('PASS: panel tabs, keyboard navigation, preserved state, two route groups, copy buttons and narrow layout.');
  console.log('Screenshot: ' + path.join(output, 'two-route-groups.png'));
}
run().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
