'use strict';

// Who may trigger an on-demand Glooko sync: a Nightscout token (or the JWT
// Nightscout issued for it) whose permissions include CONNECT_SYNC_PERMISSION,
// `api:treatments:create` by default. The importer asks the configured
// Nightscout, which already knows every subject and role.

const crypto = require('crypto');
const http = require('http');
const https = require('https');

// Nightscout's built-in roles (cgm-remote-monitor lib/authorization/storage.js).
const BUILT_IN_ROLES = {
  admin: ['*'],
  denied: [],
  'status-only': ['api:status:read'],
  readable: ['*:*:read'],
  careportal: ['api:treatments:create'],
  'devicestatus-upload': ['api:devicestatus:create'],
  activity: ['api:activity:create'],
};

// Shiro wildcard matching as Nightscout uses it: parts split on ':', '*'
// matches one part, a comma list matches any member, and a granted
// permission with fewer parts implies '*' for the rest.
function implies (granted, wanted) {
  const g = String(granted).split(':');
  const w = String(wanted).split(':');
  for (let i = 0; i < Math.max(g.length, w.length); i++) {
    if (i >= g.length) return true;
    const part = g[i];
    if (i >= w.length) {
      if (part !== '*') return false;
      continue;
    }
    if (part === '*') continue;
    if (!part.split(',').includes(w[i])) return false;
  }
  return true;
}

function permits (permissionGroups, permission) {
  if (!Array.isArray(permissionGroups)) return false;
  return permissionGroups.some((group) =>
    Array.isArray(group) && group.some((granted) => implies(granted, permission)));
}

// Whether the instance's default roles alone grant `permission`; null when a
// role name is not one of Nightscout's built-ins (its permissions are unknown).
function defaultRolesGrant (authDefaultRoles, permission) {
  // Split as Nightscout does (lib/authorization/defaultroles.js): blanks, commas, colons.
  const names = String(authDefaultRoles || '').split(/[\s,:]+/).filter(Boolean);
  let unknown = false;
  for (const name of names) {
    const perms = BUILT_IN_ROLES[name];
    if (!perms) { unknown = true; continue; }
    if (permits([perms], permission)) return true;
  }
  return unknown ? null : false;
}

function getJson (url, { timeoutMs = 10000, headers = { } } = { }) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs, headers: { Accept: 'application/json', ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = body ? JSON.parse(body) : null; } catch (_) { data = null; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Nightscout token check timed out')));
    req.on('error', () => reject(new Error('Nightscout token check failed')));
  });
}

function createTokenChecker ({ nightscoutUrl, permission, request = getJson, ttlMs = 300000, now = Date.now }) {
  const base = String(nightscoutUrl || '').replace(/\/+$/, '');
  const cache = new Map();

  function keyOf (token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  async function check (token) {
    const key = keyOf(token);
    const cachedUntil = cache.get(key);
    if (cachedUntil && cachedUntil > now()) return { ok: true };
    cache.delete(key);

    let response;
    try {
      response = await request(base + '/api/v2/authorization/request/' + encodeURIComponent(token));
    } catch (_) {
      return { ok: false, status: 503 };
    }
    if (!response || response.status === 401) return { ok: false, status: 401 };
    if (response.status !== 200) return { ok: false, status: 503 };
    if (!permits(response.data && response.data.permissionGroups, permission)) return { ok: false, status: 403 };
    cache.set(key, now() + ttlMs);
    return { ok: true };
  }

  return { check };
}

module.exports = { permits, defaultRolesGrant, createTokenChecker, getJson };
