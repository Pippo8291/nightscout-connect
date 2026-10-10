#!/usr/bin/env node
/*
 * Regression test for the profile re-POST storm.
 *
 * Symptom observed in production (glooko-sync on pm2):
 *
 *   RECORDED BATCH, total profiles 8
 *
 * ...every 5 minutes, although the 8 pump-settings profiles Glooko reports
 * had been stored long ago.  record_profiles looked up existing profiles via
 * GET /api/v1/profiles.json, but Nightscout's plural route applies a date
 * walker and answers with an empty list, so every profile looked new and was
 * POSTed again.  Nightscout upserts profiles by startDate, so nothing
 * duplicated, but every cycle rewrote all profiles, bumped their created_at
 * and dumped each of them into the Nightscout log.
 *
 * This test drives lib/outputs/nightscout.js against a fake Nightscout whose
 * plural route is empty (like the real one) and whose singular
 * GET /api/v1/profile.json?count=N returns the newest stored profiles, and
 * asserts:
 *
 *   1. recording a batch POSTs each profile once
 *   2. recording the identical batch again POSTs nothing
 *   3. a batch with one new profile POSTs only that one
 *
 * Run: node test/profile-sync-regression.js   (or: npm test)
 */

var http = require('http');
var assert = require('assert');
var axios = require('axios');

var nightscoutRestAPI = require('../lib/outputs/nightscout');

function build_fake_nightscout () {
  var profiles = [];
  var posts = [];

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

      // Nightscout's plural route runs the stored profiles through a date
      // walker and, in practice, answers with nothing.
      if (req.method === 'GET' && path === '/api/v1/profiles.json') {
        return send([]);
      }

      // The singular route lists the newest `count` profiles (default 10).
      if (req.method === 'GET' && path === '/api/v1/profile.json') {
        var count = Number(parsed.searchParams.get('count')) || 10;
        var sorted = profiles.slice().sort(function (a, b) {
          return a.startDate < b.startDate ? 1 : -1;
        });
        return send(sorted.slice(0, count));
      }

      if (req.method === 'POST' && path === '/api/v1/profiles.json') {
        var docs = Array.isArray(body) ? body : [body];
        posts.push(docs);
        // Nightscout upserts on startDate + defaultProfile.
        docs.forEach(function (doc) {
          var existing = profiles.filter(function (p) {
            return p.startDate === doc.startDate && p.defaultProfile === doc.defaultProfile;
          })[0];
          if (existing) {
            Object.assign(existing, doc);
          } else {
            profiles.push(Object.assign({ _id: String(profiles.length + 1) }, doc));
          }
        });
        return send(docs);
      }

      // Entries / treatments are not exercised here.
      return send([]);
    });
  });

  return { server: server, profiles: profiles, posts: posts };
}

// The shape the Glooko transform produces for one pump-settings sync.
function make_profile (iso) {
  var date = new Date(iso);
  var name = date.toISOString().split('.')[0];
  return {
    defaultProfile: name
  , startDate: date
  , millis: date.getTime()
  , units: 'mg/dl'
  , store: {}
  };
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

    var batch = [
      make_profile('2026-09-12T08:33:39.575Z')
    , make_profile('2026-10-04T14:30:19.424Z')
    , make_profile('2026-10-06T08:32:48.750Z')
    ];

    return record_batch.gap_for()
      .then(function () { return record_batch({ profiles: batch }); })
      .then(function () {
        assert.strictEqual(fake.profiles.length, 3,
          'first batch should store every profile once');
        assert.strictEqual(fake.posts.length, 1,
          'first batch should POST once (sent ' + fake.posts.length + ')');
        console.log('PASS: first batch stores each profile once');
      })
      // Second identical batch: this is the 5-minute cycle repeating.
      .then(function () { return record_batch({ profiles: batch }); })
      .then(function () {
        assert.strictEqual(fake.profiles.length, 3,
          're-recording the same batch must not add profiles');
        assert.strictEqual(fake.posts.length, 1,
          'profiles that already exist must not be POSTed again (sent ' +
          fake.posts.length + ' POSTs)');
        console.log('PASS: unchanged batch sends no POST');
      })
      // Glooko reports a new pump-settings sync: only that one goes out.
      .then(function () {
        var withNew = batch.concat([ make_profile('2026-10-11T06:00:00.000Z') ]);
        return record_batch({ profiles: withNew });
      })
      .then(function () {
        assert.strictEqual(fake.profiles.length, 4,
          'the new profile must be stored');
        assert.strictEqual(fake.posts.length, 2,
          'exactly one more POST for the new profile (sent ' + fake.posts.length + ')');
        var last = fake.posts[fake.posts.length - 1];
        assert.strictEqual(last.length, 1,
          'the POST must carry only the new profile, got ' + last.length);
        assert.strictEqual(last[0].millis, new Date('2026-10-11T06:00:00.000Z').getTime(),
          'the POSTed profile must be the new one');
        console.log('PASS: a new profile is POSTed alone');
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
