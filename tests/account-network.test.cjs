const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function loadNetwork(electron, netFetch, nodeFetch) {
  const source = fs.readFileSync(path.join(__dirname, '../src/providers/base.js'), 'utf8');
  const context = vm.createContext({
    module: { exports: {} },
    process: { versions: electron ? { electron: '31' } : {} },
    require: name => {
      if (name === '../provider-currency') return require('../src/provider-currency');
      if (name === '../account-session-context') return require('../src/account-session-context');
      assert.equal(name, 'electron');
      return { net: { fetch: netFetch } };
    },
    fetch: nodeFetch
  });
  vm.runInContext(source, context);
  return context.module.exports.accountFetch;
}

test('desktop account requests use Chromium networking with explicit provider cookies only', async () => {
  const options = { method: 'POST', headers: { Cookie: 'test_session=value', Authorization: 'Bearer test-token' },
    body: '{"refresh_token":"test"}', signal: new AbortController().signal, credentials: 'include' };
  let calls = 0;
  const fetchAccount = loadNetwork(true, async (url, actual) => {
    calls += 1;
    assert.equal(url, 'https://account.test/api/v1/auth/refresh');
    assert.equal(actual.credentials, 'omit');
    assert.equal(actual.bypassCustomProtocolHandlers, true);
    assert.equal(actual.headers, options.headers);
    assert.equal(actual.body, options.body);
    assert.equal(actual.method, 'POST');
    assert.equal(actual.signal, options.signal);
    return new Response('ok');
  }, () => { throw new Error('Node networking must not be used in Electron'); });
  assert.equal(await (await fetchAccount('https://account.test/api/v1/auth/refresh', options)).text(), 'ok');
  assert.equal(calls, 1);
});

test('non-desktop adapter tests and tools retain native fetch', async () => {
  const options = { headers: { Accept: 'application/json' } };
  const fetchAccount = loadNetwork(false, () => { throw new Error('Electron must not be loaded'); }, async (url, actual) => {
    assert.equal(url, 'https://account.test');
    assert.equal(actual, options);
    return new Response('ok');
  });
  assert.equal(await (await fetchAccount('https://account.test', options)).text(), 'ok');
});

test('New API balance and token imports also use the account network transport', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/providers/new-api.js'), 'utf8');
  const calls = [];
  const context = vm.createContext({
    module: { exports: {} }, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    require: () => ({ ...require('../src/providers/base'), accountFetch: async (url, options) => {
      const pathname = new URL(url).pathname;
      calls.push(pathname);
      assert.equal(options.headers.Authorization, 'Bearer test-account-token');
      assert.equal(options.headers['New-Api-User'], '123');
      const data = pathname === '/api/user/self' ? { quota: 500000 }
        : pathname === '/api/token/' ? { items: [{ id: 1, name: 'test', key: 'sk-te********st' }] }
          : pathname === '/api/token/1/key' ? { key: 'test-key' } : {};
      if (pathname.endsWith('/key')) assert.equal(options.method, 'POST');
      return new Response(JSON.stringify({ success: true, data }));
    } })
  });
  vm.runInContext(source, context);
  const adapter = context.module.exports;
  const record = { loginUrl: 'https://account.test', accountToken: 'test-account-token', accountUserId: '123' };
  assert.equal((await adapter.getBalance(record)).balance, 1);
  assert.equal((await adapter.getApiKeys(record))[0].key, 'sk-test-key');
  assert.equal(calls.length, 6);
});

test('New API user logs provide 24-hour usage when dashboard aggregation is unavailable', async () => {
  const now = Math.floor(Date.now() / 1000);
  const adapterSource = fs.readFileSync(path.join(__dirname, '../src/providers/new-api.js'), 'utf8');
  const items = [
    { type: 2, created_at: now, quota: 28125, prompt_tokens: 5, completion_tokens: 2048, use_time: 15 },
    { type: 2, created_at: now, quota: 28125, prompt_tokens: 582, completion_tokens: 2048, use_time: 18 },
    { type: 2, created_at: now, quota: 28125, prompt_tokens: 649, completion_tokens: 2048, use_time: 15 },
    { type: 2, created_at: now, quota: 25000, prompt_tokens: 649, completion_tokens: 2048, use_time: 26 },
    { type: 2, created_at: now, quota: 5000, prompt_tokens: 639, completion_tokens: 1158, use_time: 21 },
    { type: 5, created_at: now, quota: 0, prompt_tokens: 0, completion_tokens: 0, use_time: 0 }
  ];
  const context = vm.createContext({
    module: { exports: {} }, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, Date,
    require: () => ({ ...require('../src/providers/base'), accountFetch: async (url, options) => {
      const request = new URL(url);
      const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
      if (request.pathname === '/api/user/self') return reply({ success: true, data: { quota: 500000 } });
      if (request.pathname.startsWith('/api/performance/')) return reply({ message: 'admin only' }, 403);
      if (request.pathname === '/api/log/self') return reply({ success: true, data: { page: 1, page_size: 100, total: items.length, items } });
      throw new Error(`unexpected request: ${request.pathname}`);
    } })
  });
  vm.runInContext(adapterSource, context);
  const result = await context.module.exports.getBalance({ loginUrl: 'https://account.test', accountToken: 'test-token', accountUserId: '123' });
  assert.equal(result.accountStats.todayRequests, 5);
  assert.equal(result.accountStats.todayTokens, 11874);
  assert.equal(result.accountStats.todayCost, 0.22875);
  assert.equal(result.accountStats.averageDurationMs, 19000);
});

test('New API empty 24-hour logs clear stale statistics', async () => {
  const adapterSource = fs.readFileSync(path.join(__dirname, '../src/providers/new-api.js'), 'utf8');
  const context = vm.createContext({
    module: { exports: {} }, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, Date,
    require: () => ({ ...require('../src/providers/base'), accountFetch: async url => {
      const pathname = new URL(url).pathname;
      const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
      if (pathname === '/api/user/self') return reply({ success: true, data: { quota: 500000 } });
      if (pathname === '/api/performance/stats') return reply({ success: true, data: { today_cost: 70000, today_requests: 14, today_tokens: 32558, average_duration_ms: 24000 } });
      if (pathname === '/api/performance/logs') return reply({ success: true, data: { items: [] } });
      if (pathname === '/api/log/self') return reply({ success: true, data: { page: 1, page_size: 100, total: 0, items: [] } });
      throw new Error(`unexpected request: ${pathname}`);
    } })
  });
  vm.runInContext(adapterSource, context);
  const result = await context.module.exports.getBalance({ loginUrl: 'https://account.test', accountToken: 'test-token', accountUserId: '123' });
  assert.equal(result.accountStats.todayCost, 0);
  assert.equal(result.accountStats.todayRequests, 0);
  assert.equal(result.accountStats.todayTokens, 0);
  assert.equal(result.accountStats.averageDurationMs, undefined);
});

for (const [quota, expected] of [[1225100, 2.4502], [0, 0], [5000, 0.01]]) {
  test(`New API dashboard quota ${quota} overrides the first 100 logs`, async () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/providers/new-api.js'), 'utf8');
    const now = Math.floor(Date.now() / 1000);
    // The first page totals $1.0944; the full-range summary includes 250 rows.
    const items = Array.from({ length: 100 }, (_, index) => ({
      type: 2, created_at: now, quota: index === 0 ? 7200 : 5454.545454545455,
      prompt_tokens: 10, completion_tokens: 5, use_time: 2
    }));
    const calls = [];
    const context = vm.createContext({
      module: { exports: {} }, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, Date,
      require: () => ({ ...require('../src/providers/base'), accountFetch: async url => {
        const request = new URL(url);
        calls.push(request);
        const data = request.pathname === '/api/user/self' ? { quota: 500000 }
          : request.pathname === '/api/log/self/stat' ? { quota, rpm: 1, tpm: 15 }
            : request.pathname === '/api/log/self' ? { items: request.searchParams.get('p') === '3' ? items.slice(0,50) : items, total: 250, page: Number(request.searchParams.get('p')), page_size: 100 } : null;
        if (request.pathname === '/api/data/self') return new Response('{}', {status:404});
        assert.notEqual(data, null, `unexpected request: ${request.pathname}`);
        return new Response(JSON.stringify({ success: true, data }));
      } })
    });
    vm.runInContext(source, context);
    const result = await context.module.exports.getBalance({ loginUrl: 'https://account.test', accountToken: 'test-token' });
    assert.equal(result.accountStats.todayCost, expected);
    assert.equal(result.balance, 1);
    const summary = calls.find(request => request.pathname === '/api/log/self/stat');
    const logs = calls.find(request => request.pathname === '/api/log/self');
    for (const key of ['start_timestamp', 'end_timestamp']) {
      assert.equal(summary.searchParams.get(key), logs.searchParams.get(key));
    }
    assert.equal(Number(summary.searchParams.get('end_timestamp')) - Number(summary.searchParams.get('start_timestamp')), 86400);
    assert.equal(result.accountStats.todayRequests, 250);
    assert.equal(result.accountStats.todayTokens, 3750);
    assert.equal(calls.length, 6);
  });
}

test('New API dashboard aggregation matches 112 requests, 7,914,389 tokens and $0.6074 across midnight', async () => {
  const fixedNow = Date.parse('2026-10-22T00:09:22+08:00');
  class Clock extends Date { static now() { return fixedNow; } }
  const calls = [];
  const source = fs.readFileSync(path.join(__dirname, '../src/providers/new-api.js'), 'utf8');
  const context = vm.createContext({ module: {exports:{}}, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, Date: Clock,
    require: () => ({ ...require('../src/providers/base'), accountFetch: async url => {
      const request = new URL(url);
      calls.push(request);
      const data = request.pathname === '/api/user/self' ? {quota:500000}
        : request.pathname === '/api/data/self' ? [
          {created_at:Math.floor(fixedNow/1000)-7200, count:100, quota:200000, token_used:7256843},
          {created_at:Math.floor(fixedNow/1000)-3600, count:12, quota:103700, token_used:657546}
        ] : request.pathname === '/api/log/self' ? {items:[{type:2,created_at:Math.floor(fixedNow/1000)-7200,prompt_tokens:100,completion_tokens:50}], total:112} : null;
      assert.notEqual(data,null);
      return new Response(JSON.stringify({success:true,data}));
    } }) });
  vm.runInContext(source,context);
  const result = await context.module.exports.getBalance({loginUrl:'https://account.test',accountToken:'test-token'});
  assert.equal(result.accountStats.todayRequests,112);
  assert.equal(result.accountStats.todayTokens,7914389);
  assert.equal(result.accountStats.todayCost,0.6074);
  assert.equal(calls.length,3, 'Uses dashboard totals without paging through all logs');
  for (const request of calls.filter(item=>item.pathname!=='/api/user/self')) {
    assert.equal(Number(request.searchParams.get('start_timestamp')),fixedNow/1000-86400);
    assert.equal(Number(request.searchParams.get('end_timestamp')),fixedNow/1000);
  }
  assert.equal(calls.find(item=>item.pathname==='/api/data/self').searchParams.get('default_time'),'hour');
});

test('New API valid zero aggregation overrides recent logs and unavailable statistics do not invent zeros', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/providers/new-api.js'), 'utf8');
  let unavailable = false;
  const context = vm.createContext({module:{exports:{}}, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    require: () => ({...require('../src/providers/base'),accountFetch:async url=> {
      const request=new URL(url);
      if(request.pathname==='/api/user/self') return new Response(JSON.stringify({data:{quota:500000}}));
      if(unavailable) return new Response('{}',{status:503});
      if(request.pathname==='/api/data/self') return new Response(JSON.stringify({data:[]}));
      return new Response(JSON.stringify({data:{items:[{type:2,prompt_tokens:100,quota:5000}]}}));
    }})});
  vm.runInContext(source,context);
  const record={loginUrl:'https://account.test',accountToken:'test-token'};
  const zero=await context.module.exports.getBalance(record);
  assert.equal(zero.accountStats.todayRequests,0);
  assert.equal(zero.accountStats.todayTokens,0);
  assert.equal(zero.accountStats.todayCost,0);
  unavailable=true;
  const missing=await context.module.exports.getBalance(record);
  assert.equal(missing.balance,1);
  assert.deepEqual(Object.keys(missing.accountStats),[]);
});

test('New API overlapping balance queries and key imports share refresh cookie rotation', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/providers/new-api.js'), 'utf8');
  let refreshCount = 0;
  const context = vm.createContext({
    module: { exports: {} }, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    require: () => ({ ...require('../src/providers/base'), accountFetch: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/user/auth/refresh') {
        refreshCount += 1;
        assert.equal(options.headers.Cookie, 'new_api_refresh=old-cookie');
        await new Promise(setImmediate);
        return new Response(JSON.stringify({ success: true, data: { access_token: 'fresh-account-access-token' } }), {
          headers: { 'Set-Cookie': 'new_api_refresh=rotated-cookie; Path=/; HttpOnly' }
        });
      }
      if (options.headers.Authorization !== 'Bearer fresh-account-access-token') {
        await new Promise(setImmediate);
        return new Response('{"message":"expired"}', { status: 401 });
      }
      assert.equal(options.headers.Cookie, 'new_api_refresh=rotated-cookie');
      const data = pathname === '/api/user/self' ? { quota: 500000 }
        : pathname === '/api/token/' ? { items: [{ name: 'test', key: 'sk-test' }] } : {};
      return new Response(JSON.stringify({ success: true, data }));
    } })
  });
  vm.runInContext(source, context);
  const record = { id: 'site', loginUrl: 'https://account.test', accountToken: 'expired-account-access-token', accountCookie: 'new_api_refresh=old-cookie' };
  const [balance, keys] = await Promise.all([context.module.exports.getBalance(record), context.module.exports.getApiKeys(record)]);
  assert.equal(balance.balance, 1);
  assert.equal(keys.length, 1);
  assert.equal(record.accountCookie, 'new_api_refresh=rotated-cookie');
  assert.equal(refreshCount, 1);
});
