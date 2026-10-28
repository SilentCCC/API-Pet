// Optional translation at the gateway boundary. Same-format traffic never enters
// this module's response translator, so provider extensions still pass through.
const { randomUUID } = require('node:crypto');

function formatError(message) {
  const error = new Error(`请求格式转换：${message}`);
  error.statusCode = 400;
  error.type = 'api_pet_format_error';
  return error;
}
function unsupported(name) { throw formatError(`不支持转换 ${name}，请取消勾选“请求格式”或让客户端使用相同格式。`); }
function checkFields(body, allowed) {
  for (const [key, value] of Object.entries(body)) if (value != null && !allowed.includes(key)) unsupported(key);
}
const sharedFields = ['model', 'stream', 'temperature', 'top_p', 'parallel_tool_calls', 'user', 'metadata', 'store', 'service_tier', 'safety_identifier', 'prompt_cache_key', 'prompt_cache_retention'];
function shared(body) { return Object.fromEntries(sharedFields.filter(key => body[key] !== undefined).map(key => [key, body[key]])); }
function toolsFor(tools, responses) {
  return tools?.map(tool => {
    if (tool.type !== 'function') unsupported(`工具 ${tool.type}`);
    return responses ? { type: 'function', strict: false, ...tool.function } : { type: 'function', function: Object.fromEntries(Object.entries(tool).filter(([key]) => key !== 'type')) };
  });
}
function choiceFor(choice, responses) {
  if (choice == null || typeof choice === 'string') return choice;
  if (choice.type !== 'function') unsupported('tool_choice');
  return responses ? { type: 'function', name: choice.function.name } : { type: 'function', function: { name: choice.name } };
}
function contentFor(content, responses, role) {
  if (content == null || typeof content === 'string') return content;
  if (!Array.isArray(content)) throw formatError('消息 content 必须是字符串或数组。');
  return content.map(part => {
    if (responses) {
      if (part.type === 'text') return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text, ...(role === 'assistant' ? { annotations: [] } : {}) };
      if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url.url, ...(part.image_url.detail ? { detail: part.image_url.detail } : {}) };
      if (part.type === 'file') return { type: 'input_file', ...part.file };
      if (part.type === 'refusal') return { type: 'refusal', refusal: part.refusal };
    } else {
      if (['input_text', 'output_text'].includes(part.type)) return { type: 'text', text: part.text };
      if (part.type === 'input_image' && part.image_url) return { type: 'image_url', image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } };
      if (part.type === 'input_file' && !part.file_url) return { type: 'file', file: Object.fromEntries(Object.entries(part).filter(([key]) => key !== 'type')) };
      if (part.type === 'refusal') return { type: 'refusal', refusal: part.refusal };
    }
    unsupported(`消息内容 ${part.type}`);
  });
}
function chatToResponses(body) {
  checkFields(body, [...sharedFields, 'messages', 'tools', 'tool_choice', 'max_tokens', 'max_completion_tokens', 'response_format', 'reasoning_effort', 'verbosity', 'stream_options', 'n', 'frequency_penalty', 'presence_penalty']);
  if (body.n != null && body.n !== 1) unsupported('n 多候选回复');
  if (body.frequency_penalty || body.presence_penalty) unsupported('frequency_penalty / presence_penalty');
  if (body.stream_options) checkFields(body.stream_options, ['include_usage']);
  if (!Array.isArray(body.messages)) throw formatError('Chat Completions 请求需要 messages 数组。');
  const result = { ...shared(body), input: [] };
  for (const message of body.messages) {
    checkFields(message, ['role', 'content', 'tool_calls', 'tool_call_id', 'refusal']);
    if (message.role === 'tool') {
      result.input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: contentFor(message.content ?? '', true, 'tool') });
      continue;
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(message.role)) unsupported(`角色 ${message.role}`);
    if (message.content != null) result.input.push({
      ...(message.role === 'assistant' && Array.isArray(message.content) ? { type: 'message', id: `msg_${randomUUID()}`, status: 'completed' } : {}),
      role: message.role, content: contentFor(message.content, true, message.role)
    });
    if (message.refusal) result.input.push({ type: 'message', id: `msg_${randomUUID()}`, status: 'completed', role: 'assistant', content: [{ type: 'refusal', refusal: message.refusal }] });
    for (const tool of message.tool_calls || []) {
      if (tool.type !== 'function') unsupported(`工具调用 ${tool.type}`);
      result.input.push({ type: 'function_call', call_id: tool.id, name: tool.function.name, arguments: tool.function.arguments });
    }
  }
  if (body.tools) result.tools = toolsFor(body.tools, true);
  if (body.tool_choice !== undefined) result.tool_choice = choiceFor(body.tool_choice, true);
  if (body.max_completion_tokens !== undefined || body.max_tokens !== undefined) result.max_output_tokens = body.max_completion_tokens ?? body.max_tokens;
  if (body.reasoning_effort) result.reasoning = { effort: body.reasoning_effort };
  if (body.response_format) {
    const format = body.response_format;
    result.text = { format: format.type === 'json_schema' ? { type: format.type, ...format.json_schema } : format };
  }
  if (body.verbosity) result.text = { ...result.text, verbosity: body.verbosity };
  return result;
}
function responsesToChat(body) {
  checkFields(body, [...sharedFields, 'input', 'instructions', 'tools', 'tool_choice', 'max_output_tokens', 'text', 'reasoning', 'previous_response_id', 'conversation', 'background', 'include', 'truncation']);
  for (const key of ['previous_response_id', 'conversation', 'background']) if (body[key]) unsupported(key);
  if (body.include?.length) unsupported('include');
  if (body.truncation && body.truncation !== 'disabled') unsupported('truncation');
  if (body.reasoning) checkFields(body.reasoning, ['effort']);
  if (body.text) checkFields(body.text, ['format', 'verbosity']);
  const result = { ...shared(body), messages: [] };
  if (body.instructions) result.messages.push({ role: 'system', content: body.instructions });
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
  if (!Array.isArray(input)) throw formatError('Responses 请求需要 input 字符串或数组。');
  for (const item of input) {
    if (item.type === 'function_call') result.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }] });
    else if (item.type === 'function_call_output') result.messages.push({ role: 'tool', tool_call_id: item.call_id, content: contentFor(item.output, false, 'tool') });
    else if ((!item.type || item.type === 'message') && ['system', 'developer', 'user', 'assistant'].includes(item.role)) {
      const parts = contentFor(item.content, false, item.role);
      const refusal = Array.isArray(parts) ? parts.filter(part => part.type === 'refusal').map(part => part.refusal).join('') : '';
      result.messages.push({ role: item.role, content: Array.isArray(parts) ? parts.filter(part => part.type !== 'refusal') : parts, ...(refusal ? { refusal } : {}) });
    } else unsupported(`输入项 ${item.type}`);
  }
  // Chat Completions expects all calls from one assistant turn before its tool outputs.
  result.messages = result.messages.reduce((messages, message) => {
    const last = messages.at(-1);
    if (last?.role === 'assistant' && message.role === 'assistant' && message.tool_calls && !message.content) last.tool_calls = [...(last.tool_calls || []), ...message.tool_calls];
    else messages.push(message);
    return messages;
  }, []);
  if (body.tools) result.tools = toolsFor(body.tools, false);
  if (body.tool_choice !== undefined) result.tool_choice = choiceFor(body.tool_choice, false);
  if (body.max_output_tokens !== undefined) result.max_completion_tokens = body.max_output_tokens;
  if (body.reasoning?.effort) result.reasoning_effort = body.reasoning.effort;
  if (body.text?.format) {
    const { type, ...format } = body.text.format;
    result.response_format = type === 'json_schema' ? { type, json_schema: format } : { type };
  }
  if (body.text?.verbosity) result.verbosity = body.text.verbosity;
  if (body.stream) result.stream_options = { include_usage: true };
  return result;
}
function prepareGatewayRequest(body, endpoint, routing) {
  const target = routing.requestFormatEnabled === true ? `/${routing.requestFormat === 'chat/completions' ? 'chat/completions' : 'responses'}` : endpoint;
  return { endpoint: target, body: target === endpoint ? body : target === '/responses' ? chatToResponses(body) : responsesToChat(body) };
}
function usageFor(usage, responses) {
  if (!usage) return undefined;
  if (responses) return { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0, total_tokens: usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)),
    input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 }, output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 } };
  return { prompt_tokens: usage.input_tokens ?? 0, completion_tokens: usage.output_tokens ?? 0, total_tokens: usage.total_tokens ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)),
    prompt_tokens_details: { cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0 }, completion_tokens_details: { reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0 } };
}
function responseShell(payload = {}) {
  return { id: payload.id || `resp_${randomUUID()}`, object: 'response', created_at: payload.created ?? Math.floor(Date.now() / 1000), model: payload.model || '', status: 'in_progress', output: [], error: null, incomplete_details: null };
}
function responsesToCompletion(payload) {
  if (payload.error || payload.status === 'failed') return { error: payload.error || { message: '上游 Responses 请求失败' } };
  const message = { role: 'assistant', content: '' };
  const tools = [];
  for (const item of payload.output || []) {
    if (item.type === 'function_call') tools.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    else if (item.type === 'message') for (const part of item.content || []) {
      if (part.type === 'output_text') message.content += part.text;
      else if (part.type === 'refusal') message.refusal = (message.refusal || '') + part.refusal;
      else unsupported(`输出内容 ${part.type}`);
    }
    else if (item.type === 'reasoning') {
      const summary = (item.summary || []).map(part => part.text || '').join('');
      if (summary) message.reasoning_content = (message.reasoning_content || '') + summary;
    } else unsupported(`输出项 ${item.type}`);
  }
  if (!message.content && payload.output_text) message.content = payload.output_text;
  if (tools.length) { message.tool_calls = tools; if (!message.content) message.content = null; }
  const finish = payload.status === 'incomplete' ? payload.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length' : tools.length ? 'tool_calls' : 'stop';
  return { id: payload.id || `chatcmpl_${randomUUID()}`, object: 'chat.completion', created: payload.created_at ?? Math.floor(Date.now() / 1000), model: payload.model || '', choices: [{ index: 0, message, finish_reason: finish, logprobs: null }], ...(payload.usage ? { usage: usageFor(payload.usage, false) } : {}) };
}
function completionToResponse(payload) {
  if (payload.error) return { error: payload.error };
  if (payload.choices?.length !== 1) throw new Error('上游 Chat Completions 响应必须包含一个 choice');
  const choice = payload.choices[0];
  const message = choice.message || {};
  const result = responseShell(payload);
  result.status = ['length', 'content_filter'].includes(choice.finish_reason) ? 'incomplete' : 'completed';
  if (result.status === 'incomplete') result.incomplete_details = { reason: choice.finish_reason === 'length' ? 'max_output_tokens' : 'content_filter' };
  if (message.reasoning_content) result.output.push({ id: `rs_${randomUUID()}`, type: 'reasoning', summary: [{ type: 'summary_text', text: message.reasoning_content }] });
  const content = [];
  if (message.content) {
    if (typeof message.content !== 'string') unsupported('Chat Completions 非文本输出');
    content.push({ type: 'output_text', text: message.content, annotations: [] });
  }
  if (message.refusal) content.push({ type: 'refusal', refusal: message.refusal });
  if (content.length) result.output.push({ id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', status: result.status === 'completed' ? 'completed' : 'incomplete', content });
  for (const tool of message.tool_calls || []) {
    if (tool.type !== 'function') unsupported(`输出工具 ${tool.type}`);
    result.output.push({ id: `fc_${randomUUID()}`, type: 'function_call', status: 'completed', call_id: tool.id, name: tool.function.name, arguments: tool.function.arguments });
  }
  if (message.audio) unsupported('音频输出');
  if (payload.usage) result.usage = usageFor(payload.usage, true);
  return result;
}
// Parse complete SSE records rather than network chunks (which may split UTF-8,
// JSON, CRLF pairs, or contain several events). Cancel the reader on disconnect.
async function* sseRecords(body, res) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const closed = () => { reader.cancel().catch(() => {}); };
  res.on('close', closed);
  const parse = record => {
    const lines = record.split(/\r\n|\r|\n/);
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    return data || null;
  };
  try {
    while (!res.destroyed) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
        const data = parse(pending.slice(0, match.index));
        pending = pending.slice(match.index + match[0].length);
        if (data) yield data;
      }
      if (pending.length > 8 * 1024 * 1024) throw new Error('上游流式事件过大');
      if (done) { if (pending.trim()) { const data = parse(pending); if (data) yield data; } break; }
    }
  } finally { res.removeListener('close', closed); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function sendSse(res, data, event) {
  if (res.destroyed) throw new Error('客户端已断开连接');
  if (!res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)) {
    await new Promise((resolve, reject) => {
      const cleanup = () => { res.removeListener('drain', drained); res.removeListener('close', closed); res.removeListener('error', failed); };
      const drained = () => { cleanup(); resolve(); };
      const closed = () => { cleanup(); reject(new Error('客户端已断开连接')); };
      const failed = error => { cleanup(); reject(error); };
      res.once('drain', drained); res.once('close', closed); res.once('error', failed);
    });
  }
}
class ResponseStream {
  constructor(res) { this.res = res; this.response = responseShell(); this.sequence = 0; this.started = false; this.tools = new Map(); this.parts = new Map(); }
  async emit(type, data) { await sendSse(this.res, { type, sequence_number: this.sequence++, ...data }, type); }
  async start(payload) {
    if (this.started) return;
    this.started = true; this.response = responseShell(payload);
    await this.emit('response.created', { response: this.response });
    await this.emit('response.in_progress', { response: this.response });
  }
  async addItem(item) {
    const index = this.response.output.length; this.response.output.push(item);
    await this.emit('response.output_item.added', { output_index: index, item: { ...item, ...(item.content ? { content: [] } : {}), ...(item.type === 'function_call' ? { arguments: '' } : {}) } });
    return index;
  }
  async text(delta, refusal = false) {
    if (!delta) return;
    if (this.messageIndex === undefined) this.messageIndex = await this.addItem({ id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] });
    const index = this.messageIndex, item = this.response.output[index], type = refusal ? 'refusal' : 'output_text', key = refusal ? 'refusal' : 'text';
    if (!this.parts.has(type)) {
      const contentIndex = item.content.length; this.parts.set(type, contentIndex);
      const part = refusal ? { type, refusal: '' } : { type, text: '', annotations: [] };
      item.content.push(part);
      await this.emit('response.content_part.added', { item_id: item.id, output_index: index, content_index: contentIndex, part: { ...part } });
    }
    const contentIndex = this.parts.get(type); item.content[contentIndex][key] += delta;
    await this.emit(`response.${type}.delta`, { item_id: item.id, output_index: index, content_index: contentIndex, delta, ...(refusal ? {} : { logprobs: [] }) });
  }
  async chunk(payload) {
    if (payload.error) throw new Error(payload.error.message || '上游流式请求失败');
    await this.start(payload);
    if (payload.usage) this.response.usage = usageFor(payload.usage, true);
    for (const choice of payload.choices || []) {
      if (choice.index !== 0) unsupported('多个流式候选回复');
      const delta = choice.delta || {};
      if (delta.audio) unsupported('音频输出');
      if (delta.reasoning_content) {
        if (this.reasoningIndex === undefined) {
          this.reasoningIndex = await this.addItem({ id: `rs_${randomUUID()}`, type: 'reasoning', summary: [{ type: 'summary_text', text: '' }] });
          await this.emit('response.reasoning_summary_part.added', { item_id: this.response.output[this.reasoningIndex].id, output_index: this.reasoningIndex, summary_index: 0, part: { type: 'summary_text', text: '' } });
        }
        const item = this.response.output[this.reasoningIndex]; item.summary[0].text += delta.reasoning_content;
        await this.emit('response.reasoning_summary_text.delta', { item_id: item.id, output_index: this.reasoningIndex, summary_index: 0, delta: delta.reasoning_content });
      }
      await this.text(delta.content); await this.text(delta.refusal, true);
      for (const tool of delta.tool_calls || []) {
        if (tool.type && tool.type !== 'function') unsupported(`输出工具 ${tool.type}`);
        if (!this.tools.has(tool.index)) this.tools.set(tool.index, { id: `fc_${randomUUID()}`, type: 'function_call', status: 'in_progress', call_id: tool.id || `call_${randomUUID()}`, name: '', arguments: '' });
        const item = this.tools.get(tool.index);
        if (tool.function?.name) item.name += tool.function.name;
        if (tool.id) item.call_id = tool.id;
        if (tool.function?.arguments) {
          if (!item.name) throw new Error('上游工具调用缺少函数名称');
          if (!this.response.output.includes(item)) await this.addItem(item);
          item.arguments += tool.function.arguments;
          await this.emit('response.function_call_arguments.delta', { item_id: item.id, output_index: this.response.output.indexOf(item), delta: tool.function.arguments });
        }
      }
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
    }
  }
  async finish() {
    if (!this.finishReason) throw new Error('上游流式响应提前结束，未收到 finish_reason');
    for (const item of this.tools.values()) {
      if (!item.name) throw new Error('上游工具调用缺少函数名称');
      if (!this.response.output.includes(item)) await this.addItem(item);
    }
    const response = this.response;
    response.status = ['length', 'content_filter'].includes(this.finishReason) ? 'incomplete' : 'completed';
    if (response.status === 'incomplete') response.incomplete_details = { reason: this.finishReason === 'length' ? 'max_output_tokens' : 'content_filter' };
    for (const [index, item] of response.output.entries()) {
      if (item.status) item.status = response.status === 'completed' ? 'completed' : 'incomplete';
      if (item.type === 'message') for (const [contentIndex, part] of item.content.entries()) {
        const key = part.type === 'refusal' ? 'refusal' : 'text';
        await this.emit(`response.${part.type}.done`, { item_id: item.id, output_index: index, content_index: contentIndex, [key]: part[key], ...(key === 'text' ? { logprobs: [] } : {}) });
        await this.emit('response.content_part.done', { item_id: item.id, output_index: index, content_index: contentIndex, part });
      }
      if (item.type === 'function_call') await this.emit('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments, name: item.name });
      if (item.type === 'reasoning') {
        await this.emit('response.reasoning_summary_text.done', { item_id: item.id, output_index: index, summary_index: 0, text: item.summary[0].text });
        await this.emit('response.reasoning_summary_part.done', { item_id: item.id, output_index: index, summary_index: 0, part: item.summary[0] });
      }
      await this.emit('response.output_item.done', { output_index: index, item });
    }
    await this.emit(`response.${response.status}`, { response });
    return response;
  }
}
class CompletionStream {
  constructor(res, body) { this.res = res; this.body = body; this.id = `chatcmpl_${randomUUID()}`; this.created = Math.floor(Date.now() / 1000); this.model = ''; this.tools = new Map(); this.texts = new Map(); }
  async emit(delta, finish = null, usage) {
    await sendSse(this.res, { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: usage ? [] : [{ index: 0, delta, finish_reason: finish, logprobs: null }], ...(usage ? { usage } : {}) });
  }
  async tool(item, outputIndex, snapshot = false) {
    if (!this.tools.has(outputIndex)) {
      const index = this.tools.size; this.tools.set(outputIndex, { index, arguments: '' });
      await this.emit({ tool_calls: [{ index, id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: '' } }] });
    }
    const tool = this.tools.get(outputIndex);
    const delta = snapshot ? (item.arguments || '').slice(tool.arguments.length) : item.arguments || '';
    tool.arguments += delta;
    if (delta) await this.emit({ tool_calls: [{ index: tool.index, function: { arguments: delta } }] });
  }
  async text(delta, key, refusal, snapshot = false) {
    const old = this.texts.get(key) || '';
    const value = snapshot ? (delta || '').slice(old.length) : delta || '';
    this.texts.set(key, old + value);
    if (value) await this.emit({ [refusal ? 'refusal' : 'content']: value });
  }
  async chunk(event) {
    if (event.error || event.type === 'error' || event.type === 'response.failed') throw new Error(event.error?.message || event.response?.error?.message || event.message || '上游流式请求失败');
    if (!this.started) {
      this.started = true;
      if (event.response) { this.id = event.response.id || this.id; this.model = event.response.model || ''; this.created = event.response.created_at || this.created; }
      await this.emit({ role: 'assistant', content: '' });
    }
    const outputIndex = event.output_index ?? 0;
    if (event.type === 'response.output_item.added' && event.item.type === 'function_call') await this.tool({ ...event.item, arguments: '' }, outputIndex);
    if (event.type === 'response.function_call_arguments.delta') {
      if (!this.tools.has(outputIndex)) throw new Error('上游缺少 function_call 的 output_item.added 事件');
      await this.tool({ arguments: event.delta }, outputIndex);
    }
    if (['response.output_text.delta', 'response.refusal.delta', 'response.output_text.done', 'response.refusal.done'].includes(event.type)) {
      const refusal = event.type.includes('refusal');
      await this.text(event.delta ?? event.text ?? event.refusal, `${outputIndex}:${event.content_index ?? 0}`, refusal, event.type.endsWith('.done'));
    }
    if (event.type === 'response.reasoning_summary_text.delta') await this.emit({ reasoning_content: event.delta });
    if (event.type === 'response.output_item.done') {
      if (event.item.type === 'function_call') await this.tool(event.item, outputIndex, true);
      else if (!['message', 'reasoning'].includes(event.item.type)) unsupported(`输出项 ${event.item.type}`);
    }
    if (['response.completed', 'response.incomplete'].includes(event.type)) {
      this.final = event.response;
      // Some compatible sites only send the final snapshot, or omit deltas.
      for (const [index, item] of (this.final.output || []).entries()) {
        if (item.type === 'function_call') await this.tool(item, index, true);
        else if (item.type === 'message') for (const [partIndex, part] of (item.content || []).entries()) {
          if (!['output_text', 'refusal'].includes(part.type)) unsupported(`输出内容 ${part.type}`);
          await this.text(part.text ?? part.refusal, `${index}:${partIndex}`, part.type === 'refusal', true);
        }
        else if (item.type !== 'reasoning') unsupported(`输出项 ${item.type}`);
      }
    }
  }
  async finish() {
    if (!this.final) throw new Error('上游流式响应提前结束，未收到 Responses 完成事件');
    const converted = responsesToCompletion(this.final);
    await this.emit({}, converted.choices[0].finish_reason);
    if (this.body.stream_options?.include_usage && converted.usage) await this.emit({}, null, converted.usage);
    await sendSse(this.res, '[DONE]');
    return this.final;
  }
}
async function translateGatewayResponse(upstream, res, upstreamEndpoint, clientBody) {
  const responses = upstreamEndpoint === '/chat/completions';
  const type = upstream.headers.get('content-type') || '';
  if (!type.includes('text/event-stream')) {
    const payload = await upstream.json();
    const converted = responses ? completionToResponse(payload) : responsesToCompletion(payload);
    if (!clientBody.stream || converted.error) {
      res.writeHead(converted.error ? 502 : upstream.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(converted));
    } else {
      res.writeHead(upstream.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      if (responses) {
        const stream = new ResponseStream(res);
        await stream.chunk({ ...payload, choices: payload.choices.map(choice => ({ ...choice, delta: { ...choice.message,
          ...(choice.message?.tool_calls ? { tool_calls: choice.message.tool_calls.map((tool, index) => ({ ...tool, index })) } : {}) } })) });
        await stream.finish();
      } else {
        const stream = new CompletionStream(res, clientBody);
        await stream.chunk({ type: 'response.completed', response: payload }); await stream.finish();
      }
      res.end();
    }
    return { payload, success: !converted.error };
  }
  if (!clientBody.stream) throw new Error('上游对非流式请求返回了流式响应');
  res.writeHead(upstream.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
  const stream = responses ? new ResponseStream(res) : new CompletionStream(res, clientBody);
  let result;
  try {
    for await (const data of sseRecords(upstream.body, res)) {
      if (data === '[DONE]') break;
      await stream.chunk(JSON.parse(data));
      if (!responses && stream.final) break;
    }
    result = await stream.finish(); res.end();
  } catch (error) {
    if (!res.destroyed) {
      if (responses) await stream.emit('response.failed', { response: { ...stream.response, status: 'failed', error: { code: 'api_pet_format_error', message: error.message } } });
      else { await sendSse(res, { error: { message: error.message, type: 'api_pet_format_error' } }); await sendSse(res, '[DONE]'); }
      res.end();
    }
    throw error;
  }
  return { payload: responses ? result : stream.final, success: true };
}

module.exports = { prepareGatewayRequest, translateGatewayResponse, chatToResponses, responsesToChat, responsesToCompletion, completionToResponse };
