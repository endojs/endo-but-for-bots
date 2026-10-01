//! A native constructor builds a subclass instance from `new.target`'s
//! `prototype`.
//!
//! `super()` into a native constructor (and `Reflect.construct` with a
//! `newTarget`) must create the object with OrdinaryCreateFromConstructor /
//! GetPrototypeFromConstructor. The dispatcher already computed `new.target`
//! and passed it to every constructor family, but only `Object`, `Date`,
//! `Promise`, `RegExp` and `Iterator` used it. Every other constructor gave the
//! instance its intrinsic prototype, so `class D extends Map {}` produced an
//! object for which `d instanceof D` was false and none of `D`'s methods
//! existed.
//!
//! Each case also exercises the internal slots the instance must keep: a
//! Map subclass instance is still a Map, an Array subclass instance is still
//! an exotic Array, a TypedArray subclass instance still indexes its buffer.
//! The XS-backed expectations were measured on the XS oracle (Node agrees
//! where it has the global); `Intl` was measured on Node, which XS omits;
//! `Temporal`, which neither has, follows the proposal's CreateTemporal…
//! operations.
mod common;
use common::TestCompiler;

use ironhorse_vm::{parse_symbols, Interp};

/// `check(name, make, slot)` pushes `name:protoMatches,instanceof,slot(o)`.
const PRELUDE: &str = r#"var out = [];
function check(name, make, slot) {
  try {
    var r = make(), C = r[0], o = r[1];
    out.push(name + ":" + (Object.getPrototypeOf(o) === C.prototype) + "," + (o instanceof C) + "," + slot(o));
  } catch (e) { out.push(name + ":" + e.name + " " + e.message); }
}"#;

fn run(body: &str) -> String {
    let source = format!("{PRELUDE}\n{body}");
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || {
            let (code, symbols) = ironhorse_compile::compile_atoms(&source).unwrap();
            let mut machine = Interp::new();
            machine.set_source_compiler(std::rc::Rc::new(TestCompiler));
            machine.link_intrinsics(&parse_symbols(&symbols));
            let outcome = machine.run(&code);
            assert!(outcome.completed, "{:?}", outcome.halt);
            outcome.result
        })
        .unwrap()
        .join()
        .unwrap()
}

#[test]
fn a_subclass_of_each_native_constructor_gets_its_own_prototype() {
    assert_eq!(
        run(
            r#"check("Boolean", function () { class C extends Boolean {} return [C, new C(1)]; }, function (o) { return o.valueOf(); });
check("Number", function () { class C extends Number {} return [C, new C(3)]; }, function (o) { return o + 1; });
check("String", function () { class C extends String {} return [C, new C("ab")]; }, function (o) { return o.length + o.charAt(1); });
check("Array", function () { class C extends Array {} return [C, new C()]; }, function (o) { o.push(1, 2); o[5] = 1; return Array.isArray(o) + "/" + o.length; });
check("ArrayLength", function () { class C extends Array {} return [C, new C(3)]; }, function (o) { return o.length; });
check("Error", function () { class C extends Error {} return [C, new C("x")]; }, function (o) { return o.message + "/" + Object.prototype.toString.call(o); });
check("TypeError", function () { class C extends TypeError {} return [C, new C("x")]; }, function (o) { return o instanceof TypeError; });
check("RangeError", function () { class C extends RangeError {} return [C, new C("x")]; }, function (o) { return o.message; });
check("EvalError", function () { class C extends EvalError {} return [C, new C("x")]; }, function (o) { return o.message; });
check("ReferenceError", function () { class C extends ReferenceError {} return [C, new C("x")]; }, function (o) { return o.message; });
check("SyntaxError", function () { class C extends SyntaxError {} return [C, new C("x")]; }, function (o) { return o.message; });
check("URIError", function () { class C extends URIError {} return [C, new C("x")]; }, function (o) { return o.message; });
check("AggregateError", function () { class C extends AggregateError {} return [C, new C([1], "m")]; }, function (o) { return o.errors.length + o.message; });
check("SuppressedError", function () { class C extends SuppressedError {} return [C, new C(1, 2, "m")]; }, function (o) { return o.error + "/" + o.suppressed + "/" + o.message; });
check("DisposableStack", function () { class C extends DisposableStack {} return [C, new C()]; }, function (o) { return o.disposed; });
check("Map", function () { class C extends Map {} return [C, new C([[1, 2]])]; }, function (o) { o.set(3, 4); return o.size + "/" + o.get(1); });
check("Set", function () { class C extends Set {} return [C, new C([1])]; }, function (o) { o.add(2); return o.size; });
check("WeakMap", function () { class C extends WeakMap {} return [C, new C()]; }, function (o) { var k = {}; o.set(k, 1); return o.get(k); });
check("WeakSet", function () { class C extends WeakSet {} return [C, new C()]; }, function (o) { var k = {}; o.add(k); return o.has(k); });
check("ArrayBuffer", function () { class C extends ArrayBuffer {} return [C, new C(4)]; }, function (o) { return o.byteLength; });
check("SharedArrayBuffer", function () { class C extends SharedArrayBuffer {} return [C, new C(2)]; }, function (o) { return o.byteLength; });
check("DataView", function () { class C extends DataView {} return [C, new C(new ArrayBuffer(4))]; }, function (o) { o.setUint8(0, 7); return o.getUint8(0); });
check("Uint8Array", function () { class C extends Uint8Array {} return [C, new C(2)]; }, function (o) { o[0] = 5; return o.length + "/" + o[0]; });
check("Float64Array", function () { class C extends Float64Array {} return [C, new C([1.5])]; }, function (o) { return o[0]; });
check("Compartment", function () { class C extends Compartment {} return [C, new C()]; }, function (o) { return o.evaluate("40 + 2"); });
check("Function", function () { class C extends Function {} return [C, new C("return 1")]; }, function (o) { return o(); });
check("GeneratorFunction", function () { var G = Object.getPrototypeOf(function* () {}).constructor; class C extends G {} return [C, new C("yield 1")]; }, function (o) { return o().next().value; });
out.join("\n")"#
        ),
        r#"Boolean:true,true,true
Number:true,true,4
String:true,true,2b
Array:true,true,true/6
ArrayLength:true,true,3
Error:true,true,x/[object Error]
TypeError:true,true,true
RangeError:true,true,x
EvalError:true,true,x
ReferenceError:true,true,x
SyntaxError:true,true,x
URIError:true,true,x
AggregateError:true,true,1m
SuppressedError:true,true,1/2/m
DisposableStack:true,true,false
Map:true,true,2/2
Set:true,true,2
WeakMap:true,true,1
WeakSet:true,true,true
ArrayBuffer:true,true,4
SharedArrayBuffer:true,true,2
DataView:true,true,7
Uint8Array:true,true,2/5
Float64Array:true,true,1.5
Compartment:true,true,42
Function:true,true,1
GeneratorFunction:true,true,1"#,
    );
}

/// `Reflect.construct(C, args, F)` takes `F.prototype`; a non-object
/// `F.prototype` falls back to the constructor's intrinsic prototype.
#[test]
fn reflect_construct_retargets_each_native_constructor() {
    assert_eq!(
        run(
            r#"function R(base, args) { function F() {} F.prototype = Object.create(base.prototype); return [F, Reflect.construct(base, args || [], F)]; }
function N(base, args) { function F() {} F.prototype = 1; return [base, Reflect.construct(base, args || [], F)]; }
var cases = [["Map", Map], ["Error", Error, ["m"]], ["Array", Array, [2]], ["Number", Number, [1]], ["String", String, ["a"]], ["Boolean", Boolean, [1]], ["Set", Set], ["WeakMap", WeakMap], ["ArrayBuffer", ArrayBuffer, [1]], ["Uint8Array", Uint8Array, [1]], ["DataView", DataView, [new ArrayBuffer(1)]], ["AggregateError", AggregateError, [[]]], ["TypeError", TypeError]];
for (var i = 0; i < cases.length; i++) {
  (function (c) {
    check("R-" + c[0], function () { return R(c[1], c[2]); }, function (o) { return typeof o; });
    // A non-object `newTarget.prototype` falls back to the intrinsic.
    check("N-" + c[0], function () { return N(c[1], c[2]); }, function (o) { return typeof o; });
  })(cases[i]);
}
out.join("\n")"#
        ),
        r#"R-Map:true,true,object
N-Map:true,true,object
R-Error:true,true,object
N-Error:true,true,object
R-Array:true,true,object
N-Array:true,true,object
R-Number:true,true,object
N-Number:true,true,object
R-String:true,true,object
N-String:true,true,object
R-Boolean:true,true,object
N-Boolean:true,true,object
R-Set:true,true,object
N-Set:true,true,object
R-WeakMap:true,true,object
N-WeakMap:true,true,object
R-ArrayBuffer:true,true,object
N-ArrayBuffer:true,true,object
R-Uint8Array:true,true,object
N-Uint8Array:true,true,object
R-DataView:true,true,object
N-DataView:true,true,object
R-AggregateError:true,true,object
N-AggregateError:true,true,object
R-TypeError:true,true,object
N-TypeError:true,true,object"#,
    );
}

#[test]
fn a_subclass_of_each_intl_constructor_gets_its_own_prototype() {
    assert_eq!(
        run(
            r#"check("Locale", function () { class C extends Intl.Locale {} return [C, new C("en-US")]; }, function (o) { return o.language; });
check("Collator", function () { class C extends Intl.Collator {} return [C, new C("en")]; }, function (o) { return o.compare("a", "b"); });
check("ListFormat", function () { class C extends Intl.ListFormat {} return [C, new C("en")]; }, function (o) { return o.format(["a", "b"]); });
check("PluralRules", function () { class C extends Intl.PluralRules {} return [C, new C("en")]; }, function (o) { return o.select(1); });
check("Segmenter", function () { class C extends Intl.Segmenter {} return [C, new C("en")]; }, function (o) { return typeof o.segment; });
check("DateTimeFormat", function () { class C extends Intl.DateTimeFormat {} return [C, new C("en", {timeZone: "UTC"})]; }, function (o) { return o.format(0); });
check("NumberFormat", function () { class C extends Intl.NumberFormat {} return [C, new C("en")]; }, function (o) { return o.format(1234); });
out.join("\n")"#
        ),
        r#"Locale:true,true,en
Collator:true,true,-1
ListFormat:true,true,a and b
PluralRules:true,true,one
Segmenter:true,true,function
DateTimeFormat:true,true,1/1/1970
NumberFormat:true,true,1,234"#,
    );
}

#[test]
fn a_subclass_of_each_temporal_constructor_gets_its_own_prototype() {
    assert_eq!(
        run(
            r#"check("Instant", function () { class C extends Temporal.Instant {} return [C, new C(5n)]; }, function (o) { return o.epochNanoseconds; });
check("Duration", function () { class C extends Temporal.Duration {} return [C, new C(1)]; }, function (o) { return o.years; });
check("PlainDate", function () { class C extends Temporal.PlainDate {} return [C, new C(2020, 1, 2)]; }, function (o) { return o.day; });
check("PlainTime", function () { class C extends Temporal.PlainTime {} return [C, new C(1, 2)]; }, function (o) { return o.minute; });
check("ZonedDateTime", function () { class C extends Temporal.ZonedDateTime {} return [C, new C(0n, "UTC")]; }, function (o) { return o.year; });
out.join("\n")"#
        ),
        r#"Instant:true,true,5
Duration:true,true,1
PlainDate:true,true,2
PlainTime:true,true,2
ZonedDateTime:true,true,1970"#,
    );
}

/// A Temporal constructor converts its fields — guest `valueOf` included, which
/// halted the engine when the conversion re-entered without the caller's
/// bytecode — and only then reads the prototype (the proposal's
/// ToIntegerWithTruncation steps precede CreateTemporal…'s
/// OrdinaryCreateFromConstructor). Neither oracle has Temporal.
#[test]
fn a_temporal_constructor_converts_its_fields_before_the_prototype() {
    assert_eq!(
        run(r#"var log = [];
function NT() { return new Proxy(function () {}, { get: function (t, k, r) { if (k === "prototype") log.push("P"); return Reflect.get(t, k, r); } }); }
function A(n, v) { return { valueOf: function () { log.push(n); return v; } }; }
function t(name, C, args) { log = []; var r; try { var o = Reflect.construct(C, args, NT()); r = "ok"; } catch (e) { r = e.name; } out.push(name + ":" + log.join(",") + ">" + r); }
t("Duration", Temporal.Duration, [A("y", 1), A("m", 2)]);
t("DurationBad", Temporal.Duration, [A("y", 1), A("m", -2)]);
t("PlainDate", Temporal.PlainDate, [A("y", 2020), A("m", 1), A("d", 2)]);
t("PlainDateBad", Temporal.PlainDate, [A("y", 2020), A("m", 13), A("d", 2)]);
t("PlainTime", Temporal.PlainTime, [A("h", 1), A("m", 2)]);
t("Instant", Temporal.Instant, [0n]);
out.push(new Temporal.Duration(A("y", 3)).years);
out.join("\n")"#),
        "Duration:y,m,P>ok\nDurationBad:y,m>RangeError\nPlainDate:y,m,d,P>ok\nPlainDateBad:y,m,d>RangeError\nPlainTime:h,m,P>ok\nInstant:P>ok\n3",
    );
}

/// The `prototype` read is observable — here through a Proxy `new.target`'s
/// `get` trap — and each constructor performs it at XS's step: before an
/// Error's message, a Map's iterable or an Array's elements; after a
/// wrapper's coercion or a buffer's length and offset.
#[test]
fn the_prototype_is_read_at_the_step_xs_reads_it() {
    assert_eq!(
        run(r#"var log = [];
function target(base) {
  return new Proxy(function () {}, { get: function (t, k) { if (k === "prototype") { log.push("proto"); return base.prototype; } return t[k]; } });
}
var msg = { toString: function () { log.push("msg"); return "m"; } };
function step(name, f) { log.push(name + ":"); try { f(); } catch (e) { log.push("X:" + e.name); } }
step("Error", function () { Reflect.construct(Error, [msg], target(Error)); });
step("Map", function () { Reflect.construct(Map, [{ [Symbol.iterator]: function () { log.push("iter"); return [][Symbol.iterator](); } }], target(Map)); });
step("Array", function () { Reflect.construct(Array, [1, 2], target(Array)); });
step("Boolean", function () { Reflect.construct(Boolean, [1], target(Boolean)); });
step("String", function () { Reflect.construct(String, [msg], target(String)); });
step("Number", function () { Reflect.construct(Number, [{ valueOf: function () { log.push("num"); return 1; } }], target(Number)); });
step("ArrayBuffer", function () { Reflect.construct(ArrayBuffer, [{ valueOf: function () { log.push("len"); return 1; } }], target(ArrayBuffer)); });
step("DataView", function () { Reflect.construct(DataView, [new ArrayBuffer(2), { valueOf: function () { log.push("off"); return 0; } }], target(DataView)); });
step("Uint8Array", function () { Reflect.construct(Uint8Array, [{ valueOf: function () { log.push("len"); return 1; } }], target(Uint8Array)); });
step("Set", function () { var s = Reflect.construct(Set, [], target(Set)); log.push(s instanceof Set); });
log.join(" ")"#),
        r#"Error: proto msg Map: proto iter Array: proto Boolean: proto String: msg proto Number: num proto ArrayBuffer: len proto DataView: off proto Uint8Array: proto Set: proto true"#,
    );
}

/// A direct `new` reads nothing: `new.target` is the native itself, whose
/// `prototype` is fixed, so a plain construction's metering is unchanged.
#[test]
fn a_direct_construction_keeps_the_intrinsic_prototype() {
    assert_eq!(
        run("[Object.getPrototypeOf(new Map()) === Map.prototype, \
              Object.getPrototypeOf(new Error('x')) === Error.prototype, \
              Object.getPrototypeOf(new Uint8Array(1)) === Uint8Array.prototype, \
              Object.getPrototypeOf(Error('x')) === Error.prototype].join()"),
        "true,true,true,true",
    );
}
