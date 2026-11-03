# EndoPi: Iterative Compaction with Structured Summary

| | |
|---|---|
| **Created** | 2026-05-15 |
| **Updated** | 2026-11-03 |
| **Author** | Kris Kowal (prompted) |
| **Status** | In Progress |
| **Parent** | [endopi](endopi.md) |

## Status

`packages/genie`, whose observer and reflector subagents this section used to
cite as the existing substrate, was retired in `42bc7d516`. Its markdown memory
files never fed a Lal transcript, so nothing here builds on them.

`packages/lal/compaction.js` implements this design over the worker's
`piAgent.state.messages`, except for step 4 of the algorithm. Lal has no session
file yet, and its messages have no entry ids for `firstKeptEntryId` to name, so
writing the `compaction` entry waits on phase 4 of
[endopi-jsonl-transcript-format](endopi-jsonl-transcript-format.md).

Fae has its own compaction in `packages/lal/providers/context-compaction.js`,
over the provider-shaped messages Fae stores.

## Motivation

LLM context windows are finite. Without compaction, a long session
hits the model's limit and either fails outright or silently drops the
oldest messages. The [lal-transcript-memory-management](lal-transcript-memory-management.md)
design enumerates the problem; what is missing is a concrete algorithm.
Pi has one, refined across many releases, and worth importing as the
substrate.

## Design

Add an auto-compaction loop to the Lal transcript model, modeled on Pi's
`packages/coding-agent/src/core/compaction/compaction.ts`.

### Trigger conditions

Auto-compaction triggers when:

```
contextTokens > contextWindow - reserveTokens
```

`reserveTokens` defaults to 16384 (leaving room for the model's
response). Both knobs are environment variables; see [Settings](#settings).

Manual compaction: the host sends the worker a `/compact [instructions]`
message, which `packages/lal/inbox-loop.js` handles. From any other sender it
is ordinary mail for the LLM. Optional instructions focus the summary
("preserve the bug-hunt thread, drop the API exploration").

### Algorithm (from Pi)

1. **Find cut point.** Walk backwards from the newest message,
   accumulating token-count estimates until `keepRecentTokens` (default
   20000) is reached. This is the boundary between "summarize" and
   "keep verbatim".
2. **Extract.** Collect messages from the previous compaction boundary
   (or session start) up to the cut point.
3. **Generate summary.** Call the same LLM the agent is using, with a
   structured prompt asking for:
   - Goals the user expressed
   - Decisions made
   - Open threads
   - Code patterns established
   If a prior summary exists, pass it as iterative context so the new
   summary builds on it rather than starting fresh. Code appends the
   files touched; see [File tracking](#file-tracking).
4. **Append entry (not yet implemented).** Write a `compaction` entry to
   the JSONL session file (per
   [endopi-jsonl-transcript-format](endopi-jsonl-transcript-format.md))
   with `firstKeptEntryId` pointing at the cut point.
5. **Reload.** The in-memory transcript is rebuilt with the summary
   entry in place of the elided range.

### Iterative property

Each compaction's summary takes the *previous* summary as input, not
the *original* messages. This means a long session accumulates one
summary, not N summaries. Pi's structured format makes the summary
parseable enough that the next compaction can merge cleanly.

### File tracking

Pi maintains a cumulative file-operations record across compactions:
even if a file was last touched ten compactions ago, the current
summary still mentions it. The Endo equivalent observes the agent's
`readText`, `writeText`, and `editText` tool calls and tracks which paths
they touched. Code renders the list rather than the model, so it survives
even if a summary omits it.

### Compaction is lossy

Elided messages are not retained anywhere in the worker today: the
transcript lives only in its memory, so compaction discards them. The mail
itself remains in the daemon, where `messageHistory` can read it.

Once step 4 lands, the original messages will remain in the JSONL file (per
[endopi-jsonl-transcript-format](endopi-jsonl-transcript-format.md)).
Compaction will then prune the in-memory window the LLM sees, not the on-disk
record, and an operator or the agent itself can recover detail by re-reading
the JSONL.

## Settings

| Variable | Default | Description |
|---------|---------|-------------|
| `LAL_COMPACTION_ENABLED` | `true` | Auto-compaction on context overflow |
| `LAL_COMPACTION_RESERVE_TOKENS` | `16384` | Reserved for model response |
| `LAL_COMPACTION_KEEP_RECENT_TOKENS` | `20000` | Recent window kept verbatim |
| `LAL_COMPACTION_INSTRUCTIONS` | unset | Optional global instructions appended to the summary prompt |

No per-host settings store exists, so these are read from the daemon's
environment when a worker starts.

## Dependencies

| Design | Relationship |
|--------|--------------|
| [lal-reply-chain-transcripts](lal-reply-chain-transcripts.md) | Provides the transcript graph |
| [lal-transcript-memory-management](lal-transcript-memory-management.md) | Enumerates the problem this design solves |
| [endopi-jsonl-transcript-format](endopi-jsonl-transcript-format.md) | Stores `compaction` entries |

## Out of scope

- **Branch summarization on tree navigation.** Pi has this for `/tree`;
  Endo's reply-chain UI is different. Revisit if `/tree`-style
  navigation lands.
- **Multi-agent context sharing across compactions.** Compaction is per
  transcript; cross-guest context coordination is a separate problem.

## Citation

- [`packages/coding-agent/docs/compaction.md`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md)
- [`packages/coding-agent/src/core/compaction/compaction.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) (auto-compaction logic)
- [`packages/coding-agent/src/core/compaction/utils.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/compaction/utils.ts) (file tracking, serialization)

## Prompt

> Extracted from [endopi](endopi.md) § *Compaction*. The substrate the
> existing `lal-transcript-memory-management` problem statement asks
> for, in algorithmic form, matched to Pi's released implementation.
