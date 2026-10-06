const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { buildRequest, requestImage, imageSources, imageData } = require('../src/image-generation');
const { getImageSizeSelection } = require('../src/renderer/image-config');
const bytes = fs.readFileSync(path.join(__dirname, '../src/renderer/assets/pet-normal.png'));
const reference = `data:image/png;base64,${bytes.toString('base64')}`;
const defaults = { model: 'gpt-image-2', prompt: 'A cat', resolution: '1K', ratio: '1:1', quality: 'auto' };
const build = options => buildRequest('https://example.invalid/v1', 'test-only', { ...defaults, ...options });
const fields = request => typeof request.init.body === 'string' ? JSON.parse(request.init.body) : Object.fromEntries(request.init.body);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

for (const model of ['gpt-image-2', 'seedream-v5-lite', 'seedream-5.0-pro', 'grok-imagine-image', 'grok-imagine-image-2.0', 'sensenova-u1.5-lite', 'gemini-3.1-flash-image-preview']) {
  for (const editing of [false, true]) test(`${model}: ${editing ? 'reference image' : 'text'}, auto quality omitted`, () => {
    const request = build({ model, referenceImages: editing ? [reference, reference] : [] });
    const body = fields(request);
    assert.equal(request.init.headers.Authorization, 'Bearer test-only');
    assert.equal(request.init.headers['x-goog-api-key'], undefined);
    assert.equal(body.quality, undefined);
    if (model.startsWith('gemini')) {
      assert.match(request.url, /\/v1beta\/models\/.*:generateContent$/);
      assert.equal(body.contents[0].parts.length, editing ? 3 : 1);
      assert.deepEqual(body.generationConfig.imageConfig, { imageSize: '1K', aspectRatio: '1:1' });
    } else {
      assert.ok(request.url.endsWith(editing ? '/images/edits' : '/images/generations'));
      if (model.startsWith('seedream')) {
        assert.equal(body.response_format, 'b64_json');
        assert.equal(String(body.n), '1');
        assert.equal(body.output_format, 'png');
        if (editing) assert.equal(request.init.body.getAll('image[]').length, 2);
      } else if (model === 'grok-imagine-image-2.0' || model === 'sensenova-u1.5-lite') {
        if (editing) assert.deepEqual(body.images, [{ image_url: reference }, { image_url: reference }]);
        if (model.startsWith('sense')) assert.equal(body.watermark, true);
      } else if (editing) {
        assert.equal(request.init.headers['Content-Type'], undefined);
        assert.equal(request.init.body.getAll(model.startsWith('grok') ? 'image[]' : 'image').length, 2);
      }
    }
  });
}

test('explicit quality, endpoint choice, Gemini auto ratio and Grok JSON single reference', () => {
  for (const model of ['gpt-image-2', 'seedream-v5-pro']) {
    assert.equal(fields(build({ model, quality: 'high' })).quality, 'high');
    assert.equal(fields(build({ model, quality: 'low', referenceImages: [reference] })).quality, 'low');
  }
  const gemini = fields(build({ model: 'gemini-3-pro-image', resolution: 'auto', ratio: '16:9' }));
  assert.deepEqual(gemini.generationConfig.imageConfig, { aspectRatio: '16:9' });
  const grok = build({ model: 'grok-imagine-image-2.0', quality: 'medium', referenceImages: [reference], editEndpoint: 'generations' });
  assert.ok(grok.url.endsWith('/generations'));
  assert.equal(fields(grok).quality, 'medium');
  assert.deepEqual(fields(grok).image, { image_url: reference });
  assert.equal(fields(build({ model: 'grok-imagine-image', quality: 'high', referenceImages: [reference] })).quality, undefined);
});

test('model constraints and size changes', () => {
  assert.throws(() => build({ referenceImages: Array(5).fill(reference) }), /最多/);
  assert.throws(() => build({ referenceImages: ['bad'] }), /格式/);
  assert.throws(() => build({ prompt: ' ' }), /描述/);
  assert.throws(() => build({ model: 'sensenova-u1-fast', referenceImages: [reference] }), /不支持/);
  assert.throws(() => build({ model: 'gemini-3-pro-image', resolution: 'custom' }), /自定义/);
  assert.equal(fields(build({ resolution: '2K', ratio: '16:9', size: '1024x1024' })).size, '2048x1152');
  const custom = getImageSizeSelection({ model: 'sensenova-u1.5-lite', resolution: 'custom', width: 4096, height: 512 });
  assert.equal(custom.size, '1536x512');
  assert.equal(getImageSizeSelection({ model: 'seedream-v5-pro', resolution: 'auto' }).resolution, '1K');
  assert.equal(fields(build({ model: 'sensenova-u1-fast' })).size, '2048x2048');
  assert.equal(buildRequest('https://example.invalid/v1beta/v1', 'test-only', { ...defaults, model: 'gemini-3-pro-image' }).url, 'https://example.invalid/v1beta/models/gemini-3-pro-image:generateContent');
});

test('Base64 output uses actual JPEG/WebP MIME for preview and saved extension', async () => {
  const jpeg = await imageData(`data:image/png;base64,${Buffer.from([255, 216, 255, 224]).toString('base64')}`);
  assert.equal(jpeg.mimeType, 'image/jpeg');
  const webp = await imageData(`data:image/png;base64,${Buffer.from('RIFF0000WEBP').toString('base64')}`);
  assert.equal(webp.mimeType, 'image/webp');
});

test('real HTTP multipart transport and remote image download without credentials', async () => {
  let received;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = { headers: req.headers, body: Buffer.concat(chunks).toString() };
    if (req.url === '/image.png') { res.setHeader('Content-Type', 'image/png'); res.end(bytes); }
    else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const generated = await requestImage({ bases: [base], apiKey: 'test-only', options: { ...defaults, referenceImages: [reference] } });
    assert.equal(generated.url, reference);
    assert.match(received.headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.match(received.body, /name="image"; filename="reference-1.png"/);
    assert.ok(!received.body.includes('name="quality"'));
    const downloaded = await imageData(`${base}/image.png`);
    assert.deepEqual(downloaded.bytes, bytes);
    assert.equal(received.headers.authorization, undefined);
    assert.equal(received.headers['x-goog-api-key'], undefined);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('fallback only for missing endpoints, no auth retry, unique Gemini URL', async () => {
  const calls = [];
  const options = { bases: ['https://example.invalid/v1', 'https://example.invalid'], apiKey: 'test-only', options: defaults };
  const result = await requestImage({ ...options, fetchImpl: async url => {
    calls.push(url); return calls.length === 1 ? json({ error: { message: 'Invalid URL' } }, 404) : json({ data: [{ url: 'https://example.invalid/image.png' }] });
  } });
  assert.equal(calls.length, 2); assert.ok(result.url.endsWith('/image.png'));
  calls.length = 0;
  await assert.rejects(requestImage({ ...options, fetchImpl: async url => { calls.push(url); return json({ error: { message: 'invalid token' } }, 401); } }), /401.*invalid token/);
  assert.equal(calls.length, 1);
  calls.length = 0;
  await assert.rejects(requestImage({ ...options, options: { ...defaults, model: 'gemini-3-pro-image' }, fetchImpl: async url => { calls.push(url); return json({}, 404); } }), /404/);
  assert.equal(calls.length, 1);
});

test('SSE response, Gemini task polling, terminal failure and timeout', async () => {
  const common = { bases: ['https://example.invalid/v1'], apiKey: 'test-only', options: { ...defaults, model: 'gemini-3-pro-image' } };
  const streamed = await requestImage({ ...common, fetchImpl: async () => new Response(`data: {"status":"running"}\n\ndata: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: bytes.toString('base64') } }] } }] })}\n\ndata: [DONE]\n\n`) });
  assert.equal(streamed.url, reference);
  const calls = [];
  const polled = await requestImage({ ...common, fetchImpl: async (url, init) => {
    calls.push(url); assert.equal(init.headers['x-goog-api-key'], undefined);
    return calls.length === 1 ? json({ task_id: 'task/1', status: 'pending' }) : json({ status: 'completed', data: [{ url: 'https://example.invalid/image.png' }] });
  } });
  assert.ok(polled.url.endsWith('image.png'));
  assert.ok(calls[1].endsWith('/v1/images/tasks/task%2F1'));
  await assert.rejects(requestImage({ ...common, fetchImpl: async () => json({ task_id: 'x', state: 'failed', error: { message: 'task failed' } }) }), /task failed/);
  await assert.rejects(requestImage({ ...common, timeoutMs: 20, fetchImpl: async (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) }), /超时/);
  assert.deepEqual(imageSources({ result: { images: [{ b64_json: 'YQ==' }] } }), ['data:image/png;base64,YQ==']);
});

test('drawing IPC selects chat Key, batches partial results and saves without another generation', async () => {
  const handlers = {}, calls = [], metrics = [];
  const provider = { id: 'test', name: 'Test', models: ['gpt-image-2'], apiKeys: [{ key: 'first' }, { key: 'second' }] };
  let generation = 0, saved, canceled = false;
  const ctx = vm.createContext({
    ipcMain: { handle: (name, fn) => handlers[name] = fn }, state: { providers: [provider], unifiedRoute: { providerId: 'test' } }, mainWindow: null,
    providerModels: p => p.models, findProviderForModel: () => provider, resolveRequestedModel: () => ctx.state.unifiedRoute.model || 'gpt-image-2', selectProviderApiKey: () => 'first',
    unifiedRouteKey: p => p.apiKeys.find(item=>item.key===ctx.state.unifiedRoute.apiKey)?.key || '', providerBaseUrls: () => ['https://example.invalid/v1'],
    recordProviderRequest() {}, recordProviderResult: (_p, _t, success) => metrics.push(success), persist() {},
    requestImage: async input => { calls.push(input); if (++generation === 2) throw new Error('one failed'); return { url: reference }; },
    imageData: async () => ({ bytes, mimeType: 'image/png' }),
    dialog: { showSaveDialog: async () => ({ canceled, filePath: 'test.png' }) }, fs: { promises: { writeFile: async (file, data) => saved = { file, data } } }
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('generate-images'"), source.indexOf("ipcMain.handle('save-provider'")), ctx);
  const result = await handlers['generate-images'](null, { ...defaults, providerId: 'test', apiKeyIndex: 1, count: 3 });
  assert.equal(result.ok, true); assert.equal(result.images.length, 2); assert.equal(result.errors[0], 'one failed');
  assert.ok(calls.every(call => call.apiKey === 'second'));
  assert.deepEqual(metrics.sort(), [false, true, true]);
  assert.equal((await handlers['save-generated-image'](null, reference)).ok, true);
  assert.deepEqual(saved.data, bytes); assert.equal(generation, 3);
  canceled = true;
  assert.equal((await handlers['save-generated-image'](null, reference)).canceled, true);
  assert.equal((await handlers['generate-images'](null, { ...defaults, providerId: 'test', apiKeyIndex: 9 })).ok, false);
  const actualPetModel = await handlers['generate-images'](null, { ...defaults, model: 'Pet model', providerId: 'test', apiKeyIndex: 1 });
  assert.equal(actualPetModel.ok, true);
  assert.equal(calls.at(-1).options.model, 'Pet model', 'Explicit site models are never rewritten as a gateway alias');
  ctx.state.unifiedRoute={providerId:'test',apiKey:'second',model:'key-only-image',models:['key-only-image']};
  const routedImage=await handlers['generate-images'](null,{...defaults,model:'Pet model'});
  assert.equal(routedImage.ok,true);
  assert.equal(calls.at(-1).apiKey,'second');
  assert.equal(calls.at(-1).options.model,'key-only-image');
});
