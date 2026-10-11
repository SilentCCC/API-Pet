const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { attachNetworkDiagnostics, isImportantNetworkError, safeUrl } = require('../src/network-diagnostics');

test('network diagnostics removes query credentials and records request failures', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'api-pet-network-'));
  const logFile = path.join(directory, 'electron-network.log');
  let listener;
  const targetSession = { webRequest: { onErrorOccurred: (_filter, callback) => { listener = callback; } } };

  assert.equal(attachNetworkDiagnostics(targetSession, { logFile, context: 'test-session' }), true);
  assert.equal(attachNetworkDiagnostics(targetSession, { logFile, context: 'test-session' }), false);
  listener({ url: 'https://example.com/app.js', error: 'net::ERR_ABORTED' });
  listener({
    url: 'https://user:secret@example.com/v1/models?api_key=should-not-log#fragment',
    method: 'post', resourceType: 'xhr', error: 'net::ERR_CONNECTION_RESET',
    statusCode: 0, fromCache: false, webContentsId: 12
  });

  const record = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  assert.deepEqual(record, {
    source: 'test-session', at: record.at, url: 'https://example.com/v1/models', method: 'POST',
    resourceType: 'xhr', error: 'net::ERR_CONNECTION_RESET', statusCode: 0,
    fromCache: false, webContentsId: 12
  });
  assert.equal(safeUrl('not a URL'), '<invalid-url>');
  assert.equal(isImportantNetworkError('net::ERR_ABORTED'), false);
  assert.equal(isImportantNetworkError('net::ERR_CONNECTION_RESET'), true);
  fs.rmSync(directory, { recursive: true, force: true });
});
