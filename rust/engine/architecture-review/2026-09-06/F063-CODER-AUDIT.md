# F063: coder bookkeeping audit

Source inventory: `coder.rs` at `6bca165de` contains 83 production occurrences of
`expect`, `unwrap`, `panic!`, `unreachable!`, `assert!`, `assert_eq!` or `assert_ne!`.
Comments and `#[cfg(test)]` modules are excluded.
The accompanying change removes six of these, leaving 77.
This is a site inventory, not the whole panic surface: indexing and arithmetic also need
their producer contracts, and an absent explicit assertion does not make a compiler total.
F063 remains partially open.

## Logical-assignment targets: six sites removed

`code_compound` used a `shortcut` boolean and two independently optional targets.
Six unwraps depended on matching that boolean or recognizing one of three tokens later.
It now stores the branch opcode and both targets together in one optional tuple.
Destructuring that tuple supplies the targets without an assertion.
Arithmetic assignments still allocate no targets, and logical assignments create the same
two targets in the same order, before coding the reference.
The different stack behavior of `??=` is preserved: unlike `&&=` and `||=`, it does not
emit the extra `DUB` and `POP` around the conditional branch.

Before and after the change, a temporary probe hashed bytecode, symbols and exact raw compile
meter receipts for all 1,440 assignment-matrix cases.
The five mode aggregates were unchanged using Rust 1.88.0's `DefaultHasher`:

| Mode | Aggregate |
|---|---|
| Sloppy Script | `1329cdd9d09ea3af` |
| Strict Script | `2cd9da857226f145` |
| Sloppy Eval | `1329cdd9d09ea3af` |
| Strict Eval | `2cd9da857226f145` |
| Module | `c9e475edf1401b97` |

These are comparison evidence from that toolchain, not portable golden hashes or a new gate.
The checked-in runtime test, `logical_assignment_control_flow.rs`, independently checks
180 cases: taken and untaken branches, local/private/public/super references, computed keys,
expression values, discarded statement values and loop updates.
It asserts the stored value and result as well as RHS, getter, setter and key-evaluation counts.
Temporarily swapping `&&=`'s branch opcode makes that test fail; the mutation was reverted.
The existing `logical_assignment_names.rs` tests continue to check name inference.

## Control-flow target assertions: fourteen sites examined

These arguments apply to successful compilation of parser-produced Program/Module roots.
Reported errors and meter refusals abandon the coder, rather than resuming an incompletely
restored visitor.

| Sites | Required invariant and producer |
|---|---|
| `code_program`, `code_module`, `code_function`, `code_field_init_function`: four return-target reads | Each installs a target before its body/field walk. Nested functions and field functions save and restore it. |
| `code_return`: program flag and return target | The parser permits return only in a function context; function coding clears the program flag and installs its return target before coding the body. Parameter defaults precede that installation, so their nested functions must install their own targets. |
| `code_while` (two), `code_do`, `code_for`, `code_for_in_of`: five loop-target reads | Each parser loop production wraps the loop in an anonymous Label. `code_label` pushes the break/continue targets before dispatching the loop. Named outer labels collapse with that anonymous label. For-loop headers temporarily detach the continue target only after capturing it. |
| `code_option`, `code_option_this`: two chain-target reads | Every Option created by `call_expression_inner` is wrapped in Chain on successful return. `code_chain` and `code_chain_this` install and restore the target around their child walk, including nested call arguments. |
| `finalize_targets`: original-target read | Its callers pass chains made by `alias_targets`, which sets every alias's `original` before linking it. Nested finalizers alias the aliases, then restore the preceding chain. No other production assignment clears `original`. |

The function-parameter window deserves its own boundary statement.
The function's return target is installed after parameter binding.
`await`/`yield` in the function's own formal parameters are rejected by the parser; their
coder-side refusal backstops remain in place.
Nested function bodies within defaults create and restore their own return target.
The generated declaration matrix deliberately includes such defaults, including module
function declarations whose enclosing module return target has not yet been installed.

The private `nested_finalizers_restore_original_target_chains_and_propagate_use` test
checks two alias layers over a three-target chain for all eight used-target subsets.
It checks label preservation, original links, selector advancement, restoration, propagation
of use, and empty chains.
Deleting the original-link assignment fails that test before finalization; the mutation was reverted.
The source matrices exercise those same paths through nested try/finally, iterator close,
using/await-using disposal, break/continue/return, generators and top-level module await.
The array-binding matrix separately exercises destructuring's iterator-close finalizer,
including empty patterns, holes, rest, nested patterns and defaults containing nested
try/finally functions, both inside bodies and in the module function-parameter window.

## Local guards and dispatch contracts: ten sites examined

| Sites | Argument |
|---|---|
| `compile_parser`: poisoned error read | Only private `report_kind` raises `Poisoned`, after storing the error; foreign payloads are rethrown. |
| `fuse_pull`: last-record read | The sole caller first matches `codes.last()` against a store opcode, with no intervening mutation before the call. |
| `bigint_limbs_le`: digit conversion and final limb | The lexer strips prefixes/separators/suffixes while validating digits in radix 2/8/10/16. The limb vector starts nonempty and the pop loop requires length greater than one. This is a source-entry claim, not one for externally constructed BigIntLiteral values. |
| `size2_step`: branch payload | Branch records are created by `add_branch` with a Branch payload. Optimization preserves that payload on surviving branch opcodes; rewrites to END/NO_CODE stop matching the branch arm. |
| `value_code`, `unary_code`, `compound_op`, `binary_code`: four token defaults | The dispatch arms enumerate the same token sets as these helpers. Logical-assignment tokens take the separate short-circuit path rather than reaching `compound_op`. |
| `code_for_in_of`: iteration-op default | Its only dispatch arm selects ForIn, ForOf or ForAwaitOf, exactly the three handled tokens. |

These are source-reading arguments; the generated matrices are regression evidence for
their composition, not a replacement for their stated preconditions.

## Declaration bookkeeping: ten more sites examined

This follow-up reads the declaration producers and all 29 `declare_index` call sites at
`465f7104d`, then checks their composition with real parser/scoper output.
It does not replace the remaining AST-shape and scoper-receipt audit.
All ten assertions remain defensive invariants; none is converted into an `Unsupported`
refusal, and this pass found no new source-triggered panic.

### Kinds, names, aliases and disposal adjacency: nine sites

| Sites | Producer and consumer argument |
|---|---|
| `add_variable`: required name | `hoist_declare`, `hoist_define` and `inject_arguments` create named ordinary declarations. Anonymous class slots go through `scope_coding_block`'s null-symbol branch; anonymous disposal slots use `NEW_TEMPORARY`; function aliases are retrieved, not passed here. Module imports/re-exports use `TRANSFER` instead. Root Eval cannot contain `using`, so its named-only allocation loop cannot meet a nameless disposal slot. |
| `assert_declared_kind` and strict-eval private-kind guard | Block placeholder `NoToken`s are removed by `fx_scope_hoisted`; function aliases are added at function boundaries, not blocks. Ordinary declarations are Var/Let/Const/Using/Arg/Define. Class brands, keys and initializer closures are Const, not Private. No production `new_declare` call constructs Private; unresolved private names report a scoper error rather than synthesizing an eval-root brand. |
| `code_function`: scope-kind guard | `hoist_function`/`hoist_function_no_self` put Arg, optional self-name Define and injected arguments Var in the parameter scope; body declarations have a separate Block. The only subsequent function-scope insertions are NoToken captures from `scope_lookup` and the base-constructor initializer capture. |
| `scope_coding_params`: kind and non-self-alias guards | The same function producer roster applies. NoToken captures are skipped and Define is handled before the Arg/Var/Const guard. Capturing an existing parameter sets CLOSURE on it; USE_CLOSURE is set on a new NoToken alias in the inner function, not on the Arg itself. Synthetic field functions reach this helper only after `code_field_init_function` refuses non-alias declarations, so their entries all take the NoToken skip. |
| `scope_code_store`: alias target | Its callers are ordinary and field-initializer functions. The two function-capture producers set both CLOSURE and USE_CLOSURE, preserve a non-null symbol (including `Sym::Anon`), and install an ancestor `(scope, id)` target before insertion. Module/root USE_CLOSURE declarations need not have aliases, but those scopes are never passed to this helper. |
| `scope_code_used_reverse`: following disposal slot; `code_declare_assign`: resource position | `scope_add_declare` appends each Using immediately followed by a nameless Const marked DISPOSABLE. Block cleanup removes only NoToken placeholders, and binding appends captures only to functions, so neither separates the pair. Using resolutions select the declaration inserted by that hoist. The final Eval-list reversal cannot affect a pair: program-root using is rejected by the parser's block-context check; accepted pairs live in blocks, for scopes or Module. |

The USE_CLOSURE distinction matters: an assertion over **every** scope that equated that
flag with an alias would be false for imports, re-exports and module-local indirect bindings.
The new tests count those as witnesses of the exception, not malformed captures.

### Slot assignment before access: one site, 29 readers

`set_declare_index` is the sole writer of `decl_index`; it records `(scope, stable id)`.
There is no removal or clear during coding.
The scoper's completed declaration lists are immutable, and its stable-ID provenance is
covered by [F063-SCOPER-AUDIT.md](F063-SCOPER-AUDIT.md).
Resetting `scope_level` for an embedded function changes its next frame offset, not the
outer declaration's map entry.
The module's second wrapper reassigns the same named retrieve slots before its body.

| Reader family | Calls | Assignment precedes the read |
|---|---:|---|
| Block, Eval, body-eval and parameter environment publication | 5 | Each helper allocates its declaration group before its STORE loop. Body-eval has separate var/define and lexical allocation/publication passes. |
| Loop refresh and reset | 2 | `code_for` and `code_for_in_of` scope-code the header before initialization, iteration and refresh/reset. |
| Function self-name and arguments object | 2 | `scope_code_retrieve` and `scope_coding_params` run before `code_arguments_object`, parameter defaults and `code_function_name`. |
| Module var initialization | 1 | `scope_code_retrieve` assigns the module's named indirect bindings first, before the hoisted function definitions. Anonymous import-only slots are linkage records, never resolved source accesses. |
| Resource and disposal slots | 3 | Blocks/for scopes allocate the entire pair before coding declarations. Module resources are retrieved; `scope_code_using` explicitly allocates their non-retrieved disposal temporaries before the body. |
| Resolved value/reference/assignment/private access | 5 | Scope entry allocates before child traversal; parameters before defaults, body slots before hoisted definitions, catches before parameter/body coding, and switch/loop slots before their scoped children. `scope_lookup` resolves a local or creates an alias at each crossed function boundary; unresolved global/with/eval accesses take the symbol path and do not read an index. |
| Class slots, field-member plans, base and derived initializer captures | 10 | The class-name scope is coded before heritage; class-body slots before constructor/member emission. Field functions retrieve before constructing their plans. Base constructors retrieve before the initializer call; derived `super` uses the already-retrieved alias. |
| Captures stored into a newly created function | 1 | The alias targets the enclosing declaration or an enclosing function's retrieved alias. Its scope is already allocated when child function code is entered. Coding and returning from that child does not remove the outer map entry. |

`code_define_nodes` runs after scope allocation in programs, function bodies, blocks,
catches and loops; a hoisted function capturing a later lexical declaration
therefore sees an assigned slot even though its runtime value is still uninitialized.
That is a compiler ordering argument, not a claim that JavaScript TDZ access succeeds.
Switch discriminants are scoped and coded outside the case scope; that scope's slots are
allocated before case tests and bodies, including any functions those bodies contain.
Field-function non-alias declarations remain an explicit Unsupported boundary, not an
implicit premise that such source must never be parsed.

### Checked-in evidence

`coder/declaration_invariants.rs` exercises 2,240 parameter/body/function-form/goal
combinations and 34 additional goal-specific cases for anonymous class captures, mapped
arguments, with, loops, catches, module imports/re-exports and synchronous/asynchronous disposal.
It inspects completed scoper receipts before coding, requires every resolved node to have
an assigned slot afterward, serializes successfully, and compares with the public compile entry.
Counters require that captures, anonymous captures, disposal pairs and module indirections
really occurred; successful parsing alone cannot satisfy them.
Three checked-in damaged-tree controls must fail the receipt checker: a missing alias
target, a missing USE_CLOSURE bit, and a reversed resource/disposal pair.
These controls mutate test data only; no production failure path is weakened.
The finite matrix supports the ordering arguments above; it does not prove all source total.

## Remaining forty-three explicit sites

The remaining inventory is grouped below so the next pass has exact consumers to audit.
These need the fuller parser/scoper/coder producer-and-consumer argument, especially child
traversal and AST construction; this pass does not claim to have discharged them.

| Family | Count | Consumers |
|---|---|---|
| AST shapes | 21 | `node_of` (1), `code` (1), `code_node_inner` (5), `symbol_of` (1), `code_class` reserved children/Host/member kinds (5), `code_field` kind (1), `code_params_binding` (2), `code_object_binding_assign` (1), `code_object` (1), `code_assign` (2), `code_template` (1) |
| Scoper receipts | 22 | `resolution_of` (1), `scope_of` (1), `scope_secondary` (2), four scope-count reads, `private_index` (1), `code_class` member/initializer receipts (8), field-member receipt (1), `code_field` aliases (3), base-constructor capture (1) |

The related scoper producer arguments are recorded in [F063-SCOPER-AUDIT.md](F063-SCOPER-AUDIT.md).
They do not on their own prove that every coder consumer follows the same child traversal.

## Reproducible generated evidence

`tests/coder_totality_matrix.rs` contains deterministic Cartesian products with fixed counts:

- 14,700 finalizer/statement/loop/function/goal combinations;
- 384 async, generator and module suspending-finalizer combinations;
- 770 expression/declaration-position/goal combinations;
- 1,440 assignment-target/operator/value-use/goal combinations;
- 240 array-binding-pattern/position/goal combinations.

All 17,534 compilations must succeed, not merely avoid panicking.
An earlier Syntax/Unsupported refusal therefore fails the test instead of making the
targeted coder traversal vacuous.
The runtime tests separately check logical-assignment semantics; the source matrices do not
claim that all generated bytecode has been executed.
These checked-in products supply new reproducible evidence, not a reconstruction of the
earlier unpublished 1.28-million-source run.
That historical negative is not needed to reproduce any claim made by this follow-up.

Run the compiler tests from the repository root and the VM tests with the engine manifest:

```sh
cargo test --locked -p ironhorse-compile --test coder_totality_matrix
cargo test --locked -p ironhorse-compile --lib coder::target_invariants
cargo test --locked -p ironhorse-compile --lib coder::declaration_invariants
cargo test --manifest-path rust/engine/Cargo.toml --locked -p ironhorse-vm \
  --test logical_assignment_control_flow --test logical_assignment_names
```
