---
'@endo/daemon': major
'@endo/agent-mcp-stdio': major
'@endo/agentry': patch
---

A guest no longer produces or consumes formula identifiers or locators, so a
designation carried as data cannot become authority in a confined guest, and a
guest's authority cannot leave it as data. `EndoGuest` drops `identify`,
`reverseIdentify`, `locate`, `reverseLocate`, `followLocatorNameChanges`,
`listIdentifiers`, `listLocators`, `lookupById`, `lookupByLocator`,
`storeIdentifier`, `storeLocator`, `invite`, `accept`, and the internal
`deliver` (which let a guest forge an envelope carrying identifiers into its
own mailbox and adopt them). `EndoHost` keeps all of them. Messages a guest
reads replace `from` and `to` with `fromNames` and `toNames`, the guest's own
pet names for its correspondents, and withhold `ids`, `promiseId`,
`resolverId`, and `valueId`; a guest reaches an attachment or a submitted form
value with `adopt`. A guest's `followNameChanges` withholds each change's
`value`. A host can still traverse a pet-name path into its own guest (for
example, `host.copy(['answer'], ['guest-agent', 'answer'])`) to bind a value
there.

`@endo/agent-mcp-stdio` drops the corresponding guest tools. `@endo/agentry`
binds code-mode grants into its guest with `host.copy` rather than
`guest.storeIdentifier`.

Migration: detect your own mail with `fromNames.includes('@self')` instead of
comparing `from` to `locate('@self')`; read a form or value reply with
`adopt(messageNumber, 'value', name)` instead of `lookupById(valueId)`; bind a
value into a guest from its host (`introducedNames`, or
`host.copy(fromPath, [guestAgentName, name])`) instead of
`guest.storeIdentifier`; use sturdy refs for durable designation across
sessions.
