const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parse, parseResponse } = require('../src/renderer/message-parser');
const { detectMime } = require('../src/image-format');
const jpeg = 'data:image/png;base64,' + Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]).toString('base64');
const png = 'data:image/jpeg;base64,iVBORw0KGgo=';

test('plain text, Markdown and code examples retain their exact content', () => {
  for (const text of ['Normal reply', '**bold**\n[link](https://example.invalid)\n![remote](https://example.invalid/image.png)',
    `Example: \`${jpeg}\``, `\`\`\`markdown\n![example](${jpeg})\n\`\`\``, `~~~text\n${jpeg}\n~~~`, '`unmatched backtick']) {
    assert.deepEqual(parse(text), { segments: [{ type: 'text', text }], historyText: text });
  }
});

test('Markdown and bare images preserve surrounding text and every occurrence', async () => {
  const reply = `before ![one](${jpeg}) between ${png} after ![again](${jpeg}) end`;
  const result = parse(reply);
  assert.deepEqual(result.segments.map(item => item.type), ['text', 'image', 'text', 'image', 'text', 'image', 'text']);
  assert.equal(result.historyText, 'before [图片] between [图片] after [图片] end');
  assert.equal(result.segments[1].alt, 'one');
  assert.equal(result.segments[1].mime, 'image/jpeg');
  assert.equal(result.segments[3].mime, 'image/png');
  assert.equal(result.segments[1].blob.type, 'image/jpeg');
  assert.equal(Buffer.from(await result.segments[1].blob.arrayBuffer())[0], 255);
  assert.equal(JSON.stringify(result).includes('base64'), false);
});

test('Markdown titles, angle-bracket targets and escaped alt text', () => {
  const parsed = parse(`![a\\]b](<${jpeg}> "title")`);
  assert.equal(parsed.segments.length, 1);
  assert.equal(parsed.segments[0].type, 'image');
  assert.equal(parsed.historyText, '[图片]');
});

test('HTML uses attribute extraction and never emits model HTML for rendering', () => {
  const parsed = parse(`before <img alt="x" src="${jpeg}" onerror="attack()"> after`, {
    parseHtmlImage: () => ({ src: jpeg, alt: 'x' })
  });
  assert.equal(parsed.segments[1].alt, 'x');
  assert.equal(parsed.historyText, 'before [图片] after');
  assert.equal(JSON.stringify(parsed).includes('attack'), false);
});

test('invalid or unsupported image bytes become short errors without Base64 history', () => {
  for (const uri of ['data:image/png;base64,YQ==', 'data:image/png;base64,AAAAA', 'data:image/svg+xml;base64,PHN2Zz4=']) {
    const parsed = parse(uri);
    assert.equal(parsed.segments[0].type, 'image-error');
    assert.equal(parsed.historyText, '[图片]');
  }
});

test('Responses and Chat Completions use the same message parser', () => {
  for (const payload of [{output_text:jpeg}, {choices:[{message:{content:jpeg}}]}, {choices:[{text:jpeg}]},
    {choices:[{message:{content:[{type:'text',text:jpeg}]}}]}, {output:[{content:[{type:'output_text',text:jpeg}]}]}]) {
    assert.equal(parseResponse(payload).segments[0].mime, 'image/jpeg');
    assert.equal(parseResponse(payload).historyText, '[图片]');
  }
});

test('image headers distinguish supported formats without trusting the declared MIME', () => {
  assert.equal(detectMime(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(detectMime(Buffer.from('RIFF0000WEBP')), 'image/webp');
  assert.equal(detectMime(Buffer.from('0000ftypavif')), 'image/avif');
  assert.equal(detectMime(Buffer.from('0000ftypmp42')), '');
  assert.equal(detectMime(Buffer.from('BM0000')), 'image/bmp');
});
