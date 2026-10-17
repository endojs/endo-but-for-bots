use ironhorse_vm::Interp;

fn compile(source: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    (code, ironhorse_vm::parse_symbols(&symbols))
}

fn run(src: &str, headroom: usize) {
    let (code, names) = compile(src);
    let mut vm = Interp::new();
    vm.link_intrinsics(&names);
    let base = vm.chunks().byte_size();
    vm.set_chunk_ceiling(base + headroom).unwrap();
    let out = vm.run(&code);
    println!(
        "src={src:?} headroom={headroom} halt={:?} completed={} chunk_bytes_delta={} side_reserved={}",
        out.halt,
        out.completed,
        vm.chunks().byte_size() as i64 - base as i64,
        vm.chunks().side_reserved()
    );
}

#[test]
fn regexp_program_bytes_vs_chunk_ceiling() {
    // ~40 x ~250 KB compiled programs retained under a 2 MiB chunk headroom.
    run("var keep=[]; for (var i=0;i<40;i++) keep.push(new RegExp('\\\\p{RGI_Emoji}','v')); keep.length;", 2 << 20);
    // Control: retaining ~10 MB of string under the same headroom.
    run("var keep=[]; for (var i=0;i<40;i++) keep.push('x'.repeat(250000)+i); keep.length;", 2 << 20);
}
