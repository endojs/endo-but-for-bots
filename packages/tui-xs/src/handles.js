// @ts-check

// Stub XS-side handle API for endor TUI regions.  See
// designs/endor-bus-tui.md for the full specification.  This module
// declares the shapes a real implementation will produce, but does not
// carry any runtime behavior — every method throws "not implemented".

import harden from '@endo/harden';

/**
 * @typedef {object} StyleAttrs
 * @property {number | string} [fg]
 * @property {number | string} [bg]
 * @property {boolean} [bold]
 * @property {boolean} [italic]
 * @property {boolean} [underline]
 * @property {boolean} [reverse]
 * @property {boolean} [strike]
 */

/**
 * @typedef {object} StyledRun
 * @property {string} text
 * @property {StyleAttrs} attrs
 */

/**
 * @typedef {object} Cell
 * @property {string} char
 * @property {StyleAttrs} attrs
 */

/**
 * @typedef {object} LayoutHint
 * @property {number} [minCols]
 * @property {number} [minRows]
 * @property {number} [preferredCols]
 * @property {number} [preferredRows]
 * @property {'top'|'bottom'|'left'|'right'|'fill'|'float'} [dock]
 * @property {number} [priority]
 */

/**
 * @typedef {object} KeyEvent
 * @property {string} key
 * @property {number} codepoint
 * @property {boolean} [ctrl]
 * @property {boolean} [alt]
 * @property {boolean} [shift]
 * @property {boolean} [meta]
 */

/**
 * @typedef {object} MouseEvent
 * @property {number} col
 * @property {number} row
 * @property {'left'|'middle'|'right'|'wheel-up'|'wheel-down'|'none'} button
 * @property {'down'|'up'|'move'|'drag'} press
 * @property {boolean} [ctrl]
 * @property {boolean} [alt]
 * @property {boolean} [shift]
 */

/**
 * @typedef {object} PasteEvent
 * @property {string} text
 */

/**
 * @typedef {object} FocusEvent
 * @property {boolean} focused
 */

/**
 * @typedef {object} ResizeEvent
 * @property {number} cols
 * @property {number} rows
 */

/**
 * @typedef {(
 *   | { kind: 'key', event: KeyEvent }
 *   | { kind: 'mouse', event: MouseEvent }
 *   | { kind: 'paste', event: PasteEvent }
 *   | { kind: 'focus', event: FocusEvent }
 *   | { kind: 'resize', event: ResizeEvent }
 * )} TuiEvent
 */

/**
 * @typedef {object} TuiRegion
 * @property {number} regionId
 * @property {'text'|'buffer'|'canvas'} role
 * @property {() => Promise<void>} clear
 * @property {(attrs: StyleAttrs) => Promise<void>} setDefaultAttrs
 * @property {(runs: StyledRun[]) => Promise<void>} [setText]
 * @property {(lines: StyledRun[][]) => Promise<{ firstLine: number, lastLine: number }>} [appendLines]
 * @property {(lineNumber: number, runs: StyledRun[]) => Promise<void>} [editLine]
 * @property {(lineNumber: number, anchor: 'top'|'middle'|'bottom') => Promise<void>} [scrollTo]
 * @property {(col: number, row: number, grid: Cell[][]) => Promise<void>} [drawCells]
 * @property {(kinds: ('key'|'mouse'|'paste'|'focus'|'resize')[]) => AsyncIterable<TuiEvent>} events
 * @property {() => Promise<void>} close
 */

/**
 * @typedef {object} TuiWindow
 * @property {number} windowId
 * @property {string} title
 * @property {(spec: { role: 'text'|'buffer'|'canvas', layoutHint?: LayoutHint, scrollback?: number }) => Promise<TuiRegion>} createRegion
 * @property {(patch: { title?: string, layoutHint?: LayoutHint }) => Promise<void>} configure
 * @property {() => Promise<void>} close
 * @property {Promise<{ reason: string }>} revoked
 */

/**
 * @typedef {object} TuiScreen
 * @property {number} cols
 * @property {number} rows
 * @property {1 | 4 | 8 | 24} colorDepth
 * @property {(spec: { title: string, role: 'chat'|'debugger'|'status'|'tool'|'form'|'log', layoutHint?: LayoutHint }) => Promise<TuiWindow>} createWindow
 * @property {() => AsyncIterable<{ cols: number, rows: number, attached: boolean }>} changes
 */

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
