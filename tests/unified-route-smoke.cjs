const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'api-pet-unified-route-'));
const resultPath = path.join(os.tmpdir(), 'api-pet-unified-route-result.json');
app.setPath('userData', path.join(output, 'browser'));
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const state = { unifiedKey:'local-test', routingEnabled:true, routingMode:'unified', routes:{},
  chatFormat:'responses', unifiedRoute:{providerId:'',apiKey:'',model:'',models:[]}, balanceSettings:{},
  providers:[
    {id:'first',name:'长名称测试站点',loginUrl:'https://example.invalid',models:['default-model'], apiKey:'first-key',
      apiKeys:[{key:'first-key',remark:'默认账户',enabled:true},{key:'second-key',remark:'独立路由账户的长备注',enabled:false}]},
    {id:'other',name:'另一个站点',loginUrl:'https://other.invalid',models:['other-model'],apiKey:'other-key',apiKeys:[{key:'other-key',remark:'其他账户',enabled:true}]}
  ] };
const modelRequests = [];
let failModels = false;
let emptyModels = false;
let window;
const context = vm.createContext({ state, ipcMain, AbortController, setTimeout, clearTimeout,
  providerBaseUrls:provider=>[provider.loginUrl + '/v1'],
  persist:()=>fs.writeFileSync(path.join(output,'state.json'),JSON.stringify(state)),
  safeState:()=>JSON.parse(JSON.stringify(state)),
  modelFetch:async (_url,options)=>{
    const key = options.headers.Authorization;
    modelRequests.push(key);
    await new Promise(resolve=>setTimeout(resolve,70));
    return {ok:!failModels,status:failModels?401:200,statusText:failModels?'Unauthorized':'OK',
      text:async()=>JSON.stringify(failModels?{error:{message:'Test model failure'}}:{data:(emptyModels?[]:key==='Bearer second-key'?['second-only-model']:key==='Bearer other-key'?['other-model']:['default-model']).map(id=>({id}))})};
  }
});
function include(name) {
  const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));
  assert.ok(start>=0,name);
  const rest=source.slice(start);
  const end=rest.slice(1).search(/^(?:async )?function |^let |^ipcMain\./m);
  vm.runInContext(end<0?rest:rest.slice(0,end+1),context);
}
['providerModels','selectProviderApiKey','unifiedRouteKey','normalizeUnifiedRoute','fetchModels'].forEach(include);
vm.runInContext(source.slice(source.indexOf("ipcMain.handle('set-unified-route'"),source.indexOf("ipcMain.handle('quit'")),context);
ipcMain.handle('get-state',()=>context.safeState());
ipcMain.handle('get-balance-activity',()=>false);
ipcMain.handle('set-panel-open',()=>true);
async function run() {
  await app.whenReady();
  window = new BrowserWindow({show:false,width:550,height:720,webPreferences:{preload:path.join(__dirname,'../src/preload.js'),
    partition:`unified-${Date.now()}`,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  await window.loadFile(path.join(__dirname,'../src/renderer/index.html'));
  const execute = async code=>{
    const value=await window.webContents.executeJavaScript(`Promise.resolve().then(()=>eval(${JSON.stringify(code)})).catch(error=>({testError:error.stack}))`);
    if(value?.testError)throw new Error(value.testError);
    return value;
  };
  const waitFor=condition=>execute(`(async()=>{for(let i=0;i<100;i++){if(${condition})return;await new Promise(r=>setTimeout(r,20));}throw new Error(${JSON.stringify(condition)});})()`);
  await waitFor(`$('unifiedProvider')`);
  await execute(`$('openSettings').click()`);
  assert.deepEqual(await execute(`Array.from(document.querySelectorAll('.unified-field label'),el=>el.firstChild.textContent)`),['站点','Key','模型']);
  assert.equal(await execute(`$('unifiedKeySelect').disabled && $('unifiedTargetModel').disabled`),true);
  await execute(`$('unifiedProvider').value='first'; $('unifiedProvider').onchange()`);
  assert.equal(state.unifiedRoute.providerId,'first'); assert.equal(state.unifiedRoute.apiKey,'');
  assert.equal(await execute(`$('unifiedTargetModel').disabled`),true);
  assert.deepEqual(await execute(`Array.from($('unifiedKeySelect').options,el=>el.textContent)`),['选择 Key','默认账户','独立路由账户的长备注']);
  await execute(`$('unifiedKeySelect').value='1'; window.pendingRoute = $('unifiedKeySelect').onchange(); void 0;`);
  assert.equal(await execute(`$('unifiedProvider').disabled && $('unifiedKeySelect').disabled && $('unifiedTargetModel').disabled`),true);
  await execute(`window.pendingRoute`);
  assert.equal(modelRequests.at(-1),'Bearer second-key');
  assert.equal(state.providers[0].apiKey,'first-key');
  assert.deepEqual(await execute(`Array.from($('unifiedTargetModel').options,el=>el.value)`),['','second-only-model']);
  await execute(`$('unifiedTargetModel').value='second-only-model'; $('unifiedTargetModel').onchange()`);
  assert.equal(state.unifiedRoute.model,'second-only-model');
  assert.equal(JSON.parse(fs.readFileSync(path.join(output,'state.json'),'utf8')).unifiedRoute.apiKey,'second-key');
  for(const width of [400,500]) {
    await execute(`$('panel').style.width='${width}px'; $('unifiedRoute').scrollIntoView({block:'center'})`);
    const layout=await execute(`(()=>{const fields=Array.from(document.querySelectorAll('.unified-field select'),el=>el.getBoundingClientRect());return {sameRow:fields.every(el=>el.top===fields[0].top),overlap:fields.some((el,i)=>i>0&&fields[i-1].right>el.left),overflow:$('unifiedRoute').scrollWidth>$('unifiedRoute').clientWidth};})()`);
    assert.deepEqual(layout,{sameRow:true,overlap:false,overflow:false});
    await new Promise(resolve=>setTimeout(resolve,100));
    fs.writeFileSync(path.join(output,`unified-${width}.png`),(await window.webContents.capturePage()).toPNG());
  }
  await new Promise(resolve=>{window.webContents.once('did-finish-load',resolve);window.reload();});
  await waitFor(`$('unifiedKeySelect') && $('unifiedKeySelect').value === '1'`);
  assert.equal(await execute(`$('unifiedTargetModel').value`),'second-only-model');
  state.providers[0].apiKeys.reverse();
  await execute(`(async()=>{appState=await window.apiPet.getState(); render();})()`);
  assert.equal(await execute(`$('unifiedKeySelect').value`),'0','Key reorder preserves identity');
  await execute(`$('unifiedKeySelect').value='1'; $('unifiedKeySelect').onchange()`);
  assert.equal(state.unifiedRoute.model,'');
  assert.deepEqual(Array.from(state.unifiedRoute.models),['default-model']);
  failModels=true;
  await execute(`$('unifiedKeySelect').value='0'; $('unifiedKeySelect').onchange()`);
  assert.equal(state.unifiedRoute.model,'');
  assert.equal(await execute(`$('unifiedTargetModel').disabled && !unifiedRouteSaving`),true);
  assert.match(await execute(`$('toast').textContent`),/Test model failure/);
  failModels=false; emptyModels=true;
  await execute(`$('unifiedKeySelect').value='1'; $('unifiedKeySelect').onchange()`);
  assert.equal(await execute(`$('unifiedTargetModel').disabled`),true);
  emptyModels=false;
  await execute(`$('unifiedProvider').value='other'; $('unifiedProvider').onchange()`);
  assert.equal(state.unifiedRoute.apiKey,''); assert.equal(state.unifiedRoute.models.length,0);
  await execute(`$('unifiedKeySelect').value='0'; $('unifiedKeySelect').onchange()`);
  assert.equal(modelRequests.at(-1),'Bearer other-key');
  assert.deepEqual(Array.from(state.unifiedRoute.models),['other-model']);
  state.providers[1].apiKeys=[];
  state.unifiedRoute=context.normalizeUnifiedRoute(state.unifiedRoute);
  await execute(`(async()=>{appState=await window.apiPet.getState(); render();})()`);
  assert.equal(await execute(`$('unifiedKeySelect').disabled && $('unifiedTargetModel').disabled`),true);
  assert.equal(state.unifiedRoute.apiKey,'');
  fs.writeFileSync(resultPath,JSON.stringify({passed:true,output,checks:['three columns at 400 and 500px','site and Key selection','Key-specific model list','independent default Key','request locks','saved route and reload','Key reorder identity','Key change resets model','failure and empty models','site change resets Key','removed Key invalidation']},null,2));
}
const timeout=setTimeout(()=>{fs.writeFileSync(resultPath,JSON.stringify({passed:false,error:'timeout'}));app.exit(1);},25000);
run().then(()=>{clearTimeout(timeout);window?.destroy();app.exit(0);}).catch(error=>{fs.writeFileSync(resultPath,JSON.stringify({passed:false,error:error.stack}));clearTimeout(timeout);window?.destroy();app.exit(1);});
