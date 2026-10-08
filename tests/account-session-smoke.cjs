// Run in two separate Electron processes with the same temporary directory:
// electron tests/account-session-smoke.cjs <directory> write
// electron tests/account-session-smoke.cjs <directory> read
const { app, BrowserWindow, session, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { AccountSessions, partitionFor } = require('../src/account-sessions');
const { configureAccountSessions } = require('../src/account-session-context');
const directory = path.resolve(process.argv[2]);
const phase = process.argv[3];
app.setPath('userData', path.join(directory, 'browser'));
app.on('window-all-closed', () => {});
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const context = vm.createContext({ URL });
vm.runInContext(source.slice(source.indexOf('function isJwt('), source.indexOf('function accountAdapterCandidates(')), context);
let server;
let window;

app.whenReady().then(async () => {
  const file = path.join(directory, 'fixture.json');
  const saved = phase === 'read' ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const auth = saved?.auth || { token: 'server-access-token-0001', refresh: 'server-refresh-token-0001', cookie: 'cookie-0001', generation: 1 };
  let refreshes = 0;
  server = http.createServer(async (req, res) => {
    const json = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': `session=${auth.cookie}; Path=/; HttpOnly; Max-Age=2592000` });
      res.end(`<script>localStorage.setItem('auth_token',${JSON.stringify(auth.token)});localStorage.setItem('refresh_token',${JSON.stringify(auth.refresh)});localStorage.setItem('auth_user','{"id":17}');</script>Test account`);
      return;
    }
    if (req.url === '/api/v1/auth/refresh') {
      let text = '';
      for await (const chunk of req) text += chunk;
      assert.match(req.headers.cookie || '', new RegExp(`session=${auth.cookie}`));
      if (JSON.parse(text).refresh_token !== auth.refresh) return json({ message: 'refresh token expired' }, 401);
      refreshes += 1; auth.generation += 1;
      auth.token = `server-access-token-000${auth.generation}`;
      auth.refresh = `server-refresh-token-000${auth.generation}`;
      auth.cookie = `cookie-000${auth.generation}`;
      res.setHeader('Set-Cookie', `session=${auth.cookie}; Path=/; HttpOnly; Max-Age=2592000`);
      return json({ code: 0, data: { access_token: auth.token, refresh_token: auth.refresh } });
    }
    if (req.headers.authorization !== `Bearer ${auth.token}`) return json({ message: 'access expired' }, 401);
    assert.match(req.headers.cookie || '', new RegExp(`session=${auth.cookie}`));
    if (req.url.startsWith('/api/v1/keys')) return json({ code: 0, data: { total: 1, items: [{ key: 'sk-test-only', name: 'fixture' }] } });
    if (req.url === '/api/v1/user/profile') return json({ code: 0, data: { id: 17, balance: 1.25 } });
    return json({ code: 0, data: { today_requests: 2 } });
  });
  await new Promise(resolve => server.listen(saved?.port || 0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const record = saved?.provider || { id: 'smoke-account', loginUrl: `${origin}/login`, balanceAdapter: 'sub2api' };
  const manager = new AccountSessions({ session, BrowserWindow, ipcMain, dataDirectory: () => app.getPath('userData'),
    readCredentials: context.readSub2apiCredentials });
  configureAccountSessions(manager);
  const adapter = require('../src/providers').sub2api;
  const entry = await manager.prepare(record);
  if (phase === 'write') {
    window = new BrowserWindow({ show: false, webPreferences: { partition: entry.partition, preload: path.join(__dirname, '../src/account-preload.js'), contextIsolation: true, nodeIntegration: false } });
    manager.attach(record, window);
    await window.loadURL(record.loginUrl);
    await manager.run(record, async () => {});
    assert.equal(record.accountToken, auth.token);
    // Rotate while the page stays open; browser storage and provider agree.
    record.accountToken = 'expired-access-token';
    await window.webContents.executeJavaScript("localStorage.setItem('auth_token','expired-access-token')");
    const [balance, keys] = await Promise.all([adapter.getBalance(record), adapter.getApiKeys({ ...record })]);
    assert.equal(balance.balance, 1.25);
    assert.equal(keys.length, 1);
    assert.equal(refreshes, 1);
    assert.equal(await window.webContents.executeJavaScript("localStorage.getItem('refresh_token')"), auth.refresh);
    // The site's own refresh can finish while a backend operation is pending.
    // Final synchronization must retain that newer browser token.
    await manager.run(record, async () => {
      await window.webContents.executeJavaScript(`(async () => {
        const response = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: localStorage.getItem('refresh_token') }) });
        const { data } = await response.json();
        localStorage.setItem('auth_token', data.access_token);
        localStorage.setItem('refresh_token', data.refresh_token);
      })()`);
    });
    assert.equal(record.accountToken, auth.token);
    assert.equal(record.accountRefreshToken, auth.refresh);
    assert.equal(await window.webContents.executeJavaScript("localStorage.getItem('refresh_token')"), auth.refresh);
    window.destroy();
    // Closed-browser renewal uses Chromium's persistent cookie jar too.
    auth.token = 'server-invalidated-access-token';
    await adapter.getApiKeys(record);
    assert.equal(refreshes, 3);
    assert.equal(record.accountToken, auth.token);
    assert.match(record.accountCookie, new RegExp(`session=${auth.cookie}`));
    fs.writeFileSync(file, JSON.stringify({ provider: record, auth, port }));
  } else {
    assert.equal(entry.partition, partitionFor(saved.provider));
    assert.ok((await entry.session.cookies.get({ url: origin })).some(cookie => cookie.name === 'session' && cookie.value === auth.cookie));
    window = new BrowserWindow({ show: false, webPreferences: { partition: entry.partition, preload: path.join(__dirname, '../src/account-preload.js') } });
    manager.attach(record, window);
    await window.loadURL(`${origin}/storage-check`);
    assert.equal(await window.webContents.executeJavaScript("localStorage.getItem('refresh_token')"), auth.refresh);
    window.destroy();
    assert.equal((await adapter.getBalance(record)).balance, 1.25);
    // A missing refresh credential can recover via the saved site session.
    record.accountToken = 'expired-access-token'; record.accountRefreshToken = '';
    await adapter.getApiKeys(record);
    assert.equal(record.accountToken, auth.token);
    assert.equal(record.accountRefreshToken, auth.refresh);
  }
  await entry.session.cookies.flushStore();
  entry.session.flushStorageData();
  fs.writeFileSync(path.join(directory, `${phase}-result.json`), JSON.stringify({ ok: true, refreshes }));
  console.log(`Account session ${phase}: PASS`);
  await new Promise(resolve => server.close(resolve));
  app.exit(0);
}).catch(error => {
  console.error(error);
  if (window && !window.isDestroyed()) window.destroy();
  if (server) server.close();
  app.exit(1);
});
