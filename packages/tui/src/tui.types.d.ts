// Type definitions for the @endo/tui Exo wrapper.  See
// ../../../designs/endor-bus-tui.md for the full specification.
//
// Per kriskowal's review on PR #32, type-only declarations live in a
// `.d.ts` file so the runtime modules stay focused on guards and
// remotables.

import type {
  StyleAttrs,
  StyledRun,
  Cell,
  LayoutHint,
  TuiEvent,
  LogSink,
} from '@endo/tui-xs';

export type { StyleAttrs, StyledRun, Cell, LayoutHint, TuiEvent, LogSink };

/**
 * Shapes for the four method-guarded Exo classes that wrap the XS
 * handle API.  These mirror `interfaces.js`'s `M.interface()` shapes;
 * they are the TypeScript view for IDE assistance.
 */
export interface ScreenMethods {
  help(): string;
  cols(): number;
  rows(): number;
  colorDepth(): 1 | 4 | 8 | 24;
  createWindow(spec: {
    title: string;
    role: 'chat' | 'debugger' | 'status' | 'tool' | 'form' | 'log';
    layoutHint?: LayoutHint;
  }): Promise<unknown>;
  changes(): unknown;
}

export interface WindowMethods {
  help(): string;
  id(): number;
  title(): string;
  createRegion(
    spec: { role: 'text' | 'buffer' | 'canvas' },
    opts?: { layoutHint?: LayoutHint; scrollback?: number },
  ): Promise<unknown>;
  configure(patch: { title?: string; layoutHint?: LayoutHint }): Promise<void>;
  close(): Promise<void>;
  whenRevoked(): Promise<{ reason: string }>;
}

export interface RegionMethods {
  help(): string;
  id(): number;
  role(): 'text' | 'buffer' | 'canvas';
  clear(): Promise<void>;
  setDefaultAttrs(attrs: StyleAttrs): Promise<void>;
  setText(runs: StyledRun[]): Promise<void>;
  appendLines(
    lines: StyledRun[][],
  ): Promise<{ firstLine: number; lastLine: number }>;
  editLine(lineNumber: number, runs: StyledRun[]): Promise<void>;
  scrollTo(
    lineNumber: number,
    anchor: 'top' | 'middle' | 'bottom',
  ): Promise<void>;
  drawCells(col: number, row: number, grid: Cell[][]): Promise<void>;
  events(
    kinds: ('key' | 'mouse' | 'paste' | 'focus' | 'resize')[],
  ): unknown;
  close(): Promise<void>;
}

export interface TextBufferMethods {
  help(): string;
  region(): unknown;
  append(runs: StyledRun[]): Promise<void>;
  appendLines(lines: StyledRun[][]): Promise<void>;
  editLast(runs: StyledRun[]): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The inspector surface that an interactive TUI host exposes for
 * console-log capture, telemetry, and a future stepping debugger.
 *
 * In conventional UNIX-output mode (the default), `endor` does not open
 * the inspector and these capabilities are no-ops.  In interactive TUI
 * mode (`endor -i` / `endor --interactive`), the host reveals the
 * inspector window when the user toggles it open.
 *
 * See `designs/endor-bus-tui.md` § "Inspector surface" for the full
 * design.
 *
 * TODO(endor-bus-tui): wire console-log capture once the daemon
 * grows a per-worker log sink (the daemon must own the sink so
 * `console.*` is not used as a stdout writer).
 *
 * TODO(endor-bus-tui): wire telemetry once the metrics design lands.
 *
 * TODO(endor-bus-tui): wire the stepping debugger once the XS
 * `mxDebug` protocol bridge is implemented; see designs/endor-tui.md.
 */
export interface InspectorSurface {
  /**
   * Append a captured log record from a worker.  The host MUST NOT
   * route worker `console.*` through the same writer that backs region
   * text; logs always land in the inspector pane.
   */
  appendLog(
    record: {
      level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
      message: string;
      worker?: string;
      time?: number;
      fields?: Record<string, unknown>;
    },
  ): Promise<void>;

  /**
   * Append a telemetry sample.  Stub — see TODO above.
   */
  appendSample(
    sample: { name: string; value: number; tags?: Record<string, string> },
  ): Promise<void>;

  /**
   * Open or focus the inspector window.  Resolves once the window is
   * visible.
   */
  open(): Promise<void>;

  /**
   * Hide the inspector window.  The accumulated history is retained;
   * `open()` again to restore it.
   */
  close(): Promise<void>;
}

/**
 * Powers the `make()` entry point receives.
 *
 * - `mode` selects between `'interactive'` (TUI is live) and
 *   `'unix'` (no TUI; `getScreen()` will resolve to undefined).  The
 *   `endor` Rust binary picks the mode from the `-i`/`--interactive`
 *   flag and forwards it to the worker through the bus.
 * - `log` is the explicit logging capability used by the wrapper
 *   itself; `console.*` is never used as a stdout writer in the Endo
 *   platform.
 * - `inspector` is provided in interactive mode only; in UNIX mode
 *   the wrapper falls back to a no-op inspector.
 */
export interface TuiPowers {
  mode: 'interactive' | 'unix';
  log: LogSink;
  inspector?: InspectorSurface;
}
