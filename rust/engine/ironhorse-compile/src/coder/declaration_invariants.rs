//! F063: inspect the scoper receipts consumed by declaration coding, then
//! code the same tree. Refusals are failures, not evidence of safe traversal.

use super::*;
use crate::scoper::{dflags, Sym};

#[derive(Default)]
struct Evidence {
    functions: usize,
    aliases: usize,
    anonymous_aliases: usize,
    disposal_pairs: usize,
    module_indirect: usize,
}

fn inspect(source: &str, goal: Goal, strict: bool, evidence: &mut Evidence) {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        inspect_inner(source, goal, strict, evidence);
    }));
    if let Err(payload) = outcome {
        panic!(
            "{goal:?}, strict={strict}: {}\n{source}",
            panic_text(payload.as_ref())
        );
    }
}

fn inspect_inner(source: &str, goal: Goal, strict: bool, evidence: &mut Evidence) {
    let module = goal == Goal::Module;
    let mut parser = crate::parser::Parser::new(source, strict || module, module).unwrap();
    let mut root = if module {
        parser.parse_module().unwrap()
    } else {
        parser.parse_program(strict).unwrap()
    };
    if !module {
        let Item::Node(node) = &mut root else {
            panic!("expected program root");
        };
        node.flags |= crate::ast::flags::EVAL;
    }
    let tree = crate::scoper::run_goal_for_compile(&root, goal, crate::ParseMeter::new())
        .unwrap_or_else(|error| panic!("{goal:?}, strict={strict}: {error:?}\n{source}"));
    assert_receipts(&tree, source, evidence);

    let mut coder = Coder::new(&tree, crate::ParseMeter::new());
    coder.intern_tree(&root);
    if module {
        coder.code_module(node_of(&root));
    } else {
        coder.eval_flag = true;
        coder.code_program(node_of(&root));
    }
    assert!(coder.error.is_none(), "{source}");
    // The production declare_index assertion checks ordering at each read.
    // Also require slots for all resolved nodes, even if a consumer were
    // accidentally omitted from the coder's traversal.
    for &(scope, id) in tree.resolutions.values().flatten() {
        assert!(coder.decl_index.contains_key(&(scope, id)), "{source}");
    }
    let atoms = coder.serialize_atoms().unwrap();
    assert_eq!(atoms, compile_atoms_goal(source, goal, strict).unwrap());
}

fn assert_receipts(tree: &ScopeTree, source: &str, evidence: &mut Evidence) {
    for (si, scope) in tree.scopes.iter().enumerate() {
        if scope.token == Token::Function {
            evidence.functions += 1;
        }
        let mut disposal_pairs = 0;
        for (position, declaration) in scope.declares.iter().enumerate() {
            assert_ne!(declaration.token, Token::Private, "{source}");
            if scope.token == Token::Function {
                if declaration.token == Token::NoToken {
                    assert_eq!(
                        declaration.flags & (dflags::CLOSURE | dflags::USE_CLOSURE),
                        dflags::CLOSURE | dflags::USE_CLOSURE
                    );
                    let (owner, id) = declaration.alias.expect("function alias target");
                    let target = tree.scopes[owner]
                        .declares
                        .iter()
                        .find(|d| d.id == id)
                        .expect("alias target survives the completed scoper");
                    assert_eq!(declaration.symbol, target.symbol);
                    assert!(declaration.symbol.is_some());
                    assert_ne!(target.flags & dflags::CLOSURE, 0);
                    // An alias may forward through another function alias,
                    // but it must always point outward, never to itself.
                    let mut parent = scope.parent;
                    while parent.is_some_and(|p| p != owner) {
                        parent = tree.scopes[parent.unwrap()].parent;
                    }
                    assert_eq!(parent, Some(owner));
                    evidence.aliases += 1;
                    evidence.anonymous_aliases +=
                        usize::from(matches!(declaration.symbol, Some(Sym::Anon(_))));
                } else {
                    assert!(matches!(
                        declaration.token,
                        Token::Arg | Token::Var | Token::Define
                    ));
                    assert!(matches!(declaration.symbol, Some(Sym::Named(_))));
                    assert_eq!(declaration.flags & dflags::USE_CLOSURE, 0);
                }
            } else if scope.token == Token::Block {
                // Hoist placeholders are removed before binding. Captured
                // aliases are inserted only at function boundaries.
                assert!(matches!(
                    declaration.token,
                    Token::Var | Token::Let | Token::Const | Token::Using | Token::Define
                ));
                assert_eq!(declaration.flags & dflags::USE_CLOSURE, 0);
            }
            if declaration.token == Token::Using {
                // Eval's reversal must never reverse a resource/disposal pair:
                // root using is Module-only; program using lives in a block.
                assert_ne!(scope.token, Token::Eval);
                let disposal = scope.declares.get(position + 1).expect("adjacent disposal");
                assert_eq!(disposal.token, Token::Const);
                assert_ne!(disposal.flags & dflags::DISPOSABLE, 0);
                assert!(disposal.symbol.is_none());
                assert!(disposal.alias.is_none());
                disposal_pairs += 1;
            }
            if scope.token == Token::Module
                && declaration.flags & dflags::USE_CLOSURE != 0
                && declaration.alias.is_none()
            {
                // Module indirect bindings are NOT function captures. A
                // blanket USE_CLOSURE => alias assertion would be wrong.
                evidence.module_indirect += 1;
            }
        }
        assert_eq!(
            disposal_pairs, scope.disposable_count as usize,
            "scope {si}"
        );
        evidence.disposal_pairs += disposal_pairs;
    }
}

#[test]
fn generated_declaration_receipts_survive_all_compiler_goals() {
    let mut evidence = Evidence::default();
    let mut count = 0;
    for params in [
        "p",
        "p=outer",
        "p=()=>p+outer",
        "[p=()=>p+outer]=[]",
        "{[outer]:p=()=>p+outer}={}",
        "...p",
        "p=eval('outer')",
        "p, q=()=>p",
    ] {
        for body in [
            "return ()=>p+outer+before+after;",
            "var p; return ()=>p;",
            "function g(){return ()=>p+outer;} return g;",
            "{var v; let local; function g(){return p+local+v;} g();} return p;",
            "try{}catch(e){var e; let local; (()=>p+e+local)();}",
            "for(let i=0;i<2;i++){(()=>p+i)();} return p;",
            "using r=null; return ()=>p+r;",
            "eval('p'); return ()=>p+outer;",
        ] {
            for form in [
                "function f(PARAMS){BODY}",
                "async function f(PARAMS){BODY}",
                "function* f(PARAMS){BODY}",
                "async function* f(PARAMS){BODY}",
                "const f=(PARAMS)=>{BODY};",
                "const f=function self(PARAMS){BODY};",
                "class C {method(PARAMS){BODY}}",
            ] {
                let function = form.replace("PARAMS", params).replace("BODY", body);
                let source = format!("let outer; {{let before; {function} let after;}}");
                for (goal, strict) in [
                    (Goal::Script, false),
                    (Goal::Script, true),
                    (Goal::Eval, false),
                    (Goal::Eval, true),
                    (Goal::Module, true),
                ] {
                    inspect(&source, goal, strict, &mut evidence);
                    count += 1;
                }
            }
        }
    }
    assert_eq!(count, 2_240);
    assert!(evidence.functions > count);
    assert!(evidence.aliases > count);
    assert!(evidence.disposal_pairs > 0);
    assert!(evidence.module_indirect > 0);
}

#[test]
fn anonymous_captures_disposal_pairs_and_module_indirections_are_distinct() {
    let mut evidence = Evidence::default();
    let mut count = 0;
    for source in [
        "let outer; class C { #v=outer; [outer]=()=>outer; get #p(){return outer;} \
         set #p(v){} static #m(){return outer;} constructor(p=outer){} \
         method(){this.#v+=outer; return #v in this;} }",
        "let outer; class C extends Base { #v=outer; constructor(){super();} }",
        "function f(){using a=null; var v; using b=null; (()=>a+b+v)(); \
         {using c=null; (()=>a+c)();} eval('a');}",
        "let outer; for(let x in outer){(()=>x)();} \
         for(let x of outer){(()=>x)();} for(using x of outer){(()=>x)();}",
        "let outer; switch(outer){case 0: let x; function g(){return ()=>x;} g();} \
         try{}catch({message:x}){function g(){return ()=>x;} g();}",
        "(function self(p=()=>self){return ()=>self+p+arguments[0];});",
    ] {
        for (goal, strict) in [
            (Goal::Script, false),
            (Goal::Script, true),
            (Goal::Eval, false),
            (Goal::Eval, true),
            (Goal::Module, true),
        ] {
            inspect(source, goal, strict, &mut evidence);
            count += 1;
        }
    }
    for goal in [Goal::Script, Goal::Eval] {
        inspect(
            "function f(p,p){with({}){return ()=>p+arguments[0];}}",
            goal,
            false,
            &mut evidence,
        );
        count += 1;
    }
    inspect(
        "import 'side'; import {x} from 'm'; export {y} from 'n'; export * from 'q'; \
         using resource=null; export let local=x; export function f(){return local+resource+x;}",
        Goal::Module,
        true,
        &mut evidence,
    );
    count += 1;
    inspect(
        "await using resource=null; function f(){return resource;}",
        Goal::Module,
        true,
        &mut evidence,
    );
    count += 1;
    assert_eq!(count, 34);
    assert!(evidence.anonymous_aliases > 0);
    assert!(evidence.disposal_pairs > 0);
    assert!(evidence.module_indirect > 0);
}

#[test]
fn malformed_receipts_are_not_accepted_by_the_audit() {
    let source = "let outer; function f(){using resource=null; return ()=>outer+resource;}";
    let tree = crate::scoper::scope_program(source, false).unwrap();
    assert_receipts(&tree, source, &mut Evidence::default());
    for mutation in 0..3 {
        let mut damaged = tree.clone();
        if mutation < 2 {
            let scope = damaged
                .scopes
                .iter_mut()
                .find(|scope| {
                    scope.token == Token::Function
                        && scope.declares.iter().any(|d| d.alias.is_some())
                })
                .unwrap();
            let alias = scope
                .declares
                .iter_mut()
                .find(|d| d.alias.is_some())
                .unwrap();
            if mutation == 0 {
                alias.alias = None;
            } else {
                alias.flags &= !dflags::USE_CLOSURE;
            }
        } else {
            let scope = damaged
                .scopes
                .iter_mut()
                .find(|scope| scope.disposable_count > 0)
                .unwrap();
            let position = scope
                .declares
                .iter()
                .position(|d| d.token == Token::Using)
                .unwrap();
            scope.declares.swap(position, position + 1);
        }
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                assert_receipts(&damaged, source, &mut Evidence::default());
            }))
            .is_err(),
            "mutation {mutation} was not detected"
        );
    }
}
