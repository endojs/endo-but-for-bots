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
    vm.set_slot_ceiling(vm.slots().capacity() + 100);
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
    vm.set_chunk_ceiling(vm.chunks().byte_size() + 4096);
    let out = vm.run_bounded(&code, 10_000);
    assert_eq!(out.halt, Halt::HeapExhausted);
    assert!(!out.completed);
    assert!(!vm.is_quiescent());
}

#[test]
fn lowering_ceiling_below_existing_heap_refuses_even_allocation_free_code() {
    let mut vm = Interp::new();
    vm.set_chunk_ceiling(0);
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

#[test]
fn guest_sized_temporary_buffers_are_refused_before_they_are_created() {
    for source in [
        "'abcdefgh'.repeat(100000000)",
        "new ArrayBuffer(1000000)",
        "'x'.padStart(1000000, 'y')",
        "'x'.padEnd(1000000, 'y')",
        "Array(1000000).join('x')",
        "Array.prototype.join.call({length:1000000},'x')",
        "String.raw({raw:{length:1000000,0:'x'}})",
        "JSON.stringify(Array(1000000))",
        "[Array(1000).fill(1),Array(1000).fill(2)].flat()",
    ] {
        let (code, names) = compile(source);
        let mut vm = Interp::new();
        vm.link_intrinsics(&names);
        vm.set_chunk_ceiling(vm.chunks().byte_size() + 4096);
        let out = vm.run(&code);
        assert_eq!(out.halt, Halt::HeapExhausted, "{source}");
    }
}

#[test]
fn repeat_product_is_checked_independently_of_repeat_count() {
    let (code, names) =
        compile("try { 'abcdefgh'.repeat(2**30) } catch (e) { e instanceof RangeError }");
    let mut vm = Interp::new();
    vm.link_intrinsics(&names);
    let out = vm.run(&code);
    assert!(out.completed, "{:?}", out.halt);
    assert_eq!(out.result, "true");
}

#[test]
fn json_output_prepaid_units_include_escaping_and_nested_indentation() {
    for source in [
        "JSON.stringify({a:[null,true,1,1.5,'x'],b:{c:'\\ud800',d:'\\ud83d\\ude00'},z:undefined},null,'..')",
        "JSON.stringify([undefined,NaN,[],{},'\\u0000\\n\\t\\\"\\\\'],null,3)",
        "JSON.stringify({a:undefined,b:function(){},c:Symbol()})",
    ] {
        let (code,names)=compile(source);
        let mut vm=Interp::new();
        vm.link_intrinsics(&names);
        let out=vm.run(&code);
        assert!(out.completed, "{source}: {:?}",out.halt);
    }
}

#[test]
fn element_scratch_is_bounded_by_bytes_instead_of_source_element_count() {
    for source in [
        "Array.prototype.sort.call({length:1000000})",
        "new Uint8Array(100000).sort()",
        "new Uint16Array(100000).set(new Uint8Array(100000))",
        "var r=/x/;r.exec=function(){return {0:'x',length:1000000,index:0}}; 'x'.replace(r,'y')",
    ] {
        let (code, names) = compile(source);
        let mut vm = Interp::new();
        vm.link_intrinsics(&names);
        vm.set_chunk_ceiling(vm.chunks().byte_size() + 1_000_000);
        let out = vm.run(&code);
        assert_eq!(out.halt, Halt::HeapExhausted, "{source}");
        assert!(!vm.is_quiescent());
    }
}

#[test]
fn replacement_expansion_checks_each_append() {
    for source in [
        r#"'x'.repeat(5000).replace('x', "$'".repeat(1000))"#,
        r#"'x'.repeat(5000).replace(/x/, "$'".repeat(1000))"#,
        r#"var r=/x/;r.exec=function(){return {0:'x',length:1,index:0}}; 'x'.repeat(5000).replace(r,"$'".repeat(1000))"#,
    ] {
        let (code, names) = compile(source);
        let mut vm = Interp::new();
        vm.link_intrinsics(&names);
        vm.set_chunk_ceiling(vm.chunks().byte_size() + 100_000);
        assert_eq!(vm.run(&code).halt, Halt::HeapExhausted, "{source}");
    }
}

#[test]
fn empty_search_replace_all_streams_positions_under_low_headroom() {
    let (code, names) = compile("'x'.repeat(10000).replaceAll('', '')");
    let mut vm = Interp::new();
    vm.link_intrinsics(&names);
    // Enough for UTF-16 source/result and construction scratch, less than an
    // extra usize per input code unit. Empty replacement needs no index list.
    vm.set_chunk_ceiling(vm.chunks().byte_size() + 70_000);
    let out = vm.run(&code);
    assert!(out.completed, "{:?}", out.halt);
    assert_eq!(out.result.len(), 10_000);
}

#[test]
fn concat_unicode_expansion_and_dense_copies_share_admission() {
    for source in [
        "var s='x'.repeat(20000); s.concat(s,s,s,s,s)",
        "'\u{00df}'.repeat(20000).toUpperCase()",
        "'\u{fdfa}'.repeat(10000).normalize('NFKD')",
        "delete Array[Symbol.species]; var a=[]; for(var i=0;i<1000;i++)a.push(1); a.slice()",
        "delete Array[Symbol.species]; var a=[]; for(var i=0;i<1000;i++)a.push(1); a.toReversed()",
        "delete Array[Symbol.species]; var a=[]; for(var i=0;i<1000;i++)a.push(1); a.copyWithin(0,1)",
        "delete Array[Symbol.species]; var a=[]; for(var i=0;i<1000;i++)a.push(1); a.splice(0,1)",
        "delete Array[Symbol.species]; var a=[]; for(var i=0;i<1000;i++)a.push(1); a.toSpliced(0,1)",
        "Array(1000000).toString()",
    ] {
        let (code, names) = compile(source);
        let mut vm = Interp::new();
        vm.link_intrinsics(&names);
        let headroom = if source.starts_with("delete Array") {
            8_000
        } else {
            100_000
        };
        vm.set_chunk_ceiling(vm.chunks().byte_size() + headroom);
        let out = vm.run(&code);
        assert_eq!(out.halt, Halt::HeapExhausted, "{source}");
    }
}

#[test]
fn compact_json_and_argument_lists_obey_element_storage_limits() {
    for source in [
        "JSON.parse('['+'0,'.repeat(4000)+'0]')",
        "JSON.parse('['+'0,'.repeat(4000)+'0]', function(k,v){return v})",
        "Math.max.apply(null,{length:100000})",
    ] {
        let (code, names) = compile(source);
        let mut vm = Interp::new();
        vm.link_intrinsics(&names);
        vm.set_chunk_ceiling(vm.chunks().byte_size() + 60_000);
        assert_eq!(vm.run(&code).halt, Halt::HeapExhausted, "{source}");
    }
}

#[test]
fn bound_name_growth_obeys_the_heap_ceiling() {
    let (code, names) = compile("var f=function(){};for(var i=0;i<2000;i++)f=f.bind(null);f()");
    let mut vm = Interp::new();
    vm.link_intrinsics(&names);
    vm.set_chunk_ceiling(vm.chunks().byte_size() + 100_000);
    assert_eq!(vm.run(&code).halt, Halt::HeapExhausted);
}
