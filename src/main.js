const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const balanceAdapters = require('./providers');

const PORT = 8787;
let mainWindow;
let gateway;
let tray;
let isQuitting = false;
let panelWindowOpen = false;
let petHidden = false;
let activeBalanceQueries = 0;
const PET_LEFT = 14;
const PET_CLOSED_TOP = 12;
const PET_OPEN_TOP = 450;
const PET_SIZE = { width: 155, height: 190 };
const CLOSED_WINDOW_SIZE = { width: 190, height: 220 };
const OPEN_WINDOW_SIZE = { width: 430, height: 650 };
const gotSingleInstanceLock = app.requestSingleInstanceLock();

process.on('uncaughtException', error => writeStartupLog('主进程未捕获异常', error));
process.on('unhandledRejection', error => writeStartupLog('主进程未处理 Promise 异常', error));

function writeStartupLog(message, error) {
  try {
    const detail = error ? ` ${error.stack || error.message || error}` : '';
    fs.appendFileSync(path.join(__dirname, '..', 'electron-startup.log'), `[${new Date().toISOString()}] ${message}${detail}\n`);
  } catch {}
}

function setPetPinned(pinned) {
  const enabled = pinned === true;
  state.alwaysOnTop = enabled;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(enabled, 'floating');
  persist();
  updateTrayMenu();
}

function setPetHidden(hidden) {
  petHidden = hidden === true;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (petHidden) mainWindow.hide();
  else ensureMainWindowVisible();
  updateTrayMenu();
}

function openPanel() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (petHidden) setPetHidden(false);
  if (mainWindow.isMinimized()) mainWindow.restore();
  ensureMainWindowVisible();
  mainWindow.webContents.send('show-panel');
}

function buildAppMenu() {
  return Menu.buildFromTemplate([
    { label: '打开控制面板', click: openPanel },
    { label: state.alwaysOnTop ? '取消置顶' : '置顶', click: () => setPetPinned(!state.alwaysOnTop) },
    { label: petHidden ? '显示宠物' : '隐藏宠物', click: () => setPetHidden(!petHidden) },
    { label: '打开网关地址', click: () => shell.openExternal(`http://127.0.0.1:${PORT}/v1/models`) },
    { type: 'separator' },
    { label: '退出 API Pet', click: () => app.quit() }
  ]);
}

function updateTrayMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildAppMenu());
}

function createTray() {
  if (tray && !tray.isDestroyed()) return;
  const iconPath = path.join(__dirname, 'renderer', 'assets', 'pet-normal.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('API Pet');
  updateTrayMenu();
  tray.on('double-click', openPanel);
}

function setPanelWindowPosition(open) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (panelWindowOpen === open) return;
  const bounds = mainWindow.getBounds();
  const anchorX = bounds.x + PET_LEFT;
  const anchorY = bounds.y + (panelWindowOpen ? PET_OPEN_TOP : PET_CLOSED_TOP);
  const size = open ? OPEN_WINDOW_SIZE : CLOSED_WINDOW_SIZE;
  const top = open ? PET_OPEN_TOP : PET_CLOSED_TOP;
  panelWindowOpen = open;
  // Resize and move together so the pet keeps the same screen anchor while the bubble grows upward.
  mainWindow.setBounds({ x: anchorX - PET_LEFT, y: anchorY - top, width: size.width, height: size.height }, false);
  clampWindowToDisplay();
}

function ensureMainWindowVisible() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const visible = screen.getAllDisplays().some(display => {
    const area = display.workArea;
    return bounds.x >= area.x && bounds.y >= area.y
      && bounds.x + bounds.width <= area.x + area.width
      && bounds.y + bounds.height <= area.y + area.height;
  });
  if (!visible) {
    const area = screen.getPrimaryDisplay().workArea;
    mainWindow.setPosition(
      Math.round(area.x + (area.width - bounds.width) / 2),
      Math.round(area.y + (area.height - bounds.height) / 2)
    );
    writeStartupLog('窗口位置超出屏幕，已移回主屏幕中央');
  }
  mainWindow.show();
  mainWindow.focus();
}

if (!gotSingleInstanceLock) {
  try { fs.appendFileSync(path.join(__dirname, '..', 'electron-startup.log'), `[${new Date().toISOString()}] 启动请求被已有实例拦截\n`); } catch {}
  app.quit();
} else {
  app.on('second-instance', () => {
    writeStartupLog('收到重复启动请求，唤醒已有实例');
    if (!mainWindow) {
      writeStartupLog('已有实例没有主窗口，尝试重新创建窗口');
      if (app.isReady()) makeWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.setSkipTaskbar(false);
    openPanel();
  });
}

function dataPath() { return path.join(app.getPath('userData'), 'api-pet.json'); }
function defaultState() {
  return {
    unifiedKey: `pet-${crypto.randomBytes(18).toString('hex')}`,
    providers: [],
    routes: {},
    routingEnabled: false,
    routingMode: 'model',
    alwaysOnTop: true,
    unifiedRoute: { providerId: '', model: '', format: 'responses' },
    balanceSettings: { lowThreshold: 5, refreshMinutes: 10 }
  };
}
function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(dataPath(), 'utf8'));
    const oldTarget = saved.virtualModel?.target || '';
    const savedFormat = saved.unifiedRoute?.format;
    const format = savedFormat === 'responses' || savedFormat === 'chat/completions' ? savedFormat : 'responses';
    const defaults = defaultState();
    return {
      ...defaults,
      ...saved,
      routingEnabled: saved.routingEnabled === true,
      routingMode: saved.routingMode || 'model',
      alwaysOnTop: saved.alwaysOnTop !== false,
      balanceSettings: { ...defaults.balanceSettings, ...(saved.balanceSettings || {}) },
      unifiedRoute: { ...defaults.unifiedRoute, ...(saved.unifiedRoute || {}), model: saved.unifiedRoute?.model || oldTarget, format },
      providers: Array.isArray(saved.providers) ? saved.providers.map(normalizeProvider) : []
    };
  }
  catch { return defaultState(); }
}
let state = loadState();
function persist() { fs.mkdirSync(path.dirname(dataPath()), { recursive: true }); fs.writeFileSync(dataPath(), JSON.stringify(state, null, 2)); }
function safeState() { return JSON.parse(JSON.stringify(state)); }
function cleanBaseUrl(url) { return String(url || '').replace(/\/+$/, ''); }
function todayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function normalizeDailyStats(stats) {
  const current = stats?.date === todayKey() ? stats : {};
  return {
    date: todayKey(),
    requestCount: Math.max(0, Number(current.requestCount) || 0),
    successCount: Math.max(0, Number(current.successCount) || 0),
    lastResponseMs: Number.isFinite(Number(current.lastResponseMs)) ? Number(current.lastResponseMs) : null,
    usageTokens: Math.max(0, Number(current.usageTokens) || 0),
    cost: Number.isFinite(Number(current.cost)) ? Number(current.cost) : null,
    costCurrency: String(current.costCurrency || '')
  };
}
function recordProviderRequest(provider) {
  provider.dailyStats = normalizeDailyStats(provider.dailyStats);
  provider.dailyStats.requestCount += 1;
}
function recordProviderResult(provider, startedAt, success, usage = {}) {
  provider.dailyStats = normalizeDailyStats(provider.dailyStats);
  provider.dailyStats.lastResponseMs = Math.max(0, Date.now() - startedAt);
  if (success) provider.dailyStats.successCount += 1;
  if (Number.isFinite(Number(usage.tokens)) && Number(usage.tokens) > 0) provider.dailyStats.usageTokens += Number(usage.tokens);
  if (Number.isFinite(Number(usage.cost))) {
    provider.dailyStats.cost = (provider.dailyStats.cost || 0) + Number(usage.cost);
    provider.dailyStats.costCurrency = String(usage.currency || provider.dailyStats.costCurrency || '');
  }
  persist();
}
function extractUsage(body, headers) {
  const usage = body?.usage || body?.usage_info || {};
  const tokens = Number(usage.total_tokens ?? usage.totalTokens ?? ((Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0)));
  const costHeader = ['x-cost', 'x-total-cost', 'x-spend', 'x-usage-cost'].map(name => headers.get(name)).find(Boolean);
  const cost = Number(body?.cost ?? body?.usage?.cost ?? costHeader);
  const currency = headers.get('x-currency') || body?.currency || body?.usage?.currency || '';
  return { tokens: Number.isFinite(tokens) ? tokens : null, cost: Number.isFinite(cost) ? cost : null, currency };
}
function clampWindowToDisplay() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const petTop = panelWindowOpen ? PET_OPEN_TOP : PET_CLOSED_TOP;
  const petX = Math.min(Math.max(bounds.x + PET_LEFT, area.x), area.x + area.width - PET_SIZE.width);
  const petY = Math.min(Math.max(bounds.y + petTop, area.y), area.y + area.height - PET_SIZE.height);
  const x = petX - PET_LEFT;
  const y = petY - petTop;
  if (x !== bounds.x || y !== bounds.y) mainWindow.setPosition(x, y);
}
function providerBaseUrls(provider) {
  const base = cleanBaseUrl(provider?.requestUrl || provider?.loginUrl || provider?.baseUrl);
  if (!base) return [];
  return /\/v1$/i.test(base) ? [base] : [`${base}/v1`, base];
}
function providerModels(provider) { return Array.isArray(provider.models) ? provider.models : []; }
function normalizeProvider(provider) {
  const loginUrl = cleanBaseUrl(provider.loginUrl || provider.baseUrl || provider.requestUrl);
  const requestSource = Object.prototype.hasOwnProperty.call(provider, 'requestUrl') ? provider.requestUrl : provider.baseUrl;
  const requestUrl = cleanBaseUrl(requestSource);
  const rawKeys = Array.isArray(provider.apiKeys) ? provider.apiKeys : (provider.apiKey ? [{ key: provider.apiKey, remark: provider.tokenRemark || '', enabled: true }] : []);
  const apiKeys = rawKeys.map(item => ({ key: String(item?.key || '').trim(), remark: String(item?.remark || '').trim(), enabled: item?.enabled !== false })).filter(item => item.key);
  const selectedKey = apiKeys.find(item => item.enabled) || apiKeys[0] || { key: '', remark: '' };
  const selectedIndex = Math.max(0, apiKeys.findIndex(item => item === selectedKey));
  apiKeys.forEach((item, index) => { item.enabled = index === selectedIndex; });
  return {
    ...provider,
    loginUrl,
    requestUrl,
    baseUrl: requestUrl || loginUrl,
    balanceAdapter: provider.balanceAdapter === 'neko-api' ? 'sub2api' : (provider.balanceAdapter || 'custom'),
    apiKeys,
    apiKey: selectedKey.key,
    tokenRemark: selectedKey.remark,
    accountToken: provider.accountToken || '',
    accountCookie: provider.accountCookie || '',
    accountUserId: cleanAccountUserId(provider.accountUserId),
    balanceUrl: provider.balanceUrl || '',
    balanceMethod: provider.balanceMethod || 'GET',
    balancePath: provider.balancePath || 'data.balance',
    remainingPath: provider.remainingPath || '',
    currency: provider.currency || '$',
    dailyStats: normalizeDailyStats(provider.dailyStats),
    accountStats: provider.accountStats && typeof provider.accountStats === 'object' ? { ...provider.accountStats } : null,
    balance: {
      balance: null,
      remaining: null,
      currency: provider.currency || '$',
      status: 'unknown',
      apiStatus: 'unknown',
      error: '',
      updatedAt: '',
      configured: false,
      ...(provider.balance || {})
    }
  };
}
function selectProviderApiKey(provider) {
  const selected = (Array.isArray(provider.apiKeys) ? provider.apiKeys : []).find(item => item?.enabled && item.key) || (Array.isArray(provider.apiKeys) ? provider.apiKeys.find(item => item?.key) : null);
  provider.apiKey = String(selected?.key || provider.apiKey || '').trim();
  provider.tokenRemark = String(selected?.remark || provider.tokenRemark || '');
  return provider.apiKey;
}
function findProviderForModel(model) {
  const selected = state.routes[model];
  if (selected) return state.providers.find(p => p.id === selected && providerModels(p).includes(model));
  return state.providers.find(p => providerModels(p).includes(model));
}
function resolveRequestedModel(model) {
  if (model === 'Pet model') return state.unifiedRoute?.model || '';
  return model;
}
function allModels() {
  const ids = new Set();
  state.providers.forEach(p => providerModels(p).forEach(id => ids.add(id)));
  return [...ids].sort().map(id => ({ id, object: 'model', owned_by: 'api-pet' }));
}
async function fetchModels(provider, apiKeyOverride = '') {
  const apiKey = String(apiKeyOverride || selectProviderApiKey(provider)).trim();
  if (!apiKey) throw new Error('该站点没有可用的 API Key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    let lastError;
    for (const base of providerBaseUrls(provider)) {
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, signal: controller.signal
      });
      const text = await res.text();
      let body; try { body = JSON.parse(text); } catch { body = {}; }
      if (res.ok && Array.isArray(body.data)) {
        return body.data.map(x => typeof x === 'string' ? x : x.id).filter(Boolean);
      }
      lastError = new Error(`${res.status} ${res.statusText}: ${body?.error?.message || text.slice(0, 200)}`);
    }
    throw lastError || new Error('无法获取模型列表');
  } finally { clearTimeout(timer); }
}
async function testProvider(id) {
  const provider = state.providers.find(p => p.id === id);
  if (!provider) throw new Error('Provider not found');
  try {
    const models = await fetchModels(provider);
    provider.models = models; provider.status = 'online'; provider.error = ''; provider.lastChecked = new Date().toISOString(); persist();
    if (state.unifiedRoute.providerId === id && !models.includes(state.unifiedRoute.model)) { state.unifiedRoute.model = ''; persist(); }
    return { ok: true, models, state: safeState() };
  } catch (e) {
    provider.status = 'error'; provider.error = e.message; provider.lastChecked = new Date().toISOString(); persist();
    return { ok: false, error: e.message, state: safeState() };
  }
}
async function fetchChatModels(providerId, keyIndex) {
  const provider = state.providers.find(item => item.id === providerId);
  const index = Number(keyIndex);
  const selectedKey = provider?.apiKeys?.[index];
  if (!provider || !Number.isInteger(index) || index < 0 || !selectedKey?.key) {
    throw new Error('所选站点或 Key 无效');
  }
  return fetchModels(provider, selectedKey.key);
}
function balanceStatus(balance, threshold) {
  if (balance == null || !Number.isFinite(Number(balance))) return 'unknown';
  const amount = Number(balance);
  if (amount <= 0) return 'empty';
  if (amount <= Number(threshold)) return 'low';
  return 'online';
}
function getProviderAdapter(provider) {
  return balanceAdapters[provider.balanceAdapter || 'custom'] || balanceAdapters.custom;
}
async function queryProviderBalance(id) {
  const provider = state.providers.find(p => p.id === id);
  if (!provider) throw new Error('Provider not found');
  activeBalanceQueries += 1;
  try {
    selectProviderApiKey(provider);
    if (activeBalanceQueries === 1 && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('balance-activity', true);
    const now = new Date().toISOString();
    provider.balance = normalizeProvider(provider).balance;
    try {
      const adapter = getProviderAdapter(provider);
      const result = await adapter.getBalance(provider);
      provider.balance = {
        ...provider.balance,
        balance: result.balance,
        remaining: result.remaining ?? null,
        currency: result.currency || provider.currency || '$',
        status: balanceStatus(result.balance, state.balanceSettings.lowThreshold),
        apiStatus: 'online',
        error: '',
        updatedAt: now,
        configured: true
      };
      if (result.accountStats) {
        provider.accountStats = {
          ...(result.accountStats.todayCost != null && Number.isFinite(Number(result.accountStats.todayCost)) ? { todayCost: Number(result.accountStats.todayCost) } : {}),
          ...(result.accountStats.todayRequests != null && Number.isFinite(Number(result.accountStats.todayRequests)) ? { todayRequests: Number(result.accountStats.todayRequests) } : {}),
          ...(result.accountStats.todayTokens != null && Number.isFinite(Number(result.accountStats.todayTokens)) ? { todayTokens: Number(result.accountStats.todayTokens) } : {}),
          ...(result.accountStats.averageDurationMs != null && Number.isFinite(Number(result.accountStats.averageDurationMs)) ? { averageDurationMs: Number(result.accountStats.averageDurationMs) } : {}),
          updatedAt: now
        };
      }
      provider.balanceStatus = provider.balance.status;
      provider.balanceError = '';
    } catch (error) {
      const configured = error?.code !== 'balance_adapter_not_configured';
      provider.balance = {
        ...provider.balance,
        status: configured ? 'error' : 'unconfigured',
        apiStatus: configured ? 'error' : 'unknown',
        error: String(error?.message || error),
        updatedAt: now,
        configured
      };
      provider.balanceStatus = provider.balance.status;
      provider.balanceError = provider.balance.error;
    }
    persist();
    return safeState();
  } finally {
    activeBalanceQueries = Math.max(0, activeBalanceQueries - 1);
    if (activeBalanceQueries === 0 && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('balance-activity', false);
  }
}
async function refreshAllBalances() {
  for (const provider of state.providers) await queryProviderBalance(provider.id);
  return safeState();
}
let balanceTimer;
function scheduleBalanceRefresh() {
  if (balanceTimer) clearInterval(balanceTimer);
  const minutes = Math.max(1, Number(state.balanceSettings?.refreshMinutes) || 10);
  balanceTimer = setInterval(() => { refreshAllBalances().catch(() => {}); }, minutes * 60 * 1000);
}
function sub2apiOrigin(provider) {
  try { return new URL(String(provider?.loginUrl || provider?.requestUrl || provider?.baseUrl || '')).origin; } catch { return ''; }
}
function isJwt(value) {
  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(value || '').trim());
}
function cleanSessionToken(value) {
  const token = String(value || '').trim().replace(/^Bearer\s+/i, '');
  if (!token || token.length < 16 || /\s/.test(token)) return '';
  return token;
}
function cleanAccountUserId(value) {
  if (value == null) return '';
  const text = String(value).trim();
  return text && text.length <= 200 ? text : '';
}
function accountUserIdFromValue(value, keyHint = '') {
  if (value == null) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '';
    if (/^(uid|user_id|userId|userid|id)$/i.test(keyHint)) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          return accountUserIdFromValue(parsed.uid ?? parsed.user_id ?? parsed.userId ?? parsed.id, 'uid');
        }
      } catch {}
      return cleanAccountUserId(text);
    }
    if (/user|auth|session|account|profile|uid/i.test(keyHint)) {
      try {
        const parsed = JSON.parse(text);
        return accountUserIdFromValue(parsed?.uid ?? parsed?.user_id ?? parsed?.userId ?? parsed?.id, 'uid');
      } catch {}
    }
    return '';
  }
  if (typeof value === 'number' || typeof value === 'bigint') return cleanAccountUserId(value);
  if (typeof value === 'object') return accountUserIdFromValue(value.uid ?? value.user_id ?? value.userId ?? value.id, 'uid');
  return '';
}
function tokenFromValue(value, keyHint = '', seen = new Set()) {
  if (value == null) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '';
    if (isJwt(text)) return cleanSessionToken(text);
    try {
      const parsed = JSON.parse(text);
      const nested = tokenFromValue(parsed, keyHint, seen);
      if (nested) return nested;
    } catch {}
    if (/token|jwt|access|auth|session/i.test(keyHint)) return cleanSessionToken(text);
    return '';
  }
  if (typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  const preferred = ['token', 'access_token', 'accessToken', 'userToken', 'authToken', 'jwt', 'authorization', 'sessionToken', 'loginToken'];
  for (const key of preferred) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const nested = tokenFromValue(value[key], key, seen);
      if (nested) return nested;
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (/token|jwt|access|auth|session/i.test(key)) {
      const nested = tokenFromValue(child, key, seen);
      if (nested) return nested;
    }
  }
  return '';
}
async function readSub2apiCredentials(loginWindow, origin) {
  let cookies = [];
  try { cookies = await loginWindow.webContents.session.cookies.get({ url: origin }); } catch {}
  if (!cookies.length) {
    try {
      const hostname = new URL(origin).hostname;
      const allCookies = await loginWindow.webContents.session.cookies.get({});
      cookies = allCookies.filter(cookie => {
        const domain = String(cookie.domain || '').replace(/^\./, '');
        return domain === hostname || hostname.endsWith(`.${domain}`);
      });
    } catch {}
  }
  const accountCookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  let accountToken = '';
  let accountUserId = '';
  for (const cookie of cookies) {
    const token = tokenFromValue(cookie.value, cookie.name);
    if (token) { accountToken = token; break; }
  }
  try {
    const storageEntries = await loginWindow.webContents.executeJavaScript(`(() => {
      const entries = [];
      for (const storage of [localStorage, sessionStorage]) {
        for (let i = 0; i < storage.length; i += 1) {
          const key = storage.key(i) || '';
          const value = storage.getItem(key) || '';
          entries.push({ key, value });
        }
      }
      return entries;
    })()`, true);
    if (Array.isArray(storageEntries)) {
      for (const entry of storageEntries) {
        if (!accountUserId) accountUserId = accountUserIdFromValue(entry?.value, entry?.key || '');
        const token = tokenFromValue(entry?.value, entry?.key || '');
        if (token && !accountToken) accountToken = token;
      }
    }
  } catch {}
  return { accountToken: cleanSessionToken(accountToken), accountCookie, accountUserId: cleanAccountUserId(accountUserId) };
}
function accountAdapterCandidates(provider) {
  const ids = [provider?.balanceAdapter, 'new-api', 'sub2api'];
  const candidates = [];
  for (const id of ids) {
    if (!id || candidates.some(item => item.id === id)) continue;
    const adapter = balanceAdapters[id];
    if (adapter?.detect || adapter?.getBalance) candidates.push(adapter);
  }
  return candidates;
}
async function detectAccountAdapter(provider, credentials) {
  const errors = [];
  for (const adapter of accountAdapterCandidates(provider)) {
    try {
      const candidate = { ...provider, ...credentials };
      const detection = typeof adapter.detect === 'function'
        ? await adapter.detect(candidate)
        : { profile: null };
      const accountData = await adapter.getBalance({ ...candidate, _accountProfile: detection.profile });
      return { adapter, accountData };
    } catch (error) {
      if (error?.rateLimited || Number(error?.status) === 429) throw error;
      if (adapter.id === 'sub2api' && Number(error?.status) === 404) continue;
      errors.push(`${adapter.label || adapter.id}: ${String(error?.message || error)}`);
    }
  }
  throw new Error(errors.join('；') || '无法识别站点账户接口');
}
ipcMain.handle('connect-provider-account', async (_e, input) => {
  const isDraft = Boolean(input && typeof input === 'object' && input.provider);
  const id = typeof input === 'string' ? input : String(input?.id || '');
  const provider = isDraft ? normalizeProvider(input.provider) : state.providers.find(item => item.id === id);
  if (!provider) return { ok: false, error: 'Provider not found', state: safeState() };
  const adapter = getProviderAdapter(provider);
  if (!['sub2api', 'new-api'].includes(provider.balanceAdapter)) return { ok: false, error: '当前站点类型不支持账户登录', state: safeState() };
  const loginUrl = cleanBaseUrl(typeof input === 'object' ? input?.loginUrl : '') || provider.loginUrl;
  const origin = sub2apiOrigin({ ...provider, loginUrl });
  if (!origin) return { ok: false, error: '登录地址无效', state: safeState() };
  return new Promise(resolve => {
    let settled = false;
    let capturing = false;
    let lastCaptureError = '';
    const attemptedCredentials = new Set();
    const loginWindow = new BrowserWindow({ parent: mainWindow, modal: false, width: 1100, height: 760, title: `连接 ${provider.name} 账户`, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    const finish = async (result) => { if (settled) return; settled = true; resolve(result); };
    const tryCapture = async () => {
      if (settled || capturing || loginWindow.isDestroyed()) return;
      const credentials = await readSub2apiCredentials(loginWindow, origin);
      if (settled || capturing || loginWindow.isDestroyed()) return;
      const capturedUserId = credentials.accountUserId || provider.accountUserId || '';
      if (!credentials.accountToken && !credentials.accountCookie && !capturedUserId) return;
      const credentialFingerprint = `${credentials.accountToken}\n${credentials.accountCookie}\n${capturedUserId}`;
      if (attemptedCredentials.has(credentialFingerprint)) return;
      attemptedCredentials.add(credentialFingerprint);
      capturing = true;
      const accountProvider = { ...provider, loginUrl, ...credentials, accountUserId: capturedUserId };
      let accountData;
      let resolvedAdapter = adapter;
      try {
        const detected = await detectAccountAdapter(accountProvider, { ...credentials, accountUserId: capturedUserId });
        resolvedAdapter = detected.adapter;
        accountData = detected.accountData;
      } catch (error) {
        lastCaptureError = String(error?.message || error || '账户接口验证失败');
        loginWindow.setTitle(`连接 ${provider.name} 账户 - ${lastCaptureError.slice(0, 80)}`);
        capturing = false;
        return;
      }
      provider.balanceAdapter = resolvedAdapter.id;
      provider.accountToken = credentials.accountToken || provider.accountToken || '';
      provider.accountCookie = credentials.accountCookie || provider.accountCookie || '';
      provider.accountUserId = credentials.accountUserId || provider.accountUserId || '';
      const now = new Date().toISOString();
      provider.accountStats = accountData.accountStats ? {
        ...(accountData.accountStats.todayCost != null && Number.isFinite(Number(accountData.accountStats.todayCost)) ? { todayCost: Number(accountData.accountStats.todayCost) } : {}),
        ...(accountData.accountStats.todayRequests != null && Number.isFinite(Number(accountData.accountStats.todayRequests)) ? { todayRequests: Number(accountData.accountStats.todayRequests) } : {}),
        ...(accountData.accountStats.todayTokens != null && Number.isFinite(Number(accountData.accountStats.todayTokens)) ? { todayTokens: Number(accountData.accountStats.todayTokens) } : {}),
        ...(accountData.accountStats.averageDurationMs != null && Number.isFinite(Number(accountData.accountStats.averageDurationMs)) ? { averageDurationMs: Number(accountData.accountStats.averageDurationMs) } : {}),
        updatedAt: now
      } : provider.accountStats || null;
      provider.balance = {
        ...(provider.balance || {}),
        balance: Number(accountData.balance),
        remaining: accountData.remaining ?? null,
        currency: accountData.currency || provider.currency || '$',
        status: balanceStatus(accountData.balance, state.balanceSettings.lowThreshold),
        apiStatus: 'online',
        error: '',
        updatedAt: now,
        configured: true
      };
      provider.balanceStatus = provider.balance.status;
      provider.balanceError = '';
      if (!isDraft) persist();
      const snapshot = { accountToken: provider.accountToken, accountCookie: provider.accountCookie, accountUserId: provider.accountUserId, accountStats: provider.accountStats, balance: provider.balance, balanceAdapter: provider.balanceAdapter };
      await finish({ ok: true, state: safeState(), ...(isDraft ? { provider: snapshot } : {}) });
      if (!loginWindow.isDestroyed()) loginWindow.close();
    };
    const poll = setInterval(() => tryCapture().catch(() => {}), 1200);
    loginWindow.webContents.on('did-finish-load', () => setTimeout(() => tryCapture().catch(() => {}), 700));
    loginWindow.on('closed', () => { clearInterval(poll); finish({ ok: false, error: lastCaptureError || '登录窗口已关闭，尚未获取到账户会话', state: safeState() }); });
    loginWindow.loadURL(loginUrl || `${origin}/login`);
  });
});
function makeWindow() {
  writeStartupLog('正在创建主窗口');
  mainWindow = new BrowserWindow({ width: CLOSED_WINDOW_SIZE.width, height: CLOSED_WINDOW_SIZE.height, minWidth: CLOSED_WINDOW_SIZE.width, minHeight: CLOSED_WINDOW_SIZE.height, center: true, transparent: true, frame: false, resizable: false, alwaysOnTop: true, show: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  mainWindow.setSkipTaskbar(false);
  mainWindow.on('move', clampWindowToDisplay);
  mainWindow.setAlwaysOnTop(state.alwaysOnTop !== false, 'floating');
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', ensureMainWindowVisible);
  mainWindow.webContents.once('did-finish-load', ensureMainWindowVisible);
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => writeStartupLog(`页面加载失败 ${code}: ${description}`));
  mainWindow.webContents.on('render-process-gone', (_event, details) => console.error('API Pet renderer exited:', details));
  mainWindow.webContents.on('unresponsive', () => console.error('API Pet renderer became unresponsive'));
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('context-menu', () => buildAppMenu().popup({ window: mainWindow }));
}
function authOk(req) {
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${state.unifiedKey}` || req.headers['x-api-key'] === state.unifiedKey;
}
function writeJson(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(body)); }
async function directChatRequest(input = {}) {
  const requestedModel = String(input.model || '').trim();
  const requestedProviderId = String(input.providerId || '').trim();
  let model = requestedModel;
  let provider;
  if (requestedProviderId) {
    provider = state.providers.find(item => item.id === requestedProviderId);
    const requestedKeyIndex = input.apiKeyIndex == null ? null : Number(input.apiKeyIndex);
    if (model === 'Pet model') model = String(input.targetModel || '').trim() || providerModels(provider || {})[0] || resolveRequestedModel(model);
    if (!model) model = providerModels(provider || {})[0] || '';
    if (!provider || (requestedKeyIndex == null ? !providerModels(provider).includes(model) : !provider.apiKeys?.[requestedKeyIndex]?.key)) throw new Error(`站点没有模型或 Key：${model || '未选择模型'}`);
  } else if (requestedModel === 'Pet model') {
    model = resolveRequestedModel(requestedModel);
    provider = state.providers.find(item => item.id === state.unifiedRoute?.providerId && providerModels(item).includes(model));
  } else {
    provider = findProviderForModel(model);
  }
  if (!provider) throw new Error(`没有找到模型对应的 Provider：${model || '未选择模型'}`);
  const requestedKeyIndex = requestedProviderId && input.apiKeyIndex != null ? Number(input.apiKeyIndex) : null;
  const apiKey = requestedKeyIndex == null
    ? selectProviderApiKey(provider)
    : provider.apiKeys?.[requestedKeyIndex]?.key;
  if (!apiKey) throw new Error('所选 API Key 无效');
  const format = input.format === 'chat/completions' ? 'chat/completions' : 'responses';
  const upstreamBody = format === 'chat/completions'
    ? { model, messages: Array.isArray(input.messages) ? input.messages : [], stream: false }
    : { model, input: String(input.input || ''), stream: false };
  const requestStartedAt = Date.now();
  recordProviderRequest(provider);
  persist();
  mainWindow?.webContents.send('gateway-status', { status: 'requesting', model: requestedModel || model, target: model, provider: provider.name });
  try {
    let upstream;
    let upstreamUrl;
    let lastError;
    for (const base of providerBaseUrls(provider)) {
      upstreamUrl = `${base}/${format}`;
      upstream = await fetch(upstreamUrl, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(upstreamBody) });
      const contentType = upstream.headers.get('content-type') || '';
      if (upstream.ok && !contentType.toLowerCase().includes('text/html')) break;
      const text = await upstream.text();
      let errorBody; try { errorBody = JSON.parse(text); } catch { errorBody = {}; }
      lastError = new Error(`${upstream.status} ${upstream.statusText}: ${errorBody?.error?.message || text.slice(0, 200)}`);
      if (upstream.status === 404 || upstream.status === 405 || (upstream.ok && contentType.toLowerCase().includes('text/html'))) continue;
      break;
    }
    if (!upstream) throw lastError || new Error(`无法连接上游 Provider：${upstreamUrl || provider.name}`);
    const responseText = await upstream.text();
    let payload; try { payload = JSON.parse(responseText); } catch { payload = { output_text: responseText }; }
    if (!upstream.ok) throw new Error(payload?.error?.message || `${upstream.status} ${upstream.statusText}`);
    recordProviderResult(provider, requestStartedAt, true, extractUsage(payload, upstream.headers));
    mainWindow?.webContents.send('gateway-status', { status: 'success', model: requestedModel || model, target: model, provider: provider.name });
    return payload;
  } catch (error) {
    recordProviderResult(provider, requestStartedAt, false);
    mainWindow?.webContents.send('gateway-status', { status: 'error', model: requestedModel || model, target: model, provider: provider.name });
    throw error;
  }
}
async function proxyChat(req, res, body, endpoint = '/chat/completions') {
  if (!state.routingEnabled) return writeJson(res, 400, { error: { message: '模型路由已关闭，请在 API Pet 中开启“启用路由”', type: 'api_pet_routing_disabled' } });
  const requestedModel = body?.model;
  if (state.routingMode === 'unified' && requestedModel !== 'Pet model') return writeJson(res, 400, { error: { message: '当前为统一模型模式，请求模型必须是 Pet model', type: 'api_pet_mode_error' } });
  if (state.routingMode === 'model' && requestedModel === 'Pet model') return writeJson(res, 400, { error: { message: '当前为模型路由模式，请切换到统一模型模式后再请求 Pet model', type: 'api_pet_mode_error' } });
  const model = resolveRequestedModel(requestedModel);
  if (requestedModel === 'Pet model' && !model) return writeJson(res, 400, { error: { message: '统一模型尚未选择目标模型', type: 'api_pet_virtual_model_error' } });
  if (state.routingMode === 'unified' && requestedModel === 'Pet model') {
    const selectedFormat = state.unifiedRoute?.format === 'chat/completions' ? 'chat/completions' : 'responses';
    if (endpoint.slice(1) !== selectedFormat) {
      return writeJson(res, 400, { error: { message: `统一模型格式已设置为 ${selectedFormat}，客户端请使用对应的 /v1/${selectedFormat} 端点`, type: 'api_pet_format_mismatch' } });
    }
  }
  const requestedProviderId = String(body?.api_pet_provider_id || '').trim();
  const provider = requestedProviderId
    ? state.providers.find(p => p.id === requestedProviderId && providerModels(p).includes(model))
    : requestedModel === 'Pet model'
      ? state.providers.find(p => p.id === state.unifiedRoute?.providerId && providerModels(p).includes(model))
      : findProviderForModel(model);
  if (!provider) return writeJson(res, 404, { error: { message: `No provider configured for model: ${model}`, type: 'api_pet_routing_error' } });
  selectProviderApiKey(provider);
  const requestStartedAt = Date.now();
  recordProviderRequest(provider);
  persist();
  mainWindow?.webContents.send('gateway-status', { status: 'requesting', model: requestedModel, target: model, provider: provider.name });
  try {
    const selectedFormat = state.routingMode === 'unified' && requestedModel === 'Pet model'
      ? (state.unifiedRoute?.format === 'chat/completions' ? 'chat/completions' : 'responses')
      : endpoint.slice(1);
    const upstreamEndpoint = `/${selectedFormat}`;
    const upstreamBody = { ...body, model };
    delete upstreamBody.api_pet_provider_id;
    let upstream;
    let upstreamUrl;
    let lastError;
    for (const base of providerBaseUrls(provider)) {
      upstreamUrl = `${base}${upstreamEndpoint}`;
      upstream = await fetch(upstreamUrl, { method: 'POST', headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(upstreamBody) });
      const contentType = upstream.headers.get('content-type') || '';
      if (upstream.ok && !contentType.toLowerCase().includes('text/html')) break;
      lastError = new Error(`${upstream.status} ${upstream.statusText}${contentType ? ` (${contentType})` : ''}`);
      if (upstream.ok && contentType.toLowerCase().includes('text/html')) continue;
      if (upstream.status === 404 || upstream.status === 405) continue;
      break;
    }
    if (!upstream) throw lastError || new Error('无法连接上游 Provider');
    if ((upstream.headers.get('content-type') || '').toLowerCase().includes('text/html')) {
      throw new Error(`上游返回了网页而不是 API 响应: ${upstreamUrl}`);
    }
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Access-Control-Allow-Origin': '*' });
    let responseBytes = 0;
    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    const responseParts = [];
    if (upstream.body) { for await (const chunk of upstream.body) { responseBytes += chunk.byteLength; if (!contentType.includes('text/event-stream') && responseBytes <= 5 * 1024 * 1024) responseParts.push(Buffer.from(chunk)); res.write(chunk); } }
    res.end();
    const status = !upstream.ok ? 'error' : responseBytes === 0 ? 'empty' : 'success';
    let usage = extractUsage(null, upstream.headers);
    if (responseParts.length) { try { usage = { ...usage, ...extractUsage(JSON.parse(Buffer.concat(responseParts).toString('utf8')), upstream.headers) }; } catch {} }
    recordProviderResult(provider, requestStartedAt, status === 'success', usage);
    mainWindow?.webContents.send('gateway-status', { status, model: requestedModel, target: model, provider: provider.name });
  } catch (e) { recordProviderResult(provider, requestStartedAt, false); writeJson(res, 502, { error: { message: e.message, type: 'api_pet_upstream_error' } }); mainWindow?.webContents.send('gateway-status', { status: 'error', model: requestedModel, target: model, provider: provider.name }); }
}
function startGateway() {
  gateway = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return writeJson(res, 204, {});
    if (!req.url.startsWith('/v1/')) return writeJson(res, 404, { error: 'Use /v1' });
    if (!authOk(req)) return writeJson(res, 401, { error: { message: 'Invalid API Pet key' } });
    if (req.method === 'GET' && req.url === '/v1/models') {
      const models = !state.routingEnabled ? [] : state.routingMode === 'unified' ? [{ id: 'Pet model', object: 'model', owned_by: 'api-pet' }] : allModels();
      return writeJson(res, 200, { object: 'list', data: models });
    }
    const endpoint = req.url === '/v1/chat/completions' ? '/chat/completions' : req.url === '/v1/responses' ? '/responses' : '';
    if (req.method === 'POST' && endpoint) {
      let raw = ''; req.on('data', c => raw += c); req.on('end', async () => { let body; try { body = JSON.parse(raw); } catch { return writeJson(res, 400, { error: { message: 'Invalid JSON' } }); } await proxyChat(req, res, body, endpoint); }); return;
    }
    return writeJson(res, 404, { error: 'Unsupported endpoint' });
  });
  gateway.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      // A previous API Pet instance may still own the port. Keep this UI alive
      // and let clients continue using the already running gateway.
      gateway = null;
      return;
    }
    console.error('API Pet gateway error:', error);
  });
  gateway.listen(PORT, '127.0.0.1');
}
if (gotSingleInstanceLock) app.whenReady().then(() => { writeStartupLog(`API Pet ${app.getVersion()} 启动`); persist(); startGateway(); makeWindow(); createTray(); scheduleBalanceRefresh(); refreshAllBalances().catch(error => writeStartupLog('余额刷新失败', error)); }).catch(error => writeStartupLog('应用启动失败', error));
app.on('window-all-closed', (e) => { if (!isQuitting) e.preventDefault(); });
app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => { tray?.destroy(); gateway?.close(); });

ipcMain.handle('get-state', () => safeState());
ipcMain.handle('get-chat-models', async (_e, { providerId, keyIndex }) => {
  try { return { ok: true, models: await fetchChatModels(providerId, keyIndex) }; }
  catch (error) { return { ok: false, error: String(error?.message || error) }; }
});
ipcMain.handle('import-provider-tokens', async (_e, id) => {
  const input = id && typeof id === 'object' ? id : null;
  const provider = input?.provider ? normalizeProvider(input.provider) : state.providers.find(item => item.id === String(id || ''));
  if (!provider) return { ok: false, error: 'Provider not found' };
  if (provider.balanceAdapter !== 'sub2api') return { ok: false, error: '令牌导入目前支持 Sub2API；New API 请使用连接账户或备用登录令牌' };
  try {
    const tokens = await getProviderAdapter(provider).getApiKeys(provider);
    return { ok: true, tokens };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});
ipcMain.handle('chat-request', async (_e, input) => {
  try { return { ok: true, payload: await directChatRequest(input) }; }
  catch (error) { return { ok: false, error: String(error?.message || error) }; }
});
ipcMain.handle('save-provider', (_e, input) => {
  const existing = input.id ? state.providers.find(p => p.id === input.id) : null;
  const requestUrl = Object.prototype.hasOwnProperty.call(input, 'requestUrl') ? cleanBaseUrl(input.requestUrl) : (existing?.requestUrl || '');
  const tokenRemark = Object.prototype.hasOwnProperty.call(input, 'tokenRemark') ? String(input.tokenRemark || '').trim() : (existing?.tokenRemark || '');
  const apiKeys = Array.isArray(input.apiKeys) ? input.apiKeys : [{ key: String(input.apiKey || '').trim() || existing?.apiKey || '', remark: tokenRemark, enabled: true }];
  const selectedAdapter = input.balanceAdapter === 'neko-api' ? 'sub2api' : (input.balanceAdapter || 'sub2api');
  const record = normalizeProvider({ id: input.id || crypto.randomUUID(), name: String(input.name || '未命名 Provider').trim(), loginUrl: cleanBaseUrl(input.loginUrl) || existing?.loginUrl || existing?.baseUrl || '', requestUrl, apiKeys, apiKey: String(input.apiKey || '').trim() || existing?.apiKey || '', tokenRemark, accountToken: String(input.accountToken || '').trim() || existing?.accountToken || '', accountCookie: String(input.accountCookie || '').trim() || existing?.accountCookie || '', accountUserId: String(input.accountUserId || '').trim() || existing?.accountUserId || '', accountStats: input.accountStats || (existing?.balanceAdapter === selectedAdapter ? existing?.accountStats || null : null), balance: input.balance || null, models: [], status: 'unknown', error: '', balanceAdapter: selectedAdapter, balanceUrl: input.balanceUrl, balanceMethod: input.balanceMethod, balancePath: input.balancePath, remainingPath: input.remainingPath, currency: input.currency, dailyStats: existing?.dailyStats });
  const idx = state.providers.findIndex(p => p.id === record.id);
  if (idx >= 0) {
    record.models = state.providers[idx].models || [];
    record.balance = { ...(state.providers[idx].balance || record.balance), currency: record.currency };
    state.providers[idx] = { ...state.providers[idx], ...record };
  } else state.providers.push(record);
  persist(); return safeState();
});
ipcMain.handle('delete-provider', (_e, id) => { state.providers = state.providers.filter(p => p.id !== id); Object.keys(state.routes).forEach(m => { if (state.routes[m] === id) delete state.routes[m]; }); if (state.unifiedRoute.providerId === id) state.unifiedRoute = { providerId: '', model: '', format: state.unifiedRoute.format || 'responses' }; persist(); return safeState(); });
ipcMain.handle('test-provider', (_e, id) => testProvider(id));
ipcMain.handle('refresh-provider-balance', (_e, id) => queryProviderBalance(id));
ipcMain.handle('refresh-all-balances', () => refreshAllBalances());
ipcMain.handle('get-balance-activity', () => activeBalanceQueries > 0);
ipcMain.handle('set-balance-settings', (_e, settings) => {
  state.balanceSettings = { ...state.balanceSettings, lowThreshold: Math.max(0, Number(settings?.lowThreshold) || 0), refreshMinutes: Math.max(1, Number(settings?.refreshMinutes) || 10) };
  persist(); scheduleBalanceRefresh(); return safeState();
});
ipcMain.handle('set-route', (_e, { model, providerId }) => { state.routes[model] = providerId; persist(); return safeState(); });
ipcMain.handle('set-routing-mode', (_e, mode) => { state.routingMode = mode === 'unified' ? 'unified' : 'model'; persist(); return safeState(); });
ipcMain.handle('set-routing-enabled', (_e, enabled) => { state.routingEnabled = enabled === true; persist(); return safeState(); });
ipcMain.handle('set-unified-route', (_e, route) => {
  const providerId = String(route?.providerId || '');
  const provider = state.providers.find(p => p.id === providerId);
  const model = String(route?.model || '');
  const format = route?.format === 'responses' || route?.format === 'chat/completions'
    ? route.format
    : (state.unifiedRoute?.format === 'chat/completions' ? 'chat/completions' : 'responses');
  state.unifiedRoute = { providerId: provider?.id || '', model: provider && providerModels(provider).includes(model) ? model : '', format };
  persist(); return safeState();
});
ipcMain.handle('quit', () => app.quit());
ipcMain.handle('set-panel-open', (_e, open) => {
  const targetOpen = open === true;
  setPanelWindowPosition(targetOpen);
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.webContents.executeJavaScript(
    `document.querySelector('.app')?.classList.toggle('panel-open', ${targetOpen});`,
    true
  ).then(() => true).catch(() => false);
});
