//! Wave-6 Remaining item: property-key id-space exhaustion must be a
//! RELEASE-VISIBLE refusal, not an alias.
//!
//! String keys grow the name table bottom-up and symbol keys mint
//! top-down from `u16::MAX`; the MEET — same hazard class as the old
//! shared counter's saturation — tripped a `debug_assert` in debug
//! builds and silently handed out DUPLICATE ids in release, so the
//! 64Ki-th key read and wrote another key's slot. The meet now poisons
//! the machine: the dispatch loop halts with a named refusal before
//! another instruction runs, the crank aborts (the managed lifecycle
//! rewinds it), and the quiescence gate refuses to persist the
//! poisoned machine.

use ironhorse_vm::Interp;

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

/// A guest program that honestly exhausts the id space: `JSON.parse`
/// interns every novel object key straight through `intern_key` (the
/// reachable runtime-intern path), and 66,000 distinct keys carry the
/// name table past the `u16` meet with the symbol-key floor.
fn exhausting_source() -> String {
    let mut json = String::with_capacity(1 << 20);
    json.push('{');
    for i in 0..66_000u32 {
        if i > 0 {
            json.push(',');
        }
        json.push_str(&format!("\"k{i}\":0"));
    }
    json.push('}');
    format!("var j = 0; j = JSON.parse('{json}'); 0;")
}

#[test]
fn id_space_exhaustion_halts_by_name_instead_of_aliasing() {
    let (b, n) = compile(&exhausting_source());
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o = m.run(&b);
    assert!(
        !o.completed,
        "the exhausting crank must abort, not complete over aliased ids"
    );
    assert_eq!(
        o.halt,
        ironhorse_vm::Halt::Unsupported("property-key:id-space-exhausted"),
        "the refusal is named, in release and debug alike"
    );
    // A later crank naming anything NOVEL cannot even relink: the name
    // table is genuinely full, and the relink path fails closed
    // (TableFull) rather than aliasing.
    let (bt, nt) = compile("var t = 0; t = 1; t");
    assert!(
        m.relink_crank(&bt, &nt).is_err(),
        "a novel name cannot be appended to a full table"
    );
    // The poisoned machine stays refused even for a crank whose names
    // are ALL already interned (relink appends nothing, so it maps):
    // the run loop halts on the latch before the first instruction, and
    // the quiescence gate reports the machine unpersistable.
    let (b2, n2) = compile("j = 1; j");
    let b2 = m.relink_crank(&b2, &n2).expect("relink of already-interned names");
    let o2 = m.run(&b2);
    assert_eq!(
        o2.halt,
        ironhorse_vm::Halt::Unsupported("property-key:id-space-exhausted"),
        "the poison latch holds for the machine's lifetime"
    );
    assert!(
        !m.is_quiescent(),
        "a poisoned machine must never pass the persist gates"
    );
}
