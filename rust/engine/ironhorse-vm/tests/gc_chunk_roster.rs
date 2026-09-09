//! Generated bulk-table chunk walks preserve values and counted slot edges.
use ironhorse_vm::{parse_symbols, Interp};

#[test]
fn bulk_strings_relocate_without_changing_counted_object_edges() {
    let source = "var phase; var junk; var array; var index; var map; var target; \
        if (!phase) { \
          junk = 'garbage'.repeat(4096); target = {}; \
          array = ['array'.repeat(100), target]; \
          index = {}; index[0] = 'index'.repeat(100); index[1] = target; \
          map = new Map(); map.set('key'.repeat(100), 'map'.repeat(100)); \
          map.set(1, target); junk = null; phase = 1; \
        } else { \
          array[0] === 'array'.repeat(100) && index[0] === 'index'.repeat(100) && \
          map.get('key'.repeat(100)) === 'map'.repeat(100) && \
          array[1] === target && index[1] === target && map.get(1) === target; \
        }";
    let (code, names) = ironhorse_compile::compile_atoms(source).expect("compile");
    let mut collected = Interp::new();
    let mut control = Interp::new();
    for vm in [&mut collected, &mut control] {
        vm.link_intrinsics(&parse_symbols(&names));
        let out = vm.run(&code);
        assert!(out.completed, "{:?}", out.halt);
    }
    let index_chunk = |vm: &Interp| {
        vm.index_props_snapshot()
            .iter()
            .flat_map(|(_, _, items)| items)
            .find_map(|(_, slot)| slot.chunk_ref())
            .expect("index string")
    };
    let before = index_chunk(&collected);
    let stats = collected.collect_garbage();
    assert!(stats.chunk_bytes_before > stats.chunk_bytes_after);
    assert!(index_chunk(&collected).0 < before.0, "string must move");
    collected.side_table_ref_page_bits();
    assert!(
        collected.is_quiescent(),
        "counted page-edge parity after remap"
    );
    // A second compaction must not rewrite already-remapped offsets incorrectly.
    collected.collect_garbage();
    let actual = collected.run(&code);
    let expected = control.run(&code);
    assert!(actual.completed, "{:?}", actual.halt);
    assert!(expected.completed, "{:?}", expected.halt);
    assert_eq!(expected.result, "true");
    assert_eq!(actual.result, expected.result);
}
