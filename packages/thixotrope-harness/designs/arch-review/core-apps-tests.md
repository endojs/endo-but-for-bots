# Core review AR-APPS: applications, tests and build in `packages/thixotrope`

Unit AR-APPS of the core architecture review. Scope: `src/mail/**`, `src/web/**`, `src/tui/**`,
`examples/**`, `resources/**`, the `dist-*` build outputs and their scripts, the tsconfig and ava
configs, and `test/**` as a whole. Snapshot: branch `claude/thix-arch` at `3f67a8e505`. Read-only
review: nothing under `packages/thixotrope` was changed. Paths below are relative to
`packages/thixotrope` unless they start with `packages/`. Each claim is marked **read** (I read the
code), **measured** (a script or command counted it) or **inferred**.

Started 2026-11-18T12:07:18Z; ended (see the journal entry J-9961).

## Summary

**The three things most worth changing**

1. **The mail application is part of the core's control plane, not a demo beside it**
   (AR-APPS-1). The supervisor, the built-ins, the workspace table and the administration facet
   import `src/mail/**`, define a `mail-introductions` host resource, ship a mailbox into every
   workspace, carry a mail-UI bearer token, and version the state directory on mail details. Mail
   is about 3,100 lines of `src` (15 %), 2,600 lines of tests (10 %), 1,800 lines of scripts and
   5.3 MB of measurement files. The application modules depend on nothing above the shared utilities,
   so taking them out is cheap; what costs is the wiring in `src/control`.
2. **The Ironhorse lane pays for cold provisioning in nearly every test and runs one file at a
   time** (AR-APPS-2). `test/ironhorse/supervisor.js` starts 21 supervisor processes; the 17
   scenario tests each cold-boot two vats; `concurrency: 1`; no per-file timing is recorded anywhere,
   so the 12-23 minute lane cannot be attributed. The Node suite also runs every file three times
   (three SES configurations, 13.8 min). A provisioned-template copy (as the harness's spike S8 does),
   per-file timing and parallel files are the levers.
3. **The mail web UI's service keeps two projections, a dead compatibility path, and every
   capability it ever offered** (AR-APPS-3, -4, -5). A value removed from the inventory stays
   sendable through an open browser session, and the service's selection maps only grow.

**The three things most worth keeping**

1. **Engine-parameterised integration scenarios** (`test/_alarm-integration.js`,
   `_http-integration.js`, `_mailbox-integration.js`, `_remote-process-tests.js`): one scenario
   body registered under the replay engine in the Node suite and under Ironhorse in the lane, by
   six-line wrappers. This is the right way to keep the two lanes honest; extend it (AR-APPS-9).
2. **Native resources that depend only on the public entry points.** `resources/clock/**` and
   `resources/http/**` import nothing from `src` except types: `native-adapter.js`, `guest.js` and
   `src/native/contract.js` (typedefs). They are the model for how an application should sit on the
   core, and the examples (`examples/counter.js`, `http-counter.js`, `reminder.js`) are both
   documented in the README and exercised by tests.
3. **The hub's crash and delivery tests.** Randomised SIGKILL at commit points for both hub stores
   (`test/hub-crash-consistency.test.js`, child `_hub-crash-child.mjs`), commit-failure injection
   (`hub-outbox`, `hub-disposable-outbox`, `hub-gc-batch`, `delivery-storage-failures`), and the
   lane fixture's fault injection at "before delivery" and "after commit before outbound"
   (`test/ironhorse/_fixture.js:96-150`) test the hub's promises directly, not through symptoms.
   The TUI is also worth keeping as it is: five small modules, one lifetime idiom
   (`src/tui/view-session.js`) and escaping of every remote string (`src/tui/terminal-text.js`).

## Map of the area

Sizes are lines (measured with `wc -l`). The import edges come from a scratch import-graph
script over every `.js`, `.mjs` and `.ts` file outside `node_modules` and `dist-*` (measured).

| area | files, lines | job | imported by (outside tests) | imports |
|---|---|---|---|---|
| `src/mail/` | 5, 796 | mailbox (inbox/outbox observable maps), contact (introduction state, sequenced delivery), address book (pet names over the `contacts` map), introductions (host resource: publish, unpublish, redeem invitation text) | `src/control/builtins.js:12`, `src/control/supervisor.js:65`, `src/control/workspaces.js:11-13`, `scripts/measure-mail.mjs` | `@endo/*`, `describe-error`, `is-remotable`, `observable-map`, `random-id` only |
| `src/web/` | 4, 1,638 (518 CSS) | mail browser UI: Preact component, service (attenuation and projection), shared subscription | `src/platform/browser/*`, `src/platform/node/mail-ui-server.js`, `scripts/mail-ui.mjs`, `scripts/measure-mail.mjs` | `@endo/*`, `is-remotable` |
| `src/platform/browser/`, `src/platform/node/mail-ui-server.js` | 4, 589 | browser host, editor and lockdown for the mail UI; its local HTTP bridge | `scripts/mail-ui.mjs` | `src/web/*` |
| `src/tui/` | 5, 244 | terminal views: inventory, mailbox, attach; escaping; view lifetime | `bin/thix.js:11-14` | `src/control/local-control`, `src/control/workspace-client`, `src/platform/*` |
| `src/control/workspace-client.js` | 114 | the CLI's mail and alarm verbs over a control connection | `bin/thix.js`, `src/tui/mailbox-view.js` | `@endo/far` |
| `resources/clock/`, `resources/http/` | 5, 669 | shipped native resources (durable manager module, ephemeral adapter) | `src/control/builtins.js:10` (clock) | `native-adapter.js`, `guest.js`, `src/native/contract.js` (types) |
| `resources/control/` | 2, 213 | the operator's control socket as a native resource | `src/control/builtins.js:11` | `src/control/local-control.js`, `src/platform/*` (a directory-level cycle, AR-APPS-12) |
| `examples/` | 4, 136 | sample applications | README, `test/_alarm-integration.js`, `_http-integration.js`, `ironhorse/alarm-crash.js`, `ironhorse/supervisor.js:716` | `@endo/thixotrope/guest.js` |
| `scripts/` | 15, 2,154 | bundle builds (Ironhorse, XS), demo, mail UI launcher, mail measurement and profiling (1,781 lines are `*mail*`) | `package.json` scripts, two tests | `src/**` |
| `test/` | 98 files, 26,132 | 78 `.test.js` files, 20 helpers and child processes, 18 lane files under `test/ironhorse/` | | |
| `designs/` | 111 files, 5.6 MB | 17 Markdown notes; 94 measurement files (JSON, JSONL traces, SVG), 5.3 MB | | |
| `dist-ironhorse/` | 2 files, 2.0 MB | `boot.js` (polyfills, Ironhorse prelude, SES, lockdown), `worker-peer.js` (bundle of `src/core/worker-peer-xs.js`); ignored by git (`.gitignore:2`) | `src/control/supervisor.js:245-246` | built by `scripts/bundle-ironhorse-worker.mjs` |

Dependency direction at directory level (measured): `src/mail` and `src/web` are leaves above the
shared utilities; `src/control` depends on `src/mail` and `resources/*`; `src/platform` depends on
`src/web` (through the mail UI files placed there) and on `src/net`; `src/tui` depends on
`src/control`. Two directory cycles: `resources/control <-> src/control` and
`src/platform <-> src/net, src/store, random-id.js` (the second is outside this unit).

### Tests against the life cycle and the hub

Test counts are per file in one configuration (read; files that generate tests in loops counted by
reading them). Node suite files run under the replay engines; lane files run under Ironhorse.

| behaviour | Node suite (`test/*.test.js`) | Ironhorse lane | gap |
|---|---|---|---|
| hub routing, slot rewriting, third-party answers, gifts | `hub` (12), `worker-peer`, `transient-hub-client` (3) | `scenarios` (17) | none seen |
| hub persistence, restart from tables, crash at commit points | `hub`, `hub-log-store` (8), `hub-crash-consistency` (randomised SIGKILL, both stores), `durable-worker-session` (7) | `reliability` (SIGKILL phases) | power loss not modelled (stated in the design) |
| outbox, acceptance, replay identity, coalescing | `hub-outbox` (8), `hub-disposable-outbox` (7), `hub-coalesce` (4), `local-delivery` (5), `session-delivery-store` (4), `delivery-storage-failures` | `delivery` | a frame over `frameBytes` addressed to a vat (C-25): none |
| GC and retirement | `hub-gc-batch` (4), `worker-gc-cranks` (7), `answerer-retirement-gc`, `_peer-replay-gc.mjs`, `_resource-answer-gc.mjs`, `inventory-view-lifetime` | `reachability` (4), `supervisor` (collect) | none seen |
| sleep, wake, snapshot, start notices | `daemon` (8), `worker-session-restart` (4), `restorable-promise`, `start-notice` (4) | `scenarios`, `element-attributes`, `text-codec` (7) | cadence snapshot holding queued deliveries (C-24): `snapshotEveryDeliveries` appears in 2 test files, neither measures what it delays |
| crash loops, quarantine, crash bound | `durable-worker-crash-loop` (28), `supervisor-crash-bound` (2), `daemon-journal-recovery` (7), `ironhorse-engine-crash-classification` (12) | `reliability`, `alarm-crash`, `http-crash` | serving while a vat crashes at startup (C-8) is untested because it is not built |
| remote peers and durable sessions | `remote-delivery` (11), `randomized-delivery`, `durable-netlayer`, `durable-sessions` (7), `unix-netlayer` (9), `unix-delivery` | `remote-delivery` | none seen |
| native resources | `adapter-kit` (13), `manager-kit` (16), `adapter-keeper` (4), `native-adapter` (10), `native-install` (10), `native-manager-recovery`, `clock-resource` (7), `http-manual-persistence` (6) | `native-install`, `http`, `alarms` | none seen |
| control plane, registry, workspaces, state version | `registry` (13), `install-application`, `workspaces` (5), `builtins`, `local-control` (6; version refusal at `test/local-control.test.js:25`), `shipped-factories` (6) | `supervisor` (11, CLI and TUI), `limits` | none seen |
| XS engine | `worker-peer-xs`, `durable-worker-session-xs`, `worker-session-restart-xs` | none | never run in any configured lane (AR-APPS-10) |

The coverage of the hub and the life cycle is broad and aimed at the right failure points; the
gaps are the open core candidates (C-8, C-24, C-25), not forgotten behaviours [read, inferred for
"broad"].

## Findings

Severity order. Size is lines touched and files; risk names what could break and what covers it.

### AR-APPS-1 (major; questions 1 and 4) The mail application is wired into the core's control plane

- **Where.** `src/control/supervisor.js:65` (import), `:81-88` (versions 5 and 8 are mail),
  `:173-175`, `:191`, `:383-395` (mailbox placement), `:438-447` (`mail-introductions` host
  resource), `:661` (help text), `:881-893` (`getMailUiToken`), `:918-927` (`getAddressBook`);
  `src/control/builtins.js:12`, `:211-217` (`shipMailbox`); `src/control/workspaces.js:11-13`,
  `:113-175` (address book getter, woken mailbox subscriptions), `:341-372` (mailbox provision);
  `src/control/workspace-client.js` (all mail verbs); `designs/thixotrope.md` (repository root)
  vocabulary rows "workspace", "introduction", "message", and section "Contacts and capability
  offers".
- **What.** Every workspace is provisioned with a mailbox installation and an address book; the
  host endpoint carries a mail-specific resource; the administration facet carries two
  mail-specific methods; `WORKSPACE_VERSION` moves when mail changes. Nothing in the core needs mail
  to work, and the harness does not use it (no reference to `mailbox`, `getAddressBook` or
  `mail-ui` in `packages/thixotrope-harness` code) [read, measured by grep].
- **Evidence.** Mail references: `supervisor.js` 29 lines, `workspaces.js` 39, `builtins.js` 4,
  `workspace-client.js` 3 [measured]. Footprint: `src` 3,080 lines (mail, web, browser host, UI
  server, mailbox view) of 20,648 (15 %); tests 2,577 of 26,132 (10 %); scripts 1,781; designs
  1,458 lines of Markdown plus 5.3 MB of data [measured]. The application modules themselves are
  leaves: `src/mail` imports only `@endo/*`, `describe-error`, `is-remotable`, `observable-map`,
  `random-id`; `src/web` only `@endo/*` and `is-remotable` [measured]. The design document agrees
  with the code here, so the mismatch is with the package boundary table ("Comms hub, worker and
  remote transports, host endpoint, persistence coordination, supervisor, and terminal tools"),
  which names no mail and no web UI [read].
- **Smallest change.** Two steps. (a) Make "a host-provided installation per workspace" a list the
  supervisor is given (name, ship function, optional host resource makers), so the mailbox,
  address book and introductions are entries passed in by `bin/thix.js` rather than imports of
  `src/control`. (b) Move `src/mail`, `src/web`, `src/platform/browser`,
  `src/platform/node/mail-ui-server.js`, `src/tui/mailbox-view.js`, the mail half of
  `workspace-client.js`, the mail scripts, tests and designs to a package of their own (for
  example `@endo/thixotrope-mail`) that depends on `@endo/thixotrope`. The `introductions`
  resource is a generic "publish a capability as invitation text, redeem text" service (see
  AR-APPS-14) and could stay in core under a neutral name.
- **Size.** (a) about 150 lines in 4 files (`supervisor.js`, `builtins.js`, `workspaces.js`,
  `bin/thix.js`); (b) a move of about 9,000 lines with import-path edits, one new `package.json`.
- **Risk.** A `WORKSPACE_VERSION` bump (closures shipped by source move). Covered by
  `test/workspaces.test.js`, `test/builtins.test.js`, `test/shipped-factories.test.js`,
  `test/mailbox-integration.test.js` and the lane's `ironhorse/mailbox.js`; the lane's mailbox test
  is also the only two-supervisor end-to-end test, so it would move with mail and the core lane
  would need a non-mail two-supervisor scenario in its place (`remote-delivery` covers transport,
  not the control plane).

### AR-APPS-2 (major; question 5) The Ironhorse lane's time goes to cold provisioning, one file at a time, unmeasured

- **Where.** `ava.ironhorse.config.mjs:6-25` (`concurrency: 1`, 16 files); `test/ironhorse/_fixture.js:155-166`
  (every `makeFixture` starts a daemon and creates and evaluates two vats);
  `test/ironhorse/scenarios.js` (17 `makeFixture` calls, 15 restarts);
  `test/ironhorse/supervisor.js:32-70` (`start` spawns `bin/thix.js serve`; called 21 times in 11
  tests, each in a fresh `mkdtemp` directory); `_alarm-integration.js`, `_http-integration.js`,
  `_mailbox-integration.js` (fresh state directories, 3-5 supervisor starts each);
  `test/ironhorse/alarm-crash.js:138` (waits out an 8.2 s real-time alarm).
- **What dominates, from the code** [inferred]. A fresh supervisor provisions the registry vat, the
  clock and control managers with their adapter processes, a mailbox vat and the default workspace
  vat, each booting the 2.0 MB Ironhorse boot set; architecture.md puts a vat's first-message boot
  at about 3.5 s [inferred there from install times]. So `supervisor.js` alone is on the order of
  21 provisionings, and `scenarios.js` 34 cold vat boots plus 15 restores. Real-time waits (alarms,
  crash recovery deadlines) are a smaller, fixed share. The text-codec million-code-point test is
  one crank per direction and is not the cost.
- **Evidence.** Lane wall times recorded in the harness journal: 1,394 s (55 tests), about 22 min
  (63, J-0114), 17.6, 15.8, 15.75 and 12.2 min (66-69 tests) [measured there]. No record gives
  per-file times (J-0114 lists only per-file counts) [read]. The Node suite runs every file under
  three SES configurations (`package.json:98-102`; 13.8 min for 417 tests x 3, J-9212) [measured there], including its 22 supervisor starts in 14 files [measured].
- **Smallest change.** (1) Record per-file wall time in the lane (ava's `--tap` timings or a
  one-line `t.teardown` timestamp per file written as a `lane.ironhorse.file` row) before
  changing anything else. (2) For the supervisor tests, provision one state directory per file and
  copy it per test (the harness's spike S8 method). (3) For `scenarios.js`, build the two-vat
  fixture once, shut it down cleanly and copy the state directory per test (snapshot restore is
  what most scenarios test anyway). (4) Raise lane `concurrency` to 2-4 files once (1) shows which
  files are CPU-bound; the files use unique `mkdtemp` directories. (5) Run only the files that
  depend on SES configuration under all three Node configurations.
- **Size.** (1) about 20 lines, 1-2 files; (2) and (3) about 80 lines in `_fixture.js` and
  `supervisor.js`; (4) one line; (5) a config split, about 20 lines.
- **Risk.** A copied state directory must not carry a running socket path (C-4: the control socket
  path lives in a vat heap): copies must be made from a stopped daemon at a path the test then
  uses, as the harness does. Timing-sensitive tests (`alarm-crash`, alarms) may need to stay
  serial. Covered by the lane itself.

### AR-APPS-3 (moderate; question 5) The mail UI service keeps every offered capability, so removal does not revoke

- **Where.** `src/web/mail-ui-service.js:36-45` (`grants`, `selections`, `recipients`), `:96`,
  `:100`, `:308`, `:317` (insertions), `:359` and `:372` (use in `send`).
- **What.** `selections` (token to inventory value) and `recipients` (token to contact) gain an
  entry for every value and contact in every projection and lose none for the life of the bridge
  process. A value the user removes from the inventory, or a contact removed from `contacts`,
  stays sendable through an open browser session with a token it was once shown. `offered`
  (`:45`, `:128`, `:326`) is replaced per projection, which is the behaviour the other two maps
  should have [read].
- **Evidence.** No `delete` or replacement of `selections` or `recipients` anywhere in the file
  (`grep` of `selections\.` and `recipients\.`: only `set` and `get`) [measured].
- **Smallest change.** Rebuild both maps per projection, as `offered` is, and refuse a token not
  in the current projection ("This value is no longer available").
- **Size.** about 15 lines, 1 file, plus a test in `test/mail-ui.test.js`.
- **Risk.** A message composed against a projection that has since changed fails instead of
  sending; that is the intended semantics. Covered by `test/mail-ui.test.js` (11 tests).

### AR-APPS-4 (moderate; question 3) Compatibility paths for states the version gate already refuses

- **Where.** `src/web/mail-ui-subscription.js:54-67` (probe `__getMethodNames__` and fall back to
  `legacySubscribe`), `:124-134` (probe contacts for `subscribeStatus`, fall back to `status()`);
  `src/web/mail-ui-service.js:131-221` (`legacySubscribe`, 90 lines), `:345-372` (a recipient may be a
  string name "for older local bridge callers"); `src/platform/node/mail-ui-server.js:181`
  (`input.recipient ?? input.name`).
- **What.** "Old durable objects retain their original interfaces" cannot happen: a state
  directory whose version differs from `WORKSPACE_VERSION` (21) is refused before any vat
  restores (`supervisor.js:376-381`, tested at `test/local-control.test.js:25-53`), and every
  shipped mailbox and contact at version 21 has the entry and status subscriptions. The browser
  sends tokens (`src/web/mail-ui.js:88`); only tests send string names [read].
- **Evidence.** Callers of `send` with a string: `test/mail-ui.test.js` (9 sites) and
  `mail-ui-server.js:181`; none from the browser component [measured].
  `test/mail-ui.test.js:171` tests the legacy path with fakes [read].
- **Smallest change.** Delete `legacySubscribe`, the two probes and the string-recipient branch;
  make the subscription's opening the only path.
- **Size.** about 130 lines removed, 3 files; tests adjusted (about 60 lines).
- **Risk.** Low; covered by `test/mail-ui.test.js`. `scripts/measure-mail.mjs:65,203` has a
  `legacy` comparison mode that loads an older service from a path and would lose its baseline.

### AR-APPS-5 (moderate; question 2) The mail UI service projects the same state two ways

- **Where.** `src/web/mail-ui-service.js:63-130` (`project`, from subscribed state) and
  `:231-328` (`snapshot`, from fresh reads); `:266-271` and `:302-307` re-inline `tokenFor`
  (`:47-55`); `:111-124` re-implements `describe` of `src/observable-map.js:68-75` (same strings,
  `slice(0, 160)`, `'<object / capability>'`).
- **What.** Two projections build the same `MailSnapshot` shape with different lookups (local maps
  in one, `keyOf` round trips per message in the other); each change must be made twice, and they
  already differ (`snapshot` asks the mailbox to `take` each capability, `project` reads it from
  the entry) [read].
- **Smallest change.** Make `snapshot()` build the four maps once (`entries()` of mailbox, inventory,
  contacts and the contact statuses) and call `project`; export `describe` from
  `observable-map.js` (or have the service use the map's `snapshot()` entries, as `snapshot` does).
- **Size.** about 90 lines removed, 2 files.
- **Risk.** `snapshot` is used by `scripts/mail-ui.mjs:91` and `measure-mail.mjs`; covered by
  `test/mail-ui.test.js`.

### AR-APPS-6 (moderate; question 5) The mailbox's outbox only grows, and holds what it sent

- **Where.** `src/mail/mailbox.js:101-129` (`send` adds an outbox record per message, replaced on
  outcome), `:164` (`discard` deletes from the inbox only); `src/mail/mail-address-book.js:72-75`
  (`invitations` keeps every published, unredeemed and unrevoked invitation and its contact).
- **What.** Every sent message stays in the outbox forever, with its `to` contact and every
  capability in its content, so the mailbox vat's heap and its snapshots grow with the number of
  messages ever sent, and the capabilities stay reachable from the sender's side after delivery.
  The design says "inbox and outbox records retain contact references" but names no removal
  [read].
- **Smallest change.** `discard(id, box = 'inbox')` symmetrical with `take`, and an outbox record
  that drops its content values once delivered (keep descriptions). This follows the owner's rule
  of bounding retained state rather than capping use.
- **Size.** about 20 lines, 2 files (`mailbox.js`, `mail-address-book.js`), plus tests in
  `test/mailbox.test.js`. A `WORKSPACE_VERSION` bump (shipped by source).
- **Risk.** A UI that re-offers a sent capability from the outbox (`take(id, index, 'outbox')`)
  loses it after delivery; covered by `test/mailbox.test.js` (23 tests) and `test/mail-ui.test.js`.

### AR-APPS-7 (moderate; question 3) Finished experiments live on in the core: scripts, tests, patches and 5.3 MB of traces

- **Where.** `scripts/mail-hub-log.mjs` ("Disposable benchmark experiment", line 2) and
  `scripts/mail-hub-sqlite.mjs`, tested by `test/mail-hub-log.test.js`, `test/mail-hub-sqlite.test.js`
  and `test/fixtures/mail-hub-sqlite-child.mjs`; `scripts/mail-profile-worker.patch`,
  `scripts/mail-vm-detail-worker.patch` and the three `*.py` scripts; `scripts/measure-mail.mjs:105-120`;
  `designs/mail-*` (8 Markdown notes, 94 data files).
- **What.** The hub-store experiments (October) were superseded by the core's own log store
  (`src/store/hub-log-store.js`, CC-025), yet their 221 test lines run in every Node-suite
  configuration. Both worker patches no longer apply to `rust/thixotrope-ironhorse-worker/src/main.rs`
  (`git apply --check` fails at hunks `:188` and `:118`) [measured]. `measure-mail.mjs` times
  writes to `hub.json`, which the default `log` store (`supervisor.js:152-167`) no longer writes, so
  without `THIXOTROPE_HUB_STORE=file` it reports no hub cost (also noted in `CORE-CHANGES.md`,
  J-9337 (5)) [read]. The data files total 5.3 MB in git (26 raw JSONL traces); 60 are named by a
  note, the rest are "neighbouring" breakdowns [measured].
- **Smallest change.** Delete the two hub-store experiment scripts and their tests and fixture;
  delete the patches and Python helpers or move them, with the traces, to an archive outside the
  package (or keep only the SVGs the notes embed); make `measure-mail.mjs` set or refuse without
  `THIXOTROPE_HUB_STORE=file`.
- **Size.** about 1,100 lines and 5.3 MB removed, about 105 files; 3 lines in `measure-mail.mjs`.
- **Risk.** None for behaviour. The notes lose their raw data unless archived.

### AR-APPS-8 (moderate; questions 3 and 4) `mailboxPlacement` is a mode with one caller, contrary to the design

- **Where.** `src/control/supervisor.js:173-175`, `:191`, `:383-395`, `:487`;
  `src/control/workspaces.js:40`, `:341-372`; `designs/thixotrope.md` "Each mailbox lives in a
  guest vat, separate from the workspace" (section "Contacts and capability offers").
- **What.** A workspace's mailbox may be evaluated in the workspace vat (`'workspace'`) instead of
  its own installation vat (`'separate'`, the default); the choice is persisted in
  `workspace.json` and can never change. Only `test/workspaces.test.js:50,110` passes it; no
  script, CLI flag or harness code does [measured]. "Omission retains separate mailboxes for
  existing state" is a compatibility clause, but any existing state older than version 21 is
  refused anyway. The same function also checks the version twice (`:376-381` in
  `validateState`, again at `:491-496`) [read].
- **Smallest change.** Remove the option and the `'workspace'` branch; keep one version check.
- **Size.** about 50 lines, 3 files, one test reduced.
- **Risk.** A `WORKSPACE_VERSION` bump if the metadata shape changes. Covered by
  `test/workspaces.test.js`.

### AR-APPS-9 (moderate; question 2) Repeated test scaffolding

- **Where and evidence** [measured with a scratch 8-line-window duplicate finder and grep]:
  - The worker binary and boot-bundle discovery (`THIXOTROPE_IRONHORSE_WORKER`, `dist-ironhorse`)
    is written in 8 test files (`ironhorse/_fixture.js`, `delivery.js`, `element-attributes.js`,
    `key-space.js`, `process-daemon.mjs`, `reliability.js`, `text-codec.js`,
    `_remote-process-fixture.js`), 2 scripts and `src/control/supervisor.js:245`; the XS
    equivalent in 3 more test files.
  - `{ ...makePeerJournalReplayEngine(nodePowers), acquireStore: async () => async () => {} }`:
    15 sites in 10 files.
  - Temporary state directories: `mkdtemp('/tmp/...')` 54 sites in 23 files beside
    `mkdtemp(join(tmpdir(), ...))` 47 sites in 22 files; the `/tmp` form exists for the Unix socket
    path limit but says so nowhere.
  - The three XS test files copy their Node counterparts with the engine swapped
    (`worker-session-restart-xs` against `worker-session-restart`: 18 shared 8-line windows;
    `durable-worker-session-xs` against `durable-worker-session`: 14), instead of the
    engine-parameterised registration the integration files already use.
  - `ironhorse/element-attributes.js`, `key-space.js`, `text-codec.js` share an 18-window
    preamble (imports, discovery, a `makeVat` helper).
  - The retirement message is a string literal in `src/net/hub.js:1842,2278,2306` and again in
    `test/ironhorse/key-space.js:39` and `test/supervisor-crash-bound.test.js:119` (C-18).
- **Smallest change.** A `test/_engines.js` with `ironhorseEngine()`, `xsEngineOrSkip(test)`,
  `replayEngine()` and `stateDir(prefix)` (which documents why `/tmp`); turn the XS files into
  registrations of the Node scenarios; export the retirement text (or, better, the C-18 typed
  break) from `hub.js`.
- **Size.** about 150 lines added, about 400 removed, about 30 files.
- **Risk.** Low; the suites themselves cover it. The XS conversion can only be checked with an XS
  build (AR-APPS-10).

### AR-APPS-10 (moderate; question 5) The XS tests never run

- **Where.** `test/worker-peer-xs.test.js:47`, `durable-worker-session-xs.test.js:45`,
  `worker-session-restart-xs.test.js:45` (`test.serial.skip` when `dist-xs` or the XS worker is
  absent); `package.json` `"test:xs": "exit 0"`; `ava.ironhorse.config.mjs` lists no XS file.
- **What.** `makeXsEngine` is a public export (`index.js:11`) and the design names XS as "the
  alternative XS worker engine", but no configured lane builds `dist-xs` or the XS worker, and
  every recorded Node-suite run says "3 skipped (XS worker not built)" [read, measured in the
  journal].
- **Smallest change.** Decide: either an `test:xs` lane that builds and runs the three files (and
  fails rather than skips when the build is missing), or drop the XS engine export and tests to a
  branch until someone needs it.
- **Size.** a 15-line ava config plus a script, or about 900 lines removed (engine wrapper, bundle
  script, tests).
- **Risk.** Removing it loses the only second engine, which the `WorkerEngine` interface was
  designed around; keeping it unrun lets it rot silently.

### AR-APPS-11 (minor; question 1) The platform layer holds the mail web UI

- **Where.** `src/platform/browser/mail-editor.js`, `mail-ui-host.js`, `mail-ui-lockdown.js`;
  `src/platform/node/mail-ui-server.js` (imports `src/web/*` types).
- **What.** `src/platform` is otherwise the host's powers (files, sockets, processes, terminal);
  these four files make `src/platform` depend on `src/web`, an application [measured]. They are
  used only by `scripts/mail-ui.mjs` and `test/mail-ui.test.js`.
- **Smallest change.** Move them under `src/web/` (or with mail, AR-APPS-1).
- **Size.** 4 file moves, about 6 import lines.
- **Risk.** None; covered by `test/mail-ui.test.js`.

### AR-APPS-12 (minor; question 1) The control socket is a native resource that reaches into `src/control`

- **Where.** `resources/control/ephemeral.js:10-14` imports `src/control/local-control.js` and
  three `src/platform` modules; `src/control/builtins.js:11` imports `resources/control/durable.js`.
- **What.** A directory cycle `resources/control <-> src/control` [measured]. The clock and HTTP
  resources show the clean shape (public entry points only). The control resource is host code by
  design (the administration must work while vats are broken), so the dependency is legitimate,
  but its place under `resources/` suggests it is one of the shipped examples.
- **Smallest change.** Move the control resource under `src/control/resource/` (keeping it a
  bundle-shipped native resource) so `resources/` holds only resources built on the public API.
- **Size.** 2 file moves, 5 import lines, 1 path in `builtins.js:201`.
- **Risk.** The ephemeral bundle's digest is part of the launcher key; a move that changes the
  bundle text makes a fresh installation (a `WORKSPACE_VERSION` bump). Covered by
  `test/builtins.test.js` and the lane's `supervisor.js`.

### AR-APPS-13 (minor; questions 3 and 5) The Ironhorse bundle build: an ignored hook, no freshness check, not in `files`

- **Where.** `scripts/bundle-ironhorse-worker.mjs:55-61`; `scripts/bundle-xs-worker.mjs`
  (`packageDependenciesHook` returning `{ dependencies }`);
  `packages/compartment-mapper/src/node-modules.js:916-918`; `package.json` `"build": "exit 0"`
  and `"files"`; `src/control/supervisor.js:245-246`;
  `packages/thixotrope-harness/scripts/new-lane.sh:205-226`.
- **What.** (a) The Ironhorse script's hook returns a `Set`; compartment-mapper only honours a
  result with a `dependencies` property, so the exclusion of `ses`, `@endo/init` and
  `@endo/lockdown` is silently ignored. It does no harm today because nothing in the bundle imports
  them (no `ses/src` module in `dist-ironhorse/worker-peer.js`) [measured], so the hook is dead
  code that looks protective. The two bundle scripts also differ in everything else (paths,
  logging), with one entry point `src/core/worker-peer-xs.js` for both engines. (b) The core's
  `test:ironhorse` runs whatever `dist-ironhorse` holds; the rebuild-and-compare check exists only
  in the harness's `new-lane.sh`. (c) The supervisor's default engine reads
  `dist-ironhorse/` beside the package, but `files` omits it and `build` does not make it (the
  package is `private`, so this only matters if it is published).
- **Smallest change.** Return `{ dependencies }` (or drop the hook); a shared
  `scripts/_bundle.mjs`; a `pretest:ironhorse` that rebuilds into a scratch directory and fails on
  difference (the `new-lane.sh` loop); `"build"` runs the Ironhorse bundle script and `files`
  lists `dist-ironhorse`.
- **Size.** about 60 lines, 4 files.
- **Risk.** The boot digest is part of state identity; a rebuild that changes bytes refuses old
  state directories, which is the intended signal. Covered by the lane.

### AR-APPS-14 (minor; question 4) Names that say less or more than the thing

Each is read; together about 40 lines across 8 files, low risk, covered by the existing suites.

- `src/control/workspace-client.js` is the CLI's mail and alarm client (its own doc comment at
  `:9`), not a workspace client; `mail-client.js` (and `alarms` beside it) says what it is.
- `MailIntroductions` (`src/mail/introductions.js:91`) is a generic "publish a capability as
  invitation text, withdraw it, redeem text" service; the design's word "introduction" is the
  exchange of contact inboxes (`designs/thixotrope.md` vocabulary), which the address book does,
  not this resource. A neutral name (for example `invitations`) would let it stay in core.
- `src/core/worker-peer-xs.js` is the bundle entry for Ironhorse as well as XS
  (`scripts/bundle-ironhorse-worker.mjs:57`).
- `designs/thixotrope.md` (Contacts section) says "only CLI and UI adapters resolve display
  labels", against its own vocabulary rule that "adapter" means only the ephemeral half of a native
  resource.
- The mail UI token is kept at `globalThis[Symbol.for('thixotrope.mailUiToken')]`
  (`supervisor.js:891`); every other heap slot the host keeps is a plain global name
  (`globalThis.registry`, `.inventory`, `.mailAddressBook`, `.workspaceMailbox` and five more)
  [measured]. One convention, please.
- `test/observable-map.test.js` tests `src/tui/inventory-view.js` rendering; it belongs in a TUI
  test file.

### AR-APPS-15 (minor; question 2) Mail validation written three times, with different limits

- **Where.** `NameShape`/`ContentShape` in `src/mail/mailbox.js:29-37`,
  `mail-contact.js:32-38`, `mail-address-book.js:49-55` (identical; each factory is shipped by
  source and must be whole); invitation parsing in `src/mail/introductions.js:61-90` and
  `mail-address-book.js:85-98`; `introductions.js:61-83` re-inlines its own `assertSecret` and
  `assertName` (`:12-24`); `src/web/mail-ui-service.js:349-362` (up to 256 parts and 4,096
  characters in total) against the guard's 64 parts and 4,096 characters per part.
- **What.** One concept, a mail content record, has two sets of limits; the UI accepts messages the
  mailbox refuses, and the error then comes from the guard [read].
- **Smallest change.** Put the content and name shapes in the guest prelude, as version 20 did for
  `HEX128_PATTERN` and the name validators (`src/guest/prelude.js:61-63`), and import the limits
  into the UI service; let `parseInvitation` call `assertSecret` and `assertName`.
- **Size.** about 40 lines, 5 files; a `WORKSPACE_VERSION` bump.
- **Risk.** Low; covered by `test/mailbox.test.js`, `test/shipped-factories.test.js`,
  `test/mail-ui.test.js`.

## What I did not cover

- The browser component's rendering and CSS (`src/web/mail-ui.js`, `mail-ui.css`) and the browser
  host's confinement (`src/platform/browser/mail-ui-host.js`): read only for imports and calls.
- The security of the mail HTTP bridge (`mail-ui-server.js`: token check, origin and rebinding
  refusal) beyond the request routing at `:170-190`; it deserves its own security read if mail
  stays.
- Whether each test asserts what its title claims, beyond the files named above: I sampled the hub,
  mail and lane files, not all 78.
- No test was run and no timing was taken; lane cost attribution in AR-APPS-2 is inferred from the
  code and from wall times already in the harness journal.
- `src/control/**`, `src/net/**`, `src/store/**`, `src/core/**` and the engine are other units'; I
  touched them only where an application or a test depends on them.
- Re-reading the two spike surveys (`survey-ocapn-hub.md`, `survey-engine.md`): they concern the
  data path, not tests or applications, and nothing in them bears on this unit's findings.
