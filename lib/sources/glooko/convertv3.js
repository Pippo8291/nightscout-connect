var moment = require('moment');

function generate_nightscout_treatmentsv3(batch, timestampDelta) {
      // Snack Bolus
      // Meal Bolus
      // BG Check
      // Correction Bolus
      // Carb Correction  
  /*
  var foods = entries['foods']['foods']; //ugh
  var insulins = entries['insulins']['insulins'];
  var pumpBoluses = entries['pumpBoluses']['normalBoluses']
  */
  const foods = batch.foods;
  const insulins = batch.insulins;
  const pumpBoluses = batch.normalBoluses;
  const interruptedBoluses = batch.interruptedBoluses;
  const scheduledBasals = batch.scheduledBasals;
  const bgManuals = batch.bgManuals;
  const setSiteChanges = batch.setSiteChanges;
  const reservoirChanges = batch.reservoirChanges;
  const manualModes = batch.manualModes;
  const hypoModes = batch.hypoModes;

  var treatments = []

  if (foods) {
    foods.forEach(function(element) {
      var treatment = {};

      //console.log(element);
      var f_date = new Date(element.timestamp);
      var f_s_date = new Date(f_date.getTime()  + timestampDelta - 45*60000);
      var f_e_date = new Date(f_date.getTime()  + timestampDelta + 45*60000);

      var now = moment(f_date); //todays date
      var end = moment(f_s_date); // another date
      var duration = moment.duration(now.diff(end));
      var minutes = duration.asMinutes();

      var i_date = new Date();
      var result = insulins.filter(function(el) {
          i_date = new Date(el.timestamp);
          var i_moment = moment(i_date);
          var duration = moment.duration(now.diff(i_moment));
          var minutes = duration.asMinutes();
          return Math.abs(minutes) < 46;

      })
      

      insulin = result[0];
      if (insulin != undefined) {
        var i_date = moment(insulin.timestamp);
        treatment.eventType = 'Meal Bolus';
        // 4 hours * 60 minutes per hour * 60 seconds per minute * 1000 millseconds
        treatment.eventTime = new Date(i_date ).toISOString( );
        //treatment.eventTime = new Date(i_date).toISOString( );
        //treatment.eventTime = i_date.toISOString( );
        treatment.insulin = insulin.value;
        

        treatment.preBolus = moment.duration(moment(f_date).diff(moment(i_date))).asMinutes();
      } else {
        var f_date = moment(element.timestamp);
        treatment.eventType = 'Carb Correction';
        treatment.eventTime = new Date(f_date ).toISOString( );
        //treatment.eventTime = new Date(f_date).toISOString( );
        //treatment.eventTime = f_date.toISOString( );
      }

      treatment.carbs = element.carbs;
      treatment.notes = JSON.stringify(element);
      
      treatments.push(treatment);
      //console.log(treatment)

    });    
  }

  if (insulins) {
    insulins.forEach(function(element) {
      var treatment = {};

      //console.log(element);
      var f_date = new Date(element.timestamp);
      var f_s_date = new Date(f_date.getTime() + timestampDelta - 45*60000);
      var f_e_date = new Date(f_date.getTime() + timestampDelta + 45*60000);

      var now = moment(f_date); //todays date
      var end = moment(f_s_date); // another date
      var duration = moment.duration(now.diff(end));
      var minutes = duration.asMinutes();

      var i_date = new Date();
      var result = foods.filter(function(el) {
          i_date = new Date(el.timestamp);
          var i_moment = moment(i_date);
          var duration = moment.duration(now.diff(i_moment));
          var minutes = duration.asMinutes();
          return Math.abs(minutes) < 46;

      })
      //console.log(result);
      if (result[0] == undefined) {
        var f_date = moment(element.timestamp);
        treatment.eventType = 'Correction Bolus';
        treatment.eventTime = new Date(f_date).toISOString( );
        treatment.insulin = element.value;
        treatments.push(treatment);
      }
    });    
  }

  if (pumpBoluses) {
    pumpBoluses.forEach(function(element) {
      var treatment = {};

      //console.log(element);
      
      var f_date = moment(element.timestamp);
      treatment.eventType = 'Meal Bolus';
      treatment.eventTime = new Date(f_date + timestampDelta).toISOString( );
      treatment.insulin = element.insulinDelivered;
      treatment.carbs = element.carbsInput;
      treatment.notes = JSON.stringify(element);
      treatments.push(treatment);
    })
  }

  if (interruptedBoluses) {
    interruptedBoluses.forEach(function(element) {
      var treatment = {};

      var f_date = moment(element.timestamp);
      treatment.eventType = 'Announcement';
      treatment.eventTime = new Date(f_date + timestampDelta).toISOString( );
      treatment.notes = 'Interrupted insulin delivery! ' + `delivered: ${element.insulinDelivered}, recommended: ${element.totalInsulinRecommendation} - full message: ${JSON.stringify(element)}`;
      treatments.push(treatment);
    })
  }

  /*

  {
    "_id": "6481762cd06cbb6e6c06a6b7",
    "duration": 30,
    "timestamp": "2023-06-08T09:31:35+03:00",
    "absolute": 0,
    "rate": 0,
    "eventType": "Temp Basal",
    "medtronic": "mm://openaps/mm-format-ns-treatments/Temp Basal",
    "created_at": "2023-06-08T09:31:35.000+03:00",
    "enteredBy": "openaps://medtronic/"
  }
  
    {
      pumpTimestamp: '2023-06-15T12:07:30.000Z',
      pumpTimestampUtcOffset: '+00:00',
      pumpGuid: '520dd015-1b04-410b-8962-35d78b4a90e8',
      syncTimestamp: '2023-06-15T10:24:45.184Z',
      startTime: 43650,
      duration: 4582,
      segmentId: null,
      rate: 0,
      guid: 'dc335f52-0b66-11ee-ab49-0242ac110002',
      softDeleted: false,
      updatedAt: '2023-06-15T10:24:50.380Z',
      updatedBy: 'server'
    }
  */
  if (bgManuals) {
    bgManuals.forEach(function(element) {
      var treatment = {};

      var f_date = moment(element.timestamp);
      treatment.eventType = 'BG Check';
      treatment.eventTime = new Date(f_date + timestampDelta).toISOString( );
      treatment.units = "mg/dl";
      treatment.glucose = element.y;
      treatment.glucoseType = "Finger";
      treatment.notes = JSON.stringify(element);
      treatments.push(treatment);
    })
  }
  if (setSiteChanges) {
    setSiteChanges.forEach(function(element) {
      var treatment = {};

      var f_date = moment(element.timestamp);
      treatment.eventType = 'Site Change';
      treatment.eventTime = new Date(f_date + timestampDelta).toISOString( );
      treatment.notes = JSON.stringify(element);
      treatments.push(treatment);
    })
  }
  if (reservoirChanges) {
    reservoirChanges.forEach(function(element) {
      var treatment = {};

      var f_date = moment(element.timestamp);
      treatment.eventType = 'Insulin Cartridge Change';
      treatment.eventTime = new Date(f_date + timestampDelta).toISOString( );
      treatment.notes = JSON.stringify(element);
      treatments.push(treatment);
    })
  }
  if (manualModes) {
    // to be checked if always one interpolated false
    manualModes.filter(manualMode => !manualMode.interpolated).forEach(function(element) {
      var treatment = {};

      var f_date = moment(element.timestamp);
      treatment.eventType = 'Profile Switch';
      treatment.eventTime = new Date(f_date + timestampDelta).toISOString( );
      treatment.duration = element.duration / 60;
      treatment.profile = 'MANUAL';
      treatment.created_at = new Date(f_date + timestampDelta).toISOString();
      treatments.push(treatment);
    })
  }
  if (hypoModes) {
    // to be checked if always one interpolated false
    hypoModes.filter(manualMode => !manualMode.interpolated).forEach(function(element) {
      var treatment = {};

      var f_date = moment(element.timestamp);
      treatment.eventType = 'Exercise';
      treatment.eventTime = new Date(f_date + timestampDelta).toISOString( );
      treatment.duration = element.duration / 60;
      treatment.notes = `Activity Mode: ${JSON.stringify(element)}`;
      treatments.push(treatment);
    })
  }
  if (scheduledBasals) {
    scheduledBasals.forEach(function (element) {
      var treatment = {};

      //console.log(element);

      var f_date = moment(element.pumpTimestamp);
      treatment.eventType = 'Temp Basal';
      treatment.created_at = new Date(f_date + timestampDelta).toISOString();
      treatment.rate = element.rate;
      treatment.absolute = element.rate;
      treatment.duration = element.duration / 60;
      treatment.notes = JSON.stringify(element);
      //treatment.eventTime = f_date.toISOString( );
      treatments.push(treatment);
    })
  }

  console.log('GLOOKO data transformation complete, returning', treatments.length, 'treatments');

  return treatments;
}

function generate_nightscout_glucosev3(batch, timestampDelta) {
  let cgmEntries = batch.cgmReadings;
  var entries = [];
  cgmEntries.forEach((cgmEntry) => {

    var f_date = moment(cgmEntry.timestamp);
    let date = new Date(f_date + timestampDelta);
    var entry = {
      sgv: cgmEntry.y
      , date:  date.getTime()
      , dateString: date.toISOString( )
      // , trend: trend
      // , direction: trendToDirection(trend)
      , device: 'nightscout-connect'
      , type: 'sgv'
    };
    entries.push(entry)
  })
  return entries;
}

function generate_nightscout_pumpSettingsv3(batch, timestampDelta) {
  const pumpSettings = batch.pumpSettings;
  var settings = [];

  function convertSeconds(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  }

  function generateStore(pumpSettingElement, profileName, startDate) {
    const automaticModeProfile={
      dia: pumpSettingElement.generalSettings.activeInsulinTime,
      carbratio: pumpSettingElement.profilesBolus[0].insulinToCarbRatioSegments.data.flatMap(segment => {
        const seconds = segment.segmentStart * 3600;
        return {time: convertSeconds(seconds),
          timeAsSeconds: seconds,
          value: segment.value}
      }),
      carbs_hr: 12,
      delay: 12,
      sens: pumpSettingElement.profilesBolus[0].isfSegments.data.flatMap(segment => {
        const seconds = segment.segmentStart * 3600;
        return {time: convertSeconds(seconds),
          timeAsSeconds: seconds,
          value: segment.value}
      }),
      startDate: startDate,
      target_high: pumpSettingElement.profilesBolus[0].targetBgSegments.data.flatMap(segment => {
        const seconds = segment.segmentStart * 3600;
        return {time: convertSeconds(seconds),
          value: segment.value}
      }),
      target_low: pumpSettingElement.profilesBolus[0].targetBgSegments.data.flatMap(segment => {
        const seconds = segment.segmentStart * 3600;
        return {time: convertSeconds(seconds),
          value: 70}
      }),
      basal: [{time: '00:00', value: 0, timeAsSeconds: 0}],
    };
    return {
      [profileName]: automaticModeProfile,
      ["MANUAL"]: {
        ...automaticModeProfile,
        basal: pumpSettingElement.pumpProfilesBasal[0].segments.data.flatMap(segment => {
          const seconds = segment.segmentStart * 3600;
          return {
            time: convertSeconds(seconds),
            timeAsSeconds: seconds,
            value: segment.value}
        }),
      }
    }
  }
  pumpSettings?.forEach(function(element, index) {
    var pumpSetting = {};

    var f_date = moment(element.syncTimestamp);
    // without ms because leading to error
    var date = new Date(f_date + timestampDelta)
    var profileName = date.toISOString().split('.')[0];
    pumpSetting.defaultProfile = profileName
    pumpSetting.startDate =  date;
    pumpSetting.millis =  date.getTime();
    pumpSetting.store = generateStore(element, profileName, date.toISOString( ));
    pumpSetting.units = "mg/dl";
    settings.push(pumpSetting);
  })
  return settings;
}

module.exports.generate_nightscout_treatmentsv3 = generate_nightscout_treatmentsv3;
module.exports.generate_nightscout_glucosev3 = generate_nightscout_glucosev3;
module.exports.generate_nightscout_pumpSettingsv3 = generate_nightscout_pumpSettingsv3;
