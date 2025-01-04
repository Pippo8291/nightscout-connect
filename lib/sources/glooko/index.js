/*
*
* https://github.com/jonfawcett/glooko2nightscout-bridge/blob/master/index.js#L146
* Authors:
* Jeremy Pollock
* https://github.com/jpollock
* Jon Fawcett
* and others.
*/

var qs = require('qs');
var url = require('url');
const cheerio = require('cheerio');

var helper = require('./convert');
var helperv3 = require('./convertv3');

_known_servers = {
  default: 'api.glooko.com'
, development: 'api.glooko.work'
, production: 'externalapi.glooko.com'
, eu: 'eu.api.glooko.com'
};

var Defaults = {
  "applicationId":"d89443d2-327c-4a6f-89e5-496bbb0317db"
, "lastGuid":"1e0c094e-1e54-4a4f-8e6a-f94484b53789" // hardcoded, random guid; no Glooko docs to explain need for param or why bad data works
, login: '/users/sign_in'
, user: 'https://de-fr.api.glooko.com/api/v3/session/users'
// , login: '/api/v2/users/sign_in'
, mime: 'application/json'
, LatestFoods: '/api/v2/foods'
, LatestInsulins: '/api/v2/insulins'
, LatestPumpBasals: '/api/v2/pumps/scheduled_basals'
, LatestPumpBolus: '/api/v2/pumps/normal_boluses'
, LatestCGMReadings: '/api/v2/cgm/readings'
, v3PumpSettings: '/api/v3/devices_and_settings?patient=_PATIENT_'
// , v3API: '/api/v3/graph/data?patient=_PATIENT_&startDate=_STARTDATE_&endDate=_ENDDATE_&series[]=automaticBolus&series[]=basalBarAutomated&series[]=basalBarAutomatedMax&series[]=basalBarAutomatedSuspend&series[]=basalLabels&series[]=basalModulation&series[]=bgAbove400&series[]=bgAbove400Manual&series[]=bgHigh&series[]=bgHighManual&series[]=bgLow&series[]=bgLowManual&series[]=bgNormal&series[]=bgNormalManual&series[]=bgTargets&series[]=carbNonManual&series[]=cgmCalibrationHigh&series[]=cgmCalibrationLow&series[]=cgmCalibrationNormal&series[]=cgmHigh&series[]=cgmLow&series[]=cgmNormal&series[]=deliveredBolus&series[]=extendedBolusStep&series[]=gkCarb&series[]=gkInsulin&series[]=gkInsulin&series[]=gkInsulinBasal&series[]=gkInsulinBolus&series[]=gkInsulinOther&series[]=gkInsulinPremixed&series[]=injectionBolus&series[]=injectionBolus&series[]=interruptedBolus&series[]=interruptedBolus&series[]=lgsPlgs&series[]=overrideAboveBolus&series[]=overrideAboveBolus&series[]=overrideBelowBolus&series[]=overrideBelowBolus&series[]=pumpAdvisoryAlert&series[]=pumpAlarm&series[]=pumpBasaliqAutomaticMode&series[]=pumpBasaliqManualMode&series[]=pumpCamapsAutomaticMode&series[]=pumpCamapsBluetoothTurnedOffMode&series[]=pumpCamapsBoostMode&series[]=pumpCamapsDailyTotalInsulinExceededMode&series[]=pumpCamapsDepoweredMode&series[]=pumpCamapsEaseOffMode&series[]=pumpCamapsExtendedBolusNotAllowedMode&series[]=pumpCamapsManualMode&series[]=pumpCamapsNoCgmMode&series[]=pumpCamapsNoPumpConnectivityMode&series[]=pumpCamapsPumpDeliverySuspendedMode&series[]=pumpCamapsUnableToProceedMode&series[]=pumpControliqAutomaticMode&series[]=pumpControliqExerciseMode&series[]=pumpControliqManualMode&series[]=pumpControliqSleepMode&series[]=pumpGenericAutomaticMode&series[]=pumpGenericManualMode&series[]=pumpOp5AutomaticMode&series[]=pumpOp5HypoprotectMode&series[]=pumpOp5LimitedMode&series[]=pumpOp5ManualMode&series[]=reservoirChange&series[]=scheduledBasal&series[]=setSiteChange&series[]=suggestedBolus&series[]=suggestedBolus&series[]=suspendBasal&series[]=temporaryBasal&series[]=unusedScheduledBasal&locale=en-GB'
, v3API: '/api/v3/graph/data?patient=_PATIENT_&startDate=_STARTDATE_&endDate=_ENDDATE_&series[]=deliveredBolus&series[]=pumpOp5ManualMode&series[]=pumpOp5HypoprotectMode&series[]=interruptedBolus&series[]=bgHighManual&series[]=bgLowManual&series[]=bgNormalManual&series[]=cgmHigh&series[]=cgmLow&series[]=cgmNormal&series[]=reservoirChange&series[]=setSiteChange&locale=en-GB'
// ?sessionID=e59c836f-5aeb-4b95-afa2-39cf2769fede&minutes=1440&maxCount=1"
};

function base_for (spec) {
  var server = spec.glookoServer ? spec.glookoServer : _known_servers[spec.glookoEnv || 'default' ];
  var base = {
    protocol: 'https',
    host: server
  };
  return url.format(base);
}

function login_payload (opts) {
  var body = {
    "userLogin": {
      "email": opts.glookoEmail,
      "password": opts.glookoPassword
    },
    "deviceInformation": {
      "deviceModel": "iPhone"
    }
  };
  return body;
}

async function getCsrfToken() {
  try {
    const response = await http.get("aaaaaa");
    const $ = cheerio.load(response.data);
    const csrfToken = $('meta[name="csrf-token"]').attr('content');
    console.log('CSRF Token:', csrfToken);
    return csrfToken;
  } catch (error) {
    console.error('Failed to fetch CSRF token:', error);
    throw error;
  }
}
function glookoSource (opts, axios) {
  var default_headers = { 'Content-Type': Defaults.mime,
                          'Accept': 'application/json, text/plain, */*',
                          'Accept-Encoding': 'gzip, deflate, br',
                          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
                          'Referer': 'https://eu.my.glooko.com/',
                          'Origin': 'https://eu.my.glooko.com',
                          'Connection': 'keep-alive',
                          'Accept-Language': 'en-GB,en;q=0.9'
                          };
  var baseURL = opts.baseURL;
  console.log('GLOOKO OPTS', opts);
  var http = axios.create({ baseURL, headers: default_headers });
  var impl = {
    authFromCredentials ( ) {
      return fetch("https://de-fr.my.glooko.com/users/sign_in", { method: "GET", redirect: "follow" })
          .then((response) => response.text().then((html) => {
            const $ = cheerio.load(html);
            const csrfToken = $('meta[name="csrf-token"]').attr('content');
            const firstCookie = response.headers.get('set-cookie');

            // console.log('CSRF Token:', csrfToken);
            // console.log('First Cookie:', firstCookie);

            return { csrfToken, firstCookie };
          }))
          .then(({ csrfToken, firstCookie }) => {
            const myHeaders = new Headers();
            myHeaders.append("Content-Type", "application/x-www-form-urlencoded;charset=utf-8");
            myHeaders.append("Cookie", firstCookie);

            const urlencoded = new URLSearchParams();
            urlencoded.append("authenticity_token", csrfToken);
            urlencoded.append("redirect_to", "");
            urlencoded.append("language", "en");
            urlencoded.append("user[email]", opts.glookoEmail);
            urlencoded.append("user[password]", opts.glookoPassword);
            urlencoded.append("commit", "Log In");

            const requestOptions = {
              method: "POST",
              headers: myHeaders,
              //body: urlencoded.toString(),
              body: urlencoded,
              redirect: "manual" // prevent auto-redirects to handle cookies
            };

            const request = new Request("https://de-fr.my.glooko.com/users/sign_in?id=login_form&locale=en", requestOptions)
            //console.log(request)
            return fetch(request)
                .then((response) => {
                  //console.log(response)
                  const authCookie = response.headers.get('set-cookie');
                  // console.log('Auth Cookie:', authCookie);

                  const myHeaders = new Headers();
                  myHeaders.append("Cookie", authCookie);

                  const requestOptions = {
                    method: "GET",
                    headers: myHeaders,
                    redirect: "follow"
                  };

                  return fetch("https://de-fr.my.glooko.com/api/v3/session/users", requestOptions)
                      .then((response) => response.json().then((userData) => {
                        // console.log('User Data:', userData);
                        const session = { cookies: authCookie, user: { userLogin: userData.currentPatient }};
                          console.log(session);
                          
                          glookoSessionManager.initSession(session); // Store session
                          return session;
                      }));
                });
          })
          .catch((error) => {
            console.error('Error in request flow:', error);
          });
    },
    sessionFromAuth (auth) {
      return Promise.resolve(auth);
    },
    dataFromSesssion (session, last_known) {
      var two_days_ago = new Date( ).getTime( ) - (2 * 24 * 60 * 60 * 1000);
      var last_mills = Math.max(two_days_ago, (last_known && last_known.entries) ? last_known.entries.getTime( ) : two_days_ago);
      var last_glucose_at = new Date(last_mills);
      var maxCount = Math.ceil(((new Date( )).getTime( ) - last_mills) / (1000 * 60 * 5));
      var minutes = 5 * maxCount;
      var lastUpdatedAt = last_glucose_at.toISOString( );
      var body = { };
      var params = {
        lastGuid: Defaults.lastGuid,
        lastUpdatedAt,
        limit: maxCount,
      };

      function fetcher (endpoint) {
        // var headers = default_headers;
        // headers["Cookie"] = session.cookies;
        // headers["Host"] = opts.glookoServer; //"eu.api.glooko.com";
        // headers["Sec-Fetch-Dest"] = "empty";
        // headers["Sec-Fetch-Mode"] = "cors";
        // headers["Sec-Fetch-Site"] = "same-site";
        // console.log('GLOOKO FETCHER LOADING', endpoint);
        // return http.get(endpoint, { headers, params })
        //   .then((resp) => resp.data);
        // const authCookie = response.headers.get('set-cookie');
        // console.log('Auth Cookie:', authCookie);

        const myHeaders = new Headers();
        myHeaders.append("Cookie", session.cookies);
        myHeaders.append("Host", opts.glookoServer); //"eu.api.glooko.com")
        myHeaders.append("Sec-Fetch-Dest", "empty");
        myHeaders.append("Sec-Fetch-Mode", "cors");
        myHeaders.append("Sec-Fetch-Site", "same-site");
     const requestOptions = {
          method: "GET",
          headers: myHeaders
        };
        return fetch("https://de-fr.my.glooko.com" + endpoint, requestOptions)
            .then((response) => response.json());
      }

      // 2023-06-11T00:00:00.000Z
      // 2023-06-11T23:59:59.999Z

      const myDate = new Date();
       const dateStringStart = myDate.getFullYear() + '-'
           + ('0' + (myDate.getMonth()+1)).slice(-2) + '-'
           + ('0' + (Math.max(1,myDate.getDate() - myDate.getHours() > 5 ? 0 : 1))).slice(-2);
      const dateString = myDate.getFullYear() + '-'
         + ('0' + (myDate.getMonth()+1)).slice(-2) + '-'
        + ('0' + myDate.getDate()).slice(-2);

      // console.log('SESSION USER', session.user);
      let v3APIURL = Defaults.v3API.replace('_PATIENT_',session.user.userLogin?.glookoCode).replace('_STARTDATE_', dateStringStart + "T00:00:00.000Z").replace('_ENDDATE_', dateString + 'T23:59:59.999Z');
      let v3PumpSettings = Defaults.v3PumpSettings.replace('_PATIENT_',session.user.userLogin?.glookoCode);

      function constructUrl(endpoint) {
        //?patient=orange-waywood-8651&startDate=2020-01-08T06:07:00.000Z&endDate=2020-01-09T06:07:00.000Z
        const myDate = new Date();
        const startDate = new Date(two_days_ago); // myDate.getTime() - 6 * 60 * 60 * 1000);

        const url = endpoint + "?patient=" + session.user.userLogin.glookoCode
         + "&startDate=" + startDate.toISOString()
         + "&endDate=" + myDate.toISOString();

        return url;
      }

      return Promise.all([
        fetcher(v3APIURL),
        fetcher(v3PumpSettings)
        ]).then(function (results) {
          //console.log(Object.values(results[1].deviceSettings.pumps).flatMap(syncSettings => Object.values(syncSettings)));
          // console.log(results[0].series.deliveredBolus);
        var dataResults = results[0].series

        var pumpSettings = Object.values(results[1].deviceSettings.pumps).flatMap(syncSettings => Object.values(syncSettings));
         var some = {
            //food: results[0].foods,
            //insulins: results[1].insulins,
            //scheduledBasals: results[0].scheduledBasals,
            normalBoluses: dataResults.deliveredBolus,
            interruptedBoluses: dataResults.interruptedBolus,
            cgmReadings: [...dataResults.cgmHigh, ...dataResults.cgmNormal,...dataResults.cgmLow],
            bgManuals: [...dataResults.bgHighManual, ...dataResults.bgNormalManual,...dataResults.bgLowManual],
            setSiteChanges: [...new Set(dataResults.setSiteChange)],
            reservoirChanges: [...new Set(dataResults.reservoirChange)],
            hypoModes: [...new Set(dataResults.pumpOp5HypoprotectMode)],
            manualModes: [...dataResults.pumpOp5ManualMode],
            pumpSettings: [...pumpSettings]
         };

         //console.log('food sample', JSON.stringify(some.food[0]));
         //console.log('insulins sample', JSON.stringify(some.insulins[0]));
         //console.log('scheduledBasals sample', JSON.stringify(some.scheduledBasals[0]));
         //console.log('normalBoluses sample', JSON.stringify(some.normalBoluses[0]));
         //console.log('readings sample', JSON.stringify(some.readings[0]));
         //console.log('settings sample', JSON.stringify(results[4]));

          //console.log('GLOOKO DATA FETCH', results, some);
          //console.log('GOT RESULTS FROM GLOOKO', results);
          return some;
        });
    },
    align_to_glucose (last_known) {
      // TODO
	console.log(last_known)

    },
    transformData (batch) {
      // TODO
      console.log('GLOOKO passing batch for transforming');
      console.log("TRANSFORM");
      // var treatments = helper.generate_nightscout_treatments(batch, opts.glookoTimezoneOffset);
      var treatments = helperv3.generate_nightscout_treatmentsv3(batch, opts.glookoTimezoneOffset)
      var entries = helperv3.generate_nightscout_glucosev3(batch, opts.glookoTimezoneOffset)
      var profiles = helperv3.generate_nightscout_pumpSettingsv3(batch, opts.glookoTimezoneOffset)
      return { entries, treatments, profiles };
    },
  };
  function tracker_for ( ) {
    // var { AxiosHarTracker } = require('axios-har-tracker');
    // var tracker = new AxiosHarTracker(http);
    var AxiosTracer = require('../../trace-axios');
    var tracker = AxiosTracer(http);
    return tracker;
  }
  function generate_driver (builder) {
    builder.support_session({
      authenticate: impl.authFromCredentials,
      authorize: impl.sessionFromAuth,
      // refresh: impl.refreshSession,
      delays: {
        REFRESH_AFTER_SESSSION_DELAY: (1000 * 60 * 60 * 24 * 1) - 600000,
        EXPIRE_SESSION_DELAY: 1000 * 60 * 60 * 24 * 1,
      }
    });

    builder.register_loop('Glooko', {
      tracker: tracker_for,
      frame: {
        impl: impl.dataFromSesssion,
        align_schedule: impl.align_to_glucose,
        transform: impl.transformData,
        backoff: {
        // wait 2.5 minutes * 2^attempt
          interval_ms: 2.5 * 60 * 1000

        },
        // only try 3 times to get data
        maxRetries: 1
      },
      // expect new data 15 minutes after last success
      expected_data_interval_ms: 15 * 60 * 1000,
      backoff: {
        // wait 2.5 minutes * 2^attempt
        interval_ms: 2.5 * 60 * 1000
      },
    });
    return builder;
  }
  impl.generate_driver = generate_driver;
  return impl;
}

glookoSource.validate = function validate_inputs (input) {
  var ok = false;
  var baseURL = base_for(input);
  const offset = !isNaN(input.glookoTimezoneOffset) ? input.glookoTimezoneOffset * -60 * 60 * 1000 : 0
  console.log('GLOOKO using ms offset:', offset, input.glookoTimezoneOffset);

  var config = {
    glookoEnv: input.glookoEnv,
    glookoServer: input.glookoServer,
    glookoEmail: input.glookoEmail,
    glookoPassword: input.glookoPassword,
    glookoTimezoneOffset: offset,
    baseURL
  };
  var errors = [ ];
  if (!config.glookoEmail) {
    errors.push({desc: "The Glooko User Login Email is required.. CONNECT_GLOOKO_EMAIL must be an email belonging to an active Glooko User to log in.", err: new Error('CONNECT_GLOOKO_EMAIL') } );
  }
  if (!config.glookoPassword) {
    errors.push({desc: "Glooko User Login Password is required. CONNECT_GLOOKO_PASSWORD must be the password for the Glooko User Login.", err: new Error('CONNECT_GLOOKO_PASSWORD') } );
  }
  ok = errors.length == 0;
  config.kind = ok ? 'glooko' : 'disabled';
  return { ok, errors, config };
}
module.exports = glookoSource;
