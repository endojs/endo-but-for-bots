# Daemon No-Wait: Native Creation vs. Construction Semantics

| | |
|---|---|
| **Created** | 2026-07-17 |
| **Updated** | 2026-08-07 |
| **Author** | 0xpatrickdev (prompted) |
| **Status** | Proposed |
| **Source** | `packages/daemon/TODO.md` (Kris Kowal, commit `e86cad138`, 2026-01-23); maintainer review on PR [#751](https://github.com/endojs/endo-but-for-bots/pull/751#discussion_r3600377291) |

## What is the Problem Being Solved?

Every formula-producing daemon method today resolves only when the formula's
value has finished **constructing**, even though the daemon internally
completes **creation**: durable formula persistence plus pet-name
association, much earlier.
A caller who only wants the thing created and named (an agent harness, a
script, a `--no-wait` CLI invocation) has no milestone to await other than
full construction, which for `evaluate` and `makeUnconfined` can be slow or
unbounded.

PR #751 tried to patch this in `@endo/agent-tools` with a tool-local
`deadlineMs` and a `setTimeout` race.
The maintainer rejected that as misdirection: waiting and timeouts are
harness policy; the daemon needs native creation-versus-construction
semantics, with waiting for everything remaining the default.
This design turns the `packages/daemon/TODO.md` note, separately await
formula creation and formula construction, enabling a `--no-wait` flag and a
later `show`, into an implementable contract.

## Current Architecture (survey)

The split already exists inside the daemon; it is collapsed only at the facet
boundary.

**Daemon core.** `formulate` in `packages/daemon/src/manager.js` (the module
was `packages/daemon/src/daemon.js` when this design was first drafted; it was
renamed to `manager.js` on `llm`; every reference below has been updated
accordingly) is the eager choke point.
Its sequence: format the id; `persistencePowers.writeFormula` (disk before
graph, per the documented invariant); insert into `formulaForId` and
`formulaGraph.onFormulaAdded` under `withFormulaGraphLock`; publish on
`formulaChangeTopic`; construct a controller; then **eagerly** kick off
construction via `evaluateFormula` and return
`harden({ id, value: controller.value })` with the construction promise
un-awaited.
`formulateLazy` (used by `formulatePeer`) persists without constructing and
returns just the id.
`provideController`/`provide` lazily (re)incarnate on demand via
`evaluateFormulaForId`; after a restart, `seedFormulaGraphFromPersistence`
reloads formulas and retention edges but constructs nothing until the next
`provide`.
A rejected construction is **not** memoized: `promise.catch(context.cancel)`
evicts the controller, so the immediate caller sees the rejection and the
next `provide` retries construction.

In this document, a **caplet** is a confined or unconfined plugin value made
from a specifier, archive, or tree.

**Naming.** Result names are written through `makeDeferredTasks`
(`packages/daemon/src/deferred-tasks.js`).
Each facet method pushes an opaque callback that eventually calls
`E(directory).storeIdentifier(resultNamePath, identifiers.<x>Id)`; each
`formulate*` wrapper (`formulateEval`, `formulateUnconfined`,
`formulateReadableBlob`, and the other named constructors) runs
`deferredTasks.execute(identifiers)` inside the graph lock **before** calling
`formulate`.
So the pet name is durably associated before construction begins, and a
failed name write aborts before the parent formula is persisted.
This ordering uses two separate database operations inside one
`withFormulaGraphLock` call, but it provides no crash or partial-failure
protection between the writes.
The current lock is not a complete serialization boundary: its process-global
`formulaGraphLockDepth` lets any caller that observes a positive depth run
inline, even while the owning callback is awaiting a remote operation.
`unpinTransient` always mutates the graph and invokes `maybeCollect` when its
last pin is removed; it only drains asynchronous cleanup when the global depth
is zero.
Thus an unpin from another caller can mutate and collect during the durable
write window.
§ *Formula-plus-name durability* defines the replacement context-aware lock,
the provisional commit record, and the task split that prevent construction
from starting between persistence and naming.

**Facets.** Nearly every formula-creating method in
`packages/daemon/src/host.js` and `guest.js` ends with
`const { value } = await formulate*(...); return value;`, discarding `id`,
and returning the raw construction promise.
`host.evaluate` additionally pins unnamed evals transiently
(`pinTransient`) and awaits the value before unpinning.
Four paths already return without awaiting the formulated value:
`storeValue` destructures `{ id }` from `formulateMarshalValue`, unpins, and
returns `undefined`; `endow` destructures `{ id: evalId }` from
`formulateEval` and delivers a value message; `submit` posts a marshalled value
message; and `define` posts a definition backed by a promise/resolver pair.

**Guards.** `packages/daemon/src/interfaces.js` splits into two families:
the `M.call(...).returns(M.promise())` family (`evaluate`, `makeUnconfined`,
`makeArchive`, `makeFromTree`, `storeBlob`, `provideMount`, `provideGuest`,
`request`, …) whose implementations control what the promise resolves to,
and the `M.callWhen(...).returns(M.remotable(...))` family (`provideGit`,
`provideShell`, `provideHttpClient`, `provideGitRemote`,
`provideBearerCredential`, `provideBasicCredential`, `provideGitClone`)
which is guard-committed to awaiting construction and returning the built
remotable.

**Observation surfaces.** `lookup`/`maybeLookup`/`lookupById`/
`lookupByLocator` resolve through `provide`; `identify`/`locate` return
ids/locators without constructing; the host-only `diagnostics().getFormula`
([formula-inspector](formula-inspector.md)) reads the durable formula record
without constructing; `diagnostics().traces()` surfaces construction errors
(`endo trace`); `cancel` reaches `cancelValue` in daemon core.

**Promise formulas and mail.** A `promise` formula intentionally constructs
to a raw `FormulaIdentifier`, not to the value behind that identifier.
`makeRequest` and mailbox rehydration use `provide(promiseId)` as a promise of
that identity.
The waiting `request()` path awaits the identifier, validates it, adds its
retention edge, and only then calls `provide(resolutionId)` to obtain the
human-visible value.
The message-hub `@promise` lookup exposes the same raw-identity channel.
The separate `@result` lookup branch contains a second `provide`, but the live
message hub does not register `@result`, so that branch is currently dormant.
§ *Promise resolution identity and value lookup* inventories every consumer
and makes both contracts normative.

## The Contract

Six milestones for every formula-producing operation in this design, mapped
to existing symbols.
Milestones 2–5 replace the original draft's single "atomic association"
milestone; see § *Formula-plus-name durability* for the exact APIs and
failure behavior:

1. **Validation and authority resolution**: facet prelude: guard checks,
   endowment/worker/powers resolution (`prepareWorkerFormulation`,
   `prepareMakeCaplet`).
2. **Name-write preparation (no daemon persistence)**: each structured
   deferred task validates path syntax synchronously with `petNamePathFrom`.
   A result-name path can resolve through a directory hub on another node
   because `E(directory).storeIdentifier` can traverse CapTP references.
   Therefore a remote write can commit while its acknowledgement is lost.
   An optional parent-hub read may be emitted as an outcome-neutral diagnostic,
   but its success or failure never rejects the call and is not part of this
   milestone's persistence contract.
3. **Identifier allocation and durable formula persistence**:
   `randomHex256` followed by a transactional formula write and provisional
   name-commit record inside the named wrapper and `formulateWithCommit` split.
   The formula is not yet published to `formulaForId`, the graph, the change
   topic, or `controllerForId`.
4. **Durable name commit**: `formulateWithCommit` invokes the supplied
   `commitAfterPersistence` callback while holding a context-aware graph-lock
   token.
   The callback runs `deferredTasks.commit(identifiers, lockContext)` and
   reports `committed`, `rejected-before-write`, or `ambiguous`.
5. **Formula and controller publication, then construction start**: on a
   successful commit, `formulateWithCommit` inserts the formula into
   `formulaForId` and the graph, publishes the formula change, installs the
   controller, and calls `evaluateFormula` in the same synchronous prelude.
   Construction remains eager on first formulation and lazy on demand after
   restart.
6. **Construction fulfillment or rejection**: settlement of
   `controller.value`.

```mermaid
sequenceDiagram
    participant C as Caller
    participant H as Host/Guest facet
    participant D as Daemon core
    C->>H: startEvaluate(..., resultName)
    H->>D: formulateEval(..., tasks)
    D->>D: deferredTasks.preflight()
    D->>D: formula persisted (not published)
    D->>D: commitAfterPersistence: name writes
    D->>D: graph + controller publication
    D-->>D: evaluateFormula (construction starts)
    D-->>H: { id, value } (value un-awaited)
    H-->>C: FormulationReceipt { id, locator }
    Note over C: later: lookup/show awaits value;<br/>inspect reads formula; trace shows errors
```

Normative rules:

- A **default (waiting) call** settles at milestone 6, returning the same
  constructed value as today.
  Its successful-call behavior and eager evaluation remain unchanged; only
  the durable write order and failed-name-write residue change.
- A **no-wait call** settles at milestone 5, returning a **formulation
  receipt**, and MUST NOT settle
  before the formula and its requested name can survive a daemon restart.
- Milestone 1 failures and synchronously invalid result paths reject before
  persistence.
  No remote probe decides whether the call rejects.
- A crash or persistence failure between milestone 3 and milestone 4 is
  possible, and a live commit rejection can be ambiguous because a remote
  write might commit before its acknowledgement is lost.
  § *Formula-plus-name durability* specifies registration, retention, and
  collection for every classified outcome without deleting a possibly named
  formula.
- Milestone 6 rejection after a no-wait ack remains observable: `lookup` /
  `show` on the result name rejects with the construction error (and, per
  current controller semantics, the next `provide` retries construction);
  `endo trace` records worker-attributed errors; `endo inspect` /
  `getFormula` always shows the durable formula record.

## Formula-plus-name durability

The original draft's milestone 3 named this "atomic association of the
requested pet-name path."
It is not atomic: the name write and formula write are separate durable
operations, and the current `withFormulaGraphLock` is not an ownership-aware
mutex.
It cannot serialize an unrelated caller that enters while its depth counter is
positive, and `unpinTransient` can call `maybeCollect` without taking it.
This design does not claim crash-atomicity from the lock.

### Ownership boundaries

Daemon core owns the persistence, commit, construction, provisional-record,
and collection protocol below.
Host and Guest facets own the eval receipt surface.
Host owns the caplet receipt surfaces.
The CLI owns `--no-wait` mapping for `eval` and `make` only.
Harnesses (`@endo/agent-tools`, chat, and scripts) own bounded waiting policy
and later read the result name.
This design does not modify `@endo/agent-tools`.

### Context-aware graph lock

Slice 1 replaces the process-global depth counter with an explicit
`FormulaGraphLockContext` token.
`withFormulaGraphLock` enqueues every call that does not present the currently
owned token, and passes a fresh token to the queued callback.
A nested graph operation may run inline only when it presents that same token.
The token remains owned across awaited persistence and CapTP operations.

Because the token is held across CapTP name commits, every other graph
operation (formulation, provision-side graph work, and collection) queues for
the duration of a remote name write.
That global serialization is intentional: correctness of the
persist-then-commit-then-publish window takes priority over overlapping graph
work during a remote hub round-trip.
Implementations must not release the token early to reclaim concurrency.

Every graph mutation, `unpinTransient`, `maybeCollect` trigger, and collection
cleanup path must either receive the token or enqueue through
`withFormulaGraphLock`.
`unpinTransient(id, context)` decrements the graph pin under that context and
defers cleanup until the context's operation ends; an unpin without the token
queues behind the operation instead of observing a global depth counter.
The implementation must remove all direct graph mutations from the commit
window and must not retain the old depth-based fast path.
This is a normative Slice 1 requirement, not an intended property of today's
lock.

### Durable provisional name commits

The daemon database adds a `pendingNameCommit` record keyed by a unique
`commitId` and containing the formula id, result-name path, selected formula
identifier, and one of `pending` or `committed` states.
`manager-database.js` and `manager-persistence-powers.js` expose the record's
write, list, update, and delete operations.
Formula persistence and creation of the `pending` record occur in one local
database transaction, before the name commit is invoked.
No commit callback is allowed to run without that record.

The commit callback classifies its result as follows:

- `committed` means the name operation acknowledged success.
- `rejected-before-write` means the operation's local validation or authority
  path proved that no name write occurred.
- `ambiguous` means the operation failed without proving that no write
  occurred, including a lost acknowledgement after a remote write.

After the callback returns, the formula is registered in `formulaForId` and
the graph even for a rejection.
The controller is published and construction starts only for `committed`.
For `rejected-before-write`, the manager deletes the provisional record and
then explicitly invokes `formulaGraph.sweepUnreachable()` in a follow-up
context-aware lock operation.
That live sweep is the collection trigger for the persisted but unreferenced
formula; its `onCollect` cleanup deletes the durable formula JSON and drains
through `drainCollectionCleanup`.
The design does not treat collection eligibility as a trigger.

For `ambiguous`, the manager keeps the provisional record in `pending` state,
registers the formula, and does not sweep it.
For an acknowledged local commit, the local pet-store edge is observed before
the provisional record is deleted.
For a remote-capable path, the record remains a durable retention edge even
after an acknowledged commit because the remote hub's edge is not locally
observable.
It may be removed only by an explicit, verified removal or reconciliation for
that same `commitId`.
If no such observation exists, retaining the record and formula is the safe
outcome; this design places no upper bound on that residue.

On restart, `seedFormulaGraphFromPersistence` loads provisional records before
calling `sweepUnreachable` and adds each record as a retention root.
Pending records may be retried with the same `commitId` when the endpoint
supports idempotent replay.
Otherwise they remain pending until an explicit outcome is observed.
Recovery never infers "no write" from an absent remote name, so an
unacknowledged remote write cannot leave a dangling name.
Known pre-write rejection removes the record before the live sweep, which
allows collection without weakening that invariant.

`formulateWithCommit` owns the following ordered operations inside one
context-aware graph-lock section:

1. Persist the formula JSON and its `pendingNameCommit` record without
   publishing the formula to `formulaForId`, the graph, the change topic, or
   `controllerForId`.
2. Await `commitAfterPersistence(identifiers, lockContext)`.
3. Register the formula and graph edges, and publish the formula-change event.
4. For `committed`, create and publish the controller and call
   `evaluateFormula` exactly as today's `formulate` synchronous prelude does.
5. For `rejected-before-write`, release the lock, run the explicit
   post-lock `sweepUnreachable` path, and rethrow the original error.
6. For `ambiguous`, retain the provisional record and rethrow an ambiguity
   error without starting construction.

Controller publication occurs only after a successful name commit.
Consequently no eager construction can begin between persistence and naming.
Construction rejection after publication keeps today's controller eviction
and retry-on-next-`provide` behavior.
Existing waiting callers still await `value` and observe the same fulfillment
or construction rejection.
A name-commit rejection still rejects them before construction, with safe
durable residue when the outcome is ambiguous.

### Structured deferred tasks

`packages/daemon/src/deferred-tasks.js` replaces the opaque callback with this
contract and hardens the returned task collection:

```ts
type FormulaGraphLockContext = object;
type CommitOutcome =
  | 'committed'
  | 'rejected-before-write'
  | 'ambiguous';

type DeferredTask<T> = {
  preflight: () => Promise<void>;
  commit: (
    identifiers: Readonly<T>,
    lockContext: FormulaGraphLockContext,
  ) => Promise<CommitOutcome>;
};

type DeferredTasks<T> = {
  preflight: () => Promise<void>;
  commit: (
    identifiers: Readonly<T>,
    lockContext: FormulaGraphLockContext,
  ) => Promise<CommitOutcome>;
  push: (task: DeferredTask<T>) => void;
};
```

`preflight()` and `commit(identifiers, lockContext)` each run their phase in
parallel over the task list.
Preflight performs only synchronous path-syntax validation for the normative
contract.
An optional parent-hub read is a diagnostic whose rejection is recorded but
does not alter the commit outcome.
There is no `execute` alias because an opaque one-phase entry point would let a
new caller recreate the invalid order.
All current task producers in `host.js`, `guest.js`, `directory.js`,
`manager.js`, and `mail.js` migrate to the structured form in the same slice.
Empty task bags in `mail.js` (for example `formulateMarshalValue` callers that
push no name write) still migrate so they compile against the new
`preflight`/`commit` contract; they become no-op phases.
Two current callbacks, the local-guest acceptance paths in `host.js` and
`manager.js`, acquire a transient pin instead of writing a name.
They become explicit structured tasks with a no-op preflight and the existing
`pinTransient(handleId)` as commit; each remains in its own task set, and its
caller retains the existing later `@pins` write and unpin ownership.
These internal retention tasks do not satisfy the required result-name edge
for any public `start*` method.

`packages/daemon/src/directory.js` exports and hardens an internal
`makeStoreIdentifierTask(directory, petNamePath, selectIdentifier)` helper.
It normalizes the path immediately with `petNamePathFrom`.
Its preflight performs no formula, provisional-record, or pet-store writes.
Its commit calls the existing
`E(directory).storeIdentifier(path, selectIdentifier(identifiers))` and
classifies the result.
Top-level local-store tasks use the same shape with a synchronous path check
and their existing `storeIdentifier` call.
The task does not claim a writability proof, parent existence proof, or remote
liveness proof.

`packages/daemon/src/manager.js` adds
`formulateWithCommit(formulaNumber, formula, commitAfterPersistence,
nodeNumber = localNodeNumber)`.
The existing `formulate(formulaNumber, formula, nodeNumber)` remains the
no-commit convenience path for formulas that do not need a name write.
Named `formulate*` wrappers run `await deferredTasks.preflight()` before
entering the graph lock and call:

```js
return formulateWithCommit(
  formulaNumber,
  formula,
  (lockContext) => deferredTasks.commit(identifiers, lockContext),
);
```

`formulateWithCommit` uses the ordered steps above.
The context-aware lock remains held across the commit callback, but every
other graph caller queues behind it.

Caplet formulation needs one related pin change.
`formulateCapletDependencies` returns `powersPinned` instead of unpinning
immediately after the old deferred-task execution.
Each parent wrapper releases those pins in a `finally` only after
`formulateWithCommit` has registered the parent formula on both commit success
and failure, so the new persist/commit window cannot collect the powers guest
prematurely.

### Mandatory durability tests

- Unit-test `makeDeferredTasks` phase ordering and prove that preflight never
  runs a commit callback.
- Inject a pause after formula persistence and assert that no controller is
  published and `evaluateFormula` has not started before the name commit.
- Pause the same persistence-to-commit window, concurrently unpin a sentinel
  formula's last transient pin, and assert that its `onCollect` cleanup does
  not run until the context-aware lock releases.
  Then assert that the explicit post-lock sweep collects it when no retention
  edge exists.
- Inject a crash after the formula and provisional record are durable but
  before the name commit, restart, and assert that recovery seeds the record
  as retention and does not collect the formula.
- Exercise a proven `rejected-before-write` result and assert that the live
  post-lock `sweepUnreachable` trigger deletes the unreferenced formula JSON.
- Exercise a remote acknowledgement failure after a stubbed write commits,
  restart, and assert that the pending record retains the formula rather than
  creating a dangling remote name.
- A synchronously invalid result path rejects before a formula or provisional
  record write.
  A diagnostic parent-hub failure does not change the outcome.
- Concurrent `start*` calls to the same result-name path retain today's
  `storeIdentifier` overwrite semantics, while the context-aware lock keeps
  graph publication and collection ordered.
- The two local-guest acceptance retention tasks still pin the handle before
  the graph lock releases and unpin only after their existing durable `@pins`
  write.

### The receipt

```js
/** @typedef {{ id: FormulaIdentifier, locator: string }} FormulationReceipt */
```

A hardened **data-only copyRecord**: the formula identifier and its
`endo://` locator (`formatLocator` from `packages/daemon/src/locator.js`).
No promise leaf and no remotable:

- CapTP assimilates a promise contained in an eventual-send result before
  resolving the outer result.
  Because this receipt contains no promise, the caller's single `await` ends
  at creation rather than being flattened into construction.
- A `value` promise inside the receipt was considered and rejected: a
  no-wait caller by definition drops it, converting every construction
  failure into unhandled-rejection noise, and the promise dies with the
  CapTP connection while id and name survive restart.
- A receipt cannot be confused with an evaluated program's completion value
  because only the new `start*` methods return receipts; `evaluate` never
  does.

For `startMakeArchive`, `startMakeFromTree`, and
`startMakeUnconfinedFromTree`, the receipt bounds construction waiting only.
Archive packing and tree staging are creation work that happens before the
receipt and may remain unbounded for large content.

### No-wait requires a result name

`start*` methods take the result name as a **required** parameter (guarded
`NameOrPathShape`, not `.optional`).
Rationale: retention.
An unnamed formula is reachable only via transient pins, which do not
survive restart; a receipt for an unnamed formula would dangle after
`sweepUnreachable`.
The TODO frames no-wait as "commands that create and name a thing".
An unnamed variant (locator plus transient or `@pins` retention) is an open
question, not part of this design.

### Naming, replacement, and paths

`start*` reuses the existing deferred-task write,
`E(directory).storeIdentifier(resultNamePath, identifiers.<x>Id)`, so:

- Existing-name replacement keeps today's `storeIdentifier` overwrite
  semantics; the `move`-overwrites regression test remains authoritative for
  replacement.
- Nested paths resolve through directory hubs as today.
  Milestone 2 catches synchronous path syntax errors only.
  An optional parent-hub probe is diagnostic and cannot decide the outcome.
  A commit-time failure after persistence leaves a formula protected by its
  provisional record when the outcome is ambiguous; only a proven
  `rejected-before-write` result takes the explicit sweep path.
- Names land in the calling agent's namespace (host names do not leak into
  guests and vice versa; the `'guest evaluate executes code directly'` test
  is authoritative).

### Retention, collection, cancellation, workers

- Because the name is committed at creation (milestone 4), `start*` needs no
  `pinTransient`; the ephemeral-eval pin/unpin path in `host.evaluate` is
  untouched.
- `endo remove <name>` before settlement removes the formula's only edge;
  collection then cancels the in-flight construction ("became unreachable by
  any pet name path and was collected").
  This is the intended abandon story for a no-wait operation, alongside
  explicit `endo cancel <name>` (`cancelValue`, cascading through
  `thisDiesIfThatDies` contexts).
- Worker lifetime is unchanged: the eval/caplet formula's `formulaDeps`
  edge retains its worker exactly as in the waiting path.

### Restart

The receipt guarantees formula JSON and pet-store edge are durable.
After a restart, construction is **lazy on demand** (existing semantics:
`'persist spawn and evaluation'` re-derives `twenty` by lookup;
`'closure state lost by restart'` documents reconstruction ≠ state
restoration).
A no-wait operation interrupted by restart therefore re-runs on the next
`lookup`/`show`; construction is at-least-once-on-demand, not
guaranteed-background-completion.
Side-effecting programs may re-run: this is already true today for any named eval
looked up after restart.
Remote (cross-node) holders of a receipt are subject to the existing
gateway restriction ("Gateway can only provide local values") and
node-number change on restart; receipts are not a new remote-durability
promise.

### Construction outcomes

- Fulfills to pass-by-copy data: `lookup`/`show` yield the copy (within a
  session, the cached controller value; after restart, re-derived).
- Fulfills to a remotable: `lookup` yields the live reference.
- Rejects: `lookup`/`show` reject with the construction error; the
  controller is evicted, so subsequent provides retry.
  Durable memoization of construction failure is deliberately out of scope
  and deferred to [daemon-commands-as-messages](daemon-commands-as-messages.md)'s
  reply-message model (open question 2).

## API Shape

Three shapes were compared:

1. **Options record on existing methods** (`evaluate(..., { wait: false })`).
   Rejected: the return type becomes a union discriminated by an option
   value, which method guards cannot express, `@endo/exo` cannot type, and
   which makes a receipt confusable with a program that evaluates to a
   similar record.
2. **Durable operation-handle remotable.** Rejected: requires a new formula
   type and lifecycle for the handle itself; redundant because the formula
   id **is** the durable handle and the pet name already retains it.
   All later observation goes through existing naming and inspection surfaces.
3. **Parallel start methods** (chosen): for each family where no-wait is
   meaningful, a sibling method with a `start` prefix and a receipt return.
   Distinct method ⇒ distinct guard and distinct return type; existing
   methods keep their exact signatures and behavior, so conversion is
   incremental and default-wait compatibility is structural rather than
   conditional.

New facet methods (this design's full set):

| New method | Facets | Signature |
|---|---|---|
| `startEvaluate` | Host, Guest | `(workerName, source, codeNames, petNamePaths, resultName)` |
| `startMakeUnconfined` | Host | `(workerName, specifier, resultName, options)` |
| `startMakeArchive` | Host | `(workerName, archiveName, resultName, options)` |
| `startMakeFromTree` | Host | `(workerName, treeName, resultName, options)` |
| `startMakeUnconfinedFromTree` | Host | `(workerName, treeName, resultName, options)` |

`resultName` is required and positional in every `start*` sibling.
The caplet `options` records retain only optional fields.
This makes the shared required parameter consistent without changing any
waiting sibling's existing options-bag signature.

Implementation pattern (eval shown; all follow it): factor the body of
`evaluate` into an internal `evaluateInternal` returning the daemon-core
`{ id, value }`; `evaluate` keeps its current tail (ephemeral pin/unpin,
`return value`); `startEvaluate` asserts the result name, discards `value`,
and returns `harden({ id, locator: formatLocator(id, 'eval') })`.
Guards: `startEvaluate: M.call(M.or(NameOrPathShape, M.undefined()),
M.string(), M.arrayOf(M.string()), NamesOrPathsShape, NameOrPathShape)
.returns(M.promise())` (and analogously for the others, with positional
`resultName`); the resolved receipt shape is documented in `types.d.ts` as
`FormulationReceipt`.

### Promise resolution identity and value lookup

This design does **not** change `makePromise`.
At live `llm` commit `b2c1219ba`, its fulfilled construction resolves
`record.valueId`, a raw `FormulaIdentifier` string
([`manager.js#L2362-L2378`](https://github.com/endojs/endo-but-for-bots/blob/b2c1219ba483ce263d973a66536e646f1679e253/packages/daemon/src/manager.js#L2362-L2378)).
`FormulaValueTypes['promise']` is correspondingly `string` in
`packages/daemon/src/types.d.ts`.
Changing this primitive to resolve `provide(record.valueId)` would break code
that uses the promise as an identity channel: a number or record would fail
identifier validation, while an arbitrary response string could be mistaken
for an identifier.

The exhaustive live consumer inventory is:

- `makeRequest` calls `provide(promiseId)` and exposes the resulting
  `resolutionIdP` as its raw response channel.
  Waiting `request()` awaits that channel, casts and validates the result as a
  `FormulaIdentifier`, retains it with `context.thisDiesIfThatDies`, starts
  `responseP = provide(resolutionId)` for the actual value, and stores the raw
  identifier at `responseName` without awaiting `responseP`
  ([`mail.js#L1049-L1105`](https://github.com/endojs/endo-but-for-bots/blob/b2c1219ba483ce263d973a66536e646f1679e253/packages/daemon/src/mail.js#L1049-L1105)).
  This two-step control flow is why default `request()` returns a dereferenced
  value while preserving resolution identity.
- `makeDefineRequest` also calls `provide(promiseId)`.
  The returned raw response promise is not awaited by `define`; settlement is
  still owned by the persisted promise/resolver pair.
- `makeStampedMessage` calls `provide(formula.promiseId)` while rehydrating a
  request message and uses settlement only to derive its
  `'fulfilled' | 'rejected'` status.
- The message hub registers `@promise` to `promiseId` and its lookup returns
  `provide(id, 'promise')`, so `@promise` means raw resolution identity.
  The source also reserves `@result` and contains a branch that performs a
  second `provide(resolutionId)`
  ([`manager.js#L2778-L2923`](https://github.com/endojs/endo-but-for-bots/blob/b2c1219ba483ce263d973a66536e646f1679e253/packages/daemon/src/manager.js#L2778-L2923)),
  but no `registerName('@result', ...)` exists.
  Consequently `has`, `identify`, and `lookup` cannot currently reach that
  branch.
  This design neither removes the branch nor claims it as a working public
  dereference channel.

`resolve` and `reject` are not promise-id consumers.
They provide `resolverId` as a `resolver`; `resolveWithId` validates and stores
the final value's identifier in the promise store before writing the
fulfilled status record.
The existing test `'rehydrated requests can be resolved after restart'`
therefore remains correct when `lookup(['pending'])` yields `tenId`, not `10`.

The two contracts are thus distinct and normative:

- `provide(promiseId)` and message `@promise` yield the raw resolved formula
  identifier.
- `request()` and any value-oriented consumer must await that identifier,
  validate it, retain it when required, and call `provide(resolutionId)` in a
  separate step.

### No-wait request is deferred

`startRequest` and CLI `endo request --no-wait` are deliberately outside this
design.
Posting first and naming `promiseId` second is not crash-idempotent.
Once `post(to, req)` returns, the recipient's `deliver` path has persisted a
message formula in its mailbox store; that formula has dependency edges to
the promise and resolver.
The sender also delivers the message to its own inbox when sender and
recipient differ.
Each persisted message formula retains the shared promise and resolver through
its `formulaDeps` edges until that mailbox copy is dismissed.
After both mailbox copies and every other retaining edge are gone, the promise
and resolver can be collected; a committed response name instead retains the
resolved formula identifier independently of the message pair.
A crash before a caller-side response-name write therefore leaves a durable,
human-visible request and retained promise/resolver, but no retry key that the
caller can discover from `responseName`.
Repeating the call allocates a new random `messageId`, promise, and resolver
and posts a duplicate.

A sound follow-up needs a durable posting protocol, not a change to
`makePromise`.
One viable direction is a sender-owned outbox formula keyed by a stable
request key and containing the recipient id, message id, promise id, resolver
id, response path, and a post state.
The recipient would need a durable deduplication record for that stable key,
and retry would resume the same outbox entry rather than allocate a second
request.
That design must cover crashes before and after outbox persistence, recipient
mailbox persistence, recipient acknowledgement, response-name commit, and
outbox completion, including lost acknowledgements after committed writes.
It must also specify when dismissal releases each message edge, when the
outbox releases the promise/resolver, and whether the response name retains a
raw id, a dedicated dereferencing formula, or another durable link.

Current waiting `request()` remains unchanged in this design.
Its existing-name fast path suppresses a post whenever `responseName` already
names something, but the normal first-call path does not write that name until
the raw response identifier arrives from the promise formula.
It therefore provides no retry key during the pending crash window described
above.
Until a follow-up supplies the outbox/deduplication state machine and a
separate durable value channel, the raw promise identity and the explicit
second `provide` remain the compatible behavior.

## Inventory

Derivation: re-enumerated on 2026-08-07 at live `llm` commit `b2c1219ba`.
The sweep covered every method in `HostInterface` and `GuestInterface`, their
`nameHubMethodGuards`, `directoryFileMethodGuards`, and
`contentLocatorMethodGuards` spreads; the matching `EndoHost`, `EndoGuest`,
`EndoAgent`, `Mail`, `DeferredTask`, `DeferredTasks`, `FormulateResult`, and
`DaemonCore` declarations in `types.d.ts`; every method on the directory
facet; every `formulate*` function and deferred-task execution in
`manager.js`; every promise-id consumer and mailbox persistence path in
`mail.js`; the relevant daemon and CLI tests; the complete Commander registry
in `packages/cli/src/endo.js`; and the formula graph, database, and persistence
power surfaces used by provisional name commits.
The CLI currently has 51 top-level command entries, 5 nested `where`
subcommands, and 44 files in `packages/cli/src/commands/`.
The 8 root CLI test files cover clear, formula collection, list grouping,
message formatting, mount denial, number parsing, paths, and trace; none is a
focused eval, make, or request command test, so slices 2 and 3 add those
verticals rather than claiming existing CLI coverage.
Read-only, mail-control, and lifecycle methods (`lookup`, `list`,
`identify`, `locate`, `followNameChanges`, `resolve`, `reject`, `dismiss`,
`cancel`, `remove`, `move`, `copy`, `storeIdentifier`, `storeLocator`,
`locateContent`, `listContent`, `storeContent`, `reverseLocateContent`, and
`internalizeContentLocator`) create no formulas and are excluded as no-change
by construction; `move` and `copy` re-point existing ids;
`locateContent`/`listContent`/`reverseLocateContent` (`directory.js`) only
translate an existing content-bearing formula's identity into or from a
`magnet:`-style content locator.
The other `directoryFileMethodGuards` methods delegate filesystem reads and
writes to the backing mount and do not create daemon formulas.

The remaining internal core constructors are also accounted for.
`formulateNumberedHandle`, `formulateNumberedPetStore`,
`formulateNumberedMailboxStore`, `formulateNumberedMailHub`,
`formulateDirectoryForStore`, `formulateNumberedHost`,
`formulateNumberedGuest`, `formulateNumberedLookup`, `formulatePeer`,
`formulateLoopbackNetwork`, `formulateNetworksDirectory`, and
`formulateEndo` build dependencies, bootstrap state, or idempotent
infrastructure rather than a separately nameable slow result.
`formulatePromise`, `formulateMessage`, and `formulateMarshalValue` are
classified with their mail or value-producing callers below.
The existing daemon regression anchors are `deferred-tasks.test.js` plus
`endo.test.js`'s spawn/evaluate, persisted evaluation, restart rehydration,
unnamed-eval collection, request response-path, archive-error, guest-evaluate,
form, value-message, tree-restart, scratch-mount-restart, and
`makeFromTree` persistence cases.

### Group A: no-wait siblings in this design

| Method / CLI | Formulation path | Result name | Waits today | Change |
|---|---|---|---|---|
| `host.evaluate` / `guest.evaluate`; `endo eval` | `formulateEval` | optional 5th param | construction (`return value`; ephemeral: `await value` + unpin) | add `startEvaluate`; CLI `--no-wait` (requires `-n`) |
| `host.makeUnconfined`; `endo make --UNCONFINED` | `formulateUnconfined` via `prepareMakeCaplet` | `options.resultName` | construction | add `startMakeUnconfined`; CLI `--no-wait` |
| `host.makeArchive`; `endo make <archive>` | `formulateArchive` | `options.resultName` | construction | add `startMakeArchive`; CLI `--no-wait` (temp-archive cleanup reworked, see slice 3) |
| `host.makeFromTree` | `formulateFromTree` | `options.resultName` | construction | add `startMakeFromTree` |
| `host.makeUnconfinedFromTree` | `stageTreeInternal` + `makeUnconfined` | `options.resultName` | construction | add `startMakeUnconfinedFromTree` |

### Group B: already creation-only (no change; pin with tests)

| Method / CLI | Formulation path | Why conforming |
|---|---|---|
| `host.storeValue` / `guest.storeValue`; `endo store` | `formulateMarshalValue` | returns `undefined` after creation + unpin; never awaits `value`. This is the `storeValue` seam [endo-agent-tools](endo-agent-tools.md) / PR #751 consumes |
| `host.endow`; `endo endow` | `formulateEval` + `deliverValueById` | destructures `{ id: evalId }`, never awaits construction |
| `agent.submit`; `endo submit` | `formulateMarshalValue` | posts value message; returns `void` |
| `guest.define`; `endo define` | `formulatePromise` via `makeDefineRequest` | posts definition message; returns `void`. (CLI cannot name the result because a `--name` option is a separate gap, out of scope.) |
| `send`, `reply`, `editMessage`, `form`, `sendValue`, and internal `deliver` | `post` / `persistMessage` via `formulateMessage` (plus `formulateMarshalValue` for submitted form values) | acknowledgement already means durable mailbox delivery; there is no constructed result or result-name parameter to split |

### Group C: construction is fast, local, and bounded (no change)

| Method / CLI | Formulation path | Classification rationale |
|---|---|---|
| `provideWorker`; `endo spawn` | `formulateWorker` (idempotent) | worker incarnation is local process start; ack ≈ settlement |
| `makeDirectory`; `endo mkdir` | `formulateDirectory` | local pet-store creation |
| `writeText` (directory leaf) | `formulateReadableBlob` | content written during creation |
| `storeBlob`; `endo store`/`endo archive` | `formulateReadableBlob` | `contentStore.store` consumes the client-side reader **during creation**; returning early would abandon the caller's own stream |
| `storeTree`; `endo checkin` | `checkinTree` | same: content-addressing is the creation |
| `provideMount`; `endo mount` | `formulateMount` | local fs handle |
| `provideScratchMount`; `endo mktmp`; `stageTree` | `formulateScratchMount` | local |
| `provideHost` / `provideGuest`; `endo mkhost`/`mkguest` | `formulateHost`/`formulateGuest` | the dependency chain (keypair, stores, hub, worker) **is** creation; construction is quick; both idempotent. Revisit only if agent incarnation becomes slow |
| `makeChannel`, `makeTimer`, `invite` | `formulateChannel`/`formulateTimer`/`formulateInvitation` | local formulation; `invite`'s value is the invitation itself |
| `accept`; `endo accept` | `formulateGuest` + peer wiring | the peer handshake is inherent to the operation's meaning; returns `void` at completion |
| `loadContent` (agent-only, no CLI verb yet) | `formulateReadableBlob` / inline `formulate` via `manager.js` | Creation includes locator loading; see the note below. |

`loadContent` fetches and hash-verifies bytes from a `magnet:`-style content
locator's plane sources before any formula can exist.
The fetch, hash check against the locator's `xt`, and formula creation are one
inseparable sequence, so there is no meaningful creation-versus-construction
split to expose.
It also has no `resultName`-shaped parameter (see
[endo-content-locators-magnet-urn](endo-content-locators-magnet-urn.md));
naming a loaded value is a separate `storeContent`-style step.

### Group D: guard-committed to construction (no change)

`provideGit`, `provideShell`, `provideHttpClient`, `provideGitRemote`,
`provideBearerCredential`, `provideBasicCredential`, `provideGitClone` use
`M.callWhen`: their guards await construction and demand a built remotable or,
for `provideGitClone`, a record containing built remotables.
Their constructions are fast local capability wiring; converting them would
require guard changes for no benefit.
Classified no-change.

### Group E: unbounded request wait, deferred to a follow-up

| Method / CLI | Formulation path | Result name | Waits today | Change |
|---|---|---|---|---|
| `host.request` / `guest.request`; `endo request` | `formulatePromise` via `makeRequest` | optional `responseName`, written **after** resolution | raw resolution id, then dereferenced response (human-in-loop) | no change; a future no-wait sibling requires the durable outbox/deduplication protocol in § *No-wait request is deferred* |

### CLI observation surfaces (unchanged, now load-bearing)

`endo show` (`lookup` + `formatValue`) is the deferred read; `endo inspect`
(`diagnostics().getFormula`) reads the durable formula a receipt promises;
`endo trace` surfaces post-ack construction errors; `endo list`/`locate`/
`paths` observe naming and retention.
CLI plumbing note: the process exits when `withInterrupt`'s callback
resolves and `cancel()` closes the CapTP socket (`packages/cli/src/context.js`);
`--no-wait` works by simply not awaiting anything past the receipt: there is no
`process.exit` and no timer.

CLI `eval --no-wait` and `make --no-wait` output contract: print the required
result name first, followed by the receipt's locator (an `endo://` URL) on a
second labeled line to stdout.
The result name is directly consumable by `endo show <result-name>`.
Errors before creation exit non-zero as today.

## Dependencies

| Design | Relationship |
|---|---|
| [formula-inspector](formula-inspector.md) | Provides the observe-later surface (`getFormula`, `endo inspect`) for receipts returned before construction settles |
| [daemon-guest-eval-simplification](daemon-guest-eval-simplification.md) | Established `formulateEval` as the single host/guest eval path; `startEvaluate` must keep that parity |
| [daemon-commands-as-messages](daemon-commands-as-messages.md) | Natural follow-up context for durable request outboxes and durable failure outcomes; this design does not add either |
| [chat-pending-commands](chat-pending-commands.md) | UI-only consumer of pending/settled construction states exposed by named eval and caplet formulas |
| [endo-agent-tools](endo-agent-tools.md) | PR #751 context; the harness consumer. `storeValue(valueOrPromise, nameOrPath)` and code-mode `evaluate` will adopt `startEvaluate` for bounded-wait harness policy |

## Phased Implementation

Slices are individually mergeable.
The public `start*` surfaces are additive, while Slice 1 deliberately changes
the internal durable-write order for every named formulation.
No temporary public adapter is introduced or later removed.

**Slice 1: `startEvaluate` vertical plus formula-plus-name durability
(daemon).** Size M–L, risk high because the task contract, context-aware
graph lock, provisional commit record, and construction boundary are shared
by existing formula producers.
Files: `packages/daemon/src/deferred-tasks.js` (structured `preflight` and
`commit` phases), `directory.js` (`makeStoreIdentifierTask` plus migration of
its own producer), `pet-store.js` (local commit outcome and edge
observation), `manager-database.js` and
`manager-persistence-powers.js` (provisional commit records), `graph.js`
(provisional retention roots and context-routed collection), `manager.js`
(`formulateWithCommit`, failure registration, recovery seeding,
controller-publication ordering, caplet-pin handoff, and all named
`formulate*` wrappers), `host.js`, `guest.js`, and `mail.js` (migrate every
deferred-task producer, including empty bags; factor `evaluateInternal`; add
`startEvaluate`), `interfaces.js` (guard), `types.d.ts` (task contracts, lock
context, commit outcomes, `FormulationReceipt`, Host/Guest method types),
`help.md`, and generated `help-text-data.js`.
Tests (`packages/daemon/test/endo.test.js`): receipt returned while
construction pending (eval of a never-settling promise; assert `has`/
`identify` succeed and `getFormula` shows the eval record before
settlement); missing result name rejects; restart between receipt and
settlement then `lookup` re-derives; construction rejection surfaces on
`lookup` and in traces; unnamed-eval GC accounting unchanged
(`'unnamed eval results are collected'` stays green); guest namespace
isolation; waiting `evaluate` still returns the value; and every mandatory
durability case from § *Formula-plus-name durability*, including known
no-write sweep, remote ambiguous-ack retention, restart seeding, and
concurrent unpin during commit.
Crash-injection for the persistence-to-commit window is part of Slice 1
sizing, not later polish: if the existing daemon test fixture cannot pause
after formula and provisional-record durability and before name commit, Slice
1 includes the fixture or persistence-seam work those mandatory tests need.
`packages/daemon/test/deferred-tasks.test.js` covers the two-phase task
contract directly.

**Slice 2: CLI `endo eval --no-wait`.** Size S, risk low.
Files: `packages/cli/src/endo.js` (flag), `packages/cli/src/commands/eval.js`.
Tests (a new focused file under `packages/cli/test/`): `--no-wait` without
`-n` errors; with `-n` exits after creation, prints the result name and
locator, and leaves a slow eval pending; follow-up `endo show <result-name>`
prints the value; failing eval observed via `endo show <result-name>` is
non-zero and `endo trace --recent` reports the error.

**Slice 3: caplet family.** Size M, risk medium (shared
`prepareMakeCaplet` refactor).
Files: `host.js` (`startMakeUnconfined`, `startMakeArchive`,
`startMakeFromTree`, `startMakeUnconfinedFromTree` over a shared internal),
`interfaces.js`, `types.d.ts`, `help.md`, generated `help-text-data.js`,
`packages/cli/src/endo.js`, and `packages/cli/src/commands/make.js`
(`--no-wait`; remove the temp archive by name immediately after the receipt
because the `make-archive`
formula's `formulaDeps` edge, not the `tmp-archive-*` pet name, retains the
blob).
Tests: daemon start-variant coverage for unconfined and archive (note:
first-ever `makeArchive`/`makeFromTree` regression coverage rides along);
CLI `endo make --no-wait` including temp-archive removal, result-name output,
and later `show <result-name>`.

**Slice 4: conformance pinning and docs.** Size S, risk low.
Tests assert every Group B row settles without awaiting construction:
`storeValue`, `endow`, `submit`, `define`, `send`, `reply`, `editMessage`,
`form`, `sendValue`, and internal `deliver`.
There are no Group B exemptions.
The tests also pin the raw `provide(promiseId)` result and the waiting
`request()` second-dereference control flow without changing either behavior.
Delete the no-wait note from `packages/daemon/TODO.md`; sweep README and help.
Follow-up consumption of `startEvaluate` by `@endo/agent-tools` is tracked
in [endo-agent-tools](endo-agent-tools.md) (implementation issue to be
filed), not here.

### Size and LOC estimate

Total size: L, roughly 2–3 weeks.
Deferring no-wait request removes its API, CLI, mail, and crash-protocol work.
The estimate nevertheless remains L because Slice 1 now carries an explicit
two-phase deferred-task migration across all named formulation paths, a
context-aware lock, provisional name-commit persistence, caplet pin-lifetime
repair, and crash and ambiguous-acknowledgement tests.

Net production LOC (implementation only, excluding tests, generated help, and
this design document): **~380–560 lines**.
The range covers `manager.js`, `deferred-tasks.js`, `directory.js`, the task
producers and five new facet methods in `host.js`/`guest.js`, guards and types,
source help, and CLI flag plumbing in `endo.js`, `eval.js`, and `make.js`.

Total implementation churn (additions plus deletions, tests, and regenerated
help): **~800–1,200 lines**.
Tests are the largest part: phase ordering, two crash windows, ambiguous
remote acknowledgement, GC recovery, default-wait compatibility, restart,
construction rejection, per-method receipts, and two CLI verticals.

Both ranges are estimates, not commitments.
The main sources of variance are how many of the roughly 35 current
deferred-task producer sites (including `mail.js`) can use
`makeStoreIdentifierTask` mechanically, how much common factoring
`prepareMakeCaplet` permits, how many graph mutation and `unpinTransient`
call sites the context-aware lock must thread a token through, and whether
crash injection reuses the existing daemon fixture or needs a new
persistence seam (that seam work, if required, stays inside Slice 1).

The smallest useful vertical is slices 1–2: they prove receipt semantics,
the formula-plus-name durability ordering, restart durability, later
lookup, and default-wait compatibility on the `evaluate` path before the
caplet family migrates.

## Design Decisions

1. **Parallel `start*` methods, not an options record or handle**: distinct
   method, distinct guard, unconditional return type, and zero change to
   existing signatures; see § *API Shape*.
2. **Receipt is data-only `{ id, locator }`**: survives restart, passes by
   copy over CapTP, cannot be collapsed by promise assimilation, and creates
   no unhandled-rejection noise.
3. **No-wait requires a result name**: the pet name is the retention edge
   that makes the receipt durable; unnamed no-wait would dangle.
4. **Construction stays eager at first formulation, lazy after restart**:
   unchanged from today; no background-completion guarantee is added.
5. **Construction failure stays retry-on-provide, not memoized**: matches
   the existing controller-eviction semantics; durable failure records belong
   to daemon-commands-as-messages.
6. **No daemon or tool deadlines**: waiting policy is the harness's; the
   daemon exposes milestones only (PR #751 review directive).
7. **Considered and rejected:** a `value` promise inside the receipt.
   Reason: unhandled-rejection noise for no-wait callers and
   connection-lifetime instability.
8. **Considered and rejected:** a generic `start(methodName, args)` dispatcher.
   Reason: stringly-typed dispatch erodes per-method guards.
9. **`promise`-formula construction remains a raw-identifier channel.**
   Value-oriented consumers perform a separate validated `provide`.
   This preserves `request()`, mailbox rehydration, and message `@promise`
   semantics; see § *Promise resolution identity and value lookup*.
10. **Formula persistence, name commit, formula publication, controller
    publication, and construction are distinct ordered operations.**
    `formulateWithCommit` and structured deferred tasks make the order
    executable; ambiguous commit failures register rather than delete the
    durable formula, allowing graph retention or collection to recover it.
11. **No-wait request is deferred.**
    A response-name check alone cannot deduplicate a request after recipient
    mailbox persistence but before caller-side naming.
    A follow-up must supply a durable outbox, recipient deduplication, and a
    separate raw-identity-to-value observation contract.

## Open Questions

1. Should an unnamed no-wait variant exist, returning a locator and pinning
   via `@pins` (or a transient lease) instead of a pet name?
   Deferred; Group A requires names.
2. Should construction rejection be durably memoized (an error record
   observable without re-running construction), rather than retried on each
   `provide`?
   This design keeps current semantics; daemon-commands-as-messages' reply
   messages are the natural home for durable outcomes.
3. ~~Should the pet-name write move after formula persistence inside the
   locked section?~~ **Resolved** (2026-08-07): yes.
   `formulateWithCommit` persists the formula and provisional record, invokes
   the name callback under the context-aware lock, registers the formula even
   on an ambiguous callback rejection, and publishes a controller only after
   commit success.
   See § *Formula-plus-name durability*.
4. Should `endo mkhost`/`mkguest`/`accept` gain `--no-wait` later?
   Classified Group C (creation-dominant) for now; revisit if agent
   incarnation grows slow enough to matter.
5. CLI output under `--no-wait`: resolved.
   Print the required pet name first and the locator on a second labeled line;
   `endo show <result-name>` consumes the name directly.
6. Should the preflight step (milestone 2) be reused to make
   `startEvaluate`/caplet-family result-name collisions against an
   existing, differently-typed name reject up front instead of relying on
   `storeIdentifier`'s silent overwrite?
   Out of scope here: those methods have no idempotency contract, so
   overwrite-on-collision is today's intentional behavior, not a defect;
   revisit only if a future review flags it.

## Prompt

> For Endo commands that create and name a thing, like `makeUnconfined`, we
> should be able to await the promise for the creation of the formula and
> then separately, conditionally, await the construction of the formula.
> This will require a refactor of many commands and the CLI, and will allow
> the addition of a `--no-wait` flag for many commands, such that they can
> exit and allow the user to follow-up with a show command.
> `packages/daemon/TODO.md` (Kris Kowal, commit `e86cad138`)

Expanded per the maintainer's PR #751 review ("Waiting/timeouts are a
harness concern, not the tool's. The daemon still needs to work out
`--no-wait`, with waiting for everything as the default.") into a full
inventory, milestone contract, API selection, and incremental landing plan
for `endojs/endo-but-for-bots`.
