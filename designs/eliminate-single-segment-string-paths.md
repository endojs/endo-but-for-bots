# Eliminate single-segment string paths

| | |
|---|---|
| **Created** | 2026-09-04 |
| **Updated** | 2026-09-04 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Source** | PR [#897](https://github.com/endojs/endo-but-for-bots/pull/897) inline review comment [3916282675](https://github.com/endojs/endo-but-for-bots/pull/897#discussion_r3916282675) on `packages/daemon/src/help.md` (the `glob`/`glorp` section), with the sibling `entry()` thread [3916247285](https://github.com/endojs/endo-but-for-bots/pull/897#discussion_r3916247285) / [3931325779](https://github.com/endojs/endo-but-for-bots/pull/897#discussion_r3931325779) |

## What Is the Problem Being Solved?

The daemon exposes two distinct name surfaces, each with its own guard code and
its own path type:

- The **petname registry** (`EndoHost` / `EndoGuest` / `EndoDirectory`), whose
  canonical path is an array of names.
- The **EndoMount filesystem API** (`EndoMount` / `EndoMountEntry`), whose
  canonical path is an array of segments.

On both surfaces a path is conceptually an **array of segments** (for example
`["src", "foo.js"]`), and on both surfaces a **bare string** is also accepted as a
path, treated as a **single, literal segment**. The maintainer's
review on PR #897 asks us to reconsider that convenience:

> It may be noted that the "glob" expression for glob, glorp is an explicit
> aberration on the array-of-segments petname path notation we use elsewhere,
> where a single string is in the UNIX glob DSL. However, a path should always be
> represented as petname path segments and a single string is always a single
> segment. This will need to be called out in help text very clearly, since it is
> not the norm. It may behoove us to completely eliminate support for single
> segment pet name paths in order to ensure that a slash delimited string produces
> an error. Please post a follow-up design to that effect.

**The review's literal ask is already satisfied today, so it is worth stating up
front what actually remains.** A slash-delimited string like `readText("src/foo.js")`
*already* produces an error (see [Current Behavior](#current-behavior)), because a
slash is an illegal character in a segment. What remains is narrower and has two
parts:

1. The **non-slash single string** (`readText("foo")`, `lookup("foo")`) still
   silently coerces to `["foo"]`. That keeps two spellings of one path alive.
2. The **type** still carries a bare-`M.string()` arm, so the surface advertises
   "a string is a path here" even though a string is not a path anywhere the
   review wants one to be treated as a path.

The residual tension is that **two different arguments are string-shaped but mean
opposite things**:

- To a path-taking method (`readText`, `lookup`, `remove`, and the like), a
  string is a *literal one-segment path*: `readText("foo")` reads the file named
  `foo`.
- To `glob` / `grep` / `glorp`, a string is a *pattern in a different DSL*: a
  slash-separated UNIX glob (`glob("src/**/*.js")`) or an ECMAScript RegExp source
  (`grep("^export")`). There the slashes are structural and `*` / `**` are
  metacharacters.

This design proposes making **array-of-segments the sole path spelling** at every
path-*method* boundary, so that every bare-string argument to a path-taking method
is rejected with one clear message. It does **not** claim that this leaves patterns
as the only remaining string-shaped values in the surface: the search family also
*returns* and *consumes* slash-joined path strings, and those need an explicit,
sanctioned seam rather than a silent survival (see
[The Search Family](#the-search-family-glob--grep--glorp)).

### The Value-Identity Consequence

Beyond ergonomics, `"foo"` and `["foo"]` are two spellings of **one value**. As
long as both spellings are legal, a path cannot be compared, keyed, memoized, or
logged canonically without first normalizing it, and any code that skips the
normalization step has a latent bug. This is stated as a **preventive,
value-representation argument**, not a catalogued defect: the design does not
claim a specific site that keys or memoizes an un-normalized path today (no such
instance was found by grep), so the argument is that the current shape *permits*
that bug class rather than that it has already been hit. Even as a hygiene
concern, reducing a path to a single representation is a value-representation fix,
not only a teachability fix, and it is the change's most durable justification
alongside the legibility one.

## Current Behavior

Two "path" concepts coexist and must be kept distinct.

| World | Canonical path | Bare-string handling | Slash-string handling today |
|---|---|---|---|
| **Petname registry** (`EndoHost` / `EndoGuest` / `EndoDirectory` name hub) | array of names | coerced to a one-element array | **already errors**: `/` is illegal in a name |
| **EndoMount filesystem API** (`EndoMount` / `EndoMountEntry`) | array of segments | coerced to a one-element segment array (never split) | **already errors**: `/` is illegal in a segment |

### The Surface That Accepts String Paths

**EndoMount path API.** Every path-bearing method accepts
`string | string[] | EndoMountEntry`. The runtime guard is defined once as
`PathArgShape = M.or(M.string(), PathSegmentsShape, MountEntryShape)`
(`packages/daemon/src/interfaces.js:693-695`, where
`PathSegmentsShape = M.arrayOf(M.string())` and
`MountEntryShape = M.remotable('EndoMountEntry')`) and applied to `lookup`,
`maybeLookup`, `subView`, `write`, `copy`, `stat`, `readText`, `maybeReadText`,
`writeText`, `makeDirectory`, `makeFile`, `remove`, and `move`
(`interfaces.js:716-800`). The TypeScript face mirrors this as
`string | readonly string[] | EndoMountEntry` (`packages/daemon/src/types.d.ts:1342-1428`).
Three methods instead take **variadic segments** and never a single joined string:
`has(...segments)`, `list(...segments)`, `followNameChanges(...segments)`.

**Petname registry API.** `lookup`, `identify`, `locate`, `storeIdentifier`,
`storeLocator`, `remove`, `move`, `copy`, `readText`, `writeText`, `cancel`,
`storeValue`, `sendValue`, and the variadic `...petNamePath` forms all accept a
name or a name path. The shape family lives in `packages/daemon/src/type-guards.js:21-34`:
`NameShape = M.string()`, `NamePathShape = M.arrayOf(NameShape)`,
`NameOrPathShape = M.or(NameShape, NamePathShape)`, and
`NamesOrPathsShape = M.arrayOf(NameOrPathShape)`. Its accurate method inventory
matters for [Registry Symmetry](#open-questions) and is given there.

### The Coercion Sites

A bare string is turned into a one-element array in **at least eleven**
*production* places, not three as an earlier draft claimed. The grep that
produces this count is `rg "typeof .* === 'string' \? \[.*\] : "` across
`packages/`, plus the one literal-wrap site in `segmentsFromPathArg`. That raw
grep returns **sixteen** hits; the filter applied to reach eleven is
"non-test": four of the sixteen are **test-harness coercion helpers**
(`packages/workflow/test/fake-agent.js:22`,
`packages/platform/test/from-mount.test.js:81`, and
`packages/daemon/test/mount-platform-fs-conformance.test.js:366,385`), and one
is the `agentry` code-mode variant listed as item 11 below. The four test
helpers are **not** production coercion sites, so they are excluded from this
catalog; they are not free, however. `mount-platform-fs-conformance.test.js:366`
builds `segments = typeof pathArg === 'string' ? [pathArg] : pathArg`
specifically to assert the string and array forms against one expected result,
so it (and its siblings) must be **rewritten** to assert the string form now
*errors*. They are accounted for under
[Test impact](#migration-and-backward-compatibility), not dropped:

1. `packages/daemon/src/mount.js:638` (`segmentsFromPathArg`), the literal-wrap
   form `normalizeSegments(currentSegments, [pathArg], deniedSegments)`. Every
   path-bearing mount method funnels through it, directly or via `resolvePathArg`
   (`mount.js:705-706`).
2. `packages/daemon/src/mount.js:1397`, the readable-tree wrapper's
   `typeof petNamePath === 'string' ? [petNamePath] : petNamePath`.
3. `packages/daemon/src/pet-name.js:149` (`namePathFrom`),
   `typeof nameOrPath === 'string' ? [nameOrPath] : nameOrPath`.
4. `packages/platform/src/fs/extended/shared/helpers.js:84` (`toSegments`).
5. `packages/platform/src/fs/snapshot-tree.js:105`.
6. `packages/platform/src/fs-node/local-tree.js:88` and `:147` (two sites).
7. `packages/endo-fs-exec/src/tree-view.js:36`.
8. `packages/exo-unzip/src/unzip.js:191` and `:241` (two sites).
9. `packages/space-chat/src/inventory/tree-source.js:180`.
10. `packages/space-chat/src/inventory/inventory.js:620`.
11. `packages/agentry/src/code-mode-provision-policy.js:267`, a variant
    (`typeof value === 'string' ? [value] : requireStringArray(value, label)`).

Several of these (items 4 through 8) are ReadableTree-shaped surfaces a caller
meets *beside* the mount, so a partial migration would make a bare string a path
in one place and an error in the next. Any implementation must migrate the whole
set together or state explicitly which surfaces keep the coercion and why. This is
a **larger** edit than a one-file change, though still bounded and greppable.

Separately from the coercion sites, there is exactly **one** slash-*splitter*:
`segmentsFromEntryPathArg` (`mount.js:649-661`), the body of `entry()`, which does
`normalizeSegments(currentSegments, pathArg.split('/'), deniedSegments)`. It is a
splitter into many segments, not a one-element coercion, and is discussed under
[Interaction With `entry()`](#interaction-with-entry-and-endomountentry).

### What Already Errors, and What Silently Works

Segment validity is enforced *below* the coercion. Mount segments run through
`assertValidSegment` (`mount.js:248-263`), which rejects any segment containing
`/`, `\`, or a NUL byte. The rendered message a user actually sees (the source
writes the backslashes escaped) is:

```
Path segment must not contain '/', '\', or '\0' (a string is one segment; pass ["dir", "file.txt"] or entry("dir/file.txt") for nested paths): "src/foo.js"
```

Registry names run through `isValidName` (`pet-name.js:15-23`), which rejects any
name containing `/`, a NUL byte, or `@`, or equal to `.` or `..`.

So the *slash* mistake the review names is **already an error today**:
`readText("src/foo.js")` reaches `segmentsFromPathArg`, becomes `["src/foo.js"]`,
and `assertValidSegment` throws; `lookup` even re-throws with a friendlier hint
(`mount.js:900-906`). The help header already documents this (`help.md:728-733`).

What is *not* yet an error is the **non-slash single string**: `readText("foo")`,
`lookup("foo")`, and `remove("foo")` all silently coerce to `["foo"]`. That residue
keeps two spellings of a one-segment path in the surface. This design removes the
**coercion** (the silent treatment of a bare string as a one-segment path) at
every path-method boundary. It deliberately does **not** remove the runtime guard's
`M.string()` arm: as [The Proposed Rule](#the-proposed-rule-paths-are-always-arrays-of-segments)
explains, that arm is retained as a *routing affordance* so the method body can throw
a legible directive rather than an unreadable union pattern dump. What *is* narrowed
to array-only is the **declared** path type (the hand-authored `types.d.ts` union and
the generated code-mode declarations), so the surface no longer *advertises* "a string
is a path here" even though the runtime guard still structurally admits a string in
order to reject it with a good message. The guard shape and the declared type
therefore diverge on purpose; where that divergence is compensated for each consumer
is spelled out under
[The Declared Type Versus the Guard Shape](#the-declared-type-versus-the-guard-shape).

## The Search Family (`glob` / `grep` / `glorp`)

`glob`, `grep`, and `glorp` take a single string that is **never a path
argument**:

- `glob(pattern)`: `pattern` is a slash-separated **glob** whose only
  metacharacters are `*` and `**` (`mount.js:809`, `help.md:773-786`). The DSL is
  parsed by splitting on `/` in the platform engine
  (`packages/platform/src/fs/search.js:196`).
- `grep(pattern, paths?, options?)`: `pattern` is an **ECMAScript RegExp source**,
  evaluated as `new RegExp(pattern)` (`mount.js:849`, `help.md:788-801`).
- `glorp(glob, grep, options?)`: a **glob string** and a **RegExp string** fused
  (`mount.js:886`, `help.md:803-813`).

**These string *patterns* are not the only string paths left in the surface,
however, and the earlier claim that they were is false.** The search family also
carries path *strings*, in two places:

- `glob` **returns** a hardened `string[]` of slash-joined, mount-relative path
  strings (`mount.js:809-828`, joined at `packages/platform/src/fs/search.js:294`
  and `:314`).
- `grep(pattern, paths?)` **consumes** that same `readonly string[]` of
  slash-joined paths (`mount.js:846-856`, guarded as `M.arrayOf(M.string())` at
  `interfaces.js:737-742`), and the engine slash-splits each one back into
  segments (`packages/platform/src/fs/search.js:481`).

So after this change, paths are arrays inbound to path methods but strings
outbound from `glob` and inbound to `grep`. A caller who does
`readText(globResult[0])` today would, under a naive change, be handed a string
that a path method then rejects, and the common round trip breaks.

**The sanctioned seam.** A glob result and a grep `paths` entry are **display path
strings** in the search / pattern domain, explicitly *not* petname-path arguments.
To bring a search result back into a path method, a caller passes it through the
one canonical string-to-segments adapter this design introduces,
`pathFromSlashString(s: string): string[]` (a pure value function that splits a
slash-joined string into a segment array, defined fully under
[The Proposed Rule](#the-proposed-rule-paths-are-always-arrays-of-segments)):

```
readText(pathFromSlashString(globResult[0]))
```

The help text for `glob` / `grep` / `glorp` must state this seam explicitly, so
the round trip is a documented one-liner rather than a hand-rolled `.split('/')` at
every call site. Whether the search family should instead **return and consume
segment arrays** (`glob(): string[][]`, `grep(pattern, paths?: readonly string[][])`),
making the array-only invariant total at the cost of a larger change and a less
display-friendly result, is left as an [open question](#open-questions); this
design does not change the search argument or result shapes and picks the adapter
seam as the interim answer.

The glob *pattern* argument itself stays a string: a glob is inherently a string
DSL, and forcing it into a segment array would be a category error, since segments
cannot carry `*` / `**` across levels. The design makes the *contrast* legible in
help text: path methods take arrays, patterns are strings, search results are
display strings that re-enter path methods only through the named adapter.

## The Proposed Rule: Paths Are Always Arrays of Segments

**A path argument to any path-taking method is always an array of petname
segments. A bare-string path argument is rejected with a single, human-legible
directive message.** One named free function performs the string-to-segments
translation for the callers (CLI, Git, and the like) that genuinely start from a
slash string.

Concretely:

1. **A single normative rejection site: the method body.** The naive move, dropping
   the bare-`M.string()` arm from the guard so
   `PathArgShape = M.or(PathSegmentsShape, MountEntryShape)`, does **not** produce a
   good error. Run against the two-arm union, a bare string yields a serialized
   pattern dump, not a readable message (see [The Exact Error](#the-exact-error)),
   and because the guard rejects *before* the method body runs, any directive
   message drafted in the body would be dead code. So the guard **keeps** an
   `M.string()` arm purely as a routing affordance, and the **method body** is the
   single normative rejection site: it throws the directive message for any string.
   Array and `EndoMountEntry` inputs are validated by the guard exactly as today.
   This is one rule at one enforcement point, tested at that point. To keep that
   "one enforcement point" literal across the twelve-plus path-bearing methods
   rather than twelve hand-copied throws that can drift, the rejection lives in a
   **single shared assertion**, `assertPathIsSegments(arg)`, that every method body
   (or the shared `segmentsFromPathArg` funnel they already route through) calls, so
   the directive message and its wording live in exactly one place. This is the same
   centralize-one-policy-in-one-named-function move the design applies to the
   translation direction with `pathFromSlashString` (see
   [Reconciling the Three Splitters](#reconciling-the-three-splitters)), applied
   symmetrically to the reject direction.
2. **The mount-side coercion sites delete their string branch.** `segmentsFromPathArg`
   (`mount.js:638`) stops wrapping a string as `[pathArg]` and throws the directive;
   the readable-tree wrapper (`mount.js:1397`) and the platform-fs / exo-unzip /
   space-chat sites enumerated above drop theirs. Because the mount methods now reject
   strings in the body, the `segmentsFromPathArg` throw *is* that body throw for the
   mount surface; the other sites become defense in depth behind their own boundaries.
   The registry-side coercion, `namePathFrom` (`pet-name.js:149`) dropping its
   ternary, is **not** committed here: whether the petname registry migrates in
   lockstep with the mount is
   [open question 4 (Registry Symmetry)](#open-questions), and this step touches
   `namePathFrom` **only if OQ4 resolves the registry into scope**. Scoping item 2
   to the mount keeps that decision genuinely open rather than pre-empting it.
3. **Variadic-segment methods are unaffected, and here is why.** `has("dir", "file")`,
   `list("subdir")`, and the `...petNamePath` registry forms already take one
   *segment* per argument, not a joined path. A single variadic argument like
   `list("subdir")` has only **one** legal spelling, so it carries no
   string-versus-array ambiguity to remove; that is the actual argument for exempting
   them, not merely that "one segment is one element." (The resulting spelling
   incoherence against the array-taking methods is real and is raised as an
   [open question](#open-questions).)

The one canonical translation function is `pathFromSlashString(s: string): string[]`,
a **pure value function** with no mount, no lineage, and no capability: it splits a
slash-joined human string into a segment array. It is the sole sanctioned
string-to-path seam, it is what the search-result round trip uses, and it replaces
the three divergent private splitters catalogued below.

### Reconciling the Three Splitters

The string-to-segments *policy* is today triplicated with three different
semantics:

- `packages/cli/src/pet-name.js:13` (`parsePetNamePath`) splits on `/` and
  **throws** on an empty segment.
- `packages/daemon/src/mount.js:657` (`segmentsFromEntryPathArg`) splits on `/` and
  delegates empty-segment rejection to `assertValidSegment` (so an empty segment
  also **errors**).
- `packages/exo-git/src/git.js:484` splits on `/` and **drops** both empty segments
  and `'.'` via `.filter(segment => segment !== '' && segment !== '.')`.

The canonical `pathFromSlashString` should adopt the error-on-empty policy (matching
the two mount/CLI boundaries), and Git's `'.'`-and-empty dropping should be
expressed as a Git-specific normalization layered *on top* of the shared splitter,
not as a fourth private split. If a boundary genuinely needs different empty-segment
discipline, the design must say so rather than leave three copies drifting.

### The Exact Error

The guard keeps its `M.string()` arm, so a bare string reaches the method body,
where the single normative rejection throws a `TypeError`-class error with this
directive message:

```
Path must be an array of segments; a string is not a path. Pass ["src", "foo.js"] (a slash-joined string like "src/foo.js" is never split). For pattern search use glob()/grep()/glorp(), whose string argument is a glob or RegExp, not a path. To translate a slash string, call pathFromSlashString("src/foo.js").
```

This single message does triple duty: it rejects the *slash* string
(`"src/foo.js"`) and the *non-slash* string (`"foo"`) alike, it points a confused
glob user back to the pattern methods, and it names the sanctioned translation.

The reason the design does **not** enforce the rule at the guard by dropping the
string arm is that the guard-only message is unusable. Executed against the
proposed two-arm `M.or(PathSegmentsShape, MountEntryShape)`, a bare string produces
a serialized pattern dump of the form
`arg 0: "src/foo.js" - Must match one of "[...arrayOf(string)..., ...remotable...]"`,
not the friendly `Must be a copyArray` an earlier draft quoted (that message is what
a *single* `M.arrayOf(M.string())` arm gives; the union does not give it). A pattern
dump is worse for a human and worse for a code-mode model. The body throw is both
readable and testable, which is why it is the normative site.

### The Declared Type Versus the Guard Shape

Retaining the guard's `M.string()` arm for routing (above) creates a deliberate
divergence: the guard's **declared shape** structurally admits a string, but the
**value set the method actually honors** is array-or-`EndoMountEntry` only. A string
is always thrown back. A design that widens a declared shape past what it accepts must
say where that gap is compensated for **every** consumer of the guard, or the "string
is never a path" invariant leaks back in through the type surfaces the very audience
this design serves reads. The three consumers and their treatment:

- **Hand-authored TypeScript (`types.d.ts:1342-1428`).** Narrowed to
  `readonly string[] | EndoMountEntry`, dropping the `string` arm. This is the
  edit that closes the second residual defect named in
  [What Is the Problem Being Solved?](#what-is-the-problem-being-solved) item 2: a
  typed caller now gets a compile-time signal that a bare string is not a path,
  rather than a type that silently permits a value the runtime always rejects. It is
  narrowed independently of the guard because it is hand-maintained, not generated.
- **Generated code-mode declarations (`fs-declarations.js`).** These are produced by a
  generator, so narrowing them cannot rely on narrowing the guard (the guard keeps its
  string arm). The generator input or a post-generation step must emit the array-only
  shape directly, so the model-facing declarations read `readonly string[] |
  MountEndoMountEntry` with no `string` arm; see
  [Help-Text Requirements](#help-text-requirements) item 5, which is worded to match.
- **CapTP / `M.interface()` introspection.** This reflects the live guard, so it will
  continue to show the `M.string()` arm: a consumer introspecting the interface sees
  a shape that accepts a string the method then rejects. This design accepts that
  residual as the cost of the readable-error mechanism. **The exposed consumer is
  not only human**: in this bots-first repo an LLM that introspects the *live*
  interface (rather than the separately-narrowed generated declarations) sees a
  shape advertising string-as-valid with no structural signal it will be rejected
  until it tries, so the gap is a real automated-consumer hazard, not a cosmetic
  one, and OQ7 below weighs it as such. The cleaner alternative,
  a guard-level combinator that keeps the declared shape array-only *and* intercepts
  the `M.or` rejection to substitute the directive message, collapsing the divergence
  entirely, is recorded as [open question 7](#open-questions); it is preferable in
  principle but out of scope for this design's recommended (B).

The net rule: the runtime guard is wide-and-rejecting for the sake of a good error;
every *declared* surface a human or model reads is narrow (array-only); the one place
the two cannot be reconciled without a new combinator (CapTP introspection) is named
and deferred, not left implicit.

### The Escape-Hatch Evaluation

The review offers "completely eliminate" as the strong option; this design weighs
three shapes:

- **(A) Hard array-only, no escape hatch.** Every string is rejected everywhere;
  the only way to spell a one-segment path is `["foo"]`, and callers that start from
  a slash string hand-roll `.split('/')`. Maximally consistent, but it scatters the
  same splitting logic the design is trying to centralize.
- **(B) Array-only methods plus one named string-to-path adapter.** Path methods are
  array-only; a single pure free function, `pathFromSlashString`, performs the
  string-to-segments translation for the CLI, Git, and search-result round trips.
  **This design recommends (B).**
- **(C) Keep the coercion, sharpen the help text only.** Do not break anything;
  document the glob exception loudly and leave `readText("foo")` coercing. The bug
  class this forgoes preventing is the value-identity class named above (two
  spellings of one path, so paths are not canonically comparable), plus the standing
  string/DSL ambiguity in the type. Option (C) spends no migration cost but keeps
  both defects, so the design rejects it while recording that the review's *literal*
  ask (slash strings error) is already met, so (C) is not "do nothing," it is "do
  nothing more."

Recommendation (B) delivers the review's core invariant (a raw string is never a
path at a method boundary) while keeping the string-to-segments translation in one
greppable, capability-free place. Critically, **the adapter is the free function
`pathFromSlashString`, not `entry()`**: `entry()` becomes array-only (see the next
section), so the recommendation is realizable from its own decision list without
contradiction. The remaining fork, whether to keep `pathFromSlashString` as a free
function or fold it back into a string-accepting `entry()`, is an
[open question](#open-questions); the recommended answer is the free function,
because folding it into `entry()` would re-complect a pure value translation with
capability minting (see [Interaction With `entry()`](#interaction-with-entry-and-endomountentry)).

## Interaction With `entry()` and `EndoMountEntry`

*(The PR #897 review labeled the request to reconsider `entry()` as its "ask A"; it
is the second of the review's two asks on this thread.)*

The review separately called `entry()` "superfluous"
([3916247285](https://github.com/endojs/endo-but-for-bots/pull/897#discussion_r3916247285))
and asked to remove it, but investigation
([3931325779](https://github.com/endojs/endo-but-for-bots/pull/897#discussion_r3931325779))
found it **load-bearing**:

- `mount.entry()` (`mount.js:966-969`) is the **sole public minter** of an
  `EndoMountEntry`; the only other producer is `EndoMountEntry.child()`, reachable
  only from an entry a caller already holds.
- `@endo/exo-git` consumes `EndoMountEntry` as a **lineage-verified path
  capability**, not mere sugar. A *mount lineage* is the chain of parent mounts an
  entry was minted through; carrying it lets Git accept a path capability **minted
  for this worktree** while rejecting one minted by a **different** mount, so a
  caller cannot smuggle a path that resolves inside an unrelated worktree into a Git
  operation on this one. A plain string carries no such provenance. `GitPathDesignator
  = string | PathEntry`, and the `entries` option on checkin/commit opts, are public
  Git surface; the lineage check is `entryToRepoSegments`
  (`packages/exo-git/src/git.js:397-410`, `lineageOf(entry)` plus `E(entry).segments()`).
  `git.js` also mints entries internally so string and caller-supplied designators
  share one lineage-checked path (`designatorsToRepoPaths`).

So `entry()` today has **two** jobs, and this design separates them:

1. **String-splitting sugar.** `entry("dir/file.txt")` splits on `/`. This is the
   one remaining slash-splitter in the mount surface, and it is exactly what the
   review wants gone from the interface.
2. **Minting a lineage-verified `EndoMountEntry` capability.** Needed by Git,
   independent of strings.

**The reconciliation this design commits to: `entry()` becomes an array-only
capability minter** (`entry(segments: string[]) -> EndoMountEntry`), with its
string-split branch **deleted**. The string-to-segments translation that job 1 used
to fold in lives in the free function `pathFromSlashString`, so a caller who wants
the translation as a plain value gets it *without* also minting a capability, and a
caller who wants a capability calls `entry(pathFromSlashString("dir/file.txt"))` or,
more usually, `entry(["dir", "file.txt"])`. This keeps the two jobs unbraided: parse
is a pure value function, mint is a capability method. It satisfies the review's "no
string-splitting in the Exo interface" (an exo method no longer splits), keeps Git's
lineage capability alive, and gives option (B) its home in the free function rather
than back inside `entry()`.

**`entry()` is guarded separately from the other path methods, and that guard is
its own edit location.** Unlike the twelve path methods above, `entry()` is not
guarded by `PathArgShape` in `packages/daemon/src/interfaces.js`. Its guard is
`pathEntryIssuerMethodGuards.entry = M.call(M.or(M.string(),
M.arrayOf(M.string()))).returns(M.remotable('PathEntry'))` in
`packages/platform/src/fs/interfaces.js:223-225`, a **two-arm** union in the
platform package, spread into `MountInterface` via `...pathEntryIssuerMethodGuards`
(`daemon/src/interfaces.js:717`). The same guard-keeps-string-arm, body-rejects
pattern applies here and *especially* here: `entry()` is precisely the method whose
whole prior purpose was slash-string convenience, so it is the single most likely
site for a caller to reflexively pass a string post-migration. If its guard were
narrowed to a bare `M.arrayOf(M.string())` arm, that caller would get the plain
guard-level "Must be a copyArray" message (see [The Exact Error](#the-exact-error))
instead of the rich directive that names `entry(pathFromSlashString(...))` and
points at glob/grep, the least helpful error at exactly the site that most needs
the most helpful one. So `pathEntryIssuerMethodGuards.entry` **keeps** its
`M.string()` arm as the same routing affordance, and `segmentsFromEntryPathArg`'s
body throws the shared `assertPathIsSegments` directive (worded for `entry()`,
naming `entry(pathFromSlashString(...))`). This makes
`packages/platform/src/fs/interfaces.js` an explicit edit location alongside
`daemon/src/interfaces.js` and `types.d.ts`.

The larger alternative the maintainer named in
[3931325779](https://github.com/endojs/endo-but-for-bots/pull/897#discussion_r3931325779)
is to **retire `EndoMountEntry` / `PathEntry` entirely** and have Git switch to
strings-only, dropping `entryToRepoSegments` and `lineageOf`. That is a bigger
base-code and Git-interface change, and it *loses* the lineage-verification property
described above. This design does not recommend it but records it as the competing
fork (see [Open Questions](#open-questions)).

## Help-Text Requirements

The review demands the glob exception be "called out in help text very clearly."
The help text needs edits in the following places, and the catalog must include the
**model-facing generated surfaces**, which an LLM in this bots-first repo reads
directly and which no amount of `help.md` editing reaches on its own:

1. **The mount interface header** (`help.md:728-733`), restated in its stronger
   form: a path is an array of segments (`["src", "foo.js"]`), a string is never a
   path (even a single name is `["config.json"]`), so `readText("src/foo.js")` and
   `readText("config.json")` both error; to search by pattern use `glob` / `grep` /
   `glorp`, whose string argument is a glob or RegExp; to translate a slash string,
   call `pathFromSlashString`. The header must also **name the exemption
   explicitly**, so the split reads as documented contrast rather than a
   rediscovered inconsistency (OQ5): the variadic-segment methods `has`, `list`,
   and `followNameChanges` (and the registry's `...petNamePath` forms) take one
   *segment* per argument, so `list("subdir")` still accepts the exact
   single-segment string that `readText("subdir")` / `lookup("subdir")` /
   `remove("subdir")` now reject. `list`'s own help entry gains the same contrast
   line.
2. **Each `glob` / `grep` / `glorp` entry** (`help.md:773-813`), each gaining a
   one-line banner that its string argument is a glob pattern or RegExp source, not a
   path, **and** that its result / `paths` entries are display path strings that
   re-enter a path method only through `pathFromSlashString`.
3. **The `entry()` entry** (`help.md:753-759`), rewritten to describe an
   array-taking capability minter, with `pathFromSlashString` documented beside it as
   the one place a slash-joined string is translated, explicitly analogous to
   `fileURLToPath` (the review's own analogy,
   [3910555461](https://github.com/endojs/endo-but-for-bots/pull/897#discussion_r3910555461)).
4. **`help-text-data.js`**, generated from `help.md` (per PR #897's must-fix item on
   regenerating the help data table), regenerated after the edits;
   `helpdown.test.js` guards the round trip.
5. **The generated code-mode declarations**, which independently republish the path
   shape to the model: `packages/agent-tools/generated/code-mode-globals/fs-declarations.js`
   types paths as `string | readonly string[]` at lines 40, 42, 50, 259, 283, and
   `string | string[] | MountEndoMountEntry` at 325-326, and the adjacent extended
   `Filesystem` / `Directory` surface coerces the same way. Because the runtime guard
   **keeps** its `M.string()` arm (see
   [The Declared Type Versus the Guard Shape](#the-declared-type-versus-the-guard-shape)),
   these declarations **cannot** be narrowed simply by narrowing the guard; the
   generator input or a post-generation step must emit the array-only shape
   (`readonly string[] | MountEndoMountEntry`, dropping the `string` arm) directly, so
   the model-facing declarations advertise "path is an array" even though the guard
   still routes a string to a body rejection. The design must list them so this
   narrowing is not forgotten.

## Migration and Backward Compatibility

**What breaks.** Any daemon-facing caller that passes a bare string to a path-taking
method: `readText("x")`, `lookup("x")`, `remove("x")`, registry `storeValue(v, "x")`,
and the like. Slash strings already break today; this extends the break to non-slash
strings. Variadic calls (`has("a", "b")`, `list("sub")`) and array calls are
unaffected.

**How callers migrate.**

- **In-repo call sites** become array form mechanically: `"x"` becomes `["x"]`, and
  a human slash string becomes `pathFromSlashString("a/b")` or the literal
  `["a", "b"]`. The coercion sites and their callers are enumerated under
  [The Coercion Sites](#the-coercion-sites); this is a bounded but non-trivial edit
  across daemon, platform-fs, exo-unzip, and space-chat, not a one-file change.
- **The CLI keeps taking human slash strings** and translates at its boundary,
  exactly the layering the review endorsed
  ([3910555461](https://github.com/endojs/endo-but-for-bots/pull/897#discussion_r3910555461)).
  The CLI already splits via `parsePetNamePath` (`packages/cli/src/pet-name.js:13`)
  before calling the daemon, so `endo cat src/foo.js` still works. Note, however,
  that `parsePetNamePath` does **not** cover every CLI call: `commands/list.js:129,236,254`,
  `commands/make.js:114`, and `commands/inbox.js:13` (`locate('@self')`) pass bare
  strings straight through. So "no human-facing regression" holds **only if** those
  registry-facing sites are either migrated or the registry is kept out of scope (see
  [Registry Symmetry](#open-questions)); the claim is conditional, not absolute, and
  the implementation must route those sites through the shared splitter (or the
  registry's own translation) to keep it true.
- **`@endo/exo-git`** migrates per the `entry()` decision above: `entry()` is
  array-only, Git's internal `designatorsToRepoPaths` mints from segments, and its
  public `GitPathDesignator` keeps the `PathEntry` variant; a string designator, if
  still accepted at the Git boundary, is translated there through the shared
  `pathFromSlashString` plus Git's `'.'`-dropping normalization, not by the mount.

**Test impact.** The tests that build paths via `mount.entry("a/b")` or a bare
string path (an earlier draft estimated about sixty; the true count depends on how much
of the registry [open question 4 (Registry Symmetry)](#open-questions) pulls in, and
the implementation PR should report the grep)
re-express as arrays or `entry(["a", "b"])`. This includes the **four test-harness
coercion helpers** disclosed under [The Coercion Sites](#the-coercion-sites)
(`packages/workflow/test/fake-agent.js:22`,
`packages/platform/test/from-mount.test.js:81`, and
`packages/daemon/test/mount-platform-fs-conformance.test.js:366,385`): they hard-code
the `typeof x === 'string' ? [x] : x` coercion in order to assert bare-string and
array inputs against one expected result, so they must be **rewritten** to assert the
string form *errors* rather than merely re-expressing inputs as arrays. Add tests that
a string argument to each path method throws the directive message (these assert the
*break* is enforced), and tests that variadic, array, and `entry` forms still succeed
(these assert valid forms still work). Add a dedicated test for `pathFromSlashString`
itself (the design's one sanctioned string-to-path seam), covering its chosen
error-on-empty policy (empty-segment rejection), leading-slash handling, and the
glob-result round trip, so the function's reconciliation of the three divergent
splitters is pinned at its own boundary rather than only implied by the callers. The
existing `assertValidSegment` slash tests remain valid, since a slash inside an array
segment is still illegal. `helpdown.test.js` re-baselines against the reworded help.

## Design Decisions

1. **Array-only path arguments, string rejection in the method body.** The exo guard
   keeps an `M.string()` arm as a routing affordance so the body can throw one
   human-legible directive message; dropping the arm produces an unusable union
   pattern dump. The body is the single normative, tested rejection site. The
   *declared* type surfaces diverge from the guard on purpose: the hand-authored
   `types.d.ts` union and the generated code-mode declarations are both narrowed to
   array-only (`readonly string[] | EndoMountEntry`), so no human- or model-facing type
   advertises a string as a path even though the runtime guard still admits one to
   reject it well (see
   [The Declared Type Versus the Guard Shape](#the-declared-type-versus-the-guard-shape)).
2. **`glob` / `grep` / `glorp` keep their string *pattern* arguments; their path
   *strings* get a named seam.** A glob pattern is a DSL, not a path. But glob's
   results and grep's `paths` are slash-joined path strings, so the design names
   `pathFromSlashString` as the sanctioned way to re-enter a path method from a search
   result, and documents it at both ends rather than pretending patterns are the only
   strings left.
3. **`entry()` is repurposed to array-only, not deleted.** Its string-split job goes;
   its lineage-verified-capability job stays as an array-taking minter, preserving
   `@endo/exo-git` provenance while removing the last in-interface slash-splitter.
4. **One canonical string-to-segments free function.** `pathFromSlashString` replaces
   the three divergent private splitters (CLI, mount, Git) and is the escape hatch of
   option (B). It is a pure value function, so parse and mint stay unbraided.
5. **The CLI is the human-string translation layer.** Human slash strings are
   translated to segment arrays at the CLI boundary, so eliminating daemon-side string
   paths carries no human-facing regression, conditional on the registry-facing CLI
   sites named in Migration being covered.
6. **Non-slash single strings are in scope.** The design deliberately eliminates
   `readText("foo")`, not just `readText("a/b")`. A single spelling for a one-segment
   path (`["foo"]`) is the whole point (see the value-identity argument); leaving the
   non-slash string would keep the ambiguity the review is ending.

## Open Questions

1. **Free-function adapter vs. string-accepting `entry()`.** The design recommends the
   pure free function `pathFromSlashString` as the sole string-to-path seam, leaving
   `entry()` array-only. The alternative folds the string branch back into a
   string-accepting `entry()`. The recommendation keeps parse (a value) and mint (a
   capability) unbraided; is that separation worth one extra exported name over a
   single overloaded `entry()`?
2. **`entry()` / `EndoMountEntry` disposition.** Keep `entry()` as an array-taking
   lineage-capability minter (recommended, preserves Git provenance), or take the
   maintainer's larger option from
   [3931325779](https://github.com/endojs/endo-but-for-bots/pull/897#discussion_r3931325779)
   and retire `EndoMountEntry` / `PathEntry` entirely with Git going strings-only
   (loses lineage verification)?
3. **Search-family shape.** Keep `glob` returning and `grep` consuming slash-joined
   display path strings, bridged by `pathFromSlashString` (recommended, smaller change,
   display-friendly results), or convert the search family to segment arrays
   (`glob(): string[][]`, `grep(pattern, paths?: readonly string[][])`) so the
   array-only invariant is total? The second makes strings-are-never-paths hold with
   no exception, at the cost of a bigger change and a less readable result.
4. **Registry symmetry, and the teachability cost of splitting it.** The petname
   registry shares the `string | string[]` shape. Its accurate method inventory
   (`interfaces.js`, shapes from `type-guards.js:21-34`): `move` / `copy` are already
   array-only positional (`NamePathShape`); `remove` / `identify` / `locate` /
   `listIdentifiers` / `listLocators` are already variadic-only rest of array paths;
   only `storeIdentifier` / `storeLocator` / `storeValue` / `sendValue` / `cancel`,
   the `lookup` family, and `evaluate` still take `NameOrPathShape`, and `evaluate`'s
   endowment list is typed `NamesOrPathsShape` (`interfaces.js:57-64`), where
   array-only bites hardest (`evaluate(undefined, src, ["counter"], [["counter"]])`).
   The cost of scoping the change to the mount only is that the rule becomes
   unteachable: `host.lookup("foo")` would stay legal while `mount.lookup("foo")`
   errors, the same-shaped argument on adjacent faces. Since the entire justification
   is legibility, a partial adoption spends the breakage and forfeits the benefit. Do
   we change the registry in lockstep (consistent, larger blast radius, and it makes
   the value-identity fix total), or scope to the mount and accept the split with eyes
   open?
5. **Sibling spelling incoherence.** After the change, `readText(["src"])` is legal and
   `readText("src")` errors, while `list("src")` is legal and `list(["src"])` errors
   (`list` is `.rest(PathSegmentsShape)` at `interfaces.js:723`). Today the one-segment
   call works uniformly across both families; afterward the same one-segment call
   spells oppositely per method. Do we accept that, or make all path methods variadic
   (`readText("src", "foo.js")`), which yields the same array-only invariant with a
   cheaper common case and a uniform spelling? **Recommended:** accept the split for
   this design and keep the array-taking / variadic-`.rest()` families as they are. The
   uniform-variadic alternative is attractive but is a *strictly larger* interface
   change (every array-taking method's guard and TypeScript face rewritten to
   `.rest(PathSegmentsShape)`, plus every array call site migrated to spread form) that
   would balloon the blast radius past the one the migration section scopes; the
   spelling incoherence is a legibility wart, not a correctness one, and is best paid
   down separately if the uniform-variadic direction is later adopted wholesale.
6. **Deprecation window.** Reject strings immediately (clean, breaking), or first ship
   a phase that still coerces but logs a warning, giving out-of-repo consumers a
   migration window before the hard error?
7. **Guard-level combinator versus wide-guard-plus-narrow-declaration.** This design
   keeps the guard's `M.string()` arm and narrows the declared surfaces separately (see
   [The Declared Type Versus the Guard Shape](#the-declared-type-versus-the-guard-shape)),
   accepting that CapTP / `M.interface()` introspection still shows a string arm the
   method rejects. The cleaner alternative is a custom guard combinator that declares an
   array-only shape *and* intercepts the underlying `M.or` rejection to substitute the
   directive message, collapsing the guard-vs-declaration divergence at every consumer
   at once, at the cost of a new pattern-combinator primitive. Is that primitive worth
   building now, or is the wide-guard/narrow-declaration split an acceptable interim?

## Prompt

> Write a design doc proposing to **eliminate support for single-segment string
> petname paths** in the mount/daemon path API, so that a slash-delimited string
> like `"src/foo.js"` produces an **error** rather than being silently treated as
> one literal segment. Cover: (1) current behavior and the surface that accepts
> string paths; (2) the proposed array-only rule and the exact error a string
> yields, evaluating a string escape hatch; (3) the glob/glorp aberration:
> `glob`/`glorp`'s single-string argument IS the UNIX glob DSL, deliberately unlike
> petname paths, and how help text must call it out "very clearly"; (4) interaction
> with the `entry()` wrapper (PR #897 review ask A): with entry() reconsidered and
> strings rejected, what mints/represents a path; (5) migration/back-compat: what
> breaks, how callers and help text migrate, test impact; (6) open questions for
> kriskowal to decide. This is a DESIGN deliverable, not a code change.
>
> Source: kriskowal review comment on PR #897, inline comment 3916282675 on
> `packages/daemon/src/help.md`:
> *"It may be noted that the 'glob' expression for glob, glorp is an explicit
> aberration on the array-of-segments petname path notation we use elsewhere, where
> a single string is in the UNIX glob DSL. However, a path should always be
> represented as petname path segments and a single string is always a single
> segment. This will need to be called out in help text very clearly, since it is
> not the norm. It may behoove us to completely eliminate support for single segment
> pet name paths in order to ensure that a slash delimited string produces an error.
> Please post a follow-up design to that effect."*
