# `endo ls --json`

| | |
|---|---|
| **Created** | 2026-07-15 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Source** | [PR #658 follow-up directive](https://github.com/endojs/endo-but-for-bots/pull/658#issuecomment-4977137707) |

## What is the Problem Being Solved?

`endo ls` is the command-line view of `EndoDirectory.list()`.
Its help advertises `-j, --json` as "JSON format output", but the snapshot path ignores that flag and writes one human-oriented name per line.

`endo ls --follow --json` does serialize its name-change events, one JSON value per line.
The two modes therefore give `--json` incompatible meanings: it is ignored for a finite listing and is a stream format for a live listing.

This is an interface problem, not a mount-path problem.
The ordinary slash-separated directory argument already traverses any compatible name hub, including an `EndoMount`.
The fix belongs in the existing list command and must work for every directory the daemon can list.

## Goals and Scope

The command must give scripts one parseable snapshot representation, preserve the useful live event stream, and make incompatible display modifiers explicit.

This design changes only CLI rendering and option validation.
It does not change directory traversal, daemon list order, name-hub interfaces, mount behavior, or the separate `endo store` / `writeFile` follow-up requested from PR #658.

## User-facing Contract

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
Every element is a string pet name.
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
It matches the underlying list operation and the CLI convention that `--json` exposes the raw command result, as `endo inspect --json`, `endo paths --json`, and `endo trace --json` do.

### Live output

`endo ls --follow --json` remains a stream because it has no finite result.
It emits one complete JSON name-change object per line, in event order.
This is JSON Lines, not one JSON array and not one JSON document for the lifetime of the process.

```console
$ endo ls --follow --json
{"add":"workspace","type":"mount"}
{"remove":"workspace"}
```

The event shape remains the daemon's existing name-change shape: an `add` or `remove` property, with the additive `type` property only when the daemon supplies it for an addition.
This design neither invents sequence numbers nor buffers a live stream into an array.

### Option composition

`--type` is a selection option, not a presentation option.
For a snapshot, it selects names by the same locator-derived type resolution used by the text form, then serializes the resulting string array.

`--verbose` cannot compose with JSON because its current value rendering is for humans and values can be passable capabilities rather than JSON data.
`--grouped` cannot compose with JSON because its headings are a text presentation and no grouped JSON schema exists.
Both combinations fail before listing with a clear mutual-exclusion diagnostic.

`--follow --json` also rejects `--type`, `--verbose`, and `--grouped`.
Filtering a live removal would require client-side state or an invented event envelope, and serializing the existing raw event stream is the compatibility-preserving contract.

The help text must say "emit the raw name list as JSON" and describe the `--follow --json` form as JSON Lines.
It must identify `--verbose` and `--grouped` as incompatible with `--json`.

## Compatibility

The normal text forms, their order, and the generic directory traversal path do not change.
The snapshot implementation currently ignores `--json`, so there is no functioning snapshot JSON payload to preserve.
Scripts that supplied `--json` but parsed the previous text output must remove that flag or begin parsing JSON.

The existing live JSON Lines behavior is retained, including its event shape and order.
The new validation only makes combinations that could not have produced a coherent JSON contract fail explicitly.
No daemon migration, stored-data migration, or new authority is required.

## Implementation Boundaries

The implementation is localized to `packages/cli/src/commands/list.js` and the `list` command declaration in `packages/cli/src/endo.js`.

1. Resolve the list exactly as today.
2. Apply snapshot-only `--type` filtering before rendering.
3. Serialize the resulting `string[]` with `JSON.stringify` when `json` is set.
4. Keep the current event-by-event serializer for `follow && json`.
5. Validate incompatible option combinations at the CLI boundary, before any remote lookup or subscription.

`packages/daemon/src/directory.js`, `EndoDirectory`, `EndoMount`, and the mount confinement implementation are out of scope.
In particular, this work must not reintroduce a mount-specific `ls` branch: the existing `E(agent).lookup(parsePetNamePath(directory))` path is the uniform mechanism.

## Verification Plan

Add CLI integration coverage using an isolated daemon and a seeded directory.

- Assert that `endo ls --json` parses with `JSON.parse`, returns the expected `string[]`, and has no non-JSON standard-output prefix or suffix.
- Assert that an empty listing yields `[]` and a nested slash-path directory yields the raw names of that directory.
- Assert that `--type --json` returns only matching names while retaining the array-of-strings schema.
- Assert that the equivalent text invocations retain their present line-oriented output and ordering.
- Assert that `--json --verbose`, `--json --grouped`, and each unsupported `--follow --json` modifier fail before opening a subscription.
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
- Does the project want to promise the names-only JSON schema as stable across CLI-major releases, and if so where should that versioning policy be documented?

## Prompt

> Draft a self-contained design for improving the `endo ls --json` interface.
> Treat this as orthogonal follow-up work.
> Establish the intended JSON contract, user-facing behavior, compatibility considerations, implementation boundaries, and verification plan.
> Surface unresolved choices as explicit open questions.
