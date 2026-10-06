class BalanceAdapterNotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BalanceAdapterNotConfiguredError';
    this.code = 'balance_adapter_not_configured';
  }
}

function notConfigured(name, details) {
  throw new BalanceAdapterNotConfiguredError(`${name} 暂无可确认的余额接口${details ? `，需要配置：${details}` : ''}`);
}

function accountFetch(url, options = {}) {
  if (process.versions.electron) {
    // Use Chromium's system proxy settings, as the account login window does.
    // Only send this provider's explicit cookies, never the shared cookie jar.
    return require('electron').net.fetch(url, { ...options, credentials: 'omit', bypassCustomProtocolHandlers: true });
  }
  return fetch(url, options);
}

module.exports = { BalanceAdapterNotConfiguredError, notConfigured, accountFetch, ...require('../provider-currency') };
