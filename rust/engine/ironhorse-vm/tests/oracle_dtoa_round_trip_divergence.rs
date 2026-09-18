//! The one large-integer dtoa divergence the harness cannot compare away.
//!
//! The `finding_*_large_integer_dtoa.rs` family all share a shape: XS renders a
//! double's exact integer where ECMA-262 §6.1.6.1.20 wants the shortest decimal
//! that round-trips, both spellings denote the SAME double, and the differential
//! harness — which compares numeric completions by their double rather than by
//! their decimal spelling — therefore treats them as agreeing.
//!
//! This one breaks that shape, and so is filed apart from them.
//!
//! ```text
//! 51298814505517056 + 8
//! ```
//!
//! The exact double is `51298814505517064`. ironhorse renders
//! `"51298814505517064"`, which parses back to it — the same spelling Node and
//! V8 emit. XS renders `"51298814505517060"`, which parses to
//! `51298814505517056`, a DIFFERENT double, one ulp below. XS's spelling is
//! shorter (16 significant digits against 17), so it would be the spec's answer
//! if it round-tripped; it does not, and step 5's "smallest `k`" is qualified on
//! exactly that.
//!
//! Two consequences worth writing down.
//!
//! First, ironhorse is the conformant engine here and no port change can settle
//! the divergence — it is the oracle that is wrong, so the differential targets
//! will keep reporting this expression whichever way the port moves. It wants a
//! known-divergence entry, not a fix.
//!
//! Second, the by-double comparison that suppresses the rest of the family
//! cannot suppress this one, because the doubles genuinely differ once XS's
//! string is read back. A reviewer meeting this report should not reach for the
//! same "rendering only" explanation.
//!
//! Measured against the pinned oracle (`23b4d6b0`, XS 8.3.1) and Node 22; XS is
//! also self-consistent about it, since its own string-to-number conversion
//! reads `"51298814505517060"` back as the original double, so
//! `Number(String(x)) === x` holds inside XS while failing under the spec.
//!
//! Needs neither the oracle nor the `c/moddable` submodule: it pins the port's
//! own rendering and the round-trip property, which is the portable claim.

use ironhorse_vm::value::number_to_ecma_string;

/// The exact double `51298814505517056 + 8` evaluates to.
const FINDING_VALUE: f64 = 51298814505517064.0;

/// ironhorse's rendering, matching Node/V8.
const SHORTEST_ROUND_TRIPPING: &str = "51298814505517064";
/// XS's rendering, which is shorter and does not round-trip.
const XS_LOSSY: &str = "51298814505517060";

#[test]
fn the_port_renders_the_shortest_decimal_that_actually_round_trips() {
    let value = 51298814505517056.0_f64 + 8.0;
    assert_eq!(
        value.to_bits(),
        FINDING_VALUE.to_bits(),
        "the expression's double"
    );

    assert_eq!(number_to_ecma_string(value), SHORTEST_ROUND_TRIPPING);
    assert_eq!(
        SHORTEST_ROUND_TRIPPING.parse::<f64>().unwrap().to_bits(),
        value.to_bits(),
        "the port's rendering must parse back to the same double",
    );
}

/// The oracle's spelling is shorter AND lossy, which is why this case is not
/// the rest of the family.
#[test]
fn the_oracle_rendering_is_shorter_and_does_not_round_trip() {
    let value = FINDING_VALUE;
    // Shorter: 16 significant digits against 17.
    assert!(
        XS_LOSSY.trim_end_matches('0').len() < SHORTEST_ROUND_TRIPPING.len(),
        "the oracle's spelling is the shorter one",
    );
    // And lossy, which disqualifies it under step 5's round-trip condition.
    assert_ne!(
        XS_LOSSY.parse::<f64>().unwrap().to_bits(),
        value.to_bits(),
        "if this ever holds, XS became conformant and this file should go",
    );
    // Specifically, one ulp below.
    assert_eq!(XS_LOSSY.parse::<f64>().unwrap(), 51298814505517056.0);
    // So the by-double comparison that suppresses the sibling findings cannot
    // suppress this one.
    assert_ne!(
        XS_LOSSY.parse::<f64>().unwrap().to_bits(),
        SHORTEST_ROUND_TRIPPING.parse::<f64>().unwrap().to_bits(),
        "the two spellings are NOT the same double, unlike the rest of the family",
    );
}
