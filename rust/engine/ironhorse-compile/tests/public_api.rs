//! External consumers can name the data exposed by the supported entry points.
use ironhorse_compile::{
    scope_module, AccessRecord, Declare, DefineEntry, ExportSpec, ImportSpec, MemberAccess, Node,
    Scope, ScopeTree, Sym, Token, Value,
};

#[test]
fn construct_an_ast_value_through_the_public_api() {
    let node = Node::new(Token::Integer, 1, 0, Vec::new(), Value::Integer(42));
    assert_eq!(node.value, Value::Integer(42));
    assert_eq!(node.depth, 1);
}

#[test]
fn inspect_module_linkage_through_named_public_types() {
    let tree: ScopeTree = scope_module("import { x } from 'm'; export { x };").unwrap();
    let root: &Scope = &tree.scopes[tree.root];
    let declarations: &[Declare] = &root.declares;
    let import: &Declare = declarations
        .iter()
        .find(|d| d.import_spec.is_some())
        .unwrap();
    let symbol: &Sym = import.symbol.as_ref().unwrap();
    assert!(matches!(symbol, Sym::Named(_)));
    let spec: &ImportSpec = import.import_spec.as_ref().unwrap();
    assert_eq!(spec.from, vec![u16::from(b'm')]);
    let exports: &[ExportSpec] = &import.export_specs;
    assert_eq!(exports.len(), 1);
    // These annotations exercise the remaining transitive public field types.
    let _: &[DefineEntry] = &root.defines;
    let _: &[AccessRecord] = &tree.accesses;
    let _: Vec<&MemberAccess> = tree.class_member_access.values().collect();
}
