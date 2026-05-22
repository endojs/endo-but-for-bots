# EndoClaw: Coherent Browser Exo Interfaces

| | |
|---|---|
| **Created** | 2026-05-22 |
| **Author** | endolinbot (prompted) |
| **Status** | Not Started |
| **Parent** | [endoclaw](endoclaw.md) |
| **Sibling** | [endoclaw-pinchtab](endoclaw-pinchtab.md) |
| **Revises** | [endoclaw-browser](endoclaw-browser.md) (recommendation: yes, see § Recommendation) |

## Summary

Defines a single `Browser` / `Page` Exo shape that both the
Playwright-backed proposal in
[endoclaw-browser](endoclaw-browser.md) and the PinchTab-backed
proposal in [endoclaw-pinchtab](endoclaw-pinchtab.md) implement, plus
two narrow extension interfaces for features that only one backend can
serve.
The result is that an agent holding `Browser` does not know (and
does not need to know) whether the underlying engine is Playwright or
PinchTab.
Recommends revising `endoclaw-browser.md` to declare the unified
shape as the contract and Playwright as one backend.

## Why a Unified Shape

The 2026-03-03 `endoclaw-browser` proposal pre-dated PinchTab and
named Playwright in the capability shape (`E(browser).goto(url)`
returning a Playwright-flavored `Page`).
That shape is fine in isolation but commits the agent vocabulary to
one engine.

Three pressures make a unified shape worth pulling out:

1. **PinchTab and Playwright are not the last two backends.**
   A future MCP-bridge backend ("browse via a third-party browser MCP
   server") is plausibly the third
   (see [endoclaw](endoclaw.md) &sect; Browser Control, Josh's note
   on MCP-bridged browsers).
   Adding a third without a stable shape forces every agent skill to
   branch on backend.

2. **Token efficiency is a first-class agent concern, not an
   engine-specific feature.**
   PinchTab's pitch (accessibility tree with stable refs, ~10&times;
   token reduction) is something Playwright can simulate via its own
   `accessibility.snapshot()`.
   If the shape is `selector`-only (the `endoclaw-browser` original
   shape), the agent cannot use the cheaper read mode even when the
   backend supports it.

3. **Snapshot-driven loops are the post-2025 agent norm.**
   Modern agent skills `snapshot &rarr; reason &rarr; act` rather
   than `know-selector &rarr; click(selector)`.
   The unified shape makes that loop the primary read path and
   `selector` an alternative, not the other way around.

## Base `Browser` Interface

The base interface is what every backend implements.
An agent that only calls these methods is portable across backends.

```ts
interface Browser {
  /**
   * Open a new page.
   * Host-side allowedOrigins check runs before the backend call;
   * disallowed URLs throw without contacting the engine.
   */
  newPage(url: string): Promise<Page>;

  /**
   * The backend identifier ('playwright' | 'pinchtab' | ...).
   * Read-only; lets the agent (and the host) introspect, but does
   * not gate authority. The exo, not the agent, decides what each
   * backend can do.
   */
  backend(): string;

  /** Allowed origins as a snapshot (no mutation). */
  allowedOrigins(): string[];

  help(): string;
}

interface Page {
  /** Current URL. */
  url(): string;

  /** Page title (may require a backend roundtrip). */
  title(): Promise<string>;

  /**
   * Snapshot the page as a structured node list with stable refs.
   * Default filter: 'interactive' (links, buttons, inputs, etc.).
   * Each node carries { ref, role, name } plus optional { value,
   * checked, disabled }. The ref is stable for the lifetime of the
   * snapshot; backends are not required to keep refs stable across
   * snapshots.
   */
  snapshot(options?: SnapshotOptions): Promise<SnapshotNode[]>;

  /**
   * Page text. Default mode 'readability' (Mozilla Readability or
   * equivalent); 'raw' is whole-document text content.
   */
  text(options?: { mode?: 'readability' | 'raw' }): Promise<string>;

  /** PNG screenshot, full page by default. */
  screenshot(options?: { fullPage?: boolean }): Promise<Uint8Array>;

  /**
   * Wait for a condition. Backends translate to whatever they have:
   * Playwright's locator-based waits, PinchTab's polling on
   * snapshot. Selector matches { ref } or { role, name }; either
   * works.
   */
  waitFor(target: PageTarget, options?: { timeoutMs?: number }): Promise<void>;

  /** Navigate within this page (forward/back/reload). */
  navigate(direction: 'back' | 'forward' | 'reload'): Promise<void>;

  /** Same-origin navigation; cross-origin throws. */
  goto(url: string): Promise<void>;

  /** Close this page. The Page exo is no longer usable after. */
  close(): Promise<void>;

  // ----- Mutation methods (disabled by setReadOnly(true)) -----

  /** Click an element by ref or role-and-name. */
  click(target: PageTarget): Promise<void>;

  /** Focus and type text. */
  type(target: PageTarget, value: string): Promise<void>;

  /** Fill an input (clear + type, atomically where the backend allows). */
  fill(target: PageTarget, value: string): Promise<void>;

  /** Press a key globally or on a focused element. */
  press(key: string, target?: PageTarget): Promise<void>;

  /** Select an option by ref (target is the select element). */
  select(target: PageTarget, value: string): Promise<void>;

  /** Scroll an element or the page. */
  scroll(target: PageTarget | 'page', options?: ScrollOptions): Promise<void>;

  help(): string;
}

interface BrowserControl {
  setAllowedOrigins(origins: string[]): void;
  setReadOnly(flag: boolean): void;          // disables click/type/fill/press/select
  setMaxConcurrentPages(n: number): void;
  revoke(): void;
  help(): string;
}

// ----- Shared types -----

type SnapshotOptions = {
  filter?: 'interactive' | 'all';
  /** Backends may ignore this; treat as a hint. */
  budget?: { maxNodes?: number; maxBytes?: number };
};

type SnapshotNode = {
  ref: string;                                // 'e0', 'e1', ...
  role: string;                               // ARIA role
  name?: string;                              // accessible name
  value?: string;                             // for inputs
  checked?: boolean;
  disabled?: boolean;
  children?: SnapshotNode[];                  // nested when filter==='all'
};

/** Address an element either by accessibility ref or by role-and-name. */
type PageTarget =
  | { ref: string }
  | { role: string; name?: string; nth?: number };

type ScrollOptions =
  | { direction: 'up' | 'down' | 'left' | 'right'; pixels?: number }
  | { intoView: true };
```

This is the entirety of what an agent skill should bind against.
Backends MAY refuse calls they cannot serve, throwing a tagged error
(`SnapshotUnsupported`, `EvalRequired`, etc.), but the **shape**
of every call is in the base.

## Per-Backend Extensions

Two narrow interfaces sit beside `Browser` for features that one
backend can serve and the other structurally cannot.
A capability that the host wants to expose extends the base with one
or both of these.

### `PlaywrightBrowser extends Browser`

```ts
interface PlaywrightBrowser extends Browser {
  /**
   * Open a new page with a Playwright-specific browser type
   * ('chromium' | 'firefox' | 'webkit'). PinchTab is Chrome-only.
   */
  newPageOnEngine(engine: 'chromium' | 'firefox' | 'webkit', url: string): Promise<Page>;

  /**
   * Playwright's selector engines: 'css', 'xpath', 'text='.
   * PinchTab has no CSS-selector mode; refs are the only addressing.
   * Setting a non-default selector engine on a Page is a Playwright-only
   * concern.
   */
  setDefaultSelectorEngine(engine: 'css' | 'xpath' | 'text'): void;
}
```

The rationale for keeping these on an extension rather than the base:
PinchTab is Chrome-only and ref-only, and the most useful design
property is that a `Browser`-holding agent **cannot tell** which
backend is under it without calling `backend()`.
A method like `setDefaultSelectorEngine` would force a `try/catch`
on every PinchTab-backed agent.

### `PinchTabBrowser extends Browser`

```ts
interface PinchTabBrowser extends Browser {
  /**
   * PinchTab-specific stealth toggle. Stealth is on by default;
   * agents that need a "real" headless signal (Anubis evasion is
   * usually about *not* looking like a bot, so this is rare) can
   * turn it off.
   */
  setStealth(flag: boolean): void;

  /**
   * Persistent profile management. The base capability is one
   * profile per Browser; PinchTab also supports list/delete on the
   * underlying profile dir. This is a host concern, not an agent
   * one; it lives on the extension rather than BrowserControl
   * because PinchTab is the only backend that exposes a profile
   * lifecycle separate from the capability lifecycle.
   */
  listProfiles(): Promise<{ id: string; name: string }[]>;
}
```

### `EvalCapableBrowser extends Browser`

```ts
interface EvalCapableBrowser extends Browser {
  /**
   * Run an arbitrary JS expression in the page's execution context.
   * Disabled by default on every backend; opt-in via
   * BrowserControl.setEvalAllowed(true). Eval is a structural
   * side-channel out of the origin allowlist (the agent can fetch()
   * any origin from inside the page), so the host must understand
   * the trust shift before enabling it.
   */
  eval(page: Page, script: string): Promise<unknown>;
}

interface BrowserControl {
  // ... base methods elided ...
  setEvalAllowed(flag: boolean): void;
}
```

This is shared shape, but it is opt-in and orthogonal to the base.
Both Playwright and PinchTab can implement it (Playwright via
`page.evaluate`, PinchTab via `POST /tabs/{tabId}/eval`); some
backends (a hypothetical "snapshot-only" MCP backend) cannot.

## Mapping Each Backend to the Base

| Method | Playwright maps to | PinchTab maps to |
|---|---|---|
| `newPage(url)` | `context.newPage()` then `page.goto(url)` | `POST /instances/{id}/tabs/open {url}` |
| `snapshot({filter})` | `page.accessibility.snapshot()` filtered to interactive | `GET /tabs/{tabId}/snapshot?filter=interactive` |
| `text({mode:'readability'})` | inject Mozilla Readability + read | `GET /tabs/{tabId}/text` (readability default) |
| `text({mode:'raw'})` | `page.innerText('body')` | `GET /tabs/{tabId}/text?mode=raw` |
| `screenshot()` | `page.screenshot()` | `GET /tabs/{tabId}/screenshot` |
| `click({ref})` | resolve `ref` &rarr; locator &rarr; `click()` | `POST /tabs/{tabId}/action {kind:'click',ref}` |
| `click({role,name})` | `page.getByRole(role,{name}).click()` | snapshot &rarr; find matching ref &rarr; click |
| `type({ref}, v)` | `locator.type(v)` | `POST /tabs/{tabId}/action {kind:'type',ref,value}` |
| `fill({ref}, v)` | `locator.fill(v)` | `POST /tabs/{tabId}/action {kind:'fill',ref,value}` |
| `press(k)` | `page.keyboard.press(k)` | `POST /tabs/{tabId}/action {kind:'press',key}` |
| `waitFor({ref})` | poll the ref's locator | poll `snapshot` until ref present |
| `goto(url)` | `page.goto(url)` | `POST /tabs/{tabId}/action {kind:'goto',url}` |
| `close()` | `page.close()` | `DELETE /tabs/{tabId}` (or close action) |

Two places where the mapping is non-trivial:

1. **`click({role, name})` on PinchTab** requires a snapshot
   roundtrip to resolve role-and-name to a `ref`.
   The PinchTab plugin caches the most recent snapshot per tab to
   avoid double-fetching, but the cache is a closed-over implementation
   detail of the action that produced it, not a long-lived `Page`
   property; the agent never sees it.
   The invalidation policy is precise:
   - The cache is **scoped to a single `click({role, name})` (or
     `type`/`fill`/`press`/`select` by `{role, name}`) dispatch**.
     Within that dispatch the plugin issues `snapshot &rarr; resolve
     ref &rarr; act` as one atomic sequence and discards the cached
     snapshot before returning.
   - There is **no cross-call caching**: a subsequent
     `click({role, name})` re-fetches a fresh snapshot.
   - `Page.snapshot()` calls by the agent are independent of this
     internal cache; the agent's snapshot is its own and the plugin
     does not reuse it for ref resolution.
   - The plugin also issues a re-snapshot **inside** the dispatch
     after PinchTab acknowledges the action but **before** returning
     to the agent if the action is one that mutates the DOM (`click`,
     `type`, `fill`, `press`, `select`); the post-action snapshot is
     used only to surface a tagged error
     (`StaleRefAfterMutation`) when the resolved `ref` no longer
     identifies the same role-and-name pair, and is then also
     discarded.
   This eliminates the TOCTOU between role-and-name resolution and
   the action's own dispatch: the resolution snapshot is bracketed
   inside the single call, and DOM mutation under the action's own
   dispatch is detected by the post-action re-snapshot rather than by
   carrying stale state forward.

2. **`waitFor` on PinchTab** is polling, not push-based.
   The plugin's default poll interval is 200ms with exponential
   backoff up to 2s; the `timeoutMs` option caps total wait.
   This is observably slower than Playwright's event-driven waits;
   the cost is part of the PinchTab tradeoff and is documented on
   the capability's `help()` string.

## Recommendation: Revise `endoclaw-browser.md`

**Yes, revise it.**
The current `endoclaw-browser.md` shape is acceptable in isolation
but ages poorly once a second backend exists.
The recommended revision:

1. Rename the doc title from "EndoClaw: Browser Capability" to
   "EndoClaw: Browser Capability (Playwright Backend)" so the role
   of the document is clear.

2. Replace the `Capability Shape` section with a one-line
   "Implements the base `Browser` / `Page` / `BrowserControl` shape
   defined in [endoclaw-browser-interfaces](endoclaw-browser-interfaces.md);
   adds the `PlaywrightBrowser` extension."

3. Keep the `How It Works` and `Endo Idiom` sections; they remain
   Playwright-specific.

4. Move the `goto` &rarr; `Page` / `querySelector` / `submit` API
   into the base shape's mapping table (already done above), and
   delete the per-method signatures from `endoclaw-browser.md`
   itself.

5. Add a `## Backend Differences` section pointing the reader at the
   base doc's `Mapping Each Backend to the Base` table.

The revision is a **separate follow-up PR** per the dispatch
out-of-scope clause; this design proposes it, and a builder dispatch
later carries it out.

### Why not revise it in this PR

- The `endoclaw-browser.md` doc is unimplemented (Status: Not
  Started); the revision has no implementation ripple.
- A single PR that lands two siblings *and* edits a third doc is
  noisier to review than two PRs.
- Keeping the revision as a separate PR lets the maintainer accept
  the unified-shape proposal without committing to the editorial
  shape of `endoclaw-browser.md`.

## Phased Adoption

Since both backend designs are unimplemented, the unified shape can
be the implementation contract from the start.

| Phase | Scope | Where |
|---|---|---|
| 1. Define the shape | This document. | Now. |
| 2. PinchTab plugin builds against the base | Phases 1&ndash;5 of the sibling design. | [endoclaw-pinchtab](endoclaw-pinchtab.md). |
| 3. Revise `endoclaw-browser.md` | Editorial PR as described above. | Follow-up; separate PR. |
| 4. Playwright plugin builds against the base | When implementation of `endoclaw-browser` begins. | Future builder dispatch. |
| 5. MCP-bridge backend (if added) | Implements the base, declines extensions. | Future design. |

## Dependencies

| Design | Relationship |
|---|---|
| [endoclaw-browser](endoclaw-browser.md) | The doc this proposes revising; one backend of the unified shape. |
| [endoclaw-pinchtab](endoclaw-pinchtab.md) | The sibling backend; the design that motivated the unification. |
| [endoclaw](endoclaw.md) | Parent; capability vocabulary. |
| [daemon-capability-bank](daemon-capability-bank.md) | The Browser capability is the bank's row for browser automation. |

## Open Questions

1. **Should `backend()` return a string or a brand?**
   A branded type would let the host's TypeScript narrow safely;
   a string is simpler.
   Current proposal: string, with an exported union of known
   backend identifiers.

2. **Ref stability across snapshots.**
   PinchTab refs are stable within a snapshot but not necessarily
   across snapshots after a DOM mutation.
   The spec above says "not required to keep refs stable across
   snapshots," and the precise invalidation policy in § Mapping
   bounds the resulting TOCTOU exposure to a single mutating call's
   own dispatch.
   Open question: should a backend that *can* keep them stable
   (Playwright via element-handle reuse) advertise that on
   `backend()`?
   Current lean: no, agents treat refs as snapshot-local; backends
   that happen to keep refs stable longer do so as an opaque
   implementation choice, not a contract.

3. **PageTarget overlap.**
   `{ ref }` and `{ role, name }` can both match.
   The spec says the backend resolves in that order: `ref` first
   (fast), `role+name` second (slower).
   `nth` disambiguates multiple matches; default `nth: 0`.

4. **Snapshot caching contract.**
   PinchTab needs snapshot caching to make `{role, name}`
   addressing cheap.
   Should the cache be observable to the agent
   (`snapshotVersion` field), or invisible?
   Current lean: invisible; the agent calls `snapshot()` when it
   wants a fresh one.

5. **Concurrency limits.**
   `BrowserControl.setMaxConcurrentPages(n)` is in the base.
   PinchTab's `pinchtab server` can manage many instances;
   Playwright's `BrowserContext.newPage()` is unbounded.
   Open question: is the limit per-`Browser`-capability or per-host
   total?
   Current lean: per-capability, with the host setting a
   reasonable default at grant time.

## Prompt

> Author one design (or up to two siblings, designer's call per the
> 1-3-screens rule) covering: (a) a Daemon/Familiar plugin for
> pinchtab.com &mdash; including its capability shape,
> daemon-vs-familiar placement, auth model, trust posture, phased
> implementation &mdash; and (b) a coherent-Exo-interfaces analysis
> that unifies the new pinchtab plugin's shape with the existing
> Playwright proposal in `endoclaw-browser.md`, naming a base
> `Browser` Exo interface both backends implement plus per-backend
> extensions for the unreconcilable features. Recommend whether
> `endoclaw-browser.md` should be revised to match the unified base
> (decision with rationale).
