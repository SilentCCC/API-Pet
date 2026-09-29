const { notConfigured } = require('./base');

const QUOTA_PER_DOLLAR = 500000;

function parseNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = typeof value === 'number'
    ? value
    : Number(String(value).replace(/[, ￥$]/g, '').trim());
  return Number.isFinite(number) ? number : null;
}

function unwrap(body) {
  return body?.data ?? body?.result ?? body;
}

function originFor(provider) {
  try {
    return new URL(String(provider.loginUrl || provider.requestUrl || provider.baseUrl || '')).origin;
  } catch {
    return '';
  }
}

function requestHeaders(provider) {
  const token = String(provider.accountToken || '').trim().replace(/^Bearer\s+/i, '');
  const cookie = String(provider.accountCookie || '').trim();
  const userId = String(provider.accountUserId || '').trim();
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (userId) headers['New-Api-User'] = userId;
  return { headers, token, cookie };
}

function quotaAmount(value) {
  const number = parseNumber(value);
  if (number == null) return null;
  // New API normally stores quota in its internal unit (500,000 units = $1),
  // while compatible deployments may return an already formatted amount.
  return Math.abs(number) >= 10000 ? number / QUOTA_PER_DOLLAR : number;
}

function findNumber(value, keys, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumber(item, keys, seen);
      if (found != null) return found;
    }
    return null;
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const found = parseNumber(value[key]);
      if (found != null) return found;
    }
  }
  for (const child of Object.values(value)) {
    const found = findNumber(child, keys, seen);
    if (found != null) return found;
  }
  return null;
}

function findCollection(value, keys, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value;
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findCollection(child, keys, seen);
    if (found) return found;
  }
  return null;
}

function normalizeCost(value) {
  const number = parseNumber(value);
  if (number == null) return null;
  return Math.abs(number) >= 10000 ? number / QUOTA_PER_DOLLAR : number;
}

function normalizeDuration(value) {
  const number = parseNumber(value);
  if (number == null) return null;
  return number > 0 && number < 100 ? number * 1000 : number;
}

async function getJson(url, headers, signal) {
  const response = await fetch(url, { headers, signal });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  const payload = unwrap(body);
  if (!response.ok || body?.success === false || (body?.code != null && body.code !== 0)) {
    const error = new Error(`${response.status} ${response.statusText}: ${body?.message || body?.error?.message || text.slice(0, 240)}`);
    error.status = response.status;
    error.rateLimited = response.status === 429;
    throw error;
  }
  return payload;
}

function todayStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function statsFromPayload(stats, logs) {
  const todayCost = normalizeCost(findNumber(stats, ['today_cost', 'todayCost', 'today_spend', 'todaySpend', 'daily_cost', 'dailyCost']));
  const todayRequests = parseNumber(findNumber(stats, ['today_requests', 'todayRequests', 'today_request_count', 'todayRequestCount', 'request_count', 'requestCount', 'requests']));
  const todayTokens = parseNumber(findNumber(stats, ['today_tokens', 'todayTokens', 'total_tokens', 'totalTokens', 'tokens']));
  const averageDurationMs = normalizeDuration(findNumber(stats, ['average_duration_ms', 'averageDurationMs', 'avg_duration_ms', 'avgDurationMs', 'average_latency', 'avg_latency']));
  const entries = findCollection(logs, ['logs', 'items', 'records']) || [];
  if (!entries.length) return { todayCost, todayRequests, todayTokens, averageDurationMs };
  const today = entries.filter(entry => {
    const raw = entry?.created_at || entry?.createdAt || entry?.time || entry?.timestamp || entry?.date;
    if (!raw) return true;
    const timestamp = typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(raw);
    return !Number.isFinite(timestamp) || timestamp >= todayStart();
  });
  const rows = today.length ? today : entries;
  const sum = keys => rows.reduce((total, row) => {
    const raw = keys.map(key => row?.[key]).find(value => value != null);
    return total + (parseNumber(raw) || 0);
  }, 0);
  const logCost = rows.length ? normalizeCost(sum(['cost', 'quota', 'spend', 'amount'])) : null;
  const logTokens = rows.length ? sum(['total_tokens', 'totalTokens', 'tokens', 'input_tokens', 'output_tokens']) : null;
  const durations = rows.map(row => normalizeDuration(row?.duration_ms ?? row?.durationMs ?? row?.duration ?? row?.latency_ms)).filter(Number.isFinite);
  return {
    todayCost: todayCost ?? (logCost > 0 ? logCost : null),
    todayRequests: todayRequests ?? rows.length,
    todayTokens: todayTokens ?? (logTokens > 0 ? logTokens : null),
    averageDurationMs: averageDurationMs ?? (durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null)
  };
}

module.exports = {
  id: 'new-api',
  label: 'New API',
  async detect(provider) {
    const { headers, token, cookie } = requestHeaders(provider);
    if (!token && !cookie && !provider.accountUserId) return notConfigured('New API', '网页授权凭据');
    const origin = originFor(provider);
    if (!origin) throw new Error('New API 登录地址无效');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const profile = await getJson(`${origin}/api/user/self`, headers, controller.signal);
      return { profile };
    } finally {
      clearTimeout(timer);
    }
  },
  async getBalance(provider) {
    const { headers, token, cookie } = requestHeaders(provider);
    if (!token && !cookie && !provider.accountUserId) return notConfigured('New API', '点击“连接账户”完成网页授权，或填写备用登录令牌');
    const origin = originFor(provider);
    if (!origin) throw new Error('New API 登录地址无效');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const profile = provider._accountProfile || await getJson(`${origin}/api/user/self`, headers, controller.signal);
      const user = unwrap(profile);
      const rawBalance = findNumber(user, ['quota', 'remaining_quota', 'remainingQuota', 'balance', 'credit']);
      const balance = quotaAmount(rawBalance);
      if (balance == null) throw new Error('New API /api/user/self 响应中没有可识别的 quota 或 balance 字段');
      let stats = null;
      let logs = null;
      await Promise.all([
        getJson(`${origin}/api/performance/stats`, headers, controller.signal).then(value => { stats = value; }).catch(() => {}),
        getJson(`${origin}/api/performance/logs`, headers, controller.signal).then(value => { logs = value; }).catch(() => {})
      ]);
      const parsedStats = statsFromPayload(stats, logs);
      const accountStats = Object.fromEntries(Object.entries(parsedStats).filter(([, value]) => value != null && Number.isFinite(Number(value))));
      return {
        balance,
        remaining: quotaAmount(findNumber(user, ['remaining_quota', 'remainingQuota'])) ?? balance,
        currency: provider.currency || '$',
        ...(Object.keys(accountStats).length ? { accountStats } : {})
      };
    } finally {
      clearTimeout(timer);
    }
  }
};
