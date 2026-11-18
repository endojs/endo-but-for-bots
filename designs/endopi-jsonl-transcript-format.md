# EndoPi: Pi-Compatible JSONL Transcript Format

| | |
|---|---|
| **Created** | 2026-05-15 |
| **Updated** | 2026-11-17 |
| **Author** | Kris Kowal (prompted) |
| **Status** | In Progress |
| **Parent** | [endopi](endopi.md) |

## Motivation

The maintainer's existing note on [endoclaw](endoclaw.md) § *Persistence
and Memory* names the desired shape: "whatever else we do internally,
message history (sessions) should get stored as Pi-compatible jsonl
files (openclaw and localgpt at least both do this, probably most of the
other too). This is at least for offline operator inspect-ability, but
also the claw itself can use these as a form of memory if within its
workspace."

The Lal reply-chain transcripts ([lal-reply-chain-transcripts](lal-reply-chain-transcripts.md))
already implement Pi's tree shape in memory. The gap is the on-disk
projection: an inspectable, append-only JSONL file the operator can
`cat`, `grep`, and `jq` without going through the daemon.

## Design

Add an on-disk JSONL projection of the Lal transcript graph, with the
file format documented in `packages/coding-agent/docs/session-format.md`
as the reference.

### File layout

Lal keeps its sessions flat at the root of a daemon scratch mount that
its host names `transcripts-for-lal`:

```
<timestamp>_w<hex-of-worker-name>--<uuidv7>.jsonl
```

The timestamp is zero-padded, so lexical order is chronological. The
`w<hex>--` key scopes a file to one worker: hex holds no `-` or `_`, so
no worker's key can appear inside another's file name. A host that does
not use the mount (a future Fae writer, the operator CLI) has no layout
fixed yet; see § Open questions.

One file per session. Each line is a JSON object with a `type` field
(`header`, `message`, `compaction`, `branchSummary`, `custom`). Entries
form a tree via `id` / `parentId` linkage. The on-disk shape is
versioned in the header; v1 is Pi's v3 (named: `tree` + `custom`
unification).

### Entry shape (Pi-compatible subset)

```json
{
  "type": "header",
  "version": 3,
  "sessionId": "01975f...",
  "createdAt": 1715817600000,
  "cwd": "/home/user/proj"
}
{
  "type": "message",
  "id": "01975f...",
  "parentId": "01975e...",
  "message": {
    "role": "user",
    "content": "...",
    "timestamp": 1715817600000
  }
}
{
  "type": "message",
  "id": "01975g...",
  "parentId": "01975f...",
  "message": {
    "role": "assistant",
    "content": [...],
    "api": "anthropic",
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "usage": {...},
    "stopReason": "stop",
    "timestamp": 1715817601000
  }
}
```

Lal's header also carries two `endo:` keys, which Pi readers ignore:
`endo:worker` (the worker's name, checked exactly on resume) and, when
known, `endo:guestId` (the worker guest's id).

Lal records the Endo mail message that starts a round as a `custom`
entry whose `custom` object has `"endo:kind": "endo:mail"`. Beside the
kind it holds ids only, never live references: `messageId`, `replyTo`,
and `number` (the mail number as a decimal string, since it is a
bigint). Each field is present only when known.

Pi-foreign fields (the `details` slot on `toolResult`, Endo-specific
`replyTo` metadata, the `value`-typed messages from
[daemon-value-message](daemon-value-message.md)) go under a `custom`
entry type with an `endo:*` discriminator. Pi's spec already accommodates
extension-namespaced entries through the `custom` role.

### Writer

The writer is a guest-side concern, not a daemon-side concern. The Lal
manager opens a worker's transcript when the worker is created, in the
`transcripts-for-lal` scratch mount, and appends the round's starting
mail and then one line per new agent message after each round. On
restart, the manager resumes the worker's newest session file and seeds
the agent with the messages on its current path. File permissions are
the daemon's concern; this writer sets no mode.

Atomicity: the writer appends whole lines; a partial line at EOF is
recovered on reopen by truncating to the last `\n`. Pi takes the same
approach. The scratch mount has no truncate, so Lal's repair reads the
file and rewrites it whole. That rewrite is not atomic: a crash between
the read and the write can empty the file, and the next open then finds
no header and starts a fresh session.

### Reader

Two readers:

1. **The agent itself.** Lal can resume a session by reading its own
   JSONL file. This is the "claw uses these as a form of memory" path.
   Implementation: a `loadFromJsonl(path)` helper that returns the same
   transcript-node graph the in-memory model uses.

2. **The operator.** A new `endo session list` / `endo session show <id>`
   CLI verb (phase 3, not started) lists and renders sessions. The
   files are usable with off-the-shelf JSONL tooling (`jq`, `fx`).

### Compaction interaction

When [endopi-iterative-compaction](endopi-iterative-compaction.md) runs,
it writes a `compaction` entry into the same file with a
`firstKeptEntryId` pointer, matching Pi's shape. The full history stays
in the file; the in-memory graph is rebuilt with the summary entry in
place of the elided ones.

## Dependencies

| Design | Relationship |
|--------|--------------|
| [lal-reply-chain-transcripts](lal-reply-chain-transcripts.md) | Provides the tree the file projects |
| [endopi-iterative-compaction](endopi-iterative-compaction.md) | Writes `compaction` entries into the same file |
| [daemon-value-message](daemon-value-message.md) | Provides the `value` message shape that maps to Pi's `custom` |
| [endoclaw](endoclaw.md) | Source of the maintainer's directive ("Pi-compatible jsonl files") |

## Phased implementation

1. **Writer + reader for plain message entries.** Sessions can be
   serialized, listed, and resumed from disk. No compaction yet.
2. **`custom` entries for Endo-specific message kinds.** `value`
   messages, daemon-side metadata.
3. **CLI verb (`endo session ...`).** Operator-side inspection.
4. **Compaction integration.** Once
   [endopi-iterative-compaction](endopi-iterative-compaction.md)
   lands.

## Status

Phase 1 ships for Lal, with the `endo:mail` entry as the first piece of
phase 2. The rest of phase 2, Fae, and phases 3 and 4 are not started.

## Open questions

- Lal answers where its files live with the `transcripts-for-lal`
  scratch mount. Still open: whether the operator CLI and other agents
  share that mount, and whether a Pi-compatible path
  (`$HOME/.pi/agent/sessions/`) is offered by symlink or configuration.
- Should `id` be Pi's UUIDv7 or Endo's 256-bit formula ID? UUIDv7 keeps
  Pi tooling working; the 256-bit form is what the daemon already uses
  on `messageId`. Suggest: store both, with the Endo ID under a
  `endo:messageId` field.

## Citation

- [`packages/coding-agent/docs/session-format.md`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session-format.md)
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/session-manager.ts)
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/messages.ts)
- [`packages/ai/src/types.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/types.ts)

## Prompt

> Extracted from [endopi](endopi.md) § *Session model*. The maintainer's
> directive on endoclaw § *Persistence and Memory* names this as the
> shape: Pi-compatible JSONL on disk, both for operator inspect-ability
> and for the agent's own long-term memory.
