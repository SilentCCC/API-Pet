const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');

test('登录站点复用账户连接流程并保留登录窗口', () => {
  assert.match(mainSource, /ipcMain\.handle\('open-provider-login',\s*\(_e, input\) => connectProviderAccount\(input, \{ keepWindowOpen: true \}\)\)/);
  assert.match(mainSource, /async function connectProviderAccount\(input, \{ keepWindowOpen = false \} = \{\}\)/);
  assert.match(mainSource, /if \(!keepWindowOpen && !loginWindow\.isDestroyed\(\)\) loginWindow\.close\(\);/);
  assert.match(rendererSource, /connectProviderAccount\(provider\.id, provider\.loginUrl \|\| provider\.baseUrl \|\| provider\.requestUrl \|\| '', \{ keepWindowOpen: true \}\)/);
});
