'use strict';

// On-demand Glooko sync (POST /glooko/sync). Glooko pulls new pump data in
// only after a sign-in and needs 1-2 minutes for it, and every sign-in shows up
// in Glooko's own graph view, so a request:
//
//   - signs in again only when the last sign-in is at least `minSignInGapMs`
//     old (RESET_SESSION; the next frame authenticates), otherwise only fetches;
//   - runs one frame at once (SYNC_NOW) and waits for it, at most
//     `firstFetchTimeoutMs`: new data -> 200, otherwise 202;
//   - after a 202, fetches again at `followUpsMs` after the request, stopping
//     at the first frame with new data;
//   - shares one sync between every request that arrives while it runs.
//
// "New data" is an entry, or a treatment that is not a pump-state band, newer
// than anything an earlier frame saw. The first frame since start counts.

function newestOf (data) {
  let newest = null;
  const take = (ms) => {
    if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
  };
  for (const entry of (data && data.entries) || []) {
    take(Number.isFinite(entry.date) ? entry.date : Date.parse(entry.dateString));
  }
  for (const treatment of (data && data.treatments) || []) {
    if (treatment.glookoSource === 'pump-state') continue;
    take(Date.parse(treatment.created_at));
  }
  return newest;
}

function createSyncController ({
  send,
  lastSignInMs,
  now = Date.now,
  setTimeout: schedule = setTimeout,
  clearTimeout: cancel = clearTimeout,
  minSignInGapMs = 15 * 60 * 1000,
  firstFetchTimeoutMs = 45 * 1000,
  followUpsMs = [60 * 1000, 150 * 1000],
}) {
  const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

  let newestSeen = null;   // across every frame, scheduled or requested
  let frameNewest = null;  // the current frame's transformed data
  let active = null;       // the running sync, if any

  function finish ( ) {
    if (!active) return;
    for (const id of active.timers) cancel(id);
    active = null;
  }

  function startFollowUps ( ) {
    active.phase = 'follow-up';
    active.result = {
      status: 202,
      signedIn: active.signedIn,
      lastSignInAt: iso(lastSignInMs( )),
      followUpAt: followUpsMs.map((ms) => iso(active.startedAt + ms)),
    };
    active.remaining = followUpsMs.length;
    for (const ms of followUpsMs) {
      const delay = Math.max(0, active.startedAt + ms - now( ));
      active.timers.push(schedule(( ) => {
        if (!active || active.phase !== 'follow-up') return;
        active.awaitingStart = true;
        send({ type: 'SYNC_NOW' });
      }, delay));
    }
    // A follow-up frame that never reports must not keep the sync open.
    const last = Math.max(...followUpsMs);
    active.timers.push(schedule(finish, Math.max(0, active.startedAt + last + firstFetchTimeoutMs - now( ))));
    active.resolve(active.result);
  }

  function onFrameStart ( ) {
    frameNewest = null;
    if (active && active.awaitingStart) {
      active.awaitingStart = false;
      active.armed = true;
    }
  }

  function onTransformed (data) {
    frameNewest = newestOf(data);
  }

  function onFrameOutcome ({ ok }) {
    const isNew = ok && frameNewest !== null && (newestSeen === null || frameNewest > newestSeen);
    if (frameNewest !== null && (newestSeen === null || frameNewest > newestSeen)) newestSeen = frameNewest;
    frameNewest = null;

    if (!active || !active.armed) return;
    active.armed = false;

    if (active.phase === 'immediate') {
      cancel(active.firstTimer);
      if (!ok) {
        const result = { status: 502, error: 'Glooko sign-in or fetch failed' };
        const { resolve } = active;
        finish( );
        resolve(result);
        return;
      }
      if (isNew) {
        const result = {
          status: 200,
          signedIn: active.signedIn,
          lastSignInAt: iso(lastSignInMs( )),
          finishedAt: iso(now( )),
        };
        const { resolve } = active;
        finish( );
        resolve(result);
        return;
      }
      startFollowUps( );
      return;
    }

    // follow-up frame
    active.remaining -= 1;
    if (isNew || active.remaining <= 0) finish( );
  }

  function request ( ) {
    if (active) return active.promise;

    const last = lastSignInMs( );
    const signInDue = last === null || now( ) - last >= minSignInGapMs;
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    active = {
      phase: 'immediate',
      startedAt: now( ),
      signedIn: signInDue,
      awaitingStart: true,
      armed: false,
      timers: [ ],
      promise,
      resolve,
      result: null,
    };
    active.firstTimer = schedule(( ) => {
      if (active && active.phase === 'immediate') {
        active.armed = false;
        active.awaitingStart = false;
        startFollowUps( );
      }
    }, firstFetchTimeoutMs);
    active.timers.push(active.firstTimer);

    if (signInDue) send({ type: 'RESET_SESSION' });
    send({ type: 'SYNC_NOW' });
    return promise;
  }

  return { request, onFrameStart, onTransformed, onFrameOutcome };
}

module.exports = { createSyncController, newestOf };
