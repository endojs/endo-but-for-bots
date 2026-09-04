# Eliminate single-segment string paths

| | |
|---|---|
| **Created** | 2026-09-04 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Source** | PR [#897](https://github.com/endojs/endo-but-for-bots/pull/897) inline review comment [3916282675](https://github.com/endojs/endo-but-for-bots/pull/897#discussion_r3916282675) on `packages/daemon/src/help.md` (the `glob`/`glorp` section), with the sibling `entry()` thread [3916247285](https://github.com/endojs/endo-but-for-bots/pull/897#discussion_r3916247285) / [3931325779](https://github.com/endojs/endo-but-for-bots/pull/897#discussion_r3931325779) |

## What is the Problem Being Solved?

A **petname path** is conceptually an **array of segments** — `["src", "foo.js"]`.
Across the daemon we also accept a **bare string** as a path, where the string is
treated as a **single, literal segment**. The maintainer's review on PR #897 asks
us to reconsider that convenience:

> It may be noted that the "glob" expression for glob, glorp is an explicit
> aberration on the array-of-segments petname path notation we use elsewhere,
> where a single string is in the UNIX glob DSL. However, a path should always be
> represented as petname path segments and a single string is always a single
> segment. This will need to be called out in help text very clearly, since it is
> not the norm. It may behoove us to completely eliminate support for single
> segment pet name paths in order to ensure that a slash delimited string produces
> an error. Please post a follow-up design to that effect.

The tension is that **two different arguments are string-shaped but mean opposite
things**:

- To a path-taking method (`readText`, `lookup`, `remove`, …), a string is a
  *literal one-segment path*. `readText("foo")` reads the file named `foo`.
- To `glob`/`grep`/`glorp`, a string is a *pattern in a different DSL* — a
  slash-separated UNIX glob (`glob("src/**/*.js")`) or an ECMAScript RegExp
  source (`grep("^export")`). Here the slashes are structural and `*`/`**` are
  metacharacters.

A caller who has internalized "`glob` takes a slash-joined string" naturally
reaches for `readText("src/foo.js")` and expects it to descend into `src`. It does
not: `src/foo.js` is one name. Today that specific mistake is *already caught*
(see [Current behavior](#current-behavior)), but only because a slash is an illegal
character in a segment — the **non-slash** single-string case (`readText("foo")`)
still silently succeeds, keeping two spellings of a one-segment path alive and
leaving the string/DSL ambiguity in the type. This design proposes closing that gap
by making **array-of-segments the sole path spelling**, so that *every* string
argument to a path-taking method is rejected and the only remaining string-shaped
arguments are the glob/grep patterns, which are then unambiguously *not* paths.

## Current behavior

Two "path" concepts coexist and must be kept distinct.

| World | Canonical path | Bare-string handling | Slash-string handling today |
|---|---|---|---|
| **Pet-name registry** (`EndoHost`/`EndoGuest`/`EndoDirectory` name hub) | array of names | coerced to a one-element array | **already errors** — `/` is illegal in a name |
| **EndoMount filesystem API** (`EndoMount` / `EndoMountEntry`) | array of segments | coerced to a one-element segment array (never split) | **already errors** — `/` is illegal in a segment |

### The surface that accepts string paths

**EndoMount path API** — every path-bearing method accepts
`string | string[] | EndoMountEntry`. The runtime guard is defined once as
`PathArgShape = M.or(M.string(), PathSegmentsShape, MountEntryShape)`
(`packages/daemon/src/interfaces.js:693-695`) and applied to
`lookup`, `maybeLookup`, `subView`, `write`, `copy`, `stat`, `readText`,
`maybeReadText`, `writeText`, `makeDirectory`, `makeFile`, `remove`, and `move`
(`interfaces.js:716-800`). The TypeScript face mirrors this as
`string | readonly string[] | EndoMountEntry` (`packages/daemon/src/types.d.ts:1342-1428`).
Three methods instead take **variadic segments** and never a single joined string:
`has(...segments)`, `list(...segments)`, `followNameChanges(...segments)`.

**Pet-name registry API** — `lookup`, `identify`, `locate`, `storeIdentifier`,
`storeLocator`, `remove`, `move`, `copy`, `readText`, `writeText`, `cancel`,
`storeValue`, `sendValue`, and the variadic `...petNamePath` forms all accept a
name or a name path. The guard family is
`NameOrPathShape = M.or(NameShape, NamePathShape)`
(`packages/daemon/src/type-guards.js:21-34`), typed `string | string[]`
throughout (`types.d.ts:952-966`).

### The coercion choke points

There are exactly three places a bare string becomes a one-element array:

1. **Mount API** — `segmentsFromPathArg` (`packages/daemon/src/mount.js:621-639`).
   The final branch, `return normalizeSegments(currentSegments, [pathArg], …)`
   (line 638), is the one that turns a string into `[pathArg]`. Every path-bearing
   mount method funnels through it, directly or via `resolvePathArg`
   (`mount.js:705-706`). A second, minor site is the readable-tree wrapper's
   `typeof petNamePath === 'string' ? [petNamePath] : petNamePath`
   (`mount.js:1397`).
2. **Registry API** — `namePathFrom` (`packages/daemon/src/pet-name.js:148-149`):
   `const path = typeof nameOrPath === 'string' ? [nameOrPath] : nameOrPath`.
3. **`entry()` only** — `segmentsFromEntryPathArg` (`mount.js:649-661`), the sole
   splitter: `normalizeSegments(currentSegments, pathArg.split('/'), …)`.

### What already errors, and what silently works

Segment validity is enforced *below* the coercion:

- Mount segments — `assertValidSegment` (`mount.js:248-265`) rejects any segment
  containing `/`, `\`, or `\0`, with the message *"Path segment must not contain
  '/', '\\', or '\\0' (a string is one segment; pass ["dir", "file.txt"] or
  entry("dir/file.txt") for nested paths)"*.
- Registry names — `isValidName` (`pet-name.js:15-23`) rejects any name containing
  `/`, `\0`, or `@`, or equal to `.`/`..`.

So the *slash* mistake the review names is **already an error today**:
`readText("src/foo.js")` reaches `segmentsFromPathArg` → `["src/foo.js"]` →
`assertValidSegment` throws; `lookup` even re-throws with a friendlier hint
(`mount.js:900-906`). The help header already documents this
(`help.md:728-733`).

What is *not* yet an error is the **non-slash single string**: `readText("foo")`,
`lookup("foo")`, `remove("foo")` all silently coerce to `["foo"]`. That residue is
what keeps two spellings of a one-segment path in the surface and keeps the bare
`M.string()` arm in every guard — the thing this design removes.

## The glob / grep / glorp aberration

`glob`, `grep`, and `glorp` take a single string that is **never a path**:

- `glob(pattern)` — `pattern` is a slash-separated **glob** whose only
  metacharacters are `*` and `**` (`mount.js:809`, `help.md:773-786`). The DSL is
  parsed by splitting on `/` in the platform engine
  (`packages/platform/src/fs/search.js:196`).
- `grep(pattern, paths?, options?)` — `pattern` is an **ECMAScript RegExp source**,
  evaluated as `new RegExp(pattern)` (`mount.js:849`, `help.md:788-801`).
- `glorp(glob, grep, options?)` — a **glob string** and a **RegExp string**
  fused (`mount.js:886`, `help.md:803-813`).

These are the only string-shaped arguments in the mount surface that are *not*
paths. Once path arguments are array-only, the glob/grep strings become the sole
inhabitants of "a string here means a pattern, not a path," which is exactly the
distinction the review wants drawn sharply. This design does **not** change the
glob/grep argument shape — a glob is inherently a string DSL and forcing it into a
segment array would be a category error (segments cannot carry `*`/`**` across
levels). Instead it makes the *contrast* legible: paths are arrays, patterns are
strings, and the help text says so at both ends (see
[Help-text requirements](#help-text-requirements)).

## Proposed rule: paths are always arrays of segments

**A path is always an array of petname segments. A bare-string argument to any
path-taking method is rejected at the exo boundary.**

Concretely:

1. **Guards drop the bare-`M.string()` arm.** `PathArgShape` becomes
   `M.or(PathSegmentsShape, MountEntryShape)` (`interfaces.js:695`); the registry's
   `NameOrPathShape` collapses to `NamePathShape` at its path call sites
   (`type-guards.js`, `interfaces.js`); the platform-fs `NameOrPathShape`
   (`packages/platform/src/fs/interfaces.js:16`) likewise. A string argument now
   fails the *interface* guard before reaching method bodies — the cleanest,
   earliest rejection point.
2. **Coercion sites delete the string branch.** `segmentsFromPathArg`
   (`mount.js:638`) drops `[pathArg]` and throws for a string; `namePathFrom`
   (`pet-name.js:149`) drops the ternary; the readable-tree wrapper
   (`mount.js:1397`) drops its ternary. These become defense in depth behind the
   guard.
3. **Variadic-segment methods are unaffected.** `has("dir", "file")`,
   `list("subdir")`, and the `...petNamePath` registry forms already take one
   *segment* per argument, not a joined path, and keep working. A **single**
   variadic argument (`list("subdir")`) is still one segment — this is not a
   "string path," it is one element of a segment vector, and it stays legal.

### Exact error

A string argument yields a `TypeError`-class rejection at the guard:

> `In "readText" method of (EndoMount): arg 0: string "src/foo.js" - Must be a copyArray`

(the native `@endo/patterns` message for a failed `M.arrayOf(M.string())`). Because
that message is opaque to a human, method bodies **also** keep a hand-thrown guard
with a directive message, so a string that somehow reaches a body (or a future
un-guarded call path) still explains itself:

> `Path must be an array of segments; a string is not a path. Pass ["src", "foo.js"]
> (a slash-joined string like "src/foo.js" is never split). For pattern search use
> glob()/grep()/glorp(), whose string argument is a glob or RegExp, not a path.`

This single message does double duty: it rejects the *slash* string
(`"src/foo.js"`) **and** the *non-slash* string (`"foo"`), and it points a confused
glob user back to the pattern methods.

### Escape-hatch evaluation

The review offers "completely eliminate" as the strong option but the design should
weigh a narrower one. Two shapes were considered:

- **(A) Hard array-only (no escape hatch).** Every string is rejected; the only way
  to spell a one-segment path is `["foo"]`. Maximally consistent, minimal surface,
  but noisy for the overwhelmingly common one-segment call
  (`readText(["config.json"])`).
- **(B) Array-only with an explicit, adapter-named string escape hatch.** Keep a
  single, clearly-named minter that *does* accept a string and split it — the
  natural home is a renamed/kept `entry()` (see next section) or a free function
  named for the translation it performs (the review's own `fileURLToPath` analogy,
  comment [3910555461](https://github.com/endojs/endo-but-for-bots/pull/897#discussion_r3910555461)).
  The path *methods* stay array-only; the escape hatch is one named seam, not an
  overload on every method.

This design **recommends (B)** — array-only methods plus one named string→path
adapter — because it delivers the review's core invariant (a raw string is never a
path at a method boundary; a slash string produces an error there) while preserving
an ergonomic, greppable place for the string→segments translation the CLI and Git
adapter genuinely need. Whether that seam is `entry()` repurposed or a standalone
adapter is an [open question](#open-questions).

## Interaction with `entry()` and `EndoMountEntry` (PR #897 ask A)

The review separately called `entry()` "superfluous"
([3916247285](https://github.com/endojs/endo-but-for-bots/pull/897#discussion_r3916247285))
and asked to remove it, but investigation
([3931325779](https://github.com/endojs/endo-but-for-bots/pull/897#discussion_r3931325779))
found it **load-bearing**:

- `mount.entry()` (`mount.js:966-969`) is the **sole public minter** of an
  `EndoMountEntry` — the only other producer is `EndoMountEntry.child()`, reachable
  only from an entry you already hold.
- `@endo/exo-git` consumes `EndoMountEntry` as a **lineage-verified path
  capability**, not mere sugar. `GitPathDesignator = string | PathEntry`, and the
  `entries` option on checkin/commit opts, are public Git surface. The lineage
  check in `entryToRepoSegments` (`packages/exo-git/src/git.js:397-410`,
  `lineageOf(entry)` + `E(entry).segments()`) lets a caller hand Git a path
  capability **minted for this worktree** while rejecting one minted by a different
  mount lineage — provenance a plain string cannot carry. `git.js` also mints
  entries internally so string and caller-supplied designators share one
  lineage-checked path (`designatorsToRepoPaths`).

So `entry()` has **two** jobs that this design must separate:

1. **String-splitting sugar** — `entry("dir/file.txt")` splits on `/`. This job is
   exactly what the review wants gone from the path *methods*, and with paths
   array-only it is *also* the last slash-splitter in the mount surface. This job
   can be **deleted** or **quarantined** to the one named adapter of option (B).
2. **Minting a lineage-verified `EndoMountEntry` capability** — needed by Git,
   independent of strings. An array-taking minter (`entry(["dir","file.txt"])`)
   satisfies this with no string involved.

The clean reconciliation: **`entry()` survives as an array-taking capability
minter** (`entry(segments: string[]) -> EndoMountEntry`), losing its string-split
branch. That simultaneously (a) satisfies the review's "no string-splitting in the
Exo interface," (b) keeps Git's lineage capability alive, and (c) gives option (B)
its named home — if a string escape hatch is wanted at all, `entry()` is where it
lives, isolated and documented, rather than spread across every method.

The alternative the maintainer named in
[3931325779](https://github.com/endojs/endo-but-for-bots/pull/897#discussion_r3931325779)
— **retire `EndoMountEntry` / `PathEntry` entirely**, Git switches to strings-only,
drop `entryToRepoSegments`/`lineageOf` and ~60 tests — is a larger base-code + Git
interface change and *loses* the lineage-verification property. This design does not
recommend it, but records it as the competing fork (see
[Open questions](#open-questions)).

## Help-text requirements

The review demands the glob exception be "called out in help text very clearly."
The help text must state, at three places:

1. **The mount interface header** (`help.md:728-733`, today) — restate the rule in
   its stronger form: *"A path is an array of segments (`["src", "foo.js"]`). A
   string is never a path — even a single name is `["config.json"]` — so
   `readText("src/foo.js")` and `readText("config.json")` both error. To search by
   pattern, use `glob`/`grep`/`glorp`, whose string argument is a glob or RegExp,
   not a path."*
2. **Each `glob`/`grep`/`glorp` entry** (`help.md:773-813`) — add a one-line
   *"(This string is a &lt;glob pattern | RegExp source&gt;, **not** a petname path.
   Paths elsewhere are arrays of segments.)"* banner so the reader who arrives at
   `glob` cannot conflate its string with a path string.
3. **The `entry()` entry** (`help.md:753-759`) — rewrite to describe an
   array-taking capability minter and, if option (B) keeps a string hatch here,
   flag it as *the one and only* place a slash-joined string is accepted and
   translated, explicitly analogous to `fileURLToPath`.

`help-text-data.js` is generated from `help.md` (per PR #897 must-fix item 6), so
regenerate it after the edits; `helpdown.test.js` guards the round-trip.

## Migration and back-compat

**What breaks.** Any daemon-facing caller that passes a bare string to a
path-taking method: `readText("x")`, `lookup("x")`, `remove("x")`, registry
`storeValue(v, "x")`, etc. Slash strings already break today; this extends the break
to non-slash strings. Variadic calls (`has("a","b")`, `list("sub")`) and array
calls are unaffected.

**How callers migrate.**

- **In-repo call sites** mechanically become array form: `"x"` → `["x"]`,
  `"a/b"` → `["a", "b"]`. This is a bounded, greppable edit (the coercion sites and
  their callers are enumerated above).
- **The CLI keeps taking human slash strings** and translates at its boundary —
  exactly the layering the review endorsed
  ([3910555461](https://github.com/endojs/endo-but-for-bots/pull/897#discussion_r3910555461)):
  *"Translating between Endo paths and other path disciplines belongs in an adapter
  … The Endo CLI necessarily translates between Unix or Windows and URL or pet
  names path, which is valid layering."* The CLI already does this via
  `parsePetNamePath` (`packages/cli/src/pet-name.js:13`), which splits on `/` before
  calling the daemon — so **no human-facing regression**: `endo cat src/foo.js`
  still works, because the CLI hands the daemon `["src","foo.js"]`.
- **`@endo/exo-git`** migrates per the entry() decision above: if `entry()` stays as
  an array minter, Git's internal `designatorsToRepoPaths` mints from segments and
  its public `GitPathDesignator` keeps the `PathEntry` variant; a string designator,
  if still accepted at the Git boundary, is translated there (Git's own adapter),
  not by the mount.

**Test impact.** The ~60 tests that build paths via `mount.entry("a/b")` or a bare
string path re-express as arrays or as `entry(["a","b"])`. Add positive tests that a
string argument to each path method throws the directive message, and negative
tests that variadic/array/entry forms still succeed. The existing
`assertValidSegment` slash tests remain valid (a slash inside an array segment is
still illegal). `helpdown.test.js` re-baselines against the reworded help.

## Design Decisions

1. **Array-only paths, string rejection at the guard.** The earliest, clearest
   rejection point is the exo interface guard; method-body throws are defense in
   depth with a human-readable directive message.
2. **Glob/grep/glorp keep their string arguments.** A glob is a DSL, not a path;
   coercing it to segments is a category error. The design draws the contrast in
   help text rather than reshaping the pattern methods.
3. **`entry()` is repurposed, not deleted.** Its string-split job goes; its
   lineage-verified-capability job stays as an array-taking minter, preserving
   `@endo/exo-git` provenance while removing the last in-interface slash-splitter.
4. **CLI is the translation layer.** Human slash strings are translated to segment
   arrays at the CLI boundary (already implemented), so eliminating daemon-side
   string paths carries no human-facing regression.
5. **Non-slash single strings are in scope.** The design deliberately eliminates
   `readText("foo")`, not just `readText("a/b")` — a single spelling for a
   one-segment path (`["foo"]`) is the whole point; leaving the non-slash string
   would keep the ambiguity the review is trying to end.

## Open Questions

1. **Hard elimination vs. one named string escape hatch.** Do we go strictly
   array-only at *every* seam (option A), or keep exactly one clearly-named
   string→path adapter (option B — recommended)? If (B), is the adapter a
   repurposed `entry()` that accepts a slash string, or a standalone
   `fileURLToPath`-style free function, leaving `entry()` array-only?
2. **`entry()` / `EndoMountEntry` disposition.** Keep `entry()` as an array-taking
   lineage-capability minter (recommended — preserves Git provenance), or take the
   maintainer's larger option 1 from
   [3931325779](https://github.com/endojs/endo-but-for-bots/pull/897#discussion_r3931325779)
   and retire `EndoMountEntry`/`PathEntry` entirely with Git going strings-only
   (loses lineage verification, ~60-test change)?
3. **Glob-DSL exception ergonomics.** Is a per-method help banner enough to keep the
   glob/grep *string* from being conflated with a path, or should the pattern
   methods be renamed / namespaced (e.g. a `search` sub-face) so the string-shaped
   argument is visibly a different kind of thing from a path argument?
4. **Registry symmetry.** The pet-name registry (`EndoHost`/`EndoGuest`/
   `EndoDirectory`) shares the `string | string[]` shape. Do we eliminate string
   paths there in lockstep (consistent, larger blast radius), or scope this change
   to the EndoMount filesystem API where the glob aberration actually lives and
   treat the registry as a follow-up?
5. **Deprecation window.** Reject strings immediately (clean, breaking), or first
   ship a deprecation phase that still coerces but logs/warns, giving out-of-repo
   consumers a migration window before the hard error?

## Prompt

> Write a design doc proposing to **eliminate support for single-segment string
> petname paths** in the mount/daemon path API, so that a slash-delimited string
> like `"src/foo.js"` produces an **error** rather than being silently treated as
> one literal segment. Cover: (1) current behavior and the surface that accepts
> string paths; (2) the proposed array-only rule and the exact error a string
> yields, evaluating a string escape hatch; (3) the glob/glorp aberration —
> `glob`/`glorp`'s single-string argument IS the UNIX glob DSL, deliberately unlike
> petname paths — and how help text must call it out "very clearly"; (4) interaction
> with the `entry()` wrapper (PR #897 review ask A) — with entry() reconsidered and
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
