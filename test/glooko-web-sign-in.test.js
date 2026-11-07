'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const glooko = require('../lib/sources/glooko');
const createLogger = require('../lib/logging');

// Glooko pulls new pump data (e.g. Omnipod 5) in after a sign-in to its web
// app on my.glooko.com. The API sign-in the importer fetches with does not
// prompt that, so CONNECT_GLOOKO_WEB_SIGN_IN adds the web sign-in.
const API = 'https://de-fr.api.glooko.com';
const WEB = 'https://de-fr.my.glooko.com';
const EMAIL = 'patient-email-marker@example.test';
const PASSWORD = 'private-password-marker';

function config (extra) {
  return glooko.validate({ glookoEnv: 'de-fr', glookoEmail: EMAIL, glookoPassword: PASSWORD, glookoAuthMode: 'api', ...extra }).config;
}

// A Glooko double: the API sign-in, and the web app's sign-in form, form post
// (302 on success) and session lookup. `web` overrides single web answers.
function fakeGlooko (web = {}) {
  const calls = [];
  const answers = {
    'post /api/v2/users/sign_in': () => ({ status: 200, data: { userLogin: { glookoCode: 'patient-1' } },
      headers: { 'set-cookie': ['_logbook-web_session=api-session; path=/; HttpOnly'] } }),
    'get /users/sign_in': () => ({ status: 200, data: '<meta name="csrf-token" content="csrf-123" />',
      headers: { 'set-cookie': ['_logbook-web_session=form-session; path=/; HttpOnly', 'locale=en; path=/'] } }),
    'post /users/sign_in?id=login_form&locale=en': () => ({ status: 302, data: '',
      headers: { location: WEB + '/', 'set-cookie': ['_logbook-web_session=web-session; path=/; secure; HttpOnly'] } }),
    'get /api/v3/session/users': () => ({ status: 200, data: { currentPatient: { glookoCode: 'patient-1' } }, headers: {} }),
    ...web
  };
  const transport = {
    create (defaults) {
      const call = (method) => (path, body, options) => {
        if (method === 'get') { options = body; body = undefined; }
        calls.push({ host: defaults.baseURL, method, path, body, options, defaults });
        const answer = answers[method + ' ' + path];
        return answer ? Promise.resolve().then(answer) : Promise.reject(new Error('unexpected ' + method + ' ' + path));
      };
      return { get: call('get'), post: call('post') };
    }
  };
  return { transport, calls, web: () => calls.filter((c) => c.host === WEB) };
}

function recorder () {
  const lines = [];
  const log = { debug () {}, info: (m) => lines.push('info ' + m), warn: (m) => lines.push('warn ' + m), error: (m) => lines.push('error ' + m) };
  return { log, lines };
}

function authenticateFor (cfg, transport, log) {
  let session;
  const builder = { support_session: (s) => { session = s; }, register_loop () {} };
  glooko(cfg, transport, log).generate_driver(builder);
  return session.authenticate;
}

test('web sign-in is off unless CONNECT_GLOOKO_WEB_SIGN_IN is true', () => {
  assert.equal(config({}).glookoWebSignIn, false);
  assert.equal(config({ glookoWebSignIn: 'true' }).glookoWebSignIn, true);
  assert.equal(config({ glookoWebSignIn: true }).glookoWebSignIn, true);
});

test('with web sign-in on, each sign-in also signs in to the web app on my.glooko.com', async () => {
  const g = fakeGlooko();
  const { log } = recorder();
  const auth = await authenticateFor(config({ glookoWebSignIn: 'true' }), g.transport, log)();

  // The importer keeps fetching with the API session.
  assert.equal(auth.user.userLogin.glookoCode, 'patient-1');
  assert.match(auth.cookies, /api-session/);

  const web = g.web();
  assert.deepEqual(web.map((c) => c.method + ' ' + c.path), [
    'get /users/sign_in',
    'post /users/sign_in?id=login_form&locale=en',
    'get /api/v3/session/users'
  ]);
  // The form post answers 302 + cookie; following the redirect would lose it.
  assert.equal(web[0].defaults.maxRedirects, 0);

  const form = new URLSearchParams(web[1].body);
  assert.equal(form.get('authenticity_token'), 'csrf-123');
  assert.equal(form.get('user[email]'), EMAIL);
  assert.equal(form.get('user[password]'), PASSWORD);
  assert.equal(form.get('commit'), 'Log In');
  assert.equal(web[1].options.headers['Content-Type'], 'application/x-www-form-urlencoded;charset=utf-8');
  // Cookies go back as name=value pairs only, without attributes.
  assert.equal(web[1].options.headers.Cookie, '_logbook-web_session=form-session; locale=en');
  assert.equal(web[2].options.headers.Cookie, '_logbook-web_session=web-session; locale=en');
});

test('without the option, signing in does not touch the web app', async () => {
  const g = fakeGlooko();
  await authenticateFor(config({}), g.transport, recorder().log)();
  assert.deepEqual(g.web(), []);
});

for (const [name, web] of [
  ['refused credentials (form shown again)', { 'post /users/sign_in?id=login_form&locale=en': () => ({ status: 200, data: '<form>', headers: {} }) }],
  ['a form without CSRF token', { 'get /users/sign_in': () => ({ status: 200, data: '<html></html>', headers: {} }) }],
  ['an HTTP error', { 'get /users/sign_in': () => { const e = new Error('Request failed ' + PASSWORD); e.response = { status: 503 }; e.config = { data: PASSWORD }; throw e; } }],
  ['a network error', { 'get /api/v3/session/users': () => { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; } }]
]) {
  test('a failed web sign-in only warns and keeps the API session: ' + name, async () => {
    const g = fakeGlooko(web);
    const { log, lines } = recorder();
    const auth = await authenticateFor(config({ glookoWebSignIn: 'true' }), g.transport, log)();
    assert.equal(auth.user.userLogin.glookoCode, 'patient-1');
    assert.ok(lines.some((l) => /^warn Glooko web sign-in failed/.test(l)), lines.join('\n'));
    assert.ok(!lines.join('\n').includes(PASSWORD) && !lines.join('\n').includes(EMAIL));
  });
}

test('each sign-in is logged with its time and kind, without credentials', async () => {
  const g = fakeGlooko();
  const { log, lines } = recorder();
  await authenticateFor(config({ glookoWebSignIn: 'true' }), g.transport, log)();
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /^info Glooko sign-in \(api\) at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.match(lines[1], /^info Glooko web sign-in at \d{4}-\d\d-\d\dT.*Z: Glooko now fetches new pump data$/);
  assert.ok(!lines.join('\n').includes(PASSWORD) && !lines.join('\n').includes(EMAIL));
});

test('the logger prints info lines also without debug', (t) => {
  const printed = [];
  t.mock.method(console, 'info', (...args) => printed.push(args.join(' ')));
  createLogger(false).info('Glooko sign-in');
  assert.deepEqual(printed, ['nightscout-connect: Glooko sign-in']);
});
