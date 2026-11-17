//! TEMPORARY audit probe (ontology verify ONT-34). Delete after use.
use ironhorse_vm::Interp;

fn compile(src: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

const MINT: &str = "var n = 0; var err = 'none'; \
    try { for (var i = 0; i < 40000; i++) { var o = {}; o[Symbol('s')] = i; n = i + 1; } } \
    catch (e) { err = e.name + ':' + e.message; } \
    'minted=' + n + ' err=' + err";

// Uses only identifiers MINT already interned (n, o, err, e, name, message),
// so relink cannot fail on a novel identifier; the runtime string key
// 'fresh1' is the only new key.
const FRESH: &str = "var n = 'fresh' + 1; var o = {}; var err = 'ok'; \
    try { o[n] = 1; } catch (e) { err = e.name + ':' + e.message; } err";

#[test]
fn symbol_key_ids_are_not_recycled_by_gc() {
    let (b1, n1) = compile(MINT);
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    let o1 = m.run(&b1);
    println!("crank1: completed={} result={}", o1.completed, o1.result);
    let before = m.slots().free_list().len();
    let stats = m.collect_garbage().unwrap();
    let after = m.slots().free_list().len();
    println!("gc1: {:?} free_list {} -> {}", stats, before, after);
    let (b2, n2) = compile(MINT);
    let b2 = m.relink_crank(&b2, &n2).expect("relink2");
    let o2 = m.run(&b2);
    println!("crank2 (after GC): completed={} result={}", o2.completed, o2.result);
    let stats = m.collect_garbage().unwrap();
    println!("gc2: {:?}", stats);
    let (b3, n3) = compile(FRESH);
    match m.relink_crank(&b3, &n3) {
        Ok(b3) => {
            let o3 = m.run(&b3);
            println!(
                "crank3 (fresh runtime string key, no novel identifier): completed={} result={} halt={:?}",
                o3.completed, o3.result, o3.halt
            );
        }
        Err(e) => println!("crank3 relink: {:?}", e),
    }
    let (b4, n4) = compile("var zzNovelIdentifier = 1; zzNovelIdentifier");
    match m.relink_crank(&b4, &n4) {
        Ok(b4) => {
            let o4 = m.run(&b4);
            println!("crank4 (novel identifier): completed={} result={}", o4.completed, o4.result);
        }
        Err(e) => println!("crank4 relink (novel identifier): {:?}", e),
    }
}
