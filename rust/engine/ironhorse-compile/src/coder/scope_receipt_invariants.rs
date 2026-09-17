//! F063: assert scoper receipts independently of the coder's traversal.
//! Valid sources must also compile, so early refusals cannot hide missing receipts.

use super::*;
use crate::ast::flags as f;
use crate::scoper::{dflags, Declare, MemberAccess};

#[derive(Default)]
struct Evidence {
    resolutions: usize,
    unresolved: usize,
    private: usize,
    frames: usize,
    catches: usize,
    classes: usize,
    field_aliases: usize,
    shared_brands: usize,
    base_captures: usize,
    static_blocks: usize,
}

fn scoped(source: &str, goal: Goal, strict: bool) -> (Item, ScopeTree) {
    let module = goal == Goal::Module;
    let mut parser = crate::parser::Parser::new(source, strict || module, module).unwrap();
    let mut root = if module {
        parser.parse_module().unwrap()
    } else {
        parser.parse_program(strict).unwrap()
    };
    if let Item::Node(node) = &mut root {
        if !module {
            node.flags |= f::EVAL;
        }
    }
    let tree = crate::scoper::run_goal_for_compile(&root, goal, crate::ParseMeter::new()).unwrap();
    (root, tree)
}

fn declaration(tree: &ScopeTree, scope: usize, id: u32) -> &Declare {
    tree.scopes[scope]
        .declares
        .iter()
        .find(|d| d.id == id)
        .expect("receipt names a surviving declaration")
}

fn frame(tree: &ScopeTree, scope: usize, evidence: &mut Evidence) {
    assert!(
        tree.scope_counts.contains_key(&scope),
        "frame count receipt"
    );
    evidence.frames += 1;
}

fn walk(item: &Item, tree: &ScopeTree, evidence: &mut Evidence) {
    let node = match item {
        Item::Node(node) => node,
        Item::List(items) => {
            for item in items {
                walk(item, tree, evidence);
            }
            return;
        }
        _ => return,
    };
    match node.token {
        Token::Access
        | Token::Arg
        | Token::Var
        | Token::Let
        | Token::Const
        | Token::Using
        | Token::Define
        | Token::PrivateMember
        | Token::PrivateIdentifier => {
            let resolution = tree
                .resolutions
                .get(&node_id(node))
                .expect("resolution receipt");
            evidence.resolutions += 1;
            if let Some((scope, id)) = *resolution {
                declaration(tree, scope, id);
            } else {
                evidence.unresolved += 1;
            }
            if matches!(node.token, Token::PrivateMember | Token::PrivateIdentifier) {
                assert!(resolution.is_some(), "private brand must resolve");
                evidence.private += 1;
            }
        }
        _ => {}
    }
    match node.token {
        Token::Program | Token::Module | Token::Function | Token::Generator => {
            let &(scope, secondary) = tree.node_scopes.get(&node_id(node)).expect("frame scope");
            assert!(secondary.is_none());
            frame(tree, scope, evidence);
        }
        Token::Block
        | Token::Body
        | Token::For
        | Token::ForIn
        | Token::ForOf
        | Token::ForAwaitOf
        | Token::Switch
        | Token::With => {
            assert!(
                tree.node_scopes.get(&node_id(node)).is_some(),
                "node scope: {:?}",
                node.token
            );
        }
        Token::Catch => {
            let &(primary, secondary) = tree.node_scopes.get(&node_id(node)).expect("catch scope");
            if matches!(node.children[0], Item::Null) {
                assert!(secondary.is_none());
            } else {
                let body = secondary.expect("catch statement scope");
                assert_eq!(tree.scopes[body].parent, Some(primary));
                evidence.catches += 1;
            }
        }
        Token::Class => {
            class_receipts(node, tree, evidence);
            // Static blocks are Body nodes, but all three passes visit their
            // statements directly in the synthetic field function. They do
            // not get an ordinary Body scope or a member-alias receipt.
            for (index, child) in node.children.iter().enumerate() {
                if index == 2 {
                    let Item::List(members) = child else {
                        panic!("class members")
                    };
                    for member in members {
                        let member_node = node_of(member);
                        if member_node.token == Token::Body {
                            evidence.static_blocks += 1;
                            walk(&member_node.children[0], tree, evidence);
                        } else {
                            walk(member, tree, evidence);
                        }
                    }
                } else {
                    walk(child, tree, evidence);
                }
            }
            return;
        }
        _ => {}
    }
    for child in &node.children {
        walk(child, tree, evidence);
    }
}

fn class_receipts(node: &Node, tree: &ScopeTree, evidence: &mut Evidence) {
    evidence.classes += 1;
    let &(class_scope, symbol_scope) = tree.node_scopes.get(&node_id(node)).expect("class scope");
    assert_eq!(
        symbol_scope.is_some(),
        matches!(node.children[0], Item::Symbol(_))
    );
    let Item::List(members) = &node.children[2] else {
        panic!("class members")
    };
    let mut fields = [Vec::new(), Vec::new()];
    for member in members {
        let member = node_of(member);
        let method = member.flags & (f::METHOD | f::GETTER | f::SETTER) != 0;
        if method && member.token != Token::PrivateProperty {
            continue;
        }
        fields[usize::from(member.flags & f::STATIC != 0)].push(member);
    }
    let instance_init = tree.class_instance_init.get(&node_id(node)).copied();
    assert_eq!(instance_init.is_some(), !fields[0].is_empty());
    if let Some((scope, id)) = instance_init {
        assert_eq!(scope, class_scope);
        let init = declaration(tree, scope, id);
        assert!(init.symbol.is_some());
        assert_ne!(init.flags & dflags::CLOSURE, 0);
        let constructor = node_of(&node.children[5]);
        if constructor.flags & f::BASE != 0 {
            let constructor_scope = tree.node_scopes.get(&node_id(constructor)).unwrap().0;
            assert!(
                tree.scopes[constructor_scope]
                    .declares
                    .iter()
                    .any(|d| { d.alias == instance_init && d.flags & dflags::USE_CLOSURE != 0 }),
                "base constructor capture"
            );
            evidence.base_captures += 1;
        }
    }
    for (members, scope) in fields.iter().zip([
        tree.class_field_init_inst.get(&node_id(node)),
        tree.class_field_init_static.get(&node_id(node)),
    ]) {
        assert_eq!(
            scope.is_some(),
            !members.is_empty(),
            "field function receipt"
        );
        let Some(&fi) = scope else { continue };
        assert_eq!(tree.scopes[fi].token, Token::Function);
        assert_eq!(tree.scopes[fi].parent, Some(class_scope));
        frame(tree, fi, evidence);
        for member in members {
            if member.token == Token::Body {
                assert!(tree.class_member_fi.get(&node_id(member)).is_none());
                continue;
            }
            let slots = *tree
                .class_member_fi
                .get(&node_id(member))
                .expect("field member receipt");
            let access = tree
                .class_member_access
                .get(&node_id(member))
                .copied()
                .unwrap_or_default();
            let method = member.flags & (f::METHOD | f::GETTER | f::SETTER) != 0;
            let expected = match member.token {
                Token::Property => [false, false, false],
                Token::PropertyAt => [true, false, false],
                Token::PrivateProperty => [false, true, method],
                other => panic!("field kind {other:?}"),
            };
            let parts = |a: MemberAccess| [a.at, a.symbol, a.value];
            for ((source, alias), required) in
                parts(access).into_iter().zip(parts(slots)).zip(expected)
            {
                assert_eq!(source.is_some(), required, "class member slot");
                assert_eq!(alias.is_some(), required, "field alias slot");
                if let (Some(source), Some(alias)) = (source, alias) {
                    let target = declaration(tree, class_scope, source);
                    assert!(target.symbol.is_some());
                    assert_ne!(target.flags & dflags::CLOSURE, 0);
                    let capture = declaration(tree, fi, alias);
                    assert_eq!(capture.token, Token::NoToken);
                    assert_ne!(capture.flags & dflags::USE_CLOSURE, 0);
                    assert_eq!(capture.symbol, target.symbol);
                    // A getter/setter pair has two class declarations but
                    // scope_lookup selects the first declaration of that name.
                    // Anonymous keys and method values have unique symbols.
                    let canonical = tree.scopes[class_scope]
                        .declares
                        .iter()
                        .find(|d| d.symbol == target.symbol)
                        .unwrap();
                    assert_eq!(capture.alias, Some((class_scope, canonical.id)));
                    evidence.shared_brands += usize::from(canonical.id != source);
                    evidence.field_aliases += 1;
                }
            }
        }
    }
}

fn inspect(source: &str, goal: Goal, strict: bool, evidence: &mut Evidence) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let (root, tree) = scoped(source, goal, strict);
        walk(&root, &tree, evidence);
        compile_atoms_goal(source, goal, strict).unwrap();
    }));
    if let Err(payload) = result {
        panic!(
            "{goal:?}, strict={strict}: {}\n{source}",
            panic_text(payload.as_ref())
        );
    }
}

#[test]
fn class_and_scope_receipts_survive_nested_traversal() {
    let mut evidence = Evidence::default();
    let mut count = 0;
    for members in [
        "",
        "x; static y;",
        "[(()=>key)()]=()=>outer; static [key+1]=eval('outer');",
        "#x=outer; static #y=outer; m(){return this.#x;} static m(){return #y in this;}",
        "#m(){return outer;} static #n(){return outer;}",
        "static #m(){return outer;}",
        "static {}",
        "get #x(){return outer;} set #x(v){outer=v;} static get #y(){return outer;} static set #y(v){outer=v;}",
        "[key](){return outer;} static get [key](){return outer;}",
        "static { (()=>outer)(); } x=class Inner {#p; m(){return this.#p;}};",
        "#m(){return this.#x;} [key]=this.#m(); #x=outer; static #n(){} static [key]=this.#n();",
        "x=()=>{try{}catch({p=outer}){return p;}}; static {for(let i of []){(()=>i)();}}",
    ] {
        for constructor in [
            "class C {MEMBERS}",
            "class {constructor(p=()=>outer){} MEMBERS}",
            "class C extends (class B {y=outer}) {MEMBERS}",
            "class C extends Base {constructor(p=()=>outer){super(p);} MEMBERS}",
        ] {
            let class = constructor.replace("MEMBERS", members);
            for placement in [
                "const result=CLASS;",
                "function f(p=CLASS){return p;}",
                "class Outer {field=CLASS;}",
                "class Outer {static field=CLASS;}",
                "class Outer {[(CLASS, key)]() {return outer;}}",
                "class Outer extends CLASS {}",
                "try{}catch({x=CLASS}){(()=>x)();}",
                "for(let x of [CLASS]){switch(x){case outer: (()=>x)();}}",
            ] {
                let source = format!("let outer, key; {}", placement.replace("CLASS", &class));
                for (goal, strict) in [
                    (Goal::Script, false), (Goal::Script, true),
                    (Goal::Eval, false), (Goal::Eval, true), (Goal::Module, true),
                ] {
                    inspect(&source, goal, strict, &mut evidence);
                    count += 1;
                }
            }
        }
    }
    assert_eq!(count, 1_920);
    assert!(evidence.resolutions > count);
    assert!(evidence.unresolved > 0);
    assert!(evidence.private > 0);
    assert!(evidence.frames > count);
    assert!(evidence.catches > 0);
    assert!(evidence.classes > count);
    assert!(evidence.field_aliases > count);
    assert!(evidence.shared_brands > 0);
    assert!(evidence.base_captures > 0);
    assert!(evidence.static_blocks > 0);
}

#[test]
fn resolution_and_scope_boundary_roster() {
    let mut evidence = Evidence::default();
    let mut count = 0;
    for source in [
        "let x; x; unknown; typeof unknown; x=unknown; x+=unknown; x++; x?.(unknown);",
        "let x; ({[unknown]:x=unknown}=unknown); [x=unknown,...x]=unknown;",
        "let {[unknown]:x=unknown,...rest}=unknown; const [y=()=>x]=unknown;",
        "function f([x=unknown],{[unknown]:y=x}={}){return ()=>x+y+unknown;}",
        "function* f(x=()=>unknown){yield* unknown; return x;} async function g(){await unknown;}",
        "function f(){var x; eval('x'); return ()=>x+unknown;}",
        "for(let i=unknown;i<unknown;i++){(()=>i)();} for(const k in unknown){k;}",
        "async function f(){for await(const x of unknown){(()=>x)();}}",
        "try{unknown;}catch(e){e; function f(){return e;}} try{}catch{unknown;}",
        "switch(unknown){case unknown: let x; (()=>x)(); break; default: unknown;}",
        "{using x=unknown; (()=>x)();} async function f(){await using x=unknown; return ()=>x;}",
        "unknown`a${unknown}b`; ({[unknown]:unknown,...unknown}); unknown(...unknown);",
        "class C{#x; m(){this.#x=1; this.#x+=1; this.#x++; this.#x?.(); return #x in this;}}",
        "class C{#x; m(){return class D{#x; m(o){return o.#x;}};} n(o){return o.#x;}}",
        "class C{static{ {let x; (()=>x)();} } x=class extends (class {#p;}) {#q;};}",
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
    for source in [
        "import {x} from 'm'; export {x}; export default class { [x]=x; };",
        "export const x=class {#m(){}}; export function f(){return x;}",
        "export * from 'm'; export {y as z} from 'n';",
        "export default function f(p=()=>unknown){return p;}",
        "await using x=unknown; export {x};",
    ] {
        inspect(source, Goal::Module, true, &mut evidence);
        count += 1;
    }
    for goal in [Goal::Script, Goal::Eval] {
        inspect(
            "var x; with(unknown){x; x=1; (()=>x)();} delete x; delete unknown;",
            goal,
            false,
            &mut evidence,
        );
        count += 1;
    }
    assert_eq!(count, 82);
    assert!(evidence.unresolved > 0);
    assert!(evidence.private > 0);
    assert!(evidence.catches > 0);
}

fn find_node(item: &Item, token: Token) -> Option<&Node> {
    match item {
        Item::Node(node) if node.token == token => Some(node),
        Item::Node(node) => node
            .children
            .iter()
            .find_map(|child| find_node(child, token)),
        Item::List(items) => items.iter().find_map(|child| find_node(child, token)),
        _ => None,
    }
}

#[test]
fn scope_receipt_checker_rejects_damaged_trees() {
    let source = "let key; class C { [key]=1; #x; get #p(){return this.#x;} set #p(v){} static #m(){} } try{}catch(e){e;} unknown;";
    let (root, tree) = scoped(source, Goal::Script, false);
    walk(&root, &tree, &mut Evidence::default());
    let class_id = node_id(find_node(&root, Token::Class).unwrap());
    let catch_id = node_id(find_node(&root, Token::Catch).unwrap());
    let private_id = node_id(find_node(&root, Token::PrivateMember).unwrap());
    let computed_id = node_id(find_node(&root, Token::PropertyAt).unwrap());
    let init = tree.class_instance_init.get(&class_id).copied().unwrap();
    for damage in 0..13 {
        let mut broken = tree.clone();
        match damage {
            0 => broken.resolutions = Default::default(),
            1 => broken.node_scopes = Default::default(),
            2 => broken.scope_counts.clear(),
            3 => broken.class_instance_init = Default::default(),
            4 => broken.class_field_init_static = Default::default(),
            5 => broken.class_member_access = Default::default(),
            6 => broken.class_member_fi = Default::default(),
            7 => broken.class_field_init_inst = Default::default(),
            8 => {
                let (primary, _) = *broken.node_scopes.get(&catch_id).unwrap();
                broken.node_scopes.insert(catch_id, (primary, None));
            }
            9 => {
                broken.resolutions.insert(private_id, None);
            }
            10 => {
                broken
                    .class_member_fi
                    .insert(computed_id, MemberAccess::default());
            }
            11 => {
                for scope in &mut broken.scopes {
                    for d in &mut scope.declares {
                        if d.alias == Some(init) {
                            d.alias = None;
                        }
                    }
                }
            }
            12 => {
                let fi = *broken.class_field_init_inst.get(&class_id).unwrap();
                broken.scopes[fi].parent = None;
            }
            _ => unreachable!(),
        }
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                walk(&root, &broken, &mut Evidence::default());
            }))
            .is_err(),
            "damage {damage} escaped the checker"
        );
    }
}
