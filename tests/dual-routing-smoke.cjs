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
const state = { ...config('first'), secondaryRouting: config('second'), thirdRouting: { ...config('third'), routingEnabled: false, routingMode: 'model', unifiedRoute: {}, keyRoute: {} }, balanceSettings: {},
  providers: ['first', 'second', 'third'].map(id => ({ id, name: '测试站点 ' + id, loginUrl: 'https://example.invalid', models: [id + '-model'],
    apiKey: id + '-key', apiKeys: [{ key: id + '-key', remark: id + '账户', enabled: true }] })) };
let saved;
const context = vm.createContext({ state, ipcMain,
  persist: () => { saved = JSON.parse(JSON.stringify(state)); return true; }, safeState: () => ({...JSON.parse(JSON.stringify(state)),lanUrls:['http://192.168.0.11:8787/v1']}),
  setRoutingLanAccess: async (enabled, group) => {
    if (context.lanFails) throw new Error('Test LAN bind failed');
    (group===3?state.thirdRouting:group===2?state.secondaryRouting:state).lanAccess=enabled===true;
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
  assert.deepEqual(await execute(`Array.from(document.querySelectorAll('.routing-group-tab'), el=>el.textContent)`), ['路由设置1', '路由设置2', '路由设置3']);
  assert.equal(await execute(`document.querySelectorAll('#unifiedUrl').length`), 1);
  const visibleGroups = () => execute(`Array.from(document.querySelectorAll('.routing-group')).filter(group=>group.checkVisibility()).map(group=>group.id)`);
  assert.deepEqual(await visibleGroups(), ['routingGroup1']);
  const beforeViewing = JSON.stringify(state);
  for (const group of [2, 3, 1]) {
    await execute(`$('routingGroupTab${group}').click()`);
    assert.deepEqual(await visibleGroups(), ['routingGroup' + group]);
    assert.equal(await execute(`$('routingGroupTab${group}').getAttribute('aria-selected')`), 'true');
    assert.equal(JSON.stringify(state), beforeViewing);
  }
  await execute(`$('routingGroupTab1').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`);
  assert.deepEqual(await visibleGroups(), ['routingGroup3']);
  await execute(`$('routingGroupTab3').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
  assert.deepEqual(await visibleGroups(), ['routingGroup1']);
  assert.equal(await execute(`$('routingEnabled3').checked`), false);
  assert.equal(await execute(`$('unifiedKey3').textContent`), state.thirdRouting.unifiedKey);
  await execute(`$('routingGroupTab3').click(); $('routingEnabled3').click()`);
  await until(`appState.thirdRouting.routingEnabled===true`);
  await execute(`$('routingMode3').value='key'; $('routingMode3').dispatchEvent(new Event('change'))`);
  await until(`Boolean($('keyRouteProvider3'))`);
  await execute(`$('keyRouteProvider3').value='third'; $('keyRouteProvider3').dispatchEvent(new Event('change'))`);
  await until(`!$('keyRouteProvider3').disabled && $('keyRouteProvider3').value==='third'`);
  await execute(`$('keyRouteKey3').value='0'; $('keyRouteKey3').dispatchEvent(new Event('change'))`);
  await until(`!$('keyRouteKey3').disabled && appState.thirdRouting.keyRoute.models.includes('third-model')`);
  await execute(`$('routingMode3').value='model'; $('routingMode3').dispatchEvent(new Event('change'))`);
  await until(`Boolean($('routes3').querySelector('select'))`);
  await execute(`const thirdModel=$('routes3').querySelector('select[data-model="third-model"]');thirdModel.value='third';thirdModel.dispatchEvent(new Event('change'))`);
  await until(`appState.thirdRouting.routes['third-model']==='third'`);
  await execute(`$('routingMode3').value='unified'; $('routingMode3').dispatchEvent(new Event('change'))`);
  await until(`Boolean($('unifiedProvider3'))`);
  await execute(`$('unifiedProvider3').value='third';$('unifiedProvider3').dispatchEvent(new Event('change'))`);
  await until(`!$('unifiedProvider3').disabled && $('unifiedProvider3').value==='third'`);
  await execute(`$('unifiedKeySelect3').value='0';$('unifiedKeySelect3').dispatchEvent(new Event('change'))`);
  await until(`!$('unifiedTargetModel3').disabled && $('unifiedTargetModel3').options.length===2`);
  await execute(`$('unifiedTargetModel3').value='third-model';$('unifiedTargetModel3').dispatchEvent(new Event('change'))`);
  await until(`appState.thirdRouting.unifiedRoute.model==='third-model'`);
  await execute(`$('routingLanAccess3').click();$('routingRequestFormatEnabled3').click()`);
  await until(`!$('routingLanAccess3').disabled && !$('routingRequestFormatEnabled3').disabled && appState.thirdRouting.lanAccess && appState.thirdRouting.requestFormatEnabled`);
  assert.equal(saved.thirdRouting.unifiedRoute.apiKey, 'third-key');
  assert.equal(state.unifiedRoute.model, 'first-model');
  assert.equal(state.secondaryRouting.unifiedRoute.model, 'second-model');
  await capture('routing-group3.png');
  const thirdBefore = JSON.stringify(state.thirdRouting);
  await execute(`$('routingGroupTab1').click();render()`);
  assert.deepEqual(await visibleGroups(), ['routingGroup1']);
  assert.equal(await execute(`$('unifiedKey').textContent`), state.unifiedKey);
  assert.equal(await execute(`$('unifiedKey2').textContent`), state.secondaryRouting.unifiedKey);
  assert.equal(await execute(`!$('routingRequestFormatEnabled').checked && !$('routingRequestFormatEnabled2').checked && $('routingRequestFormat').disabled && $('routingRequestFormat2').disabled`), true);
  await execute(`$('routingRequestFormatEnabled2').click()`);
  await until(`!$('routingRequestFormatEnabled2').disabled && appState.secondaryRouting.requestFormatEnabled===true`);
  assert.equal(state.requestFormatEnabled, undefined);
  assert.equal(saved.secondaryRouting.requestFormatEnabled, true);
  await execute(`$('routingRequestFormat2').value='chat/completions'; $('routingRequestFormat2').dispatchEvent(new Event('change'))`);
  await until(`!$('routingRequestFormat2').disabled && appState.secondaryRouting.requestFormat==='chat/completions'`);
  assert.equal(saved.secondaryRouting.requestFormat, 'chat/completions');
  await execute(`$('routingRequestFormatEnabled').click()`);
  await until(`!$('routingRequestFormatEnabled').disabled && appState.requestFormatEnabled===true`);
  assert.equal(state.requestFormat, 'responses');
  assert.equal(state.secondaryRouting.requestFormat, 'chat/completions');
  await execute(`$('routingRequestFormatEnabled2').click()`);
  await until(`!$('routingRequestFormatEnabled2').disabled && !appState.secondaryRouting.requestFormatEnabled`);
  assert.equal(await execute(`$('routingRequestFormat2').disabled && $('routingRequestFormat2').value==='chat/completions' && !$('routingRequestFormat').disabled`), true);
  await execute(`$('routingRequestFormatEnabled2').click()`);
  await until(`!$('routingRequestFormat2').disabled`);
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
  await execute(`$('routingGroupTab2').click()`);
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
  await execute(`$('routingTab').click(); $('routingGroupTab2').click(); $('closePanel').click()`);
  await until(`$('panel').classList.contains('hidden')`);
  await execute(`$('openSettings').click()`);
  await until(`!$('panel').classList.contains('hidden')`);
  assert.deepEqual(await pageVisibility(), {providers:false,routing:true,selected:'routingTab'});
  assert.equal(await execute(`$('unifiedTargetModel2').value`), 'second-model');
  assert.deepEqual(await visibleGroups(), ['routingGroup2']);
  assert.equal(JSON.stringify(state.thirdRouting), thirdBefore);
  await capture('routing-page.png');
  for (const width of [400, 450, 500]) {
    await execute(`$('panel').style.width='${width}px'; $('routingGroup2').scrollIntoView({block:'end'});`);
    assert.equal(await execute(`(() => { const group=$('routingGroup2'); const description=$('routingModeDescription2').getBoundingClientRect(); const checkbox=$('routingEnabled2').getBoundingClientRect(); return group.scrollWidth<=group.clientWidth && Math.abs(description.left-checkbox.left)<2; })()`), true);
    assert.equal(await execute(`Array.from(document.querySelectorAll('.routing-group:not(.hidden) .request-format-row')).every(row=>row.scrollWidth<=row.clientWidth && row.querySelector('input').getBoundingClientRect().top<row.querySelector('select').getBoundingClientRect().bottom)`), true);
    assert.equal(await execute(`(() => {const tabs=document.querySelector('.routing-group-tabs');const buttons=Array.from(tabs.children);return tabs.scrollWidth<=tabs.clientWidth && buttons.every(button=>button.getBoundingClientRect().top===buttons[0].getBoundingClientRect().top)})()`), true);
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
  console.log('PASS: three route tabs, keyboard navigation, preserved selection, independent settings, copy buttons and narrow layout.');
  console.log('Screenshot: ' + path.join(output, 'two-route-groups.png'));
}
run().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
