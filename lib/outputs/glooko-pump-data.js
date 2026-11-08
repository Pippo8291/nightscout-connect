'use strict';

// Public freshness marker: up to when Glooko has pump data (the end of the
// newest delivery-state interval, normal automated delivery included). Not a
// pump status: no `pump` field, so Nightscout's IOB/pump pills ignore it.
// Persist only after the clinical writes succeed. Keep one record per owner;
// `until` never moves backwards.
const DEVICE = 'nightscout-connect-glooko-pump-data';
const epoch = '1970-01-01T00:00:00.000Z';
// The pump-state accountKey (glookoPumpState.accountKey on the state notes).
const OWNER = /^glooko:pump-state-owner:[a-f0-9]{64}$/;
const find = (owner) => ({ device: DEVICE, created_at: { $gte: epoch }, 'glookoPumpData.owner': owner });
const error = (code) => Object.assign(new Error(code), { code });
function valid(data) {
  return (
    OWNER.test(data?.owner || '') &&
    typeof data.until === 'string' &&
    Number.isFinite(Date.parse(data.until)) &&
    new Date(data.until).toISOString() === data.until
  );
}
async function save(data, list, create, remove) {
  if (!data) return;
  if (!valid(data)) throw error('GLOOKO_INVALID_PUMP_DATA');
  const query = find(data.owner);
  const previous = await list({ find: query, count: 100 });
  if (previous.length >= 100) throw error('GLOOKO_PUMP_DATA_LIMIT');
  const stored = Date.parse(previous[0]?.glookoPumpData?.until);
  // Unchanged or older: the stored record stays.
  const keep = stored >= Date.parse(data.until);
  if (!keep) {
    const latest = Date.parse(previous[0]?.created_at) || 0;
    await create([
      {
        device: DEVICE,
        created_at: new Date(Math.max(Date.now(), latest + 1)).toISOString(),
        glookoPumpData: { owner: data.owner, until: data.until }
      }
    ]);
  }
  const obsolete = (keep ? previous.slice(1) : previous).map((r) => r._id).filter(Boolean);
  if (obsolete.length) await remove({ find: { ...query, _id: { $in: obsolete } } });
}
module.exports = { DEVICE, save };
