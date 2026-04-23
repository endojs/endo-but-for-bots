// @ts-check

// Stub entry point for the @endo/tui Exo wrapper.  Every method of
// every returned remotable throws "not implemented"; a real
// implementation that wires these Exos to the XS handle API and the
// bus lands separately.  See designs/endor-bus-tui.md.

import { makeExo } from '@endo/exo';
import harden from '@endo/harden';
import {
  ScreenInterface,
  WindowInterface,
  RegionInterface,
  TextBufferInterface,
} from './src/interfaces.js';

export {
  ScreenInterface,
  WindowInterface,
  RegionInterface,
  TextBufferInterface,
};

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
 * Guest `make(powers)` entry point.  Returns a stub screen exo today;
 * a real implementation acquires the worker's screen handle from
 * `@endo/tui-xs` and wires it to the Exo method guards.
 *
 * @param {unknown} _powers
 */
export const make = async _powers => {
  return harden({ screen: makeStubScreen() });
};
harden(make);
