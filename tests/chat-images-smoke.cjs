const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
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
const drawingRequests = [];
const savedImages = [];
const copiedImages = [];
let cancelCopy = false;
let failCopy = false;
const copyContext = vm.createContext({
  ipcMain, BrowserWindow, mainWindow: null, nativeImage,
  imageData: require('../src/image-generation').imageData,
  clipboard: { writeImage(image) {
    if (failCopy) throw new Error('Clipboard test failure');
    copiedImages.push(image);
  } },
  Menu: { buildFromTemplate(items) {
    assert.deepEqual(Array.from(items, item => item.label), ['复制']);
    return { popup(options) {
      assert.ok(options.window instanceof BrowserWindow);
      if (!cancelCopy) items[0].click();
      // Closing the menu must not cancel the pending async image copy.
      options.callback();
    } };
  } }
});
const copySource = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
vm.runInContext(copySource.slice(copySource.indexOf("ipcMain.handle('show-generated-image-menu'"), copySource.indexOf("ipcMain.handle('save-provider'")), copyContext);
let drawingFailure = false;
let modelFetchFailure = false;
let fetchedModels = ['test-model'];
const modelFetches = [];
const provider = { id: 'test', name: 'Test', models: ['test-model'], status: 'online', balance: {}, apiKeys: [{ key: 'test-only' }] };
const state = { unifiedKey: 'test-only', chatFormat: 'responses', routes: {}, unifiedRoute: {}, balanceSettings: {}, providers: [provider] };
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const persistedFormats = [];
let failFormatSave = false;
const formatHandlers = {};
vm.runInNewContext(source.slice(source.indexOf("ipcMain.handle('set-chat-format'"), source.indexOf("ipcMain.handle('generate-images'")), {
  state, ipcMain: { handle: (name, handler) => { formatHandlers[name] = handler; } },
  persist() {
    if (failFormatSave) throw new Error('Format save test failure');
    persistedFormats.push(state.chatFormat);
  }
});
ipcMain.handle('set-chat-format', async (_event, format) => {
  await new Promise(resolve => setTimeout(resolve, 40));
  return formatHandlers['set-chat-format'](null, format);
});
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
ipcMain.handle('get-chat-models', (_event, input) => {
  modelFetches.push(input);
  return modelFetchFailure ? { ok: false, error: 'Model fetch test failure' } : { ok: true, models: fetchedModels };
});
ipcMain.handle('get-balance-activity', () => false);
ipcMain.handle('set-panel-open', () => true);
ipcMain.handle('chat-request', async (_event, input) => {
  try { return { ok: true, payload: await context.directChatRequest(input) }; }
  catch (error) { return { ok: false, error: error.message }; }
});
const pixels = fs.readFileSync(path.join(__dirname, '../src/renderer/assets/pet-normal.png')).toString('base64');
ipcMain.handle('generate-images', async (_event, input) => {
  drawingRequests.push(input);
  await new Promise(resolve => setTimeout(resolve, 80));
  return drawingFailure ? { ok: false, error: 'Drawing test failure' } : {
    ok: true, images: [{ url: `data:image/png;base64,${pixels}` }], errors: ['Partial test failure']
  };
});
ipcMain.handle('save-generated-image', (_event, url) => { savedImages.push(url); return { ok: true }; });
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
    window.chooseChatFormat = async format => { $('chatFormat').value = format; await $('chatFormat').onchange(); };
  })()`);
  assert.deepEqual(await execute(`Array.from($('chatFormat').options, option => option.value)`), ['responses', 'chat/completions']);
  assert.equal(await execute(`$('chatFormat').value`), 'responses');
  const originalRoute = JSON.stringify(state.unifiedRoute);
  failFormatSave = true;
  await execute(`chooseChatFormat('chat/completions')`);
  assert.equal(state.chatFormat, 'responses');
  assert.equal(await execute(`$('chatFormat').value`), 'responses');
  assert.equal(await execute(`$('toast').textContent.includes('Format save test failure')`), true);
  failFormatSave = false;
  assert.equal(await execute(`Array.from($('chatSite').options).some(option => option.textContent === '自动选择')`), false);
  assert.equal(await execute(`$('chatSite').value === '' && $('chatKey').disabled && $('chatModel').disabled && $('sendChat').disabled && currentChatModel() === ''`), true);
  await execute(`(async () => { $('chatSite').value = 'test'; await $('chatSite').onchange(); })()`);
  assert.equal(await execute(`$('sendChat').disabled && $('chatModel').disabled && !$('chatKey').disabled`), true);
  await execute(`(async () => { $('chatKey').value = '0'; await $('chatKey').onchange(); })()`);
  assert.deepEqual(modelFetches.at(-1), { providerId: 'test', keyIndex: 0 });
  assert.equal(await execute(`currentChatModel()`), 'test-model');
  assert.equal(await execute(`$('sendChat').disabled`), false);
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
  assert.equal(await execute(`getComputedStyle($('chatFormat')).display`), 'none');
  assert.equal(await execute(`$('sendChat').disabled`), false);
  assert.equal(await execute(`$('drawingParameters').classList.contains('hidden')`), false);
  assert.equal(await execute(`$('chatAttachments').children.length`), 2);
  await execute(`$('chatMode').value = 'text'; $('chatMode').dispatchEvent(new Event('change')); document.querySelector('#chatAttachments button').click();`);
  assert.notEqual(await execute(`getComputedStyle($('chatFormat')).display`), 'none');
  assert.equal(await execute(`(() => { const r = $('chatFormat').getBoundingClientRect(); return document.elementFromPoint(r.x + r.width/2, r.y + r.height/2) === $('chatFormat'); })()`), true);
  assert.equal(await execute(`$('chatAttachments').children.length`), 1);
  const layout = await execute(`(() => {
    const nodes = [$('chatMode'), $('chatInput'), $('addChatImage'), $('sendChat'), $('clearChat')];
    return nodes.map(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
  })()`);
  assert.equal(layout[0].right - layout[0].left, 54);
  assert.equal(layout[1].bottom - layout[1].top, 38);
  assert.ok(layout[0].right <= layout[1].left && layout[1].right <= layout[3].left);
  assert.ok(layout[2].left >= layout[1].left && layout[2].right <= layout[1].right);
  assert.ok(layout[3].right <= layout[4].left && layout[4].right <= 420);
  assert.equal(layout[4].bottom - layout[4].top, 38);
  assert.ok(layout.every(rect => rect.bottom <= 440));
  await execute(`new Promise(resolve => setTimeout(resolve, 100))`);
  fs.writeFileSync(path.join(output, 'attachments.png'), (await window.webContents.capturePage()).toPNG());
  const submit = async text => execute(`(async () => {
    $('chatInput').value = ${JSON.stringify(text)}; $('chatInput').focus();
    $('chatInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    if (chatSending && !$('chatFormat').disabled) throw new Error('Format must be disabled during requests');
    for (let i = 0; i < 50 && chatSending; i++) await new Promise(resolve => setTimeout(resolve, 20));
  })()`);
  await submit('Describe this image');
  assert.equal(requests.length, 1);
  assert.equal(await execute(`$('chatSite').disabled`), false);
  assert.ok(Array.isArray(requests[0].body.input));
  assert.equal(requests[0].body.input[0].content[1].type, 'input_image');
  assert.ok(requests[0].body.input[0].content[1].image_url.startsWith('data:image/png;base64,'));
  assert.equal(await execute(`$('chatAttachments').children.length`), 0);
  assert.equal(await execute(`document.querySelectorAll('.chat-message.user img').length`), 1);
  await submit('Follow up');
  assert.equal(requests[1].body.input[0].content[1].type, 'input_image');
  await execute(`(async () => {
    chatHistory = []; appState.routingMode = 'unified';
    const saving = chooseChatFormat('chat/completions');
    if (!$('chatFormat').disabled || !$('sendChat').disabled) throw new Error('Format save must lock text sends');
    await saving; await addChatImages([testImage()]);
  })()`);
  assert.equal(state.chatFormat, 'chat/completions');
  assert.equal(JSON.stringify(state.unifiedRoute), originalRoute);
  await execute(`new Promise(resolve => setTimeout(resolve, 80))`);
  fs.writeFileSync(path.join(output, 'chat-format.png'), (await window.webContents.capturePage()).toPNG());
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
  const historyCount = await execute('chatHistory.length');
  await execute(`(() => {
    $('chatMode').value = 'image'; $('chatMode').dispatchEvent(new Event('change'));
    window.changeDrawing = (key, value) => { const field = document.querySelector('[data-drawing="' + key + '"]'); field.value = value; field.dispatchEvent(new Event('change', {bubbles:true})); };
    changeDrawing('resolution', '2K'); changeDrawing('ratio', '16:9'); changeDrawing('quality', 'auto'); changeDrawing('count', '3');
  })()`);
  assert.equal(await execute(`drawingOptions.size`), '2048x1152');
  assert.equal(await execute(`$('chatModelLabel').textContent.includes('图生图')`), true);
  // Check the smallest supported panel with reference thumbnails and a full parameter grid.
  const drawingLayout = await execute(`(() => {
    document.documentElement.style.setProperty('--panel-height', '320px');
    return ['chatPanel', 'drawingParameters', 'chatInput', 'chatMessages'].map(id => { const r = $(id).getBoundingClientRect(); return { id, top:r.top, bottom:r.bottom, height:r.height }; });
  })()`);
  fs.writeFileSync(path.join(output, 'drawing-layout.json'), JSON.stringify(drawingLayout, null, 2));
  assert.ok(drawingLayout[2].bottom <= drawingLayout[0].bottom);
  assert.ok(drawingLayout[1].height >= 30);
  assert.ok(drawingLayout[3].height >= 35);
  await execute(`new Promise(resolve => setTimeout(resolve, 100))`);
  fs.writeFileSync(path.join(output, 'drawing-minimum.png'), (await window.webContents.capturePage()).toPNG());
  await execute(`document.documentElement.style.setProperty('--panel-height', '430px'); $('chatInput').value = 'Draw a cat'; $('chatInput').focus(); $('chatInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));`);
  assert.equal(await execute(`$('chatMode').disabled && document.querySelector('[data-drawing="resolution"]').disabled`), true);
  assert.equal(await execute(`['chatSite', 'chatKey', 'chatModel'].every(id => $(id).disabled)`), true);
  assert.equal(await execute(`$('clearChat').disabled`), true);
  await execute(`$('chatInput').value = 'Do not send twice'; $('chatInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));`);
  await execute(`(async () => { for (let i=0; i<100 && chatSending; i++) await new Promise(resolve => setTimeout(resolve,20)); })()`);
  assert.equal(await execute(`$('chatSite').disabled || $('chatModel').disabled`), false);
  await execute(`$('chatSite').value = 'test'; $('chatSite').dispatchEvent(new Event('change'));`);
  assert.equal(await execute(`chatSiteSelection`), 'test');
  assert.equal(await execute(`$('chatKey').disabled`), false);
  await execute(`(async () => { $('chatKey').value = '0'; await $('chatKey').onchange(); })()`);
  assert.deepEqual(await execute(`Array.from($('chatModel').options, option => option.value)`), ['test-model']);
  assert.equal(await execute(`$('chatModel').textContent.includes('自动选择')`), false);
  await execute(`$('chatModel').value = 'test-model'; $('chatModel').onchange();`);
  assert.equal(drawingRequests.length, 1);
  assert.equal(drawingRequests[0].referenceImages.length, 4);
  assert.equal(drawingRequests[0].quality, 'auto');
  assert.equal(drawingRequests[0].count, 3);
  assert.equal(drawingRequests[0].size, '2048x1152');
  assert.equal(await execute(`chatHistory.length`), historyCount);
  assert.equal(await execute(`document.querySelectorAll('.generated-image').length`), 1);
  assert.equal(await execute(`document.querySelector('.generation-warning').textContent.includes('Partial test failure')`), true);
  await execute(`(async () => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    document.querySelector('.generated-image img').dispatchEvent(event);
    if (!event.defaultPrevented) throw new Error('Default image menu was not prevented');
    for (let i=0; i<50 && !$('toast').textContent.includes('图片已复制'); i++) await new Promise(resolve => setTimeout(resolve,20));
  })()`);
  assert.equal(copiedImages.length, 1);
  const originalImage = nativeImage.createFromBuffer(Buffer.from(pixels, 'base64'));
  assert.deepEqual(copiedImages[0].getSize(), originalImage.getSize());
  assert.deepEqual(copiedImages[0].toBitmap(), originalImage.toBitmap());
  assert.equal(savedImages.length, 0, 'Copy does not require saving');
  await execute(`document.querySelector('.generated-image img').click()`);
  assert.equal(await execute(`document.querySelector('.image-viewer').open`), true);
  await execute(`document.querySelector('.image-viewer img').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))`);
  assert.equal(copiedImages.length, 2);
  cancelCopy = true;
  assert.equal((await execute(`window.apiPet.showGeneratedImageMenu(document.querySelector('.generated-image img').src)`)).canceled, true);
  assert.equal(copiedImages.length, 2);
  cancelCopy = false; failCopy = true;
  await execute(`(async () => {
    document.querySelector('.image-viewer img').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    for (let i=0; i<50 && !$('toast').textContent.includes('复制失败'); i++) await new Promise(resolve => setTimeout(resolve,20));
    if (!$('toast').textContent.includes('Clipboard test failure')) throw new Error('Missing copy failure message');
  })()`);
  failCopy = false;
  assert.equal((await execute(`window.apiPet.showGeneratedImageMenu('data:image/png;base64,YQ==')`)).ok, false, 'Undecodable images must fail');
  assert.equal(copiedImages.length, 2);
  await execute(`document.querySelector('.image-viewer button').click(); document.querySelector('.generated-image button').click();`);
  assert.equal(savedImages.length, 1);
  assert.equal(await execute(`$('chatModelLabel').textContent.includes('文生图')`), true);
  drawingFailure = true;
  await execute(`(async () => { await addChatImages([testImage()]); $('chatInput').value = 'Retry drawing'; $('chatForm').requestSubmit(); for (let i=0; i<100 && chatSending; i++) await new Promise(resolve => setTimeout(resolve,20)); })()`);
  assert.equal(await execute(`$('chatInput').value`), 'Retry drawing');
  assert.equal(await execute(`chatImages.length`), 1);
  assert.equal(await execute(`$('sendChat').disabled`), false);
  assert.equal(await execute(`$('chatSite').disabled || $('chatModel').disabled`), false);
  await execute(`(() => {
    appState.providers[0].models = ['gemini-3-pro-image']; chatModelSelection = 'gemini-3-pro-image'; updateChatModelLabel();
    changeDrawing('resolution', 'auto'); changeDrawing('ratio', '9:16');
  })()`);
  assert.equal(await execute(`drawingOptions.ratio`), '9:16');
  assert.equal(await execute(`document.querySelector('[data-drawing="quality"]') === null`), true);
  await execute(`appState.providers[0].models = ['seedream-v5-pro']; chatModelSelection = 'seedream-v5-pro'; updateChatModelLabel();`);
  assert.equal(await execute(`document.querySelector('[data-drawing="resolution"]').value`), '1K');
  await execute(`$('chatMode').value = 'text'; $('chatMode').dispatchEvent(new Event('change'));`);
  assert.equal(await execute(`$('drawingParameters').classList.contains('hidden')`), true);
  await execute(`$('chatInput').value = 'Unsent draft'; document.querySelector('.generated-image img').click(); $('clearChat').click()`);
  assert.equal(await execute(`chatHistory.length`), 0);
  assert.equal(await execute(`document.querySelectorAll('.chat-message, .image-viewer').length`), 0);
  assert.equal(await execute(`document.querySelectorAll('.chat-empty').length`), 1);
  assert.equal(await execute(`$('chatInput').value`), 'Unsent draft');
  assert.equal(await execute(`chatImages.length`), 1);
  await submit('New image conversation');
  assert.equal(requests.at(-1).body.messages.length, 1);
  assert.equal(requests.at(-1).body.messages[0].content[0].text, 'New image conversation');
  await execute(`(async () => { $('clearChat').click(); await chooseChatFormat('responses'); })()`);
  await execute(`(async () => {
    $('chatInput').value = 'New text conversation'; $('chatForm').requestSubmit();
    if (!$('clearChat').disabled) throw new Error('Clear must be disabled during text request');
    clearChatContext();
    if (chatHistory.length !== 1) throw new Error('Active request context was cleared');
    for (let i=0; i<100 && chatSending; i++) await new Promise(resolve => setTimeout(resolve,20));
  })()`);
  assert.equal(requests.at(-1).body.input, '用户：New text conversation');
  assert.equal(await execute(`$('clearChat').disabled`), false);
  assert.equal(await execute(`chatHistory.length`), 2);
  await execute(`$('clearChat').click(); $('clearChat').click()`);
  assert.equal(await execute(`chatHistory.length`), 0);
  assert.equal(await execute(`document.querySelectorAll('.chat-empty').length`), 1);
  const previousRequests = requests.length;
  await execute(`(() => {
    const input = $('chatInput'); input.value = 'Shortcut test'; input.focus();
    for (const options of [{}, { ctrlKey: true, isComposing: true }, { ctrlKey: true, repeat: true }, { ctrlKey: true, altKey: true }]) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options }));
    }
    $('clearChat').focus();
    $('clearChat').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  })()`);
  assert.equal(requests.length, previousRequests, 'Shortcut only submits from the focused input and ignores composition and repeats');
  await execute(`$('chatInput').focus()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['control'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['control'] });
  await execute(`(async () => { for (let i=0; i<100 && (chatHistory.length !== 2 || chatSending); i++) { await new Promise(resolve => setTimeout(resolve,20)); } })()`);
  assert.equal(requests.length, previousRequests + 1, 'Real Ctrl+Enter keyboard input submits once');
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(path.join(output, 'clear-button.png'), (await window.webContents.capturePage()).toPNG());
  await execute(`chooseChatFormat('chat/completions')`);
  assert.deepEqual(persistedFormats, ['chat/completions', 'responses', 'chat/completions']);
  assert.equal(JSON.stringify(state.unifiedRoute), originalRoute);
  await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.reload(); });
  await execute(`(async () => { for (let i=0; i<50 && !$('chatFormat').onchange; i++) await new Promise(resolve => setTimeout(resolve,20)); })()`);
  assert.equal(await execute(`$('chatFormat').value`), 'chat/completions');
  await execute(`$('openChat').click()`);
  assert.equal(await execute(`$('chatSite').value`), 'test');
  assert.equal(await execute(`$('sendChat').disabled && $('chatModel').disabled`), true, 'Reload requires a Key before sending');
  modelFetchFailure = true;
  await execute(`(async () => { $('chatKey').value = '0'; await $('chatKey').onchange(); })()`);
  assert.equal(await execute(`$('sendChat').disabled && currentChatModel() === ''`), true);
  modelFetchFailure = false; fetchedModels = [];
  await execute(`(async () => { $('chatKey').value = '0'; await $('chatKey').onchange(); })()`);
  assert.equal(await execute(`$('sendChat').disabled && $('chatModel').disabled && currentChatModel() === ''`), true);
  fetchedModels = ['test-model', 'Pet model'];
  await execute(`(async () => { $('chatKey').value = '0'; await $('chatKey').onchange(); })()`);
  assert.deepEqual(await execute(`Array.from($('chatModel').options, option => option.value)`), ['Pet model', 'test-model']);
  await execute(`$('chatModel').value = 'Pet model'; $('chatModel').onchange();`);
  await submit('Actual upstream Pet model');
  assert.equal(requests.at(-1).body.model, 'Pet model', 'A fetched Pet model is sent literally, never rewritten as a gateway alias');
  fetchedModels = ['very-long-model-name-for-chat-format-layout-check'];
  await execute(`(async () => { $('chatKey').value = '0'; await $('chatKey').onchange(); })()`);
  await execute(`document.documentElement.style.setProperty('--panel-height', '320px'); updateChatModelLabel();`);
  assert.equal(await execute(`(() => {
    const format = $('chatFormat').getBoundingClientRect(), label = $('chatModelLabel').getBoundingClientRect(), close = $('closeChat').getBoundingClientRect();
    return label.right <= format.left && format.right <= close.left && $('chatInput').getBoundingClientRect().bottom <= $('chatPanel').getBoundingClientRect().bottom
      && document.elementFromPoint(format.x + format.width/2, format.y + format.height/2) === $('chatFormat');
  })()`), true);
  await execute(`new Promise(resolve => setTimeout(resolve, 80))`);
  fs.writeFileSync(path.join(output, 'chat-format-minimum.png'), (await window.webContents.capturePage()).toPNG());
  await execute(`appState.providers = []; render();`);
  assert.equal(await execute(`$('chatSite').value === '' && $('chatSite').textContent.includes('请先添加站点') && $('sendChat').disabled && currentChatModel() === ''`), true);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true,
    contextChecks: ['clear history and generated previews', 'keep unsent draft', 'new requests exclude old text and images', 'request lock and restore', 'button layout'],
    formatChecks: ['dropdown options', 'both request protocols', 'saved selection survives reload', 'save failure restores selection', 'save and request locks', 'drawing hides selector', 'gateway route unchanged', 'long model and minimum height layout'],
    targetChecks: ['no automatic site or model option', 'explicit site and Key required', 'only fetched models in unified mode', 'failed and empty model lists disable sends', 'real upstream Pet model is preserved', 'reload requires Key selection', 'removed site clears target'],
    checks: ['plus opens file selection', 'file selection', 'drag and drop', 'preview decode', 'remove', 'mode preserves images', 'layout', 'responses image and history', 'chat completions image only', 'invalid and oversized files', 'four image limit', 'failure restores draft', 'drawing parameters and size changes', 'minimum height drawing layout', 'drawing request lock', 'generated preview and save', 'right click bitmap copy in preview and viewer', 'copy cancellation and failure', 'partial failure', 'drawing failure restores draft', 'model parameter changes', 'text mode hides parameters'] }, null, 2));
}
const timeout = setTimeout(() => {
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: 'timeout' })); app.exit(1);
}, 20000);
run().then(() => { clearTimeout(timeout); window?.destroy(); app.exit(0); }).catch(error => {
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: error.stack }));
  clearTimeout(timeout); window?.destroy(); app.exit(1);
});
