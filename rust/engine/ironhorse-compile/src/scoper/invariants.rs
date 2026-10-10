//! Phase-boundary checks for F063. These inspect private hoist receipts and
//! declaration indexes, which the public ScopeTree deliberately does not keep.
//! Every fixture must parse, hoist and bind; an early error is not a pass.

use super::*;

fn parse(source: &str, goal: Goal, strict: bool, eval_token: bool) -> Item {
    let module = goal == Goal::Module;
    let mut parser = Parser::new(source, strict || module, module).unwrap();
    let mut root = if module {
        parser.parse_module().unwrap()
    } else {
        parser.parse_program(strict).unwrap()
    };
    // The compiler sets EVAL on program roots; scope_program leaves the
    // parser's Program token alone. Exercise both entry-point conventions.
    if eval_token {
        let Item::Node(node) = &mut root else {
            panic!("parser did not return a node");
        };
        node.flags |= flags::EVAL;
    }
    root
}

fn nodes(item: &Item, token: Token) -> Vec<&Node> {
    let mut found = Vec::new();
    match item {
        Item::Node(node) => {
            if node.token == token {
                found.push(node.as_ref());
            }
            for child in &node.children {
                found.extend(nodes(child, token));
            }
        }
        Item::List(items) => {
            for item in items {
                found.extend(nodes(item, token));
            }
        }
        _ => {}
    }
    found
}

fn assert_declaration_indexes(scoper: &Scoper<'_>) {
    assert_eq!(scoper.scopes.len(), scoper.declare_indexes.len());
    for (si, scope) in scoper.scopes.iter().enumerate() {
        // Scope storage is append-only; a parent must have been created first.
        assert!(scope.parent.is_none_or(|parent| parent < si));
        let Some(index) = &scoper.declare_indexes[si] else {
            assert!(scope.declares.is_empty());
            continue;
        };
        let mut positions = vec![None; scope.next_id as usize];
        let mut names = HashMap::new();
        for (pos, declaration) in scope.declares.iter().enumerate() {
            assert!(positions[declaration.id as usize].replace(pos).is_none());
            if let Some(name) = &declaration.symbol {
                // Independently select the first/last surviving declaration
                // by scanning the list rather than consulting the index.
                let expected = if scope.token == Token::Eval {
                    scope
                        .declares
                        .iter()
                        .rfind(|d| d.symbol.as_ref() == Some(name))
                } else {
                    scope
                        .declares
                        .iter()
                        .find(|d| d.symbol.as_ref() == Some(name))
                }
                .unwrap();
                names.insert(name.clone(), expected.id);
            }
            assert_eq!(scoper.declare_ref(si, declaration.id).id, declaration.id);
            if let Some((owner, id)) = declaration.alias {
                let mut ancestors = Vec::new();
                let mut parent = scope.parent;
                while let Some(ancestor) = parent {
                    ancestors.push(ancestor);
                    parent = scoper.scopes[ancestor].parent;
                }
                assert!(
                    ancestors.contains(&owner),
                    "closure aliases point to ancestors"
                );
                assert!(scoper.scopes[owner].declares.iter().any(|d| d.id == id));
            }
        }
        // In particular, slots for removed block placeholders must be None,
        // not stale offsets into the shifted declaration list.
        assert_eq!(index.positions, positions, "scope {si}");
        assert_eq!(index.names, names, "scope {si}");
    }
    for &(si, id) in scoper
        .resolutions
        .values()
        .flatten()
        .chain(scoper.class_instance_init.values())
        .chain(scoper.super_instance_init.values())
    {
        assert!(scoper.scopes[si].declares.iter().any(|d| d.id == id));
        assert_eq!(scoper.declare_ref(si, id).id, id);
    }
}

fn run_phases(root: &Item, goal: Goal, after_hoist: impl FnOnce(&Scoper<'_>)) -> Scoper<'static> {
    let Item::Node(node) = root else {
        panic!("parser did not return a node");
    };
    let mut scoper = Scoper {
        goal,
        ..Scoper::default()
    };
    scoper.hoist_dispatch(node).unwrap();
    assert_eq!(scoper.scope, None, "hoist must close the root scope");
    assert_eq!(
        scoper.function_scope,
        Some(0),
        "nested functions must restore the root"
    );
    assert_declaration_indexes(&scoper);
    after_hoist(&scoper);
    scoper.bind_dispatch(node).unwrap();
    assert_eq!(scoper.scope, None, "bind must close the root scope");
    assert_declaration_indexes(&scoper);
    scoper
}

#[test]
fn declaration_indexes_survive_placeholder_removal_and_closure_insertion() {
    let sources = [
        // Repeated vars leave gaps when each intermediate block closes;
        // surviving lexicals move, and binding subsequently adds aliases.
        "let outer; function f(a) { { var x; let y; var z; const w=1; \
         function g(){ return () => a+x+y+z+w+outer; } g(); } return x+z; } outer;",
        "function f(a,a) { var a; { var x; var x; let y; (()=>x+y+a)(); } return x; }",
        "function f(a=(()=>{let inner; return inner;})()) { let b; \
         class C { #x=a; get #p(){return b;} set #p(v){b=v;} \
         static #s=()=>b; [a]=()=>this.#x; } var after; return b+after; } let tail;",
        "try {} catch (e) { var e; let x; (()=>e+x)(); } let tail; tail;",
        "function f(){ using first=null; { var x; using second=null; \
         (()=>first+second+x)(); } return x; }",
    ];
    for source in sources {
        for (goal, strict) in [
            (Goal::Script, false),
            (Goal::Script, true),
            (Goal::Eval, false),
            (Goal::Eval, true),
            (Goal::Module, true),
        ] {
            // Duplicate simple parameters are legal only in sloppy programs.
            if source.contains("f(a,a)") && strict {
                continue;
            }
            for eval_token in [false, true] {
                if goal == Goal::Module && eval_token {
                    continue;
                }
                let root = parse(source, goal, strict, eval_token);
                run_phases(&root, goal, |_| {});
            }
        }
    }
    // Imports and re-exports add anonymous and indirect declarations; local
    // exports consume stable IDs after all declarations have been hoisted.
    let root = parse(
        "import 'side'; import {x as y} from 'm'; export {z} from 'n'; \
         export * from 'q'; export let local=y; export function f(){return local+y;}",
        Goal::Module,
        true,
        false,
    );
    run_phases(&root, Goal::Module, |_| {});
}

#[test]
fn derived_constructor_retains_the_instance_initializer_capture() {
    for goal in [Goal::Script, Goal::Eval, Goal::Module] {
        let root = parse(
            "let outer; class Base {} class Derived extends Base { \
             #x=()=>outer; constructor(a=()=>outer) { super(); let after; } \
             method(){ return this.#x; } } let tail; tail;",
            goal,
            true,
            goal != Goal::Module,
        );
        let scoper = run_phases(&root, goal, |_| {});
        let initializers: Vec<_> = scoper.class_instance_init.values().copied().collect();
        let captures: Vec<_> = scoper.super_instance_init.values().copied().collect();
        assert_eq!(initializers.len(), 1);
        assert_eq!(
            captures.len(),
            1,
            "super() must capture the field initializer"
        );
        let (scope, id) = captures[0];
        assert_eq!(scoper.declare_ref(scope, id).alias, Some(initializers[0]));
    }
}

#[test]
fn every_class_member_kind_has_the_required_field_scope_receipt() {
    // Expected instance/static synthesis is stated independently of both
    // production predicates. Private methods need an initializer even when
    // there are no data values to hoist into it.
    for (member, instance, static_) in [
        ("", false, false),
        ("constructor() {}", false, false),
        ("method() {}", false, false),
        ("get value() {}", false, false),
        ("set value(v) {}", false, false),
        ("get value() {} set value(v) {}", false, false),
        ("[key]() {}", false, false),
        ("static method() {}", false, false),
        ("static get value() {}", false, false),
        ("static set value(v) {}", false, false),
        ("static get value() {} static set value(v) {}", false, false),
        ("static [key]() {}", false, false),
        ("field;", true, false),
        ("[key]=()=>key;", true, false),
        ("#field;", true, false),
        ("#method() {}", true, false),
        ("get #value() {}", true, false),
        ("set #value(v) {}", true, false),
        ("get #value() {} set #value(v) {}", true, false),
        ("static field;", false, true),
        ("static [key]=()=>key;", false, true),
        ("static #field;", false, true),
        ("static #method() {}", false, true),
        ("static get #value() {}", false, true),
        ("static set #value(v) {}", false, true),
        (
            "static get #value() {} static set #value(v) {}",
            false,
            true,
        ),
        ("static {}", false, true),
        ("static { let x; (()=>x)(); }", false, true),
        ("field; static #method() {}", true, true),
    ] {
        for goal in [Goal::Script, Goal::Eval, Goal::Module] {
            let source = format!("let key; class C {{ {member} }} let tail; tail;");
            let root = parse(&source, goal, true, goal != Goal::Module);
            let classes = nodes(&root, Token::Class);
            assert_eq!(classes.len(), 1, "{member}");
            let id = node_id(classes[0]);
            let scoper = run_phases(&root, goal, |scoper| {
                assert_eq!(
                    scoper.class_field_init_hoist.get(&id).is_some(),
                    instance,
                    "{member}"
                );
                assert_eq!(
                    scoper.class_field_init_static_hoist.get(&id).is_some(),
                    static_,
                    "{member}"
                );
                for field_scope in [
                    scoper.class_field_init_hoist.get(&id),
                    scoper.class_field_init_static_hoist.get(&id),
                ]
                .into_iter()
                .flatten()
                {
                    let field = &scoper.scopes[*field_scope];
                    assert_eq!(field.token, Token::Function);
                    assert_eq!(field.parent, Some(scoper.scope_of(classes[0]).0));
                }
            });
            assert_eq!(
                scoper.class_field_init_inst.get(&id),
                scoper.class_field_init_hoist.get(&id)
            );
            assert_eq!(
                scoper.class_field_init_static.get(&id),
                scoper.class_field_init_static_hoist.get(&id)
            );
        }
    }
}

#[test]
fn catch_receipts_distinguish_absent_simple_and_pattern_parameters() {
    for (parameter, secondary) in [
        ("", false),
        ("(error)", true),
        ("({message})", true),
        ("([value=(()=>0)()])", true),
        ("({[(()=>0)()]: value})", true),
    ] {
        for goal in [Goal::Script, Goal::Eval, Goal::Module] {
            let source = format!(
                "try {{}} catch {parameter} {{ function f() {{ let x; return ()=>x; }} f(); }} let tail; tail;"
            );
            let root = parse(&source, goal, true, goal != Goal::Module);
            let catches = nodes(&root, Token::Catch);
            assert_eq!(catches.len(), 1);
            run_phases(&root, goal, |scoper| {
                let (scope, statement) = scoper.scope_of(catches[0]);
                assert_eq!(statement.is_some(), secondary, "{parameter}");
                if let Some(statement) = statement {
                    assert_eq!(scoper.scopes[statement].parent, Some(scope));
                }
            });
        }
    }
}
