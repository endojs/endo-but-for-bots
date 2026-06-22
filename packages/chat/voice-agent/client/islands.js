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
import { NotificationCard } from './notification-card.js';
import { ChangelogList } from './changelog-list.js';
import { PowersBanner } from './powers-banner.js';
import { KitSampler } from './kit-sampler.js';
import { AskCard } from './ask-card.js';
import { ProposalCard } from './proposal-card.js';
import { ChatList } from './chat-list.js';
import { MessageControls } from './message-controls.js';
import { ChatMetaBar } from './chat-meta-bar.js';
import { DevTaskCard } from './dev-task-card.js';
import { ExhaustedCard } from './exhausted-card.js';
import { TraceSignature } from './trace-signature.js';

// A render propagator: re-paints `view(...values)` into `el` whenever any wired cell changes.
// This is the one kind of propagator whose effect is the DOM; logic propagators stay headless.
const renderPropagator = (el, cells, view) =>
  react(cells, (...values) => renderConfined(view(...values), el));

// ── Shares island ───────────────────────────────────────────────────────────────────────────────
// One cell (the data grain) holds the render-safe rows; the render propagator wires it to SharesPanel.
const sharesCell = makeCell();
let sharesWired = false;
const notifCell = makeCell();
let notifWired = false;
const changelogCell = makeCell();
let changelogWired = false;
const powersCell = makeCell();
let powersWired = false;
const kitCell = makeCell();
let kitWired = false;
const askCell = makeCell();
let askWired = false;
const propCell = makeCell();
let propWired = false;
const chatListCell = makeCell();
let chatListWired = false;
const msgCtrlCell = makeCell();
let msgCtrlWired = false;
const metaBarCell = makeCell();
let metaBarWired = false;
const devTaskCell = makeCell();
let devTaskWired = false;
const exhaustedCell = makeCell();
let exhaustedWired = false;
const traceSigCell = makeCell();
let traceSigWired = false;

const islands = {
  // Idempotent: wires the render propagator once (cell → SharesPanel), then feeds the latest data in.
  // `data` = { items:[{label,tag}], components:[{toolName,mode,price,used,atten,revoked}], earned } —
  // render-safe only (no swissnum, no share token). `handlers` index back into app.js's state, where
  // the secrets live: { onCopy(i), onQr(i), onRevoke(i), onCopyComp(i), onRevokeComp(i) }.
  renderShares(el, data, handlers) {
    if (!sharesWired) {
      // Tag the mount with this island's COMPONENT id so the Alt/Option-click overlay can select it +
      // edit its source (the island is a versioned component, like any other).
      el.setAttribute('data-component-id', 'island-shares-panel');
      el.setAttribute('data-component-name', 'Shares panel');
      renderPropagator(el, [sharesCell], d => h(SharesPanel, { ...d, ...handlers }));
      sharesWired = true;
    }
    sharesCell.addContent(data);
  },

  // ── Notifications island ──────────────────────────────────────────────────────────────────────
  // Renders a LIST of NotificationCard. `data` = { items:[{id,title,time,body,agent,avatar,status,
  // links:[{label}],attention}], withDone } — render-safe (links carry only a label, never a URL/cap).
  // `handlers` = { onDone(id), onOpenLink(itemIndex, linkIndex) } index back into app.js, where the
  // real href/cap lives.
  renderNotifications(el, data, handlers) {
    if (!notifWired) {
      el.setAttribute('data-component-id', 'island-notifications');
      el.setAttribute('data-component-name', 'Notifications');
      renderPropagator(el, [notifCell], d => h('div', null, (d.items || []).map((it, idx) =>
        h(NotificationCard, {
          ...it, withDone: d.withDone, key: it.id || idx,
          onDone: handlers.onDone,
          onOpenLink: li => handlers.onOpenLink && handlers.onOpenLink(idx, li),
        }))));
      notifWired = true;
    }
    notifCell.addContent(data);
  },

  // ── Changelog island ──────────────────────────────────────────────────────────────────────────
  // `data` = { merges:[{id,goal,when,sha,rolledBack,revertedWhen}] } (render-safe). `handlers` =
  // { onRevert(id) } runs the host-side revert.
  renderChangelogList(el, data, handlers) {
    if (!changelogWired) {
      el.setAttribute('data-component-id', 'island-changelog');
      el.setAttribute('data-component-name', 'Changelog');
      renderPropagator(el, [changelogCell], d => h(ChangelogList, { merges: d.merges || [], onRevert: handlers.onRevert }));
      changelogWired = true;
    }
    changelogCell.addContent(data);
  },

  // ── Powers banner island ──────────────────────────────────────────────────────────────────────
  // `data` = { items:[{power,icon,tip}], manageable, label } (render-safe). `handlers` =
  // { onRevoke(power), onAddPowers() }.
  renderPowersBanner(el, data, handlers) {
    if (!powersWired) {
      el.classList.add('powers-banner'); // the .chip styles are scoped under .powers-banner
      el.setAttribute('data-component-id', 'island-powers-banner');
      el.setAttribute('data-component-name', 'Powers banner');
      renderPropagator(el, [powersCell], d => h(PowersBanner, { ...d, ...handlers }));
      powersWired = true;
    }
    powersCell.addContent(data);
  },

  // ── UI-kit sampler island ─────────────────────────────────────────────────────────────────────
  // A living style guide: one of every kit primitive, rendered through the real bundle. No data/handlers.
  renderKitSampler(el) {
    if (!kitWired) {
      el.setAttribute('data-component-id', 'island-ui-kit');
      el.setAttribute('data-component-name', 'UI kit (primitives)');
      renderPropagator(el, [kitCell], () => h(KitSampler));
      kitWired = true;
    }
    kitCell.addContent({ render: true });
  },

  // ── AskCard island ────────────────────────────────────────────────────────────────────────────
  // `data` = { ask, answers:{qid:value}, status } (render-safe). `handlers` =
  // { onChange(qid,value), onSubmit(askId), onOpenOrigin() }. The host owns the answers + submits.
  renderAskCard(el, data, handlers) {
    if (!askWired) {
      el.setAttribute('data-component-id', 'island-ask-card');
      el.setAttribute('data-component-name', 'Ask card');
      renderPropagator(el, [askCell], d => h(AskCard, { ...d, ...handlers }));
      askWired = true;
    }
    askCell.addContent(data);
  },

  // ── ProposalCard island ───────────────────────────────────────────────────────────────────────
  // `data` = { proposal, icon, accent, mayConfirm, dontAsk } (render-safe). `handlers` =
  // { onConfirm(id, dontAskAgain), onReject(id), onToggleDontAsk(checked) }.
  renderProposalCard(el, data, handlers) {
    if (!propWired) {
      el.setAttribute('data-component-id', 'island-proposal-card');
      el.setAttribute('data-component-name', 'Proposal card');
      renderPropagator(el, [propCell], d => h(ProposalCard, { ...d, ...handlers }));
      propWired = true;
    }
    propCell.addContent(data);
  },

  // ── ChatList island ───────────────────────────────────────────────────────────────────────────
  // `data` = { items, more, editingId, draft, emptyText } (render-safe). `handlers` =
  // { onSelect(id), onDelete(id), onMore(), onRenameStart(id), onRenameChange(v), onRenameCommit(save) }.
  renderChatList(el, data, handlers) {
    if (!chatListWired) {
      el.setAttribute('data-component-id', 'island-chat-list');
      el.setAttribute('data-component-name', 'Chat list');
      renderPropagator(el, [chatListCell], d => h(ChatList, { ...d, ...handlers }));
      chatListWired = true;
    }
    chatListCell.addContent(data);
  },

  // ── MessageControls island ────────────────────────────────────────────────────────────────────
  // `data` = { hasAudio, varIx, varCount }. `handlers` = { onRetry, onEdit, onPlayAudio, onFork(delta) }.
  renderMessageControls(el, data, handlers) {
    if (!msgCtrlWired) {
      el.setAttribute('data-component-id', 'island-message-controls');
      el.setAttribute('data-component-name', 'Message controls');
      renderPropagator(el, [msgCtrlCell], d => h(MessageControls, { ...d, ...handlers }));
      msgCtrlWired = true;
    }
    msgCtrlCell.addContent(data);
  },

  // ── ChatMetaBar island ────────────────────────────────────────────────────────────────────────
  // `data` = { mode, title, ...memo-or-chat fields }. `handlers` = { onVersionPrev, onVersionNext,
  // onRerun, onOpenParent(id), onOpenProject(id) }.
  renderChatMetaBar(el, data, handlers) {
    if (!metaBarWired) {
      el.setAttribute('data-component-id', 'island-chat-meta-bar');
      el.setAttribute('data-component-name', 'Chat meta bar');
      renderPropagator(el, [metaBarCell], d => h(ChatMetaBar, { ...d, ...handlers }));
      metaBarWired = true;
    }
    metaBarCell.addContent(data);
  },

  // ── DevTaskCard island ────────────────────────────────────────────────────────────────────────
  // `data` = { task, accent, who, expanded, draft }. `handlers` = { onToggle, onReplyChange, onReplySend }.
  renderDevTaskCard(el, data, handlers) {
    if (!devTaskWired) {
      el.setAttribute('data-component-id', 'island-dev-task-card');
      el.setAttribute('data-component-name', 'Dev task card');
      renderPropagator(el, [devTaskCell], d => h(DevTaskCard, { ...d, ...handlers }));
      devTaskWired = true;
    }
    devTaskCell.addContent(data);
  },

  // ── ExhaustedCard island ──────────────────────────────────────────────────────────────────────
  // `data` = { isRoot, note }. `handlers` = { onTopUp(), onAbandon() }.
  renderExhaustedCard(el, data, handlers) {
    if (!exhaustedWired) {
      el.setAttribute('data-component-id', 'island-exhausted-card');
      el.setAttribute('data-component-name', 'Out-of-allowance card');
      renderPropagator(el, [exhaustedCell], d => h(ExhaustedCard, { ...d, ...handlers }));
      exhaustedWired = true;
    }
    exhaustedCell.addContent(data);
  },

  // ── TraceSignature island (the inline glyph strip; the 3D pendant is the separate island-trace) ──
  // `data` = { steps, expanded, legend }. `handlers` = { onToggle(), onOpen3D() }.
  renderTraceSignature(el, data, handlers) {
    if (!traceSigWired) {
      el.setAttribute('data-component-id', 'island-trace-signature');
      el.setAttribute('data-component-name', 'Trace signature');
      renderPropagator(el, [traceSigCell], d => h(TraceSignature, { ...d, ...handlers }));
      traceSigWired = true;
    }
    traceSigCell.addContent(data);
  },
};

globalThis.__fieldIslands = islands;
export default islands;
