'use strict';

// POST /glooko/sync — on-demand Glooko sync for apps such as diamanage.
// Started by the stand-alone `forever` command only when CONNECT_HTTP_PORT is
// set. Put it behind TLS (a reverse proxy): the request carries a Nightscout
// JWT. The token is never logged or echoed.

const http = require('http');

function createSyncServer ({ controller, checker, glooko, disabledReason, permission = 'api:treatments:create', logger }) {
  function reply (res, status, body) {
    const json = JSON.stringify(body || {});
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(json);
  }

  async function handle (req, res) {
    const path = String(req.url || '').split('?')[0];
    if (path !== '/glooko/sync') return reply(res, 404, { error: 'not found' });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reply(res, 405, { error: 'method not allowed' });
    }
    if (disabledReason) return reply(res, 503, { error: disabledReason });
    if (!glooko) return reply(res, 404, { error: 'this importer does not run the Glooko source' });

    const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    if (!match) return reply(res, 401, { error: 'missing bearer token' });

    const verdict = await checker.check(match[1]);
    if (!verdict.ok) {
      if (verdict.status === 403) return reply(res, 403, { error: 'missing permission', permission });
      if (verdict.status === 401) return reply(res, 401, { error: 'unknown token' });
      return reply(res, 503, { error: 'Nightscout unreachable for the token check' });
    }

    const result = await controller.request( );
    const { status, ...body } = result;
    logger.info('Glooko sync requested: ' + status + (body.signedIn ? ', signed in again' : ''));
    return reply(res, status, body);
  }

  return http.createServer((req, res) => {
    // Drain the (unused) request body so keep-alive connections stay usable.
    req.resume( );
    handle(req, res).catch(( ) => {
      // The error may quote the token (a failed request URL): log a fixed text only.
      logger.error('Glooko sync request failed');
      if (!res.headersSent) reply(res, 500, { error: 'internal error' });
    });
  });
}

module.exports = { createSyncServer };
