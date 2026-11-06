'use strict';

// Glooko reports a CGM reading a few seconds away from the timestamp the
// CGM's own uploader (Dexcom Share) stored for it. Nightscout upserts entries
// on their exact date, so both would be kept. A stored reading with the same
// value within this window is the same measurement: it stays as it is and
// the incoming copy is not posted.
const TOLERANCE_MS = 60 * 1000;

// Nightscout caps how many documents one query returns. Asking for a single
// capped page makes every entry beyond the cap look new, which re-inserts it
// on every cycle - so the window is paged through, newest first.
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

async function storedBetween (get, minTime, maxTime) {
  const collected = [];
  const seen = new Set();
  let upper = maxTime;
  for (let page = 0; page < MAX_PAGES; page++) {
    const docs = (await get({ 'find[date][$gte]': minTime, 'find[date][$lte]': upper, count: PAGE_SIZE })) || [];
    let added = 0;
    let oldest = upper;
    for (const doc of docs) {
      if (Number.isFinite(doc.date) && doc.date < oldest) oldest = doc.date;
      const id = doc._id && String(doc._id.$oid || doc._id);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      collected.push(doc);
      added++;
    }
    // A short page ends the window. `added === 0` stops a server that ignores
    // the narrowed bound from looping; the inclusive bound returns the
    // boundary document once more, which `seen` filters.
    if (docs.length < PAGE_SIZE || added === 0) return collected;
    upper = oldest;
  }
  return collected;
}

function window (entries, tolerance = TOLERANCE_MS) {
  const dates = entries.map((e) => e.date).filter(Number.isFinite);
  if (!dates.length) return null;
  return { minTime: Math.min(...dates) - tolerance, maxTime: Math.max(...dates) + tolerance };
}

// Entries without a numeric date cannot be matched and pass through.
function unmatched (entries, stored, tolerance = TOLERANCE_MS) {
  const bySgv = new Map();
  for (const doc of stored) {
    if (!Number.isFinite(doc.date)) continue;
    if (!bySgv.has(doc.sgv)) bySgv.set(doc.sgv, []);
    bySgv.get(doc.sgv).push(doc.date);
  }
  return entries.filter((entry) => {
    if (!Number.isFinite(entry.date)) return true;
    const dates = bySgv.get(entry.sgv) || [];
    return !dates.some((date) => Math.abs(date - entry.date) <= tolerance);
  });
}

module.exports = { TOLERANCE_MS, PAGE_SIZE, storedBetween, window, unmatched };
