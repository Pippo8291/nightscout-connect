#!/usr/bin/env node
/*
 * Regression test for the treatment re-PATCH storm.
 *
 * Symptom observed in production (glooko-sync on pm2):
 *
 *   RECORD BATCH with 2831 entries and 140 treatments 8 profiles
 *   RECORDED BATCH, 0 new treatments, updated 140
 *
 * ...every 5 minutes.  record_treatments found every treatment already in
 * Nightscout (good) but then PATCHed each one anyway with all of its fields,
 * whether or not anything had changed.  That is ~40k PATCH requests a day,
 * `srvModified` never settles, and Nightscout's in-memory treatment cache
 * (which backs count-only /api/v1/treatments.json queries) grows one copy
 * per PATCH, so clients saw the same bolus up to 40 times.
 *
 * This test drives lib/outputs/nightscout.js against a fake Nightscout that
 * stores treatments the way a real one does (eventTime becomes created_at,
 * numbers stay numbers) and asserts:
 *
 *   1. recording a batch creates each treatment once, with no PATCH
 *   2. recording the identical batch again sends no PATCH at all
 *   3. a treatment whose field really changed is PATCHed exactly once,
 *      with only the changed field
 *
 * Run: node test/treatment-patch-regression.js   (or: npm test)
 */

var http = require('http');
var assert = require('assert');
var axios = require('axios');

var nightscoutRestAPI = require('../lib/outputs/nightscout');

function build_fake_nightscout () {
  var treatments = [];
  var patches = [];
  var nextId = 1;

  var server = http.createServer(function (req, res) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      var body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      var parsed = new URL(req.url, 'http://localhost');
      var path = parsed.pathname;

      function send (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      }

      if (req.method === 'GET' && path === '/api/v1/treatments.json') {
        var gte = parsed.searchParams.get('find[created_at][$gte]');
        var lte = parsed.searchParams.get('find[created_at][$lte]');
        var count = Number(parsed.searchParams.get('count')) || 10;
        var found = treatments.filter(function (t) {
          if (gte && t.created_at < gte) return false;
          if (lte && t.created_at > lte) return false;
          return true;
        });
        found.sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
        return send(found.slice(0, count));
      }

      if (req.method === 'POST' && path === '/api/v1/treatments.json') {
        var created = (body || []).map(function (t) {
          // Nightscout turns eventTime into created_at and drops eventTime.
          var doc = Object.assign({ _id: String(nextId++) }, t);
          if (doc.eventTime) {
            doc.created_at = new Date(doc.eventTime).toISOString();
            delete doc.eventTime;
          }
          treatments.push(doc);
          return doc;
        });
        return send(created);
      }

      if (req.method === 'GET' && path.indexOf('/api/v2/authorization/request/') === 0) {
        return send({ result: { token: 'test-jwt' } });
      }

      if (req.method === 'PATCH' && path.indexOf('/api/v3/treatments/') === 0) {
        var id = path.split('/').pop();
        var doc = treatments.filter(function (t) { return t._id === id; })[0];
        if (!doc) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 404 }));
        }
        Object.assign(doc, body);
        patches.push({ id: id, body: body });
        return send({ status: 200 });
      }

      // Entries / profiles are not exercised here.
      return send([]);
    });
  });

  return { server: server, treatments: treatments, patches: patches };
}

// The shapes the Glooko transform produces: a bolus (eventTime, numbers,
// JSON notes), an ongoing activity mode (duration grows while it runs) and
// a profile switch (sets created_at itself).
function make_batch (exerciseDuration) {
  return [
    {
      eventType: 'Meal Bolus'
    , eventTime: '2026-10-10T16:11:45.000Z'
    , insulin: 0.2
    , carbs: 0
    , notes: JSON.stringify({ isInterrupted: false, insulinDelivered: 0.2 })
    },
    {
      eventType: 'Exercise'
    , eventTime: '2026-10-10T17:41:02.000Z'
    , duration: exerciseDuration
    , notes: 'Activity Mode: {"timestamp":"2026-10-10T19:41:02.000Z"}'
    },
    {
      eventType: 'Profile Switch'
    , eventTime: '2026-10-10T12:00:00.000Z'
    , created_at: '2026-10-10T12:00:00.000Z'
    , duration: 30
    , profile: 'MANUAL'
    }
  ];
}

function run () {
  var fake = build_fake_nightscout();

  return new Promise(function (resolve) {
    fake.server.listen(0, '127.0.0.1', resolve);
  }).then(function () {
    var port = fake.server.address().port;
    var record_batch = nightscoutRestAPI({
      url: 'http://127.0.0.1:' + port + '/'
    , apiSecret: 'test-secret-value'
    }, axios);

    return record_batch.gap_for()
      .then(function () { return record_batch({ treatments: make_batch(60) }); })
      .then(function () {
        assert.strictEqual(fake.treatments.length, 3,
          'first batch should insert every treatment exactly once');
        assert.strictEqual(fake.patches.length, 0,
          'first batch must not PATCH anything (sent ' + fake.patches.length + ')');
        console.log('PASS: first batch creates each treatment once, no PATCH');
      })
      // Second identical batch: this is the 5-minute cycle repeating.
      .then(function () { return record_batch({ treatments: make_batch(60) }); })
      .then(function () {
        assert.strictEqual(fake.treatments.length, 3,
          're-recording the same batch must not create duplicates');
        assert.strictEqual(fake.patches.length, 0,
          'an unchanged treatment must not be PATCHed (sent ' + fake.patches.length + ' PATCHes)');
        console.log('PASS: unchanged batch sends no PATCH');
      })
      // The activity mode is still running, so Glooko now reports a longer
      // duration.  Only that treatment, and only that field, should go out.
      .then(function () { return record_batch({ treatments: make_batch(120) }); })
      .then(function () {
        assert.strictEqual(fake.treatments.length, 3,
          'a changed treatment must be updated, not re-created');
        assert.strictEqual(fake.patches.length, 1,
          'exactly one PATCH for the one changed treatment (sent ' + fake.patches.length + ')');
        assert.deepStrictEqual(fake.patches[0].body, { duration: 120 },
          'the PATCH must carry only the changed field, got ' + JSON.stringify(fake.patches[0].body));
        var exercise = fake.treatments.filter(function (t) { return t.eventType === 'Exercise'; })[0];
        assert.strictEqual(exercise.duration, 120, 'the stored treatment must reflect the change');
        console.log('PASS: a changed treatment is PATCHed once with only the changed field');
      });
  }).then(function () {
    fake.server.close();
  }, function (err) {
    fake.server.close();
    console.error('FAIL:', err && err.message);
    process.exitCode = 1;
  });
}

run();
