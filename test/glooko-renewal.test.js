const assert = require('node:assert/strict');
const test = require('node:test');

const glooko = require('../lib/sources/glooko');
const { parseTimes, msUntilNext } = require('../lib/sources/glooko/renewal');

const MIN = 60 * 1000;
const berlin = { glookoTimezone: 'Europe/Berlin' };
const TIMES = parseTimes('08:30,12:30,18:30,23:59');

test('renewal times parse to sorted minutes after local midnight', () => {
  assert.deepEqual(parseTimes('18:30, 8:30,12:30,08:30'), [510, 750, 1110]);
  assert.equal(parseTimes(undefined), null);
  assert.equal(parseTimes(''), null);
  assert.equal(parseTimes('24:00'), null);
  assert.equal(parseTimes('8.30'), null);
  assert.equal(parseTimes('08:30,'), null);
});

test('the next renewal is the next listed local time in the configured timezone', () => {
  // 10:00 in Berlin (summer, UTC+2) -> 12:30 local
  const now = Date.parse('2026-07-15T08:00:00.000Z');
  assert.equal(msUntilNext(TIMES, now, berlin), 150 * MIN);
  // 08:00 in Berlin (winter, UTC+1) -> 08:30 local
  assert.equal(msUntilNext(TIMES, Date.parse('2026-01-15T07:00:00.000Z'), berlin), 30 * MIN);
});

test('after the last time of the day the first time tomorrow is next', () => {
  // 23:59:30 Berlin -> 08:30 next day
  const now = Date.parse('2026-07-15T21:59:30.000Z');
  assert.equal(msUntilNext(TIMES, now, berlin), 8 * 60 * MIN + 30 * MIN + 30 * 1000);
});

test('the renewal follows the wall clock across a DST change', () => {
  // 2026-03-29 02:00 Berlin jumps to 03:00. From 23:59 (UTC+1) on the 28th,
  // 08:30 the next morning is UTC+2: 7h31m of real time, not 8h31m.
  const now = Date.parse('2026-03-28T22:59:00.000Z');
  assert.equal(msUntilNext(TIMES, now, berlin), (7 * 60 + 31) * MIN);
});

test('a fixed hour offset works when no IANA timezone is set', () => {
  // CONNECT_GLOOKO_TIMEZONE_OFFSET=1 is stored as -1 h, as validate() does.
  const opts = { glookoTimezoneOffset: -60 * MIN };
  assert.equal(msUntilNext(TIMES, Date.parse('2026-07-15T07:00:00.000Z'), opts), 30 * MIN);
});

function validConfig (extra) {
  return glooko.validate({ glookoEmail: 'a@example.test', glookoPassword: 'pw', ...extra });
}

test('validation accepts renewal times and rejects malformed ones', () => {
  const ok = validConfig({ glookoSessionRenewalTimes: '08:30,12:30' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.config.glookoSessionRenewalTimes, [510, 750]);

  const bad = validConfig({ glookoSessionRenewalTimes: 'lunch' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /SESSION_RENEWAL_TIMES/.test(e.err.message)));

  assert.equal(validConfig({}).config.glookoSessionRenewalTimes, null);
});

function sessionDelays (config) {
  let delays;
  const builder = {
    support_session: (cfg) => { delays = cfg.delays; },
    register_loop: () => {}
  };
  glooko(config, { create: () => ({}) }).generate_driver(builder);
  return delays;
}

test('the session expires at the renewal times only when they are configured', () => {
  const plain = sessionDelays(validConfig({}).config);
  assert.equal(plain.EXPIRE_SESSION_DELAY, 24 * 60 * MIN);

  const timed = sessionDelays(validConfig({ glookoSessionRenewalTimes: '08:30', glookoTimezone: 'Europe/Berlin' }).config);
  assert.equal(typeof timed.EXPIRE_SESSION_DELAY, 'function');
  const ms = timed.EXPIRE_SESSION_DELAY();
  assert.ok(ms > 0 && ms <= 24 * 60 * MIN);
});
