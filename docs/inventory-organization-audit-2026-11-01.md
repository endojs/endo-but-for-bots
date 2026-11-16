# Tokyo inventory organization audit — 2026-11-01

## Findings

The initial read-only snapshot had **85 root names: 13 system names and 72 ordinary names**.
The directory/profile pass inspected 289 named entries in total, plus selected Floot profile and
configuration metadata.
It is not a recursive census of every session journal, stored object, or published file.
The initial audit made no changes; the subsequent authorized migration is recorded below.
Capability locators, formula identifiers, secret values, and published asset URLs are omitted.

The most important distinction is between the current Floot **provider backend** and the older
**Fae provider-configuration wizard**:

- The current backend is OpenRouter, configured for `deepseek/deepseek-v4.1-flash`.
  It has two retained sessions: one internal session with zero turns and one user session with
  **two completed turns**, created November 1 at 10:16 JST.
  It is demonstrably used and should be kept.
- Fae Codex has 16 retained sessions in this snapshot.
  The voice preset selects `fae-codex` / `gpt-5.6-sol`.
  Other presets leave the backend selection unset; those defaults still allow the provider backend.
- No root objects named `default`, `provider`, `fae`, `fae-factory`, or `jaine-factory` were found.
  The old `llm-provider-factory` handle, controller, and profile do remain.
  They were separate from `floot/llm-provider`; their root bindings have now been removed.
- Lal is still auto-provisioned, but none of the three saved spaces or inspected Floot grants
  targets it. Whylip also has no saved space, and its provider module is absent from both the
  current deployed release and the local checkout.
  Lal has now been removed from startup and root inventory. Whylip was explicitly retained by user request; the later shared-backend repair is recorded below.
- All four Ironhorse review workflows are marked `done`.
  The 24 review-support names are the largest coherent cleanup target.
  Their five workspace directories may contain valuable project data and should be retained.
- Four recovery directories hold seven retired workspace guests and eight old renewal-owner
  objects. They are deliberate archives, not evidence that those services are still in use.
- The only explicitly identified demo at the root is the shared browser counter we recently built.
  It is retained; the proposed move to `demos/shared-counter` has not been applied.

## Applied cleanup and revised scope

The user requested removal of legacy items and historical Floot recovery workspaces, retention of
Whylip, and organization of Ironhorse under `projects/ironhorse/`.
The applied operation reduced root inventory from **85 to 40 names**, and the Floot controller
profile from **91 to 90 names**.

- Removed eight Lal / old Fae configuration-wizard root bindings and their automatic startup setup.
- Removed four superseded Iroh service/worker bindings and the redundant current-service root alias.
  The canonical `@nets/iroh` service and its current worker retain their identities.
- Removed four historical root recovery-directory bindings and the profile's
  `retired-workload-20261006` archive binding.
- Moved 24 review helper bindings to `projects/ironhorse/reviews/<review>/<leaf>` and five
  workspace directories to `projects/ironhorse/workspaces/<existing-name>`.
- Preserved all four Whylip root bindings, all 18 current sessions, credential capabilities,
  publishing state, active backends, and the workflow service.
- Changed review provisioning to create directly under a project-owned directory, with an optional
  `projectPath` for grouping multiple reviews under the same project.

These removals detach inventory bindings; they do not cancel dormant services, revoke externally
held capabilities, or claim physical erasure of formula records or native workspaces.
Private recovery evidence is retained outside the inventory.
The migration validates identities and destination collisions before mutation, copies before
removing project sources, and can resume after an interrupted move.
A second live run was a no-op with unchanged counts and protected identities; daemon, relay, and
web server remained healthy.
The legacy-startup and review-provisioning fixes are deployed; no daemon restart was needed.
The subsequent secrets and installation-storage migration is recorded below; other proposed moves remain pending.

### Secrets and installation-storage migration

The follow-up migration reduces root inventory from **40 to 37 names** (**85 to 37 overall**).
The three former root bindings now live at:

| Former root | Actual retained path |
| --- | --- |
| `forgejo-credential` | `@pins/installations/nixos/forgejo-credential` |
| `openrouter-auth` | `@pins/installations/credentials/openrouter-auth` |
| `environments` | `@pins/installations/environments` |

The Forgejo password is now a Secrets Manager entry at `secrets/forgejo-password`.
Its bootstrap assignment has been removed from the service environment file.
Both post-restart checks verified unchanged capability identities, all 18 sessions,
all seven published routes, the existing OpenRouter secret, and both Floot grants.
The final restart ran without the Forgejo bootstrap variable in either the service file or process;
the credential remained available and the root count stayed at 37.
The hosted Chat browser smoke test passed bookmark migration, peer relay connection, and rendering.
The environment runner still uses the same native storage and owner.

Regression coverage includes daemon restart with no bootstrap credential, current-material reads,
rotation/revocation during pending work, durable local revocation, foreign-secret rejection,
fresh setup, setup reruns, conflicting destinations, and interrupted directory migration.
The asset installation cleanup was completed on November 3, as recorded below.
The broader backend/profile consolidation remains pending, including the bounded receipt cleanup
identified below.

### Asset installation migration — 2026-11-03

Moved the seven asset bindings into one public collection and retained installation storage.
Root inventory is **31 names**, down from 37 before this pass and 85 at the initial audit.
The public collection contains only `assets/publisher`.

| Former root | Actual retained path |
| --- | --- |
| `asset-server` | `assets/publisher` |
| `asset-server-admin` | `@pins/installations/assets/admin` |
| `asset-server-root` | `@pins/installations/assets/service` |
| `asset-server-host` | `@pins/installations/assets/state` |
| `asset-server-host-handle` | `@pins/installations/assets/state-handle` |
| `asset-site-fs` | `@pins/installations/assets/site-files` |
| `asset-site-route` | `@pins/installations/assets/site-route` |

Removed the three redundant direct asset pins after confirming they named the same objects.
All seven capabilities retain their identities; Floot keeps its existing local `asset-server` grant.
The state host's contents, static-site route, and seven published responses were unchanged after
migration, including their URLs and response-body hashes.
All 21 sessions present at this pass were retained.
No publication was recreated or revoked.
Verification passed again after normal daemon startup: root count remained 31, all seven response
bodies and URLs were unchanged, and no legacy asset names or direct pins reappeared.

Fresh setup creates these destinations directly; the shared backend binding helper uses the new
publisher path while retaining the local grant name and support for custom publisher names.
The host setup, durability-check tool, explicit old-code rollback tool, and operator documentation
use the same layout.
Rollback restores legacy state aliases before an older setup runs; it refuses to discard service
bindings if stopping the listener fails.

Regression tests cover fresh setup and rerun, legacy identity preservation, interrupted moves,
conflicting destinations and pins, invalid destination parents, missing state, a source changing
during copy, publisher grants, and explicit rollback with both successful and failed stops.
The remaining root cleanup concerns workflow, backend, network-worker, and saved-UI internals.

### Workflow, backend, network, and Chat storage — 2026-11-03

Applied after an adversarial review/fix/rereview loop. Root inventory fell from
31 to 24 bindings. All 21 Floot sessions and all seven published pages were
preserved; page response contents remained identical.

- Workflow guest and handle moved to `@pins/installations/workflow/`. The public
  service and its direct startup pin retained their original identities.
- Claude, Codex, and OpenCode installation directories moved intact under
  `@pins/installations/`. Native owners, credential holders, and session-record
  directories were preserved. Expected setup-created account/backend facades
  were checked against their original powers and configuration fingerprints.
- The active Iroh worker moved to `@pins/installations/iroh/worker`; `@nets/iroh`
  retained its identity.
- Saved Chat spaces moved to
  `@pins/installations/chat/<self-handle-number>/spaces`, preserving the directory
  and its saved records. The host scope prevents collisions when hosts share pins.
- Scheduled storage maintenance now reads the private backend paths. The actual
  configured maintenance program was updated and all prior image pins verified.

Fresh setup uses serialized directory provisioning, including across hosts that
share a parent. Tests cover concurrent clients and hosts, identity-preserving
adoption, alias cycles, conflict recovery, and an unrelated host remaining usable
while a session marker read stalls. Expired submission receipts are pruned during
ordinary queue operations without discarding queued messages or valid receipts.

A deployment packaging error briefly made source/public directories too restrictive,
causing Chat to return 403. A separately reviewed directory-only permission repair
restored access. The daemon's 15 setup jobs succeeded; final identity, asset,
maintenance, and browser rendering checks passed. Subsequent overlays install source
files individually and preserve live directory permissions.

An older client recreated an empty root `spaces` directory after migration.
After browser reload and a reviewed Android update, Floot was verified stopped
before retiring that empty directory. All three original saved settings and their
canonical directory retained their identities. Root inventory returned to 24 names.
The Android update includes both the bundled Chat UI and the local daemon's new
directory-provisioning API for local mode. Remote mode loads the hosted Chat UI
from the configured URL; it does not use the bundled UI. Reopening an APK can
reload that hosted UI, but cannot update its bundled local runtime.
After installation, the physical Pixel reconnected with its existing configuration:
the live WebView completed loading, rendered five space nodes, and showed no
reconnecting overlay or application error. Root inventory stayed at 24 names with
no legacy `spaces` entry. Local Android compatibility was checked by compilation
and exact embedded runtime inspection, not a separate on-device local-mode turn.

### Floot session controls — 2026-11-03

The controller profile fell from **92 to 37 names**: 55 session-control bindings
moved into their existing private per-session directories. All 21 sessions,
4,473 existing journal records, session control identities, and pending queue
contents were preserved. The one previously errored session remained unchanged;
all 20 previously ready sessions stayed ready. Four registry snapshots remain.

Startup republished seven stateless service/configuration bindings. Verification
allowed only those exact producers, checking their original formula identities,
module paths, powers, workers, and configuration fingerprints. Other profile
bindings remained identity-checked. No credential values appear in this report.

Tests cover concurrent adoption, partial migration and retry, conflicting
destinations, interrupted session creation, terminal cleanup, lost acknowledgments,
receipt expiry, and bounded namespace growth. The full Floot suite passed 933
tests. An additional 153 focused tests passed against the exact Tokyo deployment
artifact, based on Tokyo's existing source without unrelated branch features.
Independent reviewers approved each deployment and corrective operation.

### Remaining service and project bindings — 2026-11-03

After a separate adversarial review/fix/rereview loop, six more root bindings
were moved without restarting the daemon. Root inventory fell from **24 to 18**.

- Workflow service now lives at `@pins/installations/workflow/service` beside
  its retained state and handle. The direct `@pins/workflow-service` startup pin
  remains. Existing deployment grants retain their service capability. Only the
  root Workflows saved setting's service path changed; its other fields and the
  other saved settings were preserved.
- The four legacy Whylip objects now live together under
  `@pins/installations/whylip/{service,state,state-handle,worker}`. This move
  preserved their identities and dependencies; it did not repair the missing
  legacy provider module.
- The counter now lives at `projects/shared-browser-counter/counter`.
  Its formula and running worker were retained. A live before/after check
  confirmed its value/revision did not reset; concurrent increments were allowed.

Regression checks cover interrupted copies/settings writes/removals, retry,
conflicting destinations, changed settings, required ownership directories, and
unrelated inventory preservation. All 21 Floot sessions and seven published pages
remain unchanged. The new Chat default workflow path was published only after
the private destination and migrated navigation passed verification.

### Whylip shared-backend repair — 2026-11-03

Whylip provisioning now uses the standard Fae factory and the same hosted Codex
inference source used by Floot. It has no custom inference backend or separate
credential. The default recipe selects `gpt-5.6-sol`; an existing validated recipe
is retained on subsequent setup runs. The small books service provisions books
and their saved navigation; it does not perform inference.

User-facing books live at `whylip/<book>`. Factory, recipe, agent owner, pins,
book handles, and retry records stay under `@pins/installations/whylip/`.
The four consolidated legacy objects remain private and are not used by the new
installation. Creating a book again preserves its agent and conversation.
Saved Whylip entries use stable book-based identities, and creation rejects
unrelated or conflicting preexisting objects instead of silently adopting them.

Startup provisions Whylip after the shared backend and restores private agent
mailbox pins. Real-daemon regressions exercise cold restart, shared subscription
history, concurrent creation, interrupted responses, retry identity, and release
cleanup. The interface compares mailbox locators by node and formula identity,
ignoring routing hints, and uses mailbox messages to retain reply threading.

The live repair exposed and fixed a shared terminal-response bug: after a
successful reply and dismissal, a valid empty model completion was treated as
an error. A second error reply then targeted the dismissed message and stranded
the durable turn fence. The shared adapter now distinguishes validated empty
completion from a failed stream; Fae accepts it only after a successful reply to
the current message, retains reasoning and usage, and does not strand the fence
when diagnostic delivery fails. Malformed streams and unanswered empty responses
remain errors.

The failed unpublished test installation is retained under
`@pins/installations/whylip/retired-fixtures/terminal-v1/`, with both agent revival
pins removed. Its original receipts, tree, and mailbox are unchanged. Fresh
private workers use the same retained recipe and shared inference source.
Exactly two old idle workers remain as bounded diagnostic evidence until an
orderly daemon restart. Targeted cancellation/revival was excluded after a
real-daemon regression exposed a separate disposal failure; this is not the
normal setup or update path.

Live verification completed two consecutive shared-backend turns with the
agent's active-turn flag cleared after each. A third question submitted through
the published browser interface rendered its narrative and scene, and reloading
preserved all three conversation pairs without JavaScript errors. Book creation and saved navigation
retries preserved identities. Root inventory is **19 names**, including the new
public `whylip` collection; all **21 Floot sessions**, **seven published pages**,
and the counter's identity/value/revision were preserved without restarting the
daemon. Local validation passed the production build, root lint, 84 subscription
adapter tests, 46 focused Fae loop/provider tests, 11 real-daemon durability tests,
and seven Whylip interface tests. Adversarial review covered the source fixes,
recovery operation, and exact deployment artifacts.

### What the environment runner does

`@pins/installations/environments/runner` is the host's Podman environment factory (formerly `environments/runner`).
It creates the command-execution Shell handed to applicable Floot presets, projects an Endo
workspace into the container, applies command/output/time limits, and enforces the selected
`off` or `public-internet` network policy within the operator's ceiling.
It owns native startup and cleanup, while sessions receive the restricted Shell capability.
It is active infrastructure, not an old demo or a conversation agent.
Keep it; its installation state now lives beneath the existing `@pins` retention namespace.
Its native runtime storage, owner, and granted runner identity are unchanged.

Change sites: [setup-environments.js](/Users/xyz/Development/endo-but-for-bots/packages/hosted-agent/setup-environments.js),
[environment-runner.js](/Users/xyz/Development/endo-but-for-bots/packages/hosted-agent/src/environment-runner.js),
and [development-environment.js](/Users/xyz/Development/endo-but-for-bots/packages/floot/src/development-environment.js).

### Credential ownership

OpenRouter's key **already is a Secrets Manager secret** at `secrets/openrouter-auth`.
Floot's `llm-auth-secret` points to that secret capability.
The former root `openrouter-auth` was a separate managed-credential wrapper with delegation/revocation
methods, not another copy of the secret.
It now lives at `@pins/installations/credentials/openrouter-auth`, preserving both wrapper and secret identities.
Fresh setup creates the wrapper there directly without a temporary root alias.

Forgejo now uses `secrets/forgejo-password`, imported once from the bootstrap environment.
The existing Git credential is retained at `@pins/installations/nixos/forgejo-credential`.
Its durable formula references the secret rather than storing password material.
Each transport operation reads current material; rotation and revocation fence pending reads and
abort in-flight operations.
Its existing capability identity, audience restriction, and Floot grants are preserved.
Setup refuses conflicting bindings, changed backing, and revoked or missing installed secrets.
A setup rerun cannot overwrite a user rotation or resurrect a deleted installed secret.

These three moves use actual directory paths under `@pins/installations`, not a new ordinary root
name or a `private:` path syntax.
Both repositories now document this layout, and the Nix default setup order runs workflows before
provider/Floot setup without installing legacy Lal or the Fae configuration wizard.

Change sites: [setup-forgejo-credential.js](/Users/xyz/Development/endo-but-for-bots/packages/space-nixos-admin/setup-forgejo-credential.js),
[manager.js](/Users/xyz/Development/endo-but-for-bots/packages/daemon/src/manager.js:4034),
[git-credential.js](/Users/xyz/Development/endo-but-for-bots/packages/exo-git/src/git-credential.js),
and [machine-admin-setup.js](/Users/xyz/Development/endo-but-for-bots/packages/floot/machine-admin-setup.js).

### Audit of the 91-name Floot profile

| Category | Names before cleanup | Finding |
| --- | ---: | --- |
| Daemon special bindings | 11 | Normal host infrastructure. |
| Session guest/handle pairs | 36 | Exactly two for each of the 18 retained sessions; no orphan pair found. |
| Backend, account, publisher, admin, configuration, and credential grants | 19 | Factory dependencies; should not be offered as a shareable mixed-authority collection. |
| Environment admin capabilities | 10 | All correspond to retained sessions; needed for shell ownership and cleanup. |
| Pending submission records | 7 | All queues are empty. Five retain 14 expired deduplication receipts; two retain four current receipts. |
| Registry snapshots | 4 | Intentional recovery window, bounded at four; not an unbounded journal leak. |
| Private sessions directory | 1 | Exactly 18 children, all registered; 4,370 direct journal/attachment/state bindings across those session directories. |
| Account bindings directory | 1 | Four account-binding records. |
| Voice preferences | 1 | One shared settings record. |
| Historical workload archive | 1 | 462 old bindings; its profile binding has now been removed. |
| **Total** | **91** | **90 after removing the archive binding.** |

The historical archive contained 444 marshal records, seven Git workspaces, six environment-admin
facets, two session guests, two handles, and one old inference capability.
It was an intentional migration archive, not current session growth.
The current session directories were counted without reading their transcript payloads.
Their record count reflects retained history; this audit does not establish a byte-size bound or
prove every individual history record remains necessary.

Two follow-up improvements are warranted:

1. Consolidate each session's handle, guest, environment administration, pending queue, and private
   records under one owned session directory; update create/reopen/delete and failed-setup recovery
   together. Keep administrative facets out of the session guest's grants.
2. Prune expired duplicate-submission receipts durably when reading/maintaining an idle queue.
   The current code prunes on new submissions, so inactive sessions can retain expired receipts.
   Preserve unexpired receipts and queued/interrupted messages; test restart and duplicate retries.

Change sites: [agent.js](/Users/xyz/Development/endo-but-for-bots/packages/floot/agent.js),
[pending-queue.js](/Users/xyz/Development/endo-but-for-bots/packages/floot/src/pending-queue.js),
[development-environment.js](/Users/xyz/Development/endo-but-for-bots/packages/floot/src/development-environment.js),
and [private-turn-storage.js](/Users/xyz/Development/endo-but-for-bots/packages/floot/src/private-turn-storage.js).

## Inventory policy

Ordinary top-level names are for objects or collections the user would plausibly hand to an agent
or friend in chat.
An installed system's internal dependencies should not receive ordinary top-level names.
Grouping helpers into a directory is necessary when there are many of them, but does not by itself
make that directory a useful top-level inventory item.

Publish useful capabilities, such as a publisher, assistant, workflow service, project, or shared
counter, independently from their implementation state.
Keep workers, handles, profiles, configuration, credentials, journals, and recovery records in
storage owned by the installed system; expose management through its settings or diagnostics.
A public collection must not accidentally grant access to its owner's private state.
Directory placement is organization, not a security boundary: do not share a mixed directory of
public facets and administrative capabilities.
Existing daemon special names remain infrastructure conventions, with a separate inventory view
for inspecting them.

In the mapping below, `private:owner/path` means a logical destination in the owner's private
storage, **not a proposed root directory or an existing daemon path syntax**.
The implemented credential and environment destinations use `@pins/installations/<owner>/…`.
Other logical destinations still require producer/consumer and recovery updates; a cosmetic inventory filter is insufficient.
Ordinary paths denote intentional user-facing objects or collections.
Users may explicitly expose a normally internal capability when they want to share it.

The current backend's user-facing name should identify both the agent and service:
**Fae · OpenRouter**, with the selected model shown separately.
Keep `provider` as a compatibility identifier where persisted sessions require it, rather than
using it as the user's object name.
The current backend descriptor actually displays `Fae`; `provider` is its internal ID.
Naming work belongs in `listBackends()` and model/session/preset label consumers, and must derive
the service name from configuration rather than hard-code OpenRouter for every installation.
See [agent.js](/Users/xyz/Development/endo-but-for-bots/packages/floot/agent.js:6159).

## Meaning of the recommendations

**Move** means rebind the existing object identity under a directory, update path-based consumers,
and then remove the old name. It does not mean recreate the object.
**Remove duplicate name** means remove only a redundant alias, never cancel the underlying object.
**Retirement candidate** means evidence favors removal, but first check the noted dependency or
retention condition. None of these rows authorizes deletion.

A formula dependency graph is not a usage log.
The snapshot contained 197 loaded/reachable formula nodes and 235 structural edges; it is not a
complete account of dormant persisted references, mutable namespace bindings, mail, external
clients, or all session endowments.
An empty incoming-edge list therefore does not establish safe deletion.
No mailbox contents, Git working-tree contents, or historical conversations were inspected.

## Initial root mapping with revised destinations

This table retains the initial 85-name census; the applied-cleanup section above records current status.
Change-site codes identify the producer, consumer, or migration work in the next section.
For retired groups, the proposed archive path is the destination while retention is reviewed;
a permanent deletion can replace that move once the stated conditions are satisfied.

| Current root name | Category | Recommended action | Destination | Evidence / condition | Change site |
| --- | --- | --- | --- | --- | --- |
| `@agent` | System | Keep | `@agent` | Daemon infrastructure; special aliases are not ordinary clutter. | P0 |
| `@endo` | System | Keep | `@endo` | Daemon infrastructure; special aliases are not ordinary clutter. | P0 |
| `@host` | System | Keep | `@host` | Daemon infrastructure; special aliases are not ordinary clutter. | P0 |
| `@mail` | System | Keep | `@mail` | Daemon infrastructure; special aliases are not ordinary clutter. | P0 |
| `@main` | System | Keep | `@main` | Daemon infrastructure; special aliases are not ordinary clutter. | P0 |
| `@nets` | System | Keep | `@nets` | Daemon infrastructure; special aliases are not ordinary clutter. | P0 |
| `@node` | System | Keep | `@node` | Daemon infrastructure; special aliases are not ordinary clutter. | P0 |
| `@none` | System | Keep | `@none` | Daemon infrastructure; special aliases are not ordinary clutter. | P0 |
| `@pins` | System | Keep | `@pins` | Daemon infrastructure; special aliases are not ordinary clutter. | P0 |
| `@planes` | System | Keep | `@planes` | Daemon infrastructure; special aliases are not ordinary clutter. | P0 |
| `@registry` | System | Keep | `@registry` | Daemon infrastructure; special aliases are not ordinary clutter. | P0 |
| `@secrets` | System | Keep | `@secrets` | Daemon infrastructure; special aliases are not ordinary clutter. | P0 |
| `@self` | System | Keep | `@self` | Daemon infrastructure; special aliases are not ordinary clutter. | P0 |
| `asset-server` | Publishing | Move; preserve object | `assets/publisher` | Publisher is granted to Floot; state host retains seven published routes. | P1 |
| `asset-server-admin` | Publishing | Move; preserve object | `@pins/installations/assets/admin` | Publisher is granted to Floot; state host retains seven published routes. | P1 |
| `asset-server-host` | Publishing | Move; preserve object | `@pins/installations/assets/state` | Publisher is granted to Floot; state host retains seven published routes. | P1 |
| `asset-server-host-handle` | Publishing | Move; preserve object | `@pins/installations/assets/state-handle` | Publisher is granted to Floot; state host retains seven published routes. | P1 |
| `asset-server-root` | Publishing | Move; preserve object | `@pins/installations/assets/service` | Publisher is granted to Floot; state host retains seven published routes. | P1 |
| `asset-site-fs` | Publishing | Move; preserve object | `@pins/installations/assets/site-files` | Publisher is granted to Floot; state host retains seven published routes. | P1 |
| `asset-site-route` | Publishing | Move; preserve object | `@pins/installations/assets/site-route` | Publisher is granted to Floot; state host retains seven published routes. | P1 |
| `claude-sandbox` | Backend | Move under installation owner; retain capabilities | `private:claude-sandbox/` | Grouped, but still installation internals; publish only deliberately shareable facets. Codex has 16 retained sessions; Claude/OpenCode have none in this snapshot but remain configured options. | P2 |
| `codex-sandbox` | Backend | Move under installation owner; retain capabilities | `private:codex-sandbox/` | Grouped, but still installation internals; publish only deliberately shareable facets. Codex has 16 retained sessions; Claude/OpenCode have none in this snapshot but remain configured options. | P2 |
| `controller-for-lal` | Legacy Lal | Retirement candidate | `private:lal/controller (if kept)` | No saved space or inspected Floot grant targets Lal. Still auto-provisioned; mailbox usage was not audited. | P7 |
| `controller-for-llm-provider-factory` | Legacy provider wizard | Retirement candidate | `private:model-setup/controller (if kept)` | Old Fae configuration wizard; no root default/fae factory instance found. Still auto-provisioned. | P7 |
| `controller-for-nixos-admin` | Administration | Move; update consumers | `nixos/controller` | Granted to Floot as nixos-admin. | P6 |
| `environments` | Backend | Moved; same runner | `@pins/installations/environments/` | Contains the environment runner granted to Floot. | P2 |
| `floot` | Floot | Keep; organize children | `floot/` | Current chat, voice, presets, and session owner. | P3 |
| `forgejo-credential` | Administration | Migrated to secret backing; moved | `@pins/installations/nixos/forgejo-credential` | Granted to Floot and used by machine-admin setup. | P6 |
| `iroh-network-before-serialization-20261024` | Old network recovery | Retirement candidate | `private:network/archive/iroh-network-before-serialization-20261024 (until verified)` | Two superseded service/worker pairs; neither service is the active @nets/iroh binding. Check old users before cancellation. | P10 |
| `iroh-worker` | Old network recovery | Retirement candidate | `private:network/archive/iroh-worker (until verified)` | Two superseded service/worker pairs; neither service is the active @nets/iroh binding. Check old users before cancellation. | P10 |
| `iroh-worker-serialized-20261024` | Old network recovery | Retirement candidate | `private:network/archive/iroh-worker-serialized-20261024 (until verified)` | Two superseded service/worker pairs; neither service is the active @nets/iroh binding. Check old users before cancellation. | P10 |
| `iroh-worker-serialized-v2-20261024` | Active network worker | Move; keep alive | `private:network/iroh/worker` | Worker of the active Iroh service. Keep workers outside @nets, whose entries are network services. | P10 |
| `ironhorse-b10-recovered-20261014` | Project data | Move; retain data | `projects/ironhorse/workspaces/ironhorse-b10-recovered-20261014` | Contains Git/mount/remote/source capabilities; finished review does not prove all work was pushed. | P11 |
| `ironhorse-harness-recovered-20261016` | Project data | Move; retain data | `projects/ironhorse/workspaces/ironhorse-harness-recovered-20261016` | Contains Git/mount/remote/source capabilities; finished review does not prove all work was pushed. | P11 |
| `ironhorse-push-muy3ne05-ksg3ow-1` | Project data | Move; retain data | `projects/ironhorse/workspaces/ironhorse-push-muy3ne05-ksg3ow-1` | Contains Git/mount/remote/source capabilities; finished review does not prove all work was pushed. | P11 |
| `ironhorse-review-muy3ne05-ksg3ow-1` | Project data | Move; retain data | `projects/ironhorse/workspaces/ironhorse-review-muy3ne05-ksg3ow-1` | Contains Git/mount/remote/source capabilities; finished review does not prove all work was pushed. | P11 |
| `ironhorse-review-resume-muy3ne05-ksg3ow-1` | Project data | Move; retain data | `projects/ironhorse/workspaces/ironhorse-review-resume-muy3ne05-ksg3ow-1` | Contains Git/mount/remote/source capabilities; finished review does not prove all work was pushed. | P11 |
| `lal` | Legacy Lal | Retirement candidate | `private:lal/assistant (if kept)` | No saved space or inspected Floot grant targets Lal. Still auto-provisioned; mailbox usage was not audited. | P7 |
| `lal-primer` | Legacy Lal | Retirement candidate | `private:lal/primer (if kept)` | No saved space or inspected Floot grant targets Lal. Still auto-provisioned; mailbox usage was not audited. | P7 |
| `llm-provider-factory` | Legacy provider wizard | Retirement candidate | `private:model-setup/handle (if kept)` | Old Fae configuration wizard; no root default/fae factory instance found. Still auto-provisioned. | P7 |
| `network-service-iroh-serialized-20261024` | Old network recovery | Retirement candidate | `private:network/archive/network-service-iroh-serialized-20261024 (until verified)` | Two superseded service/worker pairs; neither service is the active @nets/iroh binding. Check old users before cancellation. | P10 |
| `network-service-iroh-serialized-v2-20261024` | Active network alias | Remove duplicate name only | `@nets/iroh (already present)` | Exact same object identity as @nets/iroh. Do not cancel the object. | P10 |
| `opencode-sandbox` | Backend | Move under installation owner; retain capabilities | `private:opencode-sandbox/` | Grouped, but still installation internals; publish only deliberately shareable facets. Codex has 16 retained sessions; Claude/OpenCode have none in this snapshot but remain configured options. | P2 |
| `openrouter-auth` | Credentials | Moved wrapper; preserved secret | `@pins/installations/credentials/openrouter-auth` | Managed-credential wrapper, distinct from the active secrets/openrouter-auth binding. Audit outstanding grants before retiring wrapper; keep secret. | P4 |
| `profile-for-lal` | Legacy Lal | Retirement candidate | `private:lal/profile (if kept)` | No saved space or inspected Floot grant targets Lal. Still auto-provisioned; mailbox usage was not audited. | P7 |
| `profile-for-llm-provider-factory` | Legacy provider wizard | Retirement candidate | `private:model-setup/profile (if kept)` | Old Fae configuration wizard; no root default/fae factory instance found. Still auto-provisioned. | P7 |
| `profile-for-whylip-codex-provider` | Optional Whylip | Keep; repair provisioning | Keep existing binding | Explicitly retained by user; missing source module still needs a repeatable provisioner. | P8 |
| `retired-floot-workspaces-20260924-journal` | Historical recovery | Archive; deletion candidate after retention review | `private:recovery/archive/retired-floot-workspaces-20260924-journal` | Explicitly retired state: seven old workspace guests across three directories and eight old renewal-owner objects in the fourth. | P12 |
| `retired-floot-workspaces-20260924-journal-extra` | Historical recovery | Archive; deletion candidate after retention review | `private:recovery/archive/retired-floot-workspaces-20260924-journal-extra` | Explicitly retired state: seven old workspace guests across three directories and eight old renewal-owner objects in the fourth. | P12 |
| `retired-floot-workspaces-journal-20260930` | Historical recovery | Archive; deletion candidate after retention review | `private:recovery/archive/retired-floot-workspaces-journal-20260930` | Explicitly retired state: seven old workspace guests across three directories and eight old renewal-owner objects in the fourth. | P12 |
| `retired-renewal-owners-20260924-journal` | Historical recovery | Archive; deletion candidate after retention review | `private:recovery/archive/retired-renewal-owners-20260924-journal` | Explicitly retired state: seven old workspace guests across three directories and eight old renewal-owner objects in the fourth. | P12 |
| `review-connection-handle-ironhorse-b10` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-b10/handle` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-connection-handle-ironhorse-b10-recovered` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-b10-recovered/handle` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-connection-handle-ironhorse-b10-resume` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-b10-resume/handle` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-connection-handle-ironhorse-harness-recovered-20261016` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-harness-recovered-20261016/handle` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-connection-ironhorse-b10` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-b10/connection` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-connection-ironhorse-b10-recovered` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-b10-recovered/connection` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-connection-ironhorse-b10-resume` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-b10-resume/connection` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-connection-ironhorse-harness-recovered-20261016` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-harness-recovered-20261016/connection` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-connection-powers-ironhorse-b10` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-b10/powers` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-connection-powers-ironhorse-b10-recovered` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-b10-recovered/powers` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-connection-powers-ironhorse-b10-resume` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-b10-resume/powers` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-connection-powers-ironhorse-harness-recovered-20261016` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-harness-recovered-20261016/powers` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-project-ironhorse-b10` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-b10/project` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-project-ironhorse-b10-recovered` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-b10-recovered/project` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-project-ironhorse-b10-resume` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-b10-resume/project` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-project-ironhorse-harness-recovered-20261016` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-harness-recovered-20261016/project` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-reader-ironhorse-b10` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-b10/reader` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-reader-ironhorse-b10-recovered` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-b10-recovered/reader` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-reader-ironhorse-b10-resume` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-b10-resume/reader` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-reader-ironhorse-harness-recovered-20261016` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-harness-recovered-20261016/reader` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-resolver-ironhorse-b10` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-b10/resolver` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-resolver-ironhorse-b10-recovered` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-b10-recovered/resolver` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-resolver-ironhorse-b10-resume` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-b10-resume/resolver` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `review-resolver-ironhorse-harness-recovered-20261016` | Completed review | Archive; delete helper cluster after reference check | `projects/ironhorse/reviews/ironhorse-harness-recovered-20261016/resolver` | Corresponding workflow is done. Remove the whole owned helper cluster only after checking retained workflow/session references. | P11 |
| `secrets` | Credentials | Keep | `secrets/` | Six secret bindings; do not infer obsolescence from names. No secret values were read. | P4 |
| `setup-lal` | Legacy Lal | Retirement candidate | `private:lal/setup-handle (if kept)` | No saved space or inspected Floot grant targets Lal. Still auto-provisioned; mailbox usage was not audited. | P7 |
| `shared-browser-counter` | Recent demo | Move; keep | `demos/shared-counter` | Recent user-requested shared-runtime proof, with a published frontend. Removing its last retention could break that app. | P13 |
| `spaces` | UI configuration | Move under Chat owner; preserve configuration | `private:chat/spaces/` | Three saved spaces: Secrets, Floot, Workflows. | P5 |
| `whylip-cloud-provider-worker` | Optional Whylip | Keep; repair provisioning | Keep existing binding | Explicitly retained by user; missing source module still needs a repeatable provisioner. | P8 |
| `whylip-codex-provider-handle` | Optional Whylip | Keep; repair provisioning | Keep existing binding | Explicitly retained by user; missing source module still needs a repeatable provisioner. | P8 |
| `whylip-openai-luna` | Optional Whylip | Keep; repair provisioning | Keep existing binding | Explicitly retained by user; missing source module still needs a repeatable provisioner. | P8 |
| `workflow-agent` | Workflow | Move; preserve state | `private:workflow/state` | Saved Workflows space and Floot deployment factories depend on this service; four historical runs remain. | P9 |
| `workflow-powers` | Workflow | Move; preserve state | `private:workflow/handle` | Saved Workflows space and Floot deployment factories depend on this service; four historical runs remain. | P9 |
| `workflow-service` | Workflow | Move; preserve state | `workflow/service` | Saved Workflows space and Floot deployment factories depend on this service; four historical runs remain. | P9 |

## Existing directories and internal organization

| Current subtree | Observed contents | Recommendation |
| --- | --- | --- |
| `@nets/` | Three services: Iroh, loopback, browser WebSocket relay | Keep canonical service bindings. Do not put workers or archive directories here. |
| `@pins/` | Five pins: three publishing facets/service, Floot controller, workflow service | Keep retention; update pin naming with the corresponding service migration. Pins are not disposable duplicate objects. |
| `@planes/` | Empty | Keep the system namespace. |
| `floot/` | 12 names, including controller, host/profile, STT/TTS, provider config, and two deployment factory triplets | Publish selected assistant, speech, and deployment capabilities in the public Floot collection. Move configuration, controller handle/profile, and factory powers into `private:floot/`, preserving identities and updating consumer paths and recovery checks. Do not grant the public collection access to private state. |
| `floot/controller-profile/` | 91 names; 36 names with the session prefix, including two bindings per session; configured backend, publisher, admin and environment grants | This is the factory's own namespace, not root pollution. Keep public endowment names stable. Consider a `sessions/` child for session bindings; keep journals private and update all factory lifecycle/recovery code together. A `retired-workload-20261006` entry also merits archive review. |
| `claude-sandbox/` | 19 names | Move installation internals under `private:claude-sandbox/`; expose a shareable inference capability separately if wanted. Keep while Claude is enabled. |
| `codex-sandbox/` | 27 names | Active backend; preserve identities while moving internals under `private:codex-sandbox/`. Group accounts, broker, and sessions inside that owner; update setup reuse logic. |
| `opencode-sandbox/` | 10 names | Move internals under `private:opencode-sandbox/`. Keep this configured option unless intentionally disabling it; zero retained sessions does not justify deleting credentials. |
| `environments/` (former root) | One runner | Moved intact to `@pins/installations/environments/`; Floot grants use the retained runner. |
| `asset-server-host/` | System names plus seven retained route/target pairs | Move only the host's root binding to `@pins/installations/assets/state`; leave its internal route records intact. Do not expose token-bearing record names in documentation or a general inventory report. |
| `secrets/` | Six entries: two Claude subscriptions, two Codex subscriptions, OpenRouter, and cloud administration | Keep secret entries and their stable names. Group managed service wrappers separately; do not recreate or rotate secrets as part of namespace cleanup. |
| `spaces/` | Secrets, Floot, Workflows | Move saved UI configuration to `private:chat/spaces/`. Workflows currently stores the path `workflow-service`; migrate it to `workflow/service` with the service move. Floot paths already use `floot/`. |
| Five Ironhorse workspace directories | Git, mounts, remotes, and sometimes source capabilities | Move intact under `projects/ironhorse/workspaces/`. Check unpushed commits and working-tree changes before any data deletion. |
| Four retired recovery directories | Seven old workspace guests and eight renewal-owner objects | Group under `private:recovery/archive/`; assign an explicit retention policy. Current scanned bindings do not alias these archived entries, but that alone does not prove they are unreferenced. |

## Change sites

The scope column distinguishes a live inventory migration from source changes that prevent clutter
from returning. Producer fixes must land before removing names that startup scripts recreate.

### P0 — System

No cleanup migration for special names. Preserve standard daemon conventions.

[host.js](/Users/xyz/Development/endo-but-for-bots/packages/daemon/src/host.js:2457).

### P1 — Host setup + consumer paths + live migration

Completed November 3: path-based setup preserves the state host, publisher and admin identities, removes redundant direct pins, and updates Floot publisher grants and operational rollback/health helpers. Static-site files are internal; only the publisher belongs in the public collection.

[assets.mjs](/Users/xyz/Development/endo-host/setups/assets.mjs:30); [floot-factory-setup.js](/Users/xyz/Development/endo-but-for-bots/packages/floot/floot-factory-setup.js:275); [rollback-asset-server.mjs](/Users/xyz/Development/endo-host/ops/rollback-asset-server.mjs:1).

### P2 — Backend setup only if reorganizing or disabling

Move installation internals into owner storage and explicitly publish any useful public facets. Update backend discovery and consumer paths. Disable the corresponding Nix backend configuration and reconcile grants before retiring an optional backend. Do not cancel active Codex resources.

[common.nix](/Users/xyz/Development/endo-host/hosts/common.nix:67); [hosted-setup.js](/Users/xyz/Development/endo-but-for-bots/packages/hosted-agent/src/hosted-setup.js:225); [hosted-backend-setup.js](/Users/xyz/Development/endo-but-for-bots/packages/hosted-agent/src/hosted-backend-setup.js:1); [setup-environments.js](/Users/xyz/Development/endo-but-for-bots/packages/hosted-agent/setup-environments.js:1).

### P3 — Floot setup + factory lifecycle + live migration

Use directory paths directly; remove obsolete comments and root staging/move patterns. Nested session organization must change create/reopen/delete and ownership recovery together.

[floot-factory-setup.js](/Users/xyz/Development/endo-but-for-bots/packages/floot/floot-factory-setup.js:275); [machine-admin-setup.js](/Users/xyz/Development/endo-but-for-bots/packages/floot/machine-admin-setup.js:24); [agent.js](/Users/xyz/Development/endo-but-for-bots/packages/floot/agent.js:1); [private-turn-storage.js](/Users/xyz/Development/endo-but-for-bots/packages/floot/src/private-turn-storage.js:1).

### P4 — Credential wrapper provisioning + live migration

Implemented: retain the existing Secrets entries and move the OpenRouter wrapper by identity into installation storage. Fresh provisioning names the wrapper there directly and captures the secret read capability without temporary root bindings. Forgejo adds one secret entry.

[managed-credentials.js](/Users/xyz/Development/endo-but-for-bots/packages/hosted-agent/src/managed-credentials.js:38); [credentials.js](/Users/xyz/Development/endo-but-for-bots/packages/fae/src/credentials.js:127); [providers.mjs](/Users/xyz/Development/endo-host/setups/providers.mjs:1).

### P5 — Saved UI config + defaults

Update stored paths as services move; also update discovery/default paths used for new spaces. Do not remove the saved spaces.

[spaces-gutter.js](/Users/xyz/Development/endo-but-for-bots/packages/chat/spaces-gutter.js:655); [add-space-modal.js](/Users/xyz/Development/endo-but-for-bots/packages/chat/add-space-modal.js:1).

### P6 — Admin producers + consumer grants + live migration

Expose the NixOS controller as a deliberate administration capability; keep its Forgejo credential in private NixOS storage. Update machine-admin grant lookups and both provisioning scripts.

[setup.js](/Users/xyz/Development/endo-but-for-bots/packages/space-nixos-admin/setup.js:67); [setup-forgejo-credential.js](/Users/xyz/Development/endo-but-for-bots/packages/space-nixos-admin/setup-forgejo-credential.js:32); [machine-admin-setup.js](/Users/xyz/Development/endo-but-for-bots/packages/floot/machine-admin-setup.js:24).

### P7 — Startup policy + legacy producers + completed root retirement

Host startup now provisions Floot without installing Lal or the old configuration wizard. If retained, create directly in private:lal and private:model-setup. Provider form submissions must store configs under a selected providers directory rather than root. The completed operation removed their root bindings; it did not revoke externally held capabilities or erase mailbox data.

[providers.mjs](/Users/xyz/Development/endo-host/setups/providers.mjs:29); [setup.js](/Users/xyz/Development/endo-but-for-bots/packages/lal/setup.js:28); [setup.js](/Users/xyz/Development/endo-but-for-bots/packages/fae/setup.js:24); [llm-provider-factory.js](/Users/xyz/Development/endo-but-for-bots/packages/fae/llm-provider-factory.js:144); [setup-llm-provider.js](/Users/xyz/Development/endo-but-for-bots/packages/chat/setup-llm-provider.js:1); [fae-factory-setup.js](/Users/xyz/Development/endo-but-for-bots/packages/fae/fae-factory-setup.js:63).

### P8 — Keep Whylip; repair its provisioner

No tracked creator for these exact Whylip names was found.
The live formula names `packages/fae/subscription-provider-service.js`, which is absent from both the current local checkout and deployed release; its repair needs an explicit owner.
This does not prove a retained older source path or an already-running instance is unavailable, but it makes the cluster a deployment-maintenance liability. Keep the cluster and its existing identities. Add a repeatable setup with an explicit owner destination; update any Whylip consumer path only as part of that repair.

[whylip-component.js](/Users/xyz/Development/endo-but-for-bots/packages/chat/whylip-component.js:1).

### P9 — Workflow setup + stored space + Floot grants + live migration

Keep the shareable `workflow-service` and direct `@pins/workflow-service` boot pin. Move only its guest and handle to `@pins/installations/workflow/{state,state-handle}`, preserving identity. Saved Workflows navigation and deployment-factory grants therefore retain their existing service path.

[setup.js](/Users/xyz/Development/endo-but-for-bots/packages/workflow/setup.js:22); [machine-admin-setup.js](/Users/xyz/Development/endo-but-for-bots/packages/floot/machine-admin-setup.js:24); [spaces-gutter.js](/Users/xyz/Development/endo-but-for-bots/packages/chat/spaces-gutter.js:655).

### P10 — Network setup + one-off recovery cleanup

Keep @nets/iroh and its current v2 worker. Remove only the redundant v2 root alias. Retire the two older service/worker pairs after checks. Make worker creation use private network storage and service publication use @nets directly. Exact dated recovery names appear to be one-off operations, not these normal setup scripts.

[iroh.mjs](/Users/xyz/Development/endo-host/setups/iroh.mjs:15); [setup-iroh.js](/Users/xyz/Development/endo-but-for-bots/packages/daemon/src/networks/setup-iroh.js:12); [setup-ws-relay.js](/Users/xyz/Development/endo-but-for-bots/packages/daemon/src/networks/setup-ws-relay.js:35).

### P11 — Review provisioner + workspace creators + live archive

The review provisioner creates six root objects per project. Give it one private project-owned review directory, pass paths directly, and provide cleanup on failed setup and completed/disposed review. Archive the four completed clusters; retain workspace data until checked. Exact recovered workspace-name producers were not found in tracked code.

[dev-review.js](/Users/xyz/Development/endo-but-for-bots/packages/floot/dev-review.js:267); [review-connection.js](/Users/xyz/Development/endo-but-for-bots/packages/floot/review-connection.js:1); [review-reader.js](/Users/xyz/Development/endo-but-for-bots/packages/floot/review-reader.js:1); [review-project.js](/Users/xyz/Development/endo-but-for-bots/packages/floot/review-project.js:1).

### P12 — Operations tooling + retention policy + live archive

Change archive helpers to accept a directory path under private:recovery/archive instead of another root name. Update retirement/inspection tools that recognize the current root prefix. Preserve source data until an explicit retention decision.

[archive-floot-workspace-roots.mjs](/Users/xyz/Development/endo-host/ops/archive-floot-workspace-roots.mjs:1); [prepare-mixed-retirement.mjs](/Users/xyz/Development/endo-host/ops/prepare-mixed-retirement.mjs:1); [retire-mixed-floot-sessions.mjs](/Users/xyz/Development/endo-host/ops/retire-mixed-floot-sessions.mjs:1); [retire-legacy-helper-formulas.mjs](/Users/xyz/Development/endo-host/ops/retire-legacy-helper-formulas.mjs:1).

### P13 — Demo provisioner + documentation + live move

The counter was provisioned by this chat’s one-off setup, not an automatic boot factory. Move its existing binding under demos and use a directory destination in future example provisioning. Preserve the object so already-paired frontends continue to work.

[README.md](/Users/xyz/Development/endo-but-for-bots/packages/browser-endo/README.md:1); [counter.js](/Users/xyz/Development/endo-but-for-bots/packages/browser-endo/src/counter.js:1).

## Recommended order

1. Fix producers first: legacy startup policy, direct path creation, review provisioning, and
   operational archive destinations. Do not introduce a new host/guest merely to obtain a directory.
2. Move active service names without recreating their identities; update saved paths, discovery,
   setup reuse checks, and pins together. Preserve capability-bearing published applications.
3. Archive completed Ironhorse support clusters and old recovery state under their owners.
   Verify project data before deletion; completed workflow state is not a backup of a working tree.
4. Keep Whylip and repair its provisioning; Lal and the old configuration-wizard root bindings have been removed.
   Keep the actively used Floot provider backend and its OpenRouter secret.
5. Remove redundant names and superseded network objects with separate operations:
   removing an alias is different from cancelling a service or deleting its state.

Before applying a cleanup, use an identity-checked manifest: old path, expected identity,
new path or retirement action, owner, known consumers, and rollback name.
The manifest containing actual identifiers should remain private; this report intentionally does not
contain them.
Regression coverage should verify that successful setup, rerun, partial failure, and concurrent setup
leave only deliberately published root capabilities or collections, with no temporary root names or private children reachable through public collections; disposal should release owned children without touching
shared capabilities, secrets, or published assets.
