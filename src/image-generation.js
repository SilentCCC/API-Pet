const { modelKind, normalizeImageSizeSelection } = require('./renderer/image-config');
const TIMEOUT_MS = 180000;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

function inlineImage(url) {
  const match = String(url || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) throw new Error('参考图片格式无效');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('参考图片为空或超过 10 MB');
  return { mimeType: match[1], data: bytes.toString('base64') };
}

function imageSources(payload) {
  const found = [];
  function add(value, mime = 'image/png', encoded = false) {
    if (typeof value !== 'string' || !value.trim()) return;
    const url = encoded ? `data:${mime};base64,${value.trim()}` : value.trim();
    if (/^(data:image\/(?:png|jpeg|webp|gif);base64,|https?:\/\/)/i.test(url) && !found.includes(url)) found.push(url);
  }
  function visit(value, depth = 0) {
    if (!value || depth > 10) return;
    if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return; }
    if (typeof value !== 'object') return;
    for (const key of ['url', 'image_url', 'imageUrl', 'download_url', 'downloadUrl']) add(value[key]);
    for (const key of ['b64_json', 'b64Json', 'base64', 'image_base64', 'imageBase64']) add(value[key], 'image/png', true);
    const inline = value.inlineData || value.inline_data;
    if (inline) add(inline.data || inline.bytes, inline.mimeType || inline.mime_type || 'image/png', true);
    for (const key of ['data', 'images', 'image', 'result', 'results', 'output', 'outputs', 'candidates', 'content', 'parts']) visit(value[key], depth + 1);
  }
  visit(payload);
  return found;
}

// Read complete JSON values from ordinary JSON or a gateway's streamed JSON/SSE.
function completePayloads(text) {
  const values = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (start < 0) { if (char === '{' || char === '[') { start = i; depth = 1; } continue; }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      if (--depth === 0) { try { values.push(JSON.parse(text.slice(start, i + 1))); } catch {} start = -1; }
    }
  }
  return values;
}
function taskStatus(payload) {
  return String(payload?.status || payload?.state || payload?.phase || payload?.data?.status || '').toLowerCase();
}
async function readPayload(response) {
  if (!response.body?.getReader) {
    const text = await response.text();
    return completePayloads(text).at(-1) || { error: { message: text.slice(0, 300) } };
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      text += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
      const payloads = completePayloads(text);
      const ready = payloads.find(payload => imageSources(payload).length || payload.error || /^(failed|error|completed|succeeded|success|cancelled|canceled|rejected|expired)$/.test(taskStatus(payload)));
      if (ready || chunk.done) return ready || payloads.at(-1) || { error: { message: text.slice(0, 300) } };
      if (text.length > 100 * 1024 * 1024) throw new Error('图片响应过大');
    }
  } finally { await reader.cancel().catch(() => {}); }
}

function buildRequest(base, apiKey, options) {
  const model = String(options.model || '').trim(), kind = modelKind(model);
  const refs = options.referenceImages || [];
  if (refs.length > 4) throw new Error('每次最多上传 4 张参考图片');
  const inline = refs.map(inlineImage);
  if (kind === 'sense-fast' && refs.length) throw new Error('SenseNova U1 Fast 不支持参考图片，请移除后重试');
  const prompt = String(options.prompt || '').trim();
  if (!prompt || !model) throw new Error('请选择模型并填写绘图描述');
  if (!['auto', '1K', '2K', '4K', 'custom'].includes(options.resolution || '1K')) throw new Error('绘图分辨率无效');
  if (kind === 'gemini' && options.resolution === 'custom') throw new Error('Gemini 请使用分辨率和比例，不支持自定义像素尺寸');
  if (kind === 'sense-fast' && options.resolution === 'custom') throw new Error('SenseNova U1 Fast 请使用预设比例');
  const selection = normalizeImageSizeSelection({ ...options, model, size: undefined });
  const quality = ['low', 'medium', 'high'].includes(options.quality) ? options.quality : '';
  const responseFormat = options.responseFormat === 'url' ? 'url' : 'b64_json';
  const headers = { Authorization: `Bearer ${apiKey}` };
  base = String(base || '').replace(/\/+$/, '').replace(/\/images\/(generations|edits)$/i, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('站点请求地址无效');
  if (kind === 'gemini') {
    const root = base.replace(/(?:\/v1(?:beta)?)+$/i, '');
    const imageConfig = {};
    if (selection.resolution !== 'auto') imageConfig.imageSize = selection.resolution;
    if (selection.ratio && !['auto', 'custom'].includes(selection.ratio)) imageConfig.aspectRatio = selection.ratio;
    const body = { contents: [{ role: 'user', parts: [{ text: prompt }, ...inline.map(image => ({ inlineData: image }))] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(Object.keys(imageConfig).length ? { imageConfig } : {}) } };
    return { url: `${root}/v1beta/models/${encodeURIComponent(model)}:generateContent`, init: { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, taskRoot: root, kind };
  }
  let fields = { model, prompt, size: selection.size, ...(quality ? { quality } : {}), n: 1, response_format: responseFormat, ...(responseFormat === 'url' ? { output_format: 'png' } : {}) };
  if (kind === 'seedream') fields = { model, prompt, size: selection.size, ...(quality ? { quality } : {}), n: 1, output_format: 'png', response_format: 'b64_json' };
  if (kind.startsWith('grok')) {
    fields = { model, prompt, aspect_ratio: selection.resolution === 'auto' ? 'auto' : selection.ratio,
      ...(selection.resolution === 'auto' ? {} : { resolution: selection.resolution.toLowerCase() }),
      ...(kind === 'grok-json' ? (quality === 'low' || quality === 'medium' ? { quality } : {}) : (quality && !refs.length ? { quality } : {})),
      ...(kind === 'grok-json' ? (responseFormat === 'b64_json' ? { response_format: responseFormat } : {}) : { n: 1, response_format: responseFormat, ...(!refs.length && responseFormat === 'url' ? { output_format: 'png' } : {}) }) };
  }
  if (kind.startsWith('sense')) fields = { model, prompt, size: selection.size, n: 1, response_format: responseFormat,
    watermark: options.watermark !== false,
    ...(kind === 'sense-lite' ? { prompt_extend: options.promptExtend !== false, output_format: ['png', 'jpeg', 'webp'].includes(options.outputFormat) ? options.outputFormat : 'png' } : {}) };
  const endpoint = refs.length && options.editEndpoint !== 'generations' ? 'edits' : 'generations';
  const url = `${base}/${kind === 'seedream' || kind === 'sense-lite' ? (refs.length ? 'images/edits' : 'images/generations') : `images/${endpoint}`}`;
  if (refs.length && (kind === 'grok-json' || kind === 'sense-lite')) {
    const images = refs.map(image_url => ({ image_url }));
    Object.assign(fields, kind === 'grok-json' && images.length === 1 ? { image: images[0] } : { images });
  } else if (refs.length) {
    const form = new FormData();
    if (kind !== 'seedream') { delete fields.n; delete fields.output_format; }
    for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
    const field = kind === 'seedream' || (kind === 'grok' && refs.length > 1) ? 'image[]' : 'image';
    inline.forEach((image, index) => form.append(field, new Blob([Buffer.from(image.data, 'base64')], { type: image.mimeType }), `reference-${index + 1}.${image.mimeType.split('/')[1]}`));
    return { url, init: { method: 'POST', headers, body: form }, kind };
  }
  return { url, init: { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(fields) }, kind };
}

async function requestImage({ bases, apiKey, options, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    let payload, request;
    const requests = [...new Map(bases.map(base => {
      const built = buildRequest(base, apiKey, options);
      return [built.url, built];
    })).values()];
    for (let i = 0; i < requests.length; i++) {
      request = requests[i];
      const response = await fetchImpl(request.url, { ...request.init, signal });
      payload = await readPayload(response);
      const html = /text\/html/i.test(response.headers.get('content-type') || '');
      if ((response.status === 404 || response.status === 405 || html) && i < requests.length - 1) continue;
      if (!response.ok || html) throw new Error(`${response.status} ${response.statusText}: ${payload.error?.message || payload.message || '绘图请求失败'}`);
      break;
    }
    if (!request) throw new Error('站点请求地址无效');
    if (request.kind === 'gemini') {
      const taskId = payload.task_id || payload.taskId || payload.data?.task_id || payload.data?.taskId || payload.id;
      while (taskId && !imageSources(payload).length && !payload.error && !/^(failed|error|completed|succeeded|success|cancelled|canceled|rejected|expired)$/.test(taskStatus(payload))) {
        await require('node:timers/promises').setTimeout(1000, undefined, { signal });
        const response = await fetchImpl(`${request.taskRoot}/v1/images/tasks/${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
        payload = await readPayload(response);
        if (!response.ok) throw new Error(payload.error?.message || `图片任务查询失败 (${response.status})`);
      }
    }
    const sources = imageSources(payload);
    if (!sources.length) throw new Error(payload.error?.message || payload.message || '模型没有返回图片');
    return { url: sources[0], revisedPrompt: String(payload.data?.[0]?.revised_prompt || '') };
  } catch (error) {
    if (signal.aborted) throw new Error(`绘图请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw error;
  }
}

function imageMime(bytes, fallback) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return fallback;
}
async function imageData(url, fetchImpl = fetch) {
  if (String(url).startsWith('data:')) {
    const match = String(url).match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([a-z0-9+/=\s]+)$/i);
    if (!match) throw new Error('返回图片格式无效');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('返回图片为空或超过 40 MB');
    return { bytes, mimeType: imageMime(bytes, match[1]) };
  }
  if (!/^https?:\/\//i.test(url)) throw new Error('图片地址无效');
  // Image CDN requests must not receive the provider's credentials.
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60000), headers: { Accept: 'image/*' } });
  if (!response.ok) throw new Error(`图片下载失败 (${response.status})`);
  const mimeType = (response.headers.get('content-type') || '').split(';')[0];
  if (!/^image\/(png|jpeg|webp|gif)$/i.test(mimeType)) throw new Error('下载内容不是支持的图片格式');
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('返回图片超过 40 MB');
  const chunks = []; let length = 0;
  for await (const chunk of response.body) { length += chunk.length; if (length > MAX_IMAGE_BYTES) throw new Error('返回图片超过 40 MB'); chunks.push(Buffer.from(chunk)); }
  if (!length) throw new Error('返回图片为空');
  const bytes = Buffer.concat(chunks);
  return { bytes, mimeType: imageMime(bytes, mimeType) };
}
module.exports = { buildRequest, requestImage, imageSources, imageData };
