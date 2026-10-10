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

## Scoper receipts: twenty-two more sites examined

This pass follows the completed scoper's maps into the coder at `de138db59`.
The contracts below assume the parser's node layouts, including symbol children,
null reserved class-init children and constructor/static-member flags.
Those AST construction obligations are part of the remaining shape audit, not
established by the mere presence of a receipt.
The maps are immutable while coding, and failed scoping never starts the coder.
No assertion is removed or weakened, and no new source-triggered panic was found.

| Sites | Producer and consumer argument |
|---|---|
| `resolution_of` (1) | Every reader selects Access, Arg/Var/Let/Const/Using/Define, PrivateMember or PrivateIdentifier, including reference, assignment, delete and receiver-aware call paths. The matching bind routines insert a row for the node's symbol. An unresolved ordinary access is a stored `None`, not an absent row. Binding patterns recurse into their declarations/references; Define separately binds its initializer. Export specifiers use linkage records, not `resolution_of`. |
| `private_index` (1) | Both private tokens go through `bind_private_member`. An unresolved brand reports a Syntax error before a tree can reach coding; the root strict-eval scope does not synthesize a brand. A valid private row therefore contains a declaration, not `None`. |
| `scope_of` (1) | Its coder callers select Program, Module, Block, Body, Function/Generator, For/ForIn/ForOf/ForAwaitOf, Class, Switch or Catch. Each has a matching hoist insertion keyed by the same stable node ID. Class field values, computed keys and private method values must retain the hoist/bind/coder traversal agreement described below. |
| `scope_secondary` (2) | Only parameter-bearing catches read it. `hoist_catch` inserts both parameter and statement scopes when child 0 is a node; parameterless catches have a null child and read the primary scope instead. Binding and coding preserve that distinction. |
| Four frame-count reads | Program, Module, Function/Generator and synthetic field functions each finish binding by inserting their frame count. Nested functions save/reset/restore the counters but do not remove earlier map entries. Field scopes come from the class's completed initializer-scope maps, not from a node ID guessed by the coder. |
| Class member receipts (4) | Hoisting inserts `at` for computed data fields and `symbol` for every private member, plus `value` for private methods/accessors. Public methods take a separate coder branch and do not read these receipts. Class member coding uses the same token/flag partition. |
| Class initializer receipts (4) | Instance data and instance private methods/accessors require instance initialization. Static data, static private methods/accessors and Body require static initialization. These are exactly the coder's nonempty field lists. Hoisting creates the instance closure and both applicable function scopes; binding fills the corresponding initializer maps before coding. A private-method-only class still needs a field function, even though its field-value hoist list is empty. |
| Field member receipt and three plan aliases (4) | Binding inserts a `class_member_fi` row for every field-list member except Body, including an empty row for plain Property. The required class slots have non-null symbols. Looking them up from the strict synthetic function reaches its immediate class parent and creates/reuses a capture. The coder retrieves that same function before mapping the row to a plan, then zips plans with the unchanged field list. |
| Base-constructor capture (1) | Class hoisting creates the instance closure before the constructor. Binding stages the class ID around the constructor, and the BASE branch installs its capture. Coding stages the same class's instance target around child 5 and searches that constructor's scope. Nested classes save/restore the staged context in both passes. |

The class traversal is split, not generic recursive visitation.
Heritage runs before entry into the class-body scope.
Computed data keys and private method bodies are hoisted, bound and coded in the class
definition context; data initializers run in the synthetic instance/static function.
Private methods/accessors precede data fields in both the binding and coding field lists.
Static blocks visit their statements directly in the static function: their Body nodes
have neither a separate ordinary Body scope nor a member-alias row.
Non-alias declarations directly in a static field function remain the explicit Unsupported
boundary in `code_field_init_function`; this audit does not claim to implement that fold.

Getter/setter pairs deserve a separate alias rule.
Their two class brand declarations share a name, and `scope_lookup` chooses the first
declaration of that name, so both field aliases refer to that canonical declaration.
Requiring each alias to target its own member's distinct brand ID would be false.
Computed-key and private-method-value symbols are anonymous and unique.

`coder/scope_receipt_invariants.rs` walks the AST independently of coder dispatch and
requires the applicable resolution, scope, frame and class receipts before compilation.
Its 1,920-case matrix crosses twelve member sets, four constructor forms, eight nesting
positions and five goal modes; another 82 cases cover binding/reference forms, generators,
async iteration, catches, with, eval, disposal and module linkage.
Every positive must compile successfully, and witness counters require resolved and
unresolved paths, private accesses, field aliases, shared brands, base captures and static blocks.
Thirteen damaged-tree controls exercise absent tables/counts, a missing catch secondary
scope, an unresolved private brand, an empty computed-field plan, a missing constructor
capture and an incorrect initializer parent.
These alter test data only and do not stand in for a proof of all source totality.

## AST follow-up: two reachable cover-grammar panics repaired

The next pass refuted two AST preconditions at `e9f054ca8` rather than merely
adding negative test evidence.
An arrow parameter that is a Member, MemberAt or PrivateMember reaches
`code_params_binding`'s token assertion; the same reference wrapped in a default,
rest or destructuring pattern can instead compile as an invalid formal parameter.
The shared `binding_from_expression` conversion was accepting assignment references
even when its requested target kind was Arg.
It now retains those references only for the Access (assignment) conversion, recursively
rejecting them from binding targets without rejecting member reads in initializers or keys.
This follows the distinction between assignment targets and
[arrow formal parameters][arrow-grammar], not a new Unsupported boundary.

[arrow-grammar]: https://tc39.es/ecma262/multipage/ecmascript-language-functions-and-classes.html#sec-arrow-function-definitions

Separately, `(...items)` reached `code_node_inner`'s unsupported-node panic with Spread.
`group_expression` collected spread while its interpretation was undecided, but did not
reject it after the arrow and async-call interpretations were ruled out.
The ordinary-expression branch now reports Syntax before constructing that Expressions node.
The arrow/rest and argument/spread branches remain accepted.

Both regressions were observed failing before their respective parser fixes.
`tests/cover_binding_totality.rs` checks 270 invalid member-parameter cases across five
goals, and requires the parser itself to reject them as Syntax.
It also checks 30 invalid grouped-spread cases, 180 valid member assignment cases,
60 valid arrow cases with member reads in defaults/computed keys, and 30 valid spread/rest cases.
Node's parser independently rejects all 54 distinct member-parameter source strings.
The runtime's `invalid_cover_grammar_is_a_catchable_syntax_error_with_the_real_compiler`
checks 16 eval/Function/strictness cases through the production compiler adapter, not a stub.
This closes the two demonstrated panic paths, not the entire node-kind/default-arm audit.
The 21-site AST inventory in the final section remains pending a complete
producer/consumer argument.

## Template AST follow-up: a wrong premise rather than a panic

Continuing the AST pass into the template family found a defect the two before it
were not: `code_tagged_template` never panicked on it, and never would have.

`code_tagged_template` sizes the cooked and raw arrays it then fills one index at a
time as `(items.len() / 2) + 1`.
That equals the number of `TemplateMiddle` nodes exactly when the items alternate
`TemplateMiddle`, expression, `TemplateMiddle`, ..., which is a claim about the
producer, made in the consumer, and checked in neither.

The producer did not hold it.
`template_expression` ports `fxTemplateExpression` verbatim, including its
`if (parser->states[0].token != XS_TOKEN_RIGHT_BRACE)` guard, so when the token
after `${` is `}` the call to `comma_expression` is SKIPPED and the next
`TemplateMiddle` is pushed directly after the previous one.
`TemplateSubstitutionTail` requires an [`Expression`][template-grammar], so every
such source is a spec early error, and both engines compiled it.

[template-grammar]: https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-template-literals

The consequence was silent.
`` `a${}b` `` evaluated to `"ab"`; `` tag`a${}b${}c` `` produced three
`TemplateMiddle` items, computed a string count of two, set `strings.length = 2`
and then wrote indices 0, 1 and 2.
The arithmetic was wrong and a JavaScript array rescued it, because writing index 2
extends the array back to a length of three.
A tag therefore saw a plausible template object assembled from a premise that had
already failed.

Both halves are closed.
The parser rejects an empty substitution as Syntax in all five goal/strictness modes,
a deliberate divergence from the pinned oracle's parser in the direction of the spec —
the same direction, and for the same reason, as the `for (let x, y in {})` rejection.
The coder counts the `TemplateMiddle` items it is about to write instead of deriving
that count from the alternation, so the size and the fill stay in step by construction
rather than by the parser's cooperation.
That second change is behaviour-identical under the now-enforced invariant and is not
independently testable from source; it is there so the consumer stops resting on a
shape it cannot see.

`tests/template_substitution_totality.rs` requires 25 invalid sources to report Syntax
in each of the five modes (125 rejections) and 25 valid controls to compile in each
(125 compilations).
The invalid roster covers empty substitutions alone, between cooked text, repeated,
mixed with well-formed neighbours in both orders, holding only whitespace or comments,
nested inside an outer template, and reached through a member tag, a computed key, a
parameter default, a field initializer and a static block.
The controls include the forms that sit closest to the rejected shape — object
literals, function and class bodies, and comma expressions, whose own `}` tokens
precede the substitution's.
Reverting the parser guard fails the invalid roster and leaves the controls green.
The runtime's `an_empty_template_substitution_is_a_catchable_syntax_error_with_the_real_compiler`
checks 16 eval/Function/strictness cases through the production compiler adapter.

This one could not have come from the corpus sweep.
No file among test262's 53,912 `.js` at the pinned revision contains an empty
substitution, by an explicit scan for `${` followed only by whitespace or comments.
(That 53,912 is every `.js` in the checkout; the sweep itself compiles 53,575 of them,
skipping 294 `_FIXTURE.js` and never reading `harness/`. The scan is the wider set, so
the negative covers the sweep.)
The sweep was therefore never going to reach it, and no committed expectation line moves.
It is a worked example of the limit `corpus_compiler_totality.rs` states about itself:
the sweep asks whether the compiler ANSWERS, and here it answered, wrongly.

The 21-site inventory in the final section is unchanged.
`code_template`'s own explicit site is `panic!("template without items list")`, which
this pass did not discharge; what it repaired was the arithmetic beside it.

## Declaration AST follow-up: a reachable `code_node_inner` panic

The template pass above found a wrong premise; running the same audit as a
generated matrix rather than a hand roster found a panic, and a nine-byte one.

`var [a];` aborts the compiler at `code_node_inner`'s unsupported-node assertion
(coder.rs:1588) with `coder: unsupported node kind ArrayBinding`.
`VariableDeclaration : BindingPattern Initializer` and `LexicalBinding :
BindingPattern Initializer` both REQUIRE the initializer, so this is a spec early
error, and `fxVariableStatement` does not check it; `variable_statement` ported
that omission.
`binding` wraps a binding that HAS an initializer in a `Binding` node, so a bare
`ArrayBinding`/`ObjectBinding` reaches the coder, where no node description
supplies a code method.
It reproduces for `var`, `let` and `const`, for both pattern kinds, empty and
elided and nested and rest patterns, in a binding list beside initialized
neighbours, in a three-part `for` head, under `export`, and inside every body
that opens a scope — and a guest reaches it with `eval("var [a];")`.
The `const`-requires-an-initializer rule for a plain `BindingIdentifier` was
already enforced, which is why only the pattern form survived.

The rejection is the parser's, as with the other three, and is a deliberate
divergence from the pinned oracle's parser in the direction of the spec.
It is conditional in a way the others were not: `ForBinding` takes NO
initializer, so `for (var [a] of xs)` is legal and `for (var [a]; …)` is not.
`variable_statement` therefore reports a bare pattern back to `for_statement`
rather than deciding alone, and `for_statement` settles it on the three-part
branch.

Which call is a `ForBinding` is passed as an ARGUMENT, and it took two wrong
answers to get there — both from trying to read it out of the ambient
`flags::FOR` instead.

Reading the flag AFTER the binding rejected 638 valid corpus files — 604 of them under
`test/language/statements/`, and only 15 anything to do with Temporal:
`binding` clears it on any `=` it consumes, including a default nested inside
the pattern, as in `for (const [value, message = String(value)] of tests)`.
Reading it at ENTRY fixed those and left a hole the other way, found by review.
The flag is ambient over the WHOLE head, nested function bodies included, so
`for (() => { var [a]; } ;;)` entered `variable_statement` with it set although
that declaration is an ordinary `VariableStatement`; the guard deferred, and
`for_statement` never received the answer, because that call is nested inside
`comma_expression` rather than being one of the head's own six. The panic was
still reachable, in all five modes, and through the production adapter it is an
uncatchable `Halt::EngineInvariant` rather than a `SyntaxError`.
The flag did not even mean one thing: a function-EXPRESSION body clears it and
an arrow body does not, so `for ((function(){ var [a]; });;)` was rejected while
the arrow form was not. Nor was the hole confined to the three-part `for` —
`for ((() => { var [a]; })().b of xs)` reached it through a `for-of` head, where
the deferred answer is never consulted at all.
An argument is positional and cannot leak, so the third answer is the one that
does not rest on state the function cannot see — which is the whole point of
this finding, arrived at the slow way.

Neither existing gate could have caught this.
The test262 sweep compiles each file's own source, and the corpus's only
occurrences of the shape — six of them, across two files — sit inside string
literals:
`staging/sm/lexical-environment/for-loop.js` asserts
`Function("for (const [z]; ; ) ;")` throws, and
`staging/sm/lexical-environment/for-loop.js` asserts
`Function("for (const [z]; ; ) ;")` throws, and two more of the same shape;
`staging/sm/regress/regress-699682.js` — whose line 11 comment reads "Don't assert
trying to parse any of these" — lists `"var {''};"`, `"var {'bad'};"` and
`"var {'if'};"` among sources to parse at runtime.
Both files compile cleanly as text, so the sweep is honestly green over them, and
the 262 harness, which would execute them, excludes `staging/`.
An explicit before/after run of the compiler over all 53,575 corpus sources in
three modes confirms it: zero of the 160,725 outcomes change, for this fix or the
template one, so no committed expectation line moves.

Evidence.
`tests/destructuring_declaration_totality.rs` requires 61 invalid sources to
report Syntax in each of five modes (305 rejections) and 39 controls to compile in
each (195 compilations); the controls are load-bearing, since the rule must NOT
fire on a `ForBinding`, on assignment destructuring, or on a function parameter.
Nineteen of the invalid entries are the bodies-opened-from-a-`for`-head roster,
which the first two attempts had no case for at all — that absence is why review
found the hole and the suite did not.
Reverting any of the three halves of the fix fails the invalid roster and leaves
the controls green; so does reinstating either wrong reading of `flags::FOR`.
The runtime's `a_pattern_declaration_without_an_initializer_is_a_catchable_syntax_error`
checks 24 eval/Function/strictness cases through the production compiler adapter,
including the two corpus strings above.

`tests/ast_shape_matrix.rs` is the net that found it, and is checked in as the
corpus sweep's counterpart on the other side of the grammar: 67 fragments spliced
into 81 positions across five modes, 27,135 compilations, none of which may panic.
The positions are chosen from the remaining-sites table below rather than from
intuition.
Six of them splice a declaration into a body opened from a `for` head, and they
are there because the matrix did NOT catch the hole above on its first try: its
`for` rows spliced the fragment as an EXPRESSION, so no row of 25,125 cells ever
built the shape. A generated net is only as good as the positions in it, which is
the same limit the roster has and the reason neither replaces review.
Like the corpus sweep it asks only whether the compiler ANSWERS, not whether the
answer is right, and like the corpus sweep it is a floor rather than a proof — a
product of two hand-written lists is exactly as good as those lists.

The inventory below is UNCHANGED at 21, and an earlier draft of this section
claiming 20 was wrong.
`code_node_inner`'s fifth site is a single catch-all — `other => panic!("coder:
unsupported node kind {:?}", other)` — standing for every node kind that reaches
the coder without a code method. Making one kind unreachable does not discharge
it, as the immediately preceding pass already established: `544d225d` stopped
`(...items)`'s `Spread` reaching that same catch-all and deliberately kept the
count at 21.
The claim that this pass "made the producer total" was also false when first
written, and review rather than either new gate is what established that.

## `[In]` is a grammar parameter, not an ambient mode

The declaration fix above was the third answer to one question — is this call a
`ForBinding`? — and the two wrong ones were both reads of `flags::FOR`. That
flag is the parser's model of the `[In]` grammar parameter, and modelling a
positional parameter as ambient state had produced two more defects beside the
panic, in opposite directions. Both are fixed here, because they are the same
root cause and splitting them would leave the audit's conclusion half-stated.

**Over-rejection.** Every production the grammar writes `[+In]` resets the
parameter. Several did not clear the flag, so valid source was refused:
`for ((a in b);;)`, `for (f(a in b);;)`, `` for (`${a in b}`;;) ``,
`for (x[a in b];;)`, and every arrow body — `for (x => (a in b);;)`.
A function-EXPRESSION body already cleared it, so the two spellings of one
program disagreed, exactly as they did for the panic.
The parenthesized, argument-list, computed-member and template-substitution
productions now save/clear/restore the flag, which is the idiom the class,
object-literal, array-literal, conditional-consequent and dynamic-import arms
already used; `arrow_expression` clears it as `function_expression` does.

**Under-rejection.** `[~In]` covers the WHOLE `VariableDeclarationList`,
initializers included, but the flag was cleared on the first `=` and again on
each comma, so `for (var x = "a" in {};;)` and
`for (var x = 1, y = "a" in {};;)` — spec early errors — compiled. Both clears
are gone; the `in` now ends the head and `for_statement`'s existing `Binding`
and `Statements` arms reject it.

`tests/for_head_in_scope.rs` holds both directions: 23 sources that must compile
in all five modes and 6 that must be refused in all five. The accept roster is
load-bearing in a way worth naming — its arrows need an IDENTIFIER parameter
(`x => …`) as well as a parenthesized one, because `( Expression[+In] )` alone
satisfies the parenthesized spellings and would leave the arrow-body reset
untested. Removing the arrow clear fails it; reinstating either declaration-list
clear fails the refuse roster.

Not changed, and pinned so a later pass has to come here and say so:
`for (var x = 0 in {})`, the Annex B `VariableStatement`-in-`for-in` form, is
still refused. That is a separate pre-existing divergence.

Compiling all 53,575 corpus sources in three modes still moves none of the
160,725 outcomes, with these changes included.

## Annex B.3.5: the one initializer a `for-in` head may keep

`for ( var BindingIdentifier Initializer in Expression )` was refused outright.
That was a conformance divergence rather than a fault, so the `[In]` pass above
pinned it and moved on; this closes it.

The grammar is narrow and each clause is load-bearing: `var` only, `in` only
(never `of`), one binding, a `BindingIdentifier` target, sloppy code only.
`variable_statement` returns those four in `HeadBindings` and `flags::STRICT`
settles the fifth, module code being always strict.

The parser half alone would have been worse than the refusal. It accepted the
shape and the coder dropped the initializer, so `for (var x = 'init' in {}) ; x`
evaluated to `undefined` and a side-effecting initializer never ran at all.
`code_for_in_of` had been handing the whole `Binding` node to its own
`code_assign`, whose `Binding` arm is the DESTRUCTURING-DEFAULT rule — take the
supplied value unless it is `undefined`, otherwise evaluate the initializer — and
a for-in key is never `undefined`, so the initializer was emitted inside the loop
as dead code. It is now emitted once, before the head expression, and the loop
targets the inner node. Accepting a shape the back end cannot execute is the
same defect class as the rest of this finding, pointed at ourselves.

`ironhorse-vm/tests/annex_b_for_in_initializer.rs` holds the four blocks of
test262's `nonstrict-initializer.js` reduced to the values they assert, plus
ordering and arity separately: the initializer runs exactly once, before the head
expression, and its value is visible to that expression. Every expectation was
checked against Node.

### It is recorded as an over-acceptance, and that label understates it

The pinned oracle REJECTS this source — `SyntaxError: missing ;` — so the harness
files the disagreement as
`over-acceptance: ironhorse completed a source the oracle rejected`, which is the
category it also uses for genuine safety problems. Here it is the opposite:
`annexB/language/statements/for-in/nonstrict-initializer.js` is a POSITIVE test
asserting exactly the semantics implemented above, Node accepts it, and XS is
the engine that is wrong.

The committed shard moves from `fail:"error-message-differs:…"` to
`fail:"over-acceptance:…"` — one recorded failure before and after, regenerated
by the harness rather than hand-edited. The four sibling files the change also
touches (`strict-initializer.js`, `var-arguments-{fn-,}strict-init.js`,
`var-eval-strict-init.js`) are `flags: [onlyStrict]`, so the harness runs them
only in strict mode, where behaviour is unchanged and they stay `pass`.

This is the direction the whole-tree expectations have no vocabulary for. The
error-model sweep has a `KNOWN_DIVERGENCES` list for exactly this; the whole-tree
shards do not, and a future pass that wants the distinction should add one rather
than read this line as a defect.

It is not a stale pin. `c/moddable` is at `23b4d6b0` (2026-07-07, "version bump
8.3.1"); upstream `public` had moved to `b6e06ba7` (2026-09-04) when this was
checked, and `fxVariableStatement` is byte-identical between the two. The gap is
live upstream behaviour.

And upstream wrote this feature and disabled it. `fxVariableStatement` carries the
Annex B initializer commented out in place:

```c
//  if (parser->states[0].token == XS_TOKEN_ASSIGN) {
//      parser->flags &= ~mxForFlag;
//      fxGetNextToken(parser);
//      fxAssignmentExpression(parser);
//      fxPushNodeStruct(parser, 2, XS_TOKEN_ASSIGN, aLine);
//      fxPushNodeStruct(parser, 1, XS_TOKEN_STATEMENT, aLine);
//  }
```

which is the mirror of the `for (let x, y in {})` precedent on this branch,
where the oracle's own CHECK is commented out and it under-rejects. Here the
oracle's own SUPPORT is commented out and it over-rejects. Two divergences from
one habit, in opposite directions, and the reason a parity corpus cannot be the
definition of correct on its own.

Note the shape upstream intended differs from the one taken here: it pushes an
`ASSIGN`/`STATEMENT` pair at the declaration level, where this emits the
assignment in `code_for_in_of` ahead of the head expression. Both put the
initializer before the enumeration; if the pin is ever bumped past a commit that
re-enables that block, the two want reconciling rather than stacking.

## Remaining twenty-one explicit sites

The remaining inventory is grouped below so the next pass has exact consumers to audit.
These need the fuller parser/scoper/coder producer-and-consumer argument, especially child
traversal and AST construction; this pass does not claim to have discharged them.

| Family | Count | Consumers |
|---|---|---|
| AST shapes | 21 | `node_of` (1), `code` (1), `code_node_inner` (5), `symbol_of` (1), `code_class` reserved children/Host/member kinds (5), `code_field` kind (1), `code_params_binding` (2), `code_object_binding_assign` (1), `code_object` (1), `code_assign` (2), `code_template` (1) |

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
cargo test --locked --release -p ironhorse-compile --test ast_shape_matrix
cargo test --locked -p ironhorse-compile --test template_substitution_totality
cargo test --locked -p ironhorse-compile --test destructuring_declaration_totality
cargo test --locked -p ironhorse-runtime --test runtime_compile_meter
cargo test --locked -p ironhorse-compile --lib coder::target_invariants
cargo test --locked -p ironhorse-compile --lib coder::declaration_invariants
cargo test --locked -p ironhorse-compile --lib coder::scope_receipt_invariants
cargo test --manifest-path rust/engine/Cargo.toml --locked -p ironhorse-vm \
  --test logical_assignment_control_flow --test logical_assignment_names
```
