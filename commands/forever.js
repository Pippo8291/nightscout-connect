
const { createMachine, Machine, actions, interpret, spawn  } = require('xstate');
var testImpl = require('../testable_driver');
var axios = require('axios');
var builder = require('../lib/builder');
var sources = require('../lib/sources');
var outputs = require('../lib/outputs');
var createLogger = require('../lib/logging');
var { createSyncEndpoint } = require('../lib/sync');

function sidecarLoop (input, output, sync) {
  
  // everything known for output
  // output must be passed into builder, before generate_driver is
  // called.
  var endpoint = outputs(output)(output, axios);
  var make = builder({ output: endpoint, sync });
  // var make = builder({ output });

  // select an available input source implementation based on env
  // variables/config
  var driver = sources(input);
  var _v = driver.validate ? driver.validate(input) : null;
  if (_v && !_v.ok) console.log("VALIDATION ERRORS", { count: _v.errors.length });
  var _opts = (_v && _v.ok) ? _v.config : input;
  console.log("DRIVER CONFIGURED");
  var impl = driver(_opts, axios);
  // var impl = testImpl.fakeFrame({ }, axios);

  impl.generate_driver(make);

  var built = make( );
  // console.log("BUILDER OUTPUT", built);
  return { machine: built, impl };

}

// Anything a machine logs is reduced to a fixed label, printed only with
// --debug / CONNECT_DEBUG (Andy Low, 6abefe1).
function stateMachineLogger (argv) {
  var log = createLogger(argv.debug);
  return (label) => log.debug(typeof label === 'string' ? label : 'State machine log');
}

function main (argv) {
  console.log("STARTING");
  // selected output
  // argv.nightscoutEndpoint;
  // argv.apiSecret;
  // 
  var output = { name: 'nightscout', url: argv.nightscoutEndpoint, apiSecret: argv.apiSecret };
  console.log("CONFIGURED OUTPUT", { name: output.name });
  var input = Object.assign({}, argv, { kind: argv.source, url: argv.sourceEndpoint, apiSecret: argv.sourceApiSecret });
  // argv now carries every CONNECT_* env var, credentials included, so log the
  // shape rather than the values.
  console.log("CONFIGURED INPUT");

  // On-demand Glooko sync (POST /glooko/sync), only with CONNECT_HTTP_PORT.
  var syncEndpoint = createSyncEndpoint(argv, { logger: createLogger(argv.debug) });
  var loop = sidecarLoop(input, output, syncEndpoint ? syncEndpoint.hooks : undefined);
  var actor = interpret(loop.machine, { logger: stateMachineLogger(argv) });
  actor.start( );
  actor.send({type: 'START'});
  if (syncEndpoint) {
    syncEndpoint.attach({
      send: (event) => actor.send(event),
      lastSignInMs: loop.impl.lastSignInMs,
      lastSignInFailureMs: loop.impl.lastSignInFailureMs,
    });
    // Polling goes on without the endpoint (e.g. CONNECT_HTTP_PORT already in use).
    syncEndpoint.listen( ).catch((err) => console.error('nightscout-connect: Glooko sync endpoint could not start'
      + (err && err.code ? ' (' + err.code + ')' : '')));
  }
  // Runs until the process is stopped: a timed STOP would end the sidecar
  // after a day and leave the process manager with nothing to restart.

}


module.exports.command = 'forever [hint]';
module.exports.describe = 'Runs as a background server forever.'
module.exports.builder = (yargs) => yargs.option('source', { alias: 'hint', describe: 'source input', default: 'default', choices: Object.keys(sources.kinds)})
module.exports.handler = main;
