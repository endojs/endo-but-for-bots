use super::*;
use crate::ast::flags;
use crate::Parser;

fn parse(source: &str, goal: Goal) -> Item {
    let mut parser = Parser::new(source, false, goal == Goal::Module).unwrap();
    if goal == Goal::Module {
        parser.parse_module().unwrap()
    } else {
        let mut root = parser.parse_program(false).unwrap();
        if let Item::Node(node) = &mut root {
            node.flags |= flags::EVAL;
        }
        root
    }
}

fn emit(root: &Item, tree: &ScopeTree) -> (Vec<u8>, Vec<u8>, u64) {
    let meter = crate::ParseMeter::new();
    let mut coder = Coder::new(tree, meter.clone());
    coder.intern_tree(root);
    if tree.goal == Goal::Module {
        coder.code_module(node_of(root));
    } else {
        coder.eval_flag = true;
        coder.code_program(node_of(root));
    }
    assert!(coder.error.is_none(), "{:?}", coder.error);
    let (code, symbols) = coder.serialize_atoms().unwrap();
    (code, symbols, meter.raw())
}

#[test]
fn cloned_tree_retains_bindings_after_original_is_dropped() {
    for (source, goal) in [
        ("let x=3; function f(y){let z=y; return ()=>x+z+external;} f(2)();", Goal::Eval),
        ("var x=3; function f(){return x;} f();", Goal::Script),
        ("import {x} from 'm'; export function f(y){return x+y;}", Goal::Module),
        ("class B{}; class C extends B { #x=1; [external]=2; static x=3; static { this.x++; } m(){return this.#x;} } new C().m();", Goal::Eval),
        ("let x=0; outer: for(let i=0;i<3;i++){try {switch(i){case 1: continue outer; default: x+=i;}} catch(e){x+=e;} }", Goal::Eval),
    ] {
        let original = parse(source, goal);
        let tree = crate::scoper::run_goal(&original, goal).unwrap();
        let expected = emit(&original, &tree);
        let clone = original.clone();
        drop(original);
        assert_eq!(emit(&clone, &tree), expected, "{source}");
        let re_scoped = crate::scoper::run_goal(&clone, goal).unwrap();
        assert_eq!(re_scoped.resolutions, tree.resolutions);
        assert_eq!(re_scoped.node_scopes, tree.node_scopes);
        assert_eq!(emit(&clone, &re_scoped), expected);
    }
}

#[test]
fn missing_required_scoper_data_is_fatal_instead_of_emitting_a_global_or_zero_frame() {
    let root = parse("let x=1; x; external;", Goal::Eval);
    let tree = crate::scoper::run(&root).unwrap();
    // A real global symbol is represented explicitly, and must still compile.
    assert!(tree.resolutions.values().any(Option::is_none));
    emit(&root, &tree);
    for missing in ["node resolution", "node scope", "scope count"] {
        let mut damaged = tree.clone();
        match missing {
            "node resolution" => damaged.resolutions = Default::default(),
            "node scope" => damaged.node_scopes = Default::default(),
            "scope count" => damaged.scope_counts.clear(),
            _ => unreachable!(),
        }
        let panic =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| emit(&root, &damaged)))
                .expect_err("missing required metadata must not produce bytecode");
        let message = panic
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| panic.downcast_ref::<&str>().copied())
            .unwrap();
        assert!(
            message.contains(&format!("compiler invariant: missing {missing}")),
            "{message}"
        );
    }
}

#[test]
fn field_initialization_requires_the_scopers_frame_and_member_aliases() {
    for (source, missing) in [
        ("class C { x=external; }", "instance field scope"),
        ("class C { [external]=1; #x=2; }", "instance field scope"),
        ("class C { static x=external; }", "static field scope"),
        ("class C { static { external(); } }", "static field scope"),
        ("class C { x=1; }", "field member aliases"),
    ] {
        let root = parse(source, Goal::Eval);
        let mut tree = crate::scoper::run(&root).unwrap();
        emit(&root, &tree);
        match missing {
            "instance field scope" => tree.class_field_init_inst = Default::default(),
            "static field scope" => tree.class_field_init_static = Default::default(),
            "field member aliases" => tree.class_member_fi = Default::default(),
            _ => unreachable!(),
        }
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| emit(&root, &tree)))
            .expect_err("missing field metadata must not select another frame layout");
        let message = panic
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| panic.downcast_ref::<&str>().copied())
            .unwrap();
        assert!(
            message.contains(&format!("compiler invariant: missing {missing}")),
            "{message}"
        );
    }
}
