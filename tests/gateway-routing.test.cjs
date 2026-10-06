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
  const context = vm.createContext({ state, http, PORT: 0, Buffer, console, mainWindow: null,
    providerModels: item => item.models,
    providerBaseUrls: item => [item.requestUrl],
    selectProviderApiKey: item => item.apiKey,
    recordProviderRequest() {}, recordProviderResult() {}, persist() {}, extractUsage: () => ({}),
    fetch: async (url, request) => {
      calls.push({ url, headers: request.headers, body: JSON.parse(request.body) });
      return options.response?.() || Response.json({ output_text: 'test reply' });
    }
  });
  ['unifiedRouteKey', 'resolveRequestedModel', 'findProviderForModel', 'allModels', 'authOk', 'writeJson', 'proxyChat', 'startGateway'].forEach(name => include(context, name));
  context.startGateway();
  const server = context.gateway;
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const send = (endpoint, body, key = 'test-local-key') => fetch(base + endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { calls, state, send, base };
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

test('legacy configuration retains route target and internal chat format separately', () => {
  for (const format of ['chat/completions', 'responses']) {
    const saved = { routingMode: 'unified', unifiedRoute: { providerId: 'test', model: 'upstream-model', format }, providers: [{ id:'test', models:['upstream-model'], apiKeys:[{key:'legacy-key',enabled:true}] }] };
    const context = vm.createContext({ crypto, fs: { readFileSync: () => JSON.stringify(saved) }, dataPath: () => 'test-only', normalizeProvider: item => item });
    include(context, 'defaultState');
    include(context, 'providerModels');
    include(context, 'selectProviderApiKey');
    include(context, 'unifiedRouteKey');
    include(context, 'normalizeUnifiedRoute');
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
