# Authoring a UI component in Agent C

Agent C's UI is a growing library of **confined-Preact islands** built on a shared **ui-kit**.
This is the discipline for adding to it — for the Blacksmith, dev-agents, and the in-app
Alt-click island editor alike.

## 1. Reuse first (this is the rule, not a suggestion)

**Always prefer an existing component.** Before writing any new markup, compose what already
ships — it is themed, tested, and consistent. The canonical list is
[`component-catalog.mjs`](./component-catalog.mjs) (`catalogText()`), which is injected into the
island-authoring prompt so an authoring agent is *told* what exists:

- **kit primitives** (`client/ui-kit.js`) — `Btn`, `Chip`, `Field`, `TextField`, `Select`,
  `Checkbox`, `Toggle`, `Banner`, `Modal`, `Table`, `Tabs`, `Card`, … (37 of them). Compose these.
- **islands** (`client/*.js`) — whole pieces: `ProposalCard`, `AskCard`, `ChatList`,
  `TraceSignature`, `ShareLinkManager`, … (15). Reuse one wholesale when it fits.
- **live widget verbs** — `showEntityStatus`, `showCountdowns`, `showChoices` for live replies.

**Create a new component only when no existing one meets the need.** That's allowed and expected —
the library grows. But when you do:

- build it **from kit primitives** (don't hand-roll `h('button'/'input'/…)` when `Btn`/`TextField` exist);
- use **theme vars only** — never hardcoded colours (light *and* dark must work — see §3);
- keep it **general + stateless** (state lives in props/cells), so it's reusable, not one-off;
- **register it** (add to `island-source.mjs` ISLANDS + the catalog) so the next agent reuses it
  instead of reinventing — and add a `KitSampler`/gallery preview + a vnode test.

The reuse-first directive lives in `reuseFirstPreamble()` and is prepended to `ISLAND_EDIT_SYS`
in `server.mjs`; the **theme-review kit-consistency lens** (§4) flags reinvention as the feedback loop.

## 2. The island recipe

`client/<name>.js` (pure `(props) => vnode`, `h`-based, no JSX, render-safe data only — never a
swissnum/secret) → wire a cell + `renderX` in `client/islands.js` → register in `island-source.mjs`
→ gallery preview + `ISLAND_PREVIEW` → a vnode test in `islands-ui.test.mjs` → `yarn build:islands`
→ restart. (See the `apps_on_the_fly` / `preact_component_trie` direction.)

## 3. Theming — never hardcode a colour

Every colour is a CSS var that flips with the theme (`--bg --panel --ink --mut --acc --acc2 --bad
--you* --trace* --warn`). A hardcoded dark fill under `var(--ink)` text is invisible in light mode —
that is the bug class the tests below exist to catch. When you add a theme var, add it to **both**
palettes in `theme.js` **and** the `:root` block in `index.html`.

**Accent is two tokens** (so accent-as-text and accent-as-button-fill don't fight): `var(--acc)` /
`var(--you)` for accent **text/borders/glyphs**, and `var(--acc-fill)` / `var(--you-fill)` for a solid
accent **background with white text** (white clears WCAG AA on the `-fill` tokens; the text tokens are
tuned for contrast on the panel and are *not* safe as a white-text fill). Reaching for the kit `Btn`
(`variant:'primary'`) gets this right for free — another reason to reuse.

## 4. The two-layer review gate

**a) Deterministic — run on every change (`yarn test` + `yarn test:theme`):**
- `theme-coverage.test.mjs` — var lockstep across themes, `:root` fallback, no undefined var refs,
  no opaque hardcoded backgrounds.
- `theme-matrix.staging.test.cjs` — renders every island (incl. `KitSampler`) across dark/light/
  partial themes and fails any text below 3:1 contrast.

**b) Adversarial — the judgement layer (run when authoring/changing a component):**
the **theme-review** reviewer. It renders the component across themes (screenshots + a precise
computed-style report) and runs six adversarial design lenses — visual hierarchy, affordance &
interactivity, dark/light parity, accessibility (focus/tap-target/motion/aria), **kit-consistency
(does it reuse the kit or reinvent?)**, and polish — then verifies findings against the rendered
facts.

```
# the render evidence (screenshots + computed-style report) for one island:
node theme-review.cjs <IslandName>          # → /tmp/theme-review/<IslandName>/{report.json,dark.png,light.png}

# the full adversarial review (the reusable workflow):
Workflow({ scriptPath: "<…>/theme-review.workflow.js", args: "<IslandName>" })
```

Deterministic tests catch regressions; the reviewer catches taste — and enforces "reuse first."

## 5. Cap-hygiene (always)

Render-safe data only. Never put a swissnum / `#cap` / share token in a component's DOM, props,
or logs — copy or on-demand QR only. The cap is the boundary. See [[cap_hygiene_no_render]].
