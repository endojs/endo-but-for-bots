// AUDIT PROBE (temporary, integration-fuzz-oracle region). Deleted after use.
// gen_compile_program (lib.rs:2243) draws its arm from byte 0 and then hands
// the SAME bytes to gen_program / gen_statement_program / gen_stage2b_program,
// whose first draw re-reads byte 0. What does that do to the reachable shapes?
use std::collections::BTreeMap;
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 }
    fn bytes(&mut self) -> Vec<u8> { let len = 1 + (self.next() % 256) as usize; (0..len).map(|_| self.next() as u8).collect() }
}
fn nesting(s: &str) -> usize { let (mut d, mut m) = (0i32, 0i32); for c in s.chars() { if c == '(' { d += 1; m = m.max(d) } else if c == ')' { d -= 1 } } m as usize }
fn kind(s: &str) -> &'static str {
    if s.contains("try {") { "exception(stage2b)" }
    else if s.contains("(function(p") || s.contains("var f = function(p)") { "call(stage2b)" }
    else if s.contains("var mk = ") || s.contains("var add = ") { "closure(stage2b)" }
    else if s.contains("var o = ") { "object" }
    else if s.contains("for (var i") { "statement" }
    else { "expression" }
}
#[test]
fn probe() {
    let mut rng = Rng(0x1234_5678_9ABC_DEF1);
    let (mut via_compile, mut direct_2b) = (BTreeMap::new(), BTreeMap::new());
    let (mut depth_compile, mut depth_direct) = (BTreeMap::new(), BTreeMap::new());
    for _ in 0..50_000 {
        let d = rng.bytes();
        let p = ironhorse_fuzz::gen_compile_program(&d);
        *via_compile.entry(kind(&p)).or_insert(0usize) += 1;
        if kind(&p) == "expression" { *depth_compile.entry(nesting(&p)).or_insert(0usize) += 1; }
        *direct_2b.entry(kind(&ironhorse_fuzz::gen_stage2b_program(&d))).or_insert(0usize) += 1;
        *depth_direct.entry(nesting(&ironhorse_fuzz::gen_program(&d))).or_insert(0usize) += 1;
    }
    println!("gen_compile_program shapes (50k inputs): {via_compile:?}");
    println!("gen_stage2b_program shapes, same inputs:  {direct_2b:?}");
    println!("max paren nesting, gen_compile_program expression arm: {depth_compile:?}");
    println!("max paren nesting, gen_program direct:                 {depth_direct:?}");
}
