//! The large-integer dtoa divergences the harness cannot compare away, and the
//! one build macro that causes them.
//!
//! The `finding_*_large_integer_dtoa.rs` family all share a shape: XS renders a
//! double's exact integer where ECMA-262 §6.1.6.1.20 wants the shortest decimal
//! that round-trips, both spellings denote the SAME double, and the differential
//! harness — which compares numeric completions by their double rather than by
//! their decimal spelling — therefore treats them as agreeing.
//!
//! These break that shape, and so are filed apart from them.
//!
//! # The cause is `ROUND_BIASED`, not an arithmetic bug
//!
//! `xsdtoa.c:56` carries `#define ROUND_BIASED`, one of David Gay's documented
//! configuration macros ("for IEEE-format with biased rounding and arithmetic
//! that rounds toward +Infinity", `xsdtoa.c:162`). It removes the parity test
//! from the shortest-digit loop in two places:
//!
//! ```c
//! /* xsdtoa.c:6162 */
//! #ifndef ROUND_BIASED
//!         if (j1 == 0 && mode != 1 && !(word1(&u) & 1) ...
//! /* xsdtoa.c:6181 */
//!         if (j < 0 || (j == 0 && mode != 1
//! #ifndef ROUND_BIASED
//!                         && !(word1(&u) & 1)
//! #endif
//! ```
//!
//! `j == 0` is the case where truncating leaves a remainder of EXACTLY half an
//! ulp — the candidate spelling sits on the boundary between two doubles.
//! Unbiased dtoa accepts such a spelling only when the low mantissa bit is
//! even, because reading it back resolves the tie to even and must land on the
//! double it started from. `ROUND_BIASED` compiles that condition out, so XS
//! accepts the boundary spelling whatever the parity — and emits a string that,
//! under the spec's round-to-nearest-even, reads back one ulp low.
//!
//! The same macro guards XS's `strtod` (`xsdtoa.c:4413`, `4423`, `4703`,
//! `4722`), so XS reads the boundary back by rounding UP rather than to even.
//! That is why XS is internally consistent — `Number(String(x)) === x` holds
//! inside XS — while both halves diverge from the spec. It also means this is
//! **two** divergences, not one: `Number::toString` and `Number(string)`.
//!
//! # What was measured
//!
//! Against the pinned oracle (`23b4d6b0`, XS 8.3.1) and Node 22. In the
//! `ulp == 8` band, with `x % 10 == 4` so that `x - 4` is both the exact
//! midpoint to `x - 8` and a decimal one digit shorter:
//!
//! ```text
//! x                   mantissa  XS String(x)         port / Node
//! 36028797018963984   even      36028797018963980    36028797018963980   agree
//! 36028797018964024   odd       36028797018964020    36028797018964024   DIVERGE
//! 51298814505517064   odd       51298814505517060    51298814505517064   DIVERGE
//! ```
//!
//! Six of each parity were measured in that band and the split was 6/6 and 6/6;
//! four more in the `ulp == 4` band agreed with the law. Read-back, same
//! sources: XS answers `Number("36028797018964020") === 36028797018964024` with
//! `true` for BOTH parities, where the port and Node answer `true` only for the
//! even one — the biased strtod, exactly as the macro predicts.
//!
//! The construction below exhibits the class; it does not characterize it. For
//! `ulp >= 16` the boundary spelling is not always the one the digit loop
//! stops on, so some odd-mantissa values agree anyway — `72057594037928048`
//! is one, measured. What is exact is the mechanism, not the residue arithmetic
//! used here to reach it.
//!
//! # The same macro explains the sibling family
//!
//! A tie has two sides, and `ROUND_BIASED` treats them oppositely. Everything
//! above is the LOWER boundary, `x - ulp/2`, where the biased rule accepts and
//! the spec's does not. On the UPPER boundary, `x + ulp/2`, it is the other way
//! round: the spec accepts it when the mantissa is even, and XS — whose read-back
//! would round that spelling UP to `x + ulp` — refuses and spends more digits.
//!
//! That is the `finding_*_large_integer_dtoa` family, and it is not a separate
//! phenomenon. Six generated upper-tie values in the `ulp == 8` band split
//! exactly on parity (even: port takes the tie, XS refuses; odd: both refuse,
//! no divergence), and all four values the family pins are even-mantissa upper
//! ties:
//!
//! ```text
//! value                 ulp  mantissa  port (= the tie)      XS
//! 57632001481506816       8  even      57632001481506820     57632001481506816
//! 51298825763029616       8  even      51298825763029620     51298825763029616
//! 74098287619080192      16  even      74098287619080200     74098287619080190
//! 2434477073570463744   512  even      2434477073570464000   2434477073570463700
//! ```
//!
//! So one macro accounts for both: the family is harmless because refusing a
//! shorter spelling still denotes the same double, and this file's class is not
//! because accepting a wrong one does not. Worth one correction while it is in
//! view — those files describe XS as printing "the double's exact integer",
//! which holds for the first two rows and not the last two.
//!
//! # Consequences
//!
//! First, ironhorse is the conformant engine here and no port change can settle
//! the divergence — it is the oracle's build configuration that differs, so the
//! differential targets will keep reporting these expressions whichever way the
//! port moves. They want known-divergence entries, not a fix. Flipping
//! `ROUND_BIASED` off in `xsdtoa.c` would settle both directions at once, but
//! that is a change to vendored Moddable source and belongs to whoever owns the
//! submodule pin.
//!
//! Second, the by-double comparison that suppresses the rest of the family
//! cannot suppress these, because the doubles genuinely differ once XS's string
//! is read back. A reviewer meeting one of these reports should not reach for
//! the same "rendering only" explanation.
//!
//! Needs neither the oracle nor the `c/moddable` submodule: it pins the port's
//! own rendering and the round-trip property, which is the portable claim. The
//! parse side is asserted through `str::parse::<f64>`, which is not a stand-in
//! — `interp::numeric::string_to_number` documents that it uses exactly that
//! for the decimal body, so it is the port's own conversion.

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

/// One member of the class: `x`, its exact midpoint down, and the mantissa
/// parity that decides which spelling round-trips.
struct Tie {
    value: f64,
    /// `x - ulp/2`: the exact boundary between `x - ulp` and `x`, and a decimal
    /// one significant digit shorter than `x` because it ends in `0`.
    midpoint: f64,
    mantissa_is_odd: bool,
}

/// The `ulp == 8` band, where `x % 10 == 4` makes `x - 4` the shorter decimal
/// sitting exactly on the lower boundary. Stepping by `lcm(8, 10) == 40` walks
/// the class and flips the mantissa parity each step.
fn ulp_eight_ties(count: usize) -> Vec<Tie> {
    let mut ties = Vec::new();
    let mut x: u64 = 1 << 55;
    while x % 8 != 0 || x % 10 != 4 {
        x += 1;
    }
    while ties.len() < count {
        assert!(x < 1 << 56, "left the ulp == 8 band");
        ties.push(Tie {
            value: x as f64,
            midpoint: (x - 4) as f64,
            mantissa_is_odd: (x / 8) % 2 == 1,
        });
        x += 40;
    }
    ties
}

/// The law `ROUND_BIASED` breaks, stated over the port.
///
/// At an exact decimal tie the shorter spelling round-trips if and only if the
/// mantissa is even, so a conformant dtoa emits it in exactly that case. Both
/// halves are asserted: which spelling comes out, and that it round-trips.
///
/// Without the round-trip half this test would pass on an engine that always
/// emitted the longer spelling; without the parity half, on one that always
/// emitted the shorter.
#[test]
fn at_an_exact_tie_the_shorter_spelling_is_used_exactly_when_the_mantissa_is_even() {
    let ties = ulp_eight_ties(24);
    let mut odd = 0;
    let mut even = 0;
    for tie in &ties {
        let rendered = number_to_ecma_string(tie.value);
        // Whatever comes out, it must denote the value it came from.
        assert_eq!(
            rendered.parse::<f64>().unwrap().to_bits(),
            tie.value.to_bits(),
            "{rendered} does not round-trip to {}",
            tie.value,
        );
        let shorter = number_to_ecma_string(tie.midpoint);
        if tie.mantissa_is_odd {
            odd += 1;
            assert_ne!(
                rendered, shorter,
                "the shorter spelling is a tie that reads back one ulp low",
            );
            // And that is precisely why: the boundary belongs to the neighbour.
            assert_eq!(
                shorter.parse::<f64>().unwrap(),
                tie.value - 8.0,
                "ties-to-even sends the boundary to the even mantissa",
            );
        } else {
            even += 1;
            assert_eq!(
                rendered, shorter,
                "with an even mantissa the boundary reads back to this value, \
                 so the shorter spelling is the conformant answer",
            );
        }
    }
    // The generator must actually produce both halves, or the loop above
    // asserts nothing about one of them.
    assert_eq!((odd, even), (12, 12), "both parities exercised");
}

/// The second direction, which the finding originally missed.
///
/// `Number("51298814505517060")` is not a rendering question at all, and XS's
/// answer differs from the port's by one ulp for the same reason. Pinned here
/// so the read-back divergence is not rediscovered as a fresh mystery.
#[test]
fn reading_a_tie_back_resolves_to_the_even_mantissa() {
    // The port (and Node): ties-to-even, so an odd-mantissa boundary belongs to
    // the neighbour below. XS, built with the biased strtod, answers the value.
    assert_eq!(XS_LOSSY.parse::<f64>().unwrap(), 51298814505517056.0);
    assert_ne!(XS_LOSSY.parse::<f64>().unwrap(), FINDING_VALUE);

    for tie in ulp_eight_ties(8) {
        let read_back = number_to_ecma_string(tie.midpoint).parse::<f64>().unwrap();
        let expected = if tie.mantissa_is_odd {
            tie.value - 8.0
        } else {
            tie.value
        };
        assert_eq!(
            read_back.to_bits(),
            expected.to_bits(),
            "the boundary below {} must resolve to the even mantissa",
            tie.value,
        );
    }
}
