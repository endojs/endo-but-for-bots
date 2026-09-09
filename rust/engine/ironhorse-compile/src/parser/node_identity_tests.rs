use super::*;

fn ids(root: &Item) -> Vec<u32> {
    let mut pending = vec![root];
    let mut ids = Vec::new();
    while let Some(item) = pending.pop() {
        match item {
            Item::Node(node) => {
                assert_ne!(node.id, u32::MAX);
                ids.push(node.id);
                pending.extend(&node.children);
            }
            Item::List(items) => pending.extend(items),
            _ => {}
        }
    }
    let count = ids.len();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(
        ids.len(),
        count,
        "distinct nodes must not share an identity"
    );
    ids
}

#[test]
fn every_parser_exit_and_synthetic_constructor_assigns_unique_ids() {
    for source in [
        "({a, b: [c=1], ...rest}) => ({a,c,rest})",
        "class C extends B { #x=1; [key]=2; static { work(); } }",
        "let {a: [b=1], ...rest}=value; for (let [x,y] of pairs) { (()=>x+y)(); }",
        "class C { x=1; }",
    ] {
        let root = Parser::new(source, false, false)
            .unwrap()
            .parse_program(false)
            .unwrap();
        let original_ids = ids(&root);
        assert_eq!(ids(&root.clone()), original_ids);
    }
    let module = Parser::new("export default class extends B {}", true, true)
        .unwrap()
        .parse_module()
        .unwrap();
    ids(&module);
    let assignment = Parser::new("({a=1,...rest})=>a", false, false)
        .unwrap()
        .parse_assignment_expression()
        .unwrap();
    ids(&assignment);
    let comma = Parser::new("a,b,c", false, false)
        .unwrap()
        .parse_comma_expression()
        .unwrap();
    ids(&comma);
}

#[test]
fn exhausted_identity_space_is_rejected_at_every_parse_exit() {
    for entry in 0..4 {
        let mut parser = Parser::new("0", false, entry == 3).unwrap();
        parser.next_node_id.set(Some(u32::MAX));
        let error = match entry {
            0 => parser.parse_assignment_expression(),
            1 => parser.parse_comma_expression(),
            2 => parser.parse_program(false),
            3 => parser.parse_module(),
            _ => unreachable!(),
        };
        assert_eq!(error.unwrap_err().message, "too many AST nodes");
    }
}
