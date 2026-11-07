'use strict';

// Wires the on-demand Glooko sync into the stand-alone importer:
//   const endpoint = createSyncEndpoint(argv, { logger });  // null without CONNECT_HTTP_PORT
//   builder({ output, sync: endpoint.hooks })                 // frame observers
//   endpoint.attach({ send: actor.send, lastSignInMs })       // once the actor exists
//   await endpoint.listen()
// See lib/sync/controller.js for the rules and lib/sync/server.js for the API.

const crypto = require('crypto');
const { createTokenChecker, defaultRolesGrant, getJson: defaultGetJson } = require('./auth');
const { createSyncController } = require('./controller');
const { createSyncServer } = require('./server');

const DEFAULT_PERMISSION = 'api:treatments:create';

function createSyncEndpoint (argv, { logger: base, getJson = defaultGetJson, host = '0.0.0.0' } = {}) {
  if (argv.httpPort === undefined || argv.httpPort === null || argv.httpPort === '') return null;
  // lib/logging has no info level: the endpoint's status lines are debug output.
  const logger = {
    info: (m) => base && (base.info ? base.info(m) : base.debug(m)),
    warn: (m) => base && base.warn(m),
    error: (m) => base && base.error(m),
  };
  const port = Number(argv.httpPort);
  const permission = argv.syncPermission || DEFAULT_PERMISSION;
  const nightscoutUrl = String(argv.nightscoutEndpoint || '').replace(/\/+$/, '');
  const glooko = argv.source === 'glooko';
  let controller = null;

  const hooks = {
    on_frame_start: ( ) => controller && controller.onFrameStart( ),
    on_transformed: (data) => controller && controller.onTransformed(data),
    on_frame_outcome: (outcome) => controller && controller.onFrameOutcome(outcome),
  };

  function attach ({ send, lastSignInMs }) {
    controller = createSyncController({
      send,
      lastSignInMs: lastSignInMs || (( ) => null),
      // Unreferenced: pending follow-ups must not keep a stopping process alive.
      setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref( ); return t; },
    });
    return controller;
  }

  // Whether the Nightscout's default roles already grant the permission: then
  // every token would pass the check, so the endpoint stays off.
  async function disabledReason ( ) {
    const headers = argv.apiSecret
      ? { 'api-secret': crypto.createHash('sha1').update(String(argv.apiSecret)).digest('hex') }
      : { };
    try {
      const status = await getJson(nightscoutUrl + '/api/v1/status.json', { headers });
      const roles = status && status.data && status.data.settings && status.data.settings.authDefaultRoles;
      const grant = defaultRolesGrant(roles, permission);
      if (grant === true) {
        logger.error('Glooko sync endpoint disabled: the Nightscout default roles grant ' + permission);
        return 'default roles grant ' + permission + ' to every token; endpoint disabled';
      }
      if (grant === null) logger.warn('Glooko sync endpoint: default roles could not be checked (custom role)');
    } catch (_) {
      logger.warn('Glooko sync endpoint: default roles could not be read');
    }
    return null;
  }

  async function listen ( ) {
    const reason = await disabledReason( );
    const server = createSyncServer({
      controller: { request: ( ) => controller.request( ) },
      checker: createTokenChecker({ nightscoutUrl, permission, request: (url) => getJson(url) }),
      glooko,
      disabledReason: reason,
      permission,
      logger,
    });
    await new Promise((resolve) => server.listen(port, host, resolve));
    logger.info('Glooko sync endpoint listening on port ' + server.address( ).port);
    return server;
  }

  return { hooks, attach, listen, controller: ( ) => controller };
}

module.exports = { createSyncEndpoint };
