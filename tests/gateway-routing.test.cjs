const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { prepareGatewayRequest, translateGatewayResponse } = require('../src/gateway-format');
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
  const context = vm.createContext({ state, prepareGatewayRequest, translateGatewayResponse, http: options.remoteAddress ? { createServer: handler => http.createServer((req, res) => {
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
  // Windows can assign port 6000 (or another Fetch-blocked port) for listen(0).
  // Rebind the isolated test listener rather than making this suite intermittent.
  const fetchBlockedPorts = new Set([1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);
  while (server.address().port < 1024 || fetchBlockedPorts.has(server.address().port)) {
    await new Promise(resolve => server.close(resolve));
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); server.listen(0, context.gatewayListenHost()); });
  }
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

test('format settings validate, persist independently and roll back on save failure', () => {
  const handlers = {};
  const state = { secondaryRouting: {}, chatFormat: 'chat/completions' };
  let fail = false, saved;
  const context = vm.createContext({ state, ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
    persist() { if (fail) return false; saved = JSON.parse(JSON.stringify(state)); return true; }, safeState: () => state });
  const start = source.indexOf("ipcMain.handle('set-routing-request-format'");
  vm.runInContext(source.slice(start, source.indexOf("ipcMain.handle('set-unified-route'", start)), context);
  const save = (enabled, format, group) => handlers['set-routing-request-format'](null, { enabled, format }, group);
  save(true, 'responses', 1); save(true, 'chat/completions', 2);
  assert.equal(saved.requestFormat, 'responses');
  assert.equal(saved.secondaryRouting.requestFormat, 'chat/completions');
  assert.equal(saved.chatFormat, 'chat/completions');
  assert.throws(() => save(true, 'bad', 1), /不支持/);
  fail = true;
  assert.throws(() => save(false, 'responses', 2), /保存失败/);
  assert.equal(state.secondaryRouting.requestFormatEnabled, true);
  assert.equal(state.secondaryRouting.requestFormat, 'chat/completions');
});

test('all three routing modes translate to the selected upstream protocol', async t => {
  for (const routingMode of ['unified', 'model', 'key']) {
    for (const requestFormat of ['responses', 'chat/completions']) {
      const responses = requestFormat === 'responses';
      const { send, calls, state } = await gateway(t, { state: { routingMode, requestFormatEnabled: true, requestFormat,
        keyRoute: { providerId: 'test', apiKey: 'test-upstream-key', models: ['upstream-model'] } },
        response: () => responses
          ? Response.json({ id: 'resp_result', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'converted' }] }] })
          : Response.json({ id: 'chat_result', choices: [{ index: 0, message: { role: 'assistant', content: 'converted' }, finish_reason: 'stop' }] }) });
      state.providers[0].apiKeyModels = { 'test-upstream-key': ['upstream-model'] };
      const endpoint = responses ? '/chat/completions' : '/responses';
      const payload = responses ? { messages: [{ role: 'user', content: 'question' }] } : { input: 'question' };
      const response = await send(endpoint, { model: routingMode === 'unified' ? 'Pet model' : 'upstream-model', ...payload });
      assert.equal(response.status, 200, `${routingMode}/${requestFormat}: ${await response.clone().text()}`);
      const result = await response.json();
      assert.equal(responses ? result.choices[0].message.content : result.output[0].content[0].text, 'converted');
      assert.equal(calls[0].url, 'https://upstream.test/v1/' + requestFormat);
      assert.equal(calls[0].body.model, 'upstream-model');
      assert.equal(calls[0].headers.Authorization, 'Bearer test-upstream-key');
      assert.equal(responses ? calls[0].body.input[0].content : calls[0].body.messages[0].content, 'question');
    }
  }
});

test('two Keys can translate opposite protocols concurrently without sharing preferences', async t => {
  const { send, calls, state, context } = await gateway(t, { state: { requestFormatEnabled: true, requestFormat: 'responses',
    secondaryRouting: { unifiedKey: 'second-local', routingEnabled: true, routingMode: 'unified', requestFormatEnabled: true, requestFormat: 'chat/completions',
      unifiedRoute: { providerId: 'test', apiKey: 'second-key', model: 'upstream-model', models: ['upstream-model'] } } } });
  state.providers[0].apiKeys[1].enabled = true;
  state.providers[0].apiKeyModels = { 'second-key': ['upstream-model'] };
  // Return the corresponding protocol's JSON, with a small overlap between requests.
  context.fetch = async (url, request) => {
    calls.push({ url, headers: request.headers, body: JSON.parse(request.body) });
    await new Promise(resolve => setTimeout(resolve, 10));
    return url.endsWith('/responses')
      ? Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'first' }] }] })
      : Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'second' }, finish_reason: 'stop' }] });
  };
  const [first, second] = await Promise.all([
    send('/chat/completions', { model: 'Pet model', messages: [{ role: 'user', content: 'one' }] }),
    send('/responses', { model: 'Pet model', input: 'two' }, 'second-local')
  ]);
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal((await first.json()).choices[0].message.content, 'first');
  assert.equal((await second.json()).output[0].content[0].text, 'second');
  assert.equal(calls.find(call => call.url.endsWith('/responses')).headers.Authorization, 'Bearer test-upstream-key');
  assert.equal(calls.find(call => call.url.endsWith('/chat/completions')).headers.Authorization, 'Bearer second-key');
  assert.equal(state.requestFormat, 'responses');
  assert.equal(state.secondaryRouting.requestFormat, 'chat/completions');
});

test('unsupported conversion returns 400 before sending to the provider; provider errors retain status', async t => {
  const { send, calls } = await gateway(t, { state: { requestFormatEnabled: true, requestFormat: 'chat/completions' },
    response: () => Response.json({ error: { message: 'rate limit' } }, { status: 429 }) });
  const rejected = await send('/responses', { model: 'Pet model', input: 'x', previous_response_id: 'resp_old' });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.type, 'api_pet_format_error');
  assert.equal(calls.length, 0);
  const error = await send('/responses', { model: 'Pet model', input: 'x' });
  assert.equal(error.status, 429);
  assert.equal((await error.json()).error.message, 'rate limit');
});

test('converted SSE reaches real HTTP clients in their original protocol', async t => {
  for (const requestFormat of ['responses', 'chat/completions']) {
    const responses = requestFormat === 'responses';
    const frames = responses ? [
      { type: 'response.created', response: { id: 'resp_http', model: 'upstream-model', created_at: 1 } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '你好' },
      { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '你好' }] }] } }
    ] : [
      { id: 'chat_http', model: 'upstream-model', choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ];
    const { send } = await gateway(t, { state: { requestFormatEnabled: true, requestFormat },
      response: () => new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } }) });
    const result = await send(responses ? '/chat/completions' : '/responses', { model: 'Pet model', stream: true,
      ...(responses ? { messages: [{ role: 'user', content: 'hello' }] } : { input: 'hello' }) });
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type'), /text\/event-stream/);
    const data = await result.text();
    assert.match(data, /你好/);
    assert.match(data, responses ? /chat.completion.chunk/ : /event: response.output_text.delta/);
    assert.match(data, responses ? /\[DONE\]/ : /event: response.completed/);
  }
});

test('site Key route maps the local API Pet Key to the selected site Key', async t => {
  const provider = { id: 'site-a', models: [], apiKey: 'site-a-key', apiKeys: [{ key: 'site-a-key', enabled: true }], apiKeyModels: { 'site-a-key': ['a-model'] }, requestUrl: 'https://site-a.test/v1' };
  const state = { routingEnabled: true, routingMode: 'key', routes: {}, providers: [provider], unifiedKey: 'local-key', keyRoute: { providerId: 'site-a', apiKey: 'site-a-key', models: ['a-model'] } };
  const calls = [];
  const context = vm.createContext({ state, prepareGatewayRequest, translateGatewayResponse, http, PORT: 0, Buffer, console, mainWindow: null,
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
  assert.equal(migrated.requestFormatEnabled, false);
  assert.equal(migrated.secondaryRouting.requestFormatEnabled, false);
  assert.equal(migrated.requestFormat, 'responses');
  assert.equal(migrated.secondaryRouting.requestFormat, 'responses');
  saved.secondaryRouting = JSON.parse(JSON.stringify(migrated.secondaryRouting));
  saved.secondaryRouting.routingEnabled = true;
  saved.secondaryRouting.lanAccess = true;
  saved.secondaryRouting.requestFormatEnabled = true;
  saved.secondaryRouting.requestFormat = 'chat/completions';
  saved.secondaryRouting.routingMode = 'key';
  saved.secondaryRouting.keyRoute = { providerId: 'site', apiKey: 'upstream', models: ['model'] };
  const loaded = context.loadState();
  assert.equal(loaded.secondaryRouting.unifiedKey, saved.secondaryRouting.unifiedKey);
  assert.equal(loaded.secondaryRouting.keyRoute.apiKey, 'upstream');
  assert.equal(loaded.secondaryRouting.lanAccess, true);
  assert.equal(loaded.lanAccess, false);
  assert.equal(loaded.secondaryRouting.requestFormatEnabled, true);
  assert.equal(loaded.secondaryRouting.requestFormat, 'chat/completions');
  assert.equal(loaded.requestFormatEnabled, false);
  saved.providers[0].apiKeys = [];
  assert.equal(context.loadState().secondaryRouting.keyRoute.apiKey, '');
});

test('third group migrates disabled with a unique Key and preserves all saved groups on reload', () => {
  let saved = { unifiedKey: 'first-local', providers: [], secondaryRouting: { unifiedKey: 'second-local', routingEnabled: true, routingMode: 'key', requestFormatEnabled: true, requestFormat: 'chat/completions' } };
  const context = vm.createContext({ crypto, fs: { readFileSync: () => JSON.stringify(saved) }, dataPath: () => 'isolated-test', normalizeProvider: item => item });
  ['defaultState', 'providerModels', 'selectProviderApiKey', 'unifiedRouteKey', 'normalizeUnifiedRoute', 'normalizeKeyRoute', 'loadState'].forEach(name => include(context, name));
  const loaded = context.loadState();
  assert.equal(loaded.unifiedKey, 'first-local');
  assert.equal(loaded.secondaryRouting.unifiedKey, 'second-local');
  assert.equal(loaded.secondaryRouting.routingEnabled, true);
  assert.equal(loaded.thirdRouting.routingEnabled, false);
  assert.equal(loaded.thirdRouting.lanAccess, false);
  assert.equal(loaded.thirdRouting.requestFormatEnabled, false);
  assert.equal(new Set([loaded.unifiedKey, loaded.secondaryRouting.unifiedKey, loaded.thirdRouting.unifiedKey]).size, 3);
  saved = JSON.parse(JSON.stringify(loaded));
  saved.thirdRouting.routingEnabled = true; saved.thirdRouting.lanAccess = true;
  saved.thirdRouting.requestFormatEnabled = true; saved.thirdRouting.requestFormat = 'chat/completions';
  const reloaded = context.loadState();
  assert.deepEqual(JSON.parse(JSON.stringify(reloaded.thirdRouting)), saved.thirdRouting);
  assert.deepEqual(JSON.parse(JSON.stringify(reloaded.secondaryRouting)), saved.secondaryRouting);
  saved.thirdRouting.unifiedKey = saved.secondaryRouting.unifiedKey;
  assert.notEqual(context.loadState().thirdRouting.unifiedKey, saved.secondaryRouting.unifiedKey);
});

for (const modes of [['unified', 'model', 'key'], ['key', 'unified', 'model'], ['model', 'key', 'unified']]) {
  test(`three local Keys isolate simultaneous ${modes.join('/')} routes and disabled groups`, async t => {
    const providers = ['a', 'b', 'c'].map(id => ({ id, models: ['shared-model'], apiKey: `${id}-key`, apiKeys: [{ key: `${id}-key`, enabled: true }], apiKeyModels: { [`${id}-key`]: ['shared-model'] }, requestUrl: `https://${id}.test/v1` }));
    const config = (provider, routingMode) => ({ routingEnabled: true, routingMode, unifiedKey: `${provider.id}-local`, routes: { 'shared-model': provider.id },
      unifiedRoute: { providerId: provider.id, apiKey: provider.apiKey, model: 'shared-model', models: ['shared-model'] }, keyRoute: { providerId: provider.id, apiKey: provider.apiKey, models: ['shared-model'] } });
    const groups = providers.map((provider, index) => config(provider, modes[index]));
    const { send, calls, base, state } = await gateway(t, { state: { ...groups[0], secondaryRouting: groups[1], thirdRouting: groups[2], providers } });
    const results = await Promise.all(groups.map((group, index) => send('/responses', { model: modes[index] === 'unified' ? 'Pet model' : 'shared-model', input: 'hello' }, group.unifiedKey)));
    for (const result of results) { assert.equal(result.status, 200); await result.text(); }
    for (const provider of providers) assert.ok(calls.some(call => call.url === `https://${provider.id}.test/v1/responses` && call.headers.Authorization === `Bearer ${provider.apiKey}`));
    for (const [index, group] of [state, state.secondaryRouting, state.thirdRouting].entries()) {
      group.routingEnabled = false;
      const models = await fetch(base + '/models', { headers: { Authorization: `Bearer ${group.unifiedKey}` } });
      assert.deepEqual((await models.json()).data, []);
      const denied = await send('/responses', { model: modes[index] === 'unified' ? 'Pet model' : 'shared-model' }, group.unifiedKey);
      assert.equal(denied.status, 400); await denied.text();
      group.routingEnabled = true;
    }
    assert.equal((await send('/responses', { model: 'shared-model' }, 'wrong-key')).status, 401);
  });
}

test('third group IPC settings and pending model discovery do not change either existing group', async () => {
  const handlers = {};
  const config = () => ({ routes: {}, unifiedRoute: {}, keyRoute: {}, routingMode: 'model', routingEnabled: false });
  const state = { ...config(), secondaryRouting: config(), thirdRouting: config(), providers: [{ id: 'site', models: ['third-model'], apiKeys: [{ key: 'third-key' }] }] };
  const before = JSON.stringify([state.routes, state.unifiedRoute, state.keyRoute, state.secondaryRouting]);
  let saved;
  const context = vm.createContext({ state, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, persist() { saved = JSON.parse(JSON.stringify(state)); return true; }, safeState: () => state,
    fetchModels: async () => ['third-model'], modelsForApiKey: async () => ['third-model'], providerModels: item => item.models });
  include(context, 'unifiedRouteKey');
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('set-route'"), source.indexOf("ipcMain.handle('quit'")), context);
  handlers['set-routing-enabled'](null, true, 3);
  handlers['set-routing-mode'](null, 'unified', 3);
  handlers['set-route'](null, { model: 'third-model', providerId: 'site' }, 3);
  handlers['set-routing-request-format'](null, { enabled: true, format: 'chat/completions' }, 3);
  await handlers['set-unified-route'](null, { providerId: 'site', keyIndex: 0 }, 3);
  await handlers['set-unified-route'](null, { providerId: 'site', model: 'third-model' }, 3);
  await handlers['set-key-route'](null, { providerId: 'site', keyIndex: 0 }, 3);
  assert.equal(saved.thirdRouting.routingEnabled, true);
  assert.equal(saved.thirdRouting.routes['third-model'], 'site');
  assert.equal(saved.thirdRouting.unifiedRoute.model, 'third-model');
  assert.equal(saved.thirdRouting.keyRoute.apiKey, 'third-key');
  assert.equal(saved.thirdRouting.requestFormat, 'chat/completions');
  assert.equal(JSON.stringify([state.routes, state.unifiedRoute, state.keyRoute, state.secondaryRouting]), before);
});

test('provider deletion clears matching targets in all three groups without clearing other routes', () => {
  const handlers = {};
  const config = () => ({ routes: { removed: 'removed', kept: 'kept' }, unifiedRoute: { providerId: 'removed' }, keyRoute: { providerId: 'removed' } });
  const state = { ...config(), secondaryRouting: config(), thirdRouting: config(), providers: [{ id: 'removed' }, { id: 'kept' }] };
  const context = vm.createContext({ state, ipcMain: { handle: (name, handler) => { handlers[name] = handler; } }, persist() {}, safeState: () => state });
  const start = source.indexOf("ipcMain.handle('delete-provider'");
  vm.runInContext(source.slice(start, source.indexOf("ipcMain.handle('test-provider'", start)), context);
  handlers['delete-provider'](null, 'removed');
  assert.deepEqual(state.providers, [{ id: 'kept' }]);
  for (const group of [state, state.secondaryRouting, state.thirdRouting]) {
    assert.equal(group.routes.removed, undefined);
    assert.equal(group.routes.kept, 'kept');
    assert.equal(group.unifiedRoute.providerId, '');
    assert.equal(group.keyRoute.providerId, '');
  }
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
  for (const allowedGroup of [1,2,3]) {
    const first = {lanAccess:allowedGroup===1, secondaryRouting:{unifiedKey:'second-local',routingEnabled:true,routingMode:'unified',routes:{},unifiedRoute:{providerId:'test',model:'upstream-model'},lanAccess:allowedGroup===2},
      thirdRouting:{unifiedKey:'third-local',routingEnabled:true,routingMode:'unified',routes:{},unifiedRoute:{providerId:'test',model:'upstream-model'},lanAccess:allowedGroup===3}};
    const {base,send,calls,server}=await gateway(t,{state:first,remoteAddress:'192.168.0.22'});
    assert.equal(server.address().address,'0.0.0.0');
    for (const [group,key] of [[1,'test-local-key'],[2,'second-local'],[3,'third-local']]) {
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
  state.thirdRouting={lanAccess:false};
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
  await context.setRoutingLanAccess(true,3);
  await context.setRoutingLanAccess(false,1);
  assert.equal(context.gateway.address().address,'0.0.0.0');
  assert.equal(state.thirdRouting.lanAccess,true);
  await context.setRoutingLanAccess(false,3);
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
