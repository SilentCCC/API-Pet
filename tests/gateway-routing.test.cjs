const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
function include(context, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing function ${name}`);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/^(?:async )?function |^let |^ipcMain\.|^if \(gotSingleInstanceLock\)/m);
  vm.runInContext(end < 0 ? rest : rest.slice(0, end + 1), context);
}

async function gateway(t, options = {}) {
  const provider = { id: 'test', models: ['upstream-model'], apiKey: 'test-upstream-key', apiKeys: [{key:'test-upstream-key', enabled:true}, {key:'second-key', enabled:false}], requestUrl: 'https://upstream.test/v1' };
  const state = { routingEnabled: true, routingMode: 'unified', routes: {}, providers: [provider], unifiedKey: 'test-local-key',
    unifiedRoute: { providerId: 'test', model: 'upstream-model', format: options.legacyFormat }, ...options.state };
  const calls = [];
  const context = vm.createContext({ state, http: options.remoteAddress ? { createServer: handler => http.createServer((req, res) => {
      Object.defineProperty(req.socket, 'remoteAddress', {value:options.remoteAddress,configurable:true});
      return handler(req,res);
    }) } : http, PORT: 0, Buffer, console, mainWindow: null,
    providerModels: item => item.models,
    providerBaseUrls: item => [item.requestUrl],
    selectProviderApiKey: item => item.apiKey,
    recordProviderRequest() {}, recordProviderResult() {}, persist() {}, extractUsage: () => ({}),
    fetch: async (url, request) => {
      calls.push({ url, headers: request.headers, body: JSON.parse(request.body) });
      return options.response?.() || Response.json({ output_text: 'test reply' });
    }
  });
  ['unifiedRouteKey', 'resolveRequestedModel', 'findProviderForModel', 'allModels', 'modelsForApiKey', 'isLanAddress', 'gatewayAccessAllowed', 'gatewayListenHost', 'gatewayCredential', 'gatewayRouting', 'authOk', 'writeJson', 'proxyChat', 'startGateway'].forEach(name => include(context, name));
  context.startGateway();
  const server = context.gateway;
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const send = (endpoint, body, key = 'test-local-key') => fetch(base + endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { calls, state, send, base, context, server };
}

for (const legacyFormat of ['responses', 'chat/completions']) {
  for (const endpoint of ['/chat/completions', '/responses']) {
    test(`unified routing follows ${endpoint} despite saved ${legacyFormat}`, async t => {
      const { calls, send } = await gateway(t, { legacyFormat });
      const payload = endpoint === '/responses' ? { input: [{ role: 'user', content: 'test input' }], instructions: 'test instructions' }
        : { messages: [{ role: 'user', content: 'test input' }], tools: [{ type: 'function', function: { name: 'test_tool' } }] };
      const body = { model: 'Pet model', stream: false, ...payload };
      const response = await send(endpoint, body);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).output_text, 'test reply');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://upstream.test/v1' + endpoint);
      assert.equal(calls[0].headers.Authorization, 'Bearer test-upstream-key');
      assert.deepEqual(calls[0].body, { ...body, model: 'upstream-model' });
    });
  }
}

test('both protocols retain streaming responses', async t => {
  const events = 'data: {"text":"test"}\n\ndata: [DONE]\n\n';
  const { send, calls } = await gateway(t, { response: () => new Response(events, { headers: { 'Content-Type': 'text/event-stream' } }) });
  for (const endpoint of ['/chat/completions', '/responses']) {
    const response = await send(endpoint, { model: 'Pet model', stream: true });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.equal(await response.text(), events);
  }
  assert.ok(calls.every(call => call.body.stream === true));
});

test('pet chat format does not override either gateway mode or client protocol', async t => {
  for (const routingMode of ['unified', 'model']) {
    const { send, calls, state } = await gateway(t, { state: { routingMode } });
    for (const format of ['responses', 'chat/completions']) {
      state.chatFormat = format;
      for (const endpoint of ['/responses', '/chat/completions']) {
        const response = await send(endpoint, { model: routingMode === 'unified' ? 'Pet model' : 'upstream-model' });
        assert.equal(response.status, 200);
        await response.text();
        assert.equal(calls.at(-1).url, 'https://upstream.test/v1' + endpoint);
      }
    }
  }
});

test('upstream protocol errors keep their status and body', async t => {
  const error = { error: { message: 'Unsupported API endpoint' } };
  const { send } = await gateway(t, { response: () => Response.json(error, { status: 400 }) });
  const response = await send('/responses', { model: 'Pet model', input: 'test' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), error);
});

test('gateway authorization, routing switch and model guards remain enforced', async t => {
  const { send, calls, state } = await gateway(t);
  assert.equal((await send('/responses', { model: 'Pet model' }, 'wrong-key')).status, 401);
  assert.equal((await send('/responses', { model: 'upstream-model' })).status, 400);
  state.routingEnabled = false;
  assert.equal((await send('/chat/completions', { model: 'Pet model' })).status, 400);
  assert.equal(calls.length, 0);
});

test('model routing also follows the client endpoint', async t => {
  const { send, calls } = await gateway(t, { state: { routingMode: 'model' } });
  for (const endpoint of ['/chat/completions', '/responses']) {
    const response = await send(endpoint, { model: 'upstream-model' });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(calls.at(-1).url, 'https://upstream.test/v1' + endpoint);
  }
});

test('site Key route maps the local API Pet Key to the selected site Key', async t => {
  const provider = { id: 'site-a', models: [], apiKey: 'site-a-key', apiKeys: [{ key: 'site-a-key', enabled: true }], apiKeyModels: { 'site-a-key': ['a-model'] }, requestUrl: 'https://site-a.test/v1' };
  const state = { routingEnabled: true, routingMode: 'key', routes: {}, providers: [provider], unifiedKey: 'local-key', keyRoute: { providerId: 'site-a', apiKey: 'site-a-key', models: ['a-model'] } };
  const calls = [];
  const context = vm.createContext({ state, http, PORT: 0, Buffer, console, mainWindow: null,
    providerModels: item => item.models, providerBaseUrls: item => [item.requestUrl], selectProviderApiKey: item => item.apiKey,
    recordProviderRequest() {}, recordProviderResult() {}, persist() {}, extractUsage: () => ({}),
    fetch: async (url, request) => { calls.push({ url, headers: request.headers, body: JSON.parse(request.body) }); return Response.json({ output_text: 'ok' }); }
  });
  ['cleanBaseUrl', 'providerModels', 'providerBaseUrls', 'selectProviderApiKey', 'modelsForApiKey', 'isLanAddress', 'gatewayAccessAllowed', 'gatewayListenHost', 'gatewayCredential', 'gatewayRouting', 'unifiedRouteKey', 'resolveRequestedModel', 'findProviderForModel', 'allModels', 'authOk', 'writeJson', 'proxyChat', 'startGateway'].forEach(name => include(context, name));
  context.startGateway();
  const server = context.gateway;
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const send = (endpoint, body, key = 'local-key') => fetch(base + endpoint, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const models = await fetch(base + '/models', { headers: { Authorization: 'Bearer local-key' } });
  assert.deepEqual((await models.json()).data.map(item => item.id), ['a-model']);
  const routed = await send('/responses', { model: 'a-model', input: 'test' });
  assert.equal(routed.status, 200, await routed.clone().text());
  assert.equal(calls[0].headers.Authorization, 'Bearer site-a-key');
  assert.equal(calls[0].url, 'https://site-a.test/v1/responses');
  assert.equal((await send('/responses', { model: 'other-model' })).status, 404);
  assert.equal((await send('/responses', { model: 'a-model' }, 'site-a-key')).status, 401);
});

test('legacy configuration retains route target and internal chat format separately', () => {
  for (const format of ['chat/completions', 'responses']) {
    const saved = { routingMode: 'unified', unifiedRoute: { providerId: 'test', model: 'upstream-model', format }, providers: [{ id:'test', models:['upstream-model'], apiKeys:[{key:'legacy-key',enabled:true}] }] };
    const context = vm.createContext({ crypto, fs: { readFileSync: () => JSON.stringify(saved) }, dataPath: () => 'test-only', normalizeProvider: item => item });
    include(context, 'defaultState');
    include(context, 'providerModels');
    include(context, 'selectProviderApiKey');
    include(context, 'unifiedRouteKey');
    include(context, 'normalizeUnifiedRoute');
    include(context, 'normalizeKeyRoute');
    include(context, 'loadState');
    const loaded = context.loadState();
    assert.equal(loaded.chatFormat, format);
    assert.deepEqual(JSON.parse(JSON.stringify(loaded.unifiedRoute)), { providerId: 'test', apiKey:'legacy-key', model: 'upstream-model', models:['upstream-model'] });
  }
});

test('unified route selects a Key, fetches its models and validates selected models', async () => {
  const handlers = {};
  const state = { providers: [{ id: 'test', models: ['upstream-model'], apiKeys:[{key:'first'},{key:'second'}] }], unifiedRoute: {} };
  const context = vm.createContext({ state, ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
    providerModels: item => item.models, persist() {}, safeState: () => state,
    fetchModels: async (_provider, key) => key === 'second' ? ['second-model'] : ['upstream-model'] });
  include(context, 'unifiedRouteKey');
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('set-unified-route'"), source.indexOf("ipcMain.handle('quit'")), context);
  const save = input => handlers['set-unified-route'](null, input);
  await save({ providerId:'test' });
  assert.equal(state.unifiedRoute.apiKey, '');
  await save({providerId:'test',keyIndex:1});
  assert.equal(state.unifiedRoute.apiKey,'second');
  assert.equal(state.unifiedRoute.model,'');
  assert.deepEqual(Array.from(state.unifiedRoute.models),['second-model']);
  await save({providerId:'test',model:'upstream-model'});
  assert.equal(state.unifiedRoute.model,'');
  await save({providerId:'test',model:'second-model',format:'responses'});
  assert.deepEqual(JSON.parse(JSON.stringify(state.unifiedRoute)), {providerId:'test',apiKey:'second',model:'second-model',models:['second-model']});
  await save({providerId:'test',keyIndex:''});
  assert.equal(state.unifiedRoute.apiKey,''); assert.equal(state.unifiedRoute.model,'');
});

test('unified gateway forwards with the selected non-default Key and its models for both protocols', async t => {
  const {send,calls,state} = await gateway(t, {state:{unifiedRoute:{providerId:'test',apiKey:'second-key',model:'second-model',models:['second-model']}}});
  for (const endpoint of ['/responses','/chat/completions']) {
    assert.equal((await send(endpoint,{model:'Pet model',api_pet_provider_id:'other'})).status,200);
    assert.equal(calls.at(-1).headers.Authorization,'Bearer second-key');
    assert.equal(calls.at(-1).body.model,'second-model');
  }
  assert.equal(state.providers[0].apiKey,'test-upstream-key');
  state.providers[0].apiKeys.reverse();
  assert.equal((await send('/responses',{model:'Pet model'})).status,200,'Key remains bound after reordering');
  state.providers[0].apiKeys = [{key:'test-upstream-key',enabled:true}];
  assert.equal((await send('/responses',{model:'Pet model'})).status,400,'Removed Key cannot silently use the default');
  assert.equal(calls.length,3);
});

test('unified model fetch ignores stale results and keeps route incomplete after failures', async () => {
  const handlers = {};
  const state = {providers:[{id:'test',apiKeys:[{key:'slow'},{key:'fast'},{key:'failed'}]}],unifiedRoute:{}};
  let resolveSlow;
  const context = vm.createContext({state,ipcMain:{handle:(name,fn)=>{handlers[name]=fn;}},persist(){},safeState:()=>state,
    fetchModels:async (_provider,key)=> key === 'slow' ? new Promise(resolve=>{resolveSlow=resolve;}) : key === 'fast' ? ['fast-model'] : Promise.reject(new Error('401 denied'))});
  include(context,'unifiedRouteKey');
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('set-unified-route'"),source.indexOf("ipcMain.handle('quit'")),context);
  const save = input=>handlers['set-unified-route'](null,input);
  const slow = save({providerId:'test',keyIndex:0});
  await save({providerId:'test',keyIndex:1});
  resolveSlow(['slow-model']); await slow;
  assert.equal(state.unifiedRoute.apiKey,'fast'); assert.deepEqual(Array.from(state.unifiedRoute.models),['fast-model']);
  await assert.rejects(save({providerId:'test',keyIndex:2}),/401/);
  assert.equal(state.unifiedRoute.model,''); assert.deepEqual(Array.from(state.unifiedRoute.models),[]);
});

test('saved unified route preserves exact Key identity and clears deleted credentials', () => {
  const providers = [{id:'test',models:['default-model'],apiKeys:[{key:'first',enabled:true},{key:'second',enabled:false}]}];
  const context = vm.createContext({state:{providers}});
  ['providerModels','selectProviderApiKey','unifiedRouteKey','normalizeUnifiedRoute'].forEach(name=>include(context,name));
  const route = {providerId:'test',apiKey:'second',model:'second-model',models:['second-model']};
  const normalize = ()=>JSON.parse(JSON.stringify(context.normalizeUnifiedRoute(JSON.parse(JSON.stringify(route)))));
  assert.deepEqual(normalize(),route);
  providers[0].apiKeys.reverse();
  assert.deepEqual(normalize(),route);
  providers[0].apiKeys=providers[0].apiKeys.filter(item=>item.key!=='second');
  assert.deepEqual(normalize(),{providerId:'test',apiKey:'',model:'',models:[]});
  providers.length=0;
  assert.deepEqual(normalize(),{providerId:'',apiKey:'',model:'',models:[]});
});

test('default Key model tests update only the matching unified Key list', async () => {
  const provider = {id:'test',apiKeys:[{key:'first',enabled:true},{key:'second',enabled:false}],models:['default-model']};
  const state = {providers:[provider],unifiedRoute:{providerId:'test',apiKey:'second',model:'second-model',models:['second-model']}};
  let resolveModels;
  const context = vm.createContext({state,persist(){},safeState:()=>state,
    fetchModels:async (_provider,key)=>new Promise(resolve=>{assert.equal(key,'first');resolveModels=resolve;})});
  ['selectProviderApiKey','unifiedRouteKey','testProvider'].forEach(name=>include(context,name));
  let request=context.testProvider('test');
  resolveModels(['first-model']); await request;
  assert.deepEqual(Array.from(state.unifiedRoute.models),['second-model']);
  assert.equal(state.unifiedRoute.model,'second-model');
  state.unifiedRoute={providerId:'test',apiKey:'first',model:'old-model',models:['old-model']};
  request=context.testProvider('test');
  resolveModels(['first-model']); await request;
  assert.deepEqual(Array.from(state.unifiedRoute.models),['first-model']);
  assert.equal(state.unifiedRoute.model,'');
  request=context.testProvider('test');
  provider.apiKeys[0].enabled=false;provider.apiKeys[1].enabled=true;
  context.selectProviderApiKey(provider);
  state.unifiedRoute={providerId:'test',apiKey:'second',model:'second-model',models:['second-model']};
  resolveModels(['first-model']); await request;
  assert.deepEqual(Array.from(state.unifiedRoute.models),['second-model'],'Default Key changed while model request was pending');
});


for (const firstMode of ['unified', 'model', 'key']) {
  for (const secondMode of ['unified', 'model', 'key']) {
    test(`two local Keys isolate simultaneous ${firstMode}/${secondMode} routes`, async t => {
      const providers = ['a', 'b'].map(id => ({ id, models: ['shared-model'], apiKey: `${id}-default`,
        apiKeys: [{ key: `${id}-default`, enabled: true }, { key: `${id}-selected`, enabled: false }],
        apiKeyModels: { [`${id}-selected`]: [`${id}-only-model`] }, requestUrl: `https://${id}.test/v1` }));
      const config = (id, mode) => ({ unifiedKey: `pet-${id}`, routingEnabled: true, routingMode: mode,
        routes: { 'shared-model': id }, unifiedRoute: { providerId: id, apiKey: `${id}-selected`, model: 'shared-model', models: ['shared-model'] },
        keyRoute: { providerId: id, apiKey: `${id}-selected`, models: [`${id}-only-model`] } });
      const { state, base, send, calls } = await gateway(t, { state: { ...config('a', firstMode), secondaryRouting: config('b', secondMode), providers },
        response: () => new Response('data: {"text":"ok"}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) });
      const requestModel = (id, mode) => mode === 'unified' ? 'Pet model' : mode === 'key' ? `${id}-only-model` : 'shared-model';
      for (const endpoint of ['/responses', '/chat/completions']) {
        const responses = await Promise.all([send(endpoint, { model: requestModel('a', firstMode), stream: true, marker: 'a' }, 'pet-a'),
          send(endpoint, { model: requestModel('b', secondMode), stream: true, marker: 'b' }, 'pet-b')]);
        for (const response of responses) {
          assert.equal(response.status, 200, await response.clone().text());
          assert.match(response.headers.get('content-type'), /event-stream/);
          assert.match(await response.text(), /\[DONE\]/);
        }
      }
      for (const call of calls) {
        const id = call.body.marker;
        const mode = id === 'a' ? firstMode : secondMode;
        assert.match(call.url, new RegExp(`https://${id}\\.test/v1/`));
        assert.equal(call.headers.Authorization, `Bearer ${id}-${mode === 'model' ? 'default' : 'selected'}`);
        assert.equal(call.body.model, mode === 'key' ? `${id}-only-model` : 'shared-model');
      }
      const list = async key => {
        const response = await fetch(base + '/models', { headers: { 'x-api-key': key } });
        assert.equal(response.status, 200);
        return (await response.json()).data.map(item => item.id);
      };
      assert.deepEqual(await list('pet-a'), [firstMode === 'unified' ? 'Pet model' : firstMode === 'model' ? 'shared-model' : 'a-only-model']);
      assert.deepEqual(await list('pet-b'), [secondMode === 'unified' ? 'Pet model' : secondMode === 'model' ? 'shared-model' : 'b-only-model']);
      for (const [disabled, active] of [[state, state.secondaryRouting], [state.secondaryRouting, state]]) {
        disabled.routingEnabled = false;
        assert.deepEqual(await list(disabled.unifiedKey), []);
        assert.equal((await send('/responses', { model: requestModel(disabled === state ? 'a' : 'b', disabled.routingMode) }, disabled.unifiedKey)).status, 400);
        const response = await send('/responses', { model: requestModel(active === state ? 'a' : 'b', active.routingMode) }, active.unifiedKey);
        assert.equal(response.status, 200);
        await response.text();
        disabled.routingEnabled = true;
      }
      assert.equal((await send('/responses', { model: 'shared-model' }, 'wrong-key')).status, 401);
    });
  }
}

test('second route configuration persists without changing the original Key and selections', () => {
  const provider = { id: 'site', models: ['model'], apiKeys: [{ key: 'upstream', enabled: true }] };
  const saved = { unifiedKey: 'pet-existing', routingEnabled: true, routingMode: 'unified', routes: { model: 'site' },
    unifiedRoute: { providerId: 'site', apiKey: 'upstream', model: 'model', models: ['model'] }, providers: [provider] };
  const context = vm.createContext({ crypto, fs: { readFileSync: () => JSON.stringify(saved) }, dataPath: () => 'test', normalizeProvider: item => item });
  ['defaultState', 'providerModels', 'selectProviderApiKey', 'unifiedRouteKey', 'normalizeUnifiedRoute', 'normalizeKeyRoute', 'loadState'].forEach(name => include(context, name));
  const migrated = context.loadState();
  assert.equal(migrated.unifiedKey, saved.unifiedKey);
  assert.equal(migrated.routingEnabled, true);
  assert.equal(migrated.unifiedRoute.model, 'model');
  assert.notEqual(migrated.secondaryRouting.unifiedKey, saved.unifiedKey);
  assert.match(migrated.secondaryRouting.unifiedKey, /^pet-/);
  assert.equal(migrated.secondaryRouting.routingEnabled, false);
  assert.equal(migrated.lanAccess, false);
  assert.equal(migrated.secondaryRouting.lanAccess, false);
  saved.secondaryRouting = JSON.parse(JSON.stringify(migrated.secondaryRouting));
  saved.secondaryRouting.routingEnabled = true;
  saved.secondaryRouting.lanAccess = true;
  saved.secondaryRouting.routingMode = 'key';
  saved.secondaryRouting.keyRoute = { providerId: 'site', apiKey: 'upstream', models: ['model'] };
  const loaded = context.loadState();
  assert.equal(loaded.secondaryRouting.unifiedKey, saved.secondaryRouting.unifiedKey);
  assert.equal(loaded.secondaryRouting.keyRoute.apiKey, 'upstream');
  assert.equal(loaded.secondaryRouting.lanAccess, true);
  assert.equal(loaded.lanAccess, false);
  saved.providers[0].apiKeys = [];
  assert.equal(context.loadState().secondaryRouting.keyRoute.apiKey, '');
});

test('IPC selections, mode switches and pending model fetches stay within their route group', async () => {
  const handlers = {};
  const state = { providers: [{ id: 'site', models: ['a', 'b'], apiKeys: [{ key: 'a' }, { key: 'b' }] }],
    routes: {}, unifiedRoute: {}, keyRoute: {}, secondaryRouting: { routes: {}, unifiedRoute: {}, keyRoute: {} } };
  const pending = [];
  const context = vm.createContext({ state, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, persist() {}, safeState: () => state,
    providerModels: provider => provider.models, fetchModels: (_provider, key) => new Promise(resolve => pending.push({ key, resolve })),
    modelsForApiKey: async (_provider, key) => [key + '-only'] });
  include(context, 'unifiedRouteKey');
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('set-route'"), source.indexOf("ipcMain.handle('quit'")), context);
  handlers['set-routing-mode'](null, 'unified', 1);
  handlers['set-routing-mode'](null, 'key', 2);
  handlers['set-routing-enabled'](null, true, 2);
  assert.equal(state.routingMode, 'unified');
  assert.equal(state.secondaryRouting.routingMode, 'key');
  assert.equal(state.routingEnabled, undefined);
  handlers['set-route'](null, { model: 'same', providerId: 'a' }, 1);
  handlers['set-route'](null, { model: 'same', providerId: 'b' }, 2);
  assert.equal(state.routes.same, 'a');
  assert.equal(state.secondaryRouting.routes.same, 'b');
  const first = handlers['set-unified-route'](null, { providerId: 'site', keyIndex: 0 }, 1);
  const second = handlers['set-unified-route'](null, { providerId: 'site', keyIndex: 1 }, 2);
  pending[1].resolve(['b']); await second;
  pending[0].resolve(['a']); await first;
  handlers['set-unified-route'](null, { providerId: 'site', model: 'a' }, 1);
  handlers['set-unified-route'](null, { providerId: 'site', model: 'b' }, 2);
  assert.equal(state.unifiedRoute.model, 'a');
  assert.equal(state.secondaryRouting.unifiedRoute.model, 'b');
  await handlers['set-key-route'](null, { providerId: 'site', keyIndex: 1 }, 2);
  assert.equal(state.secondaryRouting.keyRoute.apiKey, 'b');
  assert.equal(state.keyRoute.apiKey, undefined);
});


test('LAN access follows the authenticated route Key for both model lists and forwarding', async t => {
  for (const allowedGroup of [1,2]) {
    const first = {lanAccess:allowedGroup===1, secondaryRouting:{unifiedKey:'second-local',routingEnabled:true,routingMode:'unified',routes:{},unifiedRoute:{providerId:'test',model:'upstream-model'},lanAccess:allowedGroup===2}};
    const {base,send,calls,server}=await gateway(t,{state:first,remoteAddress:'192.168.0.22'});
    assert.equal(server.address().address,'0.0.0.0');
    for (const [group,key] of [[1,'test-local-key'],[2,'second-local']]) {
      const expected=group===allowedGroup?200:403;
      const models=await fetch(base+'/models',{headers:{Authorization:'Bearer '+key,'X-Forwarded-For':'127.0.0.1'}});
      assert.equal(models.status,expected);
      for(const endpoint of ['/responses','/chat/completions']) {
        const reply=await send(endpoint,{model:'Pet model'},key);
        assert.equal(reply.status,expected);
        await reply.text();
      }
    }
    assert.equal(calls.length,2);
    assert.equal((await send('/responses',{model:'Pet model'},'invalid')).status,401);
  }
});

test('loopback forms always work and public or missing peers cannot use a LAN-enabled Key',()=>{
  const context=vm.createContext({});
  ['isLanAddress','gatewayAccessAllowed'].forEach(name=>include(context,name));
  for(const address of ['127.0.0.1','127.0.0.2','::1','::ffff:127.0.0.1']) {
    assert.equal(context.gatewayAccessAllowed({socket:{remoteAddress:address}},{lanAccess:false}),true);
  }
  for(const address of ['192.168.0.22','10.1.1.2','172.16.1.2','172.31.0.1','::ffff:192.168.0.22']) {
    assert.equal(context.gatewayAccessAllowed({socket:{remoteAddress:address}},{lanAccess:true}),true);
    assert.equal(context.gatewayAccessAllowed({socket:{remoteAddress:address}},{lanAccess:false}),false);
  }
  for(const address of ['8.8.8.8','172.32.1.1','192.168.1.999','',undefined]) {
    assert.equal(context.gatewayAccessAllowed({socket:{remoteAddress:address}},{lanAccess:true}),false);
  }
});

test('independent LAN switches rebind immediately and serialize overlapping updates',async t=>{
  const {context,state,server}=await gateway(t);
  assert.equal(server.address().address,'127.0.0.1');
  state.secondaryRouting={lanAccess:false};
  context.safeState=()=>JSON.parse(JSON.stringify(state));
  vm.runInContext('let gatewaySettingsQueue = Promise.resolve()',context);
  ['restartGateway','setRoutingLanAccess'].forEach(name=>include(context,name));
  t.after(()=>new Promise(resolve=>{if(!context.gateway)return resolve();context.gateway.close(resolve);context.gateway.closeAllConnections();}));
  await context.setRoutingLanAccess(true,2);
  assert.equal(context.gateway.address().address,'0.0.0.0');
  assert.equal(state.lanAccess,undefined);
  assert.equal(state.secondaryRouting.lanAccess,true);
  await Promise.all([context.setRoutingLanAccess(true,1),context.setRoutingLanAccess(false,2)]);
  assert.equal(state.lanAccess,true);
  assert.equal(state.secondaryRouting.lanAccess,false);
  assert.equal(context.gateway.address().address,'0.0.0.0');
  await context.setRoutingLanAccess(false,1);
  assert.equal(context.gateway.address().address,'127.0.0.1');
  const response=await fetch('http://127.0.0.1:'+context.gateway.address().port+'/v1/models',{headers:{Authorization:'Bearer test-local-key'}});
  assert.equal(response.status,200);
  await response.text();
});

test('LAN address listing filters external and loopback interfaces and removes duplicates',()=>{
  const context=vm.createContext({PORT:8787,os:{networkInterfaces:()=>({ethernet:[
    {family:'IPv4',address:'192.168.0.11',internal:false},
    {family:'IPv4',address:'192.168.0.11',internal:false},
    {family:'IPv4',address:'8.8.8.8',internal:false},
    {family:'IPv4',address:'127.0.0.1',internal:true},
    {family:'IPv6',address:'::1',internal:true}
  ]})}});
  ['isLanAddress','gatewayLanUrls'].forEach(name=>include(context,name));
  assert.deepEqual(Array.from(context.gatewayLanUrls()),['http://192.168.0.11:8787/v1']);
});
