# Confinement for Hosts Delegated to a Guest and Channels a Guest Reads

| | |
|---|---|
| **Created** | 2026-10-01 |
| **Updated** | 2026-10-02 |
| **Author** | Kris Kowal (prompted) |
| **Status** | **Proposed** |
| **Source** | Round-3 panel dispositions on [#1404](https://github.com/endojs/endo-but-for-bots/pull/1404#issuecomment-5938245962) (breaker; purist and wire-watcher) |

## What is the Problem Being Solved?

This design builds on
[#1404](https://github.com/endojs/endo-but-for-bots/pull/1404) ("guests
neither produce nor consume identifiers or locators"), which is not yet
merged.
It uses the daemon's vocabulary: a **formula** is the durable record from
which the daemon reincarnates a capability, a **formula identifier** names
one, a **locator** is the network-addressable form of an identifier, and a
**pet store** maps an agent's pet names to formula identifiers.
[daemon-locator-terminology](daemon-locator-terminology.md) and
[daemon-locator-reference](daemon-locator-reference.md) define them fully.

#1404 establishes distributed confinement for a guest: a designation carried
as data must not become authority, and authority the guest holds must not
leave as data.
It scopes that invariant to the guest's own surface: its `EndoGuest` methods,
its mail (`makeMessageRedactor` in `guest-redaction.js`), and the directories
it reaches (`guestFacetFor` in `directory.js`).
The third review round on #1404 found two routes outside that scope.
Both reach a guest through a value the guest was handed, not through the
guest's own methods.

**Gap 1: delegated hosts.**
The setup scripts of lal, fae, jaine, and claude-sandbox (`setup.js`,
`*-factory-setup.js`, `credentials.js`) create a guest with
`introducedNames: { '@agent': 'host-agent' }`.
That binds the host formula itself into the guest's pet store.
`E(powers).lookup('host-agent')` returns the full `EndoHost`, which has
`identify`, `locate`, `storeIdentifier`, `lookupById`, `invite`, `accept`,
and `provideHost`.
The guest can also `send` the name `host-agent` to another guest, which then
holds the full host too.
floot reaches the same state by a second route: its `host-powers`
provisioning kind (`packages/floot/agent.js`) runs
`E(host).copy(['@agent'], [agentName, petName])`, writing the full host into
a session guest's pet store after the guest exists, and its comment says this
grants the session "full daemon control".
The `nixos-admin` and deploy presets request it on purpose.

**Gap 2: channel messages.**
`EndoChannelMember.listMessages` and `followMessages` return each
`ChannelMessage` with its `ids: FormulaIdentifier[]`, and `post` takes a
`resolvedIds` argument that `channel.js` stores verbatim.
A guest that holds a channel or a member handle therefore reads the formula
identifier of every capability shared in the channel.
It can also post identifiers it never held as capabilities.

The two gaps compound.
A guest reads an identifier from a channel, then calls `lookupById` on its
delegated host.
Each gap alone breaks the invariant, and together they turn a disclosure into
an amplification.

## What the Delegated Host Is Used For

The packages involved are LLM agent factories, each a guest that spawns
further guests:
fae and lal are general chat agents, jaine is a channel-driven agent with a
separate driver guest per task, claude-sandbox runs Claude Code inside a
container with daemon-provided mounts, and floot hosts interactive agent
sessions with configurable capability presets.

The survey covers every non-test site on the #1404 head (`90b4f72604`) that
matches `git grep -nE "'@agent'|introducedNames|E\((hostAgent|host)\)\.(identify|locate|storeIdentifier|storeLocator|lookupById)"`,
plus every guest-side `E(powers).(identify|storeIdentifier|lookupById)`.
The guest-side calls on `llm` (jaine copying `llm-provider` and `agent` into
its driver with `identify` and `storeIdentifier`, and both claude-sandbox
factories resolving a form reply with `lookupById(msg.valueId)`) are already
rewritten by #1404, whose `EndoGuest` interface carries none of those
methods.
They are not a third gap, and this design does not touch them.

| Package | Uses that need a host | Identifier traffic |
|---|---|---|
| fae (`agent.js`, `src/subagent-host.js`, `subagent-spawner.js`, `llm-provider-factory.js`) | `provideGuest`, `makeUnconfined`, `copy`, `has`, `remove`, `cancel`, `storeValue` | `locate(selfName, X)` then `storeLocator([profile, X], locator)` to give a new guest a capability the factory holds. The same pattern forwards `host-agent` to the spawner. |
| lal (`agent.js`) | `provideGuest`, `storeTree`, `copy`, `has`, `makeUnconfined` | `identify('lal-primer')`, used only in a log line |
| jaine (`agent.js`) | `provideGuest`, `makeUnconfined`, `copy`, `has` | `identify(driver)` then `storeIdentifier(['@pins', driver], id)` to pin the driver |
| claude-sandbox (`src/claude-sandbox-factory.js`, `src/claude-credentials-factory.js`, `src/container-mount-bridge.js`) | `provideMount`, `makeDirectory`, `move`, `remove`, `makeUnconfined`, `evaluate`, `storeValue` | `lookupById(capId)` in `provideContainerMountBridge`, where the caller names the mount by identifier |
| floot (`agent.js`, `src/container-mounts.js`) | `copy`, `move`, `remove`, `provideHostPath`, `provideGit`, `provideMount` | `copy(['@agent'], ...)` for the `host-powers` kind. `identify(sessionName, ...path)` mints the `capId` that `container-mounts.js` persists across restarts and replays into `provideContainerMountBridge`. |

Two facts decide the recommendation:

1. **Every surveyed identifier use has a path equivalent.**
   The host namespace already holds the factory guest under its own name
   (`selfName`).
   So `locate` then `storeLocator` is the same as
   `copy([selfName, X], [profile, X])`, which fae already uses to pin
   (`copy([driverResultName], ['@pins', driverResultName])`).
   The one use that persists an identifier is floot's `capId`, which must
   outlive a daemon restart.
   A pet name in a host-held directory also outlives a restart, so floot
   can pin the attached capability under a name derived from its attach key
   and persist that path in place of `capId`.
   The identifiers in these factories are incidental, not essential.
2. **No factory uses peer or bootstrap authority.**
   No factory calls `invite`, `accept`, `provideHost`, `gateway`, `greeter`,
   `sign`, `addPeerInfo`, or `adoptFromLocator`.
   floot's `host-powers` kind is the one deliberate grant of the full host,
   and Phase 4 gives it an explicit opt-in rather than leaving it implicit.

A delegated host still keeps `makeUnconfined`, which runs code with the
daemon host's ambient authority.
An attenuated host is therefore not confined in the isolation sense, and this
design does not claim that it is.
The goal is narrower: no formula identifier or locator flows through a guest,
even a guest trusted to provision.
Without that, the #1404 invariant has an exception for every agent factory
in the repo.
The secondary goal is least authority: a factory should not hold peer,
bootstrap, or host-minting powers it never uses.

## Recommendation 1: A Durable Provisioner Facet

Give a guest a **provisioner** in place of the host.

- **A new formula type, `provisioner`, with one field, `hostId`.**
  Its incarnation is an `EndoProvisioner` exo that forwards a fixed subset of
  `EndoHost` methods to the host.
  The provisioner depends on its host formula, so collecting or canceling
  the host takes the provisioner with it.
- **A new special name, `@provisioner`, on the host.**
  Like `@agent`, it resolves lazily.
  It formulates, then memoizes, the host's single provisioner formula.
  Setup scripts change `introducedNames: { '@agent': 'host-agent' }` to
  `introducedNames: { '@provisioner': 'host-agent' }`.
  The guest-side name stays `host-agent`, so the agents' lookups do not change.
- **A formula, not a lookup-time wrapper.**
  If the full host formula sat in the guest's pet store and only `lookup`
  wrapped it, then `send`, `copy`, and `move` would still forward the full
  host.
  With a formula, the attenuated authority is what the pet store holds.
  It is also all a guest can forward.

### Method Partition

The provisioner exposes these:

- **Namespace paths:** `has`, `list`, `lookup`, `maybeLookup`, `remove`,
  `move`, `copy`, `makeDirectory`, and `followNameChanges` (redacted with
  `redactNameChange`).
- **Storing content:** `storeBlob`, `storeValue`, and `storeTree`.
- **Making things:** `provideGuest`, `provideWorker`, `provideMount`,
  `provideScratchMount`, `provideSubMount`, `evaluate`, `makeUnconfined`,
  `makeChannel`, `makeTimer`, `cancel`, and `help`.

It withholds these:

- **Identifiers and locators:** `identify`, `locate`, `reverseLocate`,
  `reverseIdentify`, `storeIdentifier`, `storeLocator`, `lookupById`,
  `lookupByLocator`, `locateWithHints`, `adoptFromLocator`,
  `followLocatorNameChanges`, and the content-locator guards.
- **Peers and bootstrap:** `invite`, `accept`, `greeter`, `gateway`, `sign`,
  `identity`, `getPeerInfo`, `addPeerInfo`, `listKnownPeers`, and
  `followPeerChanges`.
- **Minting authority:** `provideHost` and `provideHostPath`.
- **The host's mailbox:** `listMessages`, `followMessages`, `send`, `adopt`,
  `request`, `reply`, `resolve`, `reject`, `dismiss`, `dismissAll`, `submit`,
  `form`, `deliver`, `editMessage`, `messageHistory`, `endow`, and
  `sendValue`.
  A factory has its own guest mailbox through `powers`.
- **Operator surfaces:** `diagnostics`, `listRetentionPaths`,
  `followRetentionPaths`, `allowHistoryRewrite`, and the git and HTTP
  credential providers and controllers.

Every provisioner method that returns a capability passes its result through
`guestFacetFor`: `lookup`, `maybeLookup`, and `list`, and also the makers,
so `makeChannel` returns a channel's guest facet and `provideGuest` returns
the same guest a lookup would.
That way a path that names a host returns that host's provisioner, and a
channel returns its guest facet (Recommendation 2).
The provisioner also refuses `@`-special names in paths, except `@main` (the
worker that `makeUnconfined` targets) and `@pins`.
Without that rule, `lookup('@endo')` or `lookup('@agent')` would hand back
the bootstrap or the full host.
A refused name throws from both `lookup` and `maybeLookup`: `maybeLookup`
returns `undefined` only for a name that is absent, so a policy refusal is
never mistaken for absence.

The interface guard in `interfaces.js` is the exposed list, and nothing
else is reachable.
A test enumerates `HostInterface`'s methods and fails on any method that is
in neither list above, so a method added to `EndoHost` must be classified
before it ships.

### Provisioning changes

| Package | Change |
|---|---|
| all four setup scripts | `'@agent'` becomes `'@provisioner'` in `introducedNames` |
| fae | Every `storeLocator([profile, X], await E(hostAgent).locate(selfName, X))` becomes `copy([selfName, X], [profile, X])`. Forwarding `host-agent` to the spawner copies the provisioner. `provisionFaeAgent` returns a pet name, not a `locator`. |
| lal | Drop `identify('lal-primer')`. Its only use is a log line. |
| jaine | The pin becomes `copy([driverResultName], ['@pins', driverResultName])`, as in fae. |
| claude-sandbox | `provideContainerMountBridge({ key, capId, mode })` becomes `provideContainerMountBridge({ key, mountPath, mode })`, where `mountPath` is a pet-name path in the bridge holder's namespace, and the bridge resolves it with `lookup` in place of `lookupById`. |
| floot | `container-mounts.js` pins each attached capability under a name derived from its attach key and persists that path in place of `capId`, then passes it as `mountPath`. The `host-powers` kind copies `@host-unattenuated` (Open Question 3) in place of `@agent`. |

Once the five packages migrate, the daemon refuses to write a host formula
into a guest's pet store, whether through `introducedNames` or through a
`copy`, `move`, or `storeValue` whose destination is in the guest's
namespace.
Full delegation would then need an explicit, separately named opt-in (see
Open questions).

## Recommendation 2: A Guest Facet for Channels and Members

Register guest facet makers for `EndoChannel`, `EndoChannelMember`, and
`EndoChannelInvitation` exos in the same registry that `guestFacetFor` reads.
That registry is `guestFacetMakers` in `directory.js`.
It could become a shared `guest-facets.js` once directories are not its only
client.
Then a guest that looks up a channel, adopts one from mail, or reaches one
through a provisioner holds only the facet.

The facet behaves like this:

- **`listMessages` and `followMessages`** pass each message through a new
  `redactChannelMessage` in `guest-redaction.js`.
  It deletes `ids` and keeps `names`, so the guest still sees that a message
  carried an attachment and what its sender called it.
  `memberId`, `replyTo`, and the pedigree member IDs are channel-local
  designations, not formula identifiers, so they stay.
- **`post`** refuses a non-empty `resolvedIds` or `petNamesOrPaths`.
  A guest can post text, replies, edits, and reactions, which is everything
  jaine and fae do (`jaine/agent.js`, `fae/endo-skill.js`).
- **Methods that return an exo** pass their results through `guestFacetFor`.
  That covers `createInvitation`, the invitation's `join`, and the channel's
  `join`.
  So a member reached through a guest-held invitation is also a guest facet.
- **Messages are not stored differently.**
  The facet is a view.
  Host-side readers (`space-channel`'s `showValue(undefined, message.ids[i])`,
  and `share-modal`'s repost) keep the full member and see no change.

The redaction closes three concrete hazards:

- **Disclosure.**
  A guest learns the identifier of every capability shared in the channel.
  It can carry that identifier out as text to its LLM provider, to mail, or
  into channel prose.
- **Laundering.**
  A guest posts an identifier it learned but never held, in `resolvedIds`.
  A host-side reader's UI then reifies it with `showValue` as though the
  guest had shared that capability.
  This forges the attachment's attribution.
- **Compounding with Gap 1.**
  A channel identifier fed into a delegated host's `lookupById` becomes
  authority.

A guest cannot yet share or receive a capability through a channel.
Neither is a regression: no guest does either today.
Both appear under Open questions.

## Ownership Map

| Boundary | Mechanism | Policy | Durable state | Lifecycle and commit | Value crossing |
|---|---|---|---|---|---|
| host → provisioner (daemon) | `provisioner` formula and incarnation in `host.js` / `daemon.js` | the method partition, as an interface guard in `interfaces.js` | the `provisioner` formula record (`hostId`), memoized under `@provisioner` | the daemon formula graph, where the provisioner depends on its host and is collected with it | an `EndoProvisioner` exo |
| provisioner → guest (daemon) | `introducedNames` in `provideGuest` | the setup script chooses `@provisioner`, and the daemon refuses a host formula in a guest's pet store | the guest's pet-store entry, which holds the provisioner's id | unchanged | a pet name in the guest's namespace |
| factory → new agent (fae, lal, jaine, claude-sandbox, floot) | path `copy` through the provisioner | each factory decides which capabilities each new guest receives | the new guest's pet store | the factory, as today | pet-name paths, never locators |
| channel → guest (daemon) | `guestFacetFor` and `redactChannelMessage` | `ids` withheld, posts carry no ids | none, because the facet is a view and `channel.js`'s message store is unchanged | unchanged, owned by `channel.js` | a redacted `ChannelMessage` |

Naming check: the outer concept "guest" names only the boundary facets.
The inner channel mechanism (`postInternal`, the function in `channel.js`
that appends a message) and the message store keep their
names and semantics.

## Phasing

1. **Channel guest facet** (Recommendation 2).
   It stands alone, is small, and changes no consumer.
2. **The provisioner formula, its special name, and its interface.**
   This step is additive, and `@agent` still works.
3. **Migrate fae, lal, jaine, claude-sandbox, and floot** to `@provisioner`
   and path copies, including the mount-bridge `mountPath` change and floot's
   persisted mount paths.
4. **Refuse a host formula in a guest's pet store**, by introduction or by
   copy, with floot's `host-powers` moved to the opt-in from the open
   questions.

Each phase is one build PR against `llm`, the bot fork's development branch.
Phases 1 and 2 can run in parallel.

## Test Plan

- **Guest channel facet:** a guest looks up a channel holding a message with
  `ids`.
  `listMessages` and `followMessages` return it without `ids` but with
  `names`.
  `post` with `resolvedIds` throws.
  A member joined through a guest-held invitation is also redacted.
  A host reading the same channel still sees `ids`.
- **Provisioner surface:** every withheld method is absent from the
  interface guard.
  `lookup(['@endo'])`, `lookup(['@agent'])`, and the same paths through
  `maybeLookup` throw.
  `makeChannel` returns a guest facet whose messages carry no `ids`.
  A `HostInterface` method in neither list fails the partition test.
  `lookup` of a path that names a host returns a provisioner.
  A guest that `send`s `host-agent` to a peer guest gives that peer a
  provisioner.
- **Restart:** a guest's `host-agent` still resolves to the same provisioner
  after the daemon restarts, and a floot container mount re-attaches from
  its persisted path.
- **Migration:** the existing fae subagent, lal primer, jaine pin, and
  claude-sandbox container-mount, and floot container-mount tests pass on
  `@provisioner`, and their mock
  powers offer no identifier methods.
- **Host refusal:** after phase 4, `copy(['@agent'], [guestName, 'x'])`
  throws, and floot's `host-powers` works only through the opt-in.
- **Compounding regression:** a guest holding both a channel and a
  provisioner cannot turn a channel attachment into a capability.

## Alternatives Considered

- **Keep the full host, and document a guest holding `host-agent` as
  unconfined.**
  This costs nothing, but it leaves the #1404 invariant false for every LLM
  agent factory in the repo.
  It works as an interim statement until phase 3 lands, not as the end state.
- **Wrap the host only at the guest's `lookup`.**
  Rejected: `send`, `copy`, and `move` would still forward the full host
  formula.
- **Remove `ids` from the channel protocol for every member.**
  This is cleaner, and it is the shape a universal "agents neither produce nor
  consume identifiers" rule would take.
  But it rewrites every `space-channel` view and the edit queue.
  It is left as an open question.

## Open Questions

1. Should the provisioner keep `makeUnconfined` and `evaluate`?
   Keeping them preserves every factory as it is, but leaves ambient
   authority with the guest.
   Withholding them would require pre-bound caplet makers (a caplet is a
   confined program the daemon runs as a worker), where the host
   binds one specifier per factory, and that is a larger redesign.
2. Is the method partition right?
   In particular, should the git and HTTP credential providers, `makeChannel`,
   and `provideMount` (which reaches the daemon host's filesystem) be on the
   provisioner?
3. What should the explicit opt-in for full delegation look like?
   floot's admin presets need one, so refusal without an opt-in would remove
   a shipped capability.
   A separately named special name, such as `'@host-unattenuated'`, keeps
   the grant visible in every setup script and preset that uses it.
4. Should the guest-side name stay `host-agent`, or should the migration
   rename it `provisioner` so the code says what the guest holds?
5. Should a guest be able to post a capability to a channel by pet name?
   The guest facet would then resolve `petNamesOrPaths` against its guest's
   namespace in the daemon, and that requires a facet keyed to its guest.
6. Should a guest be able to adopt a capability attached to a channel
   message, for example with a member-facet `adopt(messageNumber, edgeName,
   petName)` that writes into the guest's namespace?
7. Should channels drop `ids` for every member, which is the universal form of
   Recommendation 2, and move host-side views to resolve attachments through
   the member instead of by identifier?

## Related

- [daemon-locator-reference](daemon-locator-reference.md)
- [daemon-locator-terminology](daemon-locator-terminology.md)
- [lal-fae-form-provisioning](lal-fae-form-provisioning.md), which introduced
  `'@agent' -> 'host-agent'`.
- [endoclaw-channel-bridges](endoclaw-channel-bridges.md)
