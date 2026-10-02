---
'@endo/claude': minor
---

`@endo/claude` now pins Claude Code 2.1.280 instead of 2.1.232, and refuses to spawn any other version.
The confined argv now carries `--permission-mode dontAsk` and `--permission-prompts none`.
`assertConfinedArgv` refuses an argv in which `--tools`, `--setting-sources`, `--permission-mode`, or `--permission-prompts` is missing, carries another value, or appears more than once.
`assertConfinedArgv` also requires `--settings` and `--mcp-config`, and refuses an argv in which either appears more than once.
`assertConfinedArgv` refuses a bare token after the value of any of these six flags, because `--tools` and `--mcp-config` are variadic and would absorb it.
The per-spawn `--settings` file sets `enabledPlugins` to disable the builtin `agents-md` and `telemetry` plugins.
