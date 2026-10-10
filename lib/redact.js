
// Secrets end up in the pm2 log via console.log of config objects and
// machine contexts (API secret, Glooko password, session cookie).  Mask
// any key that looks like it holds a credential, at any depth, and leave
// everything else untouched.  The input is never mutated.
// `authorization` is anchored: the poller context counts `authorizations`.
var SECRET_KEY = /secret|password|passwd|token|cookie|^authorization$/i;
var MAX_DEPTH = 6;

function redact (value, depth) {
  depth = depth === undefined ? MAX_DEPTH : depth;
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (depth <= 0) {
    return Array.isArray(value) ? '[Array]' : '[Object]';
  }
  if (Array.isArray(value)) {
    return value.map(function (item) { return redact(item, depth - 1); });
  }
  var out = { };
  Object.keys(value).forEach(function (key) {
    out[key] = SECRET_KEY.test(key) ? '<redacted>' : redact(value[key], depth - 1);
  });
  return out;
}

module.exports = redact;
