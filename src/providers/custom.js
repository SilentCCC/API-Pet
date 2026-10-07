const { notConfigured, balanceCurrency } = require('./base');

function valueAtPath(value, path) {
  return String(path || '').split('.').filter(Boolean).reduce((current, key) => current == null ? undefined : current[key], value);
}

module.exports = {
  id: 'custom',
  label: '自定义',
  async getBalance(provider) {
    const url = String(provider.balanceUrl || '').trim();
    if (!url) return notConfigured('自定义 Provider', '余额接口 URL、响应字段路径');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(url, {
      method: String(provider.balanceMethod || 'GET').toUpperCase(),
      headers: { Authorization: `Bearer ${provider.apiKey}`, Accept: 'application/json' },
      signal: controller.signal
    });
    try {
      const text = await response.text();
      let body;
      try { body = JSON.parse(text); } catch { body = null; }
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
      const raw = valueAtPath(body, provider.balancePath || 'data.balance');
      const balance = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/[, ]/g, ''));
      if (!Number.isFinite(balance)) throw new Error(`余额字段不是数字，请检查响应字段路径：${provider.balancePath || 'data.balance'}`);
      return { balance,
        ...balanceCurrency(provider, [body, { currency: response.headers?.get?.('x-currency') }]) };
    } finally {
      clearTimeout(timer);
    }
  }
};
