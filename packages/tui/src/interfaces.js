// @ts-check

// Exo interface declarations for the endor TUI Exo wrapper.  These
// shapes are exported for documentation and for future Exo consumers;
// a runtime implementation lands separately.  See
// designs/endor-bus-tui.md for the full specification.

import { M } from '@endo/patterns';

const StyleAttrsShape = M.splitRecord(
  {},
  {
    fg: M.or(M.number(), M.string()),
    bg: M.or(M.number(), M.string()),
    bold: M.boolean(),
    italic: M.boolean(),
    underline: M.boolean(),
    reverse: M.boolean(),
    strike: M.boolean(),
  },
);

const StyledRunShape = M.splitRecord({
  text: M.string(),
  attrs: StyleAttrsShape,
});

const CellShape = M.splitRecord({
  char: M.string(),
  attrs: StyleAttrsShape,
});

const LayoutHintShape = M.splitRecord(
  {},
  {
    minCols: M.number(),
    minRows: M.number(),
    preferredCols: M.number(),
    preferredRows: M.number(),
    dock: M.string(),
    priority: M.number(),
  },
);

export const ScreenInterface = M.interface('TuiScreen', {
  help: M.call().returns(M.string()),
  cols: M.call().returns(M.number()),
  rows: M.call().returns(M.number()),
  colorDepth: M.call().returns(M.number()),
  createWindow: M.call(
    M.splitRecord({
      title: M.string(),
      role: M.string(),
    }),
  )
    .optional(LayoutHintShape)
    .returns(M.promise()),
  changes: M.call().returns(M.remotable()),
});

export const WindowInterface = M.interface('TuiWindow', {
  help: M.call().returns(M.string()),
  id: M.call().returns(M.number()),
  title: M.call().returns(M.string()),
  createRegion: M.call(
    M.splitRecord({
      role: M.string(),
    }),
  )
    .optional(
      M.splitRecord(
        {},
        { layoutHint: LayoutHintShape, scrollback: M.number() },
      ),
    )
    .returns(M.promise()),
  configure: M.call(
    M.splitRecord(
      {},
      { title: M.string(), layoutHint: LayoutHintShape },
    ),
  ).returns(M.promise()),
  close: M.call().returns(M.promise()),
  whenRevoked: M.call().returns(M.promise()),
});

export const RegionInterface = M.interface('TuiRegion', {
  help: M.call().returns(M.string()),
  id: M.call().returns(M.number()),
  role: M.call().returns(M.string()),
  clear: M.call().returns(M.promise()),
  setDefaultAttrs: M.call(StyleAttrsShape).returns(M.promise()),
  // text role
  setText: M.call(M.arrayOf(StyledRunShape)).returns(M.promise()),
  // buffer role
  appendLines: M.call(M.arrayOf(M.arrayOf(StyledRunShape))).returns(
    M.promise(),
  ),
  editLine: M.call(M.number(), M.arrayOf(StyledRunShape)).returns(
    M.promise(),
  ),
  scrollTo: M.call(M.number(), M.string()).returns(M.promise()),
  // canvas role
  drawCells: M.call(
    M.number(),
    M.number(),
    M.arrayOf(M.arrayOf(CellShape)),
  ).returns(M.promise()),
  // events
  events: M.call(M.arrayOf(M.string())).returns(M.remotable()),
  close: M.call().returns(M.promise()),
});

export const TextBufferInterface = M.interface('TuiTextBuffer', {
  help: M.call().returns(M.string()),
  region: M.call().returns(M.remotable()),
  append: M.call(M.arrayOf(StyledRunShape)).returns(M.promise()),
  appendLines: M.call(M.arrayOf(M.arrayOf(StyledRunShape))).returns(
    M.promise(),
  ),
  editLast: M.call(M.arrayOf(StyledRunShape)).returns(M.promise()),
  clear: M.call().returns(M.promise()),
  close: M.call().returns(M.promise()),
});
