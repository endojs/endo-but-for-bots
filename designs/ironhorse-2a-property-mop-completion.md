# IronHorse 2A: property/MOP seam completion

This change addresses F056, F061, F060, F072, F085, and F102.
It starts from `26bbe71b6` and is integrated with `bots/llm` at `219f3b9d9`.
The historical architecture review remains unchanged.
Its final `1b130df7` status paragraphs, rather than stale source coordinates,
provided the remaining-work scope.

## Enforcement and behavior

Guest property operations use the complete MOP dispatchers.
The old `instance_get`, `instance_has`, and `instance_put` helpers are gone.
`ordinary_get` and `ordinary_set` are visible only within the property module.
`boot_chain_get` has a mechanically checked boot/restore allowlist.
`resolve_frame_get` handles local and captured bindings; global reads use MOP.
The host `global_string` diagnostic reads only own data properties.

The option reader preserves proxy traps and receiver identity even when an option
name has never been interned, without interning every absent ordinary option.
It consults the authoritative object tables; upstream's removed classification
index is not reinstated.
Recording-proxy and accessor tests cover the remaining built-in paths.
The membrane test compares six operations on twenty representative shapes.

Relinking preserves guest redefinitions and deletions of Error's stack accessor
and the async-generator prototype's constructor.
Implicit native property dependencies are installed on both initial and later
links, with the existing installed-name filter protecting earlier guest edits.

Guest string values, Error messages, RegExp source, eval source, and Function
source retain UTF-16 code units.
`alloc_str_text` accepts valid Rust text instead of lossy decoding of byte slices.
Scalar-only option boundaries reject unpaired surrogates explicitly.
The existing CESU-8 SymbolName representation and migrations remain in place.
Lossy Rust text is confined to diagnostics, including upstream's read-only error
renderer, which never invokes guest accessors or conversion hooks.
The new UTF-16 boundary fuzz target has an oracle-free corpus test.

Restore is an owned, non-executable session with a uniform row-naming Result API.
Every public restore verb must appear in the generated admission roster and admit
its own row before work; refusal or panic prevents the session from finishing.
Cheap owner, shape, ordering, and coordinate checks run inside the VM verbs.
Atomic preparation precedes publishing function, generator, and promise clusters.
Finish checks cross-row obligations before returning an interpreter.
Private arenas and a capability bound to the original arena pair prevent callers
from bypassing the session or acknowledging another heap's store commit.

The first rejection still unhandled after a successful crank's job drain is
reported through RunOutcome, EvalOutcome, and the interpreter getter.
Same-crank handlers suppress reporting; later handlers do not erase its history.
Ordered candidates preserve settlement order until boundary selection.
The report roots the promise, whose existing result stores the reason, and travels
through snapshots without guest conversion.
The host refreshes the report after scheduled collection or recovery because a
returned Slot refers to coordinates in the current heap.
Format 20 and store schema 31 carry the optional promise-owner suffix.
Older payloads have no historical report; migration cannot recover settlement order.

## Numerical recount

Counts below are method-call token sequences in all Rust files under
`ironhorse-vm/src`, including inline and source-tree unit tests.
They exclude comments, strings, and function declarations using the repository's
`source_scan::code_only` and `source_scan::tokens` utilities.
A call is the consecutive token sequence `.` / method name / `(`.
Definitions are counted separately as `fn` / name.
This avoids treating prose, regression-test source strings, and allocator names
as property or conversion calls.

| Finding or method | Review assertion | Start `26bbe71b6` | Integrated base `219f3b9d9` | Completed tree |
| --- | --- | --- | --- | --- |
| F056 `instance_get` | 35 | 30 | 31 | 0 |
| F056 `instance_has` | 9 | 3 | 3 | 0 |
| F056 `instance_put` | 1 | 4 | 4 | 0 |
| F056 `resolve_get` | 2 | 2 | 2 | 0 |
| F056 combined old helpers | 47 | 39 | 40 | 0 |
| `ordinary_get` | 45 | 48 | 48 | 7, all inside property |
| `ordinary_set` | — | 9 | 9 | 5, all inside property |
| `mop_get` | 21 | 137 | 137 | 181 |
| `mop_set` | — | 38 | 38 | 42 |
| `boot_chain_get` | — | 0 | 0 | 11: 5 boot/restore, 6 tests |
| `resolve_frame_get` | — | 0 | 0 | 2, frame bindings only |
| `mop_get_option_field` | — | 0 | 0 | 17: 6 Intl, 11 Temporal |
| F085 `str_text` | 35 | 31 | 30 | 0 |
| `str_text_lossy` | proposed rename | 0 | 0 | 3 diagnostics |
| `alloc_str_text` | 46 | 34 | 35 | 20, valid text input |
| `to_string_bytes_metered` | 15 in final status | 15 | 15 | 0 |
| `value_to_string` | lossy helper | 23 | 23 | 0 |
| `to_string_units` | approximately 30 in earlier status | 54 | 54 | 62 |
| `to_string_units_metered` | — | 4 | 4 | 8 |

F085's original 83 raw grep lines comprised 35 reads, 46 allocator calls, and two
definitions; it was not an 83-call lossy-read count.
The equivalent token categories at the start total 67, and at the integrated base
also total 67; the completed renamed categories total 25 (3 + 20 + 2 definitions).
The seven lossy key-identity sites from earlier revisions were already fixed at
our base and remain fixed; they are not claimed as new work here.
The Error U+D800 probe now retains code unit 55296 rather than becoming 65533.
The fuzz roster grows from ten to eleven targets; the design's “target 4” is the
previously missing UTF-8/UTF-16 boundary category, not a claim of four targets.
Its deterministic test uses six edge cases and sixty-four generated cases.

F061's original four bypass sites plus trapless ownKeys, the intermediate seven
paths/sixteen sites, and final five paths/thirteen sites now have zero surviving
calls to the removed bypass helpers.
Coverage includes the requested twenty shapes times six operations, plus focused
proxy/accessor probes; this is not an exhaustive enumeration of JavaScript objects.

F060's two branches are guarded, and its requested four regression arms are
covered by six cases: data redefinition, accessor redefinition, and deletion for
each branch.
F072's review count was twenty-one verbs: five unit-returning and sixteen boolean.
Both inspected bases actually expose twenty-two: five unit-returning and seventeen
boolean; the completed API has twenty-two Result-returning session verbs and zero
public restore verbs on Interp.
The proposed “22nd verb” drift hazard is checked mechanically by the roster rather
than depending on that historical number.
F102 still has one production caller of the old boolean predicate, in the 262
harness, and retains its O(promises) behavior for that caller.
The new historical report is available to the production embedder.

## Retained costs and limits

The derived property index remains, with randomized mutation tests against the
authoritative chains, including shared tails, duplicate names, and slot reuse.
CESU-8 keys, UTF-16 values, and diagnostic Rust strings remain distinct forms.
RegExp retains its encoded scratch allocation; these tests do not establish
identical behavior at every allocation or meter limit.
The ordered rejection-candidate Vec retains capacity after clearing, and the first
reported promise and reason remain rooted for the lifetime of that history.
The report does not copy a second reason Slot into persistent VM state.

Mapped argument cells are checked in both current array and legacy index layouts.
Their projected values must have valid guest shapes, and finish requires an
arguments brand before exposing the interpreter.
Bulk restore validates cheap shapes while preserving deferred lazy string/BigInt
contents, duplicate-first-live semantics, and collection tombstones.
This is not a proof of every arbitrary heap edge, prototype graph, chunk block
boundary, or deferred payload.
Existing unsupported JSON surrogate syntax remains an explicit refusal; this work
does not claim complete JSON conformance.
The XS oracle was not run.

Upstream's quiescent-only collection admission, shared catch-scope maps, checked
stack operands, reserved environment/key IDs, and read-only diagnostic rendering
are preserved.
The candidate 2G task remained unassigned and on standby when checked; no work was
assigned to it or assumed complete.
The source guards use the current shared token scanner and module layout.

## Validation

The final integration uses oracle-free VM and snapshot tests, including restore
refusals, mapped arguments, membrane equivalence, relink preservation, UTF-16
boundaries, report persistence, and collection admission.
Compiler and RegExp tests pass.
The Endo engine's twenty host tests pass, including report refresh after scheduled
collection and recovery from a collection panic.
Both Rust workspaces pass all-target compile checks.
Strict VM clippy passes with warnings denied.
Engine formatting passes.
Rustdoc completes with fifty-nine VM warnings about existing links and private
items; it is not a warning-free documentation build.
No XS oracle tests or differential oracle suite were run.

Each implementation increment and rebase conflict resolution received an
adversarial read-only subagent review before commit.
The final review found no remaining blocker, with the limitations above retained.
