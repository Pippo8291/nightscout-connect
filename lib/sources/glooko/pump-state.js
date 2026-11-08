'use strict';

const DELIVERY = {
  basalBarAutomated: { state: 'automated', label: 'Automated delivery', priority: 5 },
  basalBarAutomatedMax: { state: 'maximum', label: 'Maximum automated delivery', priority: 6 },
  basalBarAutomatedSuspend: { state: 'paused', label: 'Automated delivery paused', priority: 7 }
};
const MODES = {
  pumpOp5AutomaticMode: { state: 'automatic', label: 'Automated mode', priority: 1 },
  pumpOp5ManualMode: { state: 'manual', label: 'Manual mode', priority: 2 },
  pumpOp5LimitedMode: { state: 'limited', label: 'Limited automated mode', priority: 3 },
  pumpOp5HypoprotectMode: { state: 'activity', label: 'Activity mode', priority: 4 }
};
const DELIVERY_SERIES = Object.keys(DELIVERY);
const MANUAL_PROFILE = 'Manual';
const DAY_MS = 86400000;
const OP5_MODE_SERIES = Object.keys(MODES);

function invalid() {
  return Object.assign(new Error('GLOOKO_INVALID_DELIVERY_STATE_GRAPH'), {
    code: 'GLOOKO_INVALID_DELIVERY_STATE_GRAPH'
  });
}

// The live graph uses five drawing points per rectangle: (start,0),
// (start,1), (end,1), (end,0), (end,null). Y is NEVER a dose or rate.
function rectangles(rows) {
  if (!Array.isArray(rows) || rows.length % 5) throw invalid();
  const out = [];
  for (let i = 0; i < rows.length; i += 5) {
    const [a, b, c, d, separator] = rows.slice(i, i + 5);
    if (
      ![a, b, c, d, separator].every((r) => r && Number.isFinite(r.x)) ||
      a.y !== 0 ||
      b.y !== 1 ||
      c.y !== 1 ||
      d.y !== 0 ||
      separator.y !== null ||
      a.x !== b.x ||
      c.x !== d.x ||
      d.x !== separator.x ||
      c.x < a.x
    )
      throw invalid();
    if (c.x > a.x) out.push({ start: a.x * 1000, end: c.x * 1000 });
  }
  return out;
}

// Contiguous intervals in one pump mode, whatever the delivery state under
// them, form one session. Like the notes they split at local midnight, so a
// session keeps its identity (its start) while the graph window advances.
function sessions(merged, mode) {
  const out = [];
  for (const r of merged) {
    if (r.mode !== mode) continue;
    const last = out[out.length - 1];
    if (last && last.end === r.start && Math.floor(last.start / DAY_MS) === Math.floor(r.start / DAY_MS))
      last.end = r.end;
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

function durationLabel(minutes) {
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60),
    rest = total % 60;
  if (!hours) return rest + ' min';
  return hours + ' h' + (rest ? ' ' + rest + ' min' : '');
}

function mapStateNotes(batch, opts, { dateFor, identifier }) {
  const series = batch.v3Graph?.series || {};
  // Older/unsupported graph responses must not erase previously imported notes.
  if (!DELIVERY_SERIES.every((name) => Array.isArray(series[name]))) return null;
  const raw = [];
  for (const [name, spec] of Object.entries(DELIVERY)) {
    for (const span of rectangles(series[name])) raw.push({ ...span, ...spec, series: name });
  }
  for (const [name, spec] of Object.entries(MODES)) {
    const seen = new Set();
    for (const row of series[name] || []) {
      if (!row.timestamp || !row.endTimestamp) continue;
      const start = Date.parse(row.timestamp),
        end = Date.parse(row.endTimestamp);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw invalid();
      const key = start + ':' + end;
      if (end === start || seen.has(key)) continue;
      seen.add(key);
      raw.push({ start, end, ...spec, series: name });
    }
  }
  const window = batch.glookoGraphWindow;
  const from = window ? Date.parse(window.start) : Math.min(...raw.map((r) => r.start));
  const to = window ? Date.parse(window.end) : Math.max(...raw.map((r) => r.end));
  const spans = raw
    .map((r) => ({ ...r, start: Math.max(from, r.start), end: Math.min(to, r.end) }))
    .filter((r) => r.end > r.start);
  const boundaries = new Set(spans.flatMap((r) => [r.start, r.end]));
  // Day boundaries keep identities stable when the graph lookback advances.
  for (let day = Math.floor(from / 86400000) * 86400000 + 86400000; day < to; day += 86400000)
    boundaries.add(day);
  const points = [...boundaries].sort((a, b) => a - b),
    merged = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i],
      end = points[i + 1];
    const active = spans
      .filter((r) => r.start <= start && r.end >= end)
      .sort((a, b) => b.priority - a.priority);
    if (!active.length) continue; // Missing data is a gap, never an inferred pump state.
    const selected = active[0],
      mode = active.find((r) => OP5_MODE_SERIES.includes(r.series));
    const row = { ...selected, start, end, mode: mode?.state || null };
    const last = merged[merged.length - 1];
    if (
      last &&
      last.end === start &&
      last.state === row.state &&
      last.mode === row.mode &&
      Math.floor(last.start / 86400000) === Math.floor(start / 86400000)
    )
      last.end = end;
    else merged.push(row);
  }
  const accountKey = identifier('pump-state-owner', 'v1', opts);
  // Automated delivery in automated mode is the pump's normal state and gets no
  // note; every other state (manual, limited, paused, maximum...) is noted.
  const normal = (r) =>
    r.state === 'automatic' || (r.state === 'automated' && (!r.mode || r.mode === 'automatic'));
  const notes = merged.filter((r) => !normal(r)).map((r) => {
    const start = dateFor({ timestamp: new Date(r.start).toISOString() }, opts);
    const end = dateFor({ timestamp: new Date(r.end).toISOString() }, opts);
    if (!start || !end || end <= start) throw invalid();
    const minutes = (end - start) / 60000;
    const detail = [r.priority >= 5 && r.mode && r.mode !== 'automatic' ? r.mode + ' mode' : '', durationLabel(minutes)];
    return {
      identifier: identifier('pump-state', [r.start, r.state, r.mode], opts),
      eventType: 'Note',
      eventTime: start.toISOString(),
      created_at: start.toISOString(),
      duration: minutes,
      notes: r.label + ' (' + detail.filter(Boolean).join(', ') + ')',
      enteredBy: 'nightscout-connect-glooko',
      glookoSource: 'pump-state',
      glookoPumpState: {
        state: r.state,
        mode: r.mode,
        sourceSeries: r.series,
        accountKey,
        end: end.toISOString(),
        historical: true
      }
    };
  });
  // Mode sessions become their own treatments, labelled with just their
  // duration: Nightscout draws a duration treatment's notes as the bar label.
  function sessionRow(session, mode, series, fields) {
    const start = dateFor({ timestamp: new Date(session.start).toISOString() }, opts);
    const end = dateFor({ timestamp: new Date(session.end).toISOString() }, opts);
    if (!start || !end || end <= start) throw invalid();
    const minutes = (end - start) / 60000;
    return {
      identifier: identifier('pump-state', [session.start, mode, fields.eventType], opts),
      eventTime: start.toISOString(),
      created_at: start.toISOString(),
      duration: minutes,
      notes: durationLabel(minutes),
      enteredBy: 'nightscout-connect-glooko',
      glookoSource: 'pump-state',
      glookoPumpState: { state: mode, mode, sourceSeries: series, accountKey, end: end.toISOString(), historical: true },
      ...(typeof fields.extra === 'function' ? fields.extra(start, end) : {}),
      eventType: fields.eventType,
      ...(fields.profile ? { profile: fields.profile } : {})
    };
  }
  // Omnipod 5 activity (hypoprotect) mode is an Exercise, as the fork wrote it.
  // `activityMode` carries the interval in the shape diamanage reads.
  const exercises = sessions(merged, 'activity').map((session) =>
    sessionRow(session, 'activity', 'pumpOp5HypoprotectMode', {
      eventType: 'Exercise',
      extra: (start, end) => ({
        activityMode: {
          type: 'hypoprotect',
          timestamp: start.toISOString(),
          endTimestamp: end.toISOString(),
          duration: (end - start) / 1000
        }
      })
    })
  );
  // With CONNECT_GLOOKO_AUTOMATED_PROFILE the default profile has no basal
  // (in automated mode the pod decides), so each manual-mode interval also
  // switches to the Manual profile, which carries the pump's basal program.
  const switches = opts.glookoAutomatedProfile
    ? sessions(merged, 'manual').map((session) =>
        sessionRow(session, 'manual', 'pumpOp5ManualMode', { eventType: 'Profile Switch', profile: MANUAL_PROFILE })
      )
    : [];
  const rows = notes.concat(exercises, switches);
  const reconcile = window
    ? {
        accountKey,
        from: dateFor({ timestamp: window.start }, opts).toISOString(),
        to: dateFor({ timestamp: window.end }, opts).toISOString(),
        identifiers: rows.map((r) => r.identifier),
        eventTypes: ['Note', 'Exercise'].concat(opts.glookoAutomatedProfile ? ['Profile Switch'] : [])
      }
    : undefined;
  // Up to when Glooko has pump data: the end of the newest interval in any
  // state, normal automated delivery included. Gaps are never filled.
  const newest = merged[merged.length - 1];
  const until = newest ? dateFor({ timestamp: new Date(newest.end).toISOString() }, opts).toISOString() : null;
  return { notes: rows, reconcile, accountKey, until };
}

module.exports = { DELIVERY_SERIES, OP5_MODE_SERIES, MANUAL_PROFILE, rectangles, mapStateNotes, durationLabel };
