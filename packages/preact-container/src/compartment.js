// @ts-check

import { h, Fragment, options } from 'preact';
import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useReducer,
} from 'preact/hooks';
import {
  _registerTrustedExitType,
  _registerSecureReentryType,
} from './renderer.js';

/** @import { VNode } from 'preact' */

/**
 * Preact `VNode` extended with this module's private slot-map bracket
 * marker. The `options[OPT_RENDER]` / `diffed` hooks stash it directly on
 * the vnode; it is not part of preact's public type. Optional — only
 * present once a confined render has bracketed the vnode.
 *
 * @typedef {VNode & { _slotMapBracketed?: boolean }} SlotMapVNode
 */

// See the note in `renderer.js`: preact mangles `options[OPT_RENDER]` to
// `__r` and `options[OPT_CATCH_ERROR]` to `__e` in its published build.
const OPT_RENDER = '__r';
const OPT_CATCH_ERROR = '__e';

/**
 * `@endo/preact-container/compartment` — mount untrusted component code inside a Preact
 * tree.
 *
 * Threat model: the host hands us a function the host already evaluated
 * in a SES Compartment (we never call `new Compartment` ourselves — we
 * stay SES-agnostic). That function can return any JavaScript value as
 * its render result. Our job is to defend the seam between the
 * attacker-supplied function and the live DOM.
 *
 * The wrapper this module returns is a normal Preact function component.
 * Mount it inside a `renderConfined` tree to get full sanitization on top.
 */

// Set of every confined-component wrapper we have minted. Used by the
// coercer to decide whether an attacker-returned `vnode.type` is allowed
// to be a function (it must be another confined component).
const confinedComponents = new WeakSet();

// Prop names the coercer drops on EVERY vnode (regardless of whether
// `renderConfined` is on top, and regardless of whether the vnode is a
// DOM element or a function component). Today this is just `ref` —
// `h()` extracts `ref` off props onto `vnode.ref`, and the secure
// layer's sanitizer strips it again, but when the attacker hand-builds
// a vnode (`{ type:'div', constructor: undefined, props:{ ref: fn }}`)
// without going through `h()`, the only defense is dropping `ref`
// here in the coercer.
//
// `key` is intentionally not in this list because the coercer reads
// it from the vnode directly and re-emits it via `rest.key`; the
// attacker putting `key` in `props` is harmless (vnode-level wins).
//
// The DOM-specific denylist that used to live alongside this set
// (`innerHTML`, `srcdoc`, the `HTMLHyperlinkElementUtils` URL
// setters, …) is gone. The renderer is now an allow-by-default
// attribute filter (`DEFAULT_SAFE_ATTRS` in `src/renderer.js`)
// and any prop name not on that list — including everything the old
// `DROPPED_PROPS_DOM` enumerated — is dropped at the renderer
// boundary. Mounting `confineComponent` WITHOUT `renderConfined` on
// top is documented as unsupported.
const DROPPED_PROPS_ALWAYS = new Set(['ref']);

// Per-render opaque-slot map. `currentSlotMap` points at the slot map of
// the confined component currently rendering (or whose subtree is
// currently diffing). It's bracketed by our `options[OPT_RENDER]` /
// `options.diffed` hooks; when the diff for a confined component finishes
// we `.clear()` the map AND drop the reference, so a slot the attacker
// stashed in their own state (across renders or compartments) becomes
// useless — the host vnode it once pointed to is no longer reachable.
//
// IMPORTANT: this replaces a previous module-global `WeakMap` that allowed
// an attacker who stashed (OpaqueChild type, slot) from tenant A to
// resurrect tenant A's host vnode inside tenant B's tree. See the
// `cross-mount slot reuse` test for the regression.
let currentSlotMap = null;
const slotMapStack = [];

function pushSlotMap() {
  slotMapStack.push(currentSlotMap);
  currentSlotMap = new Map();
}

function popSlotMap() {
  if (currentSlotMap) currentSlotMap.clear();
  currentSlotMap = slotMapStack.length > 0 ? slotMapStack.pop() : null;
}

/**
 * Frozen bundle of utilities handed to the attacker function as its
 * first argument. These are the ONLY tools we provide; the attacker can
 * use them but is not required to — they may build vnode-shaped objects
 * by hand. The coercer below treats both paths identically.
 */
// FREEZE THE VALUES, NOT JUST THE BUNDLE. `Object.freeze` is shallow, so freezing the object only
// stopped a confined component from ADDING a key — every value inside stayed a mutable, SHARED
// function object. `endowments.h.__x = secret` in one component was readable as `h.__x` from every
// other one (and, worse, wrote through to preact's real `h` in the host realm).
//
// Parent→child confinement never noticed: one child with nothing to leak to. MULTI-PARTY INLINE
// COMPOSITION does — two parties' regions in one render need no shared mutable channel, or one simply
// stashes its secret where the other reads it, no vnode traversal required. Found by the sibling
// opacity attack suite (test/sibling-opacity.test.js), which is exactly the assumption it was written
// to check.
//
// Freezing in place rather than wrapping: `Fragment` is compared by IDENTITY inside preact
// (`vnode.type === Fragment`), so handing out a wrapper would silently break Fragment rendering.
// Preact does not assign properties to these exports at runtime, so freezing them is safe here.
//
// USE `harden` WHEN WE HAVE IT (dan: "that's somewhat why we have the harden function from SES" —
// exactly right). A per-value `Object.freeze` is one level deep: it stops `h.__x = secret` but not
// `h.prototype.__x = secret`, nor anything further up the prototype chain, and those objects are
// shared by every party too. `harden` is the transitive version, and it is the SES primitive built
// for precisely this. The manual freeze stays as the fallback for the no-lockdown case, where it is
// defence-in-depth rather than a guarantee — see the note below.
// HARDEN LAZILY, NOT AT MODULE EVAL. `lockdown()` runs in the app entry (islands.js), but ES imports
// are hoisted: this module's body executes BEFORE that call, so `globalThis.harden` is reliably
// undefined right here and capturing it now silently pins the shallow fallback forever. Proven under
// a real locked-down browser — `h.prototype.__x` still crossed between two parties with lockdown on.
// So the transitive freeze is applied from `install()` instead, which first runs when a component is
// actually confined: after lockdown, every time.
let hardened = false;
const hardenEndowments = () => {
  if (hardened) return;
  const hard = globalThis.harden;
  if (typeof hard !== 'function') return; // no lockdown → nothing stronger is available; see note below
  hardened = true;
  // eslint-disable-next-line no-use-before-define
  hard(endowments); // transitive: reaches h.prototype and up the chain, which Object.freeze does not
};
for (const fn of [
  h,
  Fragment,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useReducer,
]) {
  Object.freeze(fn);
}
// WITHOUT `lockdown()` THIS CHANNEL CANNOT BE CLOSED FROM LIBRARY CODE, and it is not the worst
// thing open: the warning further down already says an un-tamed `endowments.h.constructor` reaches
// the host realm outright. Multi-party composition therefore REQUIRES lockdown to mean anything —
// pinned as a known limitation in test/sibling-opacity.test.js rather than papered over, so nobody
// ships a composition surface on the un-locked-down path believing the parties are isolated.
const endowments = Object.freeze({
  h,
  Fragment,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useReducer,
});

/**
 * Component placed inline by `Confined` to mark a slot where one of the
 * host's children should render. The sentinel's vnode carries no own
 * property pointing at the real child — the link is held in a per-render
 * `currentSlotMap` keyed by the slot object, unreachable by the
 * attacker.
 *
 * `OpaqueChild` itself is registered as a trusted-exit boundary with
 * `@endo/preact-container/renderer` (see `install()`), so the host vnode it returns
 * renders without sanitization. Crucially: we return the host vnode
 * DIRECTLY, not wrapped in `<HostPassthrough>`. Returning a vnode with
 * `type: HostPassthrough` would let the attacker read `.type` off our
 * output and obtain a reference to `HostPassthrough` they could re-use to
 * smuggle other content into trusted-exit mode.
 *
 * SECURITY: a token (`opaqueChildInvocationToken`) is set from
 * `options[OPT_RENDER]` immediately before Preact calls this component
 * and CONSUMED on first read here. If the attacker stashes the
 * `OpaqueChild` function and a slot (both reachable via
 * `props.children[i].{type, props._slot}`) and calls `OpaqueChild`
 * synchronously inside their render, the token is `null` (only set
 * for diff-driven calls) and we return `null`. Without this guard
 * the attacker could exfil the host vnode object as a JS value and
 * walk its tree / invoke host component functions to escalate to
 * host-authority code execution.
 */
let opaqueChildInvocationToken = null;
function OpaqueChild(props) {
  if (opaqueChildInvocationToken !== props) return null;
  opaqueChildInvocationToken = null;
  const real = currentSlotMap && currentSlotMap.get(props._slot);
  return real == null ? null : real;
}

// ── TRUSTED-IN-UNTRUSTED: a SEALED, PARAMETERIZED host component ─────────────────────────────────
//
// `OpaqueChild` above already lets the host hand a confined child a subtree it can PLACE but never
// reach into. What it cannot do is let the child ASK for something: the subtree is fixed before the
// child runs. The case that needs (vault: "trusted-in-untrusted Secure UI") is exactly the asking
// kind — "render the local name for THIS identifier", where the untrusted context supplies the
// identifier and must not learn, or be able to forge, the name that comes back:
//
//   · your friends' petnames beside an opaque did:, without the page learning or spoofing them;
//   · a timestamp in your timezone, without disclosing your timezone;
//   · a security-critical confirmation rendered inside a less-trusted interaction.
//
// So: `sealComponent(hostFn, { params })` mints an opaque PLACEHOLDER the child may use as a vnode
// type. The child writes `h(Name, { id })`; the host function runs with HOST authority and produces
// the real subtree. The child holds a token, never the function.
//
// THE FOUR PROPERTIES, and where each is enforced:
//
//  1. CANNOT INSPECT — the placeholder is not the host function, and the host's output is never
//     returned to child code. Preact renders it; the child sees a vnode type it cannot call for a
//     value. `ref` is dropped by DROPPED_PROPS_ALWAYS, so it cannot reach the DOM either.
//  2. CANNOT INVOKE FOR A VALUE — same token guard as OpaqueChild: the placeholder only yields the
//     host subtree when Preact itself is driving the diff. Called synchronously from child render
//     (the exfiltration move) it returns null.
//  3. CANNOT PARAMETERIZE BEYOND THE CONTRACT — only prop names the host DECLARED in `params` cross,
//     and each is coerced to a primitive. A function, object, Proxy or getter-bearing value is
//     dropped, so the child can neither smuggle a capability INTO trusted code nor hand it a prop
//     (`dangerouslySetInnerHTML`, `onClick`, …) the host never agreed to read.
//  4. CANNOT FORGE — placeholders are recognized by IDENTITY against a private WeakSet, never by a
//     flag on the object. The documented CVE class here is trusting `_isSomething`; an attacker can
//     set that on their own function. They cannot forge WeakSet membership.
//
// What this does NOT solve: a hostile child can still draw its OWN pixels that LOOK like a trusted
// badge (the "Impersonation" attack in dan's note). Distinguishing real from imitation is the job of
// an unspoofable presentation the child cannot reproduce — a per-user security pattern — which lives
// above this seam. This primitive guarantees the trusted content is unreachable and unforgeable; it
// does not by itself make a forgery recognizable.
const sealedComponents = new WeakSet();
const sealedSpecs = new WeakMap(); // placeholder → { fn, params:Set<string> } (never reachable from child code)
let sealedInvocationToken = null;

// Only primitives cross into a sealed component. Read ONCE (a Proxy/getter gets a single observation,
// and its result is what we keep), then type-checked — the same read-once-and-rebuild discipline the
// vnode coercer uses. Objects/arrays/functions/symbols are dropped rather than deep-copied: a sealed
// component's parameters are DESIGNATORS (an id, a timestamp, a count), and accepting structure here
// would be the seam through which structure carries authority.
const coerceParam = value => {
  const t = typeof value;
  if (value == null) return undefined;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint')
    return value;
  return undefined;
};

/**
 * Mint a sealed, parameterized component the confined child can place but not inspect.
 *
 * @param {(params: object) => any} hostFn Runs with HOST authority. Receives ONLY the declared,
 *   coerced params — never the child's raw props, and never child-supplied functions or objects.
 * @param {{ params?: string[] }} [opts] `params`: the prop names the child is allowed to supply.
 *   Anything else the child passes is dropped. Omitted/empty ⇒ the child may parameterize nothing,
 *   which degrades exactly to OpaqueChild's "fixed subtree" behaviour.
 * @returns {Function} An opaque placeholder to hand the child as a prop.
 */
export function sealComponent(hostFn, opts = {}) {
  if (typeof hostFn !== 'function') {
    throw new TypeError('sealComponent(hostFn): hostFn must be a function');
  }
  const declared = new Set(
    (Array.isArray(opts.params) ? opts.params : []).filter(
      p => typeof p === 'string',
    ),
  );
  // The placeholder's own body is what Preact calls during the diff. It is deliberately NOT the host
  // function: the child can reach this reference (off its own vnode's `.type`) and could call it, so
  // it must be worthless outside a real diff.
  const placeholder = props => {
    if (sealedInvocationToken !== props) return null; // property 2 — see the token discussion above
    sealedInvocationToken = null;
    const spec = sealedSpecs.get(placeholder);
    if (!spec) return null;
    const args = {};
    for (const name of spec.params) {
      const v = coerceParam(props ? props[name] : undefined); // property 3
      if (v !== undefined) args[name] = v;
    }
    let out;
    try {
      out = spec.fn(deepFreeze(args));
    } catch {
      return null; // a throwing trusted component must not take down the host render
    }
    return out == null ? null : out;
  };
  sealedComponents.add(placeholder);
  sealedSpecs.set(placeholder, { fn: hostFn, params: declared });
  // Register as a TRUSTED EXIT, exactly like OpaqueChild: what the host function returns is host
  // content and must render without the child-output sanitizer rewriting it. (`_registerTrustedExitType`
  // installs the hooks itself, so a sealed component may be minted before any render.)
  // Note this holds a strong reference — seal a component ONCE per kind of trusted UI (a `Name` badge,
  // a confirmation), not per render, or the exit set grows without bound.
  _registerTrustedExitType(placeholder);
  return deepFreeze(placeholder);
}

/** True iff `value` is a placeholder minted by `sealComponent` (identity, never a flag). */
export function isSealedComponent(value) {
  return typeof value === 'function' && sealedComponents.has(value);
}

// Hard cap on coercion recursion depth. A confined component controls
// the SHAPE of its return value and can hand back a pathologically deep
// structure (a self-similar nested array, or a vnode whose `children`
// chains thousands deep). Without this bound the recursive walk below
// would overflow the JS stack and throw synchronously during the host
// render; we fail closed (drop the subtree) well before that. Realistic
// UI nesting is far shallower than this.
const MAX_COERCE_DEPTH = 256;

/**
 * Walk an arbitrary value returned by the attacker and re-create it
 * using vnode primitives we control. Anything that doesn't match a
 * known shape is dropped (returned as `null`). This is the critical
 * defensive coercion step: even if the attacker returns a Proxy, a
 * vnode-shaped object with getters, or a custom-prototype "fake vnode",
 * we read it once and rebuild via our own `h()`, throwing away the
 * original.
 * @param value
 * @param depth Current recursion depth; external callers pass 0.
 */
function coerceToSafeVNode(value, depth = 0) {
  if (depth > MAX_COERCE_DEPTH) return null;
  if (value == null || typeof value === 'boolean') return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'bigint') return value;
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i++) {
      out.push(coerceToSafeVNode(value[i], depth + 1));
    }
    return out;
  }
  if (t !== 'object') return null;

  // Preact tags real vnodes with `constructor === undefined` (see
  // `src/create-element.js` — `UNDEFINED` is set as the constructor on
  // every vnode literal). Anything else is not a vnode.
  let ctor;
  try {
    ctor = value.constructor;
  } catch (_) {
    return null;
  }
  if (ctor !== undefined) return null;

  // Read each field defensively: the attacker may have installed
  // getters that throw or that return varying values per read.
  let type;
  let props;
  let key;
  try {
    type = value.type;
  } catch (_) {
    return null;
  }
  try {
    props = value.props;
  } catch (_) {
    return null;
  }
  try {
    // `key` lives on the vnode itself, not in `props`. Preserve it so
    // the attacker's keyed lists reconcile correctly (and so host
    // children we re-wrap with `key: i` keep stable identity across
    // re-renders even when the attacker reorders them).
    key = value.key;
  } catch (_) {
    key = undefined;
  }
  // `ref` is intentionally NOT read. Even though the secure renderer
  // strips refs in its sanitize pass, the coercer drops them here too
  // so behavior is correct if the compartment is ever mounted without
  // `renderConfined` on top (e.g. a unit test).

  const safeType = coerceType(type);
  const { children, rest } = coerceProps(props, depth);
  // Surface the key via props so `h()` picks it up — `h` extracts `key`
  // from props before forwarding to `createVNode`. Coerce the
  // attacker-controlled key to a primitive first: Preact only ever
  // COMPARES keys, so a stringified key still reconciles correctly,
  // while denying the attacker a `vnode.key` slot that carries object
  // (or function) identity.
  if (key != null) {
    const tk = typeof key;
    rest.key =
      tk === 'string' || tk === 'number' || tk === 'bigint' || tk === 'boolean'
        ? key
        : String(key);
  }
  return h(safeType, rest, ...children);
}

function coerceType(type) {
  if (type === Fragment) return Fragment;
  if (typeof type === 'string') {
    // String tags are passed through; the secure renderer applies the
    // allowlist and replaces disallowed tags with Fragment. We do the
    // same fallback here for the case where the compartment is used
    // outside `renderConfined` (e.g. a test).
    return type;
  }
  if (typeof type === 'function') {
    // Identity-based allowlist of attacker-usable component types.
    // We deliberately do NOT trust `_isOpaqueChild` / `_isSecureExit`
    // / `_isSecureBoundary` flags — an attacker can set those on
    // their own function and pass through this gate (the documented
    // CVE class from the original release). Identity is checked
    // against the actual `OpaqueChild` reference and the
    // `confinedComponents` WeakSet of wrappers we minted.
    //
    // HostPassthrough and SecureBoundary are deliberately NOT in this
    // allowlist — the attacker has no legitimate path to obtain
    // either reference (HostPassthrough is no longer exposed via
    // OpaqueChild's render output; SecureBoundary is module-private
    // to secure). Trusted-exit semantics arrive through `OpaqueChild`
    // itself, which is registered with secure as a trusted-exit type.
    // …and a SEALED component (sealComponent): the child is allowed to PLACE it, which is the whole
    // point — it just cannot read it, call it for a value, or parameterize it outside its contract.
    // Identity again (a private WeakSet), never a flag the attacker could set on their own function.
    if (
      confinedComponents.has(type) ||
      type === OpaqueChild ||
      sealedComponents.has(type)
    ) {
      return type;
    }
  }
  // Anything else (objects, class constructors, Proxies, etc.) becomes
  // a Fragment so children still render.
  return Fragment;
}

/**
 * @param props  The attacker-returned vnode's props object.
 * @param depth  Current recursion depth, forwarded to `children`.
 *
 * All DOM-specific filtering (`innerHTML`, `srcdoc`, case-variant
 * `on*`, the HTMLHyperlinkElementUtils URL setters, …) happens
 * downstream in `@endo/preact-container/renderer`'s allow-by-default attribute filter.
 * This coercer is responsible only for shape (Symbol keys, getters,
 * Proxy access patterns) and the `ref` field that the secure layer
 * cannot see when an attacker hand-builds a vnode that bypasses
 * `h()`.
 */
function coerceProps(props, depth) {
  // Null-prototype rest bag so Preact's `h()` — which copies into
  // its own props bag via `for (i in props)` — cannot pick up
  // `Object.prototype.dangerouslySetInnerHTML` (or any other
  // host-page pollution gadget) as an inherited key on the way
  // through. `Object.create(null)` neuters the prototype chain
  // completely. (The secure layer's own sanitizer also null-protos
  // its output, so this is belt-and-braces — but compartment's
  // `h()` call happens BEFORE secure's `options.vnode` hook fires,
  // and we don't want the polluted key to even materialize in the
  // intermediate normalizedProps bag.)
  const rest = Object.create(null);
  const children = [];
  if (props == null || typeof props !== 'object') {
    return { rest, children };
  }
  // Prefer `Object.keys`; fall back to `Reflect.ownKeys` (filtered to
  // strings) if a Proxy throws on `Object.keys`, so a hostile target can
  // still be handled (each read is wrapped in try/catch below). Symbol
  // keys are skipped either way: every meaningful Preact prop is
  // string-keyed, and a symbol-keyed getter could fire as a side effect
  // during diff.
  let keys;
  try {
    keys = Object.keys(props);
  } catch (_) {
    try {
      keys = Reflect.ownKeys(props).filter(k => typeof k === 'string');
    } catch (__) {
      return { rest, children };
    }
  }
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    // `key` is always a string here (Object.keys / the string-filtered
    // Reflect.ownKeys fallback). Match `ref` exactly — Preact only
    // treats the lowercase `ref` slot specially, so case variants are
    // ordinary data props that the renderer's allowlist drops anyway.
    if (DROPPED_PROPS_ALWAYS.has(key)) continue;
    // `children` is special: split out so we can recursively coerce
    // and forward as positional `h()` arguments.
    let value;
    try {
      value = props[key];
    } catch (_) {
      continue;
    }
    if (key === 'children') {
      const coerced = coerceToSafeVNode(value, depth + 1);
      if (Array.isArray(coerced)) {
        for (let j = 0; j < coerced.length; j++) children.push(coerced[j]);
      } else if (coerced != null) {
        children.push(coerced);
      }
      continue;
    }
    // `style` is read by Preact's commit phase via `for (name in value)`
    // and `value[name]` — if the attacker installs a getter that has
    // side effects, those getters fire while we're applying the DOM.
    // Defensive shallow copy reads each own data property once via a
    // descriptor and drops accessors, neutering the getter trick.
    if (key === 'style' && value !== null && typeof value === 'object') {
      rest[key] = shallowDataCopy(value);
      continue;
    }
    rest[key] = value;
  }
  return { rest, children };
}

/**
 * Shallow copy that reads own data properties only — accessors are
 * dropped, so getters never fire during the secure renderer's commit
 * phase. Used for prop values like `style` that Preact iterates and
 * reads in-place when applying to the DOM.
 *
 * Output bag has a NULL prototype — Preact's commit-phase
 * `for (name in value)` on style values walks the prototype chain, so
 * a host-page `Object.prototype.backgroundImage = 'url(attacker)'`
 * pollution gadget would otherwise leak into the style as an
 * inherited key. The secure layer also null-protos style at admission;
 * this is belt-and-braces for the compartment-coercer code path.
 * @param obj
 */
function shallowDataCopy(obj) {
  const out = Object.create(null);
  let keys;
  try {
    keys = Object.keys(obj);
  } catch (_) {
    return out;
  }
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(obj, k);
    } catch (_) {
      continue;
    }
    if (desc && 'value' in desc) {
      const v = desc.value;
      // Only carry primitives — nested objects could themselves hide
      // accessors. Functions are kept (some style libraries embed
      // units as templates, but for `style` we want strings/numbers).
      const t = typeof v;
      if (
        v === null ||
        t === 'string' ||
        t === 'number' ||
        t === 'boolean' ||
        t === 'bigint'
      ) {
        out[k] = v;
      }
    }
  }
  return out;
}

/**
 * Replace each host child in `children` with an opaque sentinel.
 * Returns the sentinel array (or `undefined` if the host passed no
 * children) plus a teardown function the wrapper component can run
 * once it unmounts.
 * @param children
 */
function wrapOpaqueChildren(children) {
  if (children == null) return undefined;
  const list = Array.isArray(children) ? children : [children];
  const sentinels = [];
  for (let i = 0; i < list.length; i++) {
    // Each slot is a unique object so multiple host children can be
    // looked up independently. The slot is registered into the
    // CURRENT confined component's slot map (set up by the
    // `options[OPT_RENDER]` hook below). When that render's diff
    // completes (`options.diffed`), the map is `.clear()`-ed and
    // dropped — slots the attacker stashed in their own state
    // become useless.
    const slot = Object.freeze({});
    if (currentSlotMap) currentSlotMap.set(slot, list[i]);
    sentinels.push(h(OpaqueChild, { _slot: slot, key: i }));
  }
  return sentinels;
}

// Best-effort detection of SES `lockdown()`. SES exposes `harden` on
// `globalThis` and freezes `Function.prototype.constructor` so the
// attacker cannot escape via `endowments.h.constructor('return
// globalThis')()`. Without lockdown, every function we hand to the
// attacker exposes the realm's `Function` via its `.constructor`
// chain and the sandbox is essentially decorative.
function sesAppearsActive() {
  return (
    typeof globalThis !== 'undefined' && typeof globalThis.harden === 'function'
  );
}

// Best-effort deep-freeze for the module's public exports (AGENTS.md
// § harden() is mandatory). Under lockdown `harden` transitively freezes
// them so a holder cannot tamper with the factory; without lockdown (the
// browser test harness) it falls back to a shallow `Object.freeze`.
const deepFreeze = value =>
  sesAppearsActive() ? globalThis.harden(value) : Object.freeze(value);

let warnedNoSes = false;
function warnIfNoSes() {
  if (warnedNoSes || sesAppearsActive()) return;
  warnedNoSes = true;
  // eslint-disable-next-line no-console
  if (typeof console !== 'undefined' && console.warn) {
    console.warn(
      '@endo/preact-container/compartment: SES `lockdown()` was not detected. The ' +
        "sandbox's endowments expose `Function` via their " +
        '`.constructor` chain, so an attacker in the compartment ' +
        'can reach the host realm via `endowments.h.constructor' +
        '("return globalThis")()`. Call `lockdown({ overrideTaming: ' +
        '"severe" })` BEFORE constructing any Compartment.',
    );
  }
}

let installed = false;
function install() {
  hardenEndowments(); // before `installed` short-circuits: lockdown may land after the first install
  if (installed) return;
  installed = true;

  warnIfNoSes();

  // Tell `@endo/preact-container/renderer` that `OpaqueChild` is a trusted-exit
  // boundary. The secure renderer will bracket `trustedExitDepth`
  // around its diff so the host child it returns renders without
  // sanitization — refs work, raw events fire, etc. — restoring the
  // behavior the previous code achieved by wrapping in `<HostPassthrough>`.
  _registerTrustedExitType(OpaqueChild);

  const previousRender = options[OPT_RENDER];
  const previousDiffed = options.diffed;
  const previousCatchError = options[OPT_CATCH_ERROR];

  options[OPT_RENDER] = vnode => {
    // Idempotent — `_render` may fire multiple times for the same
    // vnode when the component calls setState synchronously during
    // render (Preact's do-while loop in `src/diff/index.js`). The
    // flag guard means we only push once per vnode lifecycle; the
    // matching `diffed` (or `_catchError`) pops once.
    if (
      vnode.type &&
      confinedComponents.has(vnode.type) &&
      !vnode._slotMapBracketed
    ) {
      vnode._slotMapBracketed = true;
      pushSlotMap();
    }
    // Token-set for `OpaqueChild`: only diff-driven calls to the
    // component get to resolve their slot. Set to the SAME `props`
    // object Preact is about to pass — `OpaqueChild` confirms it
    // received that exact bag and consumes the token. Without this,
    // an attacker who stashed `OpaqueChild` + a slot could call
    // `OpaqueChild({_slot})` directly and exfil the host vnode as
    // a JS return value.
    if (vnode.type === OpaqueChild) {
      opaqueChildInvocationToken = vnode.props;
    }
    // Same arming for a SEALED component, and for the same reason: the child CAN reach the
    // placeholder (it is its own vnode's `.type`) and could call it directly to get the trusted
    // subtree back as a plain JS value — then walk it, read the petname out of it, or invoke host
    // functions found inside. Armed only here, on the diff Preact itself drives, and consumed on
    // first read, a direct call returns null.
    if (sealedComponents.has(vnode.type)) {
      sealedInvocationToken = vnode.props;
    }
    if (previousRender) previousRender(vnode);
  };

  options.diffed = (/** @type {SlotMapVNode} */ vnode) => {
    if (vnode._slotMapBracketed) {
      vnode._slotMapBracketed = false;
      popSlotMap();
    }
    if (previousDiffed) previousDiffed(vnode);
  };

  // On an unhandled render exception, `options.diffed` doesn't fire
  // — clean up the slot-map bracket here so the next render starts
  // from a balanced state.
  options[OPT_CATCH_ERROR] = (error, vnode, oldVNode, errorInfo) => {
    if (vnode && vnode._slotMapBracketed) {
      vnode._slotMapBracketed = false;
      popSlotMap();
    }
    if (previousCatchError) {
      return previousCatchError(error, vnode, oldVNode, errorInfo);
    }
    throw error;
  };
}

/**
 * Wrap an attacker-supplied component function so it can be mounted in
 * a normal Preact tree.
 *
 * @param {(endowments: object, props: object) => unknown} fn
 *   The untrusted function. Must accept `(endowments, props)`. May
 *   return any value; the wrapper coerces it.
 * @param {{ name?: string, onError?: (err: unknown) => void }} [opts]
 *   `name` is a display name for devtools. `onError`, if provided, is
 *   called whenever the attacker function throws — useful for
 *   telemetry. It is invoked with the thrown value; any exception it
 *   throws is swallowed so a misbehaving telemetry hook cannot itself
 *   crash the host render.
 * @returns {import('preact').FunctionComponent}
 */
export function confineComponent(fn, opts) {
  if (typeof fn !== 'function') {
    throw new TypeError('confineComponent: expected a function');
  }
  install();
  const displayName =
    (opts && typeof opts.name === 'string' && opts.name) || 'Confined';
  const onError =
    opts && typeof opts.onError === 'function' ? opts.onError : null;

  function Confined(rawProps) {
    // Fail-fast for the "mounted outside renderConfined" case lives
    // in `@endo/preact-container/renderer`'s `_render` hook: the reentry branch
    // walks `vnode._parent` for a `SecureBoundary` ancestor and
    // throws if absent. That fires BEFORE this body runs, so any
    // host that reaches us is guaranteed to be inside a real
    // secure subtree (this body cannot self-certify; the ancestor
    // walk is unforgeable because `SecureBoundary` is module-
    // private to `@endo/preact-container/renderer`).
    const { children: rawChildren, ...rest } = rawProps;
    const opaqueChildren = wrapOpaqueChildren(rawChildren);
    const sanitizedProps = Object.freeze({
      ...rest,
      children: opaqueChildren,
    });

    let result;
    try {
      result = Reflect.apply(fn, undefined, [endowments, sanitizedProps]);
    } catch (err) {
      if (onError) {
        try {
          onError(err);
        } catch (_) {
          // telemetry hook must not break the host render
        }
      }
      return null;
    }
    return coerceToSafeVNode(result);
  }
  Confined.displayName = displayName;
  // Tell `@endo/preact-container/renderer`'s entry-tree walk not to descend into our
  // children: those vnodes are host-trusted content that we route
  // through opaque sentinels and `HostPassthrough` islands at render time.
  Confined._haltSanitizeChildren = true;
  confinedComponents.add(Confined);
  // Register as a secure-reentry boundary so that an attacker confined
  // inside a `<HostPassthrough>` island still has its output sanitized.
  // Without this, `<HostPassthrough><Confined/></HostPassthrough>` would let the
  // attacker render `<script>` and arbitrary JS.
  _registerSecureReentryType(Confined);
  return Confined;
}
deepFreeze(confineComponent);

/**
 * Returns true if `value` is a wrapper returned by `confineComponent`.
 * @param value
 */
export function isConfinedComponent(value) {
  return typeof value === 'function' && confinedComponents.has(value);
}
deepFreeze(isConfinedComponent);

export { HostPassthrough } from './renderer.js';
