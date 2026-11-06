'use strict';

// A new Glooko sign-in prompts the account to sync, so renewing the session
// at fixed local times (for example around meals) pulls fresh pump data in at
// those times instead of whenever the 24 h session happens to run out.
const { timestampWithOffset, toGlookoTime } = require('./timezone');

const DAY_MS = 24 * 60 * 60 * 1000;

// "08:30,12:30,18:30,23:59" -> minutes after local midnight, sorted.
// Returns null for anything that is not a list of valid HH:MM times.
function parseTimes (value) {
  if (value === undefined || value === null || value === '') return null;
  const parts = String(value).split(',').map((part) => part.trim());
  const minutes = [];
  for (const part of parts) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(part);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
    minutes.push(Number(match[1]) * 60 + Number(match[2]));
  }
  return [...new Set(minutes)].sort((a, b) => a - b);
}

// Milliseconds from `now` until the next listed local clock time, using the
// same timezone settings that convert Glooko's own timestamps.
function msUntilNext (times, now, opts) {
  const local = toGlookoTime(now, opts.glookoTimezoneOffset, opts.glookoTimezone);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  for (let day = 0; day <= 1; day++) {
    for (const minute of times) {
      const wall = new Date(midnight + day * DAY_MS + minute * 60 * 1000).toISOString();
      const at = timestampWithOffset(wall, opts.glookoTimezoneOffset, opts.glookoTimezone).getTime();
      if (at > now) return at - now;
    }
  }
  return DAY_MS;
}

module.exports = { parseTimes, msUntilNext };
