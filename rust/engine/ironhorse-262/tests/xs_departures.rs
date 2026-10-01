//! Where Ironhorse deliberately answers differently from the pinned XS
//! oracle, and where it keeps XS's answer although V8 differs.
//!
//! Ironhorse matches XS (`c/moddable`, the `xs-oracle` build) unless XS
//! contradicts the specification; V8 (Node 22) is the second opinion. Each
//! row of [`DEPARTURES`] is a program whose answer Ironhorse takes from the
//! specification and V8 against XS, with both engines' answers and the
//! reason. Each row of [`UNPAIRED`] departs from XS where V8 has no
//! counterpart. Each row of [`KEPT`] is a program where XS and V8 disagree,
//! the specification allows XS's answer or the behavior is XS's own design,
//! and Ironhorse follows XS; V8's answer is recorded for the reader. Each
//! row of [`SHARED`] is an XS answer that contradicts the specification and
//! that Ironhorse still gives: a gap to close, recorded so that closing it
//! moves the row to [`DEPARTURES`].
//!
//! Every table runs on both engines with [`dual_run`], so they are a ratchet:
//! when a pin bump changes XS's answer, or Ironhorse's changes, the row
//! fails, and the record is updated in the same change. V8 is not run here.
//!
//! An answer is the program's completion value as `String()` renders it, or
//! `throw ` and the thrown value's rendering.

use ironhorse_262::{dual_run, Agreement, DualRun};

/// A program and the answer each engine gives.
struct Row {
    program: &'static str,
    ironhorse: &'static str,
    xs: &'static str,
    v8: &'static str,
    why: &'static str,
}

const DEPARTURES: &[Row] = &[
    Row {
        program: "[(0.5).toFixed(0), (-0.5).toFixed(0)].join(' ')",
        ironhorse: "1 -1",
        xs: "0 -0",
        v8: "1 -1",
        why: "Number.prototype.toFixed rounds the exact value, a tie to the larger digits (ES2024 21.1.3.3)",
    },
    Row {
        program: "[(123456).toPrecision(7), (12).toPrecision(4), (1.5).toPrecision(5), (123.5).toPrecision(6)].join(' ')",
        ironhorse: "123456.0 12.00 1.5000 123.500",
        xs: "123456 12.0 1.500 123.5",
        v8: "123456.0 12.00 1.5000 123.500",
        why: "Number.prototype.toPrecision keeps every requested digit (ES2024 21.1.3.5)",
    },
    Row {
        program: "'use strict'; var o = Object.create(new String('abc')); var r; try { o[1] = 'q'; r = 'wrote ' + o[1]; } catch (e) { r = e.constructor.name; } r",
        ironhorse: "TypeError",
        xs: "wrote b",
        v8: "TypeError",
        why: "OrdinarySet returns false for an inherited read-only character, which strict code throws",
    },
    Row {
        program: "var log = []; function NT() { return new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); }}); } var like = {[Symbol.match]: true, get source() { log.push('src'); return 'x'; }, get flags() { log.push('flg'); return 'g'; }}; Reflect.construct(RegExp, [like], NT()); log.join()",
        ironhorse: "src,flg,P",
        xs: "P,src,flg",
        v8: "src,flg,P",
        why: "the RegExp constructor reads a RegExp-like pattern's source and flags before RegExpAlloc reads the prototype (ES2024 22.2.4.1)",
    },
    Row {
        program: "var log = []; var NT = new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); }}); Reflect.construct(Date, [{valueOf: function () { log.push('v'); return 0; }}], NT); log.join()",
        ironhorse: "v,P",
        xs: "P,v",
        v8: "v,P",
        why: "the Date constructor converts its value before OrdinaryCreateFromConstructor reads the prototype (ES2024 21.4.2.1)",
    },
    Row {
        program: "var x = 'ab'.matchAll(/./g); x.next() === x.next()",
        ironhorse: "false",
        xs: "true",
        v8: "false",
        why: "%RegExpStringIteratorPrototype%.next creates a fresh result object per step (CreateIterResultObject)",
    },
    Row {
        program: "function* g() {} var r = g().next(); var d = Object.getOwnPropertyDescriptor(r, 'value'); [d.writable, d.configurable].join()",
        ironhorse: "true,true",
        xs: "false,false",
        v8: "true,true",
        why: "CreateIterResultObject makes a generator's result fields writable and configurable; XS's fxNewGeneratorResult, which builds a completed or async generator's results, protects them (its yields, built in bytecode, do not)",
    },
    Row {
        program: "function* g() { yield 1; } var r = g().return(5); var d = Object.getOwnPropertyDescriptor(r, 'done'); [r.value, d.writable, d.configurable].join()",
        ironhorse: "5,true,true",
        xs: "5,false,false",
        v8: "5,true,true",
        why: "as above, for the result of return()",
    },
    Row {
        program: "function F() {} F.prototype = Object.create(Object.getPrototypeOf(function* () {}).prototype); var r; try { class C extends F {} r = 'ok'; } catch (e) { r = e.constructor.name + ':' + e.message; } r",
        ironhorse: "ok",
        xs: "TypeError:extends: class is a generator",
        v8: "ok",
        why: "ClassDefinitionEvaluation requires only a constructor whose prototype is an object or null",
    },
    Row {
        program: "var f = null; String(f?.()?.())",
        ironhorse: "undefined",
        xs: "throw TypeError: call: not a function",
        v8: "undefined",
        why: "a nullish base short-circuits the whole optional chain; XS's coder lands the second link's short-circuit with a stale receiver on the stack",
    },
    Row {
        program: "var a = null; String(a?.b()?.())",
        ironhorse: "undefined",
        xs: "throw TypeError: call: not a function",
        v8: "undefined",
        why: "as above, for a method call inside the chain",
    },
    Row {
        program: "class C { #x = 1; m(o) { return eval('#x in o'); } } [new C().m(new C()), new C().m({})].join()",
        ironhorse: "true,false",
        xs: "throw SyntaxError: invalid character 120",
        v8: "true,false",
        why: "a private brand check is valid in a direct eval inside the class (PerformEval's private environment)",
    },
    Row {
        program: "class C { static #s = 4; static { this.v = eval('C.#s'); } } C.v",
        ironhorse: "4",
        xs: "throw ReferenceError: get C: not initialized yet",
        v8: "4",
        why: "a static block sees its class binding, also through a direct eval",
    },
    Row {
        program: "class B { constructor() { this.b = 1; } } class D extends B { constructor() { super(); this.v = eval('super.constructor === B'); } } new D().v",
        ironhorse: "true",
        xs: "throw TypeError: cannot coerce to object",
        v8: "true",
        why: "a direct eval in a derived constructor reads super properties through the constructor's home object",
    },
    Row {
        program: "function f() { return eval('eval(\"new.target\")'); } var r = new f(); [typeof r, f() === undefined].join()",
        ironhorse: "function,true",
        xs: "throw SyntaxError: invalid new.target",
        v8: "function,true",
        why: "a direct eval inside a direct eval inherits the function context, new.target included",
    },
    Row {
        program: "class C { x = eval('eval(\"arguments\")'); } var r; try { new C(); r = 'ok'; } catch (e) { r = e.constructor.name; } r",
        ironhorse: "SyntaxError",
        xs: "ReferenceError",
        v8: "SyntaxError",
        why: "ContainsArguments in a field initializer is an early SyntaxError, also through a nested direct eval",
    },
    Row {
        program: "class C { static x = eval('this === C'); } C.x",
        ironhorse: "true",
        xs: "throw ReferenceError: get C: not initialized yet",
        v8: "true",
        why: "a static field initializer sees its class binding, also through a direct eval",
    },
    Row {
        program: "Object.prototype.toString.call(new Intl.NumberFormat())",
        ironhorse: "[object Intl.NumberFormat]",
        xs: "throw ReferenceError: get Intl: undefined variable",
        v8: "[object Intl.NumberFormat]",
        why: "ECMA-402's @@toStringTag strings; the XS build has no Intl",
    },
];

/// Programs where Ironhorse departs from XS and V8 has no counterpart to
/// follow.
const UNPAIRED: &[Row] = &[
    Row {
        program: "var IP = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())); var cap; IP.return = function () { cap = this; return {}; }; for (var k in {a: 1, b: 2}) break; delete IP.return; var P = Object.getPrototypeOf(cap); [Object.getOwnPropertyNames(cap).join('+'), Object.getOwnPropertyNames(P).join('+'), Object.getPrototypeOf(P) === IP].join('|')",
        ironhorse: "|next|true",
        xs: "result+iterable|next+constructor|true",
        v8: "throw TypeError: Cannot convert undefined or null to object",
        why: "the specification never exposes a for-in iterator; XS's can be captured through a patched %IteratorPrototype%.return, and shows its internal slots and an internal constructor, which Ironhorse does not reproduce; V8 has no enumerator object",
    },
    Row {
        program: "Object.prototype.toString.call(Temporal.Now)",
        ironhorse: "[object Temporal.Now]",
        xs: "throw ReferenceError: get Temporal: undefined variable",
        v8: "throw ReferenceError: Temporal is not defined",
        why: "Temporal's @@toStringTag strings; neither the XS build nor Node 22 has Temporal",
    },
];

const KEPT: &[Row] = &[
    Row {
        program: "var o = {a: 1, b: 2}; var r = []; for (var k in o) { r.push(k); Object.defineProperty(o, 'b', {enumerable: false}); } r.join()",
        ironhorse: "a",
        xs: "a",
        v8: "a,b",
        why: "for-in may skip a key made non-enumerable before its turn (EnumerateObjectProperties)",
    },
    Row {
        program: "var p = {}, o = Object.create(p); o.a = 1; var r = []; for (var k in o) { r.push(k); p.z = 1; } r.join()",
        ironhorse: "a,z",
        xs: "a,z",
        v8: "a",
        why: "for-in lists each prototype level when it reaches it, so a key added there mid-loop is yielded",
    },
    Row {
        program: "var q = {y: 1}, p = {z: 1}, o = Object.create(p); o.a = 1; var r = []; for (var k in o) { r.push(k); Object.setPrototypeOf(o, q); } r.join()",
        ironhorse: "a,y",
        xs: "a,y",
        v8: "a",
        why: "for-in follows the prototype the receiver has when its own level is done",
    },
    Row {
        program: "var p = {c: 1, b: 2}; var o = Object.create(p); o.a = 1; o.b = 3; var r = []; for (var k in o) { r.push(k); if (k === 'a') delete o.b; } r.join()",
        ironhorse: "a,c,b",
        xs: "a,c,b",
        v8: "a,b,c",
        why: "a key deleted before its turn is unvisited, so the inherited key of that name is yielded at its own level",
    },
    Row {
        program: "var log = []; var t = {a: 1, b: 2}; var p = new Proxy(t, {ownKeys: function (t) { log.push('keys'); return Reflect.ownKeys(t); }, getOwnPropertyDescriptor: function (t, k) { log.push('gopd' + k); return Reflect.getOwnPropertyDescriptor(t, k); }, getPrototypeOf: function (t) { log.push('proto'); return Reflect.getPrototypeOf(t); }}); for (var k in p) log.push('body' + k); log.join()",
        ironhorse: "keys,gopda,bodya,gopdb,bodyb,proto",
        xs: "keys,gopda,bodya,gopdb,bodyb,proto",
        v8: "keys,proto,gopda,bodya,gopdb,bodyb",
        why: "for-in reads a Proxy level's prototype when the level is done",
    },
    Row {
        program: "var it = [1, 2].values(); var a = it.next(); var b = it.next(); var d = Object.getOwnPropertyDescriptor(a, 'value'); [a === b, d.writable, d.configurable].join()",
        ironhorse: "true,false,false",
        xs: "true,false,false",
        v8: "false,true,true",
        why: "XS reuses one protected result object per Array, String, Map and Set iterator; CreateIterResultObject would make a fresh one per step",
    },
    Row {
        program: "var ts = Object.prototype.toString; Object.defineProperty(Number.prototype, Symbol.toStringTag, {get: function () { 'use strict'; return typeof this; }, configurable: true}); ts.call(5)",
        ironhorse: "[object object]",
        xs: "[object object]",
        v8: "[object number]",
        why: "Object.prototype.toString reads @@toStringTag from ToObject(this), so a getter sees the wrapper",
    },
];

/// XS answers that contradict the specification and that Ironhorse still
/// gives, as V8 does not.
const SHARED: &[Row] = &[
    Row {
        program: "class B {} class D extends B { constructor() { try { eval('super()'); } catch (e) { this.e = e.constructor.name; } } } try { new D(); } catch (e) { e.constructor.name }",
        ironhorse: "ReferenceError",
        xs: "ReferenceError",
        v8: "[object Object]",
        why: "PerformEval allows SuperCall in a direct eval inside a derived constructor; XS rejects it",
    },
    Row {
        program: "function f() { return (() => eval('new.target'))(); } var r; try { r = String(f()); } catch (e) { r = e.constructor.name; } r",
        ironhorse: "SyntaxError",
        xs: "SyntaxError",
        v8: "undefined",
        why: "an arrow function's direct eval may name new.target, its enclosing function's (PerformEval's inFunction)",
    },
    Row {
        program: "class A { m() { return eval('new.target'); } } var r; try { r = String(new A().m()); } catch (e) { r = e.constructor.name; } r",
        ironhorse: "SyntaxError",
        xs: "SyntaxError",
        v8: "undefined",
        why: "a method's direct eval may name new.target, undefined in a method",
    },
    Row {
        program: "function f() { return (() => eval('arguments.length'))(); } var r; try { r = f(1, 2); } catch (e) { r = e.constructor.name; } r",
        ironhorse: "ReferenceError",
        xs: "ReferenceError",
        v8: "2",
        why: "an arrow function's direct eval sees its enclosing function's arguments",
    },
];

/// The engine's answer, as the rows spell it.
fn answers(run: &DualRun) -> (String, String) {
    let render = |completed: bool, result: &str, error: &str| {
        if completed {
            result.to_string()
        } else {
            format!("throw {error}")
        }
    };
    let (xs_completed, ironhorse_completed) = match run.agreement {
        Agreement::BothComplete => (true, true),
        Agreement::BothAbort => (false, false),
        Agreement::IronhorseOnlyComplete => (false, true),
        Agreement::OracleOnlyComplete => (true, false),
    };
    (
        render(
            ironhorse_completed,
            &run.ironhorse_result,
            &run.ironhorse_error,
        ),
        render(xs_completed, &run.oracle_result, &run.oracle_error),
    )
}

/// Whose answer a table's rows give.
#[derive(Clone, Copy, PartialEq)]
enum Follows {
    V8,
    Neither,
    Xs,
}

fn check(rows: &[Row], follows: Follows) {
    let mut bad = Vec::new();
    for row in rows {
        let filed = match follows {
            Follows::V8 => row.ironhorse == row.v8 && row.ironhorse != row.xs,
            Follows::Neither => row.ironhorse != row.v8 && row.ironhorse != row.xs,
            Follows::Xs => row.ironhorse == row.xs && row.ironhorse != row.v8,
        };
        assert!(filed, "{}: misfiled", row.program);
        let run = dual_run(row.program).expect("the pinned XS oracle machine must start");
        let (ironhorse, xs) = answers(&run);
        if ironhorse != row.ironhorse || xs != row.xs {
            bad.push(format!(
                "  {}\n    ironhorse: {ironhorse:?} (recorded {:?})\n    xs:        {xs:?} (recorded {:?})\n    ({})",
                row.program, row.ironhorse, row.xs, row.why
            ));
        }
    }
    assert!(
        bad.is_empty(),
        "rows whose engines no longer answer as recorded:\n{}",
        bad.join("\n")
    );
}

#[test]
fn departures_still_depart() {
    check(DEPARTURES, Follows::V8);
}

#[test]
fn unpaired_departures_still_depart() {
    check(UNPAIRED, Follows::Neither);
}

#[test]
fn kept_xs_answers_still_agree() {
    check(KEPT, Follows::Xs);
}

#[test]
fn shared_gaps_still_match_xs() {
    check(SHARED, Follows::Xs);
}
