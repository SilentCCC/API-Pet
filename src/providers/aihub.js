const { notConfigured, accountFetch, balanceCurrency } = require('./base');

const MICRO_PER_DOLLAR = 1000000;

function parseNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function apiUrl(provider, pathname) {
  try {
    const url = new URL(String(provider.loginUrl || provider.requestUrl || provider.baseUrl || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return `${url.origin}/api/${pathname}`;
  } catch {
    return '';
  }
}

function requestHeaders(provider) {
  const token = String(provider.accountToken || '').trim().replace(/^Bearer\s+/i, '');
  if (!token) return notConfigured('AIHub', '点击“连接账户”完成网页授权');
  return { Accept: 'application/json', Authorization: `Bearer ${token}` };
}

async function getJson(url, headers, signal) {
  if (!url) throw new Error('AIHub 登录地址无效');
  const response = await accountFetch(url, { headers, signal });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!response.ok || body == null || body.error || body.success === false) {
    const message = body?.error?.message || body?.message || body?.detail || '响应无效';
    const error = new Error(response.status === 401
      ? `AIHub 登录凭据已过期，请重新连接账户: ${message}`
      : `${response.status} ${response.statusText}: ${message}`);
    error.status = response.status;
    error.rateLimited = response.status === 429;
    throw error;
  }
  return body;
}

async function withTimeout(provider, callback, timeoutMs = 15000) {
  const headers = requestHeaders(provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await callback(headers, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  id: 'aihub',
  label: 'AIHub',
  async detect(provider) {
    return withTimeout(provider, async (headers, signal) => {
      const body = await getJson(apiUrl(provider, 'users/me'), headers, signal);
      const profile = body?.data ?? body;
      if (!profile || Array.isArray(profile) || !['number', 'string'].includes(typeof profile.id)
        || String(profile.id).trim() === '') throw new Error('AIHub 账户资料响应格式无效');
      return { profile };
    });
  },
  async getBalance(provider) {
    return withTimeout(provider, async (headers, signal) => {
      const body = await getJson(apiUrl(provider, 'billing/balance'), headers, signal);
      const balanceMicro = parseNumber((body?.data ?? body)?.balance_micro);
      if (balanceMicro == null) throw new Error('AIHub 余额响应中没有有效的 balance_micro 字段');
      // The console groups spending by UTC date. Request only the current day.
      const now = new Date();
      const since = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
      const statsBody = await getJson(`${apiUrl(provider, 'usage/aggregate')}?since=${since}`, headers, signal).catch(() => null);
      const summary = (statsBody?.data ?? statsBody)?.summary;
      const costMicro = parseNumber(summary?.cost_micro);
      return {
        balance: balanceMicro / MICRO_PER_DOLLAR,
        ...balanceCurrency(provider, [body], '$'),
        ...(summary && typeof summary === 'object' && !Array.isArray(summary) ? { accountStats: {
          todayCost: costMicro == null ? null : costMicro / MICRO_PER_DOLLAR,
          todayRequests: parseNumber(summary.requests),
          todayTokens: parseNumber(summary.total_tokens),
          averageDurationMs: parseNumber(summary.avg_latency_ms)
        } } : {})
      };
    });
  },
  async getApiKeys(provider) {
    return withTimeout(provider, async (headers, signal) => {
      const body = await getJson(apiUrl(provider, 'keys'), headers, signal);
      if (!Array.isArray(body?.data)) throw new Error('AIHub API 密钥列表响应格式无效');
      const keys = body.data.map(item => ({
        key: typeof item?.key === 'string' ? item.key.trim() : '',
        name: String(item?.name || '').trim()
      })).filter(item => item.key && !/[\s*•…]/.test(item.key) && !item.key.includes('...'));
      if (!keys.length) throw new Error('该 AIHub 账户没有可导入的完整 API 密钥');
      return keys;
    }, 30000);
  }
};
