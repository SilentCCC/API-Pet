const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/renderer/provider-quick-entry');

test('raw and Markdown links, either order', () => {
  for (const input of [
    'sk-xxxxxxxxxxxxxxxxxxx https://xxx.xxxr.xxx/',
    'sk-xxxxxxxxxxxxxxxxxxx [https://xxx.xxxr.xxx/](https://xxx.xxxr.xxx/)',
    'https://xxx.xxxr.xxx/ sk-xxxxxxxxxxxxxxxxxxx'
  ]) assert.deepEqual(parse(input), { name: 'xxxr', loginUrl: 'https://xxx.xxxr.xxx', apiKey: 'sk-xxxxxxxxxxxxxxxxxxx' });
});
test('labeled fields, Markdown formatting, and non-sk keys', () => {
  for (const input of [
    '**站点名称**：我的站点\n**Endpoint**：[入口](https://api.example.com/v1/)\n**API Key**：custom-key-123',
    '站点名称 我的站点 Endpoint https://api.example.com/v1/ API Key custom-key-123',
    '站点名称\n我的站点\nEndpoint\nhttps://api.example.com/v1/\nAPI Key\ncustom-key-123'
  ]) assert.deepEqual(parse(input), { name: '我的站点', loginUrl: 'https://api.example.com/v1', apiKey: 'custom-key-123' });
});
test('domain naming and punctuation', () => {
  assert.equal(parse('https://api.example.co.uk/，sk-test_key-123').name, 'example');
  assert.equal(parse('https://127.0.0.1:8787/ sk-test').name, '127.0.0.1');
  assert.equal(parse('Endpoint: https://example.com/; API Key: Bearer sk-test').apiKey, 'sk-test');
});
test('partial and invalid input', () => {
  assert.deepEqual(parse(''), { name: '', loginUrl: '', apiKey: '' });
  assert.deepEqual(parse('没有站点信息'), { name: '', loginUrl: '', apiKey: '' });
  assert.equal(parse('sk-test').loginUrl, '');
  assert.equal(parse('https://example.com/').apiKey, '');
  assert.equal(parse('https://user:pass@example.com/').loginUrl, '');
});
