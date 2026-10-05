const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function load(fetch, runtime = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, ...runtime });
  for (const name of ['cleanBaseUrl', 'providerBaseUrls', 'selectProviderApiKey', 'modelFetch', 'fetchModels']) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    const rest = source.slice(start);
    const next = rest.slice(1).search(/^(?:async )?function |^let |^ipcMain\./m);
    vm.runInContext(next < 0 ? rest : rest.slice(0, next + 1), context);
  }
  return key => context.fetchModels({ loginUrl: 'https://models.test', apiKey: key });
}

test('model discovery accepts OpenAI lists and falls back for missing routes', async () => {
  const calls = [];
  const models = load(async url => {
    calls.push(url);
    return calls.length === 1 ? new Response('<!doctype html><html></html>')
      : Response.json({ data: [{ id: 'image-model' }, 'chat-model'] });
  });
  assert.deepEqual(Array.from(await models('test-key')), ['image-model', 'chat-model']);
  assert.deepEqual(calls, ['https://models.test/v1/models', 'https://models.test/models']);
});

test('desktop model discovery uses Chromium networking and retains authorization and cancellation', async () => {
  let calls = 0;
  const models = load(() => { throw new Error('Node networking must not be used in Electron'); }, {
    process: { versions: { electron: '31' } },
    net: { fetch: async (url, options) => {
      calls += 1;
      assert.equal(url, 'https://models.test/v1/models');
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      assert.equal(options.headers.Accept, 'application/json');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.bypassCustomProtocolHandlers, true);
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      return Response.json({ data: [{ id: 'chat-model' }] });
    } }
  });
  assert.deepEqual(Array.from(await models('test-key')), ['chat-model']);
  assert.equal(calls, 1);
});

test('authentication failures retain the API error instead of trying a webpage', async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    const models = load(async () => {
      calls += 1;
      return Response.json({ error: { message: 'Invalid token' } }, { status });
    });
    await assert.rejects(models('test-key'), /https:\/\/models.test\/v1\/models: (401|403).*Invalid token/);
    assert.equal(calls, 1);
  }
});

test('masked keys fail before making a request', async () => {
  const models = load(() => { throw new Error('Must not send masked keys'); });
  await assert.rejects(models('sk-ab********cd'), /API Key.*脱敏/);
});

test('HTML responses explain the wrong endpoint without dumping page markup', async () => {
  const models = load(async () => new Response('<!doctype html><html>page</html>'));
  await assert.rejects(models('test-key'), error => {
    assert.match(error.message, /HTML.*API/);
    assert.ok(!error.message.includes('<!doctype'));
    return true;
  });
});
