# Snapshot schema requirements from the debugging perspective

|             |                                                                                |
| ----------- | ------------------------------------------------------------------------------ |
| **Created** | 2026-09-08                                                                     |
| **Updated** | 2026-09-08                                                                     |
| **Author**  | kumavis (prompted)                                                             |
| **Status**  | Proposed                                                                       |
| **Source**  | Relocated from `rust/endo/ironhorse-store-sqlite/DEBUG_SCHEMA_REQUIREMENTS.md` |

Part of the [snapshot schema design](ironhorse-snapshot-schema.md).

Status: research and proposed implementation, not an implemented debugger or tested exporter.
Source analysis is based on experiment implementation revision `58d42d961`.
This complements the [surgery](ironhorse-snapshot-schema-surgery.md) and [GC](ironhorse-snapshot-schema-gc.md)
requirements; it does not select a new physical storage schema.

The recommendation is a backend-independent, read-only semantic graph with a native query API,
followed by a Chrome-compatible `.heapsnapshot` exporter.
Add protocol adapters only after demonstrating specific client workflows.
Most immediate value comes from exposing existing state accurately.
Source debugging, allocation histories, and identity-preserving comparisons need additional metadata
or runtime instrumentation that cannot be recovered from a single snapshot.

## Questions the tools should answer

- What keeps this object alive, through which roots and reference roles?
- Which collections, closures, or pending activities retain the most storage?
- Where are aliases to this function, including anonymous functions and prototype methods?
- Which environment, home object, bound arguments, and saved activations accompany that function?
- What are suspended generators and async activities waiting on, insofar as persisted state records it?
- What changed between snapshots, and which apparent changes are only storage relocation or ID reuse?
- Which conclusions are exact, conservative, unavailable, or based on a declared size model?

These are structural questions, not permission to execute the guest.
Reading a getter, invoking a proxy, evaluating a watch expression, or calling a custom formatter
could mutate state or invoke capabilities.
Inspection must decode stored descriptors and internal records without those operations.
A pending promise alone does not establish why it has not settled; event history and remote progress
are separate evidence.

## Relevant standards and existing tools

| Interface                      | Useful result                                                                     | Boundary                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Chrome/Edge `.heapsnapshot`    | Reuse existing graph browsing and memory-analysis UI through an exported file.    | A V8-oriented format and consumer, not a portable specification of JavaScript GC semantics. |
| Chrome DevTools Protocol (CDP) | Serve object descriptors and stream the exported graph to a compatible client.    | Implementing a few domains does not make the whole Chrome frontend work.                    |
| Debug Adapter Protocol (DAP)   | IDE variables and saved-activation views; later source or disassembly navigation. | Not a heap-analysis interchange format; a snapshot cannot step or continue.                 |
| Native graph queries           | Precise Ironhorse roles, conditional edges, provenance, and explicit uncertainty. | Requires a small CLI/API and possibly a dedicated UI.                                       |

Chrome's Memory panel offers summary, comparison, containment, and retaining-reference views.
These are attractive existing interfaces for our object graph, but their results inherit the graph
and sizes supplied by the exporter.
The comparison workflow must not be offered as evidence of surviving object identity when we have
only recycled slot indices.
See [Chrome's heap snapshot documentation](https://developer.chrome.com/docs/devtools/memory-problems/heap-snapshots).

The [Edge format description](https://learn.microsoft.com/en-us/microsoft-edge/devtools/memory-problems/heap-snapshot-schema)
describes a flattened JSON graph with metadata defining the node and edge fields and their types.
Edges are grouped by their source node's edge count; `to_node` is an offset into the flattened node
array, not an object ID.
Names generally refer into a string table, with numeric edge indices depending on edge type.
Treat the article as orientation, and the selected consumer implementation as the compatibility target.

The [V8 processor](https://chromium.googlesource.com/v8/v8/+/main/tools/heap-snapshot-processor.py)
explicitly corrects the article's treatment of `name_or_index`: element and hidden edges use numeric
indices, whereas named edge forms use string-table lookup.
The [DevTools loader](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/entrypoints/heap_snapshot_worker/HeapSnapshotLoader.ts)
also expects particular section ordering while streaming the JSON.
A generic JSON serializer's freedom to reorder fields is therefore insufficient assurance.
Pin a frontend revision and test against its loader before claiming compatibility.

[CDP HeapProfiler](https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/)
provides snapshot chunk events, object-ID mappings, and live collection/tracking/sampling methods.
Only the first two families fit a static image.
[CDP Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/)
provides property descriptors and opaque object handles, which are useful for read-only inspection.
Its evaluation and invocation operations require a different execution contract.
These are proposed mappings, not capabilities Ironhorse currently exposes.

[DAP](https://microsoft.github.io/debug-adapter-protocol/overview) separates IDEs from adapters and
negotiates capabilities during initialization.
Its [schema](https://github.com/microsoft/debug-adapter-protocol/blob/main/debugAdapterProtocol.json)
offers stack, scope, variable, source, and disassembly requests.
A postmortem adapter could present saved activations, clearly identified as persisted activities,
without pretending they are a currently executing thread stack.
Unsupported execution commands must fail explicitly; not every command has a capability flag.

Firefox offers a useful architectural precedent: its
[memory tool](https://firefox-source-docs.mozilla.org/devtools/tools/memory-panel.html)
uses a common graph abstraction for live and deserialized heaps and performs graph analyses away
from the UI thread.
We should borrow that separation before attempting another export format.
Allocation stacks require recording at runtime; Firefox's
[recording documentation](https://firefox-source-docs.mozilla.org/devtools-user/memory/basic_operations/index.html)
illustrates why they cannot be reconstructed after the fact.

## What Ironhorse already records

| Existing seam                             | Debugging value                                                                                  | Missing or misleading if used directly                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Canonical machine image and arena records | Values, flags, links, allocation state, chunks, and persisted side state.                        | Free records still contain bytes; raw slots are not a JavaScript object graph.             |
| Surgery workspace                         | `heap_slots`, `slot_values`, `names`, `functions`, and `saved_frames` give a starting inventory. | It is a partial projection, without full incoming edges, retainers, or source maps.        |
| Function rows                             | Owner, code segment/range, name, captures pointer, arity, home object, generator metadata.       | Names are not identities; no retained binding layout or original source map.               |
| Saved frames                              | Locals, IDs, arguments, environment, current function, resume PC, stack slice and control state. | Not necessarily a synchronous call stack; variable names and source scopes are incomplete. |
| Full-GC traversal                         | Owner-associated edges, root enumeration, and conditional marking rules.                         | Current callbacks do not expose all labels or root provenance as a reusable graph API.     |
| Page summaries                            | Cheap coarse graph information.                                                                  | Page co-residency and conservative roots cannot answer precise object-retainer questions.  |

Evidence lives in [machine.rs](../rust/engine/ironhorse-snapshot/src/machine.rs),
[interp.rs](../rust/engine/ironhorse-vm/src/interp.rs), and the
[surgery example](../rust/endo/ironhorse-store-sqlite/examples/vat_surgery.rs).
The current surgery inspector validates by restoring the image as well as decoding it.
A new offline decoder should separate structural validation from VM adoption, while retaining
version-matched semantics for any reachability claim.
Boot-derived roots need a versioned root manifest or a validated reconstruction helper.
Recognizing an unfamiliar container is not enough to interpret its graph safely.

There is an existing daemon [debugger interface](../packages/daemon/src/debugger.js), backed by
an XS-specific [debug session](../packages/daemon/src/debug-session.js).
That is a product/API precedent, not an Ironhorse CDP implementation.
The [debugger recovery proposal](ironhorse-debugger-recovery-and-uncaught.md)
is another related design, not evidence that its planned engine hooks exist.
The current interpreter skips source/debug marker opcodes, and the compiler
[lexer](../rust/engine/ironhorse-compile/src/lexer.rs) recognizes source URL directives without wiring
source-map behavior.

## Requirements on the logical schema

### DEBUG-1: Expose a typed graph and explain its precision

Identify entities, allocation status, ownership, root category, edge role, strength, and conditional
relationships using the same semantic definitions as validation and collection.
Include side-state references: captures, bound functions, prototypes, collections, promise reactions,
private state, saved frames, buffers, and symbol-related state.
Distinguish object identity from storage records and shared backing storage.
Separate language-visible properties from internal links and implementation bookkeeping.

Offer both a logical-object view and a forensic storage view.
A free slot is visible only as a storage record, never silently resurrected as a live object.
A root query should name the reason, such as a VM root, pending activity, or host-held reference,
with provenance and uncertainty attached.
It must not manufacture a host root merely because the inspector has an object handle.

Distinguish intended language reachability, parity with the current collector, and conservative page
reachability in results.
They are not identical today: even the full collector documents conservative symbol-key marking.
GC parity alone is therefore insufficient proof of exact language-level retained size.

WeakMap retention requires both the map and its key, with fixpoint propagation.
Do not flatten it to a strong value edge or discard it as an ordinary weak edge.
The [DevTools graph implementation](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/entrypoints/heap_snapshot_worker/HeapSnapshot.ts)
contains V8-specific WeakMap edge-name recognition and paired-edge handling.
Merely emitting an edge type named `weak` does not reproduce those semantics.
The native graph must preserve the condition even if the compatibility export cannot.
Until tested, label Chrome retention results as projection-dependent estimates and prefer the native
conditional reachability query for explanations.
Ordinary dominators over a resolved strong graph do not automatically express reclamation after
removing one input to a conditional edge.

### DEBUG-2: Separate identity, location, and names

Use an opaque entity key scoped by snapshot digest and entity kind, with the local slot or side-state
identifier as one component.
Code identity should include segment content digest and range; display name is independent.
Anonymous, name-bound, and prototype functions must remain separately addressable even when they
share a body or name.

Use deterministic export-local IDs and retain a mapping back to native keys.
Do not put a 64-bit hash into a JSON number or assume every consumer preserves arbitrary integers.
Check all numeric fields against the pinned reader's actual limits and fail explicitly on overflow.

Cross-snapshot object comparisons require allocation generations or durable lineage mappings that
survive slot reuse and relocation.
A code digest identifies code content, not a particular closure instance.
Until lineage exists, provide counts and structural/content comparisons with ambiguous matches
marked; independently numbered exports are not safe input to identity-based comparison.

### DEBUG-3: Declare the size model

Persisted bytes, VM-accounted heap size, native allocations, and resident memory are different metrics.
A [slot record](../rust/engine/ironhorse-snapshot/src/slot_codec.rs) encodes 20 bytes;
[SlotArena accounting](../rust/engine/ironhorse-vm/src/value.rs) uses capacity times 32 for XS-comparable
accounting, rather than measuring native Rust object size.
Neither number is the shallow size of a JavaScript object with properties and side state.

Start with a versioned logical persisted-payload model: attribute each allocated record and shared
chunk once, assign zero bytes to explanatory synthetic nodes, and report unassigned/reserved storage
separately.
Document inclusion of chunk headers, code, and side tables; do not quietly mix file compression or
SQLite page overhead into object sizes.
Shared buffers and code need explicit backing nodes to avoid double counting.
Reconcile the accounting totals against the declared payload domain.
Export that model through `self_size`, with a companion manifest and a prominently labeled profile.
Chrome-displayed bytes then describe this model, not Ironhorse RSS.

### DEBUG-4: Preserve source provenance without requiring it for restore

Optional debug metadata should associate code digests with source content/digests, URLs, compiler
version, PC-to-source ranges, function definitions, lexical scope/capture layouts, and symbolic
suspension points.
Distinguish original, transformed, and generated source.
A function declaration location is not an allocation stack.
Unavailable values and locations must remain unavailable, not invented zero-line source mappings.

A debug sidecar keyed to exact snapshot/code digests is a reasonable first experiment.
Verify the binding before use and define whether a snapshot references its sidecar or merely permits
one to be supplied; never trust a filename alone.
Restore must still work without optional display metadata.
Required migration layouts belong to the surgery compatibility contract, not solely an optional
pretty-printing artifact.
Allocation sites, timestamps, async causal history, and stable allocation generations require future
runtime/compiler work and an explicit checkpoint policy.

### DEBUG-5: Keep inspection bounded and observational

Queries need pagination, cancellation, traversal budgets, and explicit truncated-result markers.
Preserve JavaScript value distinctions including negative zero, NaN, BigInt, symbols, and strings;
display summaries are not lossless encodings.
Return accessor descriptors without evaluating them, and expose persisted proxy internals only as
labeled internal state.
Do not activate stored capabilities or require guest execution to render values.
Treat snapshots as privileged data; a redacted export needs its own identity and fidelity declaration.

## Implementation sketch

### 1. Backend-independent graph reader and native queries

Introduce a proposed Rust analysis module or crate adjacent to `ironhorse-snapshot`, leaving the
existing surgery CLI as one client.
It consumes a sealed, immutable snapshot through the common decoding seam, not SQLite row layout.
Memory, file, and SQLite backends should yield equivalent graphs for equivalent canonical images.
SQLite may accelerate derived indices without becoming the format's semantic authority.

The proposed `SnapshotGraph` abstraction supplies paginated entities, labeled outgoing edges, root
records, conditional rules, and size attribution.
An analysis manifest records input digest, format/decoder versions, graph precision, size model,
and optional debug-sidecar digest.
Extract reusable tracing descriptions from the full-GC implementation rather than writing an
independent incomplete list of reference-bearing fields in the exporter.

Build incoming-reference indices and bounded path-to-root queries on demand.
Cache by the complete manifest identity, including graph/decoder and size-model version.
Keep caches disposable; opening an image must not mutate it or trigger GC.
Initial CLI commands could be `inspect object`, `inspect retainers`, `inspect activities`,
`inspect census`, and `export chrome-heap`; these are proposed commands, not existing syntax.
Expose the same operations as typed library queries and JSON results.
Support disk-backed indices for large graphs; streaming the export does not eliminate the consumer's
memory cost or the global work needed for reachability/dominators.

### 2. Chrome heap export

Use two passes: enumerate logical entities, assign offsets/IDs and count edges, then stream sections
in the selected loader's required order.
Map functions to closures, collections/instances to objects or arrays as appropriate, backing code
to code nodes, and explanatory roots to synthetic nodes.
Preserve property names, array indices, capture roles, and internal ownership labels.
Optional allocation traces and source locations remain absent unless their meaning is known.
Do not fabricate DOM detachedness, allocation histories, or Wasm metadata.

Keep the forensic all-allocated view separate from the rooted analysis view.
Attaching unreachable storage to a synthetic root makes it reachable in the exported graph and
changes retention results; it is acceptable only in a separately labeled forensic export.
Export policy must explicitly describe conditional-edge approximation and any omitted entities.
An unrepresentable graph should fail or produce an explicitly degraded artifact, never silently
claim complete GC semantics.

Produce an adjacent manifest/ID map, and include the size/precision label in the profile name used
by the workflow since the Chrome file alone may not display custom metadata.
Pin the tested frontend commit in exporter tests and record it in the manifest.
Do not assume an arbitrary installed Chrome version behaves identically.

### 3. Optional protocol adapters

For CDP, prototype a narrowly scoped snapshot target supporting `Runtime.getProperties`, object
handle release, and `HeapProfiler.takeHeapSnapshot` with chunk events and bidirectional ID mapping.
Handles are opaque, session-scoped, and bound to the snapshot digest; stale or foreign handles fail.
Honor object-group lifetime without creating semantic GC roots.
Translate exact primitive values through the protocol's appropriate value/unserializable forms.
Specify which property filters are supported and reject unsupported semantics explicitly.

Test the actual frontend initialization/request sequence before advertising Chrome attachment.
Transport, target discovery, protocol versioning, and unsupported-method responses are part of that
work; domain-shaped JSON alone is not an integration.
Reject collection, tracking, sampling, evaluation, function invocation, and execution controls.
A separate live Ironhorse debugger could later implement them with runtime hooks.
Current [CDP Debugger](https://chromedevtools.github.io/devtools-protocol/tot/Debugger/)
documentation even marks `setScriptSource` as deprecated and always failing.
Snapshot surgery should remain an explicit validated patch workflow, not masquerade as live edit.

For DAP, first test read-only activities, scopes, and variables using integer adapter handles mapped
to native keys, with capability negotiation and paginated variable expansion.
Present each persisted activation chain with its actual provenance; do not invent caller chains.
With debug metadata, add source requests and mapped positions, respecting client coordinate
conventions; otherwise offer clearly labeled bytecode positions or generated disassembly.
Do not present Ironhorse bytecode in CDP's Wasm bytecode field.
Neither adapter is required for the first useful heap export.

## Experiments and acceptance criteria

1. Extract a graph for the existing anonymous, named, and prototype-method surgery fixtures.
   Verify aliases, home objects, captures, bound targets, and both saved-activation families against
   their typed records; browsing must not change snapshot bytes or execute callbacks.
2. Cover cycles, sparse arrays, shared code/buffers, accessors, proxies, private/symbol state, dead
   side-state owners, free slots with stale bytes, and WeakMaps with independently dead keys/maps.
   Compare collector-parity reachability against instrumented full-GC marks on fixture copies,
   keeping documented conservative behavior distinct from language-semantic expectations.
3. Check every entity/edge target, root provenance, size reconciliation, and deterministic output.
   Check equivalent canonical input across backends, malformed input, version mismatch, overflow,
   cancellation, pagination, foreign handles, and stale debug sidecars.
4. Import small exports through the pinned DevTools loader and actual Memory UI.
   Verify names, containment, retainers, byte totals, and weak-edge behavior against native results.
   A JSON parse test is insufficient; document precisely which retention interpretations pass.
5. Measure graph extraction time, peak memory, export size, index build cost, and bounded-query latency
   as live graph, unreachable storage, side-state volume, and sharing grow independently.
   Measure client import cost too; use results to decide whether persistent indices are worthwhile.
6. Only then prototype protocol clients and source metadata.
   A comparison fixture must include slot reuse before enabling identity-based multi-snapshot views.

## Consequences for schema design

The immediate requirement is a versioned semantic decoding/tracing contract and queryable derived
views, not conversion of every serialized value into a permanent SQL row.
Root provenance and labeled conditional ownership are shared needs with GC.
Object identity, capture layouts, code provenance, and incoming references are shared needs with surgery.
Size attribution, source navigation, and historical telemetry add debugging-specific requirements.

Start with optional derived graph/debug artifacts and explicit compatibility versions.
If later measurements justify durable object-edge indices, make their transactional consistency,
invalidation, and rebuild rules part of the store design.
If new identity or execution-history metadata changes canonical state, migrate it under the normal
snapshot-version and checkpoint rules across all backends.
Do not silently make an optional debugger cache necessary for correct restore or collection.

## Prompt

> another perspective im interested is debug-ability, what if anything is relevant to provide
> standard debug APIs or chrome debugger heap analysis APIs or similar insights into a snapshot.
> do research and sketch out an implementation. this can go in a new design document
