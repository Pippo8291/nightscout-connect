'use strict';

// Nightscout's v1 upsert replaces the whole stored treatment when an
// identifier repeats. When Glooko updates a record, that would wipe what
// another app changed on the treatment (diamanage adds protein and fat, sets
// carbs to 0, edits or deletes it). So each Glooko treatment carries
// `glookoImported`, the fields as the importer last stored them. On the next
// write:
//  - a field that differs from that snapshot was changed elsewhere: it keeps
//    the stored value (including having been removed);
//  - fields the importer never wrote are carried over;
//  - nothing changed: the treatment is not posted at all;
//  - deleted (`isValid: false`, an API v3 DELETE): it stays deleted.

const SNAPSHOT = 'glookoImported';
// Maintained by Nightscout itself; never carried over or compared.
const SERVER_FIELDS = new Set([
  '_id', 'srvModified', 'srvCreated', 'mills', 'utcOffset', 'date', 'app',
  'subject', 'modifiedBy', 'isValid', 'isReadOnly', SNAPSHOT
]);
// lib/server/treatments.js prepareData: what Nightscout stores for a posted
// treatment, so the snapshot matches the stored fields exactly.
const NUMERIC = ['glucose', 'targetTop', 'targetBottom', 'carbs', 'insulin', 'duration',
  'percent', 'absolute', 'relative', 'preBolus'];
const DROP_EMPTY = ['targetTop', 'targetBottom', 'carbs', 'insulin', 'percent', 'relative', 'notes', 'preBolus'];

function asStored (row) {
  const out = JSON.parse(JSON.stringify(row));
  for (const field of SERVER_FIELDS) delete out[field];
  delete out.eventTime;
  for (const field of NUMERIC) if (field in out) out[field] = Number(out[field]);
  for (const field of DROP_EMPTY) if (field in out && !out[field]) delete out[field];
  for (const field of ['absolute', 'duration']) if (field in out && Number.isNaN(out[field])) delete out[field];
  if ('glucose' in out && (!out.glucose || Number.isNaN(out.glucose))) {
    delete out.glucose;
    delete out.glucoseType;
    delete out.units;
  }
  return out;
}

function canonical (value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function merge (row, stored) {
  const next = asStored(row);
  const base = stored[SNAPSHOT];
  const result = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!SERVER_FIELDS.has(key)) result[key] = value;
  }
  for (const key of new Set([...Object.keys(next), ...Object.keys(base || {})])) {
    // Without a snapshot nothing can be told apart as edited: the importer's
    // values apply and only foreign fields are kept.
    if (base && !same(stored[key], base[key])) continue;
    if (key in next) result[key] = next[key];
    else delete result[key];
  }
  result[SNAPSHOT] = next;
  const before = { ...stored };
  for (const field of SERVER_FIELDS) if (field !== SNAPSHOT) delete before[field];
  return same(before, result) ? null : result;
}

const glooko = (row) => typeof row.identifier === 'string' && row.identifier.startsWith('glooko:');

// `list(params)` reads treatments with v1 `find` semantics.
function preserveTreatments (list) {
  return async function prepare (rows) {
    const identifiers = [...new Set(rows.filter(glooko).map((row) => row.identifier))];
    if (!identifiers.length) return { rows, unchanged: 0 };
    const stored = new Map();
    const deleted = new Set();
    // Keep query arrays below the v1 parser's array-length threshold; the
    // created_at bound lifts Nightscout's default recent-days window.
    for (let i = 0; i < identifiers.length; i += 20) {
      const find = { identifier: { $in: identifiers.slice(i, i + 20) }, created_at: { $gte: '1970-01-01T00:00:00.000Z' } };
      for (const doc of await list({ count: 100, find })) {
        if (doc.isValid === false) deleted.add(doc.identifier);
        else stored.set(doc.identifier, doc);
      }
      // Reads leave deleted records out unless isValid is asked for.
      for (const doc of await list({ count: 100, find: { ...find, isValid: false } })) deleted.add(doc.identifier);
    }
    let unchanged = 0;
    const out = [];
    for (const row of rows) {
      if (!glooko(row)) { out.push(row); continue; }
      if (deleted.has(row.identifier)) { unchanged++; continue; }
      const doc = stored.get(row.identifier);
      if (!doc) { out.push({ ...row, [SNAPSHOT]: asStored(row) }); continue; }
      const merged = merge(row, doc);
      if (merged) out.push(merged);
      else unchanged++;
    }
    return { rows: out, unchanged };
  };
}

module.exports = { preserveTreatments, asStored, merge };
