const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {createRequire} = require('node:module');

function context() {
  return {bus: new EventEmitter(), bootErrors: []};
}
// Loads index.js with the sources, builder and xstate stubbed, recording which
// source each connector was built for and with which settings.
function wrapper() {
  const filename = path.resolve(__dirname, '../index.js'), localRequire = createRequire(filename);
  const state = {kinds: [], validated: [], starts: 0, stops: 0};
  const actor = {start() {state.starts++;}, stop() {state.stops++;}, send() {}};
  const driver = () => ({generate_driver() {}});
  driver.validate = (settings) => {state.validated.push(settings); return {ok: true, config: {}, errors: []};};
  const sandbox = {module: {exports: {}}, console: {log() {}}, require(name) {
    if (name === 'xstate') return {interpret: () => actor};
    if (name === './lib/sources') return (spec) => {state.kinds.push(spec.kind); return driver;};
    if (name === './lib/builder') return () => () => ({});
    if (name === './lib/outputs') return () => () => Object.assign(() => {}, {close() {}});
    return localRequire(name);
  }};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, {filename});
  return {manage: sandbox.module.exports, state};
}

test('CONNECT_MULTI_SOURCES starts one connector per listed source', () => {
  const {manage, state} = wrapper();
  const env = {extendedSettings: {connect: {multiSources: 'dexcomshare  glooko', glookoEmail: 'a@example.test'}}};

  const handles = manage(env, context());

  assert.equal(handles.length, 2);
  assert.deepEqual(state.kinds, ['dexcomshare', 'glooko']);
  assert.deepEqual(state.validated.map((s) => s.source), ['dexcomshare', 'glooko']);
  assert.ok(state.validated.every((s) => s.glookoEmail === 'a@example.test' && s.multiSources === undefined));
  assert.equal(state.starts, 2);
});

test('each connector of a multi-source setup stops on teardown', async () => {
  const {manage, state} = wrapper();
  const ctx = context();
  manage({extendedSettings: {connect: {multiSources: 'dexcomshare glooko'}}}, ctx);

  ctx.bus.emit('tearDown');

  assert.equal(state.stops, 2);
});

test('a single CONNECT_SOURCE still returns one handle', () => {
  const {manage, state} = wrapper();

  const handle = manage({extendedSettings: {connect: {source: 'glooko'}}}, context());

  assert.equal(typeof handle.run, 'function');
  assert.deepEqual(state.kinds, ['glooko']);
});
