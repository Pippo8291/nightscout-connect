'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const pumpData = require('../lib/outputs/glooko-pump-data');
const restOutput = require('../lib/outputs/nightscout');
const internalOutput = require('../lib/outputs/internal');
const owner = 'glooko:pump-state-owner:' + 'a'.repeat(64);
const other = 'glooko:pump-state-owner:' + 'b'.repeat(64);

function markerStore() {
  let docs = [],
    id = 0,
    creates = 0;
  const list = async ({ find }) =>
    docs
      .filter(
        (d) =>
          d.device === find.device &&
          (!find['glookoPumpData.owner'] || d.glookoPumpData.owner === find['glookoPumpData.owner'])
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const create = async (rows) => {
    creates++;
    docs.push(...structuredClone(rows).map((r) => ({ ...r, _id: String(++id) })));
    return rows;
  };
  const remove = async ({ find }) => {
    assert.equal(find.device, pumpData.DEVICE);
    assert.equal(find['glookoPumpData.owner'], owner);
    docs = docs.filter(
      (d) =>
        !(
          d.device === find.device &&
          d.glookoPumpData.owner === find['glookoPumpData.owner'] &&
          find._id.$in.includes(d._id)
        )
    );
  };
  return { list, create, remove, docs: () => docs, creates: () => creates, seed: (row) => docs.push(row) };
}
const mine = (store) => store.docs().filter((d) => d.glookoPumpData.owner === owner);

test('one marker per owner, rewritten only when until moves forward', async () => {
  const store = markerStore();
  const save = (data) => pumpData.save(data, store.list, store.create, store.remove);
  await save({ owner, until: '2026-07-01T10:00:00.000Z' });
  await save({ owner: other, until: '2026-07-01T09:00:00.000Z' });
  const [first] = mine(store);
  assert.deepEqual(Object.keys(first).sort(), ['_id', 'created_at', 'device', 'glookoPumpData']);
  assert.equal(first.device, 'nightscout-connect-glooko-pump-data');
  assert.deepEqual(first.glookoPumpData, { owner, until: '2026-07-01T10:00:00.000Z' });
  // Unchanged and older: no write, the stored until stays.
  await save({ owner, until: '2026-07-01T10:00:00.000Z' });
  await save({ owner, until: '2026-07-01T09:30:00.000Z' });
  assert.equal(store.creates(), 2);
  assert.deepEqual(mine(store), [first]);
  await save({ owner, until: '2026-07-01T11:00:00.000Z' });
  const [next] = mine(store);
  assert.equal(mine(store).length, 1);
  assert.equal(next.glookoPumpData.until, '2026-07-01T11:00:00.000Z');
  assert(Date.parse(next.created_at) > Date.parse(first.created_at));
  assert.equal(store.docs().find((d) => d.glookoPumpData.owner === other).glookoPumpData.until,
    '2026-07-01T09:00:00.000Z');
});

test('older markers of the owner are removed, also when until is unchanged', async () => {
  const store = markerStore();
  const until = '2026-07-01T10:00:00.000Z';
  store.seed({ _id: 'old', device: pumpData.DEVICE, created_at: '2026-07-01T09:00:00.000Z',
    glookoPumpData: { owner, until: '2026-07-01T08:00:00.000Z' } });
  store.seed({ _id: 'new', device: pumpData.DEVICE, created_at: '2026-07-01T10:05:00.000Z',
    glookoPumpData: { owner, until } });
  await pumpData.save({ owner, until }, store.list, store.create, store.remove);
  assert.equal(store.creates(), 0);
  assert.deepEqual(mine(store).map((d) => d._id), ['new']);
});

test('invalid markers fail explicitly', async () => {
  const store = markerStore();
  for (const data of [
    { owner: 'a'.repeat(64), until: '2026-07-01T10:00:00.000Z' },
    { owner, until: 'yesterday' },
    { owner, until: null }
  ])
    await assert.rejects(pumpData.save(data, store.list, store.create, store.remove), /GLOOKO_INVALID_PUMP_DATA/);
  await assert.rejects(
    pumpData.save({ owner, until: '2026-07-01T10:00:00.000Z' }, async () => Array(100).fill({}), store.create, store.remove),
    /GLOOKO_PUMP_DATA_LIMIT/
  );
  assert.equal(store.creates(), 0);
});

for (const kind of ['REST', 'internal'])
  test(kind + ' output writes the marker only after the clinical writes succeed', async () => {
    const store = markerStore();
    let failWrites = false,
      failMarker = false;
    function output() {
      if (kind === 'REST')
        return restOutput(
          { url: 'http://localhost', apiSecret: 'synthetic' },
          {
            create: () => ({
              get: async (path, { params }) => ({
                data: params.find?.device === pumpData.DEVICE ? await store.list(params) : []
              }),
              post: async (path, rows) => {
                if (rows[0]?.device === pumpData.DEVICE) {
                  if (failMarker) throw new Error('synthetic');
                  await store.create(rows);
                } else if (failWrites) throw new Error('synthetic');
                return { data: rows };
              },
              delete: async (path, { params }) => store.remove(params)
            })
          }
        );
      const ctx = { bus: new EventEmitter() };
      for (const name of ['entries', 'treatments', 'profile', 'devicestatus'])
        ctx[name] = {
          create: (rows, cb) => {
            if (rows[0]?.device === pumpData.DEVICE) {
              if (failMarker) return cb(new Error('synthetic'));
              store.create(rows).then((r) => cb(null, r));
            } else cb(failWrites ? new Error('synthetic') : null, rows);
          },
          list: (params, cb) => store.list(params).then((r) => cb(null, r)),
          remove: (params, cb) => store.remove(params).then((r) => cb(null, r))
        };
      return internalOutput({}, ctx);
    }
    const write = output();
    const frame = (until) => ({
      entries: [{ dateString: '2026-07-01T10:55:00.000Z' }],
      glookoSync: { cursors: {}, pumpData: { owner, until } }
    });
    failWrites = true;
    await assert.rejects(write(frame('2026-07-01T11:00:00.000Z')));
    assert.equal(store.docs().length, 0);
    failWrites = false;
    failMarker = true;
    await assert.rejects(write(frame('2026-07-01T11:00:00.000Z')));
    assert.equal(store.docs().length, 0);
    failMarker = false;
    await write(frame('2026-07-01T11:00:00.000Z'));
    await write(frame('2026-07-01T11:00:00.000Z'));
    assert.equal(store.creates(), 1);
    assert.deepEqual(store.docs().map((d) => d.glookoPumpData), [{ owner, until: '2026-07-01T11:00:00.000Z' }]);
    await output()(frame('2026-07-01T11:30:00.000Z'));
    assert.deepEqual(store.docs().map((d) => d.glookoPumpData), [{ owner, until: '2026-07-01T11:30:00.000Z' }]);
    assert(store.docs().every((d) => !d.pump));
  });
