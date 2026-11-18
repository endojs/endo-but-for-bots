# Fold plan: milestone names to vat and concept names

Unit G1 of the harness review's steps 1 and 2. The naming rule (`designs/milestones.md` "Rules from
the harness review", rule 1; `designs/process.md` section 6) applied to today's milestone-named
modules, exports and test helpers, as a table for the fold unit (F2) to apply. Nothing here has
been renamed. Snapshot: `802bd2767c`, plus G1's commits. Paths are relative to
`packages/thixotrope-harness/`.

## 1. The target shape

- **One guard module per vat, plus one Node-side union**, as the X1 split already started:
  `guest/lib/guards/base.js` (exec) < `guards/session.js` < `guards/factory.js` <
  `guest/lib/interfaces.js` (Node). Each exports the same plain names: `shapes`, `interfaces`,
  `methodNames`, `texts`, `textOf`, each answering its own entries and every entry below it. A vat
  module imports its vat's module, never `interfaces.js`; Node code imports `interfaces.js` only.
- **Node-only guard modules by concept** (`guards/gateway.js`, `guards/subscriptions.js`,
  `guards/secrets.js`): no vat bundles them, and only `interfaces.js` imports them. It merges their
  entries into its plain tables, so Node code writes `shapes.GatewayConfig`, not `m3Shapes`.
- **The latest version under the plain name.** Where a milestone widened or extended an entry
  (`m5Widenings`, `m5Extensions`, `m5FactoryExtensions`, the three Session guards), the widest
  version becomes the plain entry and the others go. Rewire every reader before deleting
  (`m5Widenings.PresetSnapshot` is read by `interfaces-m5-factory.js:222` and
  `interfaces-m5.js:601`; harness.md 3.2).
- **One `limits` and one set of texts per concept**, not per milestone. `lazyTable` and
  `extendInterface` live once, in `guards/base.js`.

## 2. Guard and table modules

| old module | old export | new module | new export | note |
| --- | --- | --- | --- | --- |
| `guest/lib/interfaces-m5.js` | `m5Shapes`, `m5Interfaces` (`Session`, `Composer`, `ExecScope`, `ExecPowersSource`, `SessionGrants`, `ToolGrant`, `SourceReader`) | `guards/session.js` | `shapes`, `interfaces` | entries the exec program reads move to `guards/base.js`; `exec/render.js:366-440` then imports them and its copy (and the equality test) goes. Measure the exec bundle first |
| `interfaces-m5.js` | `m5Widenings`, `m5Extensions` | `guards/session.js` | (folded into `shapes`, `interfaces`) | the widened `TurnStarted`, `RoundRequestSystem`, `SessionServicesEndowments` replace the plain ones; `PresetSnapshot` goes to `guards/factory.js` |
| `interfaces-m5.js` | `m5MethodNames` | `guards/session.js` | `methodNames` | |
| `interfaces-m5.js` | `texts`, `textOf` | `guards/session.js` | `texts`, `textOf` | already the plain names; merged into the session tables |
| `interfaces-m5.js` | `m5ToolArgumentNames` | `guards/session.js` | `toolArgumentNames` | beside `execArgumentNames`, `echoArgumentNames` |
| `interfaces-m5.js` | `objectToolNames`, `packageToolNames`, `reservedLabels`, `powersMethodNames`, `inspectOps`, `grantStates` | `guards/session.js` | unchanged | `inspectOps` to `guards/base.js` if the exec program reads it |
| `interfaces-m5.js` | `lazyTable`, `extendInterface` | `guards/base.js` | `lazyTable`, `extendInterface` | `lazyTable` is a copy of base's: delete it |
| `interfaces-m5.js` | `vocabularyShapes` | (deleted) | | `interfaces.js` answers the union |
| `guest/lib/interfaces-m5-factory.js` | `m5FactoryShapes`, `m5FactoryInterfaces` (`Operator`, `PresetCatalog`, `Preset`, `Inventory`, `InventoryEntry`), `m5FactoryExtensions` | `guards/factory.js` | `shapes`, `interfaces` | the extended `Operator` is the plain one. `PresetSnapshot` exists in both M5 tables: one entry, the widest |
| `interfaces-m5-factory.js` | `m5FactoryMethodNames`, `texts`, `textOf` | `guards/factory.js` | `methodNames`, `texts`, `textOf` | |
| `interfaces-m5-factory.js` | `presetTemplateNames`, `builtInPresetLabels`, `templateObjectKinds` | `guards/factory.js` | unchanged | |
| `guest/lib/interfaces-m3.js` | `m3Shapes` (`Gateway*`), `m3Interfaces` (`GatewayAdmin`, `GatewaySink`, `GatewayOps`, `GatewayBootstrap`), `m3MethodNames` | `guards/gateway.js` (Node only) | `shapes`, `interfaces`, `methodNames` | merged into `interfaces.js`. **Manager part**: `durable.js` and `durable-gateway.js` import it, so this is in the step-4 reinstall batch |
| `interfaces-m3.js` | `m3Texts`, `m3TextOf` | `guards/gateway.js` | `texts`, `textOf` | |
| `interfaces-m3.js` | `m3Limits` | `guest/lib/host-limits.js` | `hostLimits` (gateway entries) | check overlap with `gatewayLimits` in `contract-m3.js` |
| `interfaces-m3.js` | `GATEWAY_KEY`, `withGatewayAdmin`, `m3AgentHostAdminMethods`, `m3AgentHostAdminMethodNames` | `guards/gateway.js` | `GATEWAY_KEY`, `withGatewayAdmin`, `gatewayAdminMethods`, `gatewayAdminMethodNames` | the facet widening is the M3 seam of HR-SYN-2: with the reinstall, `AgentHostAdmin` becomes one guard |
| `guest/lib/interfaces-m4.js` | `m4Shapes`, `m4Interfaces`: `Provider`, `PoolKind`, `Pool*`, `Member*`, `Mark*`, `Served*`, `Effort*`, `Window`, `BankedCredit`, `Accounts*`; `SubscriptionsAdmin`, `PoolMember`, `PoolBackend`, `Accounts`, `AccountsSubscription` | `guards/subscriptions.js` (Node only) | `shapes`, `interfaces` | manager part (`durable.js`, `durable-subscriptions.js`): reinstall batch |
| `interfaces-m4.js` | the secrets entries: `SecretCatalog*`, `SecretKeyInfo`, `Audit*`, `Provenance`; `SecretsAdmin`, `Secret`, `CredentialOps`, `AuditReader` | `guards/secrets.js` (Node only) | `shapes`, `interfaces` | |
| `interfaces-m4.js` | `m4MethodNames`, `m4SinkMethodGuards`, `m4SinkMethodNames` | `guards/subscriptions.js` | `methodNames`, `sinkMethodGuards`, `sinkMethodNames` | the sink guards stay out of the vocabulary (adapter only) |
| `interfaces-m4.js` | `vocabularyShapes` and the re-exports of `limits-m4.js`, `texts-m4.js` | (deleted) | | importers take them from their own module |
| `guest/lib/limits-m5.js` | `limitsM5` | `guest/lib/limits.js` | `limits` | every vat already bundles both files; one table, no alias |
| `guest/lib/limits-m4.js` | `m4Limits` | `guest/lib/host-limits.js` | `hostLimits` | Node and UI only; merging into `limits.js` would put them in every vat bundle (measure before choosing that) |
| `guest/lib/texts-m4.js` | `m4Texts`, `m4TextOf`, `m4Codes`, `codexExplanations`, `poolKinds`, `providerOfKind` | `guest/lib/subscription-texts.js` | `subscriptionTexts`, `subscriptionTextOf`, `subscriptionCodes`, the rest unchanged | the factory vat bundles it without the guards, so it stays its own module |
| `guest/lib/interfaces.js` | `m2Interfaces`, `m2MethodNames`, `m1bShapes`, `m1bInterfaces`, `m1bMethodNames` (views) | (deleted) | | 22 product files read them: rewire to `shapes`, `interfaces`, `methodNames` first |
| `guards/*.js` | `m1aMethodNames`, `m1bMethodLists`, `m2NewMethodNames`, `m2VersionMethodNames`, `methodsOf`, `foldedMethodsOf` | same module | (not exported) | build-time ingredients of `methodNames`; one list per interface in declaration order |
| `guest/lib/vocabulary-tables.js` | `vocabularyTables` | unchanged | unchanged | ends as one entry, `interfaces.js`; the `guards/*` exclusions gain the Node-only modules |

The guard snapshot test (`test/unit/guards-split.test.js`, fixture
`test/fixtures/guard-snapshot-before-x1.json`) and `test/adapter/gateway-vocabulary-tables.test.js`
must stay green through the fold. They pin every guard's digest and the gateway's key and method
sets (258 and 141). A digest that changes for a renamed entry is mapped in the test, as X1 mapped the
M2 fold; it is never re-pinned.

## 3. Other product modules

| old | new | note |
| --- | --- | --- |
| `guest/session/m5-parts.js` `m5Parts` | `guest/session/runtime-parts.js` `runtimeParts` | `makeRuntime` unchanged; HR-SYN-15 later makes the hook tables runtime parts too |
| `config/defaults-m4.js` | `config/subscription-defaults.js` | `subscriptionDefaults` unchanged |
| `resources/agent-host/impl/gateway/contract-m3.js` | `gateway/protocol.js` | exports unchanged (`GATEWAY_PROTOCOL`, `WS_PATH`, `gatewayLimits`, ...) |
| `gateway/extensions/m4-secrets.js` | `gateway/extensions/secrets.js` | the loader reads by listing, so the load order changes. Today it has one file, so no effect |
| `scripts/provision-steps/50-m5-fixtures.js` | `50-object-fixtures.js` | or out of product provisioning altogether (HR-SYN-20, before M6): decide there |
| `perf/_m3-client.mjs` | `perf/_gateway-client.mjs` | |
| `perf/_m4.mjs` | `perf/_subscriptions.mjs` | |
| `perf/creation-m5.perf.mjs` | `perf/session-create-presets.perf.mjs` | perf row names stay: the journal cites them |
| `perf/exec-m5.perf.mjs` | `perf/exec-tools.perf.mjs` | |

## 4. Test helpers and fixtures

These are renamed in place. Step 5 (HR-SYN-16) may then move them to `test/support/` with the same
base names. Test files (`*.test.js`) and benches are HR-SYN-29's rename map, after the lanes
close. They follow the same rule: subject and behaviour (`gateway-vocabulary-tables.test.js`).

| old | new |
| --- | --- |
| `test/unit/_m1a-prelude.js` | `test/unit/_prelude.js` |
| `test/unit/_m1a-count-exos.js` | `test/unit/_count-exos.js` |
| `test/unit/_m2-fake-archive.js` | `test/unit/_fake-archive.js` |
| `test/unit/_m2-queue-session.js` | `test/unit/_queue-session.js` (HR-SYN-14 replaces it with the product's assembly) |
| `test/unit/_m2-w25-session.js` | `test/unit/_archive-session.js` (the same) |
| `test/unit/_m3-fake-powers.js` | `test/unit/_fake-gateway-powers.js` |
| `test/unit/_m4-ui-fakes.js` | `test/unit/_fake-secrets-accounts.js` |
| `test/adapter/_m1b-blobs.js` | `test/adapter/_blobs.js` |
| `test/adapter/_m1b-context.js` | `test/adapter/_context-cache.js` |
| `test/adapter/_m2-archive.js`, `_m2-archive-vat.js`, `_m2-archive-kill-child.mjs` | `_archive.js`, `_archive-vat.js`, `_archive-kill-child.mjs` |
| `test/adapter/_m2-w21b-round.js` | `test/adapter/_provider-round.js` |
| `test/adapter/_m3-captp-client.js` | `test/adapter/_captp-client.js` |
| `test/adapter/_m4-renewal.js`, `_m4-renewal-kill-child.mjs` | `_renewal.js`, `_renewal-kill-child.mjs` |
| `test/integration/_m1a-slice.js` | `test/integration/_served-state.js` |
| `test/integration/_m1b.js` | `test/integration/_content.js` |
| `test/integration/_m1b-exec.js`, `_m1b-pool.js` | `_exec.js`, `_pool.js` |
| `test/integration/_m2-archive-kill.js`, `_m2-lifecycle.js`, `_m2-secrets.js` | `_archive-kill.js`, `_lifecycle.js`, `_secrets.js` |
| `test/integration/_m2-w25.js` | `test/integration/_history-turns.js` |
| `test/integration/_m3-gateway.js` | `test/integration/_gateway.js` |
| `test/integration/_m4.js` | `test/integration/_subscriptions.js` |
| `test/integration/_m5-objects.js`, `_m5-presets.js` | `_objects.js`, `_presets.js` |
| `test/fixtures/m5-objects.js` | `test/fixtures/fixture-objects.js` |
| `test/fixtures/scripts/m1a-slice.js` | `test/fixtures/scripts/slice.js` |
| state template ids `m1a`, `m4`, `m5o`, `m3-300` | `slice`, `subscriptions`, `objects`, `gateway-300` |

Change the template ids together with HR-SYN-20's template-key change, since each id change
rebuilds the template once.

## 5. Order and cost

1. Guest tables (section 2, vat modules): one commit per vat. Each changes that vat's bundle and
   rebuilds the cached templates, so batch them. State the exec, session and factory bundle sizes
   before and after (`node scripts/bundle-guest.mjs`; at `802bd2767c`: exec 63,826 bytes, factory
   164,836, session 214,690).
2. Node-only guard modules (`guards/gateway.js`, `subscriptions.js`, `secrets.js`, `host-limits.js`):
   they reach the manager part, so they land in the one step-4 reinstall, or their manager
   imports keep a one-line re-export until then. That re-export is a seam the fold lists.
3. Product renames (section 3), then test helpers (section 4): mechanical, one commit each, with a
   grep showing no `m[0-9]` file name left outside `designs/` and `JOURNAL.md`.
