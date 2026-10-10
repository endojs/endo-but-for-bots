//! `get Symbol.prototype.description`, dual-run against the pinned XS
//! oracle.
//!
//! `%Symbol.prototype%` had no `description` accessor at all, so a
//! symbol's `[[Description]]` was unobservable and
//! `getOwnPropertyDescriptor(Symbol.prototype, 'description')` was
//! `undefined`. The mainline closed that
//! (`fix(ironhorse-vm): coerce a Symbol's description, and stop reaching
//! through it`, which landed the accessor together with the
//! constructor's `ToString(description)`) and shipped it without a
//! dedicated differential suite; this file is that suite.
//!
//! The trap it exists to prevent: `Symbol()` — no argument — AGREES with
//! the oracle at `undefined` even with the accessor entirely absent,
//! because the oracle's genuinely-missing description and a property
//! miss render identically. A suite written around that case is green
//! while the bug is entire, so every case below pins a symbol that HAS a
//! description, or the descriptor itself.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str) {
    let dr = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        dr.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        dr.ironhorse_halt,
        dr.oracle_result,
        dr.ironhorse_result,
    );
    assert!(
        dr.result_agrees,
        "`{source}` result divergence: oracle={:?} ironhorse={:?}",
        dr.oracle_result, dr.ironhorse_result,
    );
}

#[test]
fn a_described_symbol_reads_its_description() {
    assert_result_agrees("'' + Symbol('t').description");
    assert_result_agrees("'' + typeof Symbol('t').description");
    assert_result_agrees("'' + Symbol('').description");
    assert_result_agrees("'' + typeof Symbol('').description");
    // The undescribed symbol, kept only beside the described ones: on its
    // own it is the coincidental pass this file exists to prevent.
    assert_result_agrees("'' + typeof Symbol().description");
}

/// The constructor `ToString`s a non-string argument before storing it,
/// so `[[Description]]` is a String for every described symbol and both
/// readers see the same coerced text. `ToString` of a Symbol throws, so
/// a description can never itself be a symbol.
#[test]
fn a_non_string_argument_is_coerced_before_it_is_stored() {
    assert_result_agrees("'' + Symbol(1).description");
    assert_result_agrees("'' + typeof Symbol(1).description");
    assert_result_agrees("'' + Symbol(1).toString()");
    assert_result_agrees("'' + Symbol(null).description");
    assert_result_agrees("'' + Symbol(true).description");
    assert_result_agrees("'' + Symbol({ toString: function () { return 'x' } }).description");
    assert_result_agrees(
        "var c = ''; try { Symbol(Symbol()) } catch (e) { c = e.constructor.name } '' + c",
    );
}

#[test]
fn accessor_descriptor_shape_matches_xs() {
    assert_result_agrees(
        "var d = Object.getOwnPropertyDescriptor(Symbol.prototype, 'description'); \
         '' + [typeof d, typeof d.get, typeof d.set, d.enumerable, d.configurable].join(',')",
    );
    assert_result_agrees("'' + Symbol.prototype.hasOwnProperty('description')");
    assert_result_agrees("'' + Object.getOwnPropertyDescriptor(Symbol('t'), 'description')");
    assert_result_agrees(
        "var d = Object.getOwnPropertyDescriptor(Symbol.prototype, 'description'); \
         '' + [d.get.name, d.get.length].join(',')",
    );
}

#[test]
fn the_getter_performs_this_symbol_value() {
    assert_result_agrees("'' + Object(Symbol('t')).description");
    for receiver in ["1", "'s'", "{}", "undefined", "null", "Symbol.prototype"] {
        assert_result_agrees(&format!(
            "var g = Object.getOwnPropertyDescriptor(Symbol.prototype, 'description').get; \
             var c = ''; try {{ g.call({receiver}) }} catch (e) {{ c = e.constructor.name }} '' + c"
        ));
    }
    assert_result_agrees(
        "var g = Object.getOwnPropertyDescriptor(Symbol.prototype, 'description').get; \
         '' + g.call(Object(Symbol('w')))",
    );
}

#[test]
fn well_known_and_registered_symbols_carry_their_descriptions() {
    assert_result_agrees("'' + Symbol.iterator.description");
    assert_result_agrees("'' + Symbol.toPrimitive.description");
    assert_result_agrees("'' + Symbol.asyncIterator.description");
    assert_result_agrees("'' + Symbol.for('k').description");
}

/// `description` and `toString` read one `[[Description]]`; a split view
/// would be a divergence the single-read cases above cannot see.
#[test]
fn description_and_to_string_agree() {
    assert_result_agrees(
        "var s = Symbol('t'); '' + (s.toString() === 'Symbol(' + s.description + ')')",
    );
}

/// The one divergence the accessor itself introduces:
/// `%Symbol.prototype%`'s own-key ORDER. Recorded against BOTH engines
/// rather than asserted to agree, so a move on either side fails here
/// instead of surfacing in a nightly sweep.
#[test]
fn the_own_key_order_diverges_while_the_key_set_agrees() {
    // The install loop runs `proto_methods` before `proto_accessors`, so
    // `description` lands after the methods where XS builds it first. This
    // is an instance of a pre-existing, engine-wide class —
    // `Error.prototype` reads `toString,stack,constructor,name,message`
    // against XS's `toString,name,message,stack,constructor`, and
    // `Number.prototype` diverges in content as well as order — not a
    // class the accessor introduces. Reordering the shared install loop
    // would move five other prototypes at once, so the instance is
    // recorded, not fixed.
    let dr = dual_run("'' + Object.getOwnPropertyNames(Symbol.prototype).join(',')")
        .expect("the XS oracle machine must start");
    assert_eq!(dr.agreement, Agreement::BothComplete);
    assert_eq!(dr.oracle_result, "description,toString,valueOf,constructor");
    assert_eq!(
        dr.ironhorse_result,
        "toString,valueOf,description,constructor"
    );
    // The KEY SET agrees even though the order does not — before the
    // accessor, `description` was missing from ironhorse's list entirely,
    // so this half of the match is what the change buys.
    let mut oracle: Vec<&str> = dr.oracle_result.split(',').collect();
    let mut ironhorse: Vec<&str> = dr.ironhorse_result.split(',').collect();
    oracle.sort_unstable();
    ironhorse.sort_unstable();
    assert_eq!(oracle, ironhorse, "same own keys, different order");
}
