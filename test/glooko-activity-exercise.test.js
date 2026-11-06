'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transform } = require('../lib/sources/glooko/map');
const { DELIVERY_SERIES, durationLabel } = require('../lib/sources/glooko/pump-state');

const opts = { glookoEmail: 'synthetic@example.test', glookoTimezone: 'Europe/Berlin' };
const sec = (iso) => Date.parse(iso) / 1000;
function rect(from, to) {
  return [
    { x: from, y: 0 },
    { x: from, y: 1 },
    { x: to, y: 1 },
    { x: to, y: 0 },
    { x: to, y: null }
  ];
}
function batch(series = {}) {
  return {
    glookoGraphWindow: { start: '2026-07-01T00:00:00.000Z', end: '2026-07-02T00:00:00.000Z' },
    v3Graph: { series: { ...Object.fromEntries(DELIVERY_SERIES.map((k) => [k, []])), ...series } }
  };
}
// Glooko's graph timestamps are local wall time with a Z; 12:00Z here is
// 12:00 in Berlin, 10:00 UTC in summer.
const interval = (from, to) => ({ timestamp: from, endTimestamp: to, duration: (Date.parse(to) - Date.parse(from)) / 1000 });
const exercises = (out) => out.treatments.filter((t) => t.eventType === 'Exercise');

test('activity mode becomes one Exercise labelled with its duration', () => {
  // Delivery states change underneath the activity session; it is still one session.
  const out = transform(batch({
    pumpOp5HypoprotectMode: [interval('2026-07-01T12:00:00Z', '2026-07-01T13:30:00Z')],
    basalBarAutomated: rect(sec('2026-07-01T12:00:00Z'), sec('2026-07-01T12:40:00Z')),
    basalBarAutomatedSuspend: rect(sec('2026-07-01T12:40:00Z'), sec('2026-07-01T13:00:00Z')),
    basalBarAutomatedMax: rect(sec('2026-07-01T13:00:00Z'), sec('2026-07-01T13:30:00Z'))
  }), opts);

  const [ex] = exercises(out);
  assert.equal(exercises(out).length, 1);
  assert.equal(ex.created_at, '2026-07-01T10:00:00.000Z');
  assert.equal(ex.duration, 90);
  assert.equal(ex.notes, '1 h 30 min');
  assert.deepEqual(ex.activityMode, {
    type: 'hypoprotect',
    timestamp: '2026-07-01T10:00:00.000Z',
    endTimestamp: '2026-07-01T11:30:00.000Z',
    duration: 5400
  });
  assert.equal(ex.glookoSource, 'pump-state');
  for (const field of ['insulin', 'carbs', 'rate', 'absolute']) assert.equal(ex[field], undefined);
  assert.ok(out.glookoSync.pumpStateWindow.identifiers.includes(ex.identifier));
});

test('the Exercise keeps its identity while the session is still growing', () => {
  const first = transform(batch({ pumpOp5HypoprotectMode: [interval('2026-07-01T12:00:00Z', '2026-07-01T12:20:00Z')] }), opts);
  const later = transform(batch({ pumpOp5HypoprotectMode: [interval('2026-07-01T12:00:00Z', '2026-07-01T13:00:00Z')] }), opts);
  assert.equal(exercises(first)[0].identifier, exercises(later)[0].identifier);
  assert.equal(exercises(later)[0].notes, '1 h');
});

test('separate activity sessions stay separate and other modes add no Exercise', () => {
  const out = transform(batch({
    pumpOp5HypoprotectMode: [
      interval('2026-07-01T08:00:00Z', '2026-07-01T08:45:00Z'),
      interval('2026-07-01T15:00:00Z', '2026-07-01T16:00:00Z')
    ],
    pumpOp5ManualMode: [interval('2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z')]
  }), opts);
  assert.deepEqual(exercises(out).map((e) => e.notes), ['45 min', '1 h']);
});

test('duration labels stay short', () => {
  assert.equal(durationLabel(5), '5 min');
  assert.equal(durationLabel(60), '1 h');
  assert.equal(durationLabel(135.4), '2 h 15 min');
});
