// Entry for the confined-Preact ISLANDS bundle (built by vite.islands.config.js → public/islands/islands.js).
//
// DEFAULT ARCHITECTURE = PROPAGATION NETWORKS (see client/propagator.js + designs/preact-component-trie.md).
// An island is a STATELESS render PROPAGATOR wired to one or more CELLS (data grains) that hold the
// state. The host app (app.js) does not re-render imperatively; it pushes new facts into a cell with
// `addContent`, and the render propagator re-paints through the SANITIZING renderer (renderConfined:
// refs stripped, dangerous tags/attrs removed, frozen SafeEvent — no live DOM). Cap-hygiene holds by
// construction: a cell is only ever given render-safe data (labels/tags), never a swissnum.
import 'ses'; // installs the `assert` shim endo library code destructures at load; does NOT lockdown
import { h } from 'preact';
import { renderConfined } from '@endo/preact-container/renderer';

import { makeCell, react } from './propagator.js';
import { SharesPanel } from './shares-panel.js';

// A render propagator: re-paints `view(...values)` into `el` whenever any wired cell changes.
// This is the one kind of propagator whose effect is the DOM; logic propagators stay headless.
const renderPropagator = (el, cells, view) =>
  react(cells, (...values) => renderConfined(view(...values), el));

// ── Shares island ───────────────────────────────────────────────────────────────────────────────
// One cell (the data grain) holds the render-safe rows; the render propagator wires it to SharesPanel.
const sharesCell = makeCell();
let sharesWired = false;

const islands = {
  // Idempotent: wires the render propagator once (cell → SharesPanel), then feeds the latest data in.
  // `data` = { items:[{label,tag}], components:[{toolName,mode,price,used,atten,revoked}], earned } —
  // render-safe only (no swissnum, no share token). `handlers` index back into app.js's state, where
  // the secrets live: { onCopy(i), onQr(i), onRevoke(i), onCopyComp(i), onRevokeComp(i) }.
  renderShares(el, data, handlers) {
    if (!sharesWired) {
      renderPropagator(el, [sharesCell], d => h(SharesPanel, { ...d, ...handlers }));
      sharesWired = true;
    }
    sharesCell.addContent(data);
  },
};

globalThis.__fieldIslands = islands;
export default islands;
