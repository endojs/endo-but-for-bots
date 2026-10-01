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
//! moves the row to [`DEPARTURES`]. Each row of [`GAPS`] is a program whose
//! answer Ironhorse gets wrong where XS gets it right: a bug found and left
//! for a follow-up, recorded so that fixing it fails the row.
//!
//! Every table runs on both engines with [`dual_run`], so they are a ratchet:
//! when a pin bump changes XS's answer, or Ironhorse's changes, the row
//! fails, and the record is updated in the same change. V8 is not run here.
//!
//! An answer is the program's completion value as `String()` renders it,
//! `throw ` and the thrown value's rendering, or, for an Ironhorse halt that
//! is not a throw, `halt ` and the halt.

use ironhorse_262::{dual_run, Agreement, DualRun};
use ironhorse_vm::Halt;

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
    Row {
        program: "var m = [1, 2].values().map(function (x) { return x; }); var a = m.next(); var b = m.next(); var d = Object.getOwnPropertyDescriptor(a, 'value'); [a === b, d.writable, d.configurable].join()",
        ironhorse: "false,true,true",
        xs: "true,false,false",
        v8: "false,true,true",
        why: "an Iterator helper's `next` creates a fresh result each step (CreateIteratorResultObject); XS reuses one with read-only fields",
    },
    Row {
        program: "var log = []; var NT = new Proxy(function () {}, { get: function (t, k, r) { if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); } }); Reflect.construct(Date, [{ valueOf: function () { log.push('y'); return 2000; } }, { valueOf: function () { log.push('m'); return 1; } }], NT); log.join()",
        ironhorse: "y,m,P",
        xs: "P,y,m",
        v8: "y,m,P",
        why: "the Date constructor converts all of its arguments before OrdinaryCreateFromConstructor reads newTarget.prototype (ES2024 21.4.2.1); XS reads the prototype first",
    },
    Row {
        program: "String(9007199254740993)",
        ironhorse: "9007199254740992",
        xs: "9007199254740994",
        v8: "9007199254740992",
        why: "a numeric literal exactly halfway between two doubles rounds to the even one (RoundMVResult); XS rounds it up",
    },
    Row {
        program: "class C { static #p = 3; static f = eval('C.#p'); } C.f",
        ironhorse: "3",
        xs: "throw ReferenceError: get C: not initialized yet",
        v8: "3",
        why: "a static field's direct eval can read the class's private static, the class binding being initialized by then",
    },
    Row {
        program: "var a = null; `${a?.b()?.()}-${a?.c()?.()}`",
        ironhorse: "undefined-undefined",
        xs: "undefinedundefined",
        v8: "undefined-undefined",
        why: "a template keeps every literal piece around a substitution whose optional chain short-circuits; XS drops one",
    },
    Row {
        program: "var a = null; var s = 'x'; s += a?.b()?.(); s",
        ironhorse: "xundefined",
        xs: "x",
        v8: "xundefined",
        why: "`s += a?.b()?.()` appends the short-circuited `undefined`; XS loses the value",
    },
    Row {
        program: "class B {} Object.defineProperty(B.prototype, 0, { value: 'ro', writable: false }); class D extends B { m() { 'use strict'; try { super[0] = 1; return 'ok'; } catch (e) { return e.name; } } } var d = new D(); [d.m(), d.hasOwnProperty(0)].join()",
        ironhorse: "TypeError,false",
        xs: "ok,true",
        v8: "TypeError,false",
        why: "a strict `super[0] = v` over an inherited read-only index throws and creates nothing (OrdinarySet); XS defines an own property",
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
    Row {
        program: "var u = new Uint8Array(0); u.constructor = { [Symbol.species]: BigInt64Array }; try { u.map(function (x) { return x; }); 'ok' } catch (e) { e.constructor.name }",
        ironhorse: "TypeError",
        xs: "ok",
        v8: "ok",
        why: "TypedArraySpeciesCreate refuses a species of the other content type, BigInt against Number, even for an empty result; XS and V8 skip the check",
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
    Row {
        program: "function f() { var x = 1; return eval(...['x']); } f()",
        ironhorse: "1",
        xs: "1",
        v8: "throw ReferenceError: x is not defined",
        why: "a call `eval(...args)` is a direct eval when it names %eval% (the spec's direct-eval test is on the callee, not the argument list); V8 treats a spread call as indirect",
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
    Row {
        program: "function f() { var x = 1; try { return (eval)('x'); } catch (e) { return e.constructor.name; } } f()",
        ironhorse: "ReferenceError",
        xs: "ReferenceError",
        v8: "1",
        why: "`(eval)(s)` is still a direct eval: the parentheses keep the Reference to `eval` (PerformEval through a direct call)",
    },
    Row {
        program: "Object.prototype.hasOwnProperty.call(async function () {}, 'caller')",
        ironhorse: "true",
        xs: "true",
        v8: "false",
        why: "an async function has no own `caller` (Forbidden Extensions, 17.1)",
    },
    Row {
        program: "var o = { b: 1 }; var r = delete o?.b; [r, 'b' in o].join()",
        ironhorse: "true,true",
        xs: "true,true",
        v8: "true,false",
        why: "`delete o?.b` deletes the property when `o` is not nullish",
    },
    Row {
        program: "var log = ''; Object.defineProperty(Array.prototype, 0, { set: function (v) { log += 's' + v; }, configurable: true }); var a = []; [...a[0]] = [5]; delete Array.prototype[0]; log",
        ironhorse: "s5s",
        xs: "s5s",
        v8: "s5",
        why: "a rest element's array is filled with CreateDataProperty, so an inherited index setter runs once, for the assignment to the target",
    },
];

/// Programs where Ironhorse's answer is wrong and XS's is the one to match:
/// gaps this branch found and left for follow-ups. XS's answer is the
/// specification's unless a row says otherwise, and V8 mostly agrees. A row
/// fails once either engine's answer moves, so closing a gap moves its row to
/// a passing test or to another table. A halt is recorded as `halt` and its
/// [`Halt`] label: these are guest-reachable `NotImplemented` halts.
const GAPS: &[Row] = &[
    Row {
        program: "class A { m() {} get g() { return 1; } static s() {} } [A.prototype.m.name, Object.getOwnPropertyDescriptor(A.prototype, 'g').get.name, A.s.name, ({ b() {} }).b.name].join()",
        ironhorse: ",,,",
        xs: "m,get g,s,b",
        v8: "m,get g,s,b",
        why: "a method's, accessor's or static method's `name` is its property key, `get `/`set ` prefixed for an accessor (SetFunctionName); Ironhorse names every method the empty string",
    },
    Row {
        program: "[Array.prototype.join.name, Array.prototype.join.length, Math.max.name, Math.max.length].join()",
        ironhorse: ",0,,0",
        xs: "join,1,max,2",
        v8: "join,1,max,2",
        why: "a built-in function's `name` and `length` are its specified name and parameter count; Ironhorse gives many the empty string and 0",
    },
    Row {
        program: "Object.getOwnPropertyNames(Map.prototype).join('+')",
        ironhorse: "set+size+constructor+get+has+delete+forEach+entries+keys+values+clear+getOrInsert+getOrInsertComputed",
        xs: "size+clear+delete+entries+forEach+get+has+keys+set+values+getOrInsert+getOrInsertComputed+constructor",
        v8: "constructor+get+set+has+delete+clear+entries+forEach+keys+size+values",
        why: "Ironhorse lists a built-in prototype's members in its boot roster's order rather than the order XS creates them (V8 has its own order)",
    },
    Row {
        program: "var q = { clear: 1 }; Object.getOwnPropertyNames(Map.prototype).join('+')",
        ironhorse: "set+clear+size+constructor+get+has+delete+forEach+entries+keys+values+getOrInsert+getOrInsertComputed",
        xs: "size+clear+delete+entries+forEach+get+has+keys+set+values+getOrInsert+getOrInsertComputed+constructor",
        v8: "constructor+get+set+has+delete+clear+entries+forEach+keys+size+values",
        why: "the members a program's text names (here `clear`) are linked before the rest, so the reflected order of a built-in prototype depends on unrelated identifiers in the program",
    },
    Row {
        program: "Function.prototype.bind.call(new Proxy(function () {}, {}), null).name",
        ironhorse: "halt NotImplemented(\"bind:non-user-function-receiver\")",
        xs: "bound ",
        v8: "bound ",
        why: "Function.prototype.bind accepts any callable receiver; on a Proxy Ironhorse halts",
    },
    Row {
        program: "new ArrayBuffer(8, { maxByteLength: 16 }).resizable",
        ironhorse: "halt NotImplemented(\"native-call:ArrayBuffer:resizable\")",
        xs: "true",
        v8: "true",
        why: "resizable ArrayBuffers (ES2024 25.1.3.1); Ironhorse halts on a maxByteLength",
    },
    Row {
        program: "new ArrayBuffer(4, {}).resizable",
        ironhorse: "halt NotImplemented(\"native-call:ArrayBuffer:resizable\")",
        xs: "false",
        v8: "false",
        why: "an options object without maxByteLength makes a fixed-length buffer; Ironhorse halts on any options object",
    },
    Row {
        program: "new SharedArrayBuffer(8, { maxByteLength: 16 }).growable",
        ironhorse: "halt NotImplemented(\"native-call:SharedArrayBuffer:growable\")",
        xs: "true",
        v8: "true",
        why: "growable SharedArrayBuffers (ES2024 25.2.3.1); Ironhorse halts on a maxByteLength",
    },
    Row {
        program: "(1.5).toString(2)",
        ironhorse: "halt NotImplemented(\"Number.toString:fractional-non-decimal-radix\")",
        xs: "1.1",
        v8: "1.1",
        why: "Number.prototype.toString with a radix other than 10 renders a fraction; Ironhorse halts",
    },
    Row {
        program: "(1e21).toString(36)",
        ironhorse: "halt NotImplemented(\"Number.toString:fractional-non-decimal-radix\")",
        xs: "5v1j4f4ds7c000",
        v8: "5v1j4f4ds7c000",
        why: "Number.prototype.toString with a radix other than 10 renders an integer above 2**53; Ironhorse halts",
    },
    Row {
        program: "Atomics.add(new Int32Array(1), '0', 2)",
        ironhorse: "halt NotImplemented(\"atomics:access-index\")",
        xs: "0",
        v8: "0",
        why: "Atomics operations convert their index with ToIndex; Ironhorse halts on a non-number index",
    },
    Row {
        program: "var t = new Int32Array(1); Atomics.store(t, 0, '7'); t[0]",
        ironhorse: "halt NotImplemented(\"atomics:coerce\")",
        xs: "7",
        v8: "7",
        why: "Atomics operations convert their value with ToIntegerOrInfinity; Ironhorse halts on a non-number value",
    },
    Row {
        program: "var w = new WeakMap(); try { for (var x of w); 'iterated' } catch (e) { e.constructor.name }",
        ironhorse: "halt NotImplemented(\"for_of:weak-collection\")",
        xs: "TypeError",
        v8: "TypeError",
        why: "a WeakMap is not iterable, so for-of throws a TypeError; Ironhorse halts",
    },
    Row {
        program: "typeof Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags')",
        ironhorse: "undefined",
        xs: "object",
        v8: "object",
        why: "%RegExp.prototype% has the flag accessors (`flags`, `global`, `source`, ...); Ironhorse has none",
    },
    Row {
        program: "[RegExp.prototype.source, RegExp.prototype.flags, RegExp.prototype.toString()].join(' ')",
        ironhorse: "  /undefined/undefined",
        xs: "(?:)  /(?:)/",
        v8: "(?:)  /(?:)/",
        why: "on %RegExp.prototype% the flag accessors answer `(?:)` and the empty string, so toString renders `/(?:)/`",
    },
    Row {
        program: "Object.getPrototypeOf(TypeError) === Error",
        ironhorse: "false",
        xs: "true",
        v8: "true",
        why: "each NativeError constructor's [[Prototype]] is %Error%",
    },
    Row {
        program: "Object.prototype.toString.call(globalThis)",
        ironhorse: "[object Object]",
        xs: "[object global]",
        v8: "[object global]",
        why: "XS's global object carries the @@toStringTag `global`, as V8's does",
    },
    Row {
        program: "var ts = Object.prototype.toString; [Object.getPrototypeOf(''[Symbol.iterator]()) === Object.getPrototypeOf([][Symbol.iterator]()), ts.call([][Symbol.iterator]()), ts.call(''[Symbol.iterator]())].join()",
        ironhorse: "true,[object Iterator],[object Iterator]",
        xs: "false,[object Array Iterator],[object String Iterator]",
        v8: "false,[object Array Iterator],[object String Iterator]",
        why: "%StringIteratorPrototype% is its own object, tagged `String Iterator`, and %ArrayIteratorPrototype% is tagged `Array Iterator`; Ironhorse shares one untagged prototype",
    },
    Row {
        program: "typeof WeakRef + ' ' + typeof FinalizationRegistry",
        ironhorse: "undefined undefined",
        xs: "function function",
        v8: "function function",
        why: "WeakRef and FinalizationRegistry are absent from Ironhorse's realm",
    },
    Row {
        program: "var log = []; Object.defineProperty(Number.prototype, 'z', { set: function (v) { log.push(typeof this); }, configurable: true }); (5).z = 1; delete Number.prototype.z; log.join()",
        ironhorse: "",
        xs: "object",
        v8: "object",
        why: "a write to a primitive's property runs an inherited setter, with the primitive boxed in sloppy code; Ironhorse never calls it",
    },
    Row {
        program: "'use strict'; try { (5).y = 1; 'wrote' } catch (e) { e.constructor.name }",
        ironhorse: "wrote",
        xs: "TypeError",
        v8: "TypeError",
        why: "in strict code a write to a primitive's own-less property throws a TypeError (OrdinarySet on a non-object receiver); Ironhorse ignores it",
    },
    Row {
        program: "var s = new SharedArrayBuffer(4); [Object.getPrototypeOf(s) === SharedArrayBuffer.prototype, s instanceof SharedArrayBuffer, Reflect.ownKeys(SharedArrayBuffer.prototype).map(String).join('+')].join()",
        ironhorse: "false,false,constructor+Symbol(Symbol.toStringTag)",
        xs: "true,true,byteLength+growable+maxByteLength+grow+slice+constructor+Symbol(Symbol.toStringTag)",
        v8: "true,true,constructor+byteLength+slice+maxByteLength+growable+grow+Symbol(Symbol.toStringTag)",
        why: "a SharedArrayBuffer inherits %SharedArrayBuffer.prototype%, which has byteLength, growable, maxByteLength, grow and slice; Ironhorse builds it on %ArrayBuffer.prototype% and leaves the prototype bare",
    },
    Row {
        program: "var r = Proxy.revocable(() => 1, {}); r.revoke(); try { new r.proxy(); 'constructed' } catch (e) { e.message }",
        ironhorse: "(proxy).construct: no handler",
        xs: "new: proxy is not a constructor",
        v8: "r.proxy is not a constructor",
        why: "a Proxy keeps [[Construct]] from its target through revocation; Ironhorse drops the target on revocation and throws the revocation error",
    },
];

/// The engine's answer, as the rows spell it: the completion value, `throw`
/// and the thrown value, or, for Ironhorse, `halt` and any other halt.
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
    let ironhorse = match &run.ironhorse_halt {
        Halt::Return | Halt::Throw { .. } => render(
            ironhorse_completed,
            &run.ironhorse_result,
            &run.ironhorse_error,
        ),
        halt => format!("halt {halt:?}"),
    };
    (
        ironhorse,
        render(xs_completed, &run.oracle_result, &run.oracle_error),
    )
}

/// Whose answer a table's rows give.
#[derive(Clone, Copy, PartialEq)]
enum Follows {
    V8,
    Neither,
    Xs,
    /// Ironhorse's answer is wrong: it differs from XS's.
    Gap,
}

fn check(rows: &[Row], follows: Follows) {
    let mut bad = Vec::new();
    for row in rows {
        let filed = match follows {
            Follows::V8 => row.ironhorse == row.v8 && row.ironhorse != row.xs,
            Follows::Neither => row.ironhorse != row.v8 && row.ironhorse != row.xs,
            Follows::Xs => row.ironhorse == row.xs && row.ironhorse != row.v8,
            Follows::Gap => row.ironhorse != row.xs,
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

#[test]
fn gaps_are_still_open() {
    check(GAPS, Follows::Gap);
}
