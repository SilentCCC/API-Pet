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

module.exports = { BalanceAdapterNotConfiguredError, notConfigured };
