const { notConfigured, accountFetch } = require('./base');

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
  const session = String(provider.accountSession || '').trim();
  const headers = { Accept: 'application/json' };
  // Older saved accounts may contain a session cookie in the token field.
  const isSessionCookie = cookie.split(';').some(pair => {
    const index = pair.indexOf('=');
    return index >= 0 && /^(session|new_api_refresh)$/i.test(pair.slice(0, index).trim())
      && pair.slice(index + 1).trim() === token;
  });
  if (token && !isSessionCookie) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (userId) headers['New-Api-User'] = userId;
  if (session) headers['X-Auth-Session'] = session;
  return { headers, token, cookie, session };
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

function updateCookieHeader(cookie, response) {
  const cookies = new Map();
  for (const pair of cookie.split(';')) {
    const index = pair.indexOf('=');
    if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  // getSetCookie preserves separate headers, including commas in Expires.
  for (const header of response.headers.getSetCookie()) {
    const [pair, ...attributes] = header.split(';');
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    const expired = attributes.some(attribute => {
      const [key, ...parts] = attribute.trim().split('=');
      if (key.toLowerCase() === 'max-age') return Number(parts.join('=')) <= 0;
      if (key.toLowerCase() === 'expires') return Date.parse(parts.join('=')) <= Date.now();
      return false;
    });
    if (!value || expired) cookies.delete(name);
    else cookies.set(name, value);
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function refreshAccessToken(provider, origin, context, signal) {
  if (!context.cookie) return false;
  const headers = { Accept: 'application/json', Cookie: context.cookie, 'Cache-Control': 'no-cache, no-store' };
  if (context.session) headers['X-Auth-Session'] = context.session;
  const response = await accountFetch(`${origin}/api/user/auth/refresh`, { method: 'POST', headers, signal });
  context.cookie = updateCookieHeader(context.cookie, response);
  provider.accountCookie = context.cookie;
  if (context.cookie) context.headers.Cookie = context.cookie;
  else delete context.headers.Cookie;
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (response.status === 404 || response.status === 405) return false;
  if (!response.ok || body?.success === false) {
    const error = new Error(response.status === 401
      ? 'New API 登录会话已失效，请在连接窗口退出账户后重新登录'
      : `New API 会话刷新失败 (${response.status})${body?.code ? `: ${body.code}` : ''}`);
    error.status = response.status;
    error.rateLimited = response.status === 429;
    throw error;
  }
  const bundle = unwrap(body);
  const token = String(bundle?.access_token || bundle?.accessToken || '').trim().replace(/^Bearer\s+/i, '');
  if (token.length < 16 || /\s/.test(token)) throw new Error('New API 刷新响应缺少有效的 access_token');
  context.headers.Authorization = `Bearer ${token}`;
  provider.accountToken = token;
  if (bundle?.session?.sid) {
    context.session = String(bundle.session.sid);
    provider.accountSession = context.session;
    context.headers['X-Auth-Session'] = context.session;
  }
  if (bundle?.user?.id != null) {
    provider.accountUserId = String(bundle.user.id);
    context.headers['New-Api-User'] = provider.accountUserId;
  }
  return true;
}

async function getJson(url, headers, signal, method = 'GET', onUnauthorized) {
  let response = await accountFetch(url, { method, headers, signal });
  if (response.status === 401 && typeof onUnauthorized === 'function' && await onUnauthorized()) {
    response = await accountFetch(url, { method, headers, signal });
  }
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

function authContext(provider, origin, signal) {
  const context = requestHeaders(provider);
  let refreshPromise = null;
  const refresh = async () => {
    if (!context.cookie) return false;
    if (!refreshPromise) {
      refreshPromise = refreshAccessToken(provider, origin, context, signal).finally(() => { refreshPromise = null; });
    }
    return refreshPromise;
  };
  return { ...context, refresh };
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
    const origin = originFor(provider);
    const { token, cookie } = requestHeaders(provider);
    if (!token && !cookie && !provider.accountUserId) return notConfigured('New API', '网页授权凭据');
    if (!origin) throw new Error('New API 登录地址无效');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const request = authContext(provider, origin, controller.signal);
      const profile = await getJson(`${origin}/api/user/self`, request.headers, controller.signal, 'GET', request.refresh);
      return { profile };
    } finally {
      clearTimeout(timer);
    }
  },
  async getApiKeys(provider) {
    const origin = originFor(provider);
    const { token, cookie } = requestHeaders(provider);
    if (!token && !cookie && !provider.accountUserId) throw new Error('请先连接 New API 账户');
    if (!origin) throw new Error('New API 登录地址无效');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const request = authContext(provider, origin, controller.signal);
      const keys = [];
      for (let page = 1; page <= 100; page += 1) {
        const list = await getJson(`${origin}/api/token/?p=${page}&size=100`, request.headers, controller.signal, 'GET', request.refresh);
        const items = Array.isArray(list) ? list : list?.items;
        if (!Array.isArray(items)) throw new Error('New API 令牌列表响应格式无效');
        for (const item of items) {
          if (item?.status != null && Number(item.status) !== 1) continue;
          // Compatible sites may return the complete key in the list. The
          // upstream format still needs the separate reveal request.
          let rawKey = String(item?.key || '').trim();
          if (/\*{3,}/.test(rawKey)) rawKey = '';
          if (!rawKey && item?.id != null) {
            const detail = await getJson(`${origin}/api/token/${encodeURIComponent(item.id)}/key`, request.headers, controller.signal, 'POST', request.refresh);
            rawKey = String(detail?.key || '').trim();
          }
          if (/\*{3,}/.test(rawKey)) throw new Error('New API 返回了脱敏的 API Key，请在站点复制完整令牌后手动填写');
          if (rawKey) keys.push({ key: /^sk-/i.test(rawKey) ? rawKey : `sk-${rawKey}`, name: String(item?.name || item?.remark || '').trim() });
        }
        if (items.length < 100) break;
      }
      if (!keys.length) throw new Error('该 New API 账户没有可导入的 API 密钥');
      return keys;
    } finally {
      clearTimeout(timer);
    }
  },
  async getBalance(provider) {
    const origin = originFor(provider);
    const { token, cookie } = requestHeaders(provider);
    if (!token && !cookie && !provider.accountUserId) return notConfigured('New API', '点击“连接账户”完成网页授权，或填写备用登录令牌');
    if (!origin) throw new Error('New API 登录地址无效');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const request = authContext(provider, origin, controller.signal);
      const profile = provider._accountProfile || await getJson(`${origin}/api/user/self`, request.headers, controller.signal, 'GET', request.refresh);
      const user = unwrap(profile);
      const rawBalance = findNumber(user, ['quota', 'remaining_quota', 'remainingQuota', 'balance', 'credit']);
      const balance = quotaAmount(rawBalance);
      if (balance == null) throw new Error('New API /api/user/self 响应中没有可识别的 quota 或 balance 字段');
      let stats = null;
      let logs = null;
      await Promise.all([
        getJson(`${origin}/api/performance/stats`, request.headers, controller.signal, 'GET', request.refresh).then(value => { stats = value; }).catch(() => {}),
        getJson(`${origin}/api/performance/logs`, request.headers, controller.signal, 'GET', request.refresh).then(value => { logs = value; }).catch(() => {})
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
