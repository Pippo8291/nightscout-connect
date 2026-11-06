const assert = require('node:assert/strict');
const test = require('node:test');

const nightscoutOutput = require('../lib/outputs/nightscout');
const { unmatched } = require('../lib/outputs/entry-match');

const config = { url: 'https://example.test', apiSecret: 'secret' };
const T0 = Date.parse('2026-10-01T08:00:00.000Z');
const FIVE_MIN = 5 * 60 * 1000;

// An entries collection that caps query results the way Nightscout does.
function fakeNightscout (entries = [], { cap = 1000, failGet = false } = {}) {
  const posts = [];
  let nextId = entries.length + 1;
  const transport = { create: () => ({
    get: async (path, options) => {
      if (failGet) throw Object.assign(new Error('boom'), { response: { status: 500 } });
      if (path !== '/api/v1/entries.json') return { data: [] };
      const p = options.params || {};
      const gte = p['find[date][$gte]'];
      const lte = p['find[date][$lte]'];
      const found = entries
        .filter((e) => (gte === undefined || e.date >= gte) && (lte === undefined || e.date <= lte))
        .sort((a, b) => b.date - a.date);
      return { data: found.slice(0, Math.min(p.count || 10, cap)) };
    },
    post: async (path, body) => {
      posts.push({ path, body });
      const created = body.map((e) => ({ _id: String(nextId++), ...e }));
      if (path === '/api/v1/entries.json') entries.push(...created);
      return { data: created };
    }
  }) };
  return { entries, posts, transport };
}

const reading = (date, sgv, device = 'nightscout-connect-glooko') =>
  ({ type: 'sgv', device, date, dateString: new Date(date).toISOString(), sgv });

test('a Glooko reading seconds away from the stored Dexcom reading is not posted', async () => {
  const dexcom = { _id: 'dex-1', ...reading(T0, 120, 'share2') };
  const ns = fakeNightscout([dexcom]);

  await nightscoutOutput(config, ns.transport)({ entries: [reading(T0 + 20 * 1000, 120)] });

  assert.equal(ns.posts.length, 0);
  assert.deepEqual(ns.entries, [dexcom]);
});

test('a reading with a different value or outside the window fills the gap', async () => {
  const ns = fakeNightscout([{ _id: 'dex-1', ...reading(T0, 120, 'share2') }]);
  const otherValue = reading(T0 + 10 * 1000, 121);
  const gap = reading(T0 + 2 * 60 * 1000, 120);

  await nightscoutOutput(config, ns.transport)({ entries: [otherValue, gap] });

  assert.deepEqual(ns.posts.map((p) => p.body), [[otherValue, gap]]);
});

test('recording the same batch twice stores each reading once', async () => {
  const ns = fakeNightscout();
  const batch = { entries: [reading(T0, 100), reading(T0 + FIVE_MIN, 105)] };

  await nightscoutOutput(config, ns.transport)(batch);
  await nightscoutOutput(config, ns.transport)(batch);

  assert.equal(ns.entries.length, 2);
});

test('the lookup pages past the server cap instead of re-inserting what it cannot see', async () => {
  const readings = Array.from({ length: 1500 }, (_, i) => reading(T0 + i * FIVE_MIN, 100 + (i % 50)));
  const ns = fakeNightscout(readings.map((r, i) => ({ _id: 'old-' + i, ...r })));

  await nightscoutOutput(config, ns.transport)({ entries: readings });

  assert.equal(ns.posts.length, 0);
  assert.equal(ns.entries.length, 1500);
});

test('the entries bookmark moves to the newest reading even when all were already stored', async () => {
  const readings = [reading(T0, 100), reading(T0 + FIVE_MIN, 105)];
  const ns = fakeNightscout(readings.map((r, i) => ({ _id: 'old-' + i, ...r })));

  const bookmark = await nightscoutOutput(config, ns.transport)({ entries: readings.slice().reverse() });

  assert.equal(bookmark.entries.getTime(), T0 + FIVE_MIN);
});

test('a failed lookup fails the frame instead of posting blind', async () => {
  const ns = fakeNightscout([], { failGet: true });

  await assert.rejects(nightscoutOutput(config, ns.transport)({ entries: [reading(T0, 100)] }), /Nightscout write failed/);
  assert.equal(ns.posts.length, 0);
});

test('entries without a numeric date pass through unmatched', () => {
  const undated = { dateString: '2026-10-01T08:00:00.000Z', sgv: 100 };
  assert.deepEqual(unmatched([undated], [reading(T0, 100)]), [undated]);
});
