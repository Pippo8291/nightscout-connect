const assert = require('node:assert/strict');
const test = require('node:test');
const { Machine, actions, interpret } = require('xstate');

const createCycle = require('../lib/machines/cycle');
const createSession = require('../lib/machines/session');
const createPoller = require('../lib/machines/poller');
const glookoSource = require('../lib/sources/glooko');

const HOUR = 60 * 60 * 1000;

// A frame that reports data and success, then finishes after `holdMs`.
function fakeFrame (log, holdMs = 0) {
  return Machine({
    id: 'fakeFrame',
    initial: 'Run',
    states: {
      Run: {
        entry: [
          () => log.push('frame-start'),
          actions.sendParent({ type: 'TRANSFORMED_DATA', data: { entries: [{ date: 1 }], treatments: [] } }),
          actions.sendParent({ type: 'FRAME_SUCCESS' }),
        ],
        after: [{ target: 'Done', delay: holdMs }],
      },
      Done: { type: 'final', entry: () => log.push('frame-end') },
    },
  });
}

// The cycle sends its results to a parent, as the poller is in production.
function cycleFor (log, hooks = {}, holdMs = 0) {
  const cycle = createCycle({ fetchMachine: fakeFrame(log, holdMs) }, {
    name: 'Glooko',
    expected_data_interval_ms: HOUR,
    delay_per_frame_error: () => HOUR,
    ...hooks,
  });
  return Machine({
    id: 'host',
    initial: 'Run',
    on: { SYNC_NOW: { actions: actions.forwardTo('Glooko') } },
    states: { Run: { invoke: { id: 'Glooko', src: cycle } } },
  });
}

const cycleState = (service) => service.children.get('Glooko').state;

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

// Interprets `machine`, runs `fn`, and always stops it: an hour-long timer left
// running would keep the test process alive.
async function running (machine, fn) {
  const service = interpret(machine).start();
  try { await fn(service); } finally { service.stop(); }
}

test('SYNC_NOW in Ready starts a frame without waiting for the cycle delay', async () => {
  const log = [];
  await running(cycleFor(log), async (service) => {
    await tick();
    assert.equal(cycleState(service).value, 'Ready');
    service.send({ type: 'SYNC_NOW' });
    await tick();
    assert.deepEqual(log, ['frame-start', 'frame-end']);
    assert.equal(cycleState(service).value, 'After');
  });
});

test('SYNC_NOW in After starts the next frame at once, then the schedule resumes', async () => {
  const log = [];
  await running(cycleFor(log), async (service) => {
    await tick();
    service.send({ type: 'SYNC_NOW' });
    await tick();
    service.send({ type: 'SYNC_NOW' });
    await tick();
    assert.equal(log.filter((x) => x === 'frame-start').length, 2);
    assert.equal(cycleState(service).value, 'After');
  });
});

test('SYNC_NOW during a running frame queues exactly one more frame, never a parallel one', async () => {
  const log = [];
  await running(cycleFor(log, {}, 60), async (service) => {
    await tick();
    service.send({ type: 'SYNC_NOW' });
    await tick(10);
    assert.equal(cycleState(service).value, 'Operating');
    service.send({ type: 'SYNC_NOW' });
    service.send({ type: 'SYNC_NOW' });
    await tick(200);
    assert.deepEqual(log, ['frame-start', 'frame-end', 'frame-start', 'frame-end']);
    assert.equal(cycleState(service).value, 'After');
    assert.equal(cycleState(service).context.sync_queued, false);
  });
});

test('the cycle reports frame outcomes and transformed data to its hooks', async () => {
  const log = [];
  const outcomes = [];
  const transformed = [];
  await running(cycleFor(log, {
    on_frame_start: () => outcomes.push('start'),
    on_frame_outcome: (o) => outcomes.push(o),
    on_transformed: (d) => transformed.push(d),
  }), async (service) => {
    await tick();
    service.send({ type: 'SYNC_NOW' });
    await tick();
    assert.deepEqual(outcomes, ['start', { ok: true, status: undefined }]);
    assert.deepEqual(transformed, [{ entries: [{ date: 1 }], treatments: [] }]);
  });
});

test('RESET_SESSION drops the session and the next request authenticates again', async () => {
  let authentications = 0;
  const session = createSession({
    authenticate: async () => { authentications++; return { cookies: 'c' }; },
    authorize: async () => ({ user: 'u' }),
    delays: { REFRESH_AFTER_SESSSION_DELAY: HOUR, EXPIRE_SESSION_DELAY: 2 * HOUR },
  });
  const poller = createPoller(session, { services: {}, names: [], states: {} });
  await running(poller, async (service) => {
  service.send({ type: 'START' });
  service.send({ type: 'SESSION_REQUIRED' });
  await tick();
  assert.equal(authentications, 1);
  service.send({ type: 'SESSION_REQUIRED' });
  await tick();
  assert.equal(authentications, 1, 'an active session is reused');
  service.send({ type: 'RESET_SESSION' });
  await tick();
  service.send({ type: 'SESSION_REQUIRED' });
  await tick();
  assert.equal(authentications, 2);
  });
});

test('the glooko source remembers when it last signed in', async () => {
  const before = Date.now();
  const config = glookoSource.validate({ glookoEmail: 'a@example.test', glookoPassword: 'pw' }).config;
  const impl = glookoSource(config, { create: () => ({}) });
  assert.equal(impl.lastSignInMs(), null);
  let registered;
  impl.authFromCredentials = async () => ({ cookies: 'c', user: {} });
  impl.generate_driver({ support_session: (s) => { registered = s; }, register_loop: () => {} });
  await registered.authenticate();
  assert.ok(impl.lastSignInMs() >= before);
});
