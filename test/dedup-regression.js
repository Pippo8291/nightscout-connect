#!/usr/bin/env node
/*
 * Regression test for the duplicate-entry storm.
 *
 * Symptom observed in production (glooko-sync on pm2):
 *
 *   RECORD BATCH with 5109 entries and 285 treatments 8 profiles
 *   RECORDED BATCH, new entries 4114 patched 0
 *
 * ...repeated every 5 minutes, with last_known.entries frozen at a fixed
 * timestamp.  5109 - 4114 = 995, i.e. only ~1000 existing entries were ever
 * considered when deciding what is "new", because the existence lookup in
 * record_glucose asked for `count: 1000` over a window holding far more
 * entries than that.  Everything beyond the cap was re-inserted on every
 * cycle, and the bookmark never advanced so the window never moved.
 *
 * This test drives lib/outputs/nightscout.js against a fake Nightscout that
 * caps query results the way a real one does, and asserts:
 *
 *   1. recording the same batch twice does not create duplicates
 *   2. the entries bookmark advances to the NEWEST reading, not the first
 *
 * Run: node test/dedup-regression.js   (or: npm test)
 */

var http = require('http');
var assert = require('assert');
var axios = require('axios');

var nightscoutRestAPI = require('../lib/outputs/nightscout');

// A real Nightscout will not hand back an unbounded result set.  The fake
// enforces a server-side ceiling so the test proves the client pages through
// the window rather than merely asking for a bigger number.
var FAKE_NS_MAX_COUNT = 1000;

var BATCH_SIZE = 1500;
var FIVE_MIN = 5 * 60 * 1000;

function build_fake_nightscout () {
  var entries = [];
  var nextId = 1;
  var control = { failGet: false };

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

      if (req.method === 'GET' && path === '/api/v1/entries.json') {
        if (control.failGet) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'boom' }));
        }
        var gte = Number(parsed.searchParams.get('find[date][$gte]'));
        var lte = Number(parsed.searchParams.get('find[date][$lte]'));
        var count = Number(parsed.searchParams.get('count')) || 10;
        var found = entries.filter(function (e) {
          if (!isNaN(gte) && parsed.searchParams.has('find[date][$gte]') && e.date < gte) return false;
          if (!isNaN(lte) && parsed.searchParams.has('find[date][$lte]') && e.date > lte) return false;
          return true;
        });
        // Nightscout returns newest first.
        found.sort(function (a, b) { return b.date - a.date; });
        return send(found.slice(0, Math.min(count, FAKE_NS_MAX_COUNT)));
      }

      if (req.method === 'POST' && path === '/api/v1/entries.json') {
        var created = (body || []).map(function (e) {
          var doc = Object.assign({ _id: String(nextId++) }, e);
          entries.push(doc);
          return doc;
        });
        return send(created);
      }

      if (req.method === 'GET' && path.indexOf('/api/v2/authorization/request/') === 0) {
        return send({ result: { token: 'test-jwt' } });
      }

      if (req.method === 'PATCH' && path.indexOf('/api/v3/entries/') === 0) {
        return send({ status: 200 });
      }

      // Treatments / profiles are not exercised here.
      return send([]);
    });
  });

  return { server: server, entries: entries, control: control };
}

function make_batch (startMs, n) {
  var out = [];
  for (var i = 0; i < n; i++) {
    var date = startMs + (i * FIVE_MIN);
    out.push({
      sgv: 80 + (i % 90)
    , date: date
    , dateString: new Date(date).toISOString()
    , device: 'nightscout-connect'
    , type: 'sgv'
    });
  }
  // Oldest first, the order the Glooko transform produces.
  return out;
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

    var start = Date.UTC(2026, 8, 15, 7, 58, 32);
    var batch = make_batch(start, BATCH_SIZE);
    var newest = batch[batch.length - 1];

    // gap_for runs once at startup and seeds the bookmark.
    return record_batch.gap_for()
      .then(function () { return record_batch({ entries: batch }); })
      .then(function () {
        assert.strictEqual(fake.entries.length, BATCH_SIZE,
          'first batch should insert every entry exactly once');
      })
      // Second identical batch: this is the 5-minute cycle repeating.
      .then(function () { return record_batch({ entries: batch }); })
      .then(function (bookmark) {
        assert.strictEqual(fake.entries.length, BATCH_SIZE,
          're-recording the same batch must not create duplicates (got ' +
          fake.entries.length + ' entries, expected ' + BATCH_SIZE + ')');

        assert.ok(bookmark.entries, 'bookmark.entries must be set');
        assert.strictEqual(bookmark.entries.getTime(), newest.date,
          'bookmark.entries must advance to the newest reading, got ' +
          bookmark.entries.toISOString() + ' expected ' + newest.dateString);
        console.log('PASS: no duplicate entries, bookmark advanced to newest reading');
      })
      // If we cannot read what Nightscout already has, writing anyway is how
      // duplicates got created.  Skip the batch instead.
      .then(function () {
        fake.control.failGet = true;
        var before = fake.entries.length;
        return record_batch({ entries: batch }).then(function () {
          assert.strictEqual(fake.entries.length, before,
            'a failed existence lookup must not insert anything (inserted ' +
            (fake.entries.length - before) + ')');
          console.log('PASS: failed existence lookup skips the batch instead of duplicating');
        });
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
