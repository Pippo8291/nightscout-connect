/*
 * Remove duplicate CGM entries created by the capped existence-lookup bug in
 * lib/outputs/nightscout.js (entries beyond the query cap were re-inserted on
 * every sync cycle).
 *
 * Duplicates from that bug are byte-identical repeats: same `date` (exact
 * millisecond, they come from the same transform) and same `sgv`, all written
 * with device `nightscout-connect`.  One document per (date, sgv) group is
 * kept.  Entries from any other device (Dexcom etc.) are never touched, and
 * readings that merely sit close together in time are left alone.
 *
 * Dry run (default — counts only, changes nothing):
 *   mongosh "mongodb://localhost:27017/nightscout" tools/dedup-entries.js
 *
 * Actually delete:
 *   DEDUP_APPLY=1 mongosh "mongodb://localhost:27017/nightscout" tools/dedup-entries.js
 *
 * Optional: DEDUP_DEVICE (default "nightscout-connect"), DEDUP_COLLECTION
 * (default "entries").
 */

const APPLY = process.env.DEDUP_APPLY === '1';
const DEVICE = process.env.DEDUP_DEVICE || 'nightscout-connect';
const COLLECTION = process.env.DEDUP_COLLECTION || 'entries';
const DELETE_BATCH = 1000;

const coll = db.getCollection(COLLECTION);

print('dedup-entries');
print('  collection : ' + COLLECTION);
print('  device     : ' + DEVICE);
print('  mode       : ' + (APPLY ? 'APPLY — documents will be deleted' : 'DRY RUN — nothing will be deleted'));
print('  total docs : ' + coll.countDocuments({ device: DEVICE, type: 'sgv' }));
print('');

const cursor = coll.aggregate([
  { $match: { device: DEVICE, type: 'sgv' } },
  { $group: { _id: { date: '$date', sgv: '$sgv' }, ids: { $push: '$_id' }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } }
], { allowDiskUse: true });

let groups = 0;
let redundant = 0;
let deleted = 0;
let pending = [];

function flush () {
  if (!pending.length) return;
  if (APPLY) {
    deleted += coll.deleteMany({ _id: { $in: pending } }).deletedCount;
  }
  pending = [];
}

while (cursor.hasNext()) {
  const group = cursor.next();
  groups++;
  // Keep ids[0], drop the rest.
  for (let i = 1; i < group.ids.length; i++) {
    redundant++;
    pending.push(group.ids[i]);
    if (pending.length >= DELETE_BATCH) flush();
  }
  if (groups % 10000 === 0) {
    print('  ...scanned ' + groups + ' duplicated timestamps, ' + redundant + ' redundant docs so far');
  }
}
flush();

print('');
print('timestamps with duplicates : ' + groups);
print('redundant documents        : ' + redundant);
if (APPLY) {
  print('deleted                    : ' + deleted);
  print('remaining                  : ' + coll.countDocuments({ device: DEVICE, type: 'sgv' }));
} else {
  print('');
  print('Dry run — nothing was deleted. Re-run with DEDUP_APPLY=1 to remove them.');
}
