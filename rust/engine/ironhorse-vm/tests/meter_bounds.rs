//! Architecture review finding 2 ("the meter bounds nothing in the
//! shipped configuration"), the engine half:
//!
//! - F012: an armed meter can interrupt a catastrophic backtracking
//!   regexp match. Before the `match_regexp_checked` seam every check
//!   point lay in the dispatch loop, so `/(a+)+b/` over a run of `a`
//!   ran its exponential search to completion before a computron was
//!   charged; the host's refusal could only land afterwards.
//! - The seam moves WHEN the match's computrons are charged, never how
//!   many: armed and un-armed runs of the same program agree on the
//!   meter bit-exactly, so the differential harness is unaffected.

use ironhorse_vm::{Halt, Interp};

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

/// `/(a+)+b/` over 26 `a`s: 2^26-ish backtracking steps, each metered
/// one computron. Small enough that a regressed seam still terminates
/// (and then fails the computron assertion below) rather than hanging
/// the suite; far larger than the limit the armed host enforces.
const CATASTROPHIC: &str = "var re = /(a+)+b/; var s = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'; re.test(s)";

#[test]
fn an_armed_meter_halts_a_catastrophic_regexp_match_mid_way() {
    const LIMIT: u64 = 50_000;
    let (b, n) = compile(CATASTROPHIC);
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    m.arm_meter(1_000, Box::new(|computrons| computrons <= LIMIT));
    let out = m.run(&b);
    assert!(
        matches!(out.halt, Halt::MeterAbort),
        "the host's refusal must halt the crank: {:?}",
        out.halt
    );
    // The abort landed INSIDE the match: the meter stopped within a few
    // check strides of the limit, not after the whole exponential
    // search was charged (which would be tens of millions).
    let slack = 4 * ironhorse_regexp::MATCH_CHECK_STRIDE + 1_000;
    assert!(
        out.computrons < LIMIT + slack,
        "abort must be near the limit, not after the match ran to \
         completion: {} computrons against a limit of {LIMIT}",
        out.computrons
    );
}

#[test]
fn armed_and_unarmed_runs_meter_a_regexp_identically() {
    // A pattern with real backtracking, bounded enough to finish.
    let src = "var re = /(a|aa)+$/; var s = 'aaaaaaaaaaaaaaaab'; \
               var i = 0; var r = 0; for (i = 0; i < 20; i++) { r = re.test(s); } \
               /x*y/.exec('xxxxxxxxxxxxxxxxxxxxz') === null";
    let (b, n) = compile(src);

    let mut plain = Interp::new();
    plain.link_intrinsics(&n);
    let unarmed = plain.run(&b);
    assert!(unarmed.completed, "{:?}", unarmed.halt);

    let mut metered = Interp::new();
    metered.link_intrinsics(&n);
    // Interval 1: the host is consulted at every check point, including
    // the in-match strides — the seam's charging order is fully
    // exercised.
    metered.arm_meter(1, Box::new(|_| true));
    let armed = metered.run(&b);
    assert!(armed.completed, "{:?}", armed.halt);

    assert_eq!(unarmed.result, armed.result);
    assert_eq!(
        unarmed.meter_raw, armed.meter_raw,
        "arming the meter must not change what a regexp match costs"
    );
}

#[test]
fn a_fresh_machine_is_unarmed_and_a_host_refusal_aborts() {
    let (b, n) = compile("var i = 0; for (i = 0; i < 100000; i++) { i = i; } i");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    assert!(!m.meter_is_armed());
    assert!(!m.meter_host_attached());
    assert!(m.run(&b).completed, "the un-armed default runs unbounded");

    let mut armed = Interp::new();
    armed.link_intrinsics(&n);
    armed.arm_meter(100, Box::new(|computrons| computrons <= 5_000));
    assert!(armed.meter_is_armed() && armed.meter_host_attached());
    let out = armed.run(&b);
    assert!(matches!(out.halt, Halt::MeterAbort), "{:?}", out.halt);
}
