# Floot daemon-owned turns

| | |
|---|---|
| **Created** | 2026-08-10 |
| **Updated** | 2026-08-10 |
| **Author** | kumavis (prompted) |
| **Status** | **Complete** |

## Status

Implemented on the session facet:

- **`startTurn(input) -> FlootTurn`** replaces **`converse(input) -> replyReader`**.
- **`startTurnWithSpeech(input, tts, options?) -> { turn, audioReader, speechController }`**
  replaces **`converseWithSpeech`**.
- **`FlootTurn`**: `getStatus()`, `watch()` (disposable view stream), `cancel()`,
  `whenFinished()`.
- Drain loop lives in `packages/floot/src/session-turn.js` on the daemon.
- Chat observes via `watch()`; **Stop** calls **`Turn.cancel()`** only.

See [ui-view-not-driver](ui-view-not-driver.md) for the general principle.

## Problem

After exo-stream phase 3, the browser became the CapTP initiator on the reply
syn chain. Tab close looked like consumer close and aborted CLI turns. Moving
the background loop to module scope in chat fixed **component unmount**, not
**tab death**.

## Design

Turn authority stays on the daemon:

1. `makeReplyChannel()` without wiring **`onClose → abort`** for UI-facing
   streams.
2. Local **`iterateReader(reader)`** on the session worker.
3. **`watch()`** tees events to a separate buffered reader for the UI.
4. **`cancel()`** aborts the signal and calls producer **`close()`**.

TTS **audio** remains a browser-held ephemeral stream; disconnect may stop
piper via the shared exo-stream close watcher (appropriate for media).

## Prompt

Build the correct Floot API without backwards compatibility: daemon-owned
turns, UI view not driver, revert the exo-stream abandoned-chain workaround.
