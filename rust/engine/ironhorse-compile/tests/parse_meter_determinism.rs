//! Parse-metering **determinism** (stage-5 roadmap bar; design § Metering,
//! the accuracy-over-parity doctrine maintained 2026-07-04).
//!
//! The parse meter is ironhorse's OWN frozen, release-versioned cost table
//! (`ironhorse-meter-N`), not a back-fit of XS's `XS_PARSE_CODE_METERING`;
//! computron-vs-oracle stays advisory telemetry. What the roadmap locks
//! here is the property the doctrine makes load-bearing: **identical parse
//! computrons across repeated compiles of the same source on the same
//! build** — deterministic per release. A meter whose value drifted between
//! two parses of the same bytes (a HashMap iteration order leaking into the
//! token count, say) would make the "frozen cost table" meaningless, so
//! this test pins determinism directly.

use ironhorse_compile::meter::PARSE_METER_RELEASE;
use ironhorse_compile::parse_computrons;

/// A spread of programs across the ported grammar — literals, operators,
/// control flow, functions, objects/arrays, templates, classes — so the
/// determinism guarantee is exercised over the whole parse surface, not
/// one construct.
const PROGRAMS: &[&str] = &[
    "1 + 2 * 3",
    "(a, b) => a + b",
    "if (x) { y } else { z }",
    "for (var i = 0; i < 10; i = i + 1) { s = s + i }",
    "function f(a, b, c) { return a * b + c }",
    "var o = { a: 1, b: [2, 3], c: { d: 4 } }; o.a + o.c.d",
    "`t${a}e${b}mplate`",
    "class C extends B { m() { return super.m() + 1 } }",
    "try { f() } catch (e) { g(e) } finally { h() }",
    "switch (n) { case 1: a(); break; default: b() }",
    "label: while (true) { if (q) break label; continue label }",
    "let [x, ...rest] = arr; let { p, q: r } = obj;",
    "async function a() { await p; for await (const v of s) {} }",
    "function* gen() { yield 1; yield* other() }",
    "\"use strict\"; const k = 1; k;",
];

#[test]
fn parse_computrons_are_deterministic_per_build() {
    // The meter release this determinism is pinned against; a re-freeze
    // (bumping the suffix and recalibrating) is a deliberate release
    // boundary, not a silent drift.
    assert_eq!(
        PARSE_METER_RELEASE, "ironhorse-meter-0",
        "the frozen parse-meter release changed; re-pin the determinism baseline deliberately"
    );

    for src in PROGRAMS {
        let first = parse_computrons(src, false)
            .unwrap_or_else(|| panic!("program should parse: {src:?}"));
        assert!(first > 0, "a non-empty program must spend parse computrons: {src:?}");
        // Repeat many times: the value must be identical every time on
        // this build. Any variance is nondeterminism the meter forbids.
        for rep in 0..64 {
            let again = parse_computrons(src, false)
                .unwrap_or_else(|| panic!("program should parse on repeat {rep}: {src:?}"));
            assert_eq!(
                first, again,
                "parse computrons drifted across repeats (rep {rep}) for {src:?}: {first} != {again}"
            );
        }
    }
}

#[test]
fn parse_computrons_scale_monotonically_with_length() {
    // A coarse sanity check on the meter's shape (a monotone per-token
    // counter): repeating a program's tokens must not *lower* its parse
    // cost. Not a calibration — just that the counter is monotone, the
    // property later stages build the frozen table on.
    let one = parse_computrons("a + b + c", false).unwrap();
    let more = parse_computrons("a + b + c + d + e + f + g + h", false).unwrap();
    assert!(
        more > one,
        "more tokens must cost more parse computrons: {more} !> {one}"
    );
}
