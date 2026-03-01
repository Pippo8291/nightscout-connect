
var qs = require('querystring');
var url = require('url');
var crypto = require('crypto');

function encode_api_secret(plain) {
  var shasum = crypto.createHash('sha1');
  shasum.update(plain);
  return shasum.digest('hex').toLowerCase( );
}

function nightscoutRestAPI (config, axios) {
  // TODO change this, exposes secret in logs
  console.log("SETTING UP nightscoutRestAPI", config);
  var endpoint = url.parse(config.url);
  var baseURL = url.format({
    protocol: endpoint.protocol
  , host: endpoint.host
  , pathname: endpoint.pathname
  });
  var params = qs.parse(endpoint.query);
  var apiSecret = config.apiSecret;
  var apiHash = encode_api_secret(apiSecret);
  var http = axios.create({ baseURL });

  // Cached JWT for v3 API Bearer auth.  Refreshed on each record_batch call
  // so it doesn't expire between batches (JWTs are short-lived, ~1 h).
  var cachedJwt = null;

  /**
   * Exchange the plain API secret for a short-lived JWT required by the v3
   * API.  Calls GET /api/v2/authorization/request/<apiSecret> and returns the
   * JWT string.  Caches the result in `cachedJwt` so it is reused within the
   * same batch.
   */
  function getJwt() {
    return http.get('/api/v2/authorization/request/' + apiSecret, {
      headers: { 'Accept': 'application/json' }
    }).then(function (resp) {
      var data = resp.data || {};
      // v2 wraps the token inside { "result": { "token": "..." } }
      var token = (data.result && data.result.token) || data.token;
      if (!token) throw new Error('getJwt: no token in response');
      cachedJwt = token;
      console.log('NS JWT obtained successfully');
      return token;
    }).catch(function (err) {
      console.log('NS getJwt ERROR', err && err.message);
      throw err;
    });
  }

  // In-flight JWT promise so parallel callers within the same batch share
  // one request instead of racing.
  var jwtPromise = null;

  /**
   * Return a promise that resolves to the JWT, fetching it only once per
   * batch.  `jwtPromise` is reset to null at the start of each record_batch
   * call so the token is refreshed for every batch.
   */
  function getJwtOnce() {
    if (cachedJwt) return Promise.resolve(cachedJwt);
    if (!jwtPromise) jwtPromise = getJwt();
    return jwtPromise;
  }

  // function gap_for (kind, dt) { }
  // function record_kind (kind, data, dt) { }
  var bookmark = null;

  // NS can return _id as a plain string or as {"$oid":"..."} depending on version.
  function extractOid (id) {
    if (!id) return id;
    if (typeof id === 'string') return id;
    if (id['$oid']) return id['$oid'];
    return String(id);
  }

  // CGM readings from Glooko and Dexcom for the same physical measurement
  // can have timestamps several seconds apart.  Entries within this window
  // are considered the same reading.
  var ENTRY_MATCH_TOLERANCE_MS = 60 * 1000; // 1 minute

  function record_glucose (data) {
    if (!data.length) {
      return Promise.resolve( );
    }
    var headers = { 'API-SECRET': apiHash };

    var times = data.map(function (e) { return e.date; }).filter(Boolean);

    if (!times.length) {
      return http.post('/api/v1/entries.json', data, { headers })
        .then(function (resp) {
          console.log("RECORDED BATCH, total entries", resp.data.length);
          return resp.data;
        }).catch(function (err) { console.log("RECORDING ERROR", err); });
    }

    // Widen the query window by the tolerance on both sides so we don't miss
    // a nearby Dexcom entry whose timestamp differs from Glooko's.
    var minTime = Math.min.apply(null, times) - ENTRY_MATCH_TOLERANCE_MS;
    var maxTime = Math.max.apply(null, times) + ENTRY_MATCH_TOLERANCE_MS;

    return http.get('/api/v1/entries.json', {
      headers,
      params: { 'find[date][$gte]': minTime, 'find[date][$lte]': maxTime, count: 1000 }
    }).then(function (resp) {
      return resp.data || [];
    }).catch(function () {
      return [];
    }).then(function (existing) {
      var toCreate = [];
      var updatePromises = [];

      data.forEach(function (entry) {
        // Find the closest existing entry within tolerance.
        var closest = null;
        var closestDiff = ENTRY_MATCH_TOLERANCE_MS + 1;
        existing.forEach(function (doc) {
          var diff = Math.abs(doc.date - entry.date);
          if (diff < closestDiff && doc.sgv === entry.sgv) { closestDiff = diff; closest = doc; }
        });

        if (closest) {
          // Existing entry (likely from Dexcom) is source of truth for the
          // timestamp.  Fill in only fields that are absent on the existing
          // doc from the Glooko entry, then PATCH via v3 so the Dexcom
          // `date` / `dateString` are never overwritten.
          var patch = {};
          Object.keys(entry).forEach(function (k) {
            // Never touch the timestamp fields — they belong to Dexcom.
            if (k === 'date' || k === 'dateString') return;
            if (closest[k] == null) patch[k] = entry[k];
          });
          var oid = extractOid(closest._id);
          if (Object.keys(patch).length > 0) {
            updatePromises.push(
              getJwtOnce()
                .then(function (jwt) {
                  return http.patch('/api/v3/entries/' + oid, patch, {
                    headers: { 'Authorization': 'Bearer ' + jwt, 'Content-Type': 'application/json' }
                  });
                })
                .catch(function (err) { console.log("UPDATE ENTRY ERROR", err && err.message); })
            );
          }
        } else {
          toCreate.push(entry);
        }
      });

      var ops = updatePromises.slice();
      if (toCreate.length) {
        ops.push(
          http.post('/api/v1/entries.json', toCreate, { headers })
            .then(function (resp) {
              console.log("RECORDED BATCH, new entries", resp.data.length,
                          "patched", updatePromises.length);
              return resp.data;
            }).catch(function (err) { console.log("RECORDING ERROR", err); })
        );
      } else {
        console.log("RECORDED BATCH, 0 new entries, patched", updatePromises.length);
      }

      if (!ops.length) return Promise.resolve([]);

      return Promise.all(ops).then(function (results) {
        var created = results[results.length - 1];
        return Array.isArray(created) ? created : [];
      });
    });
  }

  function record_treatments (data) {
    if (!data.length) {
      return Promise.resolve( );
    }
    var headers = { 'API-SECRET': apiHash };

    // Determine the time window covered by incoming treatments so we can
    // query NS for existing records and patch rather than blindly insert.
    var times = data
      .map(function (t) { return new Date(t.eventTime || t.created_at).getTime(); })
      .filter(function (ms) { return !isNaN(ms); });

    if (!times.length) {
      // No parseable timestamps — fall back to plain insert.
      return http.post('/api/v1/treatments.json', data, { headers })
        .then(function (resp) {
          console.log("RECORDED BATCH, total treatments", resp.data.length);
          return resp.data;
        }).catch(function (err) { console.log("RECORDING ERROR", err); });
    }

    var minTime = new Date(Math.min.apply(null, times)).toISOString();
    var maxTime = new Date(Math.max.apply(null, times) + 1000).toISOString();

    // Fetch existing treatments in the same window.
    return http.get('/api/v1/treatments.json', {
      headers,
      params: {
        'find[created_at][$gte]': minTime,
        'find[created_at][$lte]': maxTime,
        count: 1000
      }
    }).then(function (resp) {
      return resp.data || [];
    }).catch(function () {
      return [];
    }).then(function (existing) {
      // Build lookup: "eventType|created_at_iso" → existing NS document.
      var existingMap = new Map();
      existing.forEach(function (doc) {
        var key = doc.eventType + '|' + new Date(doc.created_at).toISOString();
        existingMap.set(key, doc);
      });

      var toCreate = [];
      var updatePromises = [];

      data.forEach(function (treatment) {
        var timeStr = treatment.eventTime || treatment.created_at;
        var key = treatment.eventType + '|' + new Date(timeStr).toISOString();
        var existingDoc = existingMap.get(key);

        if (existingDoc) {
          // Build a partial patch: overwrite with the incoming Glooko fields
          // but skip `eventTime` (the existing `created_at` already holds it)
          // and skip `created_at` itself so the original timestamp is preserved.
          // Use PATCH /api/v3/treatments/{id} (Bearer JWT) instead of DELETE+POST
          // so the Nightscout _id and original created_at are never changed.
          var patch = {};
          Object.keys(treatment).forEach(function (k) {
            if (k === 'eventTime' || k === 'created_at') return;
            patch[k] = treatment[k];
          });
          var oid = extractOid(existingDoc._id);
          if (Object.keys(patch).length > 0) {
            updatePromises.push(
              getJwtOnce()
                .then(function (jwt) {
                  return http.patch('/api/v3/treatments/' + oid, patch, {
                    headers: { 'Authorization': 'Bearer ' + jwt, 'Content-Type': 'application/json' }
                  });
                })
                .catch(function (err) { console.log("UPDATE TREATMENT ERROR", err && err.message); })
            );
          }
        } else {
          toCreate.push(treatment);
        }
      });

      var ops = updatePromises.slice();
      if (toCreate.length) {
        ops.push(
          http.post('/api/v1/treatments.json', toCreate, { headers })
            .then(function (resp) {
              console.log("RECORDED BATCH, new treatments", resp.data.length,
                          "updated", updatePromises.length);
              return resp.data;
            }).catch(function (err) { console.log("RECORDING ERROR", err); })
        );
      } else {
        console.log("RECORDED BATCH, 0 new treatments, updated", updatePromises.length);
      }

      if (!ops.length) return Promise.resolve([]);

      return Promise.all(ops).then(function (results) {
        // Return the newly created treatments array for bookmark_treatments.
        var created = results[results.length - 1];
        return Array.isArray(created) ? created : [];
      });
    });
  }

  function record_profiles (data) {
    if (!data.length) {
      return Promise.resolve( );
    }
    var headers = { 'API-SECRET': apiHash };

    // Fetch all existing profiles so we can skip ones already stored,
    // identified by their startDate epoch (millis).
    return http.get('/api/v1/profiles.json', { headers })
      .then(function (resp) { return resp.data || []; })
      .catch(function () { return []; })
      .then(function (existing) {
        var existingMillis = new Set(
          existing.map(function (p) {
            return p.millis || new Date(p.startDate).getTime();
          })
        );
        var toCreate = data.filter(function (p) {
          return !existingMillis.has(p.millis);
        });
        if (!toCreate.length) {
          console.log("RECORDED BATCH, total profiles 0 (all already exist)");
          return Promise.resolve([]);
        }
        return http.post('/api/v1/profiles.json', toCreate, { headers })
          .then(function (resp) {
            console.log("RECORDED BATCH, total profiles", resp.data.length);
            return resp.data;
          }).catch(function (err) { console.log("RECORDING ERROR", err); });
      });
  }

  function bookmark_glucose (data) {
    var readings = data;
    if (readings && readings.length) {
      bookmark.entries = new Date(readings[0].dateString);
    }
    return Promise.resolve(data);
    // return data;
  }

  function bookmark_treatments (data) {
    var treatments = data;
    if (treatments && treatments.length) {
      bookmark.treatments = new Date(treatments[0].created_at);
    }
    return Promise.resolve(data);
    // return data;
  }

  function record_batch (batch) {
    console.log("RECORD BATCH with", batch.entries?.length, 'entries and', batch.treatments?.length, 'treatments', batch.profiles?.length, 'profiles');
    // Reset cached JWT so it is refreshed at the start of every batch.
    // JWTs are short-lived (~1 h); refreshing per batch keeps auth valid.
    cachedJwt = null;
    jwtPromise = null;
    var { entries, treatments, profiles, devicestatus } = batch;
    entries = entries || [ ];
    treatments = treatments || [ ];
    profiles = profiles || [ ];
    devicestatus = devicestatus || [ ];
    /*
    if (!batch.entries.length) {
      return Promise.resolve(bookmark);
    }
    */
    return Promise.all([
        record_glucose(entries).then(bookmark_glucose),
        record_treatments(treatments).then(bookmark_treatments),
        record_profiles(profiles)
      ]).then(function update_bookmark (settled) {
        //console.log("UPDATE BOOKMARK FROM I/O", bookmark, settled[0], settled.length);
        //console.log("UPDATE BOOKMARK FROM I/O", settled.length);
        return bookmark;
    });
    // return Promise.resolve(batch);

  }
  record_batch.gap_for = function ( ) {
    console.log("FETCHING GAPS INFORMATION");
    if (bookmark) {
      return Promise.resolve(bookmark);
    }
    bookmark = { };
    var headers = { 'API-SECRET': apiHash };
    var query = { count: 1 };
    return http.get('/api/v1/entries.json', { params: query, headers }).then((resp) => {
      if (resp.data && resp.data.length) {
        bookmark.entries = new Date(resp.data[0].dateString);
        bookmark.treatments = new Date(resp.data[0].dateString);
        console.log("UPDATED ENTRIES BOOKMARK", bookmark);
      }
    }).catch((err) => {
      console.log("FAILED TO DETERMINE GAP", err.request, err.response.status, err.response.data);
    })
    .then(( ) => {
      console.log("FINAL GAP", bookmark);
      return bookmark;
    });

  }
  return record_batch;

}
module.exports = nightscoutRestAPI;

