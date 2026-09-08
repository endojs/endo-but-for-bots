//! W2: arena admission refuses before mutation and escapes guest handlers.
use ironhorse_vm::value::{ChunkArena, Slot, SlotArena};
use ironhorse_vm::{Halt, Interp};

fn compile(source: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    (code, ironhorse_vm::parse_symbols(&symbols))
}

#[test]
fn chunk_ceiling_counts_headers_and_refuses_before_mutation() {
    let mut arena = ChunkArena::new();
    arena.set_ceiling(7);
    arena.alloc(&[1, 2, 3]);
    assert_eq!(arena.byte_size(), 7);
    let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| arena.alloc(&[])));
    assert!(failure.is_err());
    assert_eq!(arena.byte_size(), 7);
}

#[test]
fn slot_ceiling_allows_free_list_reuse_but_no_growth() {
    let mut arena = SlotArena::new();
    arena.set_ceiling(1);
    let first = arena.alloc(Slot::integer(1));
    arena.free(first);
    assert_eq!(arena.alloc(Slot::integer(2)), first);
    let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        arena.alloc(Slot::integer(3))
    }));
    assert!(failure.is_err());
    assert_eq!(arena.capacity(), 1);
    assert_eq!(arena.get(first), Slot::integer(2));
}

#[test]
fn guest_cannot_catch_slot_exhaustion() {
    let (code, names) = compile("try { while (true) { ({a:1}); } } catch (_) { 'caught'; }");
    let mut vm = Interp::new();
    vm.link_intrinsics(&names);
    vm.slots.set_ceiling(vm.slots.capacity() + 100);
    let out = vm.run_bounded(&code, 10_000);
    assert_eq!(out.halt, Halt::HeapExhausted);
    assert!(out.halt.is_panic());
    assert!(!out.completed);
    assert!(!vm.is_quiescent());
}

#[test]
fn guest_cannot_catch_chunk_exhaustion() {
    let (code, names) =
        compile("try { var s='x'; while (true) { s=s+'abcdefgh'; } } catch (_) { 'caught'; }");
    let mut vm = Interp::new();
    vm.link_intrinsics(&names);
    vm.chunks.set_ceiling(vm.chunks.byte_size() + 4096);
    let out = vm.run_bounded(&code, 10_000);
    assert_eq!(out.halt, Halt::HeapExhausted);
    assert!(!out.completed);
    assert!(!vm.is_quiescent());
}

#[test]
fn lowering_ceiling_below_existing_heap_refuses_even_allocation_free_code() {
    let mut vm = Interp::new();
    vm.chunks.set_ceiling(0);
    assert_eq!(vm.run(&[]).halt, Halt::HeapExhausted);
}

#[test]
fn default_arenas_use_the_execution_profile() {
    let mut slots = SlotArena::default();
    let mut chunks = ChunkArena::default();
    assert_eq!(slots.ceiling(), SlotArena::new().ceiling());
    assert_eq!(chunks.ceiling(), ChunkArena::new().ceiling());
    slots.alloc(Slot::undefined());
    chunks.alloc(&[]);
}

#[test]
fn unrelated_host_panics_are_not_misclassified_as_heap_exhaustion() {
    let (code, names) = compile("while (true) {}");
    let mut vm = Interp::new();
    vm.link_intrinsics(&names);
    vm.arm_meter(1, Box::new(|_| panic!("host failure")));
    let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| vm.run(&code)))
        .expect_err("ordinary host panic must escape");
    assert_eq!(failure.downcast_ref::<&str>(), Some(&"host failure"));
}
