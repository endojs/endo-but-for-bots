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

fn compile(src: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

/// `/(a+)+b/` over 20 `a`s: about 2^20 backtracking paths, some twenty
/// million metered steps (one computron each), run to completion. Small
/// enough that a regressed seam still terminates in about a second of
/// debug-build time (and then fails the computron assertion below)
/// rather than hanging the suite; hundreds of times larger than the
/// limit the armed host enforces.
const CATASTROPHIC: &str = "var re = /(a+)+b/; var s = 'aaaaaaaaaaaaaaaaaaaa'; re.test(s)";

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
    // search was charged (which is tens of millions of computrons).
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
    // exercised. Count the consultations so the test cannot pass by
    // the armed run silently taking the unchecked path.
    let consulted = std::rc::Rc::new(std::cell::Cell::new(0u64));
    let seen = consulted.clone();
    metered.arm_meter(
        1,
        Box::new(move |_| {
            seen.set(seen.get() + 1);
            true
        }),
    );
    let armed = metered.run(&b);
    assert!(armed.completed, "{:?}", armed.halt);

    assert_eq!(unarmed.result, armed.result);
    assert_eq!(
        unarmed.meter_raw, armed.meter_raw,
        "arming the meter must not change what a regexp match costs"
    );
    // Twenty matches of `(a|aa)+$` over sixteen `a`s take tens of
    // thousands of steps each, so the in-match strides alone must have
    // consulted the host far more often than the loop's own check
    // points (one per iteration) could.
    assert!(
        consulted.get() > 500,
        "the host must be consulted inside the matches: {} consultations",
        consulted.get()
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

#[test]
fn builtin_allocation_admission_interrupts_before_the_temporary_buffer() {
    for source in [
        "'x'.repeat(1000000)",
        "'x'.padStart(1000000, 'y')",
        "'x'.padEnd(1000000, 'y')",
        "new ArrayBuffer(1000000)",
    ] {
        let (code, names) = compile(source);
        let mut plain = Interp::new();
        plain.link_intrinsics(&names);
        let whole = plain.run(&code);
        assert!(whole.completed, "{source}: {:?}", whole.halt);
        let limit = whole.computrons.saturating_sub(5);
        let mut armed = Interp::new();
        armed.link_intrinsics(&names);
        armed.arm_meter(1, Box::new(move |spent| spent <= limit));
        let before = armed.chunks().byte_size();
        let out = armed.run(&code);
        assert_eq!(out.halt, Halt::MeterAbort, "{source}");
        assert!(
            armed.chunks().byte_size() < before + 10000,
            "result was allocated: {source}"
        );
    }
}

#[test]
fn allocation_admission_preserves_completed_meter_totals() {
    for source in [
        "'ab'.repeat(100)",
        "'x'.padStart(100, 'yz')",
        "'x'.padEnd(100, 'yz')",
        "new ArrayBuffer(100).byteLength",
        "[1,2,3].join(':')",
        "Array.prototype.join.call({length:3,0:'a',2:'b'},':')",
        "String.raw({raw:['a','b','c']},1,2)",
    ] {
        let (code, names) = compile(source);
        let mut plain = Interp::new();
        plain.link_intrinsics(&names);
        let unarmed = plain.run(&code);
        let mut armed = Interp::new();
        armed.link_intrinsics(&names);
        armed.arm_meter(1, Box::new(|_| true));
        let metered = armed.run(&code);
        assert!(unarmed.completed && metered.completed, "{source}");
        assert_eq!(unarmed.result, metered.result, "{source}");
        assert_eq!(unarmed.meter_raw, metered.meter_raw, "{source}");
    }
}

#[test]
fn caught_late_json_failure_retains_admitted_work() {
    for (source, expected_raw) in [
        (
            "try { JSON.stringify([1,1n]); } catch (_) { 'caught'; }",
            4_574_760,
        ),
        (
            "try { JSON.stringify({a:1,get b(){throw 'late'}}); } catch (_) { 'caught'; }",
            4_610_816,
        ),
    ] {
        let (code, names) = compile(source);
        let mut vm = Interp::new();
        vm.link_intrinsics(&names);
        let out = vm.run(&code);
        assert!(out.completed, "{:?}", out.halt);
        assert_eq!(out.result, "caught");
        assert_eq!(
            out.meter_raw, expected_raw,
            "version-4 admission accounting"
        );
    }
}

#[test]
fn version_four_scratch_collection_costs_are_frozen() {
    let (code, names) = compile("new Uint8Array([3,1,2]).sort().join(',')");
    let mut vm = Interp::new();
    vm.link_intrinsics(&names);
    let out = vm.run(&code);
    assert!(out.completed, "{:?}", out.halt);
    assert_eq!(out.result, "1,2,3");
    assert_eq!(out.meter_raw, 3_395_480);
}

#[test]
fn guest_regexp_source_rendering_has_an_admission_checkpoint() {
    let (code, names) = compile("var r = new RegExp('x'.repeat(10000)); r.source");
    let mut plain = Interp::new();
    plain.link_intrinsics(&names);
    let expected = plain.run(&code);
    assert!(expected.completed);
    let limit = expected.computrons - 1_000;
    let mut metered = Interp::new();
    metered.link_intrinsics(&names);
    metered.arm_meter(1, Box::new(move |n| n <= limit));
    assert_eq!(metered.run(&code).halt, Halt::MeterAbort);
}

#[test]
fn unicode_and_dense_array_work_check_before_running() {
    for source in [
        "var s='x'.repeat(10000);s.toUpperCase()",
        "var s='x'.repeat(10000);s.normalize()",
        "var s='x'.repeat(10000);s.startsWith(s)",
        "delete Array[Symbol.species]; var a=[];for(var i=0;i<1000;i++)a.push(1);a.slice()",
        "Array(20000).toReversed()",
        "Array(20000).copyWithin(0,1)",
        "Array(20000).splice(0,20000)",
    ] {
        let (code, names) = compile(source);
        let mut vm = Interp::new();
        vm.link_intrinsics(&names);
        vm.arm_meter(1, Box::new(|n| n <= 3_000));
        assert_eq!(vm.run(&code).halt, Halt::MeterAbort, "{source}");
    }
}

#[test]
fn version_four_unicode_parse_and_argument_costs_are_frozen() {
    let cases = [
        ("'abc   '.trim()", "abc"),
        ("[1,2,3].reduce((a,b)=>a+b,0)", "6"),
        ("JSON.parse('[1,2,3]').length", "3"),
        ("12345678901234567890n.toString(16)", "ab54a98ceb1f0ad2"),
        ("Math.max.apply(null,[1,2,3])", "3"),
        ("Object.keys({a:1,b:2}).join(',')", "a,b"),
    ];
    let raw: Vec<_> = cases
        .into_iter()
        .map(|(source, expected)| {
            let (code, names) = compile(source);
            let mut vm = Interp::new();
            vm.link_intrinsics(&names);
            let out = vm.run(&code);
            assert!(out.completed, "{source}: {:?}", out.halt);
            assert_eq!(out.result, expected, "{source}");
            out.meter_raw
        })
        .collect();
    assert_eq!(
        raw,
        vec![935_752, 6_411_096, 1_264_288, 1_328_472, 3_065_864, 2_282_848]
    );
}

#[test]
fn parse_and_argument_expansion_cannot_hide_host_refusal_in_a_catch() {
    for source in [
        "try { Math.max.apply(null,{length:100000}); } catch (_) { 'caught' }",
        "try { JSON.parse('['+'0,'.repeat(10000)+'0]'); } catch (_) { 'caught' }",
        "try { new AggregateError({[Symbol.iterator](){return {next(){return {value:0,done:false}}}}}); } catch (_) { 'caught' }",
    ] {
        let (code, names) = compile(source);
        let mut vm = Interp::new();
        vm.link_intrinsics(&names);
        vm.arm_meter(1, Box::new(|n| n <= 10_000));
        assert_eq!(vm.run(&code).halt, Halt::MeterAbort, "{source}");
    }
}
