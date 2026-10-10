#!/usr/bin/env node
/*
 * Regression test for log hygiene.
 *
 * Symptoms observed in production (glooko-sync on pm2):
 *
 *   - every 5-minute cycle wrote ~100 log lines, ~85 of them two bare
 *     xstate actions.log() dumps of the whole machine context, including
 *     the live Glooko session cookie
 *   - the startup banner (STARTING / CONFIGURED OUTPUT / INPUT PARAMS /
 *     SETTING UP nightscoutRestAPI / GLOOKO OPTS) printed the Glooko
 *     password and the Nightscout API secret in clear text
 *
 * Asserts:
 *
 *   1. redact() masks secret-looking keys at any depth, leaves everything
 *      else alone and does not mutate its input
 *   2. constructing the Nightscout output, selecting it, and constructing the
 *      Glooko source never print the API secret or the password
 *   3. one full machine frame prints neither the session cookie nor a
 *      context dump by default
 *   4. with CONNECT_DEBUG set the context dump is back, cookie redacted
 *
 * Run: node test/log-hygiene-regression.js   (or: npm test)
 */

var assert = require('assert');
var util = require('util');
var axios = require('axios');
var { interpret } = require('xstate');

var builder = require('../lib/builder');
var nightscoutRestAPI = require('../lib/outputs/nightscout');
var selectOutput = require('../lib/outputs');
var glookoSource = require('../lib/sources/glooko');
var redact = null;
try { redact = require('../lib/redact'); } catch (e) { }

var SECRET = 'NS-API-SECRET-1234';
var PASSWORD = 'GLOOKO-PASSWORD-5678';
var COOKIE = '_logbook-web_session=COOKIE-VALUE-9012';

// Capture what would reach the pm2 log: console.log, formatted the way
// console.log formats it (util.format, inspect depth 2).
function capture_sync (fn) {
  var lines = [];
  var original = console.log;
  console.log = function () { lines.push(util.format.apply(null, arguments)); };
  try { fn(); } finally { console.log = original; }
  return lines;
}

function assert_no_line_contains (lines, needle, what) {
  var hits = lines.filter(function (l) { return l.indexOf(needle) !== -1; });
  assert.strictEqual(hits.length, 0,
    what + ' must not be logged, but appeared in ' + hits.length + ' line(s): ' +
    (hits[0] || '').slice(0, 120));
}

function test_redact () {
  assert.strictEqual(typeof redact, 'function', 'lib/redact.js must export a function');
  var input = {
    apiSecret: 's'
  , nested: { glookoPassword: 'p', cookies: 'c', keep: 1, list: [ { token: 't', ok: 'yes' } ] }
  , when: new Date(0)
  , fn: function () { }
  };
  var out = redact(input);
  assert.strictEqual(out.apiSecret, '<redacted>', 'apiSecret must be masked');
  assert.strictEqual(out.nested.glookoPassword, '<redacted>', 'nested password must be masked');
  assert.strictEqual(out.nested.cookies, '<redacted>', 'nested cookies must be masked');
  assert.strictEqual(out.nested.list[0].token, '<redacted>', 'token inside an array must be masked');
  assert.strictEqual(out.nested.keep, 1, 'plain values must survive');
  assert.strictEqual(out.nested.list[0].ok, 'yes', 'plain values inside arrays must survive');
  assert.ok(out.when instanceof Date, 'dates must stay dates');
  assert.strictEqual(out.fn, input.fn, 'functions pass through');
  assert.strictEqual(input.apiSecret, 's', 'input must not be mutated');
  assert.strictEqual(redact('plain'), 'plain', 'primitives pass through');
  assert.strictEqual(redact(null), null, 'null passes through');
  console.log('PASS: redact masks secret keys and leaves the rest alone');
}

function test_startup_banner () {
  var lines = capture_sync(function () {
    nightscoutRestAPI({ name: 'nightscout', url: 'http://127.0.0.1:1/', apiSecret: SECRET }, axios);
    selectOutput({ name: 'nightscout', url: 'http://127.0.0.1:1/', apiSecret: SECRET });
    glookoSource({
      glookoServer: 'de-fr.my.glooko.com'
    , glookoEmail: 'someone@example.com'
    , glookoPassword: PASSWORD
    , glookoTimezoneOffset: 0
    , baseURL: 'https://de-fr.my.glooko.com'
    }, axios);
  });
  assert.ok(lines.length > 0, 'setup should still log something');
  assert_no_line_contains(lines, SECRET, 'the Nightscout API secret');
  assert_no_line_contains(lines, PASSWORD, 'the Glooko password');
  console.log('PASS: setup banner does not print the API secret or password');
}

// A deterministic stand-in for a source driver: logs in, hands out a
// session that carries a cookie, fetches, transforms.
function fake_driver () {
  var impl = {
    authenticate: function () { return Promise.resolve('auth-info'); }
  , authorize: function () { return Promise.resolve({ cookies: COOKIE, user: { name: 'someone' } }); }
  , dataFromSesssion: function (session) {
      assert.strictEqual(session.cookies, COOKIE, 'the frame must receive the session');
      return Promise.resolve({ readings: [ 1, 2, 3 ] });
    }
  , transform: function (data) { return { entries: [], treatments: [] }; }
  };
  impl.generate_driver = function (b) {
    b.support_session({
      authenticate: impl.authenticate
    , authorize: impl.authorize
    , delays: { REFRESH_AFTER_SESSSION_DELAY: 60000, EXPIRE_SESSION_DELAY: 60000 }
    });
    b.register_loop('Test', {
      frame: { impl: impl.dataFromSesssion, transform: impl.transform, backoff: { }, maxRetries: 1 }
    , expected_data_interval_ms: 60000
    , backoff: { interval_ms: 1 }
    });
    return b;
  };
  return impl;
}

// Run exactly one frame of the real poller/session/cycle/fetch machines
// and return every line that would have reached the log.
function run_one_frame () {
  var output = function record_batch (batch) {
    return Promise.resolve({ entries: null, treatments: null });
  };
  output.gap_for = function () { return Promise.resolve({ entries: null, treatments: null }); };

  var make = builder({ output: output });
  fake_driver().generate_driver(make);
  var machine = make();

  return new Promise(function (resolve, reject) {
    var lines = [];
    var original = console.log;
    var actor = null;
    var timer = setTimeout(function () { finish(new Error('frame did not finish within 5s')); }, 5000);
    function finish (err) {
      clearTimeout(timer);
      console.log = original;
      if (actor) actor.stop();
      if (err) { reject(err); } else { resolve(lines); }
    }
    function log () {
      var text = util.format.apply(null, arguments);
      // One console.log of an object is many lines in the pm2 log file.
      text.split('\n').forEach(function (line) { lines.push(line); });
      // The cycle machine logs 'AFTER' once the frame is done.
      if (text === 'AFTER') { setImmediate(function () { finish(null); }); }
    }
    // xstate binds console.log when it is loaded, so hooking console.log
    // alone would miss the machine's own log actions: hand the logger in
    // explicitly (child machines inherit it) and hook console.log for the
    // rest.
    console.log = log;
    actor = interpret(machine, { logger: log });
    actor.start();
    actor.send({ type: 'START' });
  });
}

function context_dump_lines (lines) {
  // `transformed:` only ever appears in a dump of the fetch machine context.
  return lines.filter(function (l) { return /^\s*transformed:/.test(l); });
}

function test_frame_default () {
  delete process.env.CONNECT_DEBUG;
  return run_one_frame().then(function (lines) {
    assert.ok(lines.indexOf('FRAME DONE') !== -1, 'the frame must complete (FRAME DONE)');
    assert_no_line_contains(lines, 'COOKIE-VALUE-9012', 'the session cookie');
    assert.strictEqual(context_dump_lines(lines).length, 0,
      'no machine context dump by default (found ' + context_dump_lines(lines).length + ')');
    assert.ok(lines.length < 30,
      'one frame should log a handful of lines, got ' + lines.length);
    console.log('PASS: a frame logs no cookie and no context dump by default (' + lines.length + ' lines)');
  });
}

function test_frame_debug () {
  process.env.CONNECT_DEBUG = '1';
  return run_one_frame().then(function (lines) {
    delete process.env.CONNECT_DEBUG;
    assert.ok(context_dump_lines(lines).length >= 1,
      'CONNECT_DEBUG must bring the context dump back');
    assert_no_line_contains(lines, 'COOKIE-VALUE-9012', 'the session cookie (even in debug)');
    assert.ok(lines.some(function (l) { return /cookies: '<redacted>'/.test(l); }),
      'the debug dump must show the cookie as redacted');
    console.log('PASS: CONNECT_DEBUG dumps the context with the cookie redacted');
  }, function (err) {
    delete process.env.CONNECT_DEBUG;
    throw err;
  });
}

function run () {
  return Promise.resolve()
    .then(test_redact)
    .then(test_startup_banner)
    .then(test_frame_default)
    .then(test_frame_debug)
    .then(function () {
      process.exit(0);
    }, function (err) {
      console.error('FAIL:', err && err.message);
      process.exit(1);
    });
}

run();
