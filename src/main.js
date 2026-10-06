const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, clipboard, shell, screen, dialog, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const balanceAdapters = require('./providers');
const { currencySettings, rememberCurrency } = require('./provider-currency');
const { requestImage, imageData } = require('./image-generation');
const { detectMime } = require('./image-format');

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
const OPEN_WINDOW_SIZE = { width: 490, height: 650 };
const DEFAULT_PANEL_HEIGHT = 430;
const MIN_PANEL_HEIGHT = 320;
let panelHeight = DEFAULT_PANEL_HEIGHT;
const DEFAULT_PANEL_WIDTH = 450;
const MIN_PANEL_WIDTH = 400;
const MAX_PANEL_WIDTH = 500;
let panelWidth = DEFAULT_PANEL_WIDTH;
function openWindowWidth() { return OPEN_WINDOW_SIZE.width + panelWidth - DEFAULT_PANEL_WIDTH; }
function openPetTop() { return PET_OPEN_TOP + panelHeight - DEFAULT_PANEL_HEIGHT; }
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
  const anchorY = bounds.y + (panelWindowOpen ? openPetTop() : PET_CLOSED_TOP);
  const size = open ? { width: openWindowWidth(), height: OPEN_WINDOW_SIZE.height + panelHeight - DEFAULT_PANEL_HEIGHT } : CLOSED_WINDOW_SIZE;
  const top = open ? openPetTop() : PET_CLOSED_TOP;
  panelWindowOpen = open;
  // Resize and move together so the pet keeps the same screen anchor while the bubble grows upward.
  mainWindow.setBounds({ x: anchorX - PET_LEFT, y: anchorY - top, width: size.width, height: size.height }, false);
  clampWindowToDisplay();
}
function resizePanelHeight(height) {
  if (!panelWindowOpen || !mainWindow || mainWindow.isDestroyed() || !Number.isFinite(height)) return panelHeight;
  const bounds = mainWindow.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const anchorY = bounds.y + openPetTop();
  const maxHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(area.height - 220, anchorY - area.y - 20));
  panelHeight = Math.round(Math.min(Math.max(height, MIN_PANEL_HEIGHT), maxHeight));
  mainWindow.webContents.send('panel-height', panelHeight);
  mainWindow.setBounds({ x: bounds.x, y: anchorY - openPetTop(), width: openWindowWidth(),
    height: OPEN_WINDOW_SIZE.height + panelHeight - DEFAULT_PANEL_HEIGHT }, false);
  return panelHeight;
}
function resizePanelWidth(width) {
  if (!panelWindowOpen || !mainWindow || mainWindow.isDestroyed() || !Number.isFinite(width)) return panelWidth;
  panelWidth = Math.round(Math.min(Math.max(width, MIN_PANEL_WIDTH), MAX_PANEL_WIDTH));
  const bounds = mainWindow.getBounds();
  mainWindow.setBounds({ ...bounds, width: openWindowWidth() }, false);
  clampWindowToDisplay();
  mainWindow.webContents.send('panel-width', panelWidth);
  return panelWidth;
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
    chatFormat: 'responses',
    unifiedRoute: { providerId: '', apiKey: '', model: '', models: [] },
    balanceSettings: { lowThreshold: 5, refreshMinutes: 10 }
  };
}
function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(dataPath(), 'utf8'));
    const oldTarget = saved.virtualModel?.target || '';
    const defaults = defaultState();
    const providers = Array.isArray(saved.providers) ? saved.providers.map(normalizeProvider) : [];
    return {
      ...defaults,
      ...saved,
      routingEnabled: saved.routingEnabled === true,
      routingMode: saved.routingMode || 'model',
      alwaysOnTop: saved.alwaysOnTop !== false,
      balanceSettings: { ...defaults.balanceSettings, ...(saved.balanceSettings || {}) },
      chatFormat: (saved.chatFormat || (saved.routingMode === 'unified' ? saved.unifiedRoute?.format : '')) === 'chat/completions' ? 'chat/completions' : 'responses',
      unifiedRoute: normalizeUnifiedRoute({ ...saved.unifiedRoute, model: saved.unifiedRoute?.model || oldTarget }, providers),
      providers
    };
  }
  catch { return defaultState(); }
}
let state = loadState();
function persist() { fs.mkdirSync(path.dirname(dataPath()), { recursive: true }); fs.writeFileSync(dataPath(), JSON.stringify(state, null, 2)); }
function safeState() { return { ...JSON.parse(JSON.stringify(state)), appVersion: app.getVersion() }; }
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
  const petTop = panelWindowOpen ? openPetTop() : PET_CLOSED_TOP;
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
  const balanceAdapter = provider.balanceAdapter === 'neko-api' ? 'sub2api' : (provider.balanceAdapter || 'none');
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
    balanceAdapter,
    apiKeys,
    apiKey: selectedKey.key,
    tokenRemark: selectedKey.remark,
    accountToken: provider.accountToken || '',
    accountRefreshToken: provider.accountRefreshToken || '',
    accountCookie: provider.accountCookie || '',
    accountUserId: cleanAccountUserId(provider.accountUserId),
    accountSession: cleanSessionToken(provider.accountSession),
    balanceUrl: provider.balanceUrl || '',
    balanceMethod: provider.balanceMethod || 'GET',
    balancePath: provider.balancePath || 'data.balance',
    remainingPath: provider.remainingPath || '',
    ...currencySettings(provider),
    dailyStats: normalizeDailyStats(provider.dailyStats),
    accountStats: balanceAdapter !== 'none' && provider.accountStats && typeof provider.accountStats === 'object' ? { ...provider.accountStats } : null,
    balance: {
      balance: null,
      remaining: null,
      status: 'unknown',
      apiStatus: 'unknown',
      error: '',
      updatedAt: '',
      configured: false,
      ...(provider.balance || {}),
      currency: currencySettings(provider).currency,
      ...(balanceAdapter === 'none' ? { balance: null, remaining: null, status: 'disabled', apiStatus: 'disabled', error: '', updatedAt: '', configured: false } : {})
    }
  };
}
function selectProviderApiKey(provider) {
  const selected = (Array.isArray(provider.apiKeys) ? provider.apiKeys : []).find(item => item?.enabled && item.key) || (Array.isArray(provider.apiKeys) ? provider.apiKeys.find(item => item?.key) : null);
  provider.apiKey = String(selected?.key || provider.apiKey || '').trim();
  provider.tokenRemark = String(selected?.remark || provider.tokenRemark || '');
  return provider.apiKey;
}
function unifiedRouteKey(provider, route = state.unifiedRoute) {
  if (!provider) return '';
  if (!Object.prototype.hasOwnProperty.call(route, 'apiKey')) return selectProviderApiKey(provider);
  return provider.apiKeys?.some(item => item.key === route.apiKey) ? route.apiKey : '';
}
function normalizeUnifiedRoute(route = {}, providers = state.providers) {
  const provider = providers.find(item => item.id === route.providerId);
  const apiKey = unifiedRouteKey(provider, route);
  const models = apiKey ? (Array.isArray(route.models) ? route.models : providerModels(provider)).slice() : [];
  return { providerId: provider?.id || '', apiKey, model: models.includes(route.model) ? route.model : '', models };
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
function modelFetch(url, options = {}) {
  if (typeof process !== 'undefined' && process.versions?.electron && net?.fetch) {
    // Follow the system proxy like account requests, without shared browser cookies.
    return net.fetch(url, { ...options, credentials: 'omit', bypassCustomProtocolHandlers: true });
  }
  return fetch(url, options);
}
async function fetchModels(provider, apiKeyOverride = '') {
  const apiKey = String(apiKeyOverride || selectProviderApiKey(provider)).trim();
  if (!apiKey) throw new Error('该站点没有可用的 API Key');
  if (/\*{3,}/.test(apiKey)) throw new Error('API Key 是带星号的脱敏文本，请导入或粘贴完整令牌');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    let lastError;
    for (const base of providerBaseUrls(provider)) {
      const url = `${base}/models`;
      const res = await modelFetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, signal: controller.signal
      });
      const text = await res.text();
      let body; try { body = JSON.parse(text); } catch { body = {}; }
      if (res.ok && Array.isArray(body.data)) {
        return body.data.map(x => typeof x === 'string' ? x : x.id).filter(Boolean);
      }
      const isHtml = /^\s*(?:<!doctype\s+html|<html\b)/i.test(text);
      const detail = isHtml ? '返回了 HTML 网页，请检查请求地址是否为 API 地址' : body?.error?.message || body?.message || text.slice(0, 200);
      lastError = new Error(`${url}: ${res.status} ${res.statusText}: ${detail}`);
      if (res.status === 401 || res.status === 403) throw lastError;
    }
    throw lastError || new Error('无法获取模型列表');
  } finally { clearTimeout(timer); }
}
async function testProvider(id) {
  const provider = state.providers.find(p => p.id === id);
  if (!provider) throw new Error('Provider not found');
  const apiKey = selectProviderApiKey(provider);
  try {
    const models = await fetchModels(provider, apiKey);
    provider.models = models; provider.status = 'online'; provider.error = ''; provider.lastChecked = new Date().toISOString(); persist();
    if (state.unifiedRoute.providerId === id && unifiedRouteKey(provider) === apiKey) {
      state.unifiedRoute.models = models;
      if (!models.includes(state.unifiedRoute.model)) state.unifiedRoute.model = '';
      persist();
    }
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
  if (provider.balanceAdapter === 'none') return safeState();
  activeBalanceQueries += 1;
  try {
    selectProviderApiKey(provider);
    if (activeBalanceQueries === 1 && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('balance-activity', true);
    const now = new Date().toISOString();
    provider.balance = normalizeProvider(provider).balance;
    try {
      const adapter = getProviderAdapter(provider);
      const result = await adapter.getBalance(provider);
      rememberCurrency(provider, result);
      provider.balance = {
        ...provider.balance,
        balance: result.balance,
        remaining: result.remaining ?? null,
        currency: provider.currency,
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
  for (const provider of state.providers) {
    if (provider.balanceAdapter !== 'none') await queryProviderBalance(provider.id);
  }
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
function sessionIdFromValue(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  if (value.session && typeof value.session === 'object' && value.session.sid) return cleanSessionToken(value.session.sid);
  if (value.sid && typeof value.sid === 'string') return cleanSessionToken(value.sid);
  for (const child of Object.values(value)) {
    const found = sessionIdFromValue(child, seen);
    if (found) return found;
  }
  return '';
}
function tokenFromValue(value, keyHint = '', seen = new Set()) {
  if (value == null) return '';
  if (/refresh/i.test(keyHint)) return '';
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
  const cookieByKey = new Map();
  const collectCookies = async (url) => {
    try {
      const rows = await loginWindow.webContents.session.cookies.get({ url });
      for (const cookie of rows) {
        const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
        cookieByKey.set(key, cookie);
      }
    } catch {}
  };
  await collectCookies(origin);
  await collectCookies(`${origin}/api/user/auth/refresh`);
  if (!cookieByKey.size) {
    try {
      const hostname = new URL(origin).hostname;
      const allCookies = await loginWindow.webContents.session.cookies.get({});
      for (const cookie of allCookies) {
        const domain = String(cookie.domain || '').replace(/^\./, '');
        if (domain === hostname || hostname.endsWith(`.${domain}`)) {
          const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
          cookieByKey.set(key, cookie);
        }
      }
    } catch {}
  }
  let cookies = [...cookieByKey.values()];
  let accountCookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  let accountToken = '';
  let accountRefreshToken = '';
  let accountUserId = '';
  let accountSession = '';
  for (const cookie of cookies) {
    if (/session|refresh/i.test(cookie.name) && !isJwt(cookie.value)) continue;
    if (cookie.name === 'new_api_has_session') continue;
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
        if (/^(refresh_token|refreshToken)$/i.test(entry?.key || '')) {
          accountRefreshToken = cleanSessionToken(entry.value);
          continue;
        }
        const token = tokenFromValue(entry?.value, entry?.key || '');
        if (token && (!accountToken || /^(auth_token|access_token|accessToken)$/i.test(entry?.key || ''))) accountToken = token;
      }
    }
  } catch {}
  // New API keeps the access token in an in-memory auth store and the session
  // cookie is usually HttpOnly. Refresh once from the login page itself so the
  // request has the exact same credentials as the site's own frontend.
  if (cookies.some(cookie => cookie.name === 'new_api_refresh')) {
    try {
      const pageRefresh = await loginWindow.webContents.executeJavaScript(`(async () => {
        if (location.origin !== ${JSON.stringify(origin)}) return null;
        const refresh = async () => {
        try {
          const response = await fetch('/api/user/auth/refresh', {
            method: 'POST',
            credentials: 'include',
            headers: { Accept: 'application/json', 'Cache-Control': 'no-cache, no-store' },
            signal: AbortSignal.timeout(10000)
          });
          const text = await response.text();
          let body = null;
          try { body = JSON.parse(text); } catch {}
          return { ok: response.ok, status: response.status, body };
        } catch (error) {
          return { ok: false, status: 0, body: null };
        }
        };
        return navigator.locks
          ? navigator.locks.request('new-api:auth-refresh', refresh)
          : refresh();
      })()`, true);
      if (pageRefresh?.ok && pageRefresh.body?.success !== false) {
        const bundle = pageRefresh.body?.data ?? pageRefresh.body;
        accountToken = cleanSessionToken(bundle?.access_token || bundle?.accessToken) || accountToken;
        accountSession = sessionIdFromValue(pageRefresh.body);
        accountUserId = accountUserIdFromValue(bundle?.user, 'user') || accountUserId;
        try {
          const refreshedByKey = new Map();
          for (const url of [origin, `${origin}/api/user/auth/refresh`]) {
            try {
              const refreshedCookies = await loginWindow.webContents.session.cookies.get({ url });
              for (const cookie of refreshedCookies) {
                refreshedByKey.set(`${cookie.name}|${cookie.domain}|${cookie.path}`, cookie);
              }
            } catch {}
          }
          if (refreshedByKey.size) accountCookie = [...refreshedByKey.values()].map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
        } catch {}
      }
    } catch {}
  }
  return { accountToken: cleanSessionToken(accountToken), accountRefreshToken, accountCookie, accountUserId: cleanAccountUserId(accountUserId), accountSession: cleanSessionToken(accountSession) };
}
function accountAdapterCandidates(provider) {
  const ids = [provider?.balanceAdapter, 'new-api', 'sub2api', 'aihub'];
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
      const balanceProvider = { ...candidate, _accountProfile: detection.profile };
      const accountData = await adapter.getBalance(balanceProvider);
      return { adapter, accountData, credentials: {
        accountToken: balanceProvider.accountToken,
        accountRefreshToken: balanceProvider.accountRefreshToken,
        accountCookie: balanceProvider.accountCookie,
        accountSession: balanceProvider.accountSession,
        accountUserId: balanceProvider.accountUserId
      } };
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
  if (!['sub2api', 'new-api', 'aihub'].includes(provider.balanceAdapter)) return { ok: false, error: '当前站点类型不支持账户登录', state: safeState() };
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
      capturing = true;
      try {
        const credentials = await readSub2apiCredentials(loginWindow, origin);
        if (settled || loginWindow.isDestroyed()) return;
        const capturedUserId = credentials.accountUserId || provider.accountUserId || '';
        if (!credentials.accountToken && !credentials.accountRefreshToken && !credentials.accountCookie && !capturedUserId) return;
        const credentialFingerprint = `${credentials.accountToken}\n${credentials.accountRefreshToken}\n${credentials.accountCookie}\n${credentials.accountSession}\n${capturedUserId}`;
        if (attemptedCredentials.has(credentialFingerprint)) return;
        attemptedCredentials.add(credentialFingerprint);
        const accountProvider = { ...provider, loginUrl, ...credentials, accountUserId: capturedUserId };
        let accountData;
        let resolvedAdapter = adapter;
        try {
          const detected = await detectAccountAdapter(accountProvider, { ...credentials, accountUserId: capturedUserId });
          resolvedAdapter = detected.adapter;
          accountData = detected.accountData;
          Object.assign(accountProvider, detected.credentials);
        } catch (error) {
          lastCaptureError = String(error?.message || error || '账户接口验证失败');
          if (!loginWindow.isDestroyed()) loginWindow.setTitle(`连接 ${provider.name} 账户 - ${lastCaptureError.slice(0, 80)}`);
          return;
        }
        if (settled || loginWindow.isDestroyed()) return;
        if (resolvedAdapter.id === 'sub2api' && accountProvider.accountRefreshToken
          && accountProvider.accountRefreshToken !== credentials.accountRefreshToken) {
          try {
            const storageCredentials = { origin, token: accountProvider.accountToken, refreshToken: accountProvider.accountRefreshToken };
            await loginWindow.webContents.executeJavaScript(`(() => {
              const credentials = ${JSON.stringify(storageCredentials)};
              if (location.origin !== credentials.origin) return;
              localStorage.setItem('auth_token', credentials.token);
              localStorage.setItem('refresh_token', credentials.refreshToken);
            })()`, true);
          } catch {}
        }
        provider.balanceAdapter = resolvedAdapter.id;
        rememberCurrency(provider, accountData);
        // New API access tokens are short-lived. The adapter may refresh one from
        // the captured session cookie while validating the account, so prefer the
        // refreshed value from accountProvider over the stale captured value.
        provider.accountToken = accountProvider.accountToken || credentials.accountToken || provider.accountToken || '';
        provider.accountRefreshToken = accountProvider.accountRefreshToken || '';
        provider.accountCookie = accountProvider.accountCookie || '';
        provider.accountUserId = accountProvider.accountUserId || '';
        provider.accountSession = accountProvider.accountSession || '';
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
          currency: provider.currency,
          status: balanceStatus(accountData.balance, state.balanceSettings.lowThreshold),
          apiStatus: 'online',
          error: '',
          updatedAt: now,
          configured: true
        };
        provider.balanceStatus = provider.balance.status;
        provider.balanceError = '';
        if (!isDraft) persist();
        const snapshot = { accountToken: provider.accountToken, accountRefreshToken: provider.accountRefreshToken, accountCookie: provider.accountCookie, accountUserId: provider.accountUserId, accountSession: provider.accountSession, accountStats: provider.accountStats, balance: provider.balance, balanceAdapter: provider.balanceAdapter, ...currencySettings(provider) };
        await finish({ ok: true, state: safeState(), ...(isDraft ? { provider: snapshot } : {}) });
        if (!loginWindow.isDestroyed()) loginWindow.close();
      } finally {
        capturing = false;
      }
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
  mainWindow.webContents.on('context-menu', async (_event, params) => {
    const window = mainWindow;
    if (!window || window.isDestroyed()) return;
    if (params.mediaType === 'image') {
      try {
        const x = Number(params.x) || 0;
        const y = Number(params.y) || 0;
        const generated = await window.webContents.executeJavaScript(`Boolean(document.elementFromPoint(${x}, ${y})?.matches('.generated-image img, .image-viewer img'))`);
        if (generated) return;
      } catch { return; }
    }
    if (!window.isDestroyed()) buildAppMenu().popup({ window });
  });
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
    if (!model) model = providerModels(provider || {})[0] || '';
    if (!provider || (requestedKeyIndex == null ? !providerModels(provider).includes(model) : !provider.apiKeys?.[requestedKeyIndex]?.key)) throw new Error(`站点没有模型或 Key：${model || '未选择模型'}`);
  } else if (requestedModel === 'Pet model') {
    model = resolveRequestedModel(requestedModel);
    provider = state.providers.find(item => item.id === state.unifiedRoute?.providerId && (state.unifiedRoute.models || providerModels(item)).includes(model));
  } else {
    provider = findProviderForModel(model);
  }
  if (!provider) throw new Error(`没有找到模型对应的 Provider：${model || '未选择模型'}`);
  const requestedKeyIndex = requestedProviderId && input.apiKeyIndex != null ? Number(input.apiKeyIndex) : null;
  const apiKey = requestedKeyIndex == null
    ? (!requestedProviderId && requestedModel === 'Pet model' ? unifiedRouteKey(provider) : selectProviderApiKey(provider))
    : provider.apiKeys?.[requestedKeyIndex]?.key;
  if (!apiKey) throw new Error('所选 API Key 无效');
  const format = input.format === 'chat/completions' ? 'chat/completions' : 'responses';
  const upstreamBody = format === 'chat/completions'
    ? { model, messages: Array.isArray(input.messages) ? input.messages : [], stream: false }
    : { model, input: Array.isArray(input.input) ? input.input : String(input.input || ''), stream: false };
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
  const requestedProviderId = String(body?.api_pet_provider_id || '').trim();
  const provider = requestedModel === 'Pet model'
    ? state.providers.find(p => p.id === state.unifiedRoute?.providerId && (state.unifiedRoute.models || providerModels(p)).includes(model))
    : requestedProviderId
    ? state.providers.find(p => p.id === requestedProviderId && providerModels(p).includes(model))
    : findProviderForModel(model);
  if (!provider) return writeJson(res, 404, { error: { message: `No provider configured for model: ${model}`, type: 'api_pet_routing_error' } });
  const apiKey = requestedModel === 'Pet model' ? unifiedRouteKey(provider) : selectProviderApiKey(provider);
  if (!apiKey) return writeJson(res, 400, { error: { message: '统一路由所选 Key 无效，请重新选择站点、Key 和模型', type: 'api_pet_key_error' } });
  const requestStartedAt = Date.now();
  recordProviderRequest(provider);
  persist();
  mainWindow?.webContents.send('gateway-status', { status: 'requesting', model: requestedModel, target: model, provider: provider.name });
  try {
    // The client chooses the protocol by calling /chat/completions or /responses.
    const upstreamEndpoint = endpoint;
    const upstreamBody = { ...body, model };
    delete upstreamBody.api_pet_provider_id;
    let upstream;
    let upstreamUrl;
    let lastError;
    for (const base of providerBaseUrls(provider)) {
      upstreamUrl = `${base}${upstreamEndpoint}`;
      upstream = await fetch(upstreamUrl, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(upstreamBody) });
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
ipcMain.handle('detect-provider-currency', async (_e, input = {}) => {
  let provider;
  try {
    const existing = state.providers.find(provider => provider.id === input.id);
    const previousToken = existing?.accountToken;
    const previousRefreshToken = existing?.accountRefreshToken;
    provider = normalizeProvider({ ...existing, ...input, currencyMode: 'auto' });
    const canPersistRotation = existing && provider.loginUrl === existing.loginUrl
      && provider.balanceAdapter === existing.balanceAdapter && provider.accountToken === previousToken
      && provider.accountRefreshToken === previousRefreshToken && provider.accountUserId === existing.accountUserId
      && provider.accountCookie === existing.accountCookie && provider.accountSession === existing.accountSession;
    if (provider.balanceAdapter === 'none') throw new Error('当前站点不查询余额');
    let result;
    try { result = await getProviderAdapter(provider).getBalance(provider); }
    finally {
      if (canPersistRotation && state.providers.includes(existing)
          && existing.loginUrl === provider.loginUrl && existing.balanceAdapter === provider.balanceAdapter
          && existing.accountToken === previousToken && existing.accountRefreshToken === previousRefreshToken
          && (provider.accountToken !== previousToken || provider.accountRefreshToken !== previousRefreshToken)) {
        existing.accountToken = provider.accountToken;
        existing.accountRefreshToken = provider.accountRefreshToken;
        persist();
      }
    }
    return { ok: true, detectedCurrency: result.detectedCurrency || '', currencyDetection: result.currencyDetection || 'failed',
      credentials: { accountToken: provider.accountToken, accountRefreshToken: provider.accountRefreshToken } };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), ...(provider ? {
      credentials: { accountToken: provider.accountToken, accountRefreshToken: provider.accountRefreshToken }
    } : {}) };
  }
});
ipcMain.handle('get-chat-models', async (_e, { providerId, keyIndex }) => {
  try { return { ok: true, models: await fetchChatModels(providerId, keyIndex) }; }
  catch (error) { return { ok: false, error: String(error?.message || error) }; }
});
ipcMain.handle('import-provider-tokens', async (_e, id) => {
  const input = id && typeof id === 'object' ? id : null;
  const provider = input?.provider ? normalizeProvider(input.provider) : state.providers.find(item => item.id === String(id || ''));
  if (!provider) return { ok: false, error: 'Provider not found' };
  if (!['sub2api', 'new-api', 'aihub'].includes(provider.balanceAdapter)) return { ok: false, error: '当前站点类型暂不支持令牌导入' };
  try {
    const tokens = await getProviderAdapter(provider).getApiKeys(provider);
    return { ok: true, tokens, credentials: {
      accountToken: provider.accountToken,
      accountRefreshToken: provider.accountRefreshToken,
      accountCookie: provider.accountCookie,
      accountSession: provider.accountSession,
      accountUserId: provider.accountUserId
    } };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  } finally {
    if (!input?.provider) persist();
  }
});
ipcMain.handle('chat-request', async (_e, input) => {
  try { return { ok: true, payload: await directChatRequest(input) }; }
  catch (error) { return { ok: false, error: String(error?.message || error) }; }
});
ipcMain.handle('set-chat-format', (_e, format) => {
  if (!['responses', 'chat/completions'].includes(format)) throw new Error('不支持的对话请求格式');
  const previous = state.chatFormat;
  state.chatFormat = format;
  try { persist(); }
  catch (error) { state.chatFormat = previous; throw error; }
  return state.chatFormat;
});
ipcMain.handle('generate-images', async (_e, input = {}) => {
  try {
    let model = String(input.model || '').trim();
    const providerId = String(input.providerId || '');
    let provider;
    if (providerId) {
      provider = state.providers.find(item => item.id === providerId);
    } else if (model === 'Pet model') {
      model = resolveRequestedModel(model);
      provider = state.providers.find(item => item.id === state.unifiedRoute?.providerId);
    } else provider = findProviderForModel(model);
    if (!provider || !model) throw new Error('请选择可用的站点、Key 和绘图模型');
    const keyIndex = providerId && input.apiKeyIndex != null ? Number(input.apiKeyIndex) : null;
    const models = !providerId && input.model === 'Pet model' ? state.unifiedRoute.models || providerModels(provider) : providerModels(provider);
    if (keyIndex == null && !models.includes(model)) throw new Error('站点没有所选模型');
    if (keyIndex != null && (!Number.isInteger(keyIndex) || keyIndex < 0)) throw new Error('所选 Key 无效');
    const apiKey = keyIndex == null ? (!providerId && input.model === 'Pet model' ? unifiedRouteKey(provider) : selectProviderApiKey(provider)) : provider.apiKeys?.[keyIndex]?.key;
    if (!apiKey) throw new Error('所选 Key 无效');
    const count = /^sensenova-u1\.5-lite$/i.test(model.split('/').pop()) ? 1 : Math.min(5, Math.max(1, Math.floor(Number(input.count) || 1)));
    const bases = providerBaseUrls(provider);
    const results = await Promise.all(Array.from({ length: count }, async () => {
      const startedAt = Date.now();
      recordProviderRequest(provider);
      mainWindow?.webContents.send('gateway-status', { status: 'requesting', model, provider: provider.name });
      try {
        const image = await requestImage({ bases, apiKey, options: { ...input, model } });
        recordProviderResult(provider, startedAt, true);
        mainWindow?.webContents.send('gateway-status', { status: 'success', model, provider: provider.name });
        // Keep a local copy in the chat so expiring URLs remain viewable and saveable.
        try {
          const data = await imageData(image.url);
          image.url = `data:${data.mimeType};base64,${data.bytes.toString('base64')}`;
        } catch (error) { image.warning = `图片已生成，下载失败，可稍后点击保存重试：${error.message}`; }
        return { image };
      } catch (error) {
        recordProviderResult(provider, startedAt, false);
        mainWindow?.webContents.send('gateway-status', { status: 'error', model, provider: provider.name });
        return { error: error.message || '绘图失败' };
      } finally { persist(); }
    }));
    const images = results.flatMap(result => result.image ? [result.image] : []);
    const errors = results.flatMap(result => result.error ? [result.error] : []);
    return { ok: images.length > 0, images, errors, error: errors.join('；') };
  } catch (error) { return { ok: false, error: error.message || '绘图失败' }; }
});
ipcMain.handle('save-generated-image', async (_e, url) => {
  try {
    const data = await imageData(url);
    const extension = data.mimeType.split('/')[1].replace('jpeg', 'jpg');
    const result = await dialog.showSaveDialog(mainWindow, { title: '保存生成图片', defaultPath: `API-Pet-${Date.now()}.${extension}`, filters: [{ name: '图片', extensions: [extension] }] });
    if (result.canceled || !result.filePath) return { ok: true, canceled: true };
    await fs.promises.writeFile(result.filePath, data.bytes);
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message || '保存失败' }; }
});
ipcMain.handle('show-generated-image-menu', (event, url) => new Promise(resolve => {
  let selected = false;
  const menu = Menu.buildFromTemplate([{
    label: '复制',
    click: async () => {
      selected = true;
      try {
        const data = await imageData(url);
        const image = nativeImage.createFromBuffer(data.bytes);
        if (image.isEmpty()) throw new Error('图片解码失败');
        clipboard.writeImage(image);
        resolve({ ok: true, copied: true });
      } catch (error) { resolve({ ok: false, error: error.message || '复制失败' }); }
    }
  }]);
  menu.popup({ window: BrowserWindow.fromWebContents(event.sender) || mainWindow,
    callback: () => { if (!selected) resolve({ ok: true, canceled: true }); } });
}));
ipcMain.handle('show-inline-image-menu', (event, input) => new Promise(resolve => {
  let selected = false;
  let bytes;
  try { bytes = input?.bytes ? Buffer.from(input.bytes) : Buffer.alloc(0); }
  catch { return resolve({ ok: false, error: '图片数据无效' }); }
  const mimeType = detectMime(bytes);
  if (!mimeType || !bytes.length || bytes.length > 40 * 1024 * 1024) return resolve({ ok: false, error: '图片数据无效或超过 40 MB' });
  const save = async () => {
    const extension = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender) || mainWindow, {
      title: '保存图片', defaultPath: `API-Pet-${Date.now()}.${extension}`,
      filters: [{ name: '图片', extensions: [extension] }]
    });
    if (result.canceled || !result.filePath) return { ok: true, canceled: true };
    await fs.promises.writeFile(result.filePath, bytes);
    return { ok: true, saved: true };
  };
  const menu = Menu.buildFromTemplate([
    { label: '保存图片', click: async () => { selected = true; try { resolve(await save()); } catch (error) { resolve({ ok: false, error: error.message || '保存失败' }); } } },
    { label: '复制', click: async () => {
      selected = true;
      try {
        const native = nativeImage.createFromBuffer(bytes);
        if (native.isEmpty()) throw new Error('图片解码失败');
        clipboard.writeImage(native);
        resolve({ ok: true, copied: true });
      } catch (error) { resolve({ ok: false, error: error.message || '复制失败' }); }
    } }
  ]);
  menu.popup({ window: BrowserWindow.fromWebContents(event.sender) || mainWindow,
    callback: () => { if (!selected) resolve({ ok: true, canceled: true }); } });
}));
ipcMain.handle('save-provider', (_e, input) => {
  const existing = input.id ? state.providers.find(p => p.id === input.id) : null;
  const requestUrl = Object.prototype.hasOwnProperty.call(input, 'requestUrl') ? cleanBaseUrl(input.requestUrl) : (existing?.requestUrl || '');
  const tokenRemark = Object.prototype.hasOwnProperty.call(input, 'tokenRemark') ? String(input.tokenRemark || '').trim() : (existing?.tokenRemark || '');
  const apiKeys = Array.isArray(input.apiKeys) ? input.apiKeys : [{ key: String(input.apiKey || '').trim() || existing?.apiKey || '', remark: tokenRemark, enabled: true }];
  const selectedAdapter = input.balanceAdapter === 'neko-api' ? 'sub2api' : (input.balanceAdapter || 'none');
  const record = normalizeProvider({ id: input.id || crypto.randomUUID(), name: String(input.name || '未命名 Provider').trim(), loginUrl: cleanBaseUrl(input.loginUrl) || existing?.loginUrl || existing?.baseUrl || '', requestUrl, apiKeys, apiKey: String(input.apiKey || '').trim() || existing?.apiKey || '', tokenRemark, accountToken: String(input.accountToken || '').trim() || existing?.accountToken || '', accountCookie: String(input.accountCookie || '').trim() || existing?.accountCookie || '', accountSession: String(input.accountSession || '').trim() || existing?.accountSession || '', accountUserId: String(input.accountUserId || '').trim() || existing?.accountUserId || '', accountStats: input.accountStats || (existing?.balanceAdapter === selectedAdapter ? existing?.accountStats || null : null), balance: input.balance || null, models: [], status: 'unknown', error: '', balanceAdapter: selectedAdapter, balanceUrl: input.balanceUrl, balanceMethod: input.balanceMethod, balancePath: input.balancePath, remainingPath: input.remainingPath, currency: input.currency, currencyMode: input.currencyMode || (existing ? currencySettings(existing).currencyMode : undefined), detectedCurrency: input.detectedCurrency ?? existing?.detectedCurrency, currencyDetection: input.currencyDetection ?? existing?.currencyDetection, dailyStats: existing?.dailyStats });
  record.accountRefreshToken = cleanSessionToken(input.accountRefreshToken || existing?.accountRefreshToken);
  const idx = state.providers.findIndex(p => p.id === record.id);
  if (idx >= 0) {
    record.models = state.providers[idx].models || [];
    if (selectedAdapter !== 'none') record.balance = { ...(input.balance || state.providers[idx].balance || record.balance), currency: record.currency };
    state.providers[idx] = { ...state.providers[idx], ...record };
  } else state.providers.push(record);
  if (state.unifiedRoute.providerId === record.id) state.unifiedRoute = normalizeUnifiedRoute(state.unifiedRoute);
  persist(); return safeState();
});
ipcMain.handle('delete-provider', (_e, id) => { state.providers = state.providers.filter(p => p.id !== id); Object.keys(state.routes).forEach(m => { if (state.routes[m] === id) delete state.routes[m]; }); if (state.unifiedRoute.providerId === id) state.unifiedRoute = { providerId: '', apiKey: '', model: '', models: [] }; persist(); return safeState(); });
ipcMain.handle('test-provider', (_e, id) => testProvider(id));
ipcMain.handle('move-provider', (_e, input) => {
  const index = state.providers.findIndex(provider => provider.id === input?.id);
  const target = Number.isInteger(input?.targetIndex) ? input.targetIndex : -1;
  if (index < 0 || target < 0 || target >= state.providers.length || target === index) return safeState();
  const [provider] = state.providers.splice(index, 1);
  state.providers.splice(target, 0, provider);
  persist();
  return safeState();
});
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
ipcMain.handle('set-unified-route', async (_e, route) => {
  const providerId = String(route?.providerId || '');
  const provider = state.providers.find(p => p.id === providerId);
  if (Object.prototype.hasOwnProperty.call(route, 'keyIndex')) {
    const index = route.keyIndex === '' || route.keyIndex == null ? -1 : Number(route.keyIndex);
    const apiKey = Number.isInteger(index) && index >= 0 ? provider?.apiKeys?.[index]?.key || '' : '';
    const target = { providerId: provider?.id || '', apiKey, model: '', models: [] };
    state.unifiedRoute = target;
    persist();
    if (apiKey) {
      const models = await fetchModels(provider, apiKey);
      if (state.unifiedRoute === target && unifiedRouteKey(state.providers.find(item => item.id === providerId), target)) {
        target.models = models;
        persist();
      }
    }
    return safeState();
  }
  const current = state.unifiedRoute;
  if (provider?.id === current.providerId && Object.prototype.hasOwnProperty.call(route, 'model')) {
    state.unifiedRoute = { ...current, model: unifiedRouteKey(provider) && (current.models || providerModels(provider)).includes(route.model) ? String(route.model) : '' };
  } else state.unifiedRoute = { providerId: provider?.id || '', apiKey: '', model: '', models: [] };
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
ipcMain.handle('resize-panel-height', (_e, height) => resizePanelHeight(height));
ipcMain.handle('resize-panel-width', (_e, width) => resizePanelWidth(width));
