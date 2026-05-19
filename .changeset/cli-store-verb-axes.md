---
'@endo/cli': minor
---

Reshape `endo store` around three orthogonal axes: representation
(`--blob` / `--text` / `--json` / `--bigint` / `--tree`), source
(`-p <file>` / `--stdin` / `--literal <s>`), and destination
(`-n <name-path>`).
Extend `endo cat` with the mirrored representation and sink axes
(`--blob` default / `--text` / `--json` / `--tree`;
`--stdout` default / `-p <file>` / `--show`).
Add `endo write <mount-name>/<path>` and
`endo read <mount-name>/<path>` for mutable mount-path writes and reads
(text mode; binary mode reserved).

This is a breaking change to `endo store`'s flag scheme.
The old flags `--text <text>`, `--text-stdin`, `--json <s>`,
`--json-stdin`, and `--bigint <s>` are removed in favor of the
axis-style flags above (e.g. `endo store --text --literal "hello"
-n greeting` instead of `endo store --text "hello" -n greeting`).
Implements `designs/cli-store-verb-text-modes.md`.
