// @ts-check

// Stub entry point for the @endo/tui Exo wrapper.  Every method of
// every returned remotable throws "not implemented" today; a real
// implementation that wires these Exos to the XS handle API and the
// bus lands separately.  See designs/endor-bus-tui.md.
//
// Mode selection: the `endor` Rust binary decides at startup whether
// to run in interactive TUI mode (`-i`/`--interactive`) or
// conventional UNIX-output mode (the default).  In interactive mode
// the host opens the inspector window and exposes its capability to
// guest workers.  In UNIX mode the inspector is a no-op and the
// platform behaves as a conventional process: stdout is for program
// output, stderr is for diagnostics, and there is no curses-style
// repaint.  See the `make` factory below.
//
// Re-use note: the same Exo wrapper is intended to back the Endo
// Chat UI when surfaced as a TUI, so a confined program can
// interactively request permissions through the messaging layer
// (see designs/endor-tui.md).  The Chat-as-TUI work re-uses the
// `make({ mode: 'interactive', ... })` shape; nothing in this file
// is Chat-specific.  TODO(endor-tui): expose a Chat-flavored powers
// surface once that integration is designed.

import { makeExo } from '@endo/exo';
import harden from '@endo/harden';

import {
  ScreenInterface,
  WindowInterface,
  RegionInterface,
  TextBufferInterface,
  InspectorInterface,
} from './src/interfaces.js';
import {
  makeNoopInspector,
  makeStubInspector,
  makeInspectorLogSink,
} from './src/inspector.js';

/** @import { TuiPowers, LogSink } from './src/tui.types.js' */

export {
  ScreenInterface,
  WindowInterface,
  RegionInterface,
  TextBufferInterface,
  InspectorInterface,
};
export {
  makeNoopInspector,
  makeStubInspector,
  makeInspectorLogSink,
} from './src/inspector.js';

const notImplemented = () => {
  throw Error('endor TUI Exo wrapper: not implemented');
};

const stubScreenMethods = harden({
  help: () => 'TUI screen — createWindow/changes (stub)',
  cols: () => notImplemented(),
  rows: () => notImplemented(),
  colorDepth: () => notImplemented(),
  createWindow: async () => notImplemented(),
  changes: () => notImplemented(),
});

const stubWindowMethods = harden({
  help: () => 'TUI window — createRegion/configure/close/whenRevoked (stub)',
  id: () => notImplemented(),
  title: () => notImplemented(),
  createRegion: async () => notImplemented(),
  configure: async () => notImplemented(),
  close: async () => notImplemented(),
  whenRevoked: async () => notImplemented(),
});

const stubRegionMethods = harden({
  help: () => 'TUI region — setText/appendLines/drawCells/events/close (stub)',
  id: () => notImplemented(),
  role: () => notImplemented(),
  clear: async () => notImplemented(),
  setDefaultAttrs: async () => notImplemented(),
  setText: async () => notImplemented(),
  appendLines: async () => notImplemented(),
  editLine: async () => notImplemented(),
  scrollTo: async () => notImplemented(),
  drawCells: async () => notImplemented(),
  events: () => notImplemented(),
  close: async () => notImplemented(),
});

const stubTextBufferMethods = harden({
  help: () => 'TUI text buffer — append/appendLines/editLast (stub)',
  region: () => notImplemented(),
  append: async () => notImplemented(),
  appendLines: async () => notImplemented(),
  editLast: async () => notImplemented(),
  clear: async () => notImplemented(),
  close: async () => notImplemented(),
});

/**
 * Factory for a stub `TuiScreen` exo.  Every method throws "not
 * implemented".
 *
 * @returns {object} a makeExo remotable
 */
export const makeStubScreen = () =>
  makeExo('TuiScreen', ScreenInterface, stubScreenMethods);
harden(makeStubScreen);

/**
 * Factory for a stub `TuiWindow` exo.
 *
 * @returns {object} a makeExo remotable
 */
export const makeStubWindow = () =>
  makeExo('TuiWindow', WindowInterface, stubWindowMethods);
harden(makeStubWindow);

/**
 * Factory for a stub `TuiRegion` exo.
 *
 * @returns {object} a makeExo remotable
 */
export const makeStubRegion = () =>
  makeExo('TuiRegion', RegionInterface, stubRegionMethods);
harden(makeStubRegion);

/**
 * Factory for a stub `TuiTextBuffer` exo.
 *
 * @returns {object} a makeExo remotable
 */
export const makeStubTextBuffer = () =>
  makeExo('TuiTextBuffer', TextBufferInterface, stubTextBufferMethods);
harden(makeStubTextBuffer);

/**
 * Make a silent `LogSink` that discards every record.  Used in UNIX
 * mode when no inspector is present.  Library code should never fall
 * back to `console.*` for diagnostics (the Endo platform forbids
 * treating `console` as a stdout writer); a silent sink is the
 * correct default.
 *
 * @returns {LogSink}
 */
export const makeSilentLogSink = () =>
  harden({
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });
harden(makeSilentLogSink);

/**
 * Guest `make(powers)` entry point.  Returns a screen exo and the
 * inspector capability appropriate for the selected mode.
 *
 * The `endor` Rust host calls this after parsing `-i`/`--interactive`
 * and constructs `powers` accordingly:
 *
 *   - `mode: 'interactive'` — opens the TUI; supplies a real
 *     inspector capability that surfaces console-log capture,
 *     telemetry, and (someday) a stepping debugger.
 *   - `mode: 'unix'` — conventional process; no TUI, inspector is a
 *     no-op, logs are discarded by the default sink.
 *
 * A real implementation acquires the worker's screen handle from
 * `@endo/tui-xs` and wires it to the Exo method guards.  This stub
 * returns placeholder remotables.
 *
 * @param {Partial<TuiPowers>} [powers]
 * @returns {Promise<{
 *   mode: 'interactive' | 'unix',
 *   screen: object,
 *   inspector: object,
 *   log: LogSink,
 * }>}
 */
export const make = async (powers = {}) => {
  const mode = powers.mode === 'interactive' ? 'interactive' : 'unix';
  const inspector =
    powers.inspector !== undefined
      ? powers.inspector
      : mode === 'interactive'
        ? makeStubInspector()
        : makeNoopInspector();
  const log =
    powers.log !== undefined
      ? powers.log
      : mode === 'interactive'
        ? makeInspectorLogSink(inspector)
        : makeSilentLogSink();
  return harden({
    mode,
    screen: makeStubScreen(),
    inspector,
    log,
  });
};
harden(make);
