//! A deterministic invalid-source matrix over the AST-shape sites (F063).
//!
//! `corpus_compiler_totality.rs` is the gate that does not depend on someone
//! thinking of the shape, and it has a shape of its own: test262 is mostly
//! VALID source, plus negative fixtures a conforming parser rejects early. The
//! panics this finding has actually produced were all reached by INVALID
//! source that the parser accepted and handed on — `try{}catch{function f(){}}`,
//! `for (let x, y in {})`, `(object.x)=>0`, `(...items)`, `var [a];`. Two of
//! those five the corpus could not have caught at all: the last one occurs in
//! test262 only inside string literals, and the first's one directly nested
//! case is a `negative: parse` fixture.
//!
//! So this is the corpus sweep's counterpart on the other side of the grammar:
//! a Cartesian product of odd fragments spliced into the positions whose
//! consumers appear in the coder audit's remaining-sites table — `node_of`,
//! `code`, `code_node_inner`, `symbol_of`, `code_class`, `code_field`,
//! `code_params_binding`, `code_object_binding_assign`, `code_object`,
//! `code_assign` and `code_template`.
//!
//! **What it checks is only totality.** Every cell must ANSWER — compile or
//! report — and most of them are supposed to report. Whether the answer is the
//! RIGHT one is not asked here, because the matrix is generated and nobody has
//! read all 25,125 cells; the targeted suites and the 262 harness make the
//! stronger claims. A cell that should be a `SyntaxError` and compiles passes
//! here, exactly as in the corpus sweep.
//!
//! It is still not a proof, for the same reason the corpus sweep is not: a
//! product of hand-chosen fragments and contexts is as good as the two lists.

use ironhorse_compile::{compile_atoms_goal, Goal};

const MODES: &[(Goal, bool)] = &[
    (Goal::Script, false),
    (Goal::Script, true),
    (Goal::Module, false),
    (Goal::Eval, false),
    (Goal::Eval, true),
];

/// Fragments that sit on a cover-grammar or node-kind edge: references where a
/// binding is wanted, patterns where a reference is wanted, spread and rest
/// outside their own grammars, contextual keywords, private names and `super`.
const FRAGMENTS: &[&str] = &[
    "a",
    "0",
    "'s'",
    "this",
    "this.#x",
    "obj.x",
    "obj[k]",
    "...a",
    "a=0",
    "[a]",
    "[a=0]",
    "[...a]",
    "{x:a}",
    "{x:a=0}",
    "{...a}",
    "{x}",
    "{x=0}",
    "[obj.x]",
    "{x:obj.x}",
    "{...obj.x}",
    "[...obj.x]",
    "[this.#x]",
    "()",
    "(a)",
    "(a,b)",
    "(...a)",
    "([a])",
    "({a})",
    "new.target",
    "`t`",
    "`${a}`",
    "tag`${a}`",
    "async",
    "await",
    "yield",
    "arguments",
    "function(){}",
    "class{}",
    "()=>0",
    "async()=>0",
    "function*(){}",
    "a?.b",
    "a?.[0]",
    "a?.()",
    "#x",
    "super.x",
    "super()",
    "0n",
    "/r/g",
    "[]",
    "{}",
    "[,]",
    "[a,]",
    "{a,}",
    "[[a]]",
    "{a:{b}}",
    "...[a]",
    "...{a}",
    "a.#x",
    "let",
    "static",
    "get",
    "set",
    "of",
    "from",
    "as",
    "eval",
];

/// The positions those fragments are spliced into, one or more per consumer in
/// the remaining-sites table.
const CONTEXTS: &[&str] = &[
    // `code_params_binding`, `code_object_binding_assign`.
    "({FRAG})=>0;",
    "(FRAG)=>0;",
    "async(FRAG)=>0;",
    "function f(FRAG){}",
    "function*f(FRAG){}",
    "async function f(FRAG){}",
    "({m(FRAG){}});",
    "(class{m(FRAG){}});",
    "(class{static m(FRAG){}});",
    "(class{constructor(FRAG){}});",
    "(class{#m(FRAG){}});",
    "try{}catch(FRAG){}",
    // `code_object`, `code_assign`.
    "({FRAG});",
    "({FRAG}=x);",
    "[FRAG]=x;",
    "(FRAG)=x;",
    "FRAG=x;",
    "FRAG+=x;",
    "FRAG&&=x;",
    "FRAG??=x;",
    "FRAG||=x;",
    "for(FRAG of []);",
    "for(FRAG in {});",
    "for await(FRAG of []);",
    // Declarations, where `var [a];` lived.
    "var FRAG;",
    "let FRAG;",
    "var FRAG=0;",
    "let FRAG=0;",
    "const FRAG=0;",
    "for(var FRAG;;);",
    "for(let FRAG;;);",
    "for(var FRAG=0;;);",
    // `code_class` reserved children, Host and member kinds; `code_field`.
    "(class{FRAG});",
    "(class{static FRAG});",
    "(class extends FRAG{});",
    "(class{[FRAG](){}});",
    "(class{p=FRAG;});",
    "(class{static{FRAG;}});",
    "(class{get FRAG(){}});",
    "(class{set FRAG(v){}});",
    "(class{static #p=FRAG;});",
    // `code_template`, `symbol_of`, `node_of`, `code`, `code_node_inner`.
    "`${FRAG}`;",
    "tag`${FRAG}`;",
    "({[FRAG]:1});",
    "FRAG;",
    "(FRAG);",
    "f(FRAG);",
    "new f(FRAG);",
    "[FRAG];",
    "({...FRAG});",
    "FRAG?.x;",
    "typeof FRAG;",
    "delete FRAG;",
    "void FRAG;",
    "!FRAG;",
    "FRAG++;",
    "++FRAG;",
    "export default FRAG;",
    "export {FRAG};",
    "import FRAG from 'm';",
    "({a:FRAG}=x);",
    "[,FRAG,]=x;",
    "[FRAG]=[];",
    "({a:FRAG});",
    "label: FRAG;",
    "if(FRAG);",
    "while(FRAG);",
    "do;while(FRAG);",
    "switch(FRAG){}",
    "switch(0){case FRAG:}",
    "throw FRAG;",
    "function f(){return FRAG;}",
    "with({})FRAG;",
    "async function f(){await FRAG;}",
    "function*f(){yield FRAG;}",
    // A body opened from a `for` head. `flags::FOR` is ambient across the whole
    // head, so a declaration in here is reached with it set although it is an
    // ordinary statement — the shape that hid a reachable `code_node_inner`
    // panic from every other row of this matrix.
    "for(()=>{var FRAG;};;);",
    "for(()=>{let FRAG=0;};;);",
    "for(f(()=>{var FRAG;});;);",
    "for((()=>{var FRAG;})().b of []);",
    "for(function(){var FRAG;};;);",
    "for(()=>{FRAG};;);",
];

/// The product is fixed, so a shrunk list is a visible change rather than a
/// quietly smaller sweep.
const EXPECTED_CELLS: usize = 27_135;

#[test]
fn no_generated_ast_shape_panics_the_compiler() {
    let mut panics = Vec::new();
    let mut cells = 0usize;
    for context in CONTEXTS {
        for fragment in FRAGMENTS {
            let source = context.replace("FRAG", fragment);
            for &(goal, strict) in MODES {
                cells += 1;
                let owned = source.clone();
                if let Err(payload) =
                    std::panic::catch_unwind(move || compile_atoms_goal(&owned, goal, strict))
                {
                    let message = payload
                        .downcast_ref::<String>()
                        .cloned()
                        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                        .unwrap_or_default();
                    panics.push(format!("{source:?} ({goal:?}, strict={strict}): {message}"));
                }
            }
        }
    }
    assert_eq!(
        cells, EXPECTED_CELLS,
        "the matrix changed size; update EXPECTED_CELLS deliberately"
    );
    assert!(panics.is_empty(), "{}", panics.join("\n"));
}
