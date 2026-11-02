---
'@endo/agentry': minor
---

Add the `@endo/agentry/rpc` subpath, a stdio JSONL bridge for driving a `PiAgent` from a spawned child process.
The bridge accepts `prompt`, `steer`, `abort`, `list_models`, `set_model`, and `get_status` commands, one JSON record per line.
Stdout carries only protocol records; diagnostics go to stderr.
