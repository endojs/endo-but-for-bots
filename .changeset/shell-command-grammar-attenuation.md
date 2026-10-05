---
'@endo/exo-shell': major
'@endo/daemon': major
'@endo/agent-tools': major
---

Breaking: the Shell capability's `allowedCommands` command-name allowlist is replaced by passable command grammars, and the capability gains first-class attenuation.
`ShellPolicy.commands` is an array of `ShellCommandGrammar` records — fixed literals, typed slots (`string`, lexically checked `relative-path`), unions of options with prefix flags, optional flag-value groups, and an optional variadic rest — matched against the full argv before anything spawns, because a command name cannot attenuate a POSIX command (`find` exposes arbitrary execution through `-exec`; the grammar constrains the argument language instead).
The grammar record and `exec` tool spell the argv tail `argumentVector` rather than abbreviating it as `args`.
`relative-path` rejects absolute paths and `..` segments but does not claim that a symlink target stays inside the workspace; path-bearing commands require the sandbox engine before they are suitable for an untrusted agent.
`Shell.inspect()` now returns `{ commands, usage, timeoutMs, maxOutputBytes }`, where `usage` renders one deterministic usage line per grammar.
New `Shell.attenuate(commands, { timeoutMs? })` derives a narrower Shell that matches its own grammars and then delegates to its parent, so a derived shell can only narrow; attenuation chains and is safe to expose to a guest.
`EndoHost.provideShell` rejects a policy carrying the retired `allowedCommands` key, and a persisted pre-grammar `shell` formula refuses to reincarnate (there is no widening-free translation); re-provision the shell with a `commands` grammar.
`makeShellTool` accepts a `commands` option that embeds the rendered usage lines in the `exec` tool description and pre-matches argvs tool-side; `attenuate` is granter-facing and is deliberately not emitted as a tool.
