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
    return { chatHeight: chat.height, chatWidth: chat.width, panelHeight: panel.height, petTop: pet.top, inputBottom: $('chatInput').getBoundingClientRect().bottom };
  })()`);
  assert.equal((await dimensions()).chatHeight, 430);
  assert.equal(window.getBounds().width, 430);
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
  assert.equal(window.getBounds().width, 430);
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
  context.setPanelWindowPosition(false);
  context = makeContext();
  await window.reload();
  await waitLayout();
  await execute(`$('openChat').click()`);
  await waitLayout();
  assert.equal((await dimensions()).chatHeight, 430);
  assert.equal(window.getBounds().height, 650);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({passed:true, checks:['default height', 'both top handles', 'upward drag', 'fixed width', 'fixed pet and bottom', 'panel downward drag', 'minimum height', 'cancel cleanup', 'invalid input', 'close and reopen', 'fresh startup reset']}, null, 2));
}
const timeout = setTimeout(() => { fs.writeFileSync(path.join(output,'result.json'), JSON.stringify({passed:false,error:'timeout'})); app.exit(1); }, 20000);
run().then(() => { clearTimeout(timeout); window?.destroy(); app.exit(0); }).catch(error => { fs.writeFileSync(path.join(output,'result.json'), JSON.stringify({passed:false,error:error.stack})); clearTimeout(timeout); window?.destroy(); app.exit(1); });
