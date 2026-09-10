//! Counted ordinary index rows obey the same sweep discipline as array rows.
use ironhorse_vm::value::{Payload, SlotIndex, SLOTS_PER_PAGE};
use ironhorse_vm::{parse_symbols, Interp};

fn crank(vm: &mut Interp, source: &str) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("compile");
    let code = vm
        .relink_crank(&code, &parse_symbols(&symbols))
        .expect("relink");
    let outcome = vm.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
}

#[test]
fn full_gc_drops_dead_index_rows_before_compacting_chunks() {
    let mut vm = Interp::new();
    crank(
        &mut vm,
        "var owner = {}; var garbage; var i; \
         for (i = 0; i < 2048; i++) { garbage = { value: i }; } \
         owner[0] = 'x'.repeat(8192); owner[1] = garbage; garbage = null; 0;",
    );
    let rows = vm.index_props_snapshot();
    let (owner, _, items) = rows
        .iter()
        .find(|(_, _, items)| items.len() == 2)
        .expect("index row");
    let owner = SlotIndex(*owner);
    let Payload::Reference(target) = items[1].1.value else {
        panic!("object reference")
    };
    let target_page = (target.0 / SLOTS_PER_PAGE) as usize;
    assert!(vm.side_table_ref_page_bits()[target_page]);

    crank(&mut vm, "var owner; owner = null; 0;");
    let stats = vm.collect_garbage().unwrap();
    assert!(vm.slots.is_free_index(owner));
    assert!(vm.slots.is_free_index(target));
    assert!(
        vm.index_props_snapshot()
            .iter()
            .all(|(id, _, _)| *id != owner.0),
        "a dead owner must leave no index-property row"
    );
    assert!(
        stats.chunk_bytes_before - stats.chunk_bytes_after >= 8192,
        "the dead row's dynamic string must be reclaimed in this collection"
    );
    assert!(
        !vm.side_table_ref_page_bits()[target_page],
        "dropping the index row must release its counted page edge"
    );
    assert!(
        vm.is_quiescent(),
        "the counted-reference parity net must remain healthy"
    );
    // Repeated collection must not decrement the removed row's counts twice.
    vm.collect_garbage().unwrap();
    vm.side_table_ref_page_bits();
    assert!(vm.is_quiescent());
}
