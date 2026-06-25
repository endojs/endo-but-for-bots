// confined-source.js — the keystone for rendering an UNTRUSTED component from SOURCE in-page (no iframe).
//
// This is what unblocks fork → edit → re-share on the confined-Preact substrate (designs/
// preact-component-trie.md): a fork's source is a function expression `(endowments, props) => vnode`
// (endowments = { h, Fragment, useState, … } supplied by confineComponent at render time). We evaluate it
// in a SES Compartment — so no host global reaches it — and wrap it with confineComponent, which sanitizes
// the RENDER (refs stripped, frozen SafeEvent, no DOM/File/network). The result mounts via renderConfined
// like any island, but its source came from an untrusted fork rather than our bundle.
//
// HARD PRECONDITION: `lockdown({ overrideTaming: 'severe' })` must have run in this realm first. Without it
// the endowed Function constructor can climb back to the host realm (see @endo/preact-container README
// §"SES / lockdown is a hard precondition"); 'severe' taming is also required for Preact to run at all.
// (No module-level harden so this stays importable in a not-yet-locked-down realm — callers gate on lockdown.)
import { confineComponent } from '@endo/preact-container/compartment';

// lockdownActive: best-effort check that the realm is locked down (intrinsics frozen). Callers should refuse
// to render untrusted source when this is false — rendering it un-locked-down is a containment hole.
export const lockdownActive = () => { try { return Object.isFrozen(Object.prototype) && Object.isFrozen(Function.prototype); } catch { return false; } };

// makeConfinedFromSource(source) → a confined Preact component built from untrusted source.
// `source` is a function-expression string: `(endowments, props) => vnode`. `endowments` (optional) seeds
// the Compartment's globals (default none → the source sees only what confineComponent hands it at render).
export const makeConfinedFromSource = (source, { name = 'forked-component', endowments = {} } = {}) => {
  // eslint-disable-next-line no-undef -- Compartment is a SES global (installed by `import 'ses'`)
  const compartment = new Compartment(endowments);
  const fn = compartment.evaluate(`(${String(source)})`);
  if (typeof fn !== 'function') {
    throw new TypeError('confined component source must evaluate to a function: (endowments, props) => vnode');
  }
  return confineComponent(fn, { name });
};
