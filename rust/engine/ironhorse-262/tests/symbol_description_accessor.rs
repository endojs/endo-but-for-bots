//! `get Symbol.prototype.description`, dual-run against the pinned XS
//! oracle.
//!
//! Regression: `%Symbol.prototype%` carried `toString`, `valueOf` and
//! `@@toPrimitive` but no `description` accessor, so a symbol's
//! `[[Description]]` was unobservable and
//! `getOwnPropertyDescriptor(Symbol.prototype, 'description')` was
//! `undefined`. `Symbol()` — no argument — AGREED with the oracle at
//! `undefined` throughout, for the wrong reason (the oracle returns the
//! genuinely-absent description; ironhorse returned the miss), so every
//! case below pins a symbol that HAS a description, or the descriptor
//! itself.

//! The accessor also widened the `Kind::Symbol` arm of
//! `XS_CODE_GET_PROPERTY` from a raw slot-chain walk to the full
//! `OrdinaryGet` (an accessor slot's stored value is an inert
//! `undefined`, so a walk can never run a getter). That widening makes
//! EVERY MOP path reachable from a primitive-symbol receiver for the
//! first time — guest accessors, throwing getters and their unwind, a
//! Proxy on the prototype chain — so the second half of this file pins
//! those paths rather than only `description`. Four of them moved from
//! diverging to agreeing; the two that still diverge are RECORDED here
//! against both engines rather than asserted to agree, so a change on
//! either side is loud.

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

#[test]
fn accessor_descriptor_shape_matches_xs() {
    assert_result_agrees(
        "var d = Object.getOwnPropertyDescriptor(Symbol.prototype, 'description'); \
         '' + [typeof d, typeof d.get, typeof d.set, d.enumerable, d.configurable].join(',')",
    );
    assert_result_agrees("'' + Symbol.prototype.hasOwnProperty('description')");
    assert_result_agrees(
        "'' + Object.getOwnPropertyDescriptor(Symbol('t'), 'description')",
    );
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

/// A guest accessor installed on `%Symbol.prototype%` (or inherited from
/// `%Object.prototype%`) now runs for a primitive-symbol receiver, with
/// the symbol itself as `this` — the `GetThisValue` receiver, which is
/// the primitive and not a wrapper. Every one of these read `undefined`
/// before the arm took the full `OrdinaryGet`.
#[test]
fn a_guest_accessor_runs_for_a_primitive_symbol_receiver() {
    assert_result_agrees(
        "Object.defineProperty(Symbol.prototype, 'probe', { get: function () { return 7 } }); \
         '' + Symbol('x').probe",
    );
    assert_result_agrees(
        "Object.defineProperty(Symbol.prototype, 'self', \
           { get: function () { return typeof this } }); \
         '' + Symbol('x').self",
    );
    assert_result_agrees(
        "Object.defineProperty(Object.prototype, 'inherited', { get: function () { return 9 } }); \
         '' + Symbol('x').inherited",
    );
}

/// A getter that THROWS must unwind through the enclosing handler rather
/// than escape the dispatch loop — the reason the arm routes through
/// `dispatch_result!` and not a bare `?`. Native re-entry (a callback
/// frame) and a generator boundary are the shapes that catch a
/// mis-plumbed `Halt::Resume`; all four diverged before this change.
#[test]
fn a_throwing_getter_unwinds_to_the_enclosing_handler() {
    assert_result_agrees(
        "Object.defineProperty(Symbol.prototype, 'boom', { get: function () { throw 'b' } }); \
         var o = ''; try { try { Symbol('x').boom } finally { o += 'F' } } catch (e) { o += e } '' + o",
    );
    assert_result_agrees(
        "Object.defineProperty(Symbol.prototype, 'boom', { get: function () { throw 'b' } }); \
         var o = ''; try { [Symbol('x')].map(function (s) { return s.boom }) } catch (e) { o = 'caught:' + e } '' + o",
    );
    assert_result_agrees(
        "Object.defineProperty(Symbol.prototype, 'boom', { get: function () { throw 'b' } }); \
         var o = ''; \
         function* g() { yield Symbol('x').boom } \
         try { for (var v of g()) { o += v } } catch (e) { o += e } '' + o",
    );
}

/// Two divergences the widening makes newly REACHABLE. Neither is a
/// regression — both answers diverged before too (the trap never ran at
/// all; `description` was absent from the key list entirely) — and
/// neither is asserted to agree. They are pinned against BOTH engines so
/// a move on either side fails here instead of surfacing in a nightly
/// sweep.
#[test]
fn recorded_divergences_from_the_widened_symbol_arm() {
    // ECMA-262 `GetValue` reads `baseObj.[[Get]](P, GetThisValue(V))`, and
    // `GetThisValue` of a non-super property reference is `V.[[Base]]` —
    // the PRIMITIVE. ironhorse now passes it through unchanged, so a Proxy
    // on `%Symbol.prototype%`'s chain sees `receiver` as the symbol; XS
    // boxes it for the trap while passing the primitive to a getter (the
    // `self` case above, where the two engines agree). ironhorse is the
    // spec-conformant side here; recorded because oracle-locked means a
    // divergence is a divergence, whichever way it points.
    let dr = dual_run(
        "Object.setPrototypeOf(Symbol.prototype, \
           new Proxy({}, { get: function (t, k, r) { return typeof r } })); \
         '' + Symbol('x').zzz",
    )
    .expect("the XS oracle machine must start");
    assert_eq!(dr.agreement, Agreement::BothComplete);
    assert_eq!(dr.oracle_result, "object", "XS boxes the trap's Receiver");
    assert_eq!(
        dr.ironhorse_result, "symbol",
        "ironhorse passes GetThisValue's primitive"
    );

    // `%Symbol.prototype%`'s own-key ORDER. The install loop runs
    // `proto_methods` before `proto_accessors`, so `description` lands
    // after the methods where XS builds it first. This is an instance of
    // a pre-existing, engine-wide class — `Error.prototype` reads
    // `toString,stack,constructor,name,message` against XS's
    // `toString,name,message,stack,constructor`, and `Number.prototype`
    // diverges in content as well as order — not a class this change
    // introduces. Reordering the shared install loop would move five
    // other prototypes at once, so the instance is recorded, not fixed.
    let dr = dual_run("'' + Object.getOwnPropertyNames(Symbol.prototype).join(',')")
        .expect("the XS oracle machine must start");
    assert_eq!(dr.agreement, Agreement::BothComplete);
    assert_eq!(dr.oracle_result, "description,toString,valueOf,constructor");
    assert_eq!(dr.ironhorse_result, "toString,valueOf,description,constructor");
    // The KEY SET agrees even though the order does not — before the
    // accessor, `description` was missing from ironhorse's list entirely.
    let mut oracle: Vec<&str> = dr.oracle_result.split(',').collect();
    let mut ironhorse: Vec<&str> = dr.ironhorse_result.split(',').collect();
    oracle.sort_unstable();
    ironhorse.sort_unstable();
    assert_eq!(oracle, ironhorse, "same own keys, different order");
}

/// The widening reaches SYMBOLS only. Number, String, Boolean and BigInt
/// receivers still take their raw chain walks, so an accessor inherited
/// from `%Object.prototype%` is invisible to them. XS answers `5` for all
/// five; ironhorse now answers it for one. Recorded so the remaining four
/// are visible as the named residue of this change rather than as
/// silence.
#[test]
fn only_the_symbol_arm_observes_an_inherited_accessor() {
    let dr = dual_run(
        "Object.defineProperty(Object.prototype, 'probe', { get: function () { return 5 } }); \
         '' + [Symbol('x').probe, (5).probe, 'str'.probe, true.probe, (10n).probe].join(',')",
    )
    .expect("the XS oracle machine must start");
    assert_eq!(dr.agreement, Agreement::BothComplete);
    assert_eq!(dr.oracle_result, "5,5,5,5,5");
    assert_eq!(
        dr.ironhorse_result, "5,,,,",
        "symbol observes the inherited accessor; the other four primitives do not yet"
    );
}
