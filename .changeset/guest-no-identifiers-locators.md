---
'@endo/daemon': major
'@endo/agent-mcp-stdio': major
'@endo/agentry': patch
'@endo/fae': major
'@endo/floot': major
'@endo/lal': major
'@endo/cli': patch
'@endo/jaine': minor
'@endo/claude-sandbox': patch
---

A guest no longer produces or consumes formula identifiers or locators through its own surface (its `EndoGuest` methods, its mail, and the directories it reaches), so a designation carried as data cannot become authority in a confined guest, and a guest's authority cannot leave it as data.
A capability another principal deliberately delegates to a guest, such as its host bound as `host-agent`, keeps its own surface.
`EndoGuest` drops `identify`, `reverseIdentify`, `locate`, `reverseLocate`, `followLocatorNameChanges`, `listIdentifiers`, `listLocators`, `lookupById`, `lookupByLocator`, `storeIdentifier`, `storeLocator`, `invite`, `accept`, and the internal `deliver` (which let a guest forge an envelope carrying identifiers into its own mailbox and adopt them).
`EndoHost` keeps all of them.
Messages a guest reads replace `from` and `to` with `fromNames` and `toNames`, the guest's own pet names for its correspondents, and withhold `ids`, `promiseId`, `resolverId`, and `valueId`; a guest reaches an attachment or a submitted form value with `adopt`.
A guest's `followNameChanges` withholds each change's `value`.
A directory reaches a guest, through `makeDirectory`, `lookup`, `maybeLookup`, `listValues`, or the resolution of its `request`, only as an `EndoGuestDirectory`, which carries the directory's pet-name and file methods without the identifier and locator methods, and narrows the directories it reaches in turn.
The mailbox hub a guest looks up as `@mail`, and each message hub under it, likewise reaches the guest only as a read-only `EndoGuestDirectory` without the identifier and locator methods.
Channels are outside this scope: a channel message still carries `ids` to every member, guests included.
A guest's `evaluate` resolves every endowment, even a single pet name, by a lookup through the guest, so a directory endowment arrives as its `EndoGuestDirectory` facet.
A host can still traverse a pet-name path into its own guest (for example, `host.copy(['answer'], ['guest-agent', 'answer'])`) to bind a value there.
A guest's own `copy` and `move` cannot traverse a path through another guest it names.
`@endo/daemon` exports the `GuestMessage`, `GuestMessageRevision`, `GuestNameChange`, and `EndoGuestDirectory` types.

`@endo/agent-mcp-stdio` drops the corresponding guest tools.
`@endo/agentry` binds code-mode grants into its guest with `host.copy` rather than `guest.storeIdentifier`.
`@endo/fae` and `@endo/floot` delegate to subagents by pet name: a session factory's or subagent spawner's `spawn()` returns `{ name }` instead of `{ name, locator }`, the spawner binds the parent's `subagent.<name>` edge itself, and `@endo/fae` replaces `SUBAGENT_DIRECTORY` and `isSameFormula` with `SUBAGENT_PET_NAME_PREFIX` and `subagentPetName`. `SubagentSpawner` gains `verify(name)`, which confirms by formula identity that the parent's `subagent.<name>` still names the spawned subagent, and an ask is refused when it does not.
`@endo/lal` drops the `locate` tool, reports `fromNames` and `toNames` in `listMessages`, types `InboxMessage` as `GuestMessage`, and its mock powers drop `identify` and `locate`.
`@endo/cli`'s `inbox` command names a guest's correspondents from `fromNames` and `toNames`.
`@endo/jaine`'s factory `make` accepts `{ env }` and reads `JAINE_FACTORY_AGENT_NAME` from it; its factory binds providers into an agent with `host.copy`, and its router detects its own mail by `@self` among `fromNames`.
`@endo/claude-sandbox`'s session and credentials factories detect their own form by `@self` among `fromNames` and read a submission with `adopt`.

Migration: detect your own mail with `fromNames.includes('@self')` instead of comparing `from` to `locate('@self')`; read a form or value reply with `adopt(messageNumber, 'value', name)` instead of `lookupById(valueId)`; bind a value into a guest from its host (`introducedNames`, or `host.copy(fromPath, [guestAgentName, name])`) instead of `guest.storeIdentifier`; use sturdy refs for durable designation across sessions.
