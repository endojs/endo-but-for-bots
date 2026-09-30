---
'@endo/daemon': major
'@endo/cli': patch
'@endo/lal': patch
'@endo/sandbox': major
'@endo/agentry': major
'@endo/agent-tools': patch
'@endo/platform': patch
'@endo/chat': patch
'@endo/claude-sandbox': patch
'@endo/codex-sandbox': patch
'@endo/conversation-tree': patch
'@endo/demo': patch
'@endo/fae': patch
'@endo/fetch': patch
'@endo/floot': patch
'@endo/hosted-agent': patch
'@endo/jaine': patch
'@endo/reminder': patch
'@endo/space-channel': patch
'@endo/space-chat': patch
'@endo/space-endo-mgmt': patch
'@endo/space-file-explorer': patch
'@endo/space-inventory-graph': patch
'@endo/space-nixos-admin': patch
'@endo/space-whylip': patch
'@endo/spaces-util': patch
'@endo/workflow': patch
---

The daemon's Exo surface (host, guest, directory, mail, channel, and inspector methods) now accepts only a pet-name path, an array of path components, where it used to accept either a single pet-name string or a path.
A bare string is rejected with a `TypeError` that says the string is not a pet-name path, is never split on a delimiter, and that the caller should try again with an array of path components: `lookup(['counter'])`, not `lookup('counter')`, and `lookup(['subdir', 'value'])`, not `lookup('subdir/value')`.

These methods are primarily geared toward agents, and agents are susceptible to the same confusion as people.
Accepting a string invites confusion about whether the string may be a delimited path, and ambiguity about what the delimiter is in the virtual file (and other capability) systems.
Refusing the string makes an agent that passed a delimited string learn that the invocation was invalid and retry with an array of path components.

`NameOrPathShape` and `NamesOrPathsShape` in `@endo/daemon/type-guards.js` are replaced by `NamePathArgumentShape` and `NamePathsArgumentShape`, and the `NameOrPath` and `NamesOrPaths` types are removed in favor of `NamePath`.
`@endo/daemon/type-guards.js` now also exports `NameShape`, `NamePathShape`, `NamePathArgumentShape`, and `NamePathsArgumentShape`, so consumers such as `@endo/lal` validate pet names and pet-name paths against the same matchers as the daemon's interfaces.
The `adopt` method's edge name is a message edge label, not a path, and stays a string.
The `endo` CLI already parses slash-delimited command-line names into arrays; the `cancel`, `request`, `form`, and verbose `list` commands now do so too.

`@endo/sandbox`'s `SandboxPowers.provideScratchMount` now takes a pet-name path (`string[]`) instead of a pet name, and `@endo/agentry`'s `NormalizedGitRemoteSpec.credential` is now always a pet-name path (`string[]`).
`@endo/agentry`'s provisioning and `@endo/platform`'s extended-filesystem modules pass pet-name paths to the daemon, so they require this daemon.
`@endo/agent-tools`' code-mode daemon helpers accept a pet-name path from the model; a string is passed as a single pet name and is never split, so a delimited string reaches the daemon as an invalid name.
`@endo/lal` renames the `petNameOrPath` tool-call argument to `petNamePath`, and it now expects an array of path components; an agent that still sends `petNameOrPath` must switch to the new key.
The remaining packages adapt their calls to the daemon to pass pet-name paths.

Invitation records minted before this change, whose stored `guestName` is a bare string, still revive: the daemon reads such a record as a one-segment path.
The mount and readable-tree surface (`lookup` and `listTree` on mounts) intentionally still accepts a string, as do `@endo/platform`'s portable name-hub guards; the daemon's directories, hosts, and guests are stricter than that portable contract.
Name hubs outside the daemon that are reached by a multi-segment path now receive a one-segment array from each step of the walk, so they must accept an array.
