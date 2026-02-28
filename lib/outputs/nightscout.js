
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

  // function gap_for (kind, dt) { }
  // function record_kind (kind, data, dt) { }
  var bookmark = null;

  function record_glucose (data) {
    if (!data.length) {
      return Promise.resolve( );
    }
    var headers = { 'API-SECRET': apiHash };
    return http.post('/api/v1/entries.json', data, { headers }).then((resp) => {
      console.log("RECORDED BATCH, total entries", resp.data.length);
      return resp.data;
    }).catch((err) => {
      console.log("RECORDING ERROR", err);
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
          // Patch: start from the existing NS document (preserving any
          // user-added fields), then overwrite with Glooko's fields.
          // Drop eventTime — created_at on the existing doc already holds it.
          var merged = Object.assign({}, existingDoc);
          Object.keys(treatment).forEach(function (k) {
            if (k !== 'eventTime') merged[k] = treatment[k];
          });
          updatePromises.push(
            http.put('/api/v1/treatments/' + existingDoc._id, merged, { headers })
              .catch(function (err) { console.log("UPDATE TREATMENT ERROR", err); })
          );
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

