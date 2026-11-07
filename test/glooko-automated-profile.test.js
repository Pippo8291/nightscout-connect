'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const glooko = require('../lib/sources/glooko');
const { transform } = require('../lib/sources/glooko/map');
const { mapProfiles } = require('../lib/sources/glooko/profile');
const { DELIVERY_SERIES } = require('../lib/sources/glooko/pump-state');
const reconcile = require('../lib/outputs/glooko-pump-state');

const opts = { glookoEmail: 'synthetic@example.test', glookoTimezone: 'Europe/Berlin' };
const automated = { ...opts, glookoAutomatedProfile: true };

const settings = {
  guid: 'profile',
  pump_timestamp: '2026-07-01T12:00:00.000Z',
  active_insulin_time: 14400,
  basal_settings: [{ is_current: true, segments: [{ start: 0, rate: 0.7 }, { start: 21600, rate: 0.9 }] }],
  bolus_settings: [{
    current: true,
    isf_segments: [{ start: 0, insulin_sensitivity_factor: 5000 }],
    insulin_to_carb_ratio_segments: [{ start: 0, insulin_to_carbs_ratio: 10 }],
    target_bg_segments: [{ start: 0, target_bg_low: 9000, target_bg_high: 11000 }]
  }]
};

function batch(series = {}) {
  return {
    glookoGraphWindow: { start: '2026-07-01T00:00:00.000Z', end: '2026-07-02T00:00:00.000Z' },
    v3Graph: { series: { ...Object.fromEntries(DELIVERY_SERIES.map((k) => [k, []])), ...series } }
  };
}
const interval = (from, to) => ({ timestamp: from, endTimestamp: to, duration: (Date.parse(to) - Date.parse(from)) / 1000 });

test('the automated profile has no basal by default and the pump program as Manual', () => {
  const [p] = mapProfiles([settings], automated);
  assert.equal(p.defaultProfile, 'Automated');
  assert.deepEqual(Object.keys(p.store).sort(), ['Automated', 'Manual']);
  assert.deepEqual(p.store.Automated.basal, [{ time: '00:00', timeAsSeconds: 0, value: 0 }]);
  assert.deepEqual(p.store.Manual.basal.map((b) => b.value), [0.7, 0.9]);
  assert.equal(p.store.Automated.sens[0].value, p.store.Manual.sens[0].value);
  assert.equal(p.store.Automated.dia, 4);
});

test('without the option the profile stays upstream\'s single Glooko profile', () => {
  const [plain] = mapProfiles([settings], opts);
  const [auto] = mapProfiles([settings], automated);
  assert.deepEqual(Object.keys(plain.store), ['Glooko']);
  assert.equal(plain.defaultProfile, 'Glooko');
  assert.notEqual(plain.identifier, auto.identifier);
});

test('a manual-mode interval switches to the Manual profile for its duration', () => {
  const out = transform(batch({
    pumpOp5AutomaticMode: [interval('2026-07-01T08:00:00Z', '2026-07-01T12:00:00Z')],
    pumpOp5ManualMode: [interval('2026-07-01T12:00:00Z', '2026-07-01T13:30:00Z')]
  }), automated);

  const switches = out.treatments.filter((t) => t.eventType === 'Profile Switch');
  assert.equal(switches.length, 1);
  assert.equal(switches[0].profile, 'Manual');
  assert.equal(switches[0].duration, 90);
  assert.equal(switches[0].created_at, '2026-07-01T10:00:00.000Z');
  assert.ok(switches[0].identifier.startsWith('glooko:pump-state:'));
  // The state note is still there, with its own identity.
  const note = out.treatments.find((t) => t.eventType === 'Note' && t.notes === 'Manual mode (1 h 30 min)');
  assert.ok(note);
  assert.notEqual(note.identifier, switches[0].identifier);

  const window = out.glookoSync.pumpStateWindow;
  assert.deepEqual(window.eventTypes, ['Note', 'Exercise', 'Profile Switch']);
  assert.ok(window.identifiers.includes(switches[0].identifier));
});

test('the switch keeps its identity while Glooko extends the interval', () => {
  const first = transform(batch({ pumpOp5ManualMode: [interval('2026-07-01T12:00:00Z', '2026-07-01T12:30:00Z')] }), automated);
  const later = transform(batch({ pumpOp5ManualMode: [interval('2026-07-01T12:00:00Z', '2026-07-01T13:00:00Z')] }), automated);
  const id = (out) => out.treatments.find((t) => t.eventType === 'Profile Switch').identifier;
  assert.equal(id(first), id(later));
});

test('without the option no profile switch is written or reconciled', () => {
  const out = transform(batch({ pumpOp5ManualMode: [interval('2026-07-01T12:00:00Z', '2026-07-01T13:00:00Z')] }), opts);
  assert.equal(out.treatments.filter((t) => t.eventType === 'Profile Switch').length, 0);
  assert.deepEqual(out.glookoSync.pumpStateWindow.eventTypes, ['Note', 'Exercise']);
});

test('reconciliation removes obsolete profile switches as well as notes', async () => {
  const window = {
    accountKey: 'synthetic-owner',
    from: '2026-07-01T00:00:00Z',
    to: '2026-07-02T00:00:00Z',
    identifiers: ['glooko:pump-state:keep'],
    eventTypes: ['Note', 'Profile Switch']
  };
  const queried = [];
  const deletes = [];
  await reconcile(
    window,
    async (query) => {
      queried.push(query.find.eventType);
      return [{ identifier: 'glooko:pump-state:keep' }, { identifier: 'glooko:pump-state:old-' + query.find.eventType }];
    },
    async (query) => deletes.push(query.find)
  );
  assert.deepEqual(queried, ['Note', 'Profile Switch']);
  assert.deepEqual(deletes.map((d) => [d.eventType, d.identifier.$in]), [
    ['Note', ['glooko:pump-state:old-Note']],
    ['Profile Switch', ['glooko:pump-state:old-Profile Switch']]
  ]);
});

test('the automated profile requires profile import', () => {
  const base = { glookoEmail: 'a@example.test', glookoPassword: 'pw', glookoTimezone: 'Europe/Berlin' };
  const without = glooko.validate({ ...base, glookoAutomatedProfile: 'true' });
  assert.equal(without.ok, false);
  assert.ok(without.errors.some((e) => /AUTOMATED_PROFILE/.test(e.err.message)));

  const valid = glooko.validate({ ...base, glookoAutomatedProfile: 'true', glookoImportProfile: 'true' });
  assert.equal(valid.ok, true);
  assert.equal(valid.config.glookoAutomatedProfile, true);
  assert.equal(glooko.validate(base).config.glookoAutomatedProfile, false);
});
