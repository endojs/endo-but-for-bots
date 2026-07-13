---
'@endo/agentry': minor
'@endo/genie': minor
---

Add a stdio JSONL RPC bridge per `designs/endopi-stdio-rpc-bridge.md`: a
language-agnostic, LF-delimited JSON surface that lets a spawned child (an
IDE plug-in, a CI runner, a Familiar pane) drive a `PiAgent` over stdin and
stdout, mirroring the affordances the browser gets over the daemon's event
stream. The reusable pieces live in `@endo/agentry/rpc` — `makeJsonlDecoder`
/ `encodeRecord` (strict `\n` framing that, unlike Node `readline`, does not
split on `\r` / `U+2028` / `U+2029`), `translateAgentEvent` (raw agent event
to wire event), `makeRpcSession` (a session over a `PiAgent`), `makeRpcBridge`
(the command dispatcher with `id` correlation, single-flight busy tracking,
and `prompt` / `steer` / `abort` / `list_models` / `set_model` / `get_status`
commands), and `serveRpc` (stream wiring). `@endo/genie` ships a spawnable
`rpc.js` entry point that wires a genie agent to those blocks. Diagnostics go
to stderr so stdout carries only protocol records.
