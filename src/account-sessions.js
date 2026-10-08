const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { accountContext } = require('./account-session-context');

const credentialKeys = ['accountToken', 'accountRefreshToken', 'accountCookie', 'accountUserId', 'accountSession'];
const credentialsOf = provider => Object.fromEntries(credentialKeys.map(key => [key, provider[key] || '']));
const tokenHash = token => crypto.createHash('sha256').update(String(token)).digest('hex');
function originOf(provider) {
  try {
    const url = new URL(provider.loginUrl || provider.requestUrl || provider.baseUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : '';
  } catch { return ''; }
}
function partitionFor(provider) {
  if (!provider.accountBrowserId) provider.accountBrowserId = provider.id || crypto.randomUUID();
  const key = crypto.createHash('sha256').update(`${provider.accountBrowserId}\n${originOf(provider)}`).digest('hex').slice(0, 32);
  return `persist:api-pet-account-${key}`;
}

class AccountSessions {
  constructor({ session, BrowserWindow, ipcMain, dataDirectory, readCredentials, onChanged = () => {} }) {
    Object.assign(this, { session, BrowserWindow, dataDirectory, readCredentials, onChanged });
    this.entries = new Map();
    ipcMain?.on('account-session-bootstrap', (event, refreshToken) => {
      event.returnValue = this.bootstrap(event, refreshToken);
    });
  }

  bootstrap(event, refreshToken) {
    for (const entry of this.entries.values()) {
      const window = [...entry.windows].find(item => !item.isDestroyed() && item.webContents === event.sender);
      if (!window || event.senderFrame !== event.sender.mainFrame
        || originOf({ loginUrl: event.senderFrame.url }) !== entry.origin) continue;
      const provider = entry.windowProviders.get(window);
      const credentials = entry.credentials || credentialsOf(provider);
      if (provider.balanceAdapter !== 'sub2api' || !credentials.accountRefreshToken) return null;
      if (refreshToken && tokenHash(refreshToken) !== entry.browserRefreshHash) return null;
      entry.browserRefreshHash = tokenHash(credentials.accountRefreshToken);
      this.writeMarker(entry);
      return { token: credentials.accountToken, refreshToken: credentials.accountRefreshToken };
    }
    return null;
  }

  writeMarker(entry) {
    fs.writeFileSync(entry.marker, JSON.stringify({ migrated: true, browserRefreshHash: entry.browserRefreshHash || '' }));
  }

  entry(provider) {
    const partition = partitionFor(provider);
    if (!this.entries.has(partition)) {
      this.entries.set(partition, { partition, origin: originOf(provider), session: this.session.fromPartition(partition),
        windows: new Set(), windowProviders: new Map(), queue: Promise.resolve(), seen: new Set() });
    }
    return this.entries.get(partition);
  }

  enqueue(entry, callback) {
    const pending = entry.queue.then(callback);
    entry.queue = pending.catch(() => {});
    return pending;
  }

  async prepare(provider) {
    const entry = this.entry(provider);
    if (!entry.initializing) entry.initializing = this.migrate(entry, provider);
    await entry.initializing;
    return entry;
  }

  async migrate(entry, provider) {
    const directory = path.join(this.dataDirectory(), 'account-sessions');
    const marker = path.join(directory, `${entry.partition.slice('persist:'.length)}.json`);
    entry.marker = marker;
    if (fs.existsSync(marker)) {
      try { entry.browserRefreshHash = JSON.parse(fs.readFileSync(marker, 'utf8')).browserRefreshHash || ''; } catch {}
      return;
    }
    entry.browserRefreshHash = provider.accountRefreshToken ? tokenHash(provider.accountRefreshToken) : '';
    const saved = new Map(String(provider.accountCookie || '').split(';').map(pair => {
      const index = pair.indexOf('=');
      return index > 0 ? [pair.slice(0, index).trim(), pair.slice(index + 1).trim()] : ['', ''];
    }).filter(([name]) => name));
    const existing = await entry.session.cookies.get({ url: entry.origin });
    if (!existing.length && saved.size) {
      // Retain expiry, HttpOnly, Secure and path information from the old session
      // only when the cookie matches this provider's saved account.
      const legacy = await this.session.defaultSession.cookies.get({});
      const hostname = new URL(entry.origin).hostname;
      const copied = new Set();
      for (const cookie of legacy) {
        const domain = cookie.domain.replace(/^\./, '');
        if (!(hostname === domain || hostname.endsWith(`.${domain}`)) || saved.get(cookie.name) !== cookie.value) continue;
        const { hostOnly, session, ...details } = cookie;
        if (hostOnly) delete details.domain;
        await entry.session.cookies.set({ ...details, url: `${entry.origin}${cookie.path || '/'}` });
        copied.add(cookie.name);
      }
      for (const [name, value] of saved) {
        if (!copied.has(name)) await entry.session.cookies.set({ url: entry.origin, name, value });
      }
      await entry.session.cookies.flushStore();
    }
    fs.mkdirSync(directory, { recursive: true });
    this.writeMarker(entry);
  }

  liveWindow(entry) {
    return [...entry.windows].reverse().find(window => !window.isDestroyed()
      && originOf({ loginUrl: window.webContents.getURL() }) === entry.origin);
  }

  restore(provider) {
    const entry = this.entries.get(partitionFor(provider));
    if (!entry?.credentials) return;
    const latest = entry.credentials;
    const known = entry.seen.has(JSON.stringify(credentialsOf(provider))) || [...entry.seen].some(snapshot => {
      const previous = JSON.parse(snapshot);
      return provider.accountToken && previous.accountToken === provider.accountToken
        && previous.accountUserId === (provider.accountUserId || '') && previous.accountUserId === latest.accountUserId
        && [previous.accountRefreshToken, latest.accountRefreshToken].includes(provider.accountRefreshToken || '');
    });
    if (known) Object.assign(provider, latest);
  }

  async sync(entry, provider, window = this.liveWindow(entry)) {
    const before = JSON.stringify(credentialsOf(provider));
    if (window) {
      const captured = await this.readCredentials(window, entry.origin, { refresh: false });
      if (captured.accountRefreshToken) {
        const hash = tokenHash(captured.accountRefreshToken);
        if (entry.browserRefreshHash !== hash) { entry.browserRefreshHash = hash; this.writeMarker(entry); }
      }
      for (const key of credentialKeys) {
        // In-memory tokens are not always visible to the reader. Keep the last
        // validated token in that case; cookies come from the authoritative jar.
        if (key !== 'accountCookie' && captured[key]) provider[key] = captured[key];
      }
    }
    const byKey = new Map();
    for (const url of [entry.origin, `${entry.origin}/api/user/auth/refresh`, `${entry.origin}/api/v1/auth/refresh`]) {
      for (const cookie of await entry.session.cookies.get({ url })) {
        byKey.set(`${cookie.name}|${cookie.domain}|${cookie.path}`, cookie);
      }
    }
    provider.accountCookie = [...byKey.values()].map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    const after = JSON.stringify(credentialsOf(provider));
    if (before !== after) this.onChanged(provider, before);
    entry.seen.add(before);
    entry.seen.add(after);
    while (entry.seen.size > 64) entry.seen.delete(entry.seen.values().next().value);
    entry.credentials = credentialsOf(provider);
  }

  attach(provider, window) {
    const entry = this.entry(provider);
    entry.windows.add(window);
    entry.windowProviders.set(window, provider);
    const observe = async () => {
      if (window.isDestroyed() || originOf({ loginUrl: window.webContents.getURL() }) !== entry.origin) return;
      // Observe refresh responses without consuming the response used by the
      // site's own frontend. New API may otherwise keep access tokens in memory.
      await window.webContents.executeJavaScript(`(() => {
        if (window.__apiPetAuthObserver) return;
        window.__apiPetAuthObserver = true;
        const original = window.fetch;
        window.fetch = async function(...args) {
          const response = await original.apply(this, args);
          try {
            const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href);
            if (url.origin === location.origin && /\\/auth\\/refresh$/.test(url.pathname) && response.ok) {
              const body = await response.clone().json();
              if (body.success !== false && (body.code == null || body.code === 0)) window.__apiPetAuth = body.data ?? body;
            }
          } catch {}
          return response;
        };
      })()`, true).catch(() => {});
    };
    window.webContents.on('did-finish-load', observe);
    window.once('closed', () => { entry.windows.delete(window); entry.windowProviders.delete(window); });
  }

  async writeTokens(entry, provider) {
    const window = this.liveWindow(entry);
    if (!window || provider.balanceAdapter !== 'sub2api') return;
    const bundle = { origin: entry.origin, token: provider.accountToken, refreshToken: provider.accountRefreshToken,
      previousRefreshToken: entry.credentials?.accountRefreshToken || '' };
    await window.webContents.executeJavaScript(`(() => {
      const credentials = ${JSON.stringify(bundle)};
      if (location.origin !== credentials.origin) return;
      const currentRefreshToken = localStorage.getItem('refresh_token');
      if (currentRefreshToken && currentRefreshToken !== credentials.previousRefreshToken
        && currentRefreshToken !== credentials.refreshToken) return;
      if (credentials.token) localStorage.setItem('auth_token', credentials.token);
      if (credentials.refreshToken) localStorage.setItem('refresh_token', credentials.refreshToken);
    })()`, true).catch(() => {});
  }

  async fetch(entry, url, options) {
    if (new URL(url).origin !== entry.origin) throw new Error('账户请求地址与登录站点不一致');
    const headers = new Headers(options.headers);
    headers.delete('Cookie');
    const window = this.liveWindow(entry);
    const pathname = new URL(url).pathname;
    if (window && options.method === 'POST' && ['/api/user/auth/refresh', '/api/v1/auth/refresh'].includes(pathname)) {
      // New API uses this same lock in its frontend. Read current browser cookies
      // inside the lock, rather than sending a stale cookie snapshot.
      if (options.signal?.aborted) throw options.signal.reason;
      const request = { url: String(url), origin: entry.origin, headers: Object.fromEntries(headers), body: options.body };
      const result = await window.webContents.executeJavaScript(`(async () => {
        const request = ${JSON.stringify(request)};
        if (location.origin !== request.origin) throw new Error('登录页面已离开原站点');
        const refresh = async () => {
          if (request.url.endsWith('/api/v1/auth/refresh') && request.body) {
            const latest = localStorage.getItem('refresh_token');
            if (latest) request.body = JSON.stringify({ ...JSON.parse(request.body), refresh_token: latest });
          }
          const response = await fetch(request.url, { method: 'POST', headers: request.headers, body: request.body,
            credentials: 'include', signal: AbortSignal.timeout(10000) });
          const text = await response.text();
          if (response.ok && request.url.endsWith('/api/v1/auth/refresh')) {
            try {
              const body = JSON.parse(text), data = body.data ?? body;
              if (body.success !== false && (body.code == null || body.code === 0)) {
                if (data.access_token || data.accessToken) localStorage.setItem('auth_token', data.access_token || data.accessToken);
                if (data.refresh_token || data.refreshToken) localStorage.setItem('refresh_token', data.refresh_token || data.refreshToken);
              }
            } catch {}
          }
          return { status: response.status, statusText: response.statusText, headers: [...response.headers], text };
        };
        return navigator.locks ? navigator.locks.request('new-api:auth-refresh', { signal: AbortSignal.timeout(10000) }, refresh) : refresh();
      })()`, true);
      return new Response(result.text, { status: result.status, statusText: result.statusText, headers: result.headers });
    }
    return entry.session.fetch(url, { ...options, headers: Object.fromEntries(headers), credentials: 'include', bypassCustomProtocolHandlers: true });
  }

  async recover(entry, provider) {
    let window = this.liveWindow(entry);
    const owned = !window;
    if (owned) {
      window = new this.BrowserWindow({ show: false, webPreferences: { partition: entry.partition,
        preload: path.join(__dirname, 'account-preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      this.attach(provider, window);
    }
    let timeout;
    try {
      await Promise.race([
        (async () => {
          if (owned) await window.loadURL(provider.loginUrl || entry.origin);
          const captured = await this.readCredentials(window, entry.origin);
          for (const key of credentialKeys) if (captured[key]) provider[key] = captured[key];
          await this.sync(entry, provider, window);
        })(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('登录会话恢复超时，请重新连接账户')), 15000); })
      ]);
    } finally {
      clearTimeout(timeout);
      if (owned && !window.isDestroyed()) window.destroy();
    }
  }

  async run(provider, callback) {
    if (!originOf(provider)) return callback();
    const entry = await this.prepare(provider);
    return this.enqueue(entry, () => accountContext.run({ fetch: (url, options) => this.fetch(entry, url, options) }, async () => {
      this.restore(provider);
      const before = JSON.stringify(credentialsOf(provider));
      await this.sync(entry, provider);
      try {
        return await callback();
      } catch (error) {
        // Retry only confirmed authentication failures. Offline, rate-limit and
        // permission errors must not turn into misleading "login expired" errors.
        if (Number(error.status) !== 401) throw error;
        await this.recover(entry, provider);
        return await callback();
      } finally {
        await this.writeTokens(entry, provider);
        await this.sync(entry, provider);
        await entry.session.cookies.flushStore();
        await entry.session.flushStorageData();
        if (before !== JSON.stringify(credentialsOf(provider))) this.onChanged(provider, before);
      }
    }));
  }
}

module.exports = { AccountSessions, partitionFor, originOf, credentialsOf };
