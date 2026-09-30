const { notConfigured } = require('./base');
const pendingRefreshes = new WeakMap();

function parseNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[, ]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function apiUrl(provider, pathname) {
  try {
    const raw = String(provider.loginUrl || provider.requestUrl || provider.baseUrl || '').trim();
    return `${new URL(raw).origin}/api/v1/${pathname}`;
  } catch {
    return '';
  }
}

function requestContext(provider) {
  const context = {
    provider,
    refreshUrl: apiUrl(provider, 'auth/refresh'),
    token: String(provider.accountToken || '').trim().replace(/^Bearer\s+/i, ''),
    refreshToken: String(provider.accountRefreshToken || '').trim(),
    cookie: String(provider.accountCookie || '').trim(),
    headers: { Accept: 'application/json', 'X-User-UI-Request': '1' }
  };
  if (context.token) context.headers.Authorization = `Bearer ${context.token}`;
  if (context.cookie) context.headers.Cookie = context.cookie;
  return context;
}

function unwrap(body) {
  return body?.data ?? body?.result ?? body;
}

async function refreshAccessToken(context, signal) {
  const provider = context.provider;
  if (!context.refreshToken) return false;
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', 'X-User-UI-Request': '1' };
  if (context.cookie) headers.Cookie = context.cookie;
  const response = await fetch(context.refreshUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ refresh_token: context.refreshToken }),
    signal
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!response.ok || body?.success === false || (body?.code != null && body.code !== 0)) {
    const error = new Error(response.status === 401
      ? 'Sub2API 登录会话已过期，请重新连接账户'
      : `Sub2API 会话刷新失败 (${response.status}): ${body?.message || body?.detail || '响应无效'}`);
    error.status = response.status;
    error.rateLimited = response.status === 429;
    throw error;
  }
  const data = unwrap(body);
  const token = String(data?.access_token || data?.accessToken || '').trim().replace(/^Bearer\s+/i, '');
  if (token.length < 16 || /\s/.test(token)) throw new Error('Sub2API 刷新响应缺少有效的 access_token');
  context.token = token;
  context.headers.Authorization = `Bearer ${token}`;
  provider.accountToken = token;
  const refreshToken = String(data?.refresh_token || data?.refreshToken || '').trim();
  if (refreshToken) {
    context.refreshToken = refreshToken;
    provider.accountRefreshToken = refreshToken;
  }
  if (data?.user?.id != null) provider.accountUserId = String(data.user.id);
  return true;
}

async function getJson(url, context, signal) {
  const sentToken = context.token;
  let response = await fetch(url, { headers: context.headers, signal });
  if (response.status === 401 && context.refreshToken) {
    // Balance and key imports may overlap; share token rotation for this account.
    if (String(context.provider.accountToken || '').trim().replace(/^Bearer\s+/i, '') === sentToken) {
      if (!pendingRefreshes.has(context.provider)) {
        const pending = refreshAccessToken(context, signal).finally(() => { pendingRefreshes.delete(context.provider); });
        pendingRefreshes.set(context.provider, pending);
      }
      await pendingRefreshes.get(context.provider);
    }
    context.token = String(context.provider.accountToken || '').trim().replace(/^Bearer\s+/i, '');
    context.refreshToken = String(context.provider.accountRefreshToken || '').trim();
    context.headers.Authorization = `Bearer ${context.token}`;
    response = await fetch(url, { headers: context.headers, signal });
  }
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!response.ok || body?.success === false || (body?.code != null && body.code !== 0)) {
    const message = body?.message || body?.detail || body?.error?.message || text.slice(0, 200);
    const error = new Error(response.status === 401
      ? `Sub2API 登录凭据已过期，请重新连接账户: ${message}`
      : `${response.status} ${response.statusText}: ${message}`);
    error.status = response.status;
    error.rateLimited = response.status === 429;
    throw error;
  }
  return body?.data ?? body;
}

module.exports = {
  id: 'sub2api',
  label: 'Sub2API',
  async detect(provider) {
    const token = String(provider.accountToken || '').trim();
    const cookie = String(provider.accountCookie || '').trim();
    const refreshToken = String(provider.accountRefreshToken || '').trim();
    if (!token && !cookie && !refreshToken) return notConfigured('Sub2API', '网页授权凭据');
    const profileUrl = apiUrl(provider, 'user/profile');
    if (!profileUrl) throw new Error('Sub2API 登录地址无效');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const context = requestContext(provider);
      const profile = await getJson(profileUrl, context, controller.signal);
      return { profile };
    } finally {
      clearTimeout(timer);
    }
  },
  async getApiKeys(provider) {
    const token = String(provider.accountToken || '').trim();
    const cookie = String(provider.accountCookie || '').trim();
    const refreshToken = String(provider.accountRefreshToken || '').trim();
    if (!token && !cookie && !refreshToken) throw new Error('请先连接 Sub2API 账户');
    const origin = apiUrl(provider, 'keys');
    if (!origin) throw new Error('Sub2API 登录地址无效');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const context = requestContext(provider);
      const keys = [];
      let received = 0;
      let total = Infinity;
      for (let page = 1; page <= 100 && received < total; page += 1) {
        const url = new URL(origin);
        url.searchParams.set('page', String(page));
        url.searchParams.set('page_size', '100');
        const data = await getJson(url, context, controller.signal);
        const items = Array.isArray(data) ? data : data?.items;
        if (!Array.isArray(items)) throw new Error('Sub2API API 密钥列表响应格式无效');
        if (Number.isFinite(Number(data?.total))) total = Number(data.total);
        const batch = items.map(item => ({ key: String(item?.key || '').trim(), name: String(item?.name || '').trim() })).filter(item => item.key);
        keys.push(...batch);
        received += items.length;
        if (items.length === 0 || received >= total || (!Number.isFinite(total) && items.length < 100)) break;
      }
      if (keys.length >= 10000) throw new Error('API 密钥数量超过导入上限');
      if (!keys.length) throw new Error('该 Sub2API 账户没有可导入的 API 密钥');
      return keys;
    } finally {
      clearTimeout(timer);
    }
  },
  async getBalance(provider) {
    const token = String(provider.accountToken || '').trim();
    const cookie = String(provider.accountCookie || '').trim();
    const refreshToken = String(provider.accountRefreshToken || '').trim();
    if (!token && !cookie && !refreshToken) return notConfigured('Sub2API', '点击“连接账户”完成网页授权');
    const profileUrl = apiUrl(provider, 'user/profile');
    const statsUrl = apiUrl(provider, 'usage/dashboard/stats');
    if (!profileUrl) throw new Error('Sub2API 登录地址无效');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const context = requestContext(provider);
      const [profile, stats] = await Promise.all([
        provider._accountProfile || getJson(profileUrl, context, controller.signal),
        getJson(statsUrl, context, controller.signal)
      ]);
      const user = profile?.user ?? profile;
      const balance = parseNumber(user?.balance);
      if (balance == null) throw new Error('Sub2API /user/profile 响应中没有可识别的 balance 字段');
      const todayCost = parseNumber(stats?.today_actual_cost);
      const todayRequests = parseNumber(stats?.today_requests);
      if (todayCost == null || todayRequests == null) {
        throw new Error('Sub2API 账户统计响应中缺少 today_actual_cost 或 today_requests');
      }
      return {
        balance,
        remaining: null,
        currency: provider.currency || '$',
        accountStats: {
          todayCost,
          todayRequests,
          todayTokens: parseNumber(stats?.today_tokens),
          averageDurationMs: parseNumber(stats?.average_duration_ms)
        }
      };
    } finally {
      clearTimeout(timer);
    }
  }
};
