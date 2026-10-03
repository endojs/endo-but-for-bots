---
'@endo/claude': minor
---

`@endo/claude` now pins Claude Code 2.1.280 instead of 2.1.232, and refuses to spawn any other version.
The confined argv now carries `--permission-mode dontAsk` and `--permission-prompts none`.
`assertConfinedArgv` refuses an argv in which `--tools`, `--setting-sources`, `--permission-mode`, or `--permission-prompts` is missing, carries another value, or appears more than once.
`assertConfinedArgv` also requires `--settings`, `--mcp-config`, `--allowedTools`, and `--disallowedTools`, each exactly once with a non-empty value.
`assertConfinedArgv` refuses a repeated `--bare`, `--strict-mcp-config`, or `--disable-slash-commands`, or one that sits in another flag's value slot, and a flag-shaped value for `--model`, `--max-turns`, or `--output-format`.
`assertConfinedArgv` refuses a bare token after the value of any of these eight value-carrying flags, because `--tools` and `--mcp-config` are variadic and would absorb it.
`assertConfinedArgv` refuses any `--flag=value` token and any bare `--` end-of-options token.
The per-spawn `--settings` file sets `enabledPlugins` to disable the builtin `agents-md` and `telemetry` plugins.
