# `endo ls --json`

| | |
|---|---|
| **Created** | 2026-07-15 |
| **Updated** | 2026-09-27 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Source** | [PR #658 follow-up directive](https://github.com/endojs/endo-but-for-bots/pull/658#issuecomment-4977137707) |

## What is the Problem Being Solved?

`endo ls` is the command-line view of `EndoDirectory.list()`.
Its help advertises `-j, --json` as "JSON format output", but the snapshot path ignores that flag and writes one human-oriented name per line.

`endo ls --follow --json` does serialize its name-change events, one JSON value per line.
The two modes therefore give `--json` incompatible meanings: it is ignored for a finite listing and is a stream format for a live listing.

### Prior discussion

This design follows up on PR #658, which proposed mount-specific CLI verbs such as `endo ls <mount> [path...]` for traversing an `EndoMount` (the daemon's confined directory view over a host filesystem folder).
The maintainer closed that PR and asked for two orthogonal follow-ups instead: this improvement to `endo ls --json`, and a separate design for `endo store` to drive `writeFile` on ordinary directories.
The reasoning was that mounts are not, and should not be, special as name hubs.
The ordinary slash-separated directory argument already traverses any compatible name hub (any object answering the directory `list`/`lookup` protocol), including an `EndoMount`, so `endo ls` needs no mount-specific branch.
What remains broken is the `--json` flag itself, described above.

This is therefore an interface problem, not a mount-path problem.
The fix belongs in the existing list command and must work for every directory the daemon can list, mounted or not.
The `endo store` / `writeFile` request is independent and stays out of scope here.

## Goals and Scope

The command must give scripts one parseable snapshot representation, preserve the useful live event stream, and make incompatible display modifiers explicit.

This design changes only CLI rendering and option validation.
It does not change directory traversal, daemon list order, name-hub interfaces, mount behavior, or the separate `endo store` / `writeFile` follow-up requested from PR #658.

## User-Facing Contract

The following forms are canonical:

```text
endo ls [directory] --json
endo ls [directory] --type <formula-type> --json
endo ls [directory] --follow --json
```

`-j` remains an alias for `--json`.
The optional `directory` keeps its current slash-path interpretation.
For example, `endo ls workspace/src --json` reaches the same directory as the non-JSON form.

### Snapshot output

Without `--follow`, `--json` writes exactly one JSON array to standard output, followed by the normal terminal newline.
Every element is a pet-name string.
The array is the value returned by `EndoDirectory.list()` after any `--type` filtering.

```console
$ endo ls --json
[
  "build",
  "workspace"
]

$ endo ls workspace/src --type readable-blob --json
[
  "index.js"
]
```

An empty directory emits `[]`.
The command preserves the daemon's returned order and does not sort names while serializing.
No headings, tabs, value renderings, diagnostics, or progress messages may appear on standard output in a successful JSON invocation.
Failures remain a nonzero exit with diagnostics on standard error.

The array is deliberately the raw list of names, rather than a wrapper record or a value inspection.
It matches the value returned by the underlying list operation.
It also follows the CLI convention that `--json` exposes the raw command result, the convention already observed by `endo inspect --json`, `endo paths --json`, and `endo trace --json`.
Like those commands, the snapshot is pretty-printed with a two-space indent, `JSON.stringify(names, null, 2)`.

### Live output

`endo ls --follow --json` remains a stream because it has no finite result.
It emits one complete JSON name-change object per line, in event order.
This is JSON Lines, not one JSON array and not one JSON document for the lifetime of the process.

```console
$ endo ls --follow --json
{"add":"workspace","type":"mount"}
{"remove":"workspace"}
```

The event shape remains the daemon's existing name-change shape: an `add` or `remove` property, with the `type` property present only when the daemon supplies it for an addition.
This design neither invents sequence numbers nor buffers a live stream into an array.

### Option composition

`--type` is a selection option, not a presentation option.
For a snapshot, it selects names by the same locator-derived type resolution used by the text form, then serializes the resulting string array.

`--verbose` cannot compose with JSON because its current value rendering is for humans and values can be passable capabilities rather than JSON data.
`--grouped` cannot compose with JSON because its headings are a text presentation and no grouped JSON schema exists.
Both combinations fail before listing with a mutual-exclusion diagnostic.

`--follow --json` also rejects `--type`, `--verbose`, and `--grouped`.
The text-mode follow path filters additions by type but passes every removal through unfiltered, because a removal event carries no type.
Reproducing that asymmetry in JSON would make a filtered stream look complete while it silently includes unrelated removals; filtering removals properly would require client-side state or an invented event envelope.
Rejecting the combination keeps the JSON stream an unmodified copy of the daemon's events, which is the compatibility-preserving contract.

Every conflict uses one message shape, produced by one shared validation helper:

```text
endo ls: --<a> cannot be combined with --<b>
```

The diagnostic goes to standard error and the command exits nonzero.
No other `endo` command validates option conflicts today, so this helper and message shape set the precedent that later CLI commands should reuse.

The help text must say "emit the raw name list as JSON" and describe the `--follow --json` form as JSON Lines.
It must identify `--verbose` and `--grouped` as incompatible with `--json`.

## Compatibility

The normal text forms, their order, and the generic directory traversal path do not change.
The snapshot implementation currently ignores `--json`, so there is no functioning snapshot JSON payload to preserve.
Scripts that supplied `--json` but parsed the previous text output must remove that flag or begin parsing JSON.

The existing live JSON Lines behavior is retained, including its event shape and order.
The new validation makes combinations that could not have produced a coherent JSON contract fail explicitly.
Some of those combinations succeed today and will begin failing:

- `endo ls --follow --json --type <formula-type>` currently exits normally and streams every event, because the live JSON path never reads `--type`. It will now fail with the conflict diagnostic.
- `endo ls --follow --json --verbose` and `endo ls --follow --json --grouped` currently stream every event and silently ignore the modifier. They will now fail.
- `endo ls --json --verbose` and `endo ls --json --grouped` currently print the text form and ignore `--json`. They will now fail.

A script relying on any of these combinations must drop the incompatible modifier.

Plain text `--follow` (without `--json`) already ignores `--verbose` and `--grouped` silently: it prints only `+name` and `-name` lines.
This design leaves that text-mode behavior unchanged, because its scope is the JSON contract; the asymmetry is a known text-mode gap rather than an endorsement of silent modifiers.
No daemon migration, stored-data migration, or new authority is required.

## Implementation Boundaries

The implementation is localized to `packages/cli/src/commands/list.js` and the `list` command declaration in `packages/cli/src/endo.js`.

1. Resolve the list exactly as today.
2. Apply snapshot-only `--type` filtering before rendering.
3. Serialize the resulting `string[]` with `JSON.stringify(names, null, 2)` when `json` is set, matching the `inspect`, `paths`, and `trace` JSON output.
4. Keep the current event-by-event serializer for `follow && json`.
5. Validate incompatible option combinations at the CLI boundary, before any remote lookup or subscription, through one shared helper that emits the message shape above.

`packages/daemon/src/directory.js`, `EndoDirectory`, `EndoMount`, and the mount confinement implementation are out of scope.
In particular, this work must not reintroduce a mount-specific `ls` branch: the existing `E(agent).lookup(parsePetNamePath(directory))` path is the uniform mechanism.

## Verification Plan

Add CLI integration coverage using an isolated daemon and a seeded directory.

- Assert that `endo ls --json` parses with `JSON.parse`, returns the expected `string[]`, and has no non-JSON standard-output prefix or suffix.
- Assert that an empty listing yields `[]` and a nested slash-path directory yields the raw names of that directory.
- Assert that a slash-path directory that resolves through an `EndoMount` (a mounted temporary host folder) yields the same array-of-strings schema, so the mount traversal this design relies on is exercised rather than assumed.
- Assert that `--type --json` returns only matching names while retaining the array-of-strings schema.
- Assert that the equivalent text invocations retain their present line-oriented output and ordering.
- Assert that `--json --verbose`, `--json --grouped`, and each unsupported `--follow --json` modifier fail before opening a subscription, with the shared diagnostic shape on standard error and nothing on standard output.
- Assert that a follow-mode fixture emits independently parseable lines for an add and a remove event, preserving the daemon-provided `type` field on the add event.
- Assert that `endo ls --help` documents the snapshot JSON array, JSON Lines live mode, and modifier exclusions.

The targeted CLI test suite and the repository formatting, lint, type, and documentation checks are the implementation PR's required verification.

## Design Decisions

1. A finite listing is one JSON array, not JSON Lines, because scripts can parse it with one `JSON.parse` and it mirrors `EndoDirectory.list()`.
2. A live listing remains JSON Lines because an unbounded subscription cannot complete a JSON array without buffering indefinitely.
3. JSON output remains names-only because name-to-value inspection is a distinct operation and remotable values have no general JSON representation.
4. Conflicting display modes fail instead of silently taking precedence, so a command that advertises JSON never emits a text-only representation.

## Open Questions

- Should a future richer listing mode add a separately named schema such as `--json=entries` with `{ name, type }` records, or should `endo inspect` remain the only metadata lookup surface?
- Should `--follow --json` gain an explicit `--jsonl` alias in a later CLI-major release, while retaining `--json` for backward compatibility?
  This design deliberately does not introduce `--jsonl` now: `--follow --json` already ships as JSON Lines, so renaming it would break existing consumers, and no consumer has asked for a separate stream flag.
  The residual overloading is acceptable because the two shapes follow from a real difference in the values (a finite list versus an unbounded stream), and `--follow` already selects between them.
- Does the project want to promise the names-only JSON schema as stable across CLI-major releases, and if so where should that versioning policy be documented?

## Prompt

> Draft a self-contained design for improving the `endo ls --json` interface.
> Treat this as orthogonal follow-up work.
> Establish the intended JSON contract, user-facing behavior, compatibility considerations, implementation boundaries, and verification plan.
> Surface unresolved choices as explicit open questions.
