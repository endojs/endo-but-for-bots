//! `XS_CODE_IN` over a **prototype chain**: bit-exact agreement with the pinned
//! XS oracle at every resolution depth, for a hit and for a total miss.
//!
//! `fxRunIn` calls `fxHasAt` once and does not re-enter per level, so the
//! chain walk's per-level cost is one `fxOrdinaryHasProperty` frame — the
//! `mxPushUndefined`/`mxPop` pair it runs at each level that does not find the
//! property own, `ORDINARY_HAS_PROPERTY_FRAME_METERING` = `1<<15`, half an
//! `XS_CODE_METERING`. The same constant serves the `with` scopable walk
//! (`with_statement_mop.rs`), which reaches the same recursion.
//!
//! This file exists because that was wrong in **both directions** and nothing
//! caught it: the opcode charged a whole `XS_CODE_METERING` per prototype
//! *hop*, which ran
//!
//!  - **long** on a chain — measured +0.5 units at depth 1, +1.0 at depth 2,
//!    +1.5 at depth 3, +2.0 at depth 4, on both the hit and the miss path; and
//!  - **short** on a null-prototype receiver, by `1<<15`, because a miss off
//!    the end of an ordinary chain runs a frame at the *last* object too,
//!    where there is no hop to count.
//!
//! Every `in` case in the suite used a shallow receiver, which descends no
//! level at all, so the two cancelled into invisibility. The tests here vary
//! the depth, and assert the depth they think they are testing — wiring a
//! constructor chain shallowest-first silently produces a flat object and makes
//! every depth measurement meaningless.
//!
//! `IN_METERING` itself is unchanged by that correction: it is fixed by the
//! own-hit case, which runs no frame.

use ironhorse_262::dual_run;

/// The program runs end-to-end bit-exact with the XS oracle (value + computrons).
fn exact(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert!(
        run.is_bit_exact(),
        "not bit-exact: {source}\n  oracle_result={} ironhorse_result={}\n  oracle_computrons={} ironhorse_computrons={}\n  ironhorse_halt={:?}",
        run.oracle_result,
        run.ironhorse_result,
        run.oracle_computrons,
        run.ironhorse_computrons,
        run.ironhorse_halt,
    );
}

/// `o` with a prototype chain exactly `n` levels deep:
/// `o -> K1.prototype -> … -> Kn.prototype`. Wired **deepest first**, so each
/// `new K{i+1}()` already carries the rest of the chain.
fn chain(n: usize) -> String {
    let mut s = String::new();
    for i in 1..=n {
        s.push_str(&format!("function K{i}() {{}} "));
    }
    for i in (1..n).rev() {
        s.push_str(&format!("K{}.prototype = new K{}(); ", i, i + 1));
    }
    s.push_str("var o = new K1(); ");
    s
}

#[test]
fn the_fixture_really_is_as_deep_as_it_claims() {
    // Guards the guard: a chain wired in the wrong order is flat, and every
    // depth assertion below would then be measuring depth 1 five times. This
    // one checks the **value** only — the walk it uses to count is a loop over
    // `Object.getPrototypeOf`, which carries a metering residual of its own and
    // is not what this file is gating.
    for n in 1..=5 {
        let source = format!(
            "{} var d = 0; var p = Object.getPrototypeOf(o); \
             while (p !== null && p !== Object.prototype) {{ d++; p = Object.getPrototypeOf(p); }} d",
            chain(n)
        );
        let run = dual_run(&source).expect("the XS oracle machine must start");
        assert_eq!(
            run.oracle_result,
            n.to_string(),
            "fixture depth wrong on the oracle: {source}"
        );
        assert!(
            run.result_agrees,
            "fixture depth diverged: {source}\n  oracle={} ironhorse={}",
            run.oracle_result,
            run.ironhorse_result,
        );
    }
}

#[test]
fn hit_at_each_prototype_depth() {
    exact(&format!("{} o.k = 1; ('k' in o)", chain(5)));
    for d in 1..=4 {
        exact(&format!("{} K{d}.prototype.k = 1; ('k' in o)", chain(5)));
    }
}

#[test]
fn total_miss_down_chains_of_each_length() {
    for n in 1..=5 {
        exact(&format!("{} ('zz' in o)", chain(n)));
    }
}

#[test]
fn repeated_lookups_at_a_fixed_depth() {
    // The per-operation cost must be flat: a residual that grows with the
    // number of lookups is a per-level charge, not a fixed one.
    for n in 1..=3 {
        exact(&format!(
            "{} K4.prototype.k = 1; var r = 0; {} r",
            chain(5),
            "r += ('k' in o) ? 1 : 0; ".repeat(n)
        ));
    }
}

#[test]
fn null_prototype_receiver_pays_its_last_frame() {
    // The direction the old per-hop charge got wrong the other way: no hop, but
    // `fxOrdinaryHasProperty` still pushes and pops at the receiver itself.
    exact("var o = Object.create(null); ('zz' in o)");
    exact("var o = Object.create(null); o.k = 1; ('k' in o)");
    exact("var o = Object.create(null); o.k = 1; ('zz' in o)");
}

#[test]
fn shallow_and_exotic_receivers_stay_exact() {
    // The cases that were already covered — they must not move.
    exact("var o = {k: 1}; ('k' in o)");
    exact("var o = {}; ('zz' in o)");
    exact("var o = [1]; ('0' in o)");
    exact("var o = [1]; ('length' in o)");
    exact("var t = new Uint8Array(2); ('0' in t)");
    exact("var o = new String('ab'); ('zz' in o)");
    exact("function f() { return ('length' in arguments); } f(1)");
}
