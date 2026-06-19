// Entry for the confined-Preact ISLANDS bundle (built by vite.islands.config.js → public/islands/islands.js).
//
// The existing DOM app (app.js) calls the functions hung on `globalThis.__fieldIslands` to render a
// migrated slice through the SANITIZING renderer. Each island gets a host mount node + plain data +
// callbacks; the component renders confined (refs stripped, dangerous tags/attrs removed, SafeEvent
// facade — no live DOM). We migrate one slice at a time; until a slice is wired, app.js keeps its DOM
// path, so the app always works (incremental islands — see designs/preact-component-trie.md).
import 'ses'; // installs the `assert` shim that endo library code destructures at load; does NOT lockdown
import { h } from 'preact';
import { renderConfined } from '@endo/preact-container/renderer';

import { SharesPanel } from './shares-panel.js';

const islands = {
  // Render the Shares panel into `el`. `props` = { items:[{label,tag}], onCopy(i), onQr(i), onRevoke(i) }.
  // Re-render (after a revoke) by calling again with the same `el`.
  mountShares(el, props) {
    renderConfined(h(SharesPanel, props), el);
  },
};

globalThis.__fieldIslands = islands;
export default islands;
