const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const output = path.join(require('node:os').tmpdir(), 'api-pet-window-height-check');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'browser'));
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
let window;
let context;
function makeContext() {
  const ctx = vm.createContext({ mainWindow: window, screen, panelWindowOpen: false });
  vm.runInContext(source.slice(source.indexOf('const PET_LEFT'), source.indexOf('const gotSingleInstanceLock')), ctx);
  vm.runInContext(source.slice(source.indexOf('function setPanelWindowPosition('), source.indexOf('function ensureMainWindowVisible(')), ctx);
  vm.runInContext(source.slice(source.indexOf('function clampWindowToDisplay('), source.indexOf('function providerBaseUrls(')), ctx);
  return ctx;
}
ipcMain.handle('get-state', () => ({ unifiedKey: 'test-only', providers: [], routes: {}, unifiedRoute: {}, balanceSettings: {} }));
ipcMain.handle('get-balance-activity', () => false);
ipcMain.handle('set-panel-open', (_event, open) => { context.setPanelWindowPosition(open); return true; });
ipcMain.handle('resize-panel-height', (_event, height) => context.resizePanelHeight(height));
ipcMain.handle('resize-panel-width', (_event, width) => context.resizePanelWidth(width));
async function run() {
  await app.whenReady();
  const area = screen.getPrimaryDisplay().workArea;
  window = new BrowserWindow({ show: false, frame: false, resizable: false, x: area.x + 40, y: area.y + area.height - 210,
    width: 190, height: 220, webPreferences: { preload: path.join(__dirname, '../src/preload.js'),
      partition: `height-check-${Date.now()}`, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  context = makeContext();
  await window.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  const execute = async code => {
    const result = await window.webContents.executeJavaScript(`Promise.resolve().then(() => eval(${JSON.stringify(code)})).catch(error => ({testError: error.stack}))`);
    if (result?.testError) throw new Error(result.testError);
    return result;
  };
  const waitLayout = () => execute(`new Promise(resolve => setTimeout(resolve, 80))`);
  await execute(`(async () => { for (let i = 0; i < 50 && !$('toggleProviders'); i++) await new Promise(resolve => setTimeout(resolve, 20)); $('openChat').click(); })()`);
  await waitLayout();
  const dimensions = () => execute(`(() => {
    const chat = $('chatPanel').getBoundingClientRect(), panel = $('panel').getBoundingClientRect(), pet = $('pet').getBoundingClientRect();
    return { chatHeight: chat.height, chatWidth: chat.width, panelHeight: panel.height, panelWidth: panel.width, petTop: pet.top, inputBottom: $('chatInput').getBoundingClientRect().bottom };
  })()`);
  assert.equal((await dimensions()).chatHeight, 430);
  assert.equal(window.getBounds().width, 490);
  assert.equal(window.getBounds().height, 650);
  assert.equal(await execute(`document.querySelectorAll('.panel-height-handle').length`), 2);
  const before = window.getBounds();
  const anchorY = before.y + 450;
  // Drive the actual PointerEvent handlers while native pointer capture is replaced for synthetic events.
  await execute(`(() => {
    const handle = $('chatPanel').querySelector('.panel-height-handle');
    handle.setPointerCapture = () => {}; handle.releasePointerCapture = () => {};
    handle.dispatchEvent(new PointerEvent('pointerdown', {button:0,pointerId:1,screenY:300}));
    handle.dispatchEvent(new PointerEvent('pointermove', {pointerId:1,screenY:200}));
    handle.dispatchEvent(new PointerEvent('pointerup', {pointerId:1,screenY:200}));
  })()`);
  await waitLayout();
  let layout = await dimensions();
  const expectedHeight = Math.min(530, area.height - 220);
  assert.equal(layout.chatHeight, expectedHeight);
  assert.equal(layout.chatWidth, 390);
  assert.equal(layout.petTop, expectedHeight + 20);
  assert.equal(window.getBounds().width, 490);
  assert.equal(window.getBounds().y + layout.petTop, anchorY);
  assert.equal(window.getBounds().y + window.getBounds().height, before.y + before.height);
  assert.ok(layout.inputBottom <= layout.chatHeight + 10);
  fs.writeFileSync(path.join(output, 'chat-expanded.png'), (await window.webContents.capturePage()).toPNG());
  await execute(`$('openSettings').click()`);
  await waitLayout();
  assert.equal((await dimensions()).panelHeight, expectedHeight);
  await execute(`(() => {
    const handle = $('panel').querySelector('.panel-height-handle');
    handle.setPointerCapture = () => {}; handle.releasePointerCapture = () => {};
    handle.dispatchEvent(new PointerEvent('pointerdown', {button:0,pointerId:2,screenY:300}));
    handle.dispatchEvent(new PointerEvent('pointermove', {pointerId:2,screenY:1000}));
    handle.dispatchEvent(new PointerEvent('pointercancel', {pointerId:2}));
  })()`);
  await waitLayout();
  assert.equal((await dimensions()).panelHeight, 320);
  assert.equal(await execute(`appRoot.classList.contains('resizing-panel')`), false);
  assert.equal(window.getBounds().y + 340, anchorY);
  await execute(`window.apiPet.resizePanelHeight(Number.NaN)`);
  assert.equal((await dimensions()).panelHeight, 320);
  await execute(`$('closePanel').click()`);
  await waitLayout();
  assert.equal(window.getBounds().height, 220);
  assert.equal(window.getBounds().y + 12, anchorY);
  await execute(`$('openSettings').click()`);
  await waitLayout();
  assert.equal((await dimensions()).panelHeight, 320);
  assert.equal((await dimensions()).panelWidth, 450);
  assert.equal(await execute(`document.querySelectorAll('.panel-width-handle').length`), 1);
  assert.equal(await execute(`getComputedStyle($('panel').querySelector('.panel-width-handle')).cursor`), 'ew-resize');
  const widthAnchor = window.getBounds();
  const dragWidth = async (delta, end = 'pointerup') => {
    await execute(`(() => {
      const handle = $('panel').querySelector('.panel-width-handle');
      handle.setPointerCapture = () => {}; handle.releasePointerCapture = () => {};
      handle.dispatchEvent(new PointerEvent('pointerdown', {button:0,pointerId:3,screenX:200}));
      handle.dispatchEvent(new PointerEvent('pointermove', {pointerId:3,screenX:${200 + delta}}));
      handle.dispatchEvent(new PointerEvent('${end}', {pointerId:3}));
    })()`);
    await waitLayout();
  };
  const checkColumns = async () => {
    const result = await execute(`(() => {
      const cards = Array.from(document.querySelectorAll('.provider-card-compact'));
      const rows = cards.map(card => Array.from(card.children).map(node => node.getBoundingClientRect()));
      return {
        overflow: cards.some(card => card.scrollWidth > card.clientWidth),
        overlaps: rows.some(rects => rects.some((rect, i) => i > 0 && rect.left < rects[i - 1].right)),
        aligned: rows.every(rects => rects.every((rect, i) => Math.abs(rect.left - rows[0][i].left) < 0.5)),
        fitsWindow: $('panel').getBoundingClientRect().right <= innerWidth,
        moneyVisible: cards.every(card => ['.provider-compact-consumption', '.provider-compact-balance'].every(selector => {
          const cell = card.querySelector(selector), box = cell.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(cell);
          const text = range.getBoundingClientRect();
          return cell.scrollWidth <= cell.clientWidth && text.left >= box.left - 0.5 && text.right <= box.right + 0.5 && getComputedStyle(cell).textOverflow !== 'ellipsis';
        }))
      };
    })()`);
    assert.deepEqual(result, {overflow:false, overlaps:false, aligned:true, fitsWindow:true, moneyVisible:true});
  };
  await execute(`appState.providers = [
    {id:'saved', name:'仅保存站点', balanceAdapter:'none', models:['a','b','c'], status:'online'},
    {id:'normal', name:'普通站点', balance:{balance:42.12346}, dailyStats:{cost:1.23456}, models:[], status:'unknown'},
    {id:'long', name:'很长的站点名称测试', balance:{balance:12345.6789}, models:[], status:'error'}
  ]; providersCollapsed = true; render();`);
  assert.deepEqual(await execute(`Array.from(document.querySelectorAll('.provider-card-compact')).map(card => ['.provider-compact-consumption', '.provider-compact-balance'].map(selector => card.querySelector(selector).textContent))`), [['$-.----', '$-.----'], ['$1.2346', '$42.1235'], ['$-.----', '$12345.6789']]);
  assert.deepEqual(await execute(`[null, undefined, '', 'bad', Infinity, 0, 1.23456].map(value => formatCompactMoney(value, '$'))`), ['$-.----', '$-.----', '$-.----', '$-.----', '$-.----', '$0.0000', '$1.2346']);
  await dragWidth(1000);
  assert.equal((await dimensions()).panelWidth, 500);
  assert.equal(window.getBounds().width, 540);
  assert.equal(window.getBounds().x, widthAnchor.x);
  assert.equal(window.getBounds().y, widthAnchor.y);
  assert.equal(window.getBounds().height, widthAnchor.height);
  await checkColumns();
  await execute(`window.apiPet.resizePanelHeight(350)`);
  await waitLayout();
  assert.equal(window.getBounds().width, 540, 'Height adjustment preserves width');
  await execute(`$('closePanel').click()`);
  await waitLayout();
  assert.equal(window.getBounds().width, 190);
  await execute(`$('openSettings').click()`);
  await waitLayout();
  assert.equal((await dimensions()).panelWidth, 500, 'Reopening preserves width');
  await dragWidth(-1000, 'pointercancel');
  assert.equal((await dimensions()).panelWidth, 400);
  assert.equal(window.getBounds().width, 440);
  assert.equal(await execute(`appRoot.classList.contains('resizing-panel-width')`), false);
  await checkColumns();
  await execute(`window.apiPet.resizePanelWidth(Number.NaN)`);
  await waitLayout();
  assert.equal((await dimensions()).panelWidth, 400);
  await dragWidth(65);
  assert.equal((await dimensions()).panelWidth, 465);
  assert.equal(window.getBounds().width, 505);
  await execute(`$('openChat').click()`);
  await waitLayout();
  assert.equal((await dimensions()).chatWidth, 390);
  await execute(`appState.providers[2].balance.balance = 99999.0001; render();`);
  await execute(`$('openSettings').click()`);
  await waitLayout();
  assert.equal((await dimensions()).panelWidth, 465);
  await checkColumns();
  fs.writeFileSync(path.join(output, 'panel-width.png'), (await window.webContents.capturePage()).toPNG());
  assert.equal(await execute(`getComputedStyle($('routingGateway')).display`), 'none');
  await execute(`appState.routingEnabled = true; appState.unifiedKey = 'pet-test-only-0123456789abcdef0123456789abcdef'; render();
    window.gatewayCopies = []; window.gatewayCopyFails = false;
    Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText: async text => {
      if (window.gatewayCopyFails) throw new Error('Test copy failure');
      window.gatewayCopies.push(text);
    }}});`);
  assert.equal(await execute(`$('localGateway').querySelector('.section-title').textContent`), '本地统一 API');
  assert.equal(await execute(`$('localGateway').querySelectorAll('.gateway-field').length`), 3);
  await execute(`$('copyUrl').click(); $('copyKey').click(); $('copyModel').click();`);
  await waitLayout();
  assert.deepEqual(await execute(`window.gatewayCopies`), ['http://127.0.0.1:8787/v1', 'pet-test-only-0123456789abcdef0123456789abcdef', 'Pet model']);
  const checkGatewayLayout = async () => {
    assert.equal(await execute(`Array.from(document.querySelectorAll('.gateway-field')).every(row => {
      const [label, value, button] = Array.from(row.children).map(node => node.getBoundingClientRect());
      return row.scrollWidth <= row.clientWidth && label.right <= value.left && value.right <= button.left;
    })`), true);
  };
  await dragWidth(-1000);
  await checkGatewayLayout();
  await dragWidth(1000);
  await checkGatewayLayout();
  await execute(`$('localGateway').scrollIntoView({block:'center'});`);
  await waitLayout();
  window.webContents.invalidate();
  await waitLayout();
  fs.writeFileSync(path.join(output, 'gateway-fields.png'), (await window.webContents.capturePage()).toPNG());
  await execute(`appState.unifiedKey = 'pet-new-test-key'; render(); $('copyKey').click();`);
  await waitLayout();
  assert.equal(await execute(`window.gatewayCopies.at(-1)`), 'pet-new-test-key');
  await execute(`window.gatewayCopyFails = true; $('copyUrl').click();`);
  await waitLayout();
  assert.equal(await execute(`$('toast').textContent.includes('复制失败')`), true);
  await execute(`appState.routingEnabled = false; renderMode();`);
  assert.equal(await execute(`getComputedStyle($('routingGateway')).display`), 'none');
  context.setPanelWindowPosition(false);
  context = makeContext();
  await window.reload();
  await waitLayout();
  await execute(`$('openChat').click()`);
  await waitLayout();
  assert.equal((await dimensions()).chatHeight, 430);
  assert.equal(window.getBounds().height, 650);
  await execute(`$('openSettings').click()`);
  await waitLayout();
  assert.equal((await dimensions()).panelWidth, 450);
  assert.equal(window.getBounds().width, 490);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({passed:true, checks:['default height', 'both top handles', 'upward drag', 'fixed chat width', 'fixed pet and bottom', 'panel downward drag', 'minimum height', 'cancel cleanup', 'invalid input', 'close and reopen', 'width drag', 'width limits', 'width and height independent', 'aligned columns at both width limits', 'gateway title and three fields', 'copy exact URL Key and model', 'live Key updates', 'gateway layout at both width limits', 'copy failure handling', 'gateway routing visibility', 'fresh startup reset']}, null, 2));
}
const timeout = setTimeout(() => { fs.writeFileSync(path.join(output,'result.json'), JSON.stringify({passed:false,error:'timeout'})); app.exit(1); }, 20000);
run().then(() => { clearTimeout(timeout); window?.destroy(); app.exit(0); }).catch(error => { fs.writeFileSync(path.join(output,'result.json'), JSON.stringify({passed:false,error:error.stack})); clearTimeout(timeout); window?.destroy(); app.exit(1); });
