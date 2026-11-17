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

/// Every public parse entry point routes its tree through `finish_tree`.
///
/// `node_id` (scoper.rs:362) carries a RELEASE-mode `assert_ne!` against the
/// `u32::MAX` sentinel `new_node` hands out once the identity space is
/// exhausted, and 39 production call sites reach it. Nothing downstream
/// checks for the sentinel, so the only thing standing between an exhausted
/// parse and a release-mode abort is that `finish_tree` refuses the tree at
/// the parse exit (architecture finding F063).
///
/// `exhausted_identity_space_is_rejected_at_every_parse_exit` above asserts
/// that for the four entry points someone wrote down. This asserts the list
/// is the whole list: a fifth `pub fn parse_*` added without `finish_tree`
/// would reopen the abort, and it would pass that test by not being in it.
#[test]
fn every_public_parse_entry_point_calls_finish_tree() {
    const SOURCES: &[(&str, &str)] = &[
        ("parser.rs", include_str!("../parser.rs")),
        ("parser/stmt.rs", include_str!("stmt.rs")),
    ];

    let mut found = Vec::new();
    for (name, source) in SOURCES {
        for (offset, _) in source.match_indices("pub fn parse_") {
            let signature_end = match source[offset..].find('{') {
                Some(brace) => offset + brace,
                None => panic!("{name}: no body brace after a `pub fn parse_`"),
            };
            let signature = source[offset..signature_end].trim().to_string();

            // Walk the body by brace depth: a nested block or a closure must
            // not end the scan early, or a `finish_tree` in a later arm would
            // read as present when it is not.
            let bytes = source.as_bytes();
            let mut depth = 0usize;
            let mut end = signature_end;
            for (index, byte) in bytes.iter().enumerate().skip(signature_end) {
                match byte {
                    b'{' => depth += 1,
                    b'}' => {
                        depth -= 1;
                        if depth == 0 {
                            end = index;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            assert!(
                depth == 0 && end > signature_end,
                "{name}: unbalanced body in {signature}"
            );

            let body = &source[signature_end..end];
            assert!(
                body.contains("finish_tree"),
                "{name}: `{signature}` returns a tree without `finish_tree`, so an \
                 exhausted identity space would reach `node_id`'s release-mode assert",
            );
            found.push(signature);
        }
    }

    // The scan must actually have found the entry points. A pattern that
    // stops matching — a reformat putting `pub fn` and `parse_` on separate
    // lines, a move to another module — would otherwise leave this test green
    // while checking nothing.
    assert_eq!(
        found.len(),
        4,
        "expected the four known parse entry points, found {found:?}; \
         if one was added, cover it in \
         `exhausted_identity_space_is_rejected_at_every_parse_exit` too",
    );
}
