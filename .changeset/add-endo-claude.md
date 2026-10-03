---
'@endo/claude': major
---

Add `@endo/claude`, an Endo package giving a guest inference from a Claude
subscription through a hermetically confined `claude -p` whose only capability
surface is the MCP projection of one guest formula's granted facet, per
`designs/endo-claude.md`. This is the inverse of the minion.town designs: the
guest thinks *with* Claude, rather than Claude driving a guest from outside, so
Claude is the thing that must be confined.

The public entry is the maker `make(powers, context, options)`, returning a
host-only, non-passable `inferenceProvider` exo whose
`makeGuestInference(guestFormulaId)` resolves and closes over one facet and
returns a per-guest `infer(prompt, { model, cancelled })` exo carrying no
designator (Design Decision 4). The confinement is a *combination* of measured
Claude Code 2.1.232 flags asserted before every spawn — `--bare`,
`--strict-mcp-config`, `--setting-sources ""`, `--tools ""`, and
`--disable-slash-commands`, plus a pinned-version gate — never `--resume` /
`--continue`. The per-guest `--allowedTools` list and the bridge's dispatch check
both derive from one pinned, pre-pruned `tools/list` snapshot (a hardened
null-prototype record, never a `Map`): unsafe, dunder, `__`-bearing, and
code-eval names are pruned at the boundary before pinning, and an unanchored
`mcp__*` never grants. The prompt is delivered on stdin (never a swallowable
positional), the child env is a constructed allowlist (not inherited-minus-one),
and subscriptions pool through an allocator whose admission is reject-with-a-tag
and whose occupancy is freed on every exit path.

This first increment implements the dependency-injected confinement core with
fast-check property tests (the argv construction invariant, the five-flag
spawn-refusal predicate, the env allowlist, the `--tools`/`--setting-sources`
value assertions, the allow-list round-trip, and the credential-pool lifecycle),
plus a DD8 hardened/passable result taxonomy. The `@endo/agent-tools` MCP
adapter has since landed, so this package now reuses its allow-list renderer and
no longer carries the temporary stdio shim. The confined
`@endo/agent-mcp-stdio` hosting seam, a live negative-and-positive confinement
test against a real `claude -p`, a network profile for the DD6 slice (the
`bwrap` slice shares the host network), and the credential-path / entitlement
verifications remain named prerequisites (package README, design Known Gaps).

`runConfinedTurn` requires a `sandbox` option, and `endo-claude-turn` a
matching `--bwrap <path>` flag: `sandbox: { bwrapPath }` runs the confined
`claude` inside a `bwrap` slice, and only an explicit `sandbox: false`
(`--unconfined`) runs it without one.
Inside the slice the daemon socket has no path: `claude` sees only the system
directories, its own installation, the guest's broker socket, its spawn files,
and a writable working directory, with a scratch `HOME`.
`claude`'s directory is granted only when it is a package holding
`package.json`; a lone binary is granted alone.
Nested user namespaces are disabled inside the slice.
The network namespace is still shared with the host.
The slice's building blocks (`makeBwrapSpawn`, `assembleBwrapArgv`,
`resolveSystemMounts`) and the `SliceMount` type are exported for deployment
companions.
