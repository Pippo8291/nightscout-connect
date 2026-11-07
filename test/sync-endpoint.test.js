const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const { createSyncEndpoint } = require('../lib/sync');

const quiet = { info () {}, warn () {}, error () {}, debug () {} };

function post (port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/glooko/sync', headers: { Authorization: 'Bearer t' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('no CONNECT_HTTP_PORT, no endpoint', () => {
  assert.equal(createSyncEndpoint({ source: 'glooko' }, { logger: quiet }), null);
});

test('default roles that grant the permission disable the endpoint', async () => {
  const seen = [];
  const getJson = async (url, options) => {
    seen.push({ url, headers: options && options.headers });
    return { status: 200, data: { settings: { authDefaultRoles: 'readable careportal' } } };
  };
  const endpoint = createSyncEndpoint(
    { source: 'glooko', httpPort: 0, nightscoutEndpoint: 'https://ns.example/', apiSecret: 'abc' },
    { logger: quiet, getJson, host: '127.0.0.1' },
  );
  endpoint.attach({ send () {}, lastSignInMs: () => null });
  const server = await endpoint.listen();
  try {
    const res = await post(server.address().port);
    assert.equal(res.status, 503);
    assert.match(res.json.error, /default roles/);
    assert.equal(seen[0].url, 'https://ns.example/api/v1/status.json');
    assert.equal(seen[0].headers['api-secret'], 'a9993e364706816aba3e25717850c26c9cd0d89d');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the hooks reach the controller once it is attached', () => {
  const endpoint = createSyncEndpoint({ source: 'glooko', httpPort: 0, nightscoutEndpoint: 'https://ns.example' }, { logger: quiet });
  // before attach the hooks are harmless no-ops
  endpoint.hooks.on_frame_start();
  endpoint.hooks.on_transformed({ entries: [] });
  endpoint.hooks.on_frame_outcome({ ok: true });
  const sent = [];
  endpoint.attach({ send: (e) => sent.push(e.type), lastSignInMs: () => Date.now() });
  endpoint.controller().request();
  assert.deepEqual(sent, ['SYNC_NOW']);
});

test('a port already in use rejects listen() instead of crashing the process', async () => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  try {
    const getJson = async () => ({ status: 200, data: { settings: { authDefaultRoles: 'readable' } } });
    const endpoint = createSyncEndpoint(
      { source: 'glooko', httpPort: blocker.address().port, nightscoutEndpoint: 'https://ns.example' },
      { logger: quiet, getJson, host: '127.0.0.1' },
    );
    endpoint.attach({ send () {}, lastSignInMs: () => null });
    await assert.rejects(endpoint.listen());
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('status.json that cannot be read leaves the endpoint on and warns', async () => {
  for (const response of [{ status: 401, data: { message: 'Unauthorized' } }, { status: 200, data: '<html>' }, { status: 500, data: null }]) {
    const warnings = [];
    const logger = { ...quiet, warn: (m) => warnings.push(m) };
    const endpoint = createSyncEndpoint(
      { source: 'glooko', httpPort: 0, nightscoutEndpoint: 'https://ns.example' },
      { logger, getJson: async () => response, host: '127.0.0.1' },
    );
    endpoint.attach({ send () {}, lastSignInMs: () => null });
    const server = await endpoint.listen();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(warnings.length, 1, JSON.stringify(response));
  }
});
