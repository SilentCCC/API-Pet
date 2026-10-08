const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const start = source.indexOf('async function directChatRequest(');
const end = source.indexOf('async function proxyChat(', start);

function chat(responses, bases = ['https://chat.test/v1', 'https://chat.test']) {
  const calls = [], results = [], events = [];
  const provider = { id: 'test', name: 'Test site', models: ['test-model'], apiKey: 'test-key' };
  const context = vm.createContext({
    state: { providers: [provider] },
    providerModels: item => item.models,
    providerBaseUrls: () => bases,
    selectProviderApiKey: item => item.apiKey,
    recordProviderRequest() {}, persist() {}, extractUsage: () => ({}),
    recordProviderResult: (_provider, _started, success) => results.push(success),
    mainWindow: { webContents: { send: (_channel, event) => events.push(event.status) } },
    fetch: async (url, request) => {
      calls.push({ url, body: JSON.parse(request.body) });
      assert.ok(responses.length >= calls.length, 'Unexpected fallback request');
      return responses[calls.length - 1];
    }
  });
  vm.runInContext(source.slice(start, end), context);
  return {
    calls, results, events,
    send: format => context.directChatRequest({ providerId: 'test', model: 'test-model', format,
      messages: [{ role: 'user', content: 'hello' }], input: 'hello' })
  };
}

for (const format of ['responses', 'chat/completions']) {
  test(`${format}: upstream errors retain their message without reading the body twice`, async () => {
    for (const status of [400, 401, 403, 429, 500]) {
      const response = Response.json({ error: { message: 'Upstream rejected request' } }, { status });
      const { send, calls, results, events } = chat([response]);
      await assert.rejects(send(format), error => {
        assert.match(error.message, new RegExp(`^${status} .*Upstream rejected request`));
        assert.doesNotMatch(error.message, /Body is unusable|already been read/);
        return true;
      });
      assert.equal(calls.length, 1, 'No fallback for authentication, rate limits or service errors');
      assert.equal(response.bodyUsed, true);
      assert.deepEqual(results, [false]);
      assert.deepEqual(events, ['requesting', 'error']);
    }
  });

  test(`${format}: missing endpoints fall back to a successful response`, async () => {
    for (const first of [
      Response.json({ error: { message: 'Missing endpoint' } }, { status: 404 }),
      new Response('Method not allowed', { status: 405 }),
      new Response('<html>Console</html>', { headers: { 'Content-Type': 'text/html' } })
    ]) {
      const payload = format === 'responses' ? { output_text: 'hello' }
        : { choices: [{ message: { content: 'hello' } }] };
      const { send, calls, results, events } = chat([first, Response.json(payload)]);
      assert.deepEqual(JSON.parse(JSON.stringify(await send(format))), payload);
      assert.deepEqual(calls.map(call => call.url), [`https://chat.test/v1/${format}`, `https://chat.test/${format}`]);
      assert.deepEqual(results, [true]);
      assert.deepEqual(events, ['requesting', 'success']);
    }
  });

  test(`${format}: exhausted fallback reports the final upstream error`, async () => {
    const { send, calls } = chat([
      Response.json({ error: { message: 'Missing first endpoint' } }, { status: 404 }),
      Response.json({ error: { message: 'Missing final endpoint' } }, { status: 404 })
    ]);
    await assert.rejects(send(format), /404 .*Missing final endpoint/);
    assert.equal(calls.length, 2);
  });

  test(`${format}: HTML and plain error responses are reported as failures`, async () => {
    const html = chat([new Response('<html>Login page</html>', { headers: { 'Content-Type': 'text/html' } })], ['https://chat.test/v1']);
    await assert.rejects(html.send(format), /200 .*Login page/);
    assert.deepEqual(html.results, [false]);
    const plain = chat([new Response('Upstream unavailable', { status: 503 })]);
    await assert.rejects(plain.send(format), /503 .*Upstream unavailable/);
  });
}
