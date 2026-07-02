# Extensible UI: a trie of confined Preact component-projects

Source: dan's voice note 2026-06-19 (`vault/inbox/processed/Extensible UI via Preact Confinement and Git Objects.md`).
Status: **ALL 5 PHASES COMPLETE (2026-06-25) — and LIVE: `FIELD_LOCKDOWN=1` is ON in prod**
(drop-in `~/.config/systemd/user/voice-agent.service.d/lockdown.conf`, gated by the heavy-panel
smoke; reversible by removing that file + daemon-reload + restart).
P1 keystone (confineComponent inline, no iframe) + P2 grain/git-object + P3 alt-click on live forks +
P4 sharing/upgrades (pin/try-on/accept/auto + inbox) + P5 distribution-trust (social-collateral gate).
Proven by staging suites: `test:lockdown` 13/13, `test:forks` 14/14, `test:fork-widget` 10/10,
`test:alt-fork` 5/5, `test:fork-upgrade` 10/10, `test:fork-distribution` 13/13 + unit forks 10/10,
dist-trust 7/7 — and re-verified against the LIVE :8778 service under lockdown (boot, confined fork
render, alt-click chip; 2026-07-01). Next big project: `islands-as-objects-inventory.md`.

## The one-sentence vision

Refactor the field-agent UI from a monolithic DOM app (+ iframed applets) into a
**tree of nested, confined Preact components, where every component is its own
project backed by a git-as-Endo-object** — so any user can select any element,
talk to a micro-agent scoped to just that component, fork it, mutate their own
live interface, and share those mutations along capability-graph trust lines
without iframes.

## Why this is buildable now — the building blocks already exist

| Need (from the voice note) | Building block | Where |
| --- | --- | --- |
| "a project is a git repository exposing the folder/filesystem interface + branches + PRs" | `@endo/exo-git` `makeGit({mount,backend,lineageOf,readOnly})`; `git-filesystem.js`; `git-remote.js` (fetch/pull/push w/ credential caps) | `packages/exo-git` (in tree) |
| Node-side git backend (subprocess over real `git`) | `@endo/endo-git` `makeNativeGitBackend({repoRoot,makeReaderRef})` | `packages/endo-git` (in tree) |
| the folder/filesystem seam a project already speaks | `@endo/endo-fs` `Filesystem`/`FsBackend` (`makeGitFsBackend` adapts a git tree onto it) | `packages/endo-fs` |
| render a component CONFINED under SES (no exfiltration) | `@endo/preact-container`: `confineComponent`, `renderConfined`, `unmount`, `h`, hooks; `renderConfined` strips refs/dangerous tags/attrs, frozen `SafeEvent`, `SafeDataTransfer` (string-only, no File/FS/DOM) | **PR #471 branch** `claude/chat-preact-setup-r95thr` → `llm` (NOT yet in our working tree) |
| micro-agent scoped to one component, forks + adversarial dev flow | our existing `projects` + `delegateTask`/`employ` (CodeMode, traced) + `dev` ring (`host`/`home`) | `voice-agent/` |
| "valid for distribution" = a social-collateral trust act | our social-collateral capability-governance model | memory `social_collateral_capability_governance`, `[[Social Collateral]]` |

The two things we do NOT yet have locally: `@endo/preact-container` (lives on
PR #471, unmerged) and the wiring that makes **a component a project a git
object**. Everything else is in the repo.

## The model: component = project = git object

Today a **project** is a folder (`projects.mjs`, shared home folder). The voice
note upgrades that: a project becomes a **git repository** that *exposes the same
folder/filesystem object interface* (so existing folder-traversal code keeps
working) but additionally supports `checkout`, branch, fork, and pull-request.
`@endo/exo-git` is exactly this — `makeGit` over a backend, with
`git-filesystem.js` presenting the tree as a `Filesystem`.

The app is then a **trie of these project-objects**: the root app-project nests
child component-projects, each nesting theirs. Each node renders a confined
Preact component (`renderConfined`) mounted into its parent's slot — **no
iframes**; confinement is the SES compartment + the sanitizing renderer, not an
iframe boundary. Because each node is a git object, a node can be **forked and
swapped at runtime** (check out a different tree-oid → re-render) per user.

## Two distinct kinds of component: data GRAINS vs functional PROPAGATORS

(dan, 2026-06-19, refining the above — and correcting an earlier conflation of
the UI component with the grain.) Do **not** make the UI component a capability
grain. Split the system into two kinds of thing, after Radul & Sussman's
*Propagation Networks* (MIT-CSAIL-TR-2009-053) and Caputi:

- **Data grains = propagator CELLS.** A grain is a reference-gated capability
  (Caputi: `read/write/subscribe/lock`) that, in propagator terms, *accumulates
  information about a value* rather than storing a value: writes **merge**
  monotonically (never blind-overwrite), the cell **never forgets**, and it
  **notifies its neighbors** on new content (that is `subscribe`). State lives
  ONLY in grains. `lock` is the exclusive-erights / Train-&-Hotel atomicity for
  multi-party edits; Caputi's *paid lock durations / uniform-price auction* is
  the same shape as our GpuLease/agora tolling.
- **Functional components = PROPAGATORS.** Asynchronous, autonomous, **stateless,
  memoryless** machines wired to the grains they neighbor; they hold no state of
  their own — they read input grains, run logic, and write output grains, re-firing
  when a neighbor changes, until the network is **quiescent**. A UI component is
  just one kind of propagator (a *render* propagator: grains → DOM via
  `renderConfined`); most logic propagators are headless. Confinement is then
  precise and structural: **a propagator's authority IS the set of grains it is
  wired to** — nothing else is in lexical scope.

Why this split is the right substrate (the paper's central claim): *"accumulating
partial information is a module boundary."* It separates the core of propagation
from the things propagated, so independent pieces compose **additively** — you add
a propagator (or a grain) to the network **without modifying** the existing ones,
and it just interoperates. That is exactly the component-trie's sharing model: a
user/agent **forks or adds a functional component that re-wires existing data
grains without touching them** — additive, confined, reviewable. Networks are also
**multidirectional** (the same wiring runs a constraint both ways — the thesis's
Fahrenheit⇄Celsius converter), and cells carry **provenance via truth-maintenance
(TMS)** — which lets us non-destructively "try on" a friend's change as a *worldview*,
accept/reject it atomically, and know *who supplied what* (the accountability the
social-collateral distribution gate needs).

Implications that change the phases below:
- **Git-object versioning attaches to PROPAGATOR SOURCE** (the functional/UI
  component code), not to live state. **State lives in grains** (cells). So
  "swap a component at runtime" is clean: propagators are stateless → hot-swappable;
  the grains they were wired to persist across the swap.
- **Reactivity is not bolted on** — it falls out: a grain merges new info →
  notifies neighbor propagators → they re-run → the render propagator re-paints.
- The Phase-1 islands API (`renderConfined` + props) is already a *stateless render
  propagator* substrate — keep it stateless. What's still missing is the **grain
  layer** (mergeable, subscribable, provenance-carrying cells) the propagators wire.

## Interaction model (later phases, but design now)

1. **Alt/Option-select.** Hold Alt/Option → hover draws an outline around the
   *lowest-level component* under the cursor (desktop); click/tap selects it.
2. **Per-component agent.** On select, a button appears → opens a chat with the
   **micro-agent for that element's project**. Its scope is just that component
   → least-privilege, focused edits. (This IS our delegate-as-agent pattern,
   confined to the component-project's git object + a dev ring.)
3. **Mutate.** Submit a prompt → the agent **forks** the component-project,
   edits, **writes tests, runs the adversarial dev flow**, presents the diff.
   A per-element flag makes **revert to a previous version** one tap (git
   lineage). The user freely mutates their own live interface (their fork).
4. **Hosting power.** Keeping your fork live / sharing it requires a capability
   "host your own projects" brought into the interface. Without it you view the
   inviter's current state; with it you keep a personal live fork.

## Sharing & trust (the governance core — design now, build last)

- **Invite = current mutated state.** Inviting someone to a page invites them to
  *its current forked state*. The invite carries an **inbox** (the inviter keeps
  a reference) → the inviter can message the invitee ("I changed X — update?").
- **Atomic upgrades.** Invitee can accept-one / accept-all / reject-all /
  auto-accept-future. Non-destructive "try it on for size" review.
- **Upstream proposals.** An invitee who edits can option-select an element and
  **share it back upstream** (to their inviter) or downstream (to their own
  invitees). At invite time the inviter can flag "I trust this person's judgment"
  / "notify me of their changes" → their edits surface in the notifications feed.
- **The distribution gate = a social-collateral trust act.** Because a component
  is a confined Preact container, *a code-literate admin can verify it cannot
  exfiltrate data* (no network/File/FS/DOM reach; the one residual risk is a
  **destructive write cap passed in**, which stays an explicit endowment-moment
  decision — see memory `endowment_moment_approval`). There is a capability that
  marks a component **"valid for distribution to end users."** Holding/【granting】
  it is a social-collateral act:
  - **Developers** accept external contributions only after **review** — unless
    they granted an explicit "submit-without-review" power (a root power from the
    server administrator).
  - **End users** (default: code-illiterate) must **never** receive a change not
    reviewed by an administrator (or someone granted admin-capacity review).
  - Not "a small council of app-store clerics" — the **maximal flow of trust
    from the core team outward** along the capability graph. (Sits below agora,
    grounded in dan's vault — consistent with `social_collateral_capability_governance`.)

## Phasing

- **Phase 1 — the port (DONE) + the untrusted-fork render keystone (DONE, flag-gated).**
  `@endo/preact-container` is in the build; islands render OWN (trusted) components via
  `renderConfined`; real slices ported. ✅ **`confineComponent` (untrusted SOURCE → confined,
  inline, NO iframe) is now wired + proven**: `client/confined-source.js`
  (`makeConfinedFromSource`) + `__fieldIslands.renderSource`, which REFUSES unless the realm is
  locked down. Severe-taming lockdown is **flag-gated** behind the server's `FIELD_LOCKDOWN` env —
  **now ON in production** (the `lockdown.conf` drop-in; with it off, zero change to the live realm
  and the strict CSP stays). When ON, the server
  serves the shell with `<html data-field-lockdown="1">` (islands.js reads it → `lockdown({
  overrideTaming:'severe' })` before app.js) AND widens the shell CSP to `script-src 'unsafe-eval'`.
  - **CSP gotcha (load-bearing, do not regress):** SES's `tameFunctionConstructors` REQUIRES
    `'unsafe-eval'` in the page CSP. Under the strict `default-src 'self'` CSP, `lockdown()` freezes
    intrinsics but the Function-constructor taming **silently no-ops**, leaving
    `endowments.h.constructor('return globalThis')()` a live host escape — confinement is decorative.
    `'unsafe-eval'` is safe here precisely because SES then tames eval/Function; the server couples the
    CSP relaxation to the lockdown marker so they can never drift. Also: **ses must NOT be bundled**
    (vite/rollup break the taming) — the page loads the standalone compartment-mapper build
    `public/ses.umd.min.js` first; rebuild via `yarn build:ses-shim`.
  - Proven end-to-end against the real server by `lockdown-survive.staging.test.cjs`
    (`yarn test:lockdown`, 13/13): app.js boots in the frozen realm, built-in islands + untrusted
    forks render inline, a malicious fork's Function escape THROWS, and the flag-off path refuses
    untrusted source. dan made the live call: **`FIELD_LOCKDOWN=1` shipped to the live service**
    (systemd drop-in `lockdown.conf`), re-proven against :8778 itself 2026-07-01.
- **Phase 2 — the grain layer + component = git object (DONE).** ✅ The
  cell/propagator substrate (`client/propagator.js`) and the **TMS grain**
  (`makeTmsCell`) — proven 15/15. ✅ **component = git-as-Endo object**
  (`component-git.mjs`, on the real `@endo/git` `makeNativeGitBackend` — one git
  repo per component): a component's SOURCE is versioned (each edit = a commit oid),
  read-at-version (immutable git tree → file map), **fork** (independent clone that
  diverges while the original is untouched), **non-destructive revert** (re-commit
  an earlier tree; history preserved) — proven 11/11. Wired into the tool lifecycle:
  a version is committed on admit; `/components/{history,read,revert}` (root) +
  `componentHistory`/`revertComponent` agent verbs; revert updates the live tool via
  `customTools.setSource`. ✅ The full **`makeGit` exo wrapper now exists too**
  (`component-git.mjs` `gitObject(id)`): the remotable, attenuable EndoGit cap over a
  lazily-built daemon mount — `filesystemAt(ref)` read-a-version-as-a-folder,
  `worktree()` writable authoring + `add`/`commit`, `readOnly()` attenuation, plus the
  file-granular `writeFile()` on top of it. Still open: binding a component's persisted
  DATA to grains so a runtime source-swap keeps the grains (partial today — grain data
  survives some paths, not all).
- **Phase 3 — per-component edit agent (DONE) + alt-click selection (DONE).**
  ✅ The Component Studio (root "Components" tab): every admitted component shows its
  source version history + live grain data, with **✎ edit** (a confined agent edits
  ONLY that component's source → a new version, applied live), **fork**, and **revert**.
  The edit agent is `editComponentSource` (`/components/edit`); the conversational loop
  is `/components/edit-chat` (a real scoped agent: read source → clarify → edit, modal
  chat via `openComponentEditChat`); both are scoped to the one component's source and
  their output runs the discipline panel. A seeded `demo-counter` makes it tryable out
  of the box. ✅ The **Alt/Option-click selection overlay** is BUILT + TESTED
  (`componentSelect()` in `public/app.js`): hold Alt → hover outlines any element
  carrying a component identity (`[data-component-id]`, `.gw-component`, or a live
  mounted fork's `[data-fork-id]` — confined iframes go pointer-transparent while Alt
  is held so the owner's gesture lands); click → a chip offers ✎ edit / ⑂|🍴 fork, and
  an id-less inline chat component is broken out into a project object on first edit.
  Proven by `test:component-select` 10/10 + `test:alt-fork` 5/5, live under
  `FIELD_LOCKDOWN=1`. What IS still open here:
  - ~~most app chrome is not registry-backed~~ **CHROME DECOMPOSITION BEGUN (2026-07-01,
    increment 1)** — see "App chrome as registry-backed components" below. Three shell
    pieces converted (`chrome-msg-toolbar`, `chrome-welcome`, and `chrome-trace-view` —
    the trace view as a data-fed, fork-riffable island); the rest of the shell is
    still hardcoded/island-only — convert piece by piece with the recipe below.
  - ~~forks use the one-shot `/forks/edit`~~ **DONE (2026-07-01)**: forks now get the
    same conversational agent loop via `/forks/edit-chat` (owner-gated; toolbox =
    `readForkSource` + `editFork`, its entire authority); Alt-click ✎ on a live fork
    opens the same modal chat. Proven by `test:fork-edit-chat`. The one-shot
    `/forks/edit` remains for deterministic/tooling edits.
  - **grain-data persistence across a source-swap is partial** (see Phase 2).
  - binding the dev flow to fork→adversarial-review→diff.
- **Phase 4 — sharing & upgrades.** Invite-carries-inbox; atomic accept/reject/
  auto upgrades; non-destructive try-on review; upstream/downstream element
  sharing; trust flags in invites → notifications feed.
- **Phase 5 — distribution trust.** The "valid for distribution" capability as a
  social-collateral act; admin review gate for end-user distribution;
  exfiltration-proof verification of a confined container.

## App chrome as registry-backed components (increment 1 — SHIPPED 2026-07-01)

"The app feels like yours, edit anything" used to stop at the shell: alt-click only
targeted elements that already carried a component identity. Increment 1 makes the
monolithic chrome itself decomposable: a chrome piece becomes a **seeded `chrome-…`
project-object** in component-git, rendered through the **existing confined no-iframe
path** (the fork pipeline: `(endowments, props) => vnode`, SES compartment under
`FIELD_LOCKDOWN`, `renderConfined`) — so it gets versions/revert, a backlog, alt-click
→ edit chat, and the render-check gate, all for free. Proven end-to-end by
`chrome-components.staging.test.cjs` (`yarn test:chrome`, 63/63).

**Converted so far:**
- `chrome-msg-toolbar` — the per-message action strip (🔗 clip + 📋 copy). Mounts once
  per message; perf is a non-issue because the source is **compiled once per version**
  (one Compartment, cached in `islands.js renderChrome`) and each mount is a plain
  preact render — measured 0.11 ms/mount (first mount incl. compile 0.4 ms).
- `chrome-welcome` — the empty-chat landing panel (tagline + starter-suggestion chips
  that fill the composer).
- `chrome-trace-view` — **the TRACE VIEW as an island (2026-07-01)**, dan: "make the
  trace view an island … properly fork & riffable. I suspect people will have a lot of
  interesting ways they want to visualize a trace." The first **DATA-FED chrome piece**
  — see "The cell-as-interface pattern" below. During a turn the island (a 2D neon
  fan-out: pulsing running chips, ok/fail settling, children counts, live progress
  line, a ⊿3D chip) replaces the in-turn 3D pendant; the pendant remains (a) one tap
  away via ⊿3D — fullscreen on the same live `/chat/steps` replay — and (b) the
  automatic fallback whenever the island refuses/breaks, including a live edit breaking
  it MID-turn. Voice-listening, the permissioning dodecahedron, and agent-shape views
  stay pendant-native. Proven by `trace-island.staging.test.cjs` (`yarn
  test:trace-island`, 32/32: a REAL turn against a stub CodeMode LLM streams ≥4
  monotonic frames through the cell; chips grow mid-turn; alt-click chips it; a
  scripted list-renderer riff receives the same frames; a throwing edit is
  render-check-refused; a broken island → pendant fallback + backlog auto-file).
- `chrome-studio` — **the Component Studio LIST itself (wave 1, 2026-07-01)**, dan: he
  wanted to reorder the Studio's sections and couldn't — the order was a hardcoded concat
  in `app.js` (`pending+admitted html + chromeHtml + islandsHtml`). Now the whole list is
  one confined component whose **section order is DATA in the source** — a `SECTION_ORDER`
  array (`['pending','admitted','chrome','islands']`). "Show islands before app chrome" /
  "put admitted at the top" is a one-sentence edit chat, persisted as a git commit that
  **survives reload — no new runtime state needed** (this is the whole point of the ask).
  - **THE SECTION-ORDER-VIA-SOURCE PATTERN.** Layout/order that today is hardcoded DOM
    concatenation becomes an *ordered list in the component source*; reordering is a source
    edit (⇒ a git version ⇒ reload-durable). No per-user prefs, no store, no schema — the
    committed source IS the persisted order. Reach for this whenever "I want to rearrange
    the shell" is the ask and the arrangement can be shared across viewers.
  - **DEFERRED: the `chrome-prefs` grain.** Per-USER runtime order/prefs (each viewer their
    own arrangement, live-toggleable, not a shared commit) is out of scope here — it wants a
    subscribable per-user grain (the cell-as-interface pattern) feeding an `order` prop, not
    a source edit. Named for a later wave; do NOT build drag-reorder/prefs into chrome-studio.
  - Authority: the confined component only RENDERS + calls back. Admit / reject / revise /
    edit / revert / fork are the trust-sensitive component-lifecycle actions — they stay
    **host-gated exactly as before** (`studioAdmit`/`studioReject`/`studioRevise`/`studioRevert`
    + `editComponent`/`forkComponentAct` in app.js, cap-carrying, `window.confirm` on
    critical/destructive). The host aggregates the 4 fetches (`/tools/review`,
    `GET /chrome/components`, `/components/islands`, per-id `/components/history`) into ONE
    render-safe props object `{pending, admitted, chrome, islands, on*}` and mounts via
    `renderChrome`. **The imperative builder is KEPT as the fallback branch** (renderChrome
    returns false → the original `innerHTML` list + `wireComponentActions`) — the anti-brick
    floor: a broken chrome-studio edit degrades to a working legacy list you can still
    admit/edit/revert from. `reloadChromeComps` repaints it (refreshComponents) too. Proven
    by `chrome-components.staging.test.cjs` (63/63: seeded w/ the props-schema header;
    reorder round-trips + persists via git; a throwing edit is render-check-refused; alt-click
    ✎/⑂ chip names the Studio; admit + revert fire correctly through the CALLBACK path; a
    broken source falls back to a WORKING imperative list + auto-files to `backlog:chrome-studio`).

**The architecture (each part is load-bearing):**
- `chrome-components.mjs` — the seed registry. Seeds commit on first boot only; user
  edits survive restarts. Seeding also `componentBacklog.ensure`s (implicit endowment).
- `GET /chrome/components` — HEAD sources for every chrome id (public-safe render text,
  no cap, `no-store`). The client fetches once per load + after an edit/revert.
- **Authority model:** a chrome component is a pure render propagator. The HOST keeps
  every authority-bearing move (selection/DOM reads, clipboard, `/clip/create`) and
  passes only the affordance callbacks it may fire (`onClip`/`onCopy`/`onSuggest`) as
  props — the props ARE the ocap boundary.
- **Edit lane:** `/components/edit` + `/components/edit-chat` recognize `chrome-` ids →
  `editChromeSource` (FORK_EDIT_SYS persona; `body.source` = exact-source tooling lane).
  **Render-check gate:** the rewritten source must pass `renderCheck(kind:'fork')`
  BEFORE commit — a broken edit is refused, the previous version stays live.
- **Live apply:** after an edit-chat edit or a Studio revert of a `chrome-` id, the
  client re-fetches HEAD + repaints (`reloadChromeComps` → `renderTx` + welcome mount).
  No vite rebuild, no page reload (unlike islands).
- **Fallback floor:** `renderChrome` returns false on compile OR mount-time failure →
  the caller paints the ORIGINAL hardcoded DOM (never a dead toolbar), and the failure
  auto-files onto the component's own backlog (`__fieldReportError` → `/error/flag` →
  `componentBacklog`).
- Chrome components appear in the Component Studio ("App chrome" section: edit +
  version history + revert).

**THE TRUSTED-PATH DENYLIST (dan's hard boundary — never regress).** The
consent/permission surfaces are NOT editable chrome: the scope-consent sheet, the
Shares panel (power grant/revoke + auto-confirm rules), the powers banner, and
proposal Confirm/Reject cards. Enforced by an **explicit denylist mechanism**, not
omission: they carry `data-trusted-path`, and
1. `componentSelect` (app.js) refuses anything inside `[data-trusted-path]` with a
   distinct dashed **"🔒 trusted path"** indicator — no chip, no edit chat, ever;
2. `tagComponent` (islands.js) refuses to give any element inside a trusted container
   a component identity at all (so the identity can't even exist to be selected);
3. the staging test asserts the consent sheet can never acquire a component identity
   and that alt-click on it and on the Shares panel yields the 🔒 refusal.
Residual (flagged, deliberate): `island-shares-panel` remains editable via the
root-only Studio path (a deliberate operator act on source, not an in-situ alt-click);
its rendered mount can no longer be tagged or selected.

**The cell-as-interface pattern (data-fed islands — how chrome-trace-view is wired):**
a chrome piece that renders LIVE DATA never fetches and never parses SSE. Instead:
1. The server folds its event stream into a **monotonic propagator cell** served by the
   one `/cells/subscribe` broker. For the trace: `trace-cells.mjs` rides the `emitStep`
   choke point (the same events as `/chat/steps`) — steps append then settle in place
   (merge, never rewind), `rev` only grows, a new turn bumps `turn`, `rnode` upserts the
   research sub-tree. Ownership binds first-writer to the cap that runs the turn and the
   subscribe gate re-validates on the 15s heartbeat (like `backlog:` cells).
2. The HOST holds the cap + ONE subscribe stream and re-renders the island on every
   push (`app.js traceIslandBegin`): `mountChrome(id, host, { trace: value, …handlers })`
   — compile-once-per-version makes the per-push render a cheap preact diff.
3. **THE CELL IS THE INTERFACE.** The value schema is documented in the seeded source's
   HEADER COMMENT, so anyone alt-clicking into the edit chat sees the contract before
   riffing. Any `(endowments, props) => vnode` honoring the same props contract can
   replace the viz entirely (list, timeline, graph…) — the cell feeds every fork the
   same frames. The component stays pure render: no cap, no network, host callbacks
   (`onOpen3D`) as props.
4. A mid-stream mount failure (e.g. a live edit that breaks the island while data is
   flowing) falls back to the piece's legacy renderer and auto-files the error — the
   data keeps flowing either way because the stream belongs to the HOST, not the island.

**Recipe — converting the NEXT chrome piece (checklist for future workers):**
1. Pick a piece whose authority-bearing behavior can stay host-side. Write its render
   as a `(endowments, props) => vnode` seed in `chrome-components.mjs` (stable id
   `chrome-<piece>`; keep load-bearing class names, e.g. `.msg-clip`). Callbacks come
   in via props; the seed must pass `renderCheck(kind:'fork')`.
2. In app.js, replace the hardcoded render with a `mountChrome('chrome-<piece>', host,
   props)` call **behind `chromeReady`**, keeping the original DOM builder as the
   fallback branch (`if (!mountChrome(...)) legacy()`); repaint the piece inside
   `reloadChromeComps` if it lives outside `renderTx`.
3. Do NOT convert anything on the trusted-path denylist; if the piece renders
   authority decisions, mark it `data-trusted-path` instead.
4. Extend `chrome-components.staging.test.cjs`: renders confined + tagged, alt-click
   selects → edit chat addresses the id, a broken edit is refused, live apply, the
   fallback paints the legacy DOM + backlog auto-file.
5. Run the battery: `test:chrome`, `test:component-select`, `test:alt-fork`,
   `test:component-error-loop`, `test:component-backlog`, `test:fork-edit-chat`,
   `test:theme`, `test:confinement`, `test:lockdown` (+ any island test for the piece).

Still open for chrome (increment 2+): non-root users get their own VARIANT (fork
model: owner edits root, others fork — today chrome editing is root-only and one
shared root variant); converting larger shell regions (header, composer, sidebar)
whose islands currently need a rebuild; ~~grain-backed chrome~~ **BEGUN** — the trace
island is the first cell-fed chrome piece (the cell-as-interface pattern above); wire
the remaining data-showing pieces to cells the same way. Trace-specific residuals:
WebGL/three riffs need the Tier-2 iframe runtime (the no-iframe sanitizer allowlist has
no canvas/svg tags — the default island is div-based on purpose, ⊿3D opens the classic
pendant); per-user trace-island VARIANTS ride the same fork-model open above.

## Open sequencing decisions (for dan)

1. **How to obtain `@endo/preact-container`** — rebase our fork onto `llm`/#471
   (clean, but #471 is open/unmerged) vs vendor the package onto our current
   branch now (fast, but divergence to reconcile when #471 merges).
2. **Port strategy** — incremental islands (mount confined Preact components into
   the existing 2223-line DOM `app.js` one at a time; lowest risk; both render
   paths coexist behind a flag) vs a big-bang rewrite.
3. **First slice to port** — a self-contained leaf (e.g. the budget chip, the
   composer, a message bubble, or the Shares panel) to validate confined-render
   + project-backing + runtime-swap before widening.
