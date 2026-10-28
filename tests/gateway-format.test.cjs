const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { prepareGatewayRequest, translateGatewayResponse, chatToResponses, responsesToChat, completionToResponse, responsesToCompletion } = require('../src/gateway-format');

const usage = { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29, prompt_tokens_details: { cached_tokens: 12 }, completion_tokens_details: { reasoning_tokens: 3 } };
const completion = { id: 'chatcmpl_test', model: 'model', created: 123, choices: [{ index: 0, message: { role: 'assistant', content: '你好', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"上海"}' } }] }, finish_reason: 'tool_calls' }], usage };
const response = { id: 'resp_test', model: 'model', created_at: 123, status: 'completed', output: [
  { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好', annotations: [] }] },
  { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '{"city":"上海"}' }
], usage: { input_tokens: 20, output_tokens: 9, total_tokens: 29, input_tokens_details: { cached_tokens: 12 }, output_tokens_details: { reasoning_tokens: 3 } } };

test('unchecked and same-format gateway requests preserve provider extensions', () => {
  const body = { model: 'm', messages: [], provider_extension: true };
  assert.equal(prepareGatewayRequest(body, '/chat/completions', {}).body, body);
  assert.equal(prepareGatewayRequest(body, '/chat/completions', { requestFormatEnabled: true, requestFormat: 'chat/completions' }).body, body);
  assert.equal(prepareGatewayRequest(body, '/chat/completions', { requestFormatEnabled: false, requestFormat: 'responses' }).endpoint, '/chat/completions');
});

test('Chat request translates instructions, images, function definitions, results and generation controls', () => {
  const request = { model: 'm', stream: true, messages: [
    { role: 'system', content: 'rules' },
    { role: 'user', content: [{ type: 'text', text: '图片' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '晴' }
  ], tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: {} } } }],
    tool_choice: { type: 'function', function: { name: 'weather' } }, max_completion_tokens: 200, reasoning_effort: 'low',
    response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' }, strict: true } }, stream_options: { include_usage: true } };
  const converted = chatToResponses(request);
  assert.equal(converted.input[0].role, 'system');
  assert.equal(converted.input[1].content[0].type, 'input_text');
  assert.deepEqual(converted.input[1].content[1], { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' });
  assert.deepEqual(converted.input[2], { type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '{}' });
  assert.deepEqual(converted.input[3], { type: 'function_call_output', call_id: 'call_1', output: '晴' });
  assert.equal(converted.tools[0].name, 'weather');
  assert.equal(converted.tools[0].strict, false);
  assert.deepEqual(converted.tool_choice, { type: 'function', name: 'weather' });
  assert.equal(converted.max_output_tokens, 200);
  assert.deepEqual(converted.reasoning, { effort: 'low' });
  assert.equal(converted.text.format.name, 'answer');
  assert.equal(converted.messages, undefined);
  assert.equal(request.messages[1].content[0].type, 'text');
});

test('Responses request translates full multi-turn history, parallel calls and structured output', () => {
  const converted = responsesToChat({ model: 'm', instructions: 'rules', input: [
    { role: 'user', content: [{ type: 'input_text', text: 'hello' }, { type: 'input_image', image_url: 'https://example.invalid/i.png' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
    { type: 'function_call', call_id: 'a', name: 'one', arguments: '{}' },
    { type: 'function_call', call_id: 'b', name: 'two', arguments: '{}' },
    { type: 'function_call_output', call_id: 'a', output: 'a result' },
    { type: 'function_call_output', call_id: 'b', output: 'b result' }
  ], tools: [{ type: 'function', name: 'one', parameters: { type: 'object' }, strict: false }], tool_choice: { type: 'function', name: 'one' },
    text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true } }, max_output_tokens: 60, stream: true });
  assert.equal(converted.messages[0].content, 'rules');
  assert.equal(converted.messages[1].content[1].type, 'image_url');
  assert.equal(converted.messages[2].tool_calls.length, 2);
  assert.equal(converted.messages[3].tool_call_id, 'a');
  assert.equal(converted.messages[4].content, 'b result');
  assert.equal(converted.tools[0].function.name, 'one');
  assert.equal(converted.tool_choice.function.name, 'one');
  assert.equal(converted.response_format.json_schema.name, 'answer');
  assert.equal(converted.max_completion_tokens, 60);
  assert.equal(converted.stream_options.include_usage, true);
  assert.equal(converted.input, undefined);
});

test('conversion rejects unsupported state, built-in tools and parameters explicitly', () => {
  for (const extra of [{ previous_response_id: 'resp_old' }, { conversation: 'conv_old' }, { background: true }, { include: ['reasoning.encrypted_content'] }, { tools: [{ type: 'web_search' }] }, { input: [{ type: 'item_reference', id: 'msg_old' }] }]) {
    assert.throws(() => responsesToChat({ model: 'm', input: 'x', ...extra }), /请求格式转换/);
  }
  for (const extra of [{ n: 2 }, { frequency_penalty: 1 }, { audio: {} }, { seed: 3 }, { messages: [{ role: 'user', content: [{ type: 'input_audio' }] }] }]) {
    assert.throws(() => chatToResponses({ model: 'm', messages: [], ...extra }), /请求格式转换/);
  }
});

test('nonstream results preserve text, tools and cached/reasoning token usage both ways', () => {
  const convertedResponse = completionToResponse(completion);
  assert.equal(convertedResponse.output[0].content[0].text, '你好');
  assert.equal(convertedResponse.output[1].call_id, 'call_1');
  assert.deepEqual(convertedResponse.usage, response.usage);
  const convertedCompletion = responsesToCompletion(response);
  assert.deepEqual(convertedCompletion.choices, completion.choices.map(choice => ({ ...choice, logprobs: null })));
  assert.deepEqual(convertedCompletion.usage, usage);
  assert.equal(responsesToCompletion({ ...response, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }).choices[0].finish_reason, 'length');
  assert.equal(completionToResponse({ ...completion, choices: [{ message: { refusal: 'denied' }, finish_reason: 'content_filter' }] }).status, 'incomplete');
  assert.equal(responsesToCompletion({ status: 'failed', error: { message: 'bad' } }).error.message, 'bad');
});

class Output extends EventEmitter {
  constructor() { super(); this.frames = []; }
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }
  write(chunk) { this.frames.push(chunk); return true; }
  end(chunk) { if (chunk) this.frames.push(chunk); this.writableEnded = true; }
  events() { return this.frames.join('').split(/\n\n/).map(frame => frame.split('\n').find(line => line.startsWith('data: '))?.slice(6)).filter(Boolean).map(data => data === '[DONE]' ? data : JSON.parse(data)); }
}
function upstream(events) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`).join(''));
  // Deliberately split all UTF-8 and SSE record boundaries.
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
function chunks() {
  const item = delta => ({ id: 'chat_test', model: 'model', created: 123, choices: [{ index: 0, delta, finish_reason: null }] });
  return [item({ role: 'assistant' }), item({ content: '你' }), item({ content: '好' }),
    item({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'wea', arguments: '' } }] }),
    item({ tool_calls: [{ index: 0, function: { name: 'ther', arguments: '{"city":' } }] }),
    item({ tool_calls: [{ index: 0, function: { arguments: '"上海"}' } }] }),
    { ...item({}), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, { ...item({}), choices: [], usage }, '[DONE]'];
}
test('Chat SSE becomes Responses events incrementally with tools, final snapshots and usage', async () => {
  const output = new Output();
  const result = await translateGatewayResponse(upstream(chunks()), output, '/chat/completions', { stream: true });
  const events = output.events();
  assert.equal(events[0].type, 'response.created');
  assert.equal(events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta).join(''), '你好');
  assert.equal(events.find(event => event.type === 'response.output_item.added' && event.item.type === 'function_call').item.name, 'weather');
  assert.equal(events.find(event => event.type === 'response.function_call_arguments.done').arguments, '{"city":"上海"}');
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(events.at(-1).response.output[1].call_id, 'call_1');
  assert.deepEqual(events.at(-1).response.usage, response.usage);
  assert.deepEqual(events.map(event => event.sequence_number), events.map((_, i) => i));
  assert.equal(result.success, true);
});
test('Responses SSE becomes Chat chunks without duplicating final text or tool arguments', async () => {
  const output = new Output();
  await translateGatewayResponse(upstream([
    { type: 'response.created', response: { ...response, output: [], status: 'in_progress' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '你好' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: '你好' },
    { type: 'response.output_item.added', output_index: 1, item: { ...response.output[1], arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"city":' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"上海"}' },
    { type: 'response.output_item.done', output_index: 1, item: response.output[1] },
    { type: 'response.completed', response }
  ]), output, '/responses', { stream: true, stream_options: { include_usage: true } });
  const events = output.events();
  const deltas = events.filter(event => event.choices?.length).map(event => event.choices[0].delta);
  assert.equal(deltas.map(delta => delta.content || '').join(''), '你好');
  assert.equal(deltas.flatMap(delta => delta.tool_calls || []).map(tool => tool.function.arguments || '').join(''), '{"city":"上海"}');
  assert.equal(deltas.flatMap(delta => delta.tool_calls || []).filter(tool => tool.id).length, 1);
  assert.equal(events.at(-3).choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(events.at(-2).usage, usage);
  assert.equal(events.at(-1), '[DONE]');
});
test('truncated and failed streams return protocol errors instead of a successful finish', async () => {
  for (const [endpoint, events] of [['/chat/completions', chunks().slice(0, 2)], ['/responses', [{ type: 'response.output_text.delta', delta: 'partial' }]], ['/responses', [{ type: 'response.failed', response: { error: { message: 'provider failed' } } }]]]) {
    const output = new Output();
    await assert.rejects(translateGatewayResponse(upstream(events), output, endpoint, { stream: true }), /提前结束|provider failed/);
    assert.ok(output.events().some(event => event.error || event.type === 'response.failed'));
    assert.ok(!output.events().some(event => event.type === 'response.completed' || event.choices?.[0]?.finish_reason === 'stop'));
  }
});
test('JSON responses also support clients requesting streaming in both directions', async () => {
  for (const [endpoint, payload] of [['/responses', response], ['/chat/completions', completion]]) {
    const output = new Output();
    await translateGatewayResponse(Response.json(payload), output, endpoint, { stream: true });
    assert.equal(output.headers['Content-Type'], 'text/event-stream');
    assert.ok(output.events().some(event => event.type === 'response.completed' || event === '[DONE]'));
  }
});
test('parallel function calls keep separate indices and complete names in both stream protocols', async () => {
  const source = { ...completion, choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [
    { id: 'a', type: 'function', function: { name: 'first', arguments: '{"a":1}' } },
    { id: 'b', type: 'function', function: { name: 'second', arguments: '{"b":2}' } }
  ] }, finish_reason: 'tool_calls' }] };
  const first = new Output();
  await translateGatewayResponse(Response.json(source), first, '/chat/completions', { stream: true });
  const items = first.events().at(-1).response.output;
  assert.deepEqual(items.map(item => [item.call_id, item.name, item.arguments]), [['a', 'first', '{"a":1}'], ['b', 'second', '{"b":2}']]);
  const second = new Output();
  await translateGatewayResponse(upstream(first.events()), second, '/responses', { stream: true });
  const toolDeltas = second.events().flatMap(event => event.choices?.[0]?.delta.tool_calls || []);
  assert.deepEqual(toolDeltas.filter(tool => tool.id).map(tool => [tool.index, tool.id, tool.function.name]), [[0, 'a', 'first'], [1, 'b', 'second']]);
  assert.equal(toolDeltas.filter(tool => tool.index === 0).map(tool => tool.function.arguments).join(''), '{"a":1}');
  assert.equal(toolDeltas.filter(tool => tool.index === 1).map(tool => tool.function.arguments).join(''), '{"b":2}');
});
test('refusal and length-limited streams retain the correct terminal state', async () => {
  const output = new Output();
  await translateGatewayResponse(upstream([{ id: 'chat_x', model: 'm', choices: [{ index: 0, delta: { refusal: '不能回答' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage }, '[DONE]']), output, '/chat/completions', { stream: true });
  const events = output.events();
  assert.equal(events.find(event => event.type === 'response.refusal.done').refusal, '不能回答');
  assert.equal(events.at(-1).type, 'response.incomplete');
  assert.equal(events.at(-1).response.incomplete_details.reason, 'max_output_tokens');
  const client = new Output();
  await translateGatewayResponse(upstream(events), client, '/responses', { stream: true });
  assert.equal(client.events().filter(event => event.choices?.[0]?.delta.refusal).map(event => event.choices[0].delta.refusal).join(''), '不能回答');
  assert.equal(client.events().at(-2).choices[0].finish_reason, 'length');
  assert.ok(!client.events().some(event => event.usage));
});
test('stream text reaches the client before the upstream has completed', async () => {
  let controller;
  const source = new ReadableStream({ start(value) { controller = value; } });
  const output = new Output();
  const running = translateGatewayResponse(new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }), output, '/chat/completions', { stream: true });
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunks()[1])}\n\n`));
  for (let i = 0; i < 20 && !output.events().some(event => event.type === 'response.output_text.delta'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(output.events().some(event => event.type === 'response.output_text.delta'));
  assert.equal(output.writableEnded, undefined);
  controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')); controller.close();
  await running;
});
test('client disconnect cancels upstream streaming reader', async () => {
  let canceled = false;
  const source = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunks()[1])}\n\n`)); }, cancel() { canceled = true; } });
  const output = new Output();
  const running = translateGatewayResponse(new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }), output, '/chat/completions', { stream: true });
  for (let i = 0; i < 20 && !output.frames.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  output.destroyed = true; output.emit('close');
  await assert.rejects(running);
  assert.equal(canceled, true);
});
