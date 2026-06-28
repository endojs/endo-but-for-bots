// Entry for the confined-Preact ISLANDS bundle (built by vite.islands.config.js → public/islands/islands.js).
//
// DEFAULT ARCHITECTURE = PROPAGATION NETWORKS (see client/propagator.js + designs/preact-component-trie.md).
// An island is a STATELESS render PROPAGATOR wired to one or more CELLS (data grains) that hold the
// state. The host app (app.js) does not re-render imperatively; it pushes new facts into a cell with
// `addContent`, and the render propagator re-paints through the SANITIZING renderer (renderConfined:
// refs stripped, dangerous tags/attrs removed, frozen SafeEvent — no live DOM). Cap-hygiene holds by
// construction: a cell is only ever given render-safe data (labels/tags), never a swissnum.
// NOTE: ses is NOT bundled here. Bundlers (vite/rollup) break `tameFunctionConstructors`, so a bundled
// lockdown freezes intrinsics but leaves the global `Function`/`eval` LIVE — an untrusted endowment's
// `h.constructor('return globalThis')()` then climbs to the host realm (proven in the staging probe).
// Instead the page loads the standalone, compartment-mapper-built shim (public/ses.umd.min.js) as a
// classic script FIRST; it installs `assert`/`harden`/`Compartment`/`lockdown` globals with taming intact.
import { h, Fragment } from 'preact';
import { renderConfined } from '@endo/preact-container/renderer';
import { confineComponent } from '@endo/preact-container/compartment';
import { makeConfinedFromSource, lockdownActive } from './confined-source.js';
import * as uiKit from './ui-kit.js';

// Phase: severe-taming lockdown (designs/preact-component-trie.md). FLAG-GATED so the live app is
// untouched until the staging probe proves app.js + the islands survive a frozen realm. When the flag is
// set (the staging test sets it via addInitScript BEFORE any page module runs; live never sets it),
// freeze the realm here — islands.js executes before app.js, so this is the "pre-lockdown" the plan wants.
// 'severe' is required for Preact's override mistake AND to contain an untrusted fork's Function escape;
// 'unsafe' error taming keeps usable stacks/console in the operator app.
const wantLockdown = globalThis.__FIELD_LOCKDOWN__
  || (typeof document !== 'undefined' && document.documentElement
      && document.documentElement.getAttribute('data-field-lockdown') === '1');
if (wantLockdown && typeof globalThis.lockdown === 'function' && !lockdownActive()) {
  // Requires the page's CSP to allow script-src 'unsafe-eval' (the server pairs the marker with that CSP);
  // without it SES freezes but cannot tame the Function constructor and the confinement is decorative.
  globalThis.lockdown({ overrideTaming: 'severe', errorTaming: 'unsafe', consoleTaming: 'unsafe' });
}

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
import { ObjectBrowser } from './object-browser.js';
import { ShareLinkManager } from './share-link-manager.js';
import { FileBrowser } from './file-browser.js';
import { TaglineHero } from './tagline-hero.js';
import { HeaderBar } from './header-bar.js';
import { InputRow } from './input-row.js';

// P3 (live-editable plan): ONE tagging path. tagComponent(el, id, name) marks a DOM element as a live,
// alt-clickable component AND registers it (id → {name}) so the alt-click overlay can resolve + name it and
// the edit chat can address it. The global registry is the authoritative list of every live component on the
// page (the substrate for "talk to the agent that owns it" + the P4 shell→island migration).
const componentRegistry = (globalThis.__componentRegistry = globalThis.__componentRegistry || new Map());
const tagComponent = (el, id, name) => { if (!el || !el.setAttribute) return el; try { el.setAttribute('data-component-id', String(id)); el.setAttribute('data-component-name', String(name)); componentRegistry.set(String(id), { name: String(name), at: Date.now() }); } catch { /* best effort */ } return el; };

// A render propagator: re-paints `view(...values)` into `el` whenever any wired cell changes.
// This is the one kind of propagator whose effect is the DOM; logic propagators stay headless.
const renderPropagator = (el, cells, view) =>
  react(cells, (...values) => renderConfined(view(...values), el));

// Every island component, by name — for renderInto (one-shot per-mount rendering of a card whose state
// the HOST owns + re-renders, e.g. the ask/proposal cards appended individually into the chat log).
const COMPONENTS = {
  SharesPanel, NotificationCard, ChangelogList, PowersBanner, KitSampler, AskCard, ProposalCard,
  ChatList, MessageControls, ChatMetaBar, DevTaskCard, ExhaustedCard, TraceSignature, ObjectBrowser, ShareLinkManager, FileBrowser, TaglineHero,
};

// The authoring vocabulary handed to an untrusted FORK as compartment globals (see renderSource): preact's
// h/Fragment + every ui-kit primitive. All are pure (props)→vnode render functions — no caps, DOM, fs, or
// network — so this is the fork's entire authority. It matches what islands themselves import, so a fork
// reads like an island body.
//
// CONFINE THE KIT COMPONENTS. A fork's returned tree passes through the compartment's coerceToSafeVNode,
// whose coerceType ONLY admits a function-typed vnode if it's a registered confined component — every other
// function type is dropped to a Fragment. So a RAW kit component used as `h(Btn,…)` rendered NOTHING (the
// dead-Send-button bug). Wrapping each PascalCase kit component with confineComponent registers it, so a
// fork can write `h(Btn,{label,onClick})` / `h(TextField,{value,onInput})` and have it actually render +
// wire events: the wrapper invokes the kit fn, whose raw-tag output is itself coerced (sanitized) + mounted,
// and host children are routed through the opaque-child machinery. Non-component helpers (camelCase, e.g.
// joinDot) ride along UNWRAPPED — a fork calls them directly, never as a vnode type.
const confinedKit = {};
for (const [name, val] of Object.entries(uiKit)) {
  confinedKit[name] =
    typeof val === 'function' && /^[A-Z]/.test(name)
      ? confineComponent((_endowments, props) => val(props), { name })
      : val;
}
const FORK_VOCAB = Object.freeze({ h, Fragment, ...confinedKit });

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
const objBrowserCell = makeCell();
let objBrowserWired = false;
const shareMgrCell = makeCell();
let shareMgrWired = false;

const islands = {
  // Idempotent: wires the render propagator once (cell → SharesPanel), then feeds the latest data in.
  // `data` = { items:[{label,tag}], components:[{toolName,mode,price,used,atten,revoked}], earned } —
  // render-safe only (no swissnum, no share token). `handlers` index back into app.js's state, where
  // the secrets live: { onCopy(i), onQr(i), onRevoke(i), onCopyComp(i), onRevokeComp(i) }.
  renderShares(el, data, handlers) {
    if (!sharesWired) {
      // Tag the mount with this island's COMPONENT id so the Alt/Option-click overlay can select it +
      // edit its source (the island is a versioned component, like any other).
      tagComponent(el, 'island-shares-panel', 'Shares panel');
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
      tagComponent(el, 'island-notifications', 'Notifications');
      renderPropagator(el, [notifCell], d => h('div', null, (d.items || []).map((it, idx) =>
        h(NotificationCard, {
          ...it, withDone: d.withDone, key: it.id || idx,
          onDone: handlers.onDone,
          onOpenLink: li => handlers.onOpenLink && handlers.onOpenLink(idx, li),
          onOpen: id => handlers.onOpen && handlers.onOpen(id),
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
      tagComponent(el, 'island-changelog', 'Changelog');
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
      tagComponent(el, 'island-powers-banner', 'Powers banner');
      renderPropagator(el, [powersCell], d => h(PowersBanner, { ...d, ...handlers }));
      powersWired = true;
    }
    powersCell.addContent(data);
  },

  // ── UI-kit sampler island ─────────────────────────────────────────────────────────────────────
  // A living style guide: one of every kit primitive, rendered through the real bundle. No data/handlers.
  renderKitSampler(el) {
    if (!kitWired) {
      tagComponent(el, 'island-ui-kit', 'UI kit (primitives)');
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
      tagComponent(el, 'island-ask-card', 'Ask card');
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
      tagComponent(el, 'island-proposal-card', 'Proposal card');
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
      tagComponent(el, 'island-chat-list', 'Chat list');
      renderPropagator(el, [chatListCell], d => h(ChatList, { ...d, ...handlers }));
      chatListWired = true;
    }
    chatListCell.addContent(data);
  },

  // ── MessageControls island ────────────────────────────────────────────────────────────────────
  // `data` = { hasAudio, varIx, varCount }. `handlers` = { onRetry, onEdit, onPlayAudio, onFork(delta) }.
  renderMessageControls(el, data, handlers) {
    if (!msgCtrlWired) {
      tagComponent(el, 'island-message-controls', 'Message controls');
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
      tagComponent(el, 'island-chat-meta-bar', 'Chat meta bar');
      renderPropagator(el, [metaBarCell], d => h(ChatMetaBar, { ...d, ...handlers }));
      metaBarWired = true;
    }
    metaBarCell.addContent(data);
  },

  // ── DevTaskCard island ────────────────────────────────────────────────────────────────────────
  // `data` = { task, accent, who, expanded, draft }. `handlers` = { onToggle, onReplyChange, onReplySend }.
  renderDevTaskCard(el, data, handlers) {
    if (!devTaskWired) {
      tagComponent(el, 'island-dev-task-card', 'Dev task card');
      renderPropagator(el, [devTaskCell], d => h(DevTaskCard, { ...d, ...handlers }));
      devTaskWired = true;
    }
    devTaskCell.addContent(data);
  },

  // ── ExhaustedCard island ──────────────────────────────────────────────────────────────────────
  // `data` = { isRoot, note }. `handlers` = { onTopUp(), onAbandon() }.
  renderExhaustedCard(el, data, handlers) {
    if (!exhaustedWired) {
      tagComponent(el, 'island-exhausted-card', 'Out-of-allowance card');
      renderPropagator(el, [exhaustedCell], d => h(ExhaustedCard, { ...d, ...handlers }));
      exhaustedWired = true;
    }
    exhaustedCell.addContent(data);
  },

  // ── TraceSignature island (the inline glyph strip; the 3D pendant is the separate island-trace) ──
  // `data` = { steps, expanded, legend }. `handlers` = { onToggle(), onOpen3D() }.
  renderTraceSignature(el, data, handlers) {
    if (!traceSigWired) {
      tagComponent(el, 'island-trace-signature', 'Trace signature');
      renderPropagator(el, [traceSigCell], d => h(TraceSignature, { ...d, ...handlers }));
      traceSigWired = true;
    }
    traceSigCell.addContent(data);
  },

  // ── ObjectBrowser island (the capability navigator) ─────────────────────────────────────────────
  // `data` = { crumbs, items, roOnly, emptyText }. `handlers` = { onCrumb, onDrill, onShareRO, onShareFull }.
  renderObjectBrowser(el, data, handlers) {
    if (!objBrowserWired) {
      tagComponent(el, 'island-object-browser', 'Object browser');
      renderPropagator(el, [objBrowserCell], d => h(ObjectBrowser, { ...d, ...handlers }));
      objBrowserWired = true;
    }
    objBrowserCell.addContent(data);
  },

  // ── ShareLinkManager island ─────────────────────────────────────────────────────────────────────
  // `data` = { title, links, newName, newMode, newAllow }. `handlers` = { onCopy, onQr, onAdjustToggle,
  // onAdjustField, onSave, onRevoke, onNewField, onCreate }.
  renderShareLinkManager(el, data, handlers) {
    if (!shareMgrWired) {
      tagComponent(el, 'island-share-link-manager', 'Share link manager');
      renderPropagator(el, [shareMgrCell], d => h(ShareLinkManager, { ...d, ...handlers }));
      shareMgrWired = true;
    }
    shareMgrCell.addContent(data);
  },

  // ── One-shot render of any island component into `el` (renderConfined diffs → input focus survives a
  // re-render). For per-card surfaces where the HOST owns the state + calls this again on each change —
  // e.g. the ask/proposal cards appended individually into the chat log (live wiring). Returns false if
  // the name is unknown.
  // The landing tagline (P4 leaf): a confined, alt-clickable, EDITABLE island where a static <div> used to be.
  renderTaglineHero(el, text) {
    if (!el) return false;
    tagComponent(el, 'island-tagline-hero', 'Landing tagline');
    renderConfined(h(TaglineHero, { text }), el);
    return true;
  },

  // The header bar (P4 shell leaf): renders the structure into the existing <header>; app.js wires by id.
  renderHeaderBar(el) {
    if (!el) return false;
    tagComponent(el, 'island-header-bar', 'Header bar');
    renderConfined(h(HeaderBar, {}), el);
    return true;
  },

  // The composer input row (P4 shell leaf). app.js RE-WIRES send/mic/textarea by id AFTER this mounts.
  renderInputRow(el) {
    if (!el) return false;
    tagComponent(el, 'island-input-row', 'Composer input row');
    renderConfined(h(InputRow, {}), el);
    return true;
  },

  renderInto(name, el, props) {
    const C = COMPONENTS[name];
    if (!C || !el) return false;
    tagComponent(el, `island-${name}`, name);
    renderConfined(h(C, props || {}), el);
    return true;
  },

  // ── Render an UNTRUSTED component from SOURCE, confined + inline (no iframe). This is the fork→edit→
  // re-share render path: `source` is a `(endowments, props) => vnode` function string. We REFUSE unless
  // the realm is locked down (severe taming) — rendering untrusted source un-frozen is a containment hole
  // (the endowed Function constructor could climb to the host realm). Returns false on refusal/bad source.
  // The fork is seeded with FORK_VOCAB as compartment globals — the render-safe island vocabulary (h,
  // Fragment + every ui-kit primitive). That IS the fork's whole authority: pure render functions that emit
  // vnodes, no caps/DOM/fs/network. Under lockdown their `.constructor` is tamed, so they grant no escape.
  renderSource(source, el, props) {
    if (!el) return false;
    if (!lockdownActive()) { el.textContent = '⚠︎ refusing untrusted source: realm not locked down'; return false; }
    let C;
    try { C = makeConfinedFromSource(source, { name: 'forked-component', endowments: FORK_VOCAB }); }
    catch (e) { el.textContent = `⚠︎ bad component source: ${e && e.message}`; return false; }
    tagComponent(el, 'confined-source', 'forked-component');
    renderConfined(h(C, props || {}), el);
    return true;
  },
};

globalThis.__fieldIslands = islands;
export default islands;
