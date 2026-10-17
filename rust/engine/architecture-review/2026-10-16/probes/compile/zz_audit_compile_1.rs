//! TEMPORARY audit probe (compile region): memory amplification and
//! super-linear paths. Delete after the audit.
use ironhorse_compile::{
    compile_atoms_with_budget, scope_program, Item, Lexeme, Node, Parser, Token, Value,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;

struct Counting;
static CUR: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            let c = CUR.fetch_add(l.size(), Relaxed) + l.size();
            PEAK.fetch_max(c, Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l);
        CUR.fetch_sub(l.size(), Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let q = System.realloc(p, l, n);
        if !q.is_null() {
            if n > l.size() {
                let c = CUR.fetch_add(n - l.size(), Relaxed) + (n - l.size());
                PEAK.fetch_max(c, Relaxed);
            } else {
                CUR.fetch_sub(l.size() - n, Relaxed);
            }
        }
        q
    }
}
#[global_allocator]
static A: Counting = Counting;

fn reset() -> usize {
    let c = CUR.load(Relaxed);
    PEAK.store(c, Relaxed);
    c
}
fn mb(b: usize) -> f64 {
    b as f64 / 1048576.0
}

#[test]
fn sizes() {
    println!(
        "SIZE Node={} Item={} Value={} Lexeme={} Token={} Box<Node>+Item={}",
        std::mem::size_of::<Node>(),
        std::mem::size_of::<Item>(),
        std::mem::size_of::<Value>(),
        std::mem::size_of::<Lexeme>(),
        std::mem::size_of::<Token>(),
        std::mem::size_of::<Node>() + std::mem::size_of::<Item>(),
    );
}

fn phases(name: &str, src: &str) {
    let base = reset();
    let t = Instant::now();
    let mut p = Parser::new(src, false, false).unwrap();
    let tree = p.parse_program(false).unwrap();
    let tp = t.elapsed().as_secs_f64();
    let parse_peak = PEAK.load(Relaxed) - base;
    let retained_tree = CUR.load(Relaxed) - base;
    drop(p);
    let retained_tree_only = CUR.load(Relaxed) - base;
    drop(tree);
    let base = reset();
    let t = Instant::now();
    let st = scope_program(src, false).unwrap();
    let ts = t.elapsed().as_secs_f64();
    let scope_peak = PEAK.load(Relaxed) - base;
    drop(st);
    let base = reset();
    let t = Instant::now();
    let rep = compile_atoms_with_budget(src, false, u64::MAX);
    let tc = t.elapsed().as_secs_f64();
    let compile_peak = PEAK.load(Relaxed) - base;
    let (bc, sy) = rep.result.unwrap();
    println!(
        "PHASE {name} src={:.2}MB parse_peak={:.1}MB tree+parser={:.1}MB tree={:.1}MB scope_peak={:.1}MB compile_peak={:.1}MB (x{:.0}) bytecode={:.2}MB syms={}B t_parse={:.2}s t_parse+scope={:.2}s t_compile={:.2}s computrons={} ns/computron={:.1}",
        mb(src.len()),
        mb(parse_peak),
        mb(retained_tree),
        mb(retained_tree_only),
        mb(scope_peak),
        mb(compile_peak),
        compile_peak as f64 / src.len() as f64,
        mb(bc.len()),
        sy.len(),
        tp,
        ts,
        tc,
        rep.parse_meter_raw >> 16,
        tc * 1e9 / (rep.parse_meter_raw >> 16) as f64,
    );
}

#[test]
fn memory_and_time_scaling() {
    for &k in &[1usize, 2, 4] {
        let n = k * 1024 * 1024;
        phases(
            &format!("arr0_{k}mb"),
            &format!("function g(){{var x=[{}0];}}", "0,".repeat(n / 2)),
        );
        phases(
            &format!("ids_{k}mb"),
            &format!("function g(){{var a;var x=[{}a];}}", "a,".repeat(n / 2)),
        );
        phases(
            &format!("stmts_{k}mb"),
            &format!("function g(){{var a;{}}}", "a=0;".repeat(n / 4)),
        );
        phases(
            &format!("top_stmts_{k}mb"),
            &format!("var a;{}", "a=0;".repeat(n / 4)),
        );
    }
}

/// `unwrap_reference_cover` / `binding_from_expression` deep-clone the
/// parenthesized operand once per paren level.
#[test]
fn paren_cover_clone_amplification() {
    for &parens in &[0usize, 10, 45, 85] {
        let big = format!("[{}0]", "0,".repeat(200_000));
        let src = format!(
            "var a = {{}}; {}a[{big}]{} = 1;",
            "(".repeat(parens),
            ")".repeat(parens)
        );
        let t = Instant::now();
        let rep = compile_atoms_with_budget(&src, false, u64::MAX);
        let tc = t.elapsed().as_secs_f64();
        assert!(rep.result.is_ok(), "{:?}", rep.result.err());
        println!(
            "PARENS assign parens={parens} src={:.2}MB t={:.3}s computrons={}",
            mb(src.len()),
            tc,
            rep.parse_meter_raw >> 16
        );
        // arrow-parameter cover: `((a[big])) => 1` is rejected, after the clones
        let src = format!(
            "var f = ({}a[{big}]{}) => 1;",
            "(".repeat(parens),
            ")".repeat(parens)
        );
        let t = Instant::now();
        let rep = compile_atoms_with_budget(&src, false, u64::MAX);
        let tc = t.elapsed().as_secs_f64();
        println!(
            "PARENS arrowcover parens={parens} t={:.3}s computrons={} ok={}",
            tc,
            rep.parse_meter_raw >> 16,
            rep.result.is_ok()
        );
    }
}

/// `check_strict_binding` clones every pattern list it visits; the export
/// path clones the whole declaration to collect names.
#[test]
fn pattern_clone_cost() {
    for &depth in &[1usize, 40, 80] {
        let big = format!("[{}0]", "0,".repeat(200_000));
        // arrow params with a deep array pattern whose innermost default is big
        let src = format!(
            "var f = ({}a = {big}{}) => 1;",
            "[".repeat(depth),
            "]".repeat(depth)
        );
        let t = Instant::now();
        let rep = compile_atoms_with_budget(&src, false, u64::MAX);
        let tc = t.elapsed().as_secs_f64();
        println!(
            "PATTERN arrow depth={depth} t={:.3}s computrons={} ok={}",
            tc,
            rep.parse_meter_raw >> 16,
            rep.result.is_ok()
        );
    }
}

/// Lexer identifier acceptance, as ranges, for comparison with the regexp
/// engine's `\p{ID_Start}` / `\p{ID_Continue}`.
#[test]
fn lexer_identifier_ranges() {
    fn ranges(accept: impl Fn(char) -> bool) -> String {
        let mut out = Vec::new();
        let mut start: Option<u32> = None;
        for c in 0u32..=0x110000 {
            let m = char::from_u32(c).map_or(false, &accept);
            match (m, start) {
                (true, None) => start = Some(c),
                (false, Some(s)) => {
                    out.push(format!("{s}-{}", c - 1));
                    start = None;
                }
                _ => {}
            }
        }
        out.join(",")
    }
    let is_ident = |src: String| {
        matches!(ironhorse_compile::tokenize(&src).as_deref(),
            Ok([l, eof]) if l.token == Token::Identifier && eof.token == Token::Eof)
    };
    let start = ranges(|c| is_ident(c.to_string()));
    let cont = ranges(|c| is_ident(format!("a{c}")));
    let path = std::env::var("AUDIT_OUT").unwrap_or("/tmp/lexer_ranges.txt".into());
    std::fs::write(&path, format!("START {start} CONT {cont}")).unwrap();
    println!("RANGES written to {path}");
}
