//! An escaping throw can be rendered by the guest's own `toString` — but only
//! where the caller asks for it.
//!
//! The differential harness compares ironhorse's rendering of an uncaught throw
//! against the oracle's. The oracle's does not come from XS: `xs_shim.c`'s
//! `endor_error_from_exception` runs `fxToString` on `mxException` after
//! `mxCatch`, in the SHIM, and falls back to the literal
//! `(exception stringification threw)` when the stringification itself throws.
//! So the oracle reports whatever a guest `toString` returns, and test262's
//! `Test262Error` — whose prototype `toString` yields
//! `"Test262Error: " + this.message` (`harness/sta.js:18`) — is reported by
//! that name.
//!
//! The port's boundary is deliberately guest-free and reported `Object: …`
//! for the same value, from a heuristic that pairs the
//! `Object.prototype.toString` tag with a readable `message`. That string is
//! one XS never produces in EITHER direction: for a plain object carrying a
//! message XS reports `[object Object]`, and for a `Test262Error` it reports
//! the guest's text. Nothing readable without running guest code can produce
//! the latter, so the guest-free approximation cannot match it and must not
//! try.
//!
//! [`Interp::run_rendering_throws_in_guest`] is the opt-in that renders the way
//! the shim does. The ordinary entry points are unchanged, and
//! `host_rendering_meter.rs` still pins what that buys: a diagnostic render
//! cannot run guest work past an exhausted meter ceiling, cannot allocate past
//! the chunk ceiling, and cannot make a run's cost depend on rendering work.
//!
//! Every `XS` string below was measured against the pinned oracle
//! (`23b4d6b0`, XS 8.3.1) before it was asserted here.

use ironhorse_compile::compile_atoms;
use ironhorse_vm::{parse_symbols_checked, Halt, Interp};

fn thrown(source: &str, in_guest: bool) -> String {
    let (bytecode, symbols) = compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols_checked(&symbols).unwrap());
    let outcome = if in_guest {
        vm.run_rendering_throws_in_guest(&bytecode)
    } else {
        vm.run(&bytecode)
    };
    match outcome.halt {
        Halt::Throw { rendered, .. } => rendered,
        other => panic!("{source}: expected a throw, got {other:?}"),
    }
}

/// `(source, what XS reports)`.
const AGAINST_THE_ORACLE: &[(&str, &str)] = &[
    // The shape the whole exercise is about: the harness's own error.
    (
        "function Test262Error(m){this.message=m} \
         Test262Error.prototype.toString=function(){return 'Test262Error: '+this.message}; \
         throw new Test262Error('boom')",
        "Test262Error: boom",
    ),
    // Any guest `toString` on the prototype, not just that one.
    (
        "function E(m){this.message=m} \
         E.prototype.toString=function(){return 'E: '+this.message}; throw new E('m')",
        "E: m",
    ),
    // WITHOUT a custom `toString`, XS reports the tag — even though a
    // `message` is right there. This is the half the old heuristic got wrong
    // in the opposite direction, reporting `Object: m`.
    ("throw {message:'m'}", "[object Object]"),
    (
        "function E(m){this.message=m} throw new E('m')",
        "[object Object]",
    ),
    (
        "class E { constructor(m){ this.message = m } } throw new E('m')",
        "[object Object]",
    ),
    ("throw {}", "[object Object]"),
    // A `Symbol.toStringTag` changes the tag, and nothing else does: an
    // overridden constructor `name` does NOT, which is what rules out reading
    // the constructor's name instead of running `toString`.
    (
        "throw {message:'m', [Symbol.toStringTag]:'Tag'}",
        "[object Tag]",
    ),
    (
        "function E(m){this.message=m} Object.defineProperty(E,'name',{value:'Renamed'}); \
         throw new E('m')",
        "[object Object]",
    ),
    // Native errors already agreed, and must keep agreeing.
    ("throw new TypeError('m')", "TypeError: m"),
    (
        "class E extends TypeError {} throw new E('m')",
        "TypeError: m",
    ),
    // Primitives and arrays go through ordinary `ToString`.
    ("throw 'plain'", "plain"),
    ("throw [1,2]", "1,2"),
    // The sentinel: a null-prototype object has no `toString` to call, so
    // `ToString` throws and both engines report the shim's literal text.
    (
        "var o = Object.create(null); o.message='m'; throw o",
        "(exception stringification threw)",
    ),
];

#[test]
fn the_opt_in_render_matches_the_oracle_shim() {
    let mut mismatches = Vec::new();
    for (source, expected) in AGAINST_THE_ORACLE {
        let observed = thrown(source, true);
        if observed != *expected {
            mismatches.push(format!(
                "{source}\n  want {expected:?}\n  got  {observed:?}"
            ));
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// The default entry point did not change, which is what keeps the guarantees
/// in `host_rendering_meter.rs` true for every embedder that did not ask.
///
/// Both halves matter. The guest `toString` must NOT run — pinned by a
/// `toString` with an observable side effect — and the cases that never needed
/// it must render identically either way.
#[test]
fn the_ordinary_boundary_still_refuses_to_run_guest_code() {
    // The side effect proves the call did not happen: had `toString` run, the
    // rendering would be `ran`.
    let source =
        "globalThis.seen = 'no'; throw {toString(){ globalThis.seen = 'yes'; return 'ran' }}";
    assert_eq!(thrown(source, false), "[object Object]");
    // And with the opt-in it does run, so the probe is not inert.
    assert_eq!(thrown(source, true), "ran");

    // Values needing no guest call render the same through both entry points.
    for source in [
        "throw new TypeError('m')",
        "throw 'plain'",
        "throw [1,2]",
        "throw {}",
    ] {
        assert_eq!(
            thrown(source, false),
            thrown(source, true),
            "{source}: the two entry points disagree on a value needing no guest call"
        );
    }
}
