const assert = require('node:assert/strict');
const test = require('node:test');

const nightscoutOutput = require('../lib/outputs/nightscout');
const internalOutput = require('../lib/outputs/internal');
const { merge, asStored } = require('../lib/outputs/glooko-preserve');

const config = { url: 'https://example.test', apiSecret: 'secret' };

// Nightscout's v1 treatment storage, as far as it matters here: eventTime is
// dropped, numbers are coerced, empty carbs/insulin/notes are removed, a
// repeated identifier replaces the whole document (keeping _id), and reads
// leave out isValid:false documents unless isValid is asked for.
function fakeTreatments () {
  const docs = [];
  let nextId = 1;
  const posts = [];
  function prepare (row) {
    const doc = { ...row };
    if (doc.eventTime) doc.created_at = new Date(doc.eventTime).toISOString();
    delete doc.eventTime;
    for (const f of ['carbs', 'insulin', 'duration']) if (f in doc) doc[f] = Number(doc[f]);
    for (const f of ['carbs', 'insulin', 'notes']) if (f in doc && !doc[f]) delete doc[f];
    doc.utcOffset = 0;
    return doc;
  }
  function list (params = {}) {
    const find = params.find || {};
    return docs.filter((doc) => {
      // glooko-legacy asks for identifier-less imports with $exists.
      if (find.identifier?.$exists === false && doc.identifier) return false;
      if (find.identifier?.$in && !find.identifier.$in.includes(doc.identifier)) return false;
      if ('isValid' in find) return doc.isValid === find.isValid;
      return doc.isValid !== false;
    }).map((doc) => JSON.parse(JSON.stringify(doc)));
  }
  function create (rows) {
    posts.push(rows.map((r) => ({ ...r })));
    return rows.map((row) => {
      const doc = prepare(row);
      const index = docs.findIndex((d) => d.identifier === doc.identifier);
      if (index >= 0) docs[index] = { ...doc, _id: docs[index]._id };
      else docs.push({ ...doc, _id: String(nextId++) });
      return docs[docs.length - 1];
    });
  }
  // What an API v3 PATCH (diamanage) does: set fields on the stored document.
  function patch (identifier, fields) {
    const doc = docs.find((d) => d.identifier === identifier);
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) delete doc[key];
      else doc[key] = value;
    }
    doc.srvModified = Date.now();
  }
  const transport = { create: () => ({
    get: async (path, options) => ({ data: path === '/api/v1/treatments.json' ? list(options.params) : [] }),
    post: async (path, body) => ({ data: path === '/api/v1/treatments.json' ? create(body) : body })
  }) };
  return { docs, posts, list, create, patch, transport };
}

const bolus = (fields = {}) => ({
  identifier: 'glooko:bolus:abc',
  eventTime: '2026-07-01T10:00:00.000Z',
  created_at: '2026-07-01T10:00:00.000Z',
  enteredBy: 'nightscout-connect-glooko',
  eventType: 'Meal Bolus',
  insulin: 4,
  carbs: 30,
  glookoGuid: 'g-1',
  glookoSource: 'bolus',
  ...fields
});

async function write (ns, rows) {
  await nightscoutOutput(config, ns.transport)({ treatments: rows });
}

test('a new Glooko treatment is stored with a snapshot of what was written', async () => {
  const ns = fakeTreatments();
  await write(ns, [bolus()]);
  assert.equal(ns.docs.length, 1);
  assert.deepEqual(ns.docs[0].glookoImported, asStored(bolus()));
  assert.equal(ns.docs[0].glookoImported.eventTime, undefined);
});

test('an unchanged treatment is not posted again', async () => {
  const ns = fakeTreatments();
  await write(ns, [bolus()]);
  await write(ns, [bolus()]);
  assert.equal(ns.posts.length, 1);
});

test('fields another app added survive a Glooko update', async () => {
  const ns = fakeTreatments();
  await write(ns, [bolus()]);
  ns.patch('glooko:bolus:abc', { protein: 20, fat: 15 });

  await write(ns, [bolus({ insulin: 4.5 })]);

  const [doc] = ns.docs;
  assert.equal(doc.insulin, 4.5);
  assert.equal(doc.protein, 20);
  assert.equal(doc.fat, 15);
  assert.equal(ns.docs.length, 1);
});

test('a field another app changed or removed keeps that change', async () => {
  const ns = fakeTreatments();
  await write(ns, [bolus()]);
  // diamanage's correction: carbs=0, which Nightscout stores as no carbs.
  ns.patch('glooko:bolus:abc', { carbs: undefined, notes: 'superseded by diamanage: meal 12' });

  await write(ns, [bolus({ insulin: 5 })]);

  const [doc] = ns.docs;
  assert.equal(doc.carbs, undefined);
  assert.equal(doc.notes, 'superseded by diamanage: meal 12');
  assert.equal(doc.insulin, 5);
});

test('a treatment deleted through API v3 stays deleted', async () => {
  const ns = fakeTreatments();
  await write(ns, [bolus()]);
  ns.patch('glooko:bolus:abc', { isValid: false });

  await write(ns, [bolus({ insulin: 5 })]);

  assert.equal(ns.posts.length, 1);
  assert.equal(ns.docs[0].isValid, false);
});

test('without a snapshot the importer\'s values apply and foreign fields stay', () => {
  const stored = { ...asStored(bolus()), _id: '1', utcOffset: 0, insulin: 3, protein: 10 };
  const merged = merge(bolus(), stored);
  assert.equal(merged.insulin, 4);
  assert.equal(merged.protein, 10);
  assert.equal(merged._id, undefined);
  assert.equal(merged.utcOffset, undefined);
});

test('treatments without a Glooko identifier are posted as before', async () => {
  const ns = fakeTreatments();
  const manual = { eventType: 'Note', created_at: '2026-07-01T10:00:00.000Z', notes: 'hi' };
  await write(ns, [manual]);
  await write(ns, [manual]);
  assert.equal(ns.posts.length, 2);
  assert.equal(ns.docs[0].glookoImported, undefined);
});

test('the embedded output keeps other apps\' changes too', async () => {
  const ns = fakeTreatments();
  const callback = (fn) => (params, cb) => { try { cb(null, fn(params)); } catch (err) { cb(err); } };
  const ctx = {
    bus: { on () {}, removeListener () {}, emit () {} },
    entries: { create: (rows, cb) => cb(null, rows) },
    devicestatus: { create: (rows, cb) => cb(null, rows), list: (p, cb) => cb(null, []), remove: (p, cb) => cb(null) },
    profile: { create: (rows, cb) => cb(null, rows), list: (p, cb) => cb(null, []) },
    treatments: { create: callback((rows) => ns.create(rows)), list: callback((params) => ns.list(params)), remove: (p, cb) => cb(null) }
  };
  const output = internalOutput({}, ctx);
  await output({ treatments: [bolus()] });
  ns.patch('glooko:bolus:abc', { protein: 20 });
  await output({ treatments: [bolus({ insulin: 6 })] });
  await output({ treatments: [bolus({ insulin: 6 })] });

  assert.equal(ns.posts.length, 2);
  assert.equal(ns.docs[0].protein, 20);
  assert.equal(ns.docs[0].insulin, 6);
});
