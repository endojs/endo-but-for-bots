// @ts-check

// Inspector surface for the interactive TUI host.  In `endor`'s
// interactive mode (`endor -i`/`--interactive`), the TUI exposes an
// inspector window that surfaces:
//
//   - Worker `console.*` log records, captured by the daemon and
//     forwarded through this capability.  The Endo platform does NOT
//     treat `console` as a stdout writer; logs flow through this
//     dedicated capability so they cannot corrupt a region's
//     character grid.  See `designs/endor-bus-tui.md` § "Logging is
//     not console.log".
//   - Telemetry samples (counters, histograms) — TODO once the
//     metrics design lands.
//   - A stepping debugger over the Moddable XS `mxDebug` protocol —
//     TODO once the bridge in `designs/endor-tui.md` is implemented.
//
// In conventional UNIX-output mode (the default), the inspector is a
// no-op; `appendLog`/`appendSample` accept and discard, `open`/`close`
// are no-ops.  Construction never fails.
//
// This is a stub.  The real wiring lives in the Rust `endor` host
// (`rust/endo/src/`) — JS only describes the shape of the capability
// the host hands across the bus.

import { makeExo } from '@endo/exo';
import harden from '@endo/harden';

import { InspectorInterface } from './interfaces.js';

/** @import { InspectorSurface, LogSink } from './tui.types.js' */

/**
 * Make a no-op inspector exo.  Suitable for conventional UNIX-output
 * mode and for tests; every method resolves silently.
 *
 * @returns {object} a makeExo remotable implementing InspectorInterface
 */
export const makeNoopInspector = () =>
  makeExo(
    'TuiInspector',
    InspectorInterface,
    harden({
      help: () => 'TUI inspector (no-op) — UNIX mode discards logs/samples',
      appendLog: async () => undefined,
      appendSample: async () => undefined,
      open: async () => undefined,
      close: async () => undefined,
    }),
  );
harden(makeNoopInspector);

/**
 * Make a stub inspector exo whose mutating methods throw "not
 * implemented".  Used by the interactive mode entry point as a
 * placeholder until the Rust host wires the real capability.
 *
 * @returns {object} a makeExo remotable implementing InspectorInterface
 */
export const makeStubInspector = () => {
  const notImplemented = () => {
    throw Error('endor TUI inspector: not implemented');
  };
  return makeExo(
    'TuiInspector',
    InspectorInterface,
    harden({
      help: () =>
        'TUI inspector (stub) — interactive surface for logs, telemetry, and debugger',
      appendLog: async () => notImplemented(),
      appendSample: async () => notImplemented(),
      open: async () => notImplemented(),
      close: async () => notImplemented(),
    }),
  );
};
harden(makeStubInspector);

/**
 * A console-free `LogSink` adapter that routes log calls through an
 * inspector exo.  The Endo platform forbids using `console.*` as a
 * stdout writer; library code that needs to emit diagnostics asks for
 * a `LogSink` capability and uses it instead.
 *
 * @param {object} inspector - an Exo implementing InspectorInterface
 * @returns {LogSink}
 */
export const makeInspectorLogSink = inspector => {
  const send = (level, message, fields) => {
    // Fire-and-forget; the inspector handles back-pressure on its
    // own.  We deliberately do NOT use console.* here; that is the
    // whole point of this capability.
    void inspector.appendLog(harden({ level, message, fields }));
  };
  return harden({
    trace: (message, fields) => send('trace', message, fields),
    debug: (message, fields) => send('debug', message, fields),
    info: (message, fields) => send('info', message, fields),
    warn: (message, fields) => send('warn', message, fields),
    error: (message, fields) => send('error', message, fields),
  });
};
harden(makeInspectorLogSink);
