#[test]
fn program_sizes() {
    for (p, f) in [("\\p{RGI_Emoji}", "v"), ("a", "v"), ("[\\0-\\u{10FFFF}]", "iu"), ("\\p{Lu}", "iu"), ("\\p{Lu}", "u")] {
        let t = std::time::Instant::now();
        let prog = ironhorse_regexp::compile(p, f).unwrap();
        println!("{p:?}/{f}: code_bytes={} compile_computrons={} wall={:?}", prog.code.len() * 4, prog.compile_meter_raw >> 16, t.elapsed());
    }
}
