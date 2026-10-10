use super::*;
use std::cell::RefCell;
use std::rc::Rc;

#[test]
fn slice_methods_do_not_decode_whole_receivers() {
    for method in ["slice", "substring"] {
        for receiver in ["s", "new String(s)", "{toString(){return s}}"] {
            let (setup, symbols) = ironhorse_compile::compile_atoms(&format!(
                "var s='x'.repeat(1048576);var receiver={receiver};"
            ))
            .unwrap();
            let mut vm = Interp::new();
            vm.link_intrinsics(&crate::parse_symbols(&symbols));
            assert!(vm.run(&setup).completed);
            let (code, symbols) = ironhorse_compile::compile_atoms(&format!(
                "for(var i=0;i<1000;i++){{String.prototype.{method}.call(receiver,0,1)}}0"
            ))
            .unwrap();
            let code = vm
                .relink_crank(&code, &crate::parse_symbols(&symbols))
                .unwrap();
            string_decode_instrumentation::STRING_UNITS_CALLS.with(|count| count.set(0));
            let out = vm.run(&code);
            assert!(out.completed, "{method}/{receiver}: {:?}", out.halt);
            assert_eq!(out.result, "0");
            assert_eq!(
                string_decode_instrumentation::STRING_UNITS_CALLS.with(|count| count.get()),
                0,
                "{method}/{receiver}"
            );
        }
    }
}

#[test]
fn slicing_lazy_strings_reads_only_the_requested_range() {
    use crate::value::{ChunkArena, PageSource, CHUNK_EXTENT_BYTES};
    struct Source {
        bytes: Vec<u8>,
        reads: Rc<RefCell<Vec<u32>>>,
    }
    impl PageSource for Source {
        fn slot_page(&self, _: u32) -> Vec<Slot> {
            panic!("no slot reads")
        }
        fn chunk_extent(&self, extent: u32) -> Vec<u8> {
            self.reads.borrow_mut().push(extent);
            let start = extent as usize * CHUNK_EXTENT_BYTES as usize;
            self.bytes[start..(start + CHUNK_EXTENT_BYTES as usize).min(self.bytes.len())].to_vec()
        }
    }
    for method in [NativeMethod::StringSlice, NativeMethod::StringSubstring] {
        let extent = CHUNK_EXTENT_BYTES as usize;
        let mut chunks = ChunkArena::new();
        chunks.alloc(&vec![0; extent - 9]);
        let off = chunks.alloc(&units_to_be16(&vec![0x1234; extent * 3]));
        let bytes = chunks.raw_vec();
        let last_extent = ((bytes.len() - 1) / extent) as u32;
        let reads = Rc::new(RefCell::new(Vec::new()));
        let mut vm = Interp::new();
        let byte_size = bytes.len();
        let source = Rc::new(Source {
            bytes,
            reads: reads.clone(),
        });
        vm.chunks = ChunkArena::lazy_from_parts(byte_size, source.clone());
        vm.stack = vec![Slot::undefined(); 4];
        vm.stack.extend([Slot::integer(0), Slot::integer(1)]);
        let value = vm
            .call_string_indexed(
                method,
                Slot::of(Kind::String, Payload::String(off)),
                0,
                2,
                &[],
            )
            .unwrap();
        let Payload::String(result) = value.value else {
            panic!("string result")
        };
        assert_eq!(vm.str_len(result), 1);
        assert_eq!(vm.str_unit_at(result, 0), Some(0x1234));
        // The result is appended at the arena's tail. It may fault that
        // final extent for writing, but no middle receiver extent is read.
        assert!(reads.borrow().contains(&0));
        assert!(reads.borrow().contains(&1));
        assert!(
            reads
                .borrow()
                .iter()
                .all(|&e| e == 0 || e == 1 || e == last_extent),
            "{:?}",
            reads.borrow()
        );
        // A refusal must precede even a one-unit payload read in a cold
        // middle extent. Reading the receiver length faults only its header.
        vm.chunks = ChunkArena::lazy_from_parts(byte_size, source);
        vm.chunks.set_ceiling(byte_size);
        reads.borrow_mut().clear();
        vm.stack[4] = Slot::integer(extent as i32);
        vm.stack[5] = Slot::integer(extent as i32 + 1);
        let refused = vm.call_string_indexed(
            method,
            Slot::of(Kind::String, Payload::String(off)),
            0,
            2,
            &[],
        );
        assert_eq!(refused, Err(Step::Host(Halt::HeapExhausted)));
        assert_eq!(vm.chunks.byte_size(), byte_size);
        assert_eq!(*reads.borrow(), [0]);
    }
}
