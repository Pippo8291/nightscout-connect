const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const { createSyncServer } = require('../lib/sync/server');

const TOKEN = 'secret-jwt-value';

function call (server, { method = 'POST', path = '/glooko/sync', token } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, json: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer (options, fn) {
  const logs = [];
  const logger = { info: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a), debug: (...a) => logs.push(a) };
  const server = createSyncServer({ glooko: true, disabledReason: null, logger, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(server, logs);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const allow = { check: async () => ({ ok: true }) };
const ok200 = { status: 200, signedIn: true, lastSignInAt: '2026-11-07T08:00:00.000Z', finishedAt: '2026-11-07T08:00:20.000Z' };
const ok202 = { status: 202, signedIn: false, lastSignInAt: '2026-11-07T07:50:00.000Z', followUpAt: ['a', 'b'] };

test('without a bearer token the request is 401 and the controller is not asked', async () => {
  let asked = 0;
  await withServer({ checker: allow, controller: { request: async () => { asked++; return ok200; } } }, async (server) => {
    assert.equal((await call(server)).status, 401);
    assert.equal(asked, 0);
  });
});

test('the checker decides 401, 403 and 503', async () => {
  for (const status of [401, 403, 503]) {
    const checker = { check: async () => ({ ok: false, status }) };
    await withServer({ checker, controller: { request: async () => ok200 } }, async (server) => {
      const res = await call(server, { token: TOKEN });
      assert.equal(res.status, status);
      if (status === 403) assert.equal(res.json.permission, 'api:treatments:create');
    });
  }
});

test('200 and 202 results are passed through with their bodies', async () => {
  for (const result of [ok200, ok202]) {
    await withServer({ checker: allow, controller: { request: async () => result } }, async (server) => {
      const res = await call(server, { token: TOKEN });
      assert.equal(res.status, result.status);
      const { status, ...body } = result;
      assert.deepEqual(res.json, body);
    });
  }
});

test('a 502 from the controller is passed through', async () => {
  await withServer({ checker: allow, controller: { request: async () => ({ status: 502, error: 'Glooko sign-in or fetch failed' }) } }, async (server) => {
    const res = await call(server, { token: TOKEN });
    assert.equal(res.status, 502);
    assert.equal(res.json.error, 'Glooko sign-in or fetch failed');
  });
});

test('a disabled endpoint answers 503 with its reason, before any token check', async () => {
  let checked = 0;
  const checker = { check: async () => { checked++; return { ok: true }; } };
  await withServer({ checker, controller: { request: async () => ok200 }, disabledReason: 'default roles grant the permission' }, async (server) => {
    const res = await call(server, { token: TOKEN });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'default roles grant the permission');
    assert.equal(checked, 0);
  });
});

test('no glooko source is 404; other paths 404; other methods 405', async () => {
  await withServer({ checker: allow, controller: { request: async () => ok200 }, glooko: false }, async (server) => {
    assert.equal((await call(server, { token: TOKEN })).status, 404);
  });
  await withServer({ checker: allow, controller: { request: async () => ok200 } }, async (server) => {
    assert.equal((await call(server, { token: TOKEN, path: '/x' })).status, 404);
    assert.equal((await call(server, { token: TOKEN, method: 'GET' })).status, 405);
  });
});

test('the token never appears in a response or a log line', async () => {
  const checker = { check: async () => { throw new Error('boom ' + TOKEN); } };
  await withServer({ checker, controller: { request: async () => ok200 } }, async (server, logs) => {
    const res = await call(server, { token: TOKEN });
    assert.equal(res.status, 500);
    assert.equal(res.body.includes(TOKEN), false);
    assert.equal(JSON.stringify(logs).includes(TOKEN), false);
  });
});
