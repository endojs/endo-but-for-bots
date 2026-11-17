//! The [[Prototype]] and `constructor` links among the error constructors
//! and the generator prototypes, against the pinned XS oracle (V8 agrees).

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str, expected: &str) {
    let run = dual_run(source).expect("the pinned XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
}

/// Each NativeError constructor's [[Prototype]] is %Error% (ES2024
/// 20.5.6.2, 20.5.7.2), so it inherits Error's statics.
#[test]
fn native_error_constructors_inherit_error() {
    assert_result_agrees(
        "[EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, AggregateError, SuppressedError].map(function (C) { return Object.getPrototypeOf(C) === Error; }).join()",
        "true,true,true,true,true,true,true,true",
    );
    assert_result_agrees(
        "Error.isMine = function () { return this.name; }; [TypeError.isMine(), RangeError.isMine()].join()",
        "TypeError,RangeError",
    );
}

/// %GeneratorPrototype%.constructor is %GeneratorFunction.prototype%, as
/// %AsyncGeneratorPrototype%'s is %AsyncGeneratorFunction.prototype%
/// (ES2024 27.5.1.1, 27.6.1.1), non-writable and configurable.
#[test]
fn generator_prototypes_link_back_to_their_function_prototypes() {
    assert_result_agrees(
        "var GP = Object.getPrototypeOf(function* () {}); var AGP = Object.getPrototypeOf(async function* () {}); var d = Object.getOwnPropertyDescriptor(GP.prototype, 'constructor'); [GP.prototype.constructor === GP, AGP.prototype.constructor === AGP, d.writable, d.enumerable, d.configurable].join()",
        "true,true,false,false,true",
    );
}

/// A generator function's own `prototype` object has no `constructor`
/// (ES2024 15.5.4), so an instance's `constructor` is the shared one.
#[test]
fn a_generator_functions_prototype_has_no_constructor() {
    assert_result_agrees(
        "function* g() {} async function* h() {} class A { *m() {} } [g.prototype.hasOwnProperty('constructor'), h.prototype.hasOwnProperty('constructor'), A.prototype.m.prototype.hasOwnProperty('constructor'), Reflect.ownKeys(g.prototype).length, g().constructor === Object.getPrototypeOf(g), (function () {}).prototype.hasOwnProperty('constructor')].join()",
        "false,false,false,0,true,true",
    );
}
