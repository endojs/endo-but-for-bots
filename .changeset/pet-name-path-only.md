---
'@endo/daemon': major
'@endo/cli': patch
'@endo/lal': major
'@endo/sandbox': major
'@endo/agentry': major
'@endo/agent-tools': patch
'@endo/platform': patch
'@endo/chat': patch
'@endo/claude-sandbox': patch
'@endo/codex-sandbox': patch
'@endo/conversation-tree': patch
'@endo/demo': patch
'@endo/endo-fs-exec': patch
'@endo/exo-zip': patch
'@endo/fae': patch
'@endo/fetch': patch
'@endo/floot': patch
'@endo/host-shell': patch
'@endo/hosted-agent': patch
'@endo/jaine': patch
'@endo/reminder': patch
'@endo/space-channel': patch
'@endo/space-chat': patch
'@endo/space-endo-mgmt': patch
'@endo/space-floot': patch
'@endo/space-file-explorer': patch
'@endo/space-inventory-graph': patch
'@endo/space-nixos-admin': patch
'@endo/space-whylip': patch
'@endo/spaces-util': patch
'@endo/workflow': patch
---

The daemon's Exo surface (host, guest, directory, mail, channel, and inspector methods) now accepts only a pet-name path, an array of path components.
A bare string is rejected with a `TypeError` asking the caller to retry with an array; a string is never split on a delimiter.
Write `lookup(['counter'])`, not `lookup('counter')`, and `lookup(['subdir', 'value'])`, not `lookup('subdir/value')`.
The `adopt` method's edge name is a message label, not a path, and stays a string.

Migration:
`NameOrPathShape` and `NamesOrPathsShape` in `@endo/daemon/type-guards.js` are replaced by `NamePathArgumentShape` and `NamePathsArgumentShape`, and the `NameOrPath` and `NamesOrPaths` types by `NamePath`.
`@endo/sandbox`'s `provideScratchMount` and `@endo/agentry`'s `NormalizedGitRemoteSpec.credential` now take a pet-name path.
`@endo/lal`'s tool-call arguments that hold a pet-name path are renamed to say so (`petNameOrPath`, `petName`, `recipientName`, `responseName`, `workerName`, `resultName`, and `petNames` become `petNamePath`, `petNamePath`, `recipientNamePath`, `responseNamePath`, `workerNamePath`, `resultNamePath`, and `petNamePaths`); an agent sending an old key must switch.
Name hubs outside the daemon reached by a multi-segment path now receive a one-segment array per step.
The remaining packages pass pet-name paths to the daemon.

Scope: mounts and readable trees, and `@endo/platform`'s portable name-hub guards, still accept a string.

Invitation records whose stored `guestName` is a bare string still revive, read as a one-segment path.
