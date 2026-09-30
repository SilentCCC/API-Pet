const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const output = path.join(require('node:os').tmpdir(), 'api-pet-chat-images-check');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'browser'));
let window;
let failNext = false;
const requests = [];
const provider = { id: 'test', name: 'Test', models: ['test-model'], status: 'online', balance: {}, apiKeys: [{ key: 'test-only' }] };
const state = { unifiedKey: 'test-only', routes: {}, unifiedRoute: {}, balanceSettings: {}, providers: [provider] };
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const context = vm.createContext({
  state, mainWindow: null, providerModels: item => item.models,
  findProviderForModel: () => provider, selectProviderApiKey: () => 'test-only',
  providerBaseUrls: () => ['https://test.invalid/v1'],
  recordProviderRequest() {}, recordProviderResult() {}, persist() {}, extractUsage() {},
  fetch: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    const failed = failNext;
    failNext = false;
    return { ok: !failed, status: failed ? 400 : 200, statusText: failed ? 'Bad Request' : 'OK',
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(failed ? { error: { message: 'Test failure' } } : { output_text: 'Test reply' }) };
  }
});
vm.runInContext(source.slice(source.indexOf('async function directChatRequest('), source.indexOf('async function proxyChat(')), context);
ipcMain.handle('get-state', () => state);
ipcMain.handle('get-balance-activity', () => false);
ipcMain.handle('set-panel-open', () => true);
ipcMain.handle('chat-request', async (_event, input) => {
  try { return { ok: true, payload: await context.directChatRequest(input) }; }
  catch (error) { return { ok: false, error: error.message }; }
});
const pixels = fs.readFileSync(path.join(__dirname, '../src/renderer/assets/pet-normal.png')).toString('base64');
async function run() {
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 430, height: 650, webPreferences: {
    preload: path.join(__dirname, '../src/preload.js'), partition: `image-check-${Date.now()}`,
    contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false
  } });
  await window.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  const execute = async code => {
    const result = await window.webContents.executeJavaScript(`Promise.resolve().then(() => eval(${JSON.stringify(code)})).catch(error => ({ testError: error.stack }))`);
    if (result?.testError) throw new Error(result.testError);
    return result;
  };
  await execute(`(async () => {
    for (let i = 0; i < 50 && !document.querySelector('#toggleProviders'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    document.querySelector('#openChat').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    window.testImage = () => new File([Uint8Array.from(atob(${JSON.stringify(pixels)}), char => char.charCodeAt(0))], 'test.png', { type: 'image/png' });
    window.waitImages = () => chatImageQueue;
  })()`);
  assert.equal(await execute(`(() => {
    let clicked = false;
    $('chatImageFiles').click = () => { clicked = true; };
    $('addChatImage').click();
    return clicked;
  })()`), true);
  await execute(`(async () => {
    const data = new DataTransfer(); data.items.add(testImage());
    $('chatImageFiles').files = data.files;
    $('chatImageFiles').dispatchEvent(new Event('change'));
    await waitImages();
  })()`);
  assert.equal(await execute(`$('chatAttachments').children.length`), 1);
  assert.equal(await execute(`$('chatAttachments').getBoundingClientRect().height > 0`), true);
  assert.equal(await execute(`$('chatImageFiles').files.length`), 0);
  assert.equal(await execute(`document.querySelector('#chatAttachments img').naturalWidth > 0`), true);
  await execute(`(async () => {
    const data = new DataTransfer(); data.items.add(testImage());
    $('chatInput').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    if (!chatPanel.classList.contains('drag-over')) throw new Error('Missing drag highlight');
    $('chatInput').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    await waitImages();
  })()`);
  assert.equal(await execute(`$('chatAttachments').children.length`), 2);
  assert.equal(await execute(`chatPanel.classList.contains('drag-over')`), false);
  await execute(`$('chatMode').value = 'image'; $('chatMode').dispatchEvent(new Event('change'));`);
  assert.equal(await execute(`$('sendChat').disabled`), true);
  assert.equal(await execute(`$('chatAttachments').children.length`), 2);
  await execute(`$('chatMode').value = 'text'; $('chatMode').dispatchEvent(new Event('change')); document.querySelector('#chatAttachments button').click();`);
  assert.equal(await execute(`$('chatAttachments').children.length`), 1);
  const layout = await execute(`(() => {
    const nodes = [$('chatMode'), $('chatInput'), $('addChatImage'), $('sendChat')];
    return nodes.map(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
  })()`);
  assert.equal(layout[0].right - layout[0].left, 54);
  assert.equal(layout[1].bottom - layout[1].top, 38);
  assert.ok(layout[0].right <= layout[1].left && layout[1].right <= layout[3].left);
  assert.ok(layout[2].left >= layout[1].left && layout[2].right <= layout[1].right);
  assert.ok(layout.every(rect => rect.bottom <= 440));
  await execute(`new Promise(resolve => setTimeout(resolve, 100))`);
  fs.writeFileSync(path.join(output, 'attachments.png'), (await window.webContents.capturePage()).toPNG());
  const submit = async text => execute(`(async () => {
    $('chatInput').value = ${JSON.stringify(text)}; $('chatForm').requestSubmit();
    for (let i = 0; i < 50 && chatSending; i++) await new Promise(resolve => setTimeout(resolve, 20));
  })()`);
  await submit('Describe this image');
  assert.equal(requests.length, 1);
  assert.ok(Array.isArray(requests[0].body.input));
  assert.equal(requests[0].body.input[0].content[1].type, 'input_image');
  assert.ok(requests[0].body.input[0].content[1].image_url.startsWith('data:image/png;base64,'));
  assert.equal(await execute(`$('chatAttachments').children.length`), 0);
  assert.equal(await execute(`document.querySelectorAll('.chat-message.user img').length`), 1);
  await submit('Follow up');
  assert.equal(requests[1].body.input[0].content[1].type, 'input_image');
  await execute(`(async () => { chatHistory = []; appState.routingMode = 'unified'; appState.unifiedRoute.format = 'chat/completions'; await addChatImages([testImage()]); })()`);
  await submit('');
  assert.ok(requests[2].url.endsWith('/chat/completions'));
  assert.equal(requests[2].body.messages[0].content[0].type, 'image_url');
  await execute(`addChatImages([new File(['bad'], 'bad.png', { type: 'image/png' }), new File(['text'], 'text.txt', { type: 'text/plain' }), new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })])`);
  assert.equal(await execute(`$('chatAttachments').children.length`), 0);
  await execute(`addChatImages(Array.from({length: 5}, testImage))`);
  assert.equal(await execute(`$('chatAttachments').children.length`), 4);
  failNext = true;
  await submit('Retry me');
  assert.equal(await execute(`$('chatInput').value`), 'Retry me');
  assert.equal(await execute(`$('chatAttachments').children.length`), 4);
  assert.equal(await execute(`$('sendChat').disabled`), false);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true,
    checks: ['plus opens file selection', 'file selection', 'drag and drop', 'preview decode', 'remove', 'mode preserves images', 'layout', 'responses image and history', 'chat completions image only', 'invalid and oversized files', 'four image limit', 'failure restores draft'] }, null, 2));
}
const timeout = setTimeout(() => {
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: 'timeout' })); app.exit(1);
}, 20000);
run().then(() => { clearTimeout(timeout); window?.destroy(); app.exit(0); }).catch(error => {
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: error.stack }));
  clearTimeout(timeout); window?.destroy(); app.exit(1);
});
