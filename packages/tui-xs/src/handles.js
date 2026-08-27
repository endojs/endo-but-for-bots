// @ts-check

// Stub XS-side handle API for endor TUI regions.  See
// designs/endor-bus-tui.md for the full specification.  This module
// declares the runtime entry point a real implementation will provide,
// but does not carry any runtime behavior — every method throws
// "not implemented".
//
// Type definitions for the handle shapes (StyleAttrs, StyledRun, Cell,
// LayoutHint, KeyEvent, MouseEvent, TuiEvent, TuiRegion, TuiWindow,
// TuiScreen, LogSink) live in the sibling `types.d.ts`.  Per
// kriskowal's review on PR #32, type-only declarations belong in a
// `.d.ts` so the runtime module stays focused on runtime code.

import harden from '@endo/harden';

/** @import { TuiScreen } from './tui-xs.types.js' */

/**
 * Acquire the currently attached screen for this worker.  Returns
 * `undefined` when no screen is attached.
 *
 * Stub implementation: always returns a rejected promise until the
 * bus-protocol plumbing lands.  See designs/endor-bus-tui.md.
 *
 * @returns {Promise<TuiScreen | undefined>}
 */
export const getScreen = async () => {
  throw Error('endor TUI XS handle API: not implemented');
};
harden(getScreen);
