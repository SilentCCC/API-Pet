const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { AccountSessions, partitionFor } = require('../src/account-sessions');
const { accountContext } = require('../src/account-session-context');

function fixture(t, { readCredentials = async () => ({}), fetch = async () => new Response('ok'), legacy = [] } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'api-pet-session-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const jars = new Map();
  const changes = [];
  let windowCount = 0;
  class Window extends EventEmitter {
    constructor(options) {
      super(); windowCount += 1; this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.getURL = () => this.url || '';
      this.webContents.executeJavaScript = async () => {};
    }
    async loadURL(url) { this.url = url; this.webContents.emit('did-finish-load'); }
    isDestroyed() { return !!this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const session = { defaultSession: { cookies: { get: async () => legacy } }, fromPartition(partition) {
    if (!jars.has(partition)) {
      const rows = [];
      jars.set(partition, { rows, fetch, cookies: {
        get: async ({ url } = {}) => rows.filter(cookie => !url || new URL(url).pathname.startsWith(cookie.path || '/')),
        set: async cookie => {
          const existing = rows.findIndex(row => row.name === cookie.name && row.path === (cookie.path || '/'));
          const value = { domain: new URL(cookie.url).hostname, path: '/', ...cookie };
          if (existing >= 0) rows[existing] = value; else rows.push(value);
        }, flushStore: async () => {}
      }, flushStorageData() {} });
    }
    return jars.get(partition);
  } };
  const manager = new AccountSessions({ session, BrowserWindow: Window, dataDirectory: () => directory,
    readCredentials, onChanged: value => changes.push({ ...value }) });
  return { manager, jars, changes, Window, session, directory, windowCount: () => windowCount };
}

const provider = () => ({ id: 'site-a', loginUrl: 'https://site.test/login', balanceAdapter: 'sub2api',
  accountToken: 'expired-access-token', accountRefreshToken: 'saved-refresh-token', accountCookie: 'session=saved' });

test('persistent partitions isolate providers and origins and survive saving a new draft', () => {
  const record = provider();
  assert.match(partitionFor(record), /^persist:api-pet-account-/);
  assert.equal(partitionFor(record), partitionFor({ ...record }));
  assert.notEqual(partitionFor(record), partitionFor({ ...provider(), id: 'site-b' }));
  assert.notEqual(partitionFor(record), partitionFor({ ...record, loginUrl: 'https://other.test' }));
  const draft = { ...provider(), id: undefined };
  const partition = partitionFor(draft);
  assert.equal(partitionFor({ ...draft, id: 'new-saved-id' }), partition);
});

test('legacy migration retains matching cookie metadata and does not copy another account', async t => {
  const f = fixture(t, { legacy: [
    { name: 'session', value: 'saved', domain: 'site.test', path: '/', httpOnly: true, secure: true, expirationDate: 2000000000, hostOnly: true },
    { name: 'other_account', value: 'secret', domain: 'site.test', path: '/' }
  ] });
  const record = provider();
  const entry = await f.manager.prepare(record);
  assert.equal(entry.session.rows.length, 1);
  assert.equal(entry.session.rows[0].httpOnly, true);
  assert.equal(entry.session.rows[0].expirationDate, 2000000000);
  entry.session.rows.length = 0; // Logout or server expiry must not restore saved cookies on restart.
  const restarted = new AccountSessions({ session: f.session, BrowserWindow: f.Window,
    dataDirectory: () => f.directory, readCredentials: async () => ({}) });
  assert.equal((await restarted.prepare(record)).session.rows.length, 0);
});

test('account requests share the scoped browser cookie jar and persist rotated path cookies', async t => {
  let entry;
  const f = fixture(t, { fetch: async (url, options) => {
    assert.equal(options.credentials, 'include');
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.authorization, 'Bearer account-token');
    await entry.session.cookies.set({ url: 'https://site.test/api/v1/auth/refresh', path: '/api/v1/auth/refresh', name: 'refresh', value: 'rotated' });
    return new Response('ok');
  } });
  const record = provider();
  entry = await f.manager.prepare(record);
  await f.manager.run(record, async () => {
    const response = await accountContext.getStore().fetch('https://site.test/api/v1/auth/refresh', {
      headers: { Cookie: 'session=stale', Authorization: 'Bearer account-token' }
    });
    assert.equal(await response.text(), 'ok');
  });
  assert.match(record.accountCookie, /refresh=rotated/);
  assert.ok(f.changes.length);
  await assert.rejects(f.manager.run(record, () => accountContext.getStore().fetch('https://other.test', {})), /不一致/);
});

test('overlapping requests and stale provider copies use one account queue and latest credentials', async t => {
  const f = fixture(t);
  const record = provider(), stale = { ...record };
  const order = [];
  const first = f.manager.run(record, async () => {
    order.push('first');
    await new Promise(setImmediate);
    record.accountToken = 'rotated-access-token';
    record.accountRefreshToken = 'rotated-refresh-token';
    order.push('rotated');
  });
  const second = f.manager.run(stale, async () => {
    order.push('second');
    assert.equal(stale.accountToken, 'rotated-access-token');
    assert.equal(stale.accountRefreshToken, 'rotated-refresh-token');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'rotated', 'second']);
});

test('saving a stale editor snapshot keeps rotated credentials without overwriting a manually changed account', async t => {
  const f = fixture(t);
  const record = provider(), draft = { ...record };
  await f.manager.run(record, async () => {
    record.accountToken = 'rotated-access-token';
    record.accountRefreshToken = 'rotated-refresh-token';
  });
  // The editor still has the old access token but save-provider fills the
  // omitted refresh token from the current saved record.
  draft.accountRefreshToken = record.accountRefreshToken;
  f.manager.restore(draft);
  assert.equal(draft.accountToken, record.accountToken);
  const manual = { ...draft, accountToken: 'manually-entered-new-account' };
  f.manager.restore(manual);
  assert.equal(manual.accountToken, 'manually-entered-new-account');
  const otherUser = { ...draft, accountToken: 'expired-access-token', accountUserId: 'another-user' };
  f.manager.restore(otherUser);
  assert.equal(otherUser.accountUserId, 'another-user');
  assert.equal(otherUser.accountToken, 'expired-access-token');
});

test('an open login page keeps synchronizing tokens after connection without forcing refresh', async t => {
  let token = 'first-browser-access-token';
  const f = fixture(t, { readCredentials: async (_window, _origin, options) => {
    assert.equal(options.refresh, false);
    return { accountToken: token, accountRefreshToken: 'latest-browser-refresh-token' };
  } });
  const record = provider();
  await f.manager.prepare(record);
  const window = new f.Window({});
  f.manager.attach(record, window);
  await window.loadURL(record.loginUrl);
  await f.manager.run(record, async () => {});
  token = 'second-browser-access-token';
  await f.manager.run(record, async () => {});
  assert.equal(record.accountToken, token);
  window.destroy();
});

test('401 restores the saved browser session once, while network and permission errors do not trigger login', async t => {
  const f = fixture(t, { readCredentials: async () => ({ accountToken: 'recovered-access-token' }) });
  const record = provider();
  let attempts = 0;
  await f.manager.run(record, async () => {
    attempts += 1;
    if (record.accountToken !== 'recovered-access-token') throw Object.assign(new Error('expired'), { status: 401 });
  });
  assert.equal(attempts, 2);
  assert.equal(f.windowCount(), 1);
  for (const status of [403, 429, 500, undefined]) {
    const error = Object.assign(new Error('original upstream failure'), { status });
    await assert.rejects(f.manager.run(record, async () => { throw error; }), actual => actual === error);
  }
  assert.equal(f.windowCount(), 1);
  attempts = 0;
  await assert.rejects(f.manager.run(record, async () => { attempts += 1; throw Object.assign(new Error('still expired'), { status: 401 }); }), /still expired/);
  assert.equal(attempts, 2);
  assert.equal(f.windowCount(), 2);
});

test('browser bootstrap updates the last observed refresh token and preserves a newer browser login', async t => {
  const f = fixture(t);
  const record = provider();
  const entry = await f.manager.prepare(record);
  await f.manager.run(record, async () => { record.accountRefreshToken = 'backend-rotated-refresh-token'; });
  const window = new f.Window({});
  const frame = { url: record.loginUrl };
  window.webContents.mainFrame = frame;
  f.manager.attach(record, window);
  const event = { sender: window.webContents, senderFrame: frame };
  assert.equal(f.manager.bootstrap(event, 'saved-refresh-token').refreshToken, 'backend-rotated-refresh-token');
  assert.equal(f.manager.bootstrap(event, 'newer-browser-refresh-token'), null);
  assert.equal(f.manager.bootstrap({ ...event, senderFrame: { url: record.loginUrl } }, ''), null);
  frame.url = 'https://other.test/login';
  assert.equal(f.manager.bootstrap(event, ''), null);
  window.destroy();
  const metadata = fs.readFileSync(entry.marker, 'utf8');
  assert.ok(!metadata.includes(record.accountRefreshToken), 'Migration metadata stores only a hash');
});
