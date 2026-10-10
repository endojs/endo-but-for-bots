use ironhorse_regexp::unicode;

#[test]
fn public_unicode_path_reexports_leaf_tables_and_classifiers() {
    assert!(std::ptr::eq(
        unicode::IDENTIFIER_FIRST,
        ironhorse_unicode::IDENTIFIER_FIRST
    ));
    assert!(std::ptr::eq(
        unicode::IDENTIFIER_NEXT,
        ironhorse_unicode::IDENTIFIER_NEXT
    ));
    assert!(unicode::is_identifier_first(0x10400));
    assert!(!unicode::is_identifier_first(0x300));
    assert!(unicode::is_identifier_next(0xe01ef));
    assert!(!unicode::is_identifier_next(0xe01f0));
}
