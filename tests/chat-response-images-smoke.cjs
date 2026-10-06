const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'api-pet-response-images-'));
const resultPath = path.join(os.tmpdir(), 'api-pet-response-images-result.json');
app.setPath('userData', path.join(output, 'browser'));
let window;
let menuAction = '保存图片';
let cancelSave = false;
let failCopy = false;
let failWrite = false;
const menuLabels = [];
const copiedImages = [];
const saveOptions = [];
const savedPath = path.join(output, 'saved-response.jpg');
const mainSource = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
vm.runInNewContext(mainSource.slice(mainSource.indexOf("ipcMain.handle('show-inline-image-menu'"),mainSource.indexOf("ipcMain.handle('save-provider'")), {
  ipcMain, Buffer, detectMime:require('../src/image-format').detectMime, nativeImage, BrowserWindow, mainWindow:null,
  clipboard:{writeImage:image=>{if(failCopy)throw new Error('Test copy failure');copiedImages.push(image);}},
  dialog:{showSaveDialog:async (_window,options)=>{saveOptions.push(options);return {canceled:cancelSave,filePath:savedPath};}},
  fs:{promises:{writeFile:async (file,bytes)=>{if(failWrite)throw new Error('Test save failure');await fs.promises.writeFile(file,bytes);}}},
  Menu:{buildFromTemplate:items=>{menuLabels.push(items.map(item=>item.label));return {popup:options=>{
    const selected=items.find(item=>item.label===menuAction);
    if(selected)selected.click();options.callback();
  }};}}
});
const requests = [];
const fixture = nativeImage.createFromPath(path.join(__dirname, '../src/renderer/assets/pet-normal.png')).toJPEG(85);
const jpeg = 'data:image/png;base64,' + fixture.toString('base64');
const actualSample = process.env.API_PET_TEST_IMAGE_SAMPLE ? fs.readFileSync(process.env.API_PET_TEST_IMAGE_SAMPLE, 'utf8') : `![sample](${jpeg})`;
let reply = `before ![one](${jpeg}) between ${jpeg} after <img alt="third" onerror="window.modelHtmlExecuted=true" src="${jpeg}"> end`;
let format = 'responses';
const provider = { id:'test', name:'Test', models:['test-model'], apiKeys:[{key:'test-only'}], balance:{} };
ipcMain.handle('get-state', () => ({providers:[provider],unifiedKey:'local',chatFormat:format,balanceSettings:{},unifiedRoute:{}}));
ipcMain.handle('get-balance-activity', () => false);
ipcMain.handle('set-panel-open', () => true);
ipcMain.handle('get-chat-models', () => ({ok:true,models:['test-model']}));
ipcMain.handle('set-chat-format', (_event, value) => {format=value;return format;});
ipcMain.handle('chat-request', (_event, request) => {
  requests.push(request);
  return {ok:true,payload:request.format === 'responses' ? {output:[{content:[{type:'output_text',text:reply}]}]} : {choices:[{message:{content:reply}}]}};
});
async function run() {
  await app.whenReady();
  window = new BrowserWindow({show:false,width:490,height:650,webPreferences:{preload:path.join(__dirname,'../src/preload.js'),
    contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  await window.loadFile(path.join(__dirname,'../src/renderer/index.html'));
  const execute = code => window.webContents.executeJavaScript(code);
  const waitFor = expression => execute(`(async()=>{for(let i=0;i<150;i++){if(${expression})return;await new Promise(r=>setTimeout(r,20));}throw new Error(${JSON.stringify(expression)});})()`);
  await waitFor(`$('chatSite') && $('chatSite').onchange`);
  await execute(`(async()=>{$('openChat').click();$('chatSite').value='test';$('chatSite').onchange();$('chatKey').value='0';await $('chatKey').onchange();})()`);
  const submit = async () => {await execute(`$('chatInput').value='test';$('chatForm').requestSubmit()`);await waitFor('!chatSending');};
  await submit();
  await waitFor(`Array.from(document.querySelectorAll('.chat-inline-image')).every(img=>img.complete&&img.naturalWidth>0)`);
  assert.equal(await execute(`document.querySelectorAll('.chat-inline-image').length`),3);
  assert.equal(await execute(`document.querySelector('.chat-message.assistant').textContent`),'before  between  after  end');
  assert.equal(await execute(`chatHistory.at(-1).content`),'before [图片] between [图片] after [图片] end');
  assert.equal(await execute(`Boolean(window.modelHtmlExecuted)`),false);
  assert.equal(await execute(`JSON.stringify(chatHistory).includes('base64')`),false);
  const urls=await execute(`Array.from(chatReplyObjectUrls)`);
  assert.ok(urls.every(url=>url.startsWith('blob:')));
  assert.equal(await execute(`(async()=>{const blob=await fetch(${JSON.stringify(urls[0])}).then(r=>r.blob());return blob.type;})()`),'image/jpeg');
  await execute(`(async()=>{const event=new MouseEvent('contextmenu',{cancelable:true});await document.querySelector('.chat-inline-image').oncontextmenu(event);if(!event.defaultPrevented)throw new Error('Native browser menu must be prevented');})()`);
  assert.deepEqual(Array.from(menuLabels.at(-1)),['保存图片','复制']);
  assert.deepEqual(fs.readFileSync(savedPath),fixture,'Save preserves original JPEG bytes');
  assert.ok(saveOptions.at(-1).defaultPath.endsWith('.jpg'));
  menuAction='复制';
  await execute(`document.querySelector('.chat-inline-image').oncontextmenu(new MouseEvent('contextmenu',{cancelable:true}))`);
  assert.equal(copiedImages.length,1);
  assert.deepEqual(copiedImages[0].toBitmap(),nativeImage.createFromBuffer(fixture).toBitmap());
  await submit();
  assert.equal(JSON.stringify(requests.at(-1)).includes('base64'),false,'Assistant images must not be sent back as giant text');
  await execute(`document.querySelector('.chat-inline-image').click()`);
  assert.equal(await execute(`document.querySelector('.image-viewer').open`),true);
  await execute(`document.querySelector('.image-viewer img').oncontextmenu(new MouseEvent('contextmenu',{cancelable:true}))`);
  assert.equal(copiedImages.length,2,'Enlarged image also supports the menu');
  failCopy=true;
  await execute(`document.querySelector('.image-viewer img').oncontextmenu(new MouseEvent('contextmenu',{cancelable:true}))`);
  assert.match(await execute(`$('toast').textContent`),/Test copy failure/);
  failCopy=false;menuAction='保存图片';cancelSave=true;
  await execute(`document.querySelector('.image-viewer img').oncontextmenu(new MouseEvent('contextmenu',{cancelable:true}))`);
  assert.equal(copiedImages.length,2);
  cancelSave=false;failWrite=true;
  await execute(`document.querySelector('.image-viewer img').oncontextmenu(new MouseEvent('contextmenu',{cancelable:true}))`);
  assert.match(await execute(`$('toast').textContent`),/Test save failure/);
  failWrite=false;menuAction='';
  assert.equal((await execute(`(async()=>{const bytes=await fetch(${JSON.stringify(urls[0])}).then(r=>r.arrayBuffer());return window.apiPet.showInlineImageMenu({bytes,mimeType:'image/png'});})()`)).canceled,true);
  assert.equal((await execute(`window.apiPet.showInlineImageMenu({bytes:new Uint8Array([1,2,3]).buffer})`)).ok,false);
  menuAction='复制';
  await execute(`$('clearChat').click()`);
  assert.equal(await execute(`chatReplyObjectUrls.size`),0);
  assert.equal(await execute(`document.querySelectorAll('.image-viewer').length`),0);
  assert.equal(await execute(`fetch(${JSON.stringify(urls[0])}).then(()=>false,()=>true)`),true,'Clearing revokes Blob URLs');
  await execute(`(async()=>{$('chatFormat').value='chat/completions';await $('chatFormat').onchange();})()`);
  reply=actualSample;
  await submit();
  await waitFor(`document.querySelector('.chat-inline-image')?.naturalWidth>0`);
  assert.equal(await execute(`chatHistory.at(-1).content`),'[图片]');
  assert.equal(await execute(`document.querySelector('.chat-message.assistant').textContent`),'');
  for(const height of [430,320]) {
    await execute(`document.documentElement.style.setProperty('--panel-height','${height}px')`);
    await new Promise(resolve=>setTimeout(resolve,100));
    const layout=await execute(`(()=>{const panel=$('chatPanel'),img=document.querySelector('.chat-inline-image');const p=panel.getBoundingClientRect(),r=img.getBoundingClientRect();return {overflow:panel.scrollWidth>panel.clientWidth,imgWidth:r.width,panelWidth:p.width,inputBottom:$('chatInput').getBoundingClientRect().bottom,panelBottom:p.bottom};})()`);
    assert.equal(layout.overflow,false);assert.ok(layout.imgWidth<layout.panelWidth);assert.ok(layout.inputBottom<=layout.panelBottom);
    window.webContents.invalidate();
    const screenshot=await window.webContents.capturePage();
    assert.ok(new Set(screenshot.toBitmap()).size>20,'Screenshot has rendered content');
    fs.writeFileSync(path.join(output,`response-image-${height}.png`),screenshot.toPNG());
  }
  await execute(`$('clearChat').click()`);
  reply='before data:image/png;base64,YQ== after';
  await submit();
  await waitFor(`document.querySelector('.chat-inline-image-error')`);
  assert.equal(await execute(`document.querySelector('.chat-message.assistant').textContent`),'before [图片无法显示] after');
  assert.equal(await execute(`chatHistory.at(-1).content`),'before [图片] after');
  reply='**normal Markdown**\n```js\nconst x = 1;\n```';
  await submit();
  assert.equal(await execute(`document.querySelector('.chat-message.assistant:last-child').textContent`),reply);
  const png=fs.readFileSync(path.join(__dirname,'../src/renderer/assets/pet-normal.png'));
  reply=`data:image/jpeg;base64,${png.toString('base64')}`;
  await submit();
  await waitFor(`document.querySelector('.chat-message.assistant:last-child img')?.naturalWidth>0`);
  menuAction='保存图片';
  await execute(`document.querySelector('.chat-message.assistant:last-child img').oncontextmenu(new MouseEvent('contextmenu',{cancelable:true}))`);
  assert.ok(saveOptions.at(-1).defaultPath.endsWith('.png'));
  assert.deepEqual(fs.readFileSync(savedPath),png,'PNG save preserves original bytes despite declared JPEG');
  fs.writeFileSync(resultPath,JSON.stringify({passed:true,output,checks:['both protocols','ordered multiple image formats','actual sample and incorrect MIME','no model HTML execution','Blob resource conversion','clean history and following request','preview and clearing resources','invalid image and unchanged normal Markdown','430px and 320px layout screenshots','save and copy menu on inline and enlarged images','exact original PNG and JPEG bytes and extensions','bitmap copy','menu and save cancellation','save and copy errors','invalid IPC data']},null,2));
}
const timeout=setTimeout(()=>{fs.writeFileSync(resultPath,JSON.stringify({passed:false,error:'timeout'}));app.exit(1);},25000);
run().then(()=>{clearTimeout(timeout);window?.destroy();app.exit(0);}).catch(error=>{clearTimeout(timeout);fs.writeFileSync(resultPath,JSON.stringify({passed:false,error:error.stack}));window?.destroy();app.exit(1);});
