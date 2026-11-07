const assert = require('node:assert/strict');
const test = require('node:test');

const { permits, createTokenChecker, defaultRolesGrant } = require('../lib/sync/auth');

const PERMISSION = 'api:treatments:create';

test('permits follows Shiro wildcard semantics', () => {
  assert.equal(permits([['*']], PERMISSION), true);
  assert.equal(permits([['api:*:create']], PERMISSION), true);
  assert.equal(permits([[PERMISSION]], PERMISSION), true);
  assert.equal(permits([['*:*:read']], PERMISSION), false);
  assert.equal(permits([['api:treatments:read'], [PERMISSION]], PERMISSION), true);
  assert.equal(permits([['api']], PERMISSION), true);
  assert.equal(permits([['api:treatments,entries:create']], PERMISSION), true);
  assert.equal(permits([['api:entries:create']], PERMISSION), false);
  assert.equal(permits([], PERMISSION), false);
  assert.equal(permits(undefined, PERMISSION), false);
});

function stub (responses) {
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { request, calls };
}

const careportal = { status: 200, data: { sub: 'phone', permissionGroups: [['*:*:read'], [PERMISSION]] } };
const readable = { status: 200, data: { sub: 'follower', permissionGroups: [['*:*:read']] } };

test('a token with the permission passes and is cached for the ttl', async () => {
  let clock = 1000;
  const { request, calls } = stub([careportal, careportal]);
  const checker = createTokenChecker({
    nightscoutUrl: 'https://ns.example/', permission: PERMISSION, request, ttlMs: 300000, now: () => clock,
  });
  assert.deepEqual(await checker.check('jwt-1'), { ok: true });
  assert.equal(calls[0], 'https://ns.example/api/v2/authorization/request/jwt-1');
  assert.deepEqual(await checker.check('jwt-1'), { ok: true });
  assert.equal(calls.length, 1);
  clock += 300001;
  assert.deepEqual(await checker.check('jwt-1'), { ok: true });
  assert.equal(calls.length, 2);
});

test('a read-only token is refused and not cached', async () => {
  const { request, calls } = stub([readable, readable]);
  const checker = createTokenChecker({ nightscoutUrl: 'https://ns.example', permission: PERMISSION, request });
  assert.deepEqual(await checker.check('ro'), { ok: false, status: 403 });
  assert.deepEqual(await checker.check('ro'), { ok: false, status: 403 });
  assert.equal(calls.length, 2);
});

test('an unknown token is 401, an unreachable nightscout 503, and no result carries the token', async () => {
  const { request } = stub([{ status: 401, data: {} }, new Error('ECONNREFUSED secret-token'), { status: 500, data: {} }]);
  const checker = createTokenChecker({ nightscoutUrl: 'https://ns.example', permission: PERMISSION, request });
  const results = [await checker.check('secret-token'), await checker.check('secret-token'), await checker.check('secret-token')];
  assert.deepEqual(results, [{ ok: false, status: 401 }, { ok: false, status: 503 }, { ok: false, status: 503 }]);
  assert.equal(JSON.stringify(results).includes('secret-token'), false);
});

test('a token is url-encoded into the path', async () => {
  const { request, calls } = stub([careportal]);
  const checker = createTokenChecker({ nightscoutUrl: 'https://ns.example', permission: PERMISSION, request });
  await checker.check('a/b?c');
  assert.equal(calls[0], 'https://ns.example/api/v2/authorization/request/a%2Fb%3Fc');
});

test('default roles: whether they already grant the permission', () => {
  assert.equal(defaultRolesGrant('readable', PERMISSION), false);
  assert.equal(defaultRolesGrant('readable careportal', PERMISSION), true);
  assert.equal(defaultRolesGrant(' admin ', PERMISSION), true);
  assert.equal(defaultRolesGrant('denied', PERMISSION), false);
  assert.equal(defaultRolesGrant('custom-x', PERMISSION), null);
  assert.equal(defaultRolesGrant(undefined, PERMISSION), false);
  assert.equal(defaultRolesGrant('', PERMISSION), false);
  // Nightscout splits AUTH_DEFAULT_ROLES on blanks, commas and colons (defaultroles.js)
  assert.equal(defaultRolesGrant('readable,careportal', PERMISSION), true);
  assert.equal(defaultRolesGrant('readable:careportal', PERMISSION), true);
  assert.equal(defaultRolesGrant('readable, denied', PERMISSION), false);
});
