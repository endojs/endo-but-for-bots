# Endow a new agent with indelible special names on provisioning

| | |
|---|---|
| **Created** | 2026-08-31 |
| **Revised** | 2026-09-04 |
| **Author** | kriscendobot (prompted) |
| **Status** | Proposed |
| **Source** | Narrowed from a broader Claude-agent provisioning proposal at maintainer request ([#1102](https://github.com/endojs/endo-but-for-bots/pull/1102) review) to just the generic daemon mechanism. |

## What is the Problem Being Solved?

A host provisions a guest with `E(host).provideGuest(petName, opts)`. Today the
only way to seed the new agent's namespace is `opts.introducedNames`, which maps
names held by the providing host to **ordinary pet names** in the new agent.
Ordinary pet names are mutable: the recipient can rename or remove them and can
rebind the name to a different capability, so an `introducedNames` entry is a
starting convenience, not a durable grant.

Some deployments need to endow a new agent with a capability the agent can look
up by a well-known name but **cannot remove or rebind** — a *special name* (the
`@`-prefixed names the daemon reserves, e.g. `@self`, `@host`). Special names are
currently daemon-owned and cannot be introduced from a providing host through the
provisioning call.

This design adds one generic mechanism: an `introducedSpecialNames` option on the
provisioning call that maps host-held source names to `@`-prefixed destination
names indelibly bound in the new agent, resolved once at provisioning time,
persisted in the agent's formula, and re-supplied on every daemon reincarnation.

It is deliberately narrow. It defines no package, no factory, no credential
model, and nothing Claude-specific. Any deployment that wants to hand a new agent
a durable capability under a reserved name — a scoped provisioner, an account
status facet, a policy object — uses this one seam. The policy of *which* names to
introduce, and *what* capabilities sit behind them, belongs to the deployment, not
to this daemon feature.

## The option

`introducedSpecialNames` joins `introducedNames` on the existing shared options
bag `MakeHostOrGuestOptions` (`packages/daemon/src/types.d.ts:1432`), which both
`provideGuest` and `provideHost` already accept:

```js
await E(host).provideGuest(childName, {
  introducedSpecialNames: {
    // source name held by the providing host -> @-prefixed name in the new agent
    'some-scoped-cap': '@scoped-cap',
  },
});
```

The keys are names (or name paths) the **providing host** can resolve in its own
pet store; the values are the `@`-prefixed names bound in the **new agent**.

Honoring the option on the shared `MakeHostOrGuestOptions` — and thus for both
`provideHost` and `provideGuest` — is a deliberate widening, not an oversight: a
host is an agent with a pet store just as a guest is, and is equally entitled to
receive an indelible special name. Keeping the option on the shared type avoids
splitting `MakeHostOrGuestOptions` (and the single `MakeHostOrGuestOptions`
normalizer at `packages/daemon/src/host.js:78`) into per-agent-kind variants. If a
later design needs a guest-only or host-only provisioning option, that split is
its work to justify; this mechanism does not require it.

## Resolution, validation, and rejection

Provisioning resolves each source name **once**, against the providing host's pet
store, and records the resulting formula identifier. Validation runs before any
side effect and **rejects** (does not silently degrade) when:

- a destination is not a well-formed `@`-prefixed special name;
- two entries map to the same destination name (duplicate destination);
- a destination collides with a name the daemon owns and manages itself; or
- a **source name does not resolve** in the providing host's pet store.

The last case is the load-bearing departure from `introducedNames`. The existing
`introduceNamesToAgent` helper silently `return`s when a source name is
unresolvable (`packages/daemon/src/host.js:1766-1769`): the ordinary-name path can
afford to no-op because those names are mutable hints. An indelible special name
must not follow that path — a silent skip would mint an agent that is *missing* a
capability the caller believes it endowed and that the agent can never acquire
afterward, the exact failure this mechanism exists to prevent. An unresolvable
source name therefore **fails the provisioning call loudly**, before the agent is
created.

## Persistence and reincarnation

The resolved formula identifiers are stored in the new agent's **formula**, not
merely applied to its live pet store. On every daemon reincarnation the daemon
re-supplies the special-name bindings to the agent from the persisted formula, so
the grant survives restart without the providing host being present or re-running
provisioning.

Because the identifiers now live in the guest (and host) formula, they become part
of the daemon's reachability graph and must be enumerated where every other
formula-held identifier is, or the garbage collector will reclaim a capability the
agent formula still names:

- `extractLabeledDeps` for the `'guest'` (and `'host'`) case
  (`packages/daemon/src/manager.js:733-743`), the hand-maintained table
  `makeFormulaGraph` reads at `manager.js:1145-1149` for reachability and
  `onCollect`; and
- the parallel normalized-formula table in
  `packages/daemon/src/formula-record.js` (the `'guest'`/`'host'` cases) that
  `EndoHost.getFormula` and the inspector read.

Both tables gain the persisted `introducedSpecialNames` identifiers, and a
retention test asserts an introduced capability is still reachable — not collected
— after a daemon restart while the agent formula names it.

## Indelibility

The recipient can **look up** an introduced special name through ordinary naming
machinery (it resolves like any `@`-prefixed name) but cannot **remove** or
**rebind** it, exactly as it cannot remove or rebind daemon-owned special names.
An ordinary `introducedNames` entry offers neither property; that difference is the
entire point of the new option.

## Security invariants

1. `introducedSpecialNames` can only introduce capabilities the **providing host
   already holds and can resolve** in its own pet store; it grants no way to name
   a capability the host cannot itself reach.
2. Destination names are constrained to well-formed `@`-prefixed special names and
   may not collide with daemon-owned names or with each other.
3. An unresolvable source name aborts provisioning; the mechanism never produces
   an agent silently missing an intended indelible capability.
4. An introduced special name is indelible to the recipient — lookup-only, not
   removable or rebindable — and survives daemon reincarnation from the persisted
   formula.
5. Persisted introduced identifiers are enumerated in the daemon's reachability
   and formula-record tables, so an introduced capability is neither collected
   while named nor invisible to the inspector.

## Phased implementation and tests

1. **Guard and normalizer.** Add `introducedSpecialNames` to
   `MakeHostOrGuestOptions` and the shared options normalizer, with the validation
   above. Test malformed destinations, duplicate destinations, daemon-owned-name
   collisions, and — distinctly — an **unresolvable source name that rejects** the
   call rather than skipping.
2. **Provisioning and formula.** Resolve source names once, persist the resulting
   identifiers in the agent formula, and bind them as special (indelible) names in
   the new agent. Test that the recipient can look the name up but cannot remove or
   rebind it, and that provisioning is idempotent for a repeated provide of the same
   agent.
3. **Reincarnation and GC.** Re-supply bindings from the persisted formula on
   restart; extend `extractLabeledDeps` and the formula-record tables. Test
   identity preservation of the introduced capability across a daemon restart and a
   retention test that the capability is not collected while the agent formula names
   it.

## Design decisions

1. **Reuse the existing options bag rather than a new provisioning verb.** The
   grant is a property of provisioning; a separate call would let an agent exist
   for a window without its intended indelible capability.
2. **Make the mechanism generic and Claude-agnostic.** A hard-coded daemon name
   for one deployment's capability would not be reusable; deployments supply their
   own source capabilities and destination names.
3. **Reject an unresolvable source instead of inheriting `introducedNames`'
   silent skip.** Indelibility means the recipient can never recover from a missed
   grant, so the miss must be a loud provisioning failure, not a quiet absence.
4. **Persist resolved identifiers, not source names.** Re-resolving source names at
   reincarnation would depend on the providing host still holding them and would
   let a later rebind on the host silently change the recipient's indelible
   capability.

## Prompt

> Narrow the earlier `@endo/exo-claude-agents` provisioning proposal, at the
> maintainer's request, to just the one generic daemon mechanism it needed:
> endowing a newly provisioned agent with indelible special names supplied on the
> provisioning options bag. Drop the package, factory, credential-lease, and
> lifecycle content; keep the daemon `introducedSpecialNames` seam, its
> validation and rejection rules, persistence across reincarnation, garbage-
> collection reachability, and a phased test plan. Implementation is out of scope.
