# UI displays state and sends actions (view not driver)

| | |
|---|---|
| **Created** | 2026-08-10 |
| **Updated** | 2026-09-07 |
| **Author** | kumavis (prompted) |
| **Status** | Proposed |

## What is the problem?

Chat and Floot treated **CapTP connection lifetime** as **turn lifetime**: when
the browser tab closed or the gateway dropped, the reply stream's close watcher
aborted in-flight model and CLI work.
That contradicts the product model: **sessions run on the daemon; the UI is only
a view.**

## Principle

The UI **displays state** that authority elsewhere already owns (daemon,
session guest, persistence).
It **sends actions** (start turn, cancel turn, navigate) as explicit commands.

The UI must **not**:

- Hold streams whose teardown decides whether work continues.
- Run consume loops that must stay alive for turns or subprocesses to finish.
- Treat navigation, unmount, tab close, or gateway loss as cancellation.

**Losing observation must not change intent.**
Only an action (or session or factory teardown) may cancel work.

## Corollaries

| UI | Authority |
|----|-----------|
| Renders snapshots / subscribes to `watch()` | Runs turns, tools, MCP, CLI |
| Calls `startTurn`, `Turn.cancel()` | Drains reply channel locally, persists |
| Detaches on unmount | Continues until terminal or `cancel()` |
| Repaints from `getHistory()` after completion | Owns canonical transcript |

## Anti-patterns

- Returning a **reply reader** to the browser with **`onClose → abort`** on the
  turn channel.
- Running **`iterateReader(sessionReader)` in the browser** for work that must
  survive the tab.
- Mapping **CapTP disconnect** to user **Stop**.

## Positive pattern

```
UI --action--> Session.startTurn / Turn.cancel
UI <--state--- Turn.getStatus / Turn.watch / getHistory
Daemon: local drain + persistence (always)
```

A view stream opens on a **snapshot** of the state the authority has already
accumulated, then carries the events that follow it.
Without that, opening a view is a round trip during which state changes
unobserved, and "subscribe" quietly means "subscribe to whatever happens after
you finish asking".

## Related

- [floot-daemon-owned-turns](floot-daemon-owned-turns.md) — Floot applies this
  principle to chat turns.

## Prompt

Document the design principle that the UI should not drive anything; it displays
state and sends actions.
Apply to Floot session lifecycle vs browser CapTP.
