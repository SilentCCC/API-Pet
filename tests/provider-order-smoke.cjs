const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const os = require('node:os');

const output = path.join(os.tmpdir(), 'api-pet-provider-order-check');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'browser'));
let window;
let persisted = 0;
const state = {
  unifiedKey: 'test-only', routingEnabled: false, routes: {}, unifiedRoute: {},
  balanceSettings: { lowThreshold: 5, refreshMinutes: 10 },
  providers: ['Alpha', 'A longer provider name', 'Gamma'].map((name, index) => ({
    id: String(index), name, status: 'online', balanceAdapter: 'custom', models: [], apiKeys: [],
    currency: '$', balance: { balance: 1234.56, status: 'normal' }, dailyStats: { cost: 0.1234 }
  }))
};

const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const handler = source.slice(source.indexOf("ipcMain.handle('move-provider'"), source.indexOf("ipcMain.handle('refresh-provider-balance'"));
vm.runInNewContext(handler, { ipcMain, state, safeState: () => structuredClone(state), persist: () => {
  persisted += 1;
  fs.writeFileSync(path.join(output, 'order.json'), JSON.stringify(state.providers.map(provider => provider.id)));
} });
ipcMain.handle('get-state', () => state);
ipcMain.handle('get-balance-activity', () => false);
ipcMain.handle('set-panel-open', () => true);

async function run() {
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 430, height: 650, webPreferences: {
    preload: path.join(__dirname, '../src/preload.js'), partition: `order-check-${Date.now()}`,
    contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false
  } });
  await window.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  const execute = code => window.webContents.executeJavaScript(code);
  await execute(`(async () => {
    for (let i = 0; i < 50 && !document.querySelector('#toggleProviders'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    document.querySelector('#openSettings').click();
    if (document.querySelector('#toggleProviders').textContent === '折叠全部') document.querySelector('#toggleProviders').click();
  })()`);
  const rows = await execute(`Array.from(document.querySelectorAll('.provider-card')).map(card => ({
    name: card.querySelector('.provider-compact-name').textContent,
    up: !!card.querySelector('[data-direction="up"]'), down: !!card.querySelector('[data-direction="down"]'),
    overflow: card.scrollWidth > card.clientWidth,
    children: Array.from(card.children).map(child => ({left: child.getBoundingClientRect().left, right: child.getBoundingClientRect().right}))
  }))`);
  assert.deepEqual(rows.map(row => [row.up, row.down]), [[false, true], [true, true], [true, false]]);
  assert.ok(rows.every(row => !row.overflow));
  for (const row of rows) for (let i = 1; i < row.children.length; i++) assert.ok(row.children[i - 1].right <= row.children[i].left);
  fs.writeFileSync(path.join(output, 'collapsed.png'), (await window.webContents.capturePage()).toPNG());

  await execute(`(async () => {
    document.querySelector('.provider-card [data-direction="down"]').click();
    for (let i = 0; i < 50 && document.querySelector('.provider-compact-name').textContent === 'Alpha'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  })()`);
  assert.deepEqual(state.providers.map(provider => provider.id), ['1', '0', '2']);
  assert.equal(persisted, 1);
  assert.equal(await execute(`document.querySelectorAll('.provider-card-compact').length`), 3);
  await execute(`(async () => {
    document.querySelectorAll('.provider-card')[1].querySelector('[data-direction="up"]').click();
    for (let i = 0; i < 50 && document.querySelector('.provider-compact-name').textContent !== 'Alpha'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  })()`);
  assert.deepEqual(state.providers.map(provider => provider.id), ['0', '1', '2']);
  assert.equal(persisted, 2);
  await execute(`window.apiPet.moveProvider({id:'0',direction:'up'})`);
  await execute(`window.apiPet.moveProvider({id:'2',direction:'down'})`);
  await execute(`window.apiPet.moveProvider({id:'missing',direction:'up'})`);
  assert.equal(persisted, 2);
  assert.deepEqual(state.providers.map(provider => provider.id), ['0', '1', '2']);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const point = async index => execute(`(() => {
    const rect = document.querySelectorAll('#providers .provider-card')[${index}].getBoundingClientRect();
    return { x: Math.round(rect.left + 30), y: Math.round(rect.top + rect.height / 2), bottom: Math.round(rect.bottom) };
  })()`);
  let pressed = false;
  const mouse = (type, p) => {
    if (type === 'mouseDown') pressed = true;
    window.webContents.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers: pressed ? ['leftButtonDown'] : [] });
    if (type === 'mouseUp') pressed = false;
  };
  let start = await point(0);
  let end = await point(2);
  mouse('mouseMove', start);
  mouse('mouseDown', start);
  await delay(450);
  assert.equal(await execute(`!!document.querySelector('.provider-sort-ghost')`), true, 'Long press starts dragging');
  mouse('mouseMove', { ...end, y: end.bottom - 1 });
  await delay(60);
  fs.writeFileSync(path.join(output, 'dragging.png'), (await window.webContents.capturePage()).toPNG());
  mouse('mouseUp', { ...end, y: end.bottom - 1 });
  await delay(150);
  assert.deepEqual(state.providers.map(provider => provider.id), ['1', '2', '0']);
  assert.equal(persisted, 3, 'Cross-row drag saves once');
  assert.equal(await execute(`document.querySelectorAll('#providers .provider-card-compact').length === 3 && !document.querySelector('.provider-sort-ghost')`), true);

  start = await point(2);
  end = await point(0);
  mouse('mouseDown', start);
  await delay(450);
  mouse('mouseMove', { ...end, y: end.y - 12 });
  await delay(60);
  await execute(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  mouse('mouseUp', end);
  assert.deepEqual(state.providers.map(provider => provider.id), ['1', '2', '0']);
  assert.deepEqual(await execute(`Array.from(document.querySelectorAll('#providers .provider-card')).map(row => row.dataset.providerId)`), ['1', '2', '0'], 'Escape restores original visual order');
  assert.equal(persisted, 3);

  start = await point(0);
  mouse('mouseDown', start);
  mouse('mouseUp', start);
  await delay(450);
  assert.equal(await execute(`!!document.querySelector('.provider-sort-ghost')`), false, 'Short press does not drag');
  mouse('mouseDown', start);
  await delay(50);
  mouse('mouseMove', { ...start, y: start.y + 15 });
  await delay(450);
  assert.equal(await execute(`!!document.querySelector('.provider-sort-ghost')`), false, 'Movement before long press cancels drag');
  mouse('mouseUp', start);

  start = await point(2);
  end = await point(0);
  mouse('mouseDown', start);
  await delay(450);
  mouse('mouseMove', { ...end, y: end.y - 12 });
  await delay(60);
  mouse('mouseUp', { ...end, y: end.y - 12 });
  await delay(150);
  assert.deepEqual(state.providers.map(provider => provider.id), ['0', '1', '2']);
  assert.equal(persisted, 4, 'Dragging upward also saves once');
  await execute(`window.apiPet.moveProvider({id:'0',targetIndex:-1}); window.apiPet.moveProvider({id:'0',targetIndex:99}); window.apiPet.moveProvider({id:'0',targetIndex:0})`);
  assert.equal(persisted, 4, 'Invalid and unchanged drag positions do not persist');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'order.json'), 'utf8')), ['0', '1', '2']);
  for (let i = 3; i < 15; i++) state.providers.push({ ...state.providers[0], id: String(i), name: `Site ${i}` });
  await execute(`(async () => { appState = await window.apiPet.getState(); render(); document.querySelector('.panel-scroll').scrollTop = 0; })()`);
  start = await point(0);
  end = await execute(`(() => { const rect = document.querySelector('.panel-scroll').getBoundingClientRect(); return {x: 70, y: Math.round(rect.bottom - 8)}; })()`);
  mouse('mouseDown', start);
  await delay(450);
  mouse('mouseMove', end);
  await delay(250);
  assert.equal(await execute(`document.querySelector('.panel-scroll').scrollTop > 0`), true, 'Dragging at the panel edge scrolls the list');
  await execute(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  mouse('mouseUp', end);
  assert.equal(persisted, 4, 'Cancelling after autoscroll does not save');
  state.providers.splice(3);
  await execute(`(async () => { appState = await window.apiPet.getState(); render(); document.querySelector('.panel-scroll').scrollTop = 0; })()`);
  await execute(`document.querySelector('#toggleProviders').click()`);
  assert.equal(await execute(`document.querySelectorAll('.provider-reorder').length`), 0);
  assert.equal(await execute(`document.querySelectorAll('.provider-sortable').length`), 0);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({
    passed: true, checks: ['boundary buttons', 'nonoverlapping layout', 'move down', 'move up', 'persist', 'stay collapsed', 'invalid moves', 'long press drag down and up', 'Escape cancellation', 'short press and early movement', 'edge autoscroll', 'expanded mode'], rows
  }, null, 2));
}

const timeout = setTimeout(() => {
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: 'timeout' }));
  app.exit(1);
}, 20000);
run().then(() => {
  clearTimeout(timeout);
  window?.destroy();
  app.exit(0);
}).catch(error => {
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: error.stack }));
  clearTimeout(timeout);
  window?.destroy();
  app.exit(1);
});
