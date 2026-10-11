const fs = require('node:fs');
const path = require('node:path');

const attachedSessions = new WeakSet();

function safeUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) return `${url.protocol}//${url.hostname}`;
    return `${url.protocol}//${url.host}${url.pathname || '/'}`;
  } catch {
    return '<invalid-url>';
  }
}

function safeErrorDetails(details = {}) {
  return {
    at: new Date().toISOString(),
    url: safeUrl(details.url),
    method: String(details.method || 'GET').toUpperCase(),
    resourceType: String(details.resourceType || 'unknown'),
    error: String(details.error || 'unknown'),
    statusCode: Number.isInteger(details.statusCode) ? details.statusCode : 0,
    fromCache: details.fromCache === true,
    webContentsId: Number.isInteger(details.webContentsId) ? details.webContentsId : null
  };
}

function appendLog(logFile, record) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Network diagnostics must never interfere with the request that failed.
  }
}

function isImportantNetworkError(error) {
  return String(error || '').toUpperCase() !== 'NET::ERR_ABORTED';
}

function attachNetworkDiagnostics(targetSession, { logFile, context = 'default-session' } = {}) {
  if (!targetSession?.webRequest?.onErrorOccurred || attachedSessions.has(targetSession) || !logFile) return false;
  attachedSessions.add(targetSession);
  targetSession.webRequest.onErrorOccurred({ urls: ['http://*/*', 'https://*/*'] }, details => {
    if (!isImportantNetworkError(details?.error)) return;
    appendLog(logFile, { source: context, ...safeErrorDetails(details) });
  });
  return true;
}

module.exports = { attachNetworkDiagnostics, isImportantNetworkError, safeUrl, safeErrorDetails };
