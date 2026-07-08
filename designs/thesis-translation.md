# Thesis translation: Robust Composition in Hardened JavaScript

| | |
|---|---|
| **Created** | 2026-07-07 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## Summary

Publish a modernized edition of Mark S. Miller's 2006 PhD dissertation,
*Robust Composition: Towards a Unified Approach to Access Control and
Concurrency Control*, as documentation under `docs/thesis/`, routed to
`docs.endojs.org/thesis/`. The defining move: Miller's prose and arguments
stay faithful to the original, while every E code example is translated
into the Jessie subset of Hardened JavaScript, and the dissertation's
distributed-object protocol material (Pluribus, the ancestor of CapTP)
is re-expressed in OCapN terms, grounded in this repository's own
`@endo/eventual-send`, `@endo/exo`, `@endo/patterns`, and `@endo/ocapn`
packages. Every substitution is visibly flagged so a reader can always
distinguish Miller's 2006 text from the 2026 translation layer.

This is a design, not the translation. A sequence of builder jobs
implements it in phases; the first phase is specified to the level a
builder can start from. **Publication was gated on the author's explicit
permission; that permission has now been granted** (Mark S. Miller,
[endojs/endo-but-for-bots#632](https://github.com/endojs/endo-but-for-bots/issues/632),
2026-07-08) on the sole condition that every adaptation keep making clear
it is *derived from* the original but *is not* the original — a condition
this design's fidelity contract already meets. See § Provenance,
attribution, and licensing.

## What is the problem being solved?

The dissertation is the intellectual foundation of this stack. It defines
defensive consistency, the object-capability paradigm as a reference-graph
discipline, communicating event loops, promise pipelining, broken-promise
contagion, the when-catch idiom, and emergent robustness through nested
POLA. Endo, SES, `@endo/eventual-send`, and OCapN are direct descendants.
Yet the founding document speaks E, a research language that is no longer
practical to run, and Pluribus, a protocol whose living descendant is
OCapN. A reader who wants the foundations must first learn a retired
language and mentally rename a protocol. The existing docs
(`docs/message-passing.md`, `docs/guide.md`) teach the mechanics but not
the argument; the thesis carries the argument but in a notation the
ecosystem no longer shares. Translating the examples closes that gap and
gives docs.endojs.org the canonical "why" document beside its "how"
documents.

## Source text

- Canonical: `erights.org/talks/thesis/markm-thesis.pdf` (erights.org is
  intermittently unreachable; the site is mirrored at erights.github.io).
- Reliable mirror the builder should use:
  <https://papers.agoric.com/assets/pdf/papers/robust-composition.pdf>
  (verified reachable 2026-07-07; PDF 1.2, 229 pages).
- Archival record: Johns Hopkins University JScholarship, handle
  `1774.2/873`.

The PDF's embedded text extracts with typographic ligatures (`ﬁ`, `ﬂ`)
and TeX-era spacing artifacts ("F ragile Composition"); the builder
normalizes these during extraction and proofreads against the rendered
page, not the raw extraction.

## Structure of the dissertation (translation inventory)

Chapter inventory from the PDF table of contents, with the translation
treatment each chapter needs. "Prose" means the chapter carries no E
code and translates by careful transcription plus link and terminology
notes; "code" marks the chapters where E examples must become Jessie;
"protocol" marks the chapters where Pluribus/CapTP material becomes
OCapN.

| Part | Chapters | Treatment |
|---|---|---|
| Front matter | Abstract, acknowledgements | Prose, verbatim |
| (Unparted) | 1 Introduction; 2 Approach and Contributions | Prose |
| I The Software Composition Problem | 3 Fragile Composition; 4 Programs as Plans; 5 Forms of Robustness; 6 A Taste of E; 7 A Taste of Pluribus | 3-5 prose; **6 code (keystone)**; **7 protocol (keystone)** |
| II Access Control | 8 Bounding Access Rights; 9 The Object-Capability Paradigm; 10 The Loader: Turning Code Into Behavior; 11 Confinement; 12 Summary of Access Control | 8 prose; 9 code (caretaker, membrane figure 9.3); 10 code (loader isolation maps to Compartment); 11 code; 12 prose |
| III Concurrency Control | 13 Interleaving Hazards; 14 Two Ways to Postpone Plans; 15 Protection from Misbehavior; 16 Promise Pipelining; 17 Partial Failure; 18 The When-Catch Expression; 19 Delivering Messages in E-ORDER | Code throughout (statusHolder listener examples, purchase-order example, promise kit, when-catch); 17 §17.3 and 19 also protocol |
| IV Emergent Robustness | 20 Composing Complex Systems; 21 The Fractal Nature of Authority; 22 Macro Patterns of Robustness | Prose (CapDesk, Polaris, DarpaBrowser history; petname material cross-references the daemon's pet-name system) |
| V Related Work | 23 From Objects to Actors and Back Again; 24 Related Languages; 25 Other Related Work; 26 Work Influenced by E; 27 Conclusions and Future Work | Prose; historical claims stay as 2006 claims, with dated translator's notes only where the 2026 reader would otherwise be misled |
| Back matter | Bibliography; Vita | Bibliography augmented with working links; Vita verbatim |

## Scope and phasing

Translate the full dissertation, but in phases so each PR is reviewable
and the highest-value chapters land first. Each phase is one builder job
and one PR; later phases depend on the conventions the earlier ones
establish but not on their prose.

1. **Phase 1, scaffolding and front matter.** The `docs/thesis/`
   directory, the landing page (provenance, translator's preface, reading
   map, table of contents), the translation-conventions page, the TypeDoc
   and routing wiring, and chapters 1 and 2 (prose-only, lowest risk).
   This phase proves the pipeline end to end and is specified fully in
   § Builder-ready plan for phase 1.
2. **Phase 2, the keystone chapters.** Chapter 6 ("A Taste of E",
   rendered as "A Taste of E, in Jessie") and chapter 7 ("A Taste of
   Pluribus", re-expressed over OCapN), plus chapters 3-5. This phase
   exercises every translation convention and should be panel-reviewed
   hardest; its patterns become precedent.
3. **Phase 3, Part II** (chapters 8-12): access control, caretaker and
   membrane examples, loader-to-Compartment mapping.
4. **Phase 4, Part III** (chapters 13-19): the concurrency chapters,
   densest in code; when-catch, promise pipelining, partial failure,
   E-ORDER.
5. **Phase 5, Parts IV and V plus back matter** (chapters 20-27,
   bibliography): mostly transcription with link repair.

If maintainer appetite turns out to be "key chapters only", the natural
stopping point is after phase 4: parts I-III are the load-bearing
argument, and the landing page's reading map already directs readers to
the PDF for untranslated parts. The landing page should link every
untranslated chapter to the PDF until its phase lands, so the site is
honest about coverage from phase 1 onward.

## E to Jessie approach

Target language: Jessie, the tiny ocap-safe subset of JavaScript
(`endojs/Jessie`), as it is written in this repository: `const`-only
bindings, arrow-function makers, `harden` on every exposed record, no
`this`, no classes. Code examples must be runnable Hardened JavaScript
(under `lockdown()` with the repository's conventions), not pseudocode,
except where a translator's note says otherwise.

The normative construct mapping:

| E construct (thesis usage) | Jessie / Hardened JavaScript translation | Notes |
|---|---|---|
| `def x := expr` | `const x = expr;` | |
| `def makeThing(a) { ... }` maker | `const makeThing = a => harden({ ... });` | The maker pattern survives intact; it is the house idiom. |
| Object expression with `to` methods (`def counter { to incr() { ... } }`) | Maker returning a hardened record of arrow-function methods, closing over state (`let count = 0;` in the maker body) | Methods become record properties; `to` verbs become property names. |
| Composites and facets (§6.2) | Several hardened records sharing one closure state; for defensive facets, `@endo/exo` with an interface guard | Show the plain-closure form first (it is the thesis's point), then note the exo form as the production idiom. |
| Eventual send `bob <- foo(carol)` | `E(bob).foo(carol)` with `E` from `@endo/far` | Jessie's proposed `~.` (tildot) syntax never standardized; the translation uses `E()` throughout and says so once in the conventions page. |
| When-catch expression (ch 18) | `E.when(p, result => ..., reason => ...)` | Closest semantic match: the handler runs in a later turn, and `E.when` evaluates to a promise for the handler's result, exactly the §18.1 semantics. A translator's note presents `async`/`await` as the reader's everyday idiom and states the difference (an `await` suspends mid-function; when-catch schedules a whole handler). |
| `def [p, r] := Ref.promise()` | `makePromiseKit()` from `@endo/promise-kit` | `{ promise, resolve, reject }`. |
| Reference states: near, eventual, broken (§7.1, §16) | Presences and (handled) promises of `@endo/eventual-send`; broken references become rejected promises | Broken-promise contagion (§16.5) maps to rejection propagation through `E()` chains. |
| Promise pipelining (ch 16) | `E(E(a).getB()).useC()` pipelining through handled promises; over the network, OCapN promise pipelining | Datalock (§16.3) discussion carries over unchanged. |
| Soft type checking, guards (`:G` patterns, §6.3) | `@endo/patterns` (`M` matchers) and `@endo/exo` interface guards | The thesis's "soft type checking" argument is the design rationale for patterns/guards; a translator's note makes that lineage explicit. |
| Sealer/unsealer pairs (rights amplification) | A WeakMap-based `makeSealerUnsealerPair` written inline in Jessie | No dedicated `@endo/*` package exports this today; the inline maker is a dozen lines and is itself a worked example. |
| The loader, loader isolation (ch 10) | `Compartment` with explicit endowments; module loading per `@endo/compartment-mapper` | The chapter's "turning code into behavior" is `new Compartment(...)` with chosen globals; loader isolation is compartment isolation. |
| Vat (ch 14) | Keep the term "vat" (it survives in modern usage); gloss as event loop plus heap plus pending-delivery queue, realized today as a worker or process hosting compartments under a shared event loop | Do not rename; add the modern gloss once. |
| Miranda methods, `__whenBroken`, other E-runtime specifics | No clean equivalent; keep the original E fragment in the flagged original-code block and explain in a translator's note | Fidelity over forced translation. |
| Quasi-literals | Template literals | Only where they appear incidentally. |

**Where no clean equivalent exists** (Miranda methods above; any E
auditing or `meta` construct encountered during extraction): translate
nothing. Present Miller's E code as the original, add a translator's
note stating that Hardened JavaScript has no direct analog and what the
nearest practice is. The conventions page carries this rule so later
builders do not invent mappings.

## CapTP to OCapN approach

The thesis names its protocol **Pluribus** (chapter 7); CapTP is the
E implementation's descendant of it, and OCapN is the live
standardization of CapTP (ocapn.org), implemented in this repository as
`@endo/ocapn` (CapTP message layer, Syrup and CBOR codecs, netlayer
abstraction, third-party handoffs). The translation strategy for
protocol material:

- **Name discipline.** First mention in each protocol chapter keeps
  Miller's term with the modern name beside it: "Pluribus (whose living
  descendant is OCapN)". After that, translated examples and diagrams
  use OCapN vocabulary; Miller's prose keeps Pluribus where it appears,
  since the prose is verbatim.
- **Concept mapping**, stated once on the conventions page and applied
  in notes throughout:

| Thesis concept | OCapN / Endo expression |
|---|---|
| VatID as public-key fingerprint (§7.3) | OCapN peer identity; session keys per the OCapN handshake (in this repository, `@endo/ocapn-noise`) |
| Swiss numbers, offline capabilities, SturdyRefs (§7.4, §17.3) | OCapN sturdyrefs (`ocapn` URIs carrying a swiss-num), `@endo/ocapn` client sturdy-reference support |
| Distributed pointer safety (§7.3) | The CapTP layer of OCapN: import/export tables, promise import/export, gc operations |
| Bootstrapping initial connectivity (§7.4) | Netlayers plus sturdyref enlivening; the netlayer abstraction of `@endo/ocapn` |
| No central points of failure (§7.5) | OCapN's peer-to-peer netlayer design; note that specific netlayers (relays) reintroduce operational centralization without protocol centralization |
| Introductions and rights transfer across vats | OCapN third-party handoffs (handoff-give and handoff-receive certificates) |
| E-ORDER (ch 19) | **Not settled in OCapN.** See below. |

- **E-ORDER honesty.** Chapter 19 argues for a delivery order stronger
  than fail-stop FIFO and weaker than CAUSAL. OCapN sessions deliver
  operations in order per session, but the cross-session and
  third-party-handoff ordering story is still under discussion in the
  OCapN standards group, and `@endo/ocapn`'s README describes itself as
  a testbed for building specification consensus. Chapter 19 therefore
  translates with a prominent translator's note: Miller's argument is
  presented as the normative case the protocol lineage aims to satisfy,
  not as a description of what OCapN guarantees today. The note should
  cite the current OCapN draft state at build time rather than this
  design.
- **Wire-format restraint.** The thesis does not specify Pluribus's wire
  format, so the translation does not teach Syrup or CBOR; protocol
  examples stay at the level of sessions, references, and handoffs, and
  point to `packages/ocapn/README.md` for the wire layer.

## Docs structure and site routing

docs.endojs.org is the TypeDoc site built by `yarn docs`
(`typedoc.json`, TypeDoc 0.28 with `typedoc-plugin-mermaid`), where
markdown pages enter through `projectDocuments` and render at
`/documents/<name>.html`; `scripts/posttypedoc.sh` copies static assets
into the output tree (`api-docs/`), and `.github/workflows/typedoc-gh-pages.yml`
deploys it. The thesis integrates with that pipeline rather than beside
it:

- **Files.** `docs/thesis/index.md` (landing page: provenance and
  permission statement, translator's preface, conventions summary,
  reading map, table of contents), `docs/thesis/conventions.md` (the
  normative translation conventions, the two mapping tables above, and
  the flagging mechanics), and one file per chapter,
  `docs/thesis/NN-<slug>.md` (`01-introduction.md` through
  `27-conclusions.md`, plus `00-front-matter.md` for abstract and
  acknowledgements).
- **TypeDoc wiring.** Register `docs/thesis/index.md` as one new entry
  in `typedoc.json` `projectDocuments`; the index declares the chapter
  files as child documents in its frontmatter, so the sidebar shows one
  "thesis" node that expands to chapters rather than 28 top-level
  entries. Frontmatter category: `Annex` (already last in the site's
  `categoryOrder`), keeping the research edition below Guides and
  Reference in the navigation.
- **The `/thesis/` route.** TypeDoc's router will emit the pages under
  `/documents/...`. To honor the `docs.endojs.org/thesis/` address,
  extend `scripts/posttypedoc.sh` to install a small static
  `api-docs/thesis/index.html` redirect to the landing page's generated
  URL. The builder verifies the generated URL by running `yarn docs`
  and inspecting `api-docs/documents/`, rather than trusting this
  design's guess at TypeDoc's slug of the moment. Literal per-chapter
  `/thesis/<n>` URLs would require rendering outside TypeDoc and are
  not proposed; the redirect gives the memorable entry point and
  TypeDoc keeps navigation, search, and theme.
- **Figures.** The dissertation's figures are redrawn as mermaid diagrams
  where they are graphs or sequences, which matches the site tooling and
  keeps the diagram layer repository-authored. The author approved this as
  an experiment and expects some figures may read better as the originals;
  because his grant now covers his own diagrams as well as his text
  (§ Provenance), reproducing Miller's original figure is a permitted
  fallback where a mermaid redraw disappoints — there is no separate figure
  copyright issue for his own diagrams. The dissertation's acknowledgements
  credit **Ka-Ping Yee** with four figures — Figures 14.2 (p. 107), 14.3
  (p. 108), 16.1 (p. 118), and 17.1 (p. 124), drawn "with input from the
  e-lang community" — while Figure 9.3 (the membrane) is Marc Stiegler's
  example, not Yee's. For the Yee figures the rule is **quality first, not
  permission-avoidance**: the mermaid redraw is still tried first, but where
  a redraw would be clearly worse the design does *not* settle for the
  degraded version to sidestep asking. The author has offered to grant
  permission for Yee's figures that appear in public texts he co-authored
  (his own IANAL caveat noted), and where any doubt remains the plan is to
  ask Ka-Ping Yee ("Ping") directly rather than iterate on something clearly
  worse
  ([endojs/endo-but-for-bots#631 review](https://github.com/endojs/endo-but-for-bots/pull/631#pullrequestreview-4650709899),
  2026-07-08). So a Yee figure is redrawn when the redraw is at least as
  good, and reproduced from the original — once permission is confirmed
  (the author's offered grant, or Ping's direct assent) — when it is not.
  Where a figure resists mermaid and reproduction is not yet cleared, the
  chapter describes it and links the PDF page as an interim measure, not a
  permanent downgrade.
- **CI.** Chapter PRs are docs-only and ride `ci-docs.yml` (Prettier
  plus a TypeDoc build), which exists precisely for this shape of
  change.
- **This fork versus docs.endojs.org.** The domain is served from
  upstream `endojs/endo`'s Pages deployment; this repository's own Pages
  shows the same pipeline's output for the fork. Landing the work here
  is the whole job; ferrying `docs/thesis/` upstream so it actually
  appears at docs.endojs.org is a later, maintainer-authorized boatman
  step and is called out in open questions.

## Fidelity versus modernization

The reader must always know which words are Miller's and which are the
translation layer's. The contract:

- **Verbatim (Miller's voice):** all prose, arguments, chapter and
  section structure, quotations, the abstract, acknowledgements,
  bibliography entries, and the 2006 perspective of Parts IV and V. No
  silent paraphrase, no silent reordering, no "improvements" to the
  argument. Typographic normalization (ligatures, hyphenation artifacts
  of PDF extraction) is not flagged.
- **Translated (the layer's voice), each instance flagged:**
  - Code blocks: every E example becomes a Jessie block introduced by a
    caption line such as `*Translated from E (p. 41); original below.*`,
    with the original E code preserved beneath in a collapsed
    `<details><summary>Original E</summary>` block. The original is
    never deleted; fidelity stays auditable on the page.
  - Inline code fragments in prose (an `a <- b()` in a sentence): the
    Jessie form in place, with the E original in the chapter's
    translator's-notes footnotes when the substitution is more than
    notation.
  - Protocol renamings: per § CapTP to OCapN approach.
  - Translator's notes: blockquotes opening with **Translator's note
    (2026):**, used for dead-link repair targets, "what this became"
    pointers into `packages/*`, and the no-clean-equivalent cases.
    Notes are additive; they never replace Miller's text.
- **Updated without preserving the original in place:** dead external
  links move to archive.org or successor URLs, with the original URL
  kept in the link title attribute. The bibliography gains DOI/URL
  links but keeps its entries verbatim.
- The landing page and `conventions.md` state this contract to the
  reader, so the flagging idioms are defined once and every chapter
  uses them identically.

## Provenance, attribution, and licensing

The dissertation's title page states, exactly:

> Copyright © 2006, Mark Samuel Miller. All rights reserved.
> Permission is hereby granted to make and distribute verbatim copies
> of this document without royalty or fee. Permission is granted to
> quote excerpts from this documented provided the original source is
> properly cited.

Consequences, now resolved by the author's grant of permission:

- The title-page grant covers **verbatim copies** and **cited
  excerpts**. A modernized translation that substitutes code examples
  and protocol vocabulary is a **derivative work**, which that
  title-page grant does not cover. **This has since been resolved by an
  explicit, wider grant from the author:** Mark S. Miller granted the
  Endo project (`@kriscendobot`) standing permission to reuse and
  adapt/derive-from any of his public texts — his thesis among them — on
  the sole condition that any adaptation **continue to make clear that
  it is *derived from* the original but *is not* the original**
  ([endojs/endo-but-for-bots#632](https://github.com/endojs/endo-but-for-bots/issues/632),
  2026-07-08). The author subsequently extended that grant to **diagrams**
  as well as text — all diagrams appearing in his public texts that are
  **not otherwise attributed** — clarifying that there is no separate
  figure copyright issue for his own figures
  ([endojs/endo-but-for-bots#631 review](https://github.com/endojs/endo-but-for-bots/pull/631#pullrequestreview-4650647188),
  2026-07-08). The fidelity contract, the flagging mechanics, and the
  attribution page below already satisfy that condition, so the
  publication gate this design named is met; a phase PR no longer waits
  on the permission question, only on the remaining open questions. If a
  future case makes even the *derived-from* framing awkward, the design
  asks the author rather than assuming a wider grant.
- Attribution: the landing page carries the full citation (Miller,
  *Robust Composition: Towards a Unified Approach to Access Control and
  Concurrency Control*, PhD dissertation, Johns Hopkins University,
  Baltimore, Maryland, May 2006), the copyright and grant text verbatim,
  a link to the canonical PDF, and a statement of what this edition
  changes and who maintains the translation layer. Each chapter footer
  repeats a one-line citation and links the landing page.
- The translation layer's own text (translator's notes, conventions
  page, redrawn diagrams, Jessie code) is repository-authored content
  under the repository's Apache-2.0 license, stated as such on the
  landing page so the two copyright regimes are legible.
- The acknowledgements note the dissertation borrows from co-authored
  papers; permission from Miller covers his dissertation text and his own
  diagrams (the grant above), and the translation introduces no additional
  third-party text. Ka-Ping Yee's four contributed figures (14.2, 14.3,
  16.1, 17.1) are *otherwise attributed* and so fall outside Miller's own
  diagram grant, but they are **not** therefore forced to a lower-quality
  redraw. Reviewing this design, the author held that reducing figure
  quality out of reluctance to seek permission is the wrong trade: he
  believes he can grant permission for Yee's figures appearing in public
  texts he co-authored (IANAL), and where any doubt remains the resolution
  is to ask Ka-Ping Yee directly rather than accept a clearly-worse redraw
  ([endojs/endo-but-for-bots#631 review](https://github.com/endojs/endo-but-for-bots/pull/631#pullrequestreview-4650709899),
  2026-07-08). The handling therefore mirrors § Docs structure, Figures:
  redraw first, reproduce the original under confirmed permission where the
  redraw is clearly worse, and describe-with-PDF-link only as an interim
  measure until permission is settled.

## Builder-ready plan for phase 1

One builder job, one PR. Base branch: `master` (docs-only; `docs/`
exists on both `master` and `llm`, and the job directing this design
names `master` as the implementation base). Branch `thesis-translation`,
frozen-base snapshot per `skills/frozen-base-branch` convention.

Deliverables:

1. `docs/thesis/index.md`: landing page per § Provenance (citation,
   grant text, permission-status line, translator's preface, reading
   map with per-chapter status linking untranslated chapters to the
   PDF).
2. `docs/thesis/conventions.md`: the fidelity contract, both normative
   mapping tables (copied from this design, which remains the source of
   record until the docs page lands, after which the docs page is),
   and the flagging idioms with one worked example (a §6.1 counter
   translated both ways).
3. `docs/thesis/00-front-matter.md`: abstract and acknowledgements,
   verbatim.
4. `docs/thesis/01-introduction.md` and `docs/thesis/02-approach.md`:
   chapters 1 and 2, verbatim prose with translator's-note link repair
   only.
5. `typedoc.json`: add the `docs/thesis/index.md` project document with
   child chapters; category `Annex`.
6. `scripts/posttypedoc.sh`: install the `/thesis/` redirect stub into
   `api-docs/`.
7. Verification: `yarn docs` builds clean; the thesis node appears in
   the sidebar with children; `api-docs/thesis/index.html` redirects to
   the generated landing page; Prettier passes (`ci-docs.yml` is the CI
   surface).

The phase-1 PR ships as **draft**. The author-permission open question
that formerly held it draft is now resolved (§ Provenance; #632); it
stays draft only until the remaining open questions (ferry intent, URL
shape, category) are settled and the docs build is verified.

Later phases (2 through 5) are separate builder jobs following the same
shape: extract the phase's chapters from the PDF, normalize, translate
per the conventions page, add chapters to the index frontmatter and
reading map, keep each PR under roughly five chapters so panel review
stays tractable.

## Dependencies

| Design / artifact | Relationship |
|---|---|
| `docs/message-passing.md` | Sibling document; the thesis is the argument behind its mechanics. Cross-link both ways (it already cites the thesis URL). |
| `packages/ocapn` (README and docs) | Ground truth for OCapN terminology in chapters 7, 17, 19; the translation cites it rather than restating wire detail. |
| `packages/eventual-send`, `packages/exo`, `packages/patterns`, `packages/promise-kit` | The construct-mapping targets; chapter notes point into their READMEs. |
| `endojs/Jessie` | Normative definition of the Jessie subset the examples are written in. |

No blocking dependency on any in-flight design.

## Design decisions

1. **Full translation, phased, rather than key-chapters-only.** The
   dissertation is one argument; parts IV and V are cheap (prose) once
   the conventions exist. The phase plan still yields a useful artifact
   if stopped after phase 4.
2. **Verbatim prose plus flagged code substitution**, rather than a free
   modernization or a summary. Anything looser forfeits both the
   scholarly value and the plausible permission story.
3. **Original E preserved in collapsed blocks** beside every translated
   example. The translation must be auditable without the PDF.
4. **`E()` rather than tildot** for eventual send, matching the code the
   reader will actually write with `@endo/far`.
5. **`E.when` as the primary when-catch translation**, with async/await
   presented in notes: it preserves the thesis's turn semantics and its
   "evaluates to a promise for the handler's result" point.
6. **OCapN honesty over neatness**: chapter 19 (E-ORDER) is labeled as
   normative ancestry, not current OCapN guarantee.
7. **TypeDoc-native integration with a `/thesis/` redirect**, rather
   than a parallel static site: keeps navigation, search, theme, and the
   existing docs CI; the redirect honors the requested address.
8. **Mermaid redraws as the first figure experiment**, tool-native and
   repository-authored, with reproducing Miller's original figures as an
   author-permitted fallback where the redraw disappoints (§ Docs
   structure, Figures). Ka-Ping Yee's four figures (14.2, 14.3, 16.1,
   17.1) get the same quality-first treatment: redraw first, and where a
   redraw would be clearly worse, seek permission (the author's offered
   grant, or ask Ka-Ping Yee directly) and reproduce rather than ship a
   degraded figure. Considered and rejected: redrawing-or-describing Yee's
   figures unconditionally to sidestep asking — the author explicitly
   rejected trading quality to avoid seeking permission.
9. **Publication gated on recorded author permission.** Considered and
   rejected: relying on the verbatim-copy grant. Reason: a translation
   is not a verbatim copy.

## Open questions

1. **Author permission (publication gate). — RESOLVED.** Mark S. Miller
   (erights) granted the Endo project standing permission to reuse and
   adapt/derive-from any of his public texts, his thesis among them, on
   the sole condition that every adaptation keep making clear it is
   *derived from* the original but *is not* the original
   ([endojs/endo-but-for-bots#632](https://github.com/endojs/endo-but-for-bots/issues/632),
   2026-07-08). The fidelity contract above already satisfies that
   condition, so this gate is met and no longer holds a phase PR draft.
   Record kept in § Provenance, attribution, and licensing.
2. **Upstream ferry.** docs.endojs.org serves upstream `endojs/endo`;
   when phases land on this fork, does the maintainer intend to ferry
   `docs/thesis/` upstream (boatman, separately authorized), or should
   the edition live on the fork's Pages first while the OCapN and Jessie
   surfaces stabilize?
3. **URL shape.** Is the `/thesis/` redirect into TypeDoc's
   `/documents/...` URLs acceptable, or does the maintainer want literal
   `/thesis/<chapter>` URLs badly enough to render the thesis as a
   static subtree outside TypeDoc (more tooling, less navigation
   integration)?
4. **Navigation category.** Is `Annex` the right sidebar category, or
   should the site grow a `Foundations` category (a one-line
   `categoryOrder` change) so the thesis does not sit beside unrelated
   annex material?
5. **Chapter 19 versus the OCapN standards group.** Should the E-ORDER
   translator's note solicit OCapN-group review (erights sits in both
   worlds), making the chapter a live input to the ordering discussion
   rather than only a historical argument?
6. **Title of the edition.** "Robust Composition, Hardened JavaScript
   edition" versus "…, annotated translation" versus Miller's plain
   title with a subtitle on the landing page only. Cosmetic, but it is
   the first line readers and search engines see.
7. **Ka-Ping Yee figure permission. — SCOPED, DEFERRED TO PHASE 4.** The
   design now answers the author's "which diagrams?" question: the Yee
   figures are Figures 14.2, 14.3, 16.1, and 17.1 (named in the thesis
   acknowledgements). The author has offered to grant permission for Yee
   figures in
   texts he co-authored and, failing that, to ask Ka-Ping Yee directly
   ([review 4650709899](https://github.com/endojs/endo-but-for-bots/pull/631#pullrequestreview-4650709899)).
   Confirmation is only needed for the specific figures where a mermaid
   redraw proves clearly worse, and all four live in the concurrency
   chapters (14, 16, 17), which land in phase 4 — so this does not block
   phase 1. The phase-4 builder either confirms the redraw is adequate or
   requests permission (the author's grant, or Ping's assent) before
   reproducing the original.

## Prompt

> Design a translation of Mark Miller's PhD thesis "Robust Composition:
> Towards a Unified Approach to Access Control and Concurrency Control"
> (2006) for publication at docs.endojs.org/thesis/.
>
> Venue and mechanism: the translation ships as documentation in Endo's
> `docs/` directory, published at docs.endojs.org/thesis/. Propose it as
> a PR on the `endojs/endo-but-for-bots` fork, based on `master`. No
> upstream `endojs/endo` interaction beyond the fork.
>
> The defining move: modernize the thesis into today's Hardened
> JavaScript / Endo world. Swap the E language for the Jessie subset of
> Hardened JavaScript: translate E code examples and E-specific
> constructs (eventual sends, when-catch, makers, facets,
> sealer/unsealer pairs, ...) into Jessie / Hardened JavaScript idioms.
> Swap CapTP for OCapN: the thesis's distributed-object protocol and
> rights-transfer discussion re-expresses in OCapN terms.
>
> The design should specify (self-contained enough for a builder to
> implement): scope and phasing with a chapter/section mapping and a
> phased plan; the E-to-Jessie approach, including how to translate
> faithfully and flag constructs with no clean equivalent; the
> CapTP-to-OCapN approach; docs structure and site routing respecting
> Endo's existing docs tooling and navigation; fidelity versus
> modernization, and how each substitution is visibly flagged; how
> attribution and permission are handled, flagged as a maintainer/author
> decision without assuming a license; and a builder-ready
> implementation plan with the first-phase deliverable.
>
> Deliverable: a DESIGN document (a plan), not the translation itself.
> Surface open questions for the maintainer rather than guessing.
