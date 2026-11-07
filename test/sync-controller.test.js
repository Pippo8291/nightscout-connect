const assert = require('node:assert/strict');
const test = require('node:test');

const { createSyncController } = require('../lib/sync/controller');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-07T08:00:00.000Z');

// A fake clock with timers that only fire on advance().
function fakeTime () {
  let now = T0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance (ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
    pending: () => timers.size,
  };
}

function setup ({ lastSignIn = null } = {}) {
  const time = fakeTime();
  const sent = [];
  let signIn = lastSignIn;
  const controller = createSyncController({
    send: (event) => {
      sent.push(event.type);
      if (event.type === 'RESET_SESSION') signIn = 'pending';
    },
    lastSignInMs: () => (signIn === 'pending' ? null : signIn),
    now: time.now,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
  });
  // A frame as the cycle reports it: start, transformed data, outcome.
  const frame = ({ entryMs = null, treatments = [], ok = true, signs = false } = {}) => {
    controller.onFrameStart();
    if (signs) signIn = time.now();
    controller.onTransformed({ entries: entryMs ? [{ date: entryMs }] : [], treatments });
    controller.onFrameOutcome({ ok, status: ok ? undefined : 500 });
  };
  return { time, sent, controller, frame };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a sign-in only when the last one is at least 15 minutes old', async () => {
  for (const [ago, reset] of [[14 * MIN + 59 * 1000, false], [15 * MIN, true]]) {
    const { sent, controller, frame } = setup({ lastSignIn: T0 - ago });
    frame({ entryMs: T0 - 10 * MIN });          // earlier scheduled frame: baseline
    const pending = controller.request();
    assert.deepEqual(sent, reset ? ['RESET_SESSION', 'SYNC_NOW'] : ['SYNC_NOW']);
    frame({ entryMs: T0 });
    assert.equal((await pending).signedIn, reset);
  }
  const never = setup();
  never.controller.request();
  assert.deepEqual(never.sent, ['RESET_SESSION', 'SYNC_NOW']);
});

test('new data in the immediate fetch answers 200', async () => {
  const { controller, frame, time } = setup({ lastSignIn: T0 - 20 * MIN });
  frame({ entryMs: T0 - 10 * MIN });
  const pending = controller.request();
  frame({ entryMs: T0 - 1 * MIN, signs: true });
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal(result.signedIn, true);
  assert.equal(result.lastSignInAt, new Date(T0).toISOString());
  assert.equal(result.finishedAt, new Date(T0).toISOString());
  assert.equal(time.pending(), 0);
});

test('no new data answers 202 and follows up at 60 s and 150 s', async () => {
  const { controller, frame, sent, time } = setup({ lastSignIn: T0 - 5 * MIN });
  frame({ entryMs: T0 - 10 * MIN });
  const pending = controller.request();
  frame({ entryMs: T0 - 10 * MIN });
  const result = await pending;
  assert.equal(result.status, 202);
  assert.deepEqual(result.followUpAt, [new Date(T0 + 60000).toISOString(), new Date(T0 + 150000).toISOString()]);
  time.advance(60000);
  assert.deepEqual(sent, ['SYNC_NOW', 'SYNC_NOW']);
  frame({ entryMs: T0 - 10 * MIN });
  time.advance(90000);
  assert.deepEqual(sent, ['SYNC_NOW', 'SYNC_NOW', 'SYNC_NOW']);
});

test('the follow-ups stop at the first fetch with new data', async () => {
  const { controller, frame, sent, time } = setup({ lastSignIn: T0 - 5 * MIN });
  frame({ entryMs: T0 - 10 * MIN });
  const pending = controller.request();
  frame({ entryMs: T0 - 10 * MIN });
  await pending;
  time.advance(60000);
  frame({ entryMs: T0 + 30000 });
  time.advance(10 * MIN);
  assert.deepEqual(sent, ['SYNC_NOW', 'SYNC_NOW']);
  assert.equal(time.pending(), 0);
  // the sync is over: a new request starts a new one (15.5 min later, so it signs in again)
  controller.request();
  assert.deepEqual(sent.slice(2), ['RESET_SESSION', 'SYNC_NOW']);
});

test('a failed immediate fetch answers 502', async () => {
  const { controller, frame } = setup({ lastSignIn: T0 - 5 * MIN });
  const pending = controller.request();
  frame({ ok: false });
  const result = await pending;
  assert.equal(result.status, 502);
  assert.equal(typeof result.error, 'string');
});

test('no outcome within 45 s answers 202', async () => {
  const { controller, time } = setup({ lastSignIn: T0 - 5 * MIN });
  const pending = controller.request();
  time.advance(45000);
  assert.equal((await pending).status, 202);
});

test('concurrent and repeated requests share one sync and send nothing more', async () => {
  const { controller, frame, sent } = setup({ lastSignIn: T0 - 20 * MIN });
  frame({ entryMs: T0 - 10 * MIN });
  const a = controller.request();
  const b = controller.request();
  assert.deepEqual(sent, ['RESET_SESSION', 'SYNC_NOW']);
  frame({ entryMs: T0 - 10 * MIN, signs: true });
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(ra, rb);
  assert.equal(ra.status, 202);
  const c = await controller.request();   // inside the follow-up window
  assert.deepEqual(c, ra);
  assert.deepEqual(sent, ['RESET_SESSION', 'SYNC_NOW']);
});

test('the outcome of a frame that started before the request does not count', async () => {
  const { controller, frame } = setup({ lastSignIn: T0 - 5 * MIN });
  frame({ entryMs: T0 - 10 * MIN });
  controller.onFrameStart();                  // a scheduled frame is already running
  const pending = controller.request();
  controller.onTransformed({ entries: [{ date: T0 - 9 * MIN }], treatments: [] });
  controller.onFrameOutcome({ ok: true });    // ... and finishes: not ours
  let settled = false;
  pending.then(() => { settled = true; });
  await flush();
  assert.equal(settled, false);
  frame({ entryMs: T0 - 9 * MIN });           // the queued, triggered frame: nothing newer
  assert.equal((await pending).status, 202);
});

test('pump-state treatments never count as new data', async () => {
  const { controller, frame } = setup({ lastSignIn: T0 - 5 * MIN });
  frame({ entryMs: T0 - 10 * MIN, treatments: [{ created_at: new Date(T0 - 10 * MIN).toISOString() }] });
  const pending = controller.request();
  frame({ entryMs: T0 - 10 * MIN, treatments: [{ created_at: new Date(T0).toISOString(), glookoSource: 'pump-state' }] });
  assert.equal((await pending).status, 202);

  const second = setup({ lastSignIn: T0 - 5 * MIN });
  second.frame({ entryMs: T0 - 10 * MIN });
  const bolus = second.controller.request();
  second.frame({ entryMs: T0 - 10 * MIN, treatments: [{ created_at: new Date(T0).toISOString(), glookoSource: 'bolus' }] });
  assert.equal((await bolus).status, 200);
});

test('after a failed sign-in, requests within 15 minutes fail fast and trigger nothing', async () => {
  const time = fakeTime();
  const sent = [];
  let failedAt = T0 - 5 * MIN;
  const controller = createSyncController({
    send: (event) => sent.push(event.type),
    lastSignInMs: () => T0 - 60 * MIN,
    lastSignInFailureMs: () => failedAt,
    now: time.now,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
  });
  const result = await controller.request();
  assert.equal(result.status, 502);
  assert.match(result.error, /sign-in failed/i);
  assert.deepEqual(sent, []);

  // 15 minutes after the failure a request may try again
  failedAt = T0 - 15 * MIN;
  controller.request();
  assert.deepEqual(sent, ['RESET_SESSION', 'SYNC_NOW']);
});

test('a failure older than the last successful sign-in does not block', () => {
  const time = fakeTime();
  const sent = [];
  const controller = createSyncController({
    send: (event) => sent.push(event.type),
    lastSignInMs: () => T0 - 2 * MIN,
    lastSignInFailureMs: () => T0 - 5 * MIN,
    now: time.now,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
  });
  controller.request();
  assert.deepEqual(sent, ['SYNC_NOW']);
});
