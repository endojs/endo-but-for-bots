// Type definitions for the XS-side handle API for endor TUI regions.
// See ../../../designs/endor-bus-tui.md for the full specification.
//
// These shapes describe what a real implementation will produce; the
// runtime stub in handles.js does not yet honor them.

export interface StyleAttrs {
  fg?: number | string;
  bg?: number | string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  reverse?: boolean;
  strike?: boolean;
}

export interface StyledRun {
  text: string;
  attrs: StyleAttrs;
}

export interface Cell {
  char: string;
  attrs: StyleAttrs;
}

export interface LayoutHint {
  minCols?: number;
  minRows?: number;
  preferredCols?: number;
  preferredRows?: number;
  dock?: 'top' | 'bottom' | 'left' | 'right' | 'fill' | 'float';
  priority?: number;
}

export interface KeyEvent {
  key: string;
  codepoint: number;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

export interface MouseEvent {
  col: number;
  row: number;
  button: 'left' | 'middle' | 'right' | 'wheel-up' | 'wheel-down' | 'none';
  press: 'down' | 'up' | 'move' | 'drag';
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface PasteEvent {
  text: string;
}

export interface FocusEvent {
  focused: boolean;
}

export interface ResizeEvent {
  cols: number;
  rows: number;
}

export type TuiEvent =
  | { kind: 'key'; event: KeyEvent }
  | { kind: 'mouse'; event: MouseEvent }
  | { kind: 'paste'; event: PasteEvent }
  | { kind: 'focus'; event: FocusEvent }
  | { kind: 'resize'; event: ResizeEvent };

/**
 * A logging capability separate from `console`. The Endo platform does
 * not treat `console` as a stdout writer for TUI output; diagnostics
 * flow through this capability so they can be routed to the inspector
 * surface (`packages/tui/src/inspector.js`) rather than corrupting a
 * region's character grid.
 *
 * See `designs/endor-bus-tui.md` § "Logging is not console.log".
 */
export interface LogSink {
  trace(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface TuiRegion {
  regionId: number;
  role: 'text' | 'buffer' | 'canvas';
  clear(): Promise<void>;
  setDefaultAttrs(attrs: StyleAttrs): Promise<void>;
  setText?(runs: StyledRun[]): Promise<void>;
  appendLines?(
    lines: StyledRun[][],
  ): Promise<{ firstLine: number; lastLine: number }>;
  editLine?(lineNumber: number, runs: StyledRun[]): Promise<void>;
  scrollTo?(
    lineNumber: number,
    anchor: 'top' | 'middle' | 'bottom',
  ): Promise<void>;
  drawCells?(col: number, row: number, grid: Cell[][]): Promise<void>;
  events(
    kinds: ('key' | 'mouse' | 'paste' | 'focus' | 'resize')[],
  ): AsyncIterable<TuiEvent>;
  close(): Promise<void>;
}

export interface TuiWindow {
  windowId: number;
  title: string;
  createRegion(spec: {
    role: 'text' | 'buffer' | 'canvas';
    layoutHint?: LayoutHint;
    scrollback?: number;
  }): Promise<TuiRegion>;
  configure(patch: { title?: string; layoutHint?: LayoutHint }): Promise<void>;
  close(): Promise<void>;
  revoked: Promise<{ reason: string }>;
}

export interface TuiScreen {
  cols: number;
  rows: number;
  colorDepth: 1 | 4 | 8 | 24;
  createWindow(spec: {
    title: string;
    role: 'chat' | 'debugger' | 'status' | 'tool' | 'form' | 'log';
    layoutHint?: LayoutHint;
  }): Promise<TuiWindow>;
  changes(): AsyncIterable<{ cols: number; rows: number; attached: boolean }>;
}
