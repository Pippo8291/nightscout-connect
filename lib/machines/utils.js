
const { createMachine, Machine, actions, interpret, spawn  } = require('xstate');
var redact = require('../redact');

  function increment_field (name) {
    return actions.assign({
      [name]: (context, event) => context[name] + 1
    });
  }

  // A bare actions.log() prints the whole machine context and event:
  // ~40 lines per call, and the context carries the live session cookie.
  // dump_log() keeps that for rare events (errors, logins) with secrets
  // redacted; debug_log() is the per-frame variant and stays silent unless
  // CONNECT_DEBUG is set.
  function dump_log (label) {
    return actions.log((context, event) => redact({ context, event }), label);
  }

  function debug_log (label) {
    if (!process.env.CONNECT_DEBUG) {
      return function debug_log_disabled ( ) { };
    }
    return dump_log(label);
  }

module.exports = { increment_field, dump_log, debug_log };
