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
    Row {
        program: "var s = new SharedArrayBuffer(8, { maxByteLength: 16 }); s.grow(12); [s.byteLength, s.maxByteLength].join()",
        ironhorse: "12,16",
        xs: "throw RangeError: cannot grow SharedArrayBuffer instance",
        v8: "12,16",
        why: "SharedArrayBuffer.prototype.grow grows a growable buffer up to its maximum (ES2024 25.2.5.3); XS checks the range, then always throws",
    },
    Row {
        program: "var log = []; try { new ArrayBuffer(4).resize({ valueOf: function () { log.push('valueOf'); return 1; } }); } catch (e) { log.push(e.constructor.name); } log.join()",
        ironhorse: "TypeError",
        xs: "valueOf,TypeError",
        v8: "TypeError",
        why: "ArrayBuffer.prototype.resize requires [[ArrayBufferMaxByteLength]] before it converts newLength (ES2024 25.1.6.6 steps 2-4); XS converts first",
    },
    Row {
        program: "var r; try { r = new ArrayBuffer(4, { maxByteLength: 8 }).transfer(12).byteLength; } catch (e) { r = e.constructor.name; } r",
        ironhorse: "RangeError",
        xs: "12",
        v8: "RangeError",
        why: "transfer keeps a resizable buffer's maximum, so AllocateArrayBuffer refuses a new length above it (ArrayBufferCopyAndDetach); XS makes a buffer longer than its maximum",
    },
    Row {
        program: "var b = new ArrayBuffer(8, { maxByteLength: 8 }); new Uint8Array(b).set([1,2,3,4,5,6,7,8]); var C = function (n) { b.resize(3); return new ArrayBuffer(n); }; C[Symbol.species] = C; b.constructor = C; var r; try { r = new Uint8Array(b.slice(1, 6)).join(''); } catch (e) { r = e.constructor.name + ': ' + e.message; } r",
        ironhorse: "23000",
        xs: "TypeError: resized this",
        v8: "23000",
        why: "ArrayBuffer.prototype.slice copies the bytes a species constructor that shrank the source left in range (ES2024 25.1.6.7 steps 26-27); XS throws",
    },
    Row {
        program: "var log = []; var p = new Proxy({ c: 1 }, { defineProperty(t, k, d) { log.push(Object.keys(d).join('+')); return Reflect.defineProperty(t, k, d); } }); p.c = 2; log.join()",
        ironhorse: "value",
        xs: "value+writable+enumerable+configurable",
        v8: "value",
        why: "[[Set]] on an existing data property defines `{ [[Value]]: V }` on the receiver (OrdinarySetWithOwnDescriptor step 2.d.iv), and the trap receives FromPropertyDescriptor of it; XS completes the descriptor",
    },
    Row {
        program: "var log = []; var p = new Proxy({}, { defineProperty(t, k, d) { log.push(Object.keys(d).join('+')); return Reflect.defineProperty(t, k, d); } }); Object.defineProperty(p, 'g', { get() {}, enumerable: true }); log.join()",
        ironhorse: "get+enumerable",
        xs: "get+set+enumerable",
        v8: "get+enumerable",
        why: "a Proxy's `defineProperty` trap receives FromPropertyDescriptor of the descriptor, only the fields present (ES2024 10.5.6 step 7); XS adds an absent `set`",
    },
    Row {
        program: "var t = { get a() { return 42; } }; var p = new Proxy(t, { defineProperty(t, k, d) { return Reflect.defineProperty(t, k, d); } }); Reflect.defineProperty(p, 'a', { set: undefined }); typeof Object.getOwnPropertyDescriptor(t, 'a').get",
        ironhorse: "function",
        xs: "undefined",
        v8: "function",
        why: "the same rule through a forwarding trap: `{ set: undefined }` leaves the getter; XS's added `get: undefined` removes it",
    },
    Row {
        program: "class C { set #a(v) {} static has(o) { return #a in o; } } C.has(new C())",
        ironhorse: "true",
        xs: "false",
        v8: "true",
        why: "`#a in o` asks PrivateElementFind, which finds a setter-only accessor (ES2024 13.10.1); XS looks the element up as a read",
    },
    Row {
        program: "(function f() { try { (function () { 'use strict'; f = 1; })(); return 'ignored ' + typeof f; } catch (e) { return e.constructor.name; } })()",
        ironhorse: "TypeError",
        xs: "ignored function",
        v8: "TypeError",
        why: "a function expression's own name is an immutable binding, and a STRICT write to it throws (SetMutableBinding, ES2024 9.1.1.1.5 step 4); XS ignores every write once the sloppy function marked the binding",
    },
    Row {
        program: "var proto = {}; Object.defineProperty(proto, 'y', { value: 0, writable: false }); var o = { __proto__: proto, m() { super.y = 1; return 'ok ' + this.y + ' ' + this.hasOwnProperty('y'); } }; o.m()",
        ironhorse: "ok 0 false",
        xs: "ok 1 true",
        v8: "ok 0 false",
        why: "a sloppy `super.y = v` over an inherited read-only `y` is refused silently and creates nothing (OrdinarySet step 2.a); XS defines an own property",
    },
    Row {
        program: "const c = 1; var r = []; for (var w of [function () { [c] = [2]; }, function () { ({ c } = { c: 2 }); }, function () { for (c of [2]); }]) { try { w(); r.push('wrote ' + c); } catch (e) { r.push(e.constructor.name); } } r.join()",
        ironhorse: "TypeError,TypeError,TypeError",
        xs: "wrote 1,wrote 1,wrote 1",
        v8: "TypeError,TypeError,TypeError",
        why: "a destructuring or for-of write to a `const` is a TypeError like `c = 2` (SetMutableBinding on an immutable binding with S true, ES2024 9.1.1.1.5 step 4); XS discards it silently",
    },
    Row {
        program: "'use strict'; var o = { m() { delete super.x; } }; try { o.m.call(undefined); 'ok' } catch (e) { e.constructor.name }",
        ironhorse: "ReferenceError",
        xs: "TypeError",
        v8: "ReferenceError",
        why: "`delete super.x` throws a ReferenceError (ES2024 13.5.1.2 step 4); a super reference never converts `this` to an object, which is where XS throws",
    },
    Row {
        program: "Atomics.isLockFree(2 ** 32 + 4)",
        ironhorse: "false",
        xs: "true",
        v8: "false",
        why: "Atomics.isLockFree takes ToIntegerOrInfinity of its size (ES2024 25.4.6); XS wraps it to 32 bits first",
    },
    Row {
        program: "var A = Object.getPrototypeOf(async function () {}).constructor; [async function () {}, A('return 1')].map(function (f) { return Object.getOwnPropertyNames(f).join('+'); }).join()",
        ironhorse: "length+name,length+name",
        xs: "length+name+caller,length+name+caller",
        v8: "length+name,length+name",
        why: "an async function has no own `caller` (Forbidden Extensions, ES2024 17.1); XS's compiler defines one on every sloppy plain function, and Ironhorse keeps XS's bytes but drops that define",
    },
    Row {
        program: "var o = { b: { c: 1 }, d: 1, e: 1 }; var r = [delete o?.b.c, delete o?.['d'], delete (o?.e), 'c' in o.b, 'd' in o, 'e' in o]; var f = Object.freeze({ b: 1 }); r.push(delete f?.b); r.join()",
        ironhorse: "true,true,true,false,false,false,false",
        xs: "true,true,true,true,true,true,true",
        v8: "true,true,true,false,false,false,false",
        why: "`delete o?.b` deletes the Reference the optional chain produces (ES2024 13.5.1.2), refused on a frozen object; XS's compiler codes the chain as a value and answers `true` without deleting",
    },
    Row {
        program: "'use strict'; var f = Object.freeze({ b: 1 }); try { delete f?.b; 'deleted' } catch (e) { e.constructor.name }",
        ironhorse: "TypeError",
        xs: "deleted",
        v8: "TypeError",
        why: "a strict `delete o?.b` that the object refuses throws (ES2024 13.5.1.2 step 4.e)",
    },
    Row {
        program: "function f() { var x = 1; var r = []; try { r.push((eval)('x')); } catch (e) { r.push(e.constructor.name); } try { r.push((0, eval)('x')); } catch (e) { r.push(e.constructor.name); } return r.join(); } f()",
        ironhorse: "1,ReferenceError",
        xs: "ReferenceError,ReferenceError",
        v8: "1,ReferenceError",
        why: "`(eval)(s)` is a direct eval: the parentheses keep the Reference to `eval` (ES2024 13.3.6.1, 13.2.9.2); XS calls it indirectly",
    },
    Row {
        program: "var log = ''; Object.defineProperty(Array.prototype, 0, { set: function (v) { log += 's' + v; }, configurable: true }); var a = []; [...a[0]] = [5]; var [...t] = [5, 6]; var r = [7, ...[8]]; delete Array.prototype[0]; [log, t.length, r.hasOwnProperty(0), r.join()].join('|')",
        ironhorse: "s5|2|true|7,8",
        xs: "s5ss5s6s7|0|false|,8",
        v8: "s5|2|true|7,8",
        why: "a rest element's array and a spread array literal are filled with CreateDataProperty (ES2024 8.6.3, 13.2.4.1), so an inherited index setter runs only for the assignment to the target; XS fills them with [[Set]]",
    },
    Row {
        program: "'use strict'; var log = []; Object.defineProperty(Number.prototype, 'z', { set: function (v) { log.push(typeof this, v); }, configurable: true }); (5).z = 1; (5)['z'] = 2; log.join()",
        ironhorse: "number,1,number,2",
        xs: "object,1,object,2",
        v8: "number,1,number,2",
        why: "PutValue on a primitive base calls the wrapper's [[Set]] with the primitive itself as the receiver (ES2024 6.2.5.6 step 5.b), so a strict setter's `this` is the primitive; XS passes the wrapper object",
    },
    Row {
        program: "var log = []; Object.setPrototypeOf(Number.prototype, new Proxy({}, { set: function (t, k, v, r) { log.push(typeof r, k, v); return true; } })); (5).q = 1; (5)[7] = 2; log.join()",
        ironhorse: "number,q,1,number,7,2",
        xs: "object,q,1,object,7,2",
        v8: "number,q,1,number,7,2",
        why: "a Proxy `set` trap reached from a primitive base receives the primitive as its receiver (ES2024 6.2.5.6 step 5.b, 10.5.9 step 8); XS passes the wrapper object",
    },
    Row {
        program: "var log = []; Object.setPrototypeOf(Number.prototype, new Proxy({}, { get: function (t, k, r) { log.push(typeof r, String(k)); } })); (5).q; (5)[7]; log.join()",
        ironhorse: "number,q,number,7",
        xs: "object,q,object,7",
        v8: "number,q,number,7",
        why: "a Proxy `get` trap reached from a primitive base receives the primitive as its receiver (ES2024 6.2.5.5 step 3.b, 10.5.8 step 8); XS passes the wrapper object",
    },
    Row {
        program: "'use strict'; var log = []; class A { m(k) { super[k] = 7; } n() { super.s = 8; } } Object.defineProperty(Object.prototype, 's', { set(v) { log.push(typeof this + v); }, configurable: true }); [5, 'ab', true, Symbol(), 5n].forEach(function (p) { A.prototype.m.call(p, 's'); A.prototype.n.call(p); }); log.join()",
        ironhorse: "number7,number8,string7,string8,boolean7,boolean8,symbol7,symbol8,bigint7,bigint8",
        xs: "object7,object8,object7,object8,object7,object8,object7,object8,object7,object8",
        v8: "number7,number8,string7,string8,boolean7,boolean8,symbol7,symbol8,bigint7,bigint8",
        why: "a super reference keeps a strict method's primitive `this` as its receiver (ES2024 13.3.7.3 MakeSuperPropertyReference), so an inherited setter's `this` is the primitive; XS converts `this` to an object",
    },
    Row {
        program: "'use strict'; class A { m() { return super.g; } n(k) { return super[k]; } } Object.defineProperty(Object.prototype, 'g', { get() { return String(this); }, configurable: true }); var r; try { r = [A.prototype.m.call(undefined), A.prototype.n.call(null, 'g')].join(); } catch (e) { r = String(e) } r",
        ironhorse: "undefined,null",
        xs: "TypeError: cannot coerce undefined to object",
        v8: "undefined,null",
        why: "a super reference reads from the home object's prototype with `this` as the receiver, whatever its type (ES2024 13.3.7.3, 6.2.5.5); XS converts `this` to an object, which throws for undefined and null",
    },
    Row {
        program: "[({ f: class { static { delete this.name; } } }).f.name, typeof ({ g: class { static { delete this.name; } } }).g.name].join('|')",
        ironhorse: "|string",
        xs: "f|string",
        v8: "|string",
        why: "a class value is named before its static elements run (ClassDefinitionEvaluation's SetFunctionName, ES2024 15.7.14), so a name a static block deleted stays deleted; XS names the class when its property is defined, after the block",
    },
    Row {
        program: "RegExp.prototype.compile.length",
        ironhorse: "2",
        xs: "0",
        v8: "2",
        why: "Annex B's RegExp.prototype.compile takes (pattern, flags), so its length is 2 (B.2.4.1)",
    },
    Row {
        program: "var hp = Object.getPrototypeOf([].values().map(function (x) { return x; })); var wp = Object.getPrototypeOf(Iterator.from({ next: function () {} })); [hp.next.length, hp.return.length, wp.next.length, wp.return.length].join()",
        ironhorse: "0,0,0,0",
        xs: "1,1,1,1",
        v8: "0,0,0,0",
        why: "%IteratorHelperPrototype% and %WrapForValidIteratorPrototype%'s `next` and `return` take no arguments, so their length is 0 (ES2025 27.1.2.1, 27.1.3.2.1)",
    },
    Row {
        program: "var log = []; var o = { length: 2 ** 53 - 1 }; o[2 ** 53 - 2] = 'a'; o[2 ** 53 - 4] = 'b'; try { Array.prototype.reduceRight.call(o, function (acc, v, i) { log.push(v + i); if (v === 'b') throw 0; return acc; }, 0); } catch (e) {} log.join()",
        ironhorse: "a9007199254740990,b9007199254740988",
        xs: "",
        v8: "a9007199254740990,b9007199254740988",
        why: "LengthOfArrayLike admits a length up to 2^53 - 1, so reduceRight folds from just below it; XS's fxGetArrayLimit (also behind reduce, forEach, some, every, filter, find, findIndex, join, toLocaleString and %ArrayIteratorPrototype%.next) replaces a length above 2^32 - 1 with its resident index storage's, which holds no index that large, so XS folds nothing (test262 reduceRight/length-near-integer-limit.js)",
    },
    Row {
        program: "Array.prototype.reduce.call(new Proxy({ length: 2 ** 32, 0: 'a', 1: 'b' }, {}), function (acc, v, i) { if (i === 1) throw acc + v; return acc + v; }, '')",
        ironhorse: "throw ab",
        xs: "",
        v8: "throw ab",
        why: "as above, for reduce over a Proxy, which has no resident index storage, so XS reads its length as 0",
    },
    Row {
        program: "['abcdef'.substr(1, Infinity), 'abcdef'.substr(1, 2147483647), 'abcdef'.substr(0, Infinity), 'abcdef'.substr(1, 4294967297)].join()",
        ironhorse: "bcdef,bcdef,abcdef,bcdef",
        xs: ",,,b",
        v8: "bcdef,bcdef,abcdef,bcdef",
        why: "String.prototype.substr clamps the length to what remains of the string (B.2.2.1); XS's fx_String_prototype_substr converts it with fxToInteger, which wraps it modulo 2**32 into a 32-bit int (+Infinity becomes 0 and 4294967297 becomes 1), and adds it to the start in a 32-bit int, which overflows for 2**31 - 1",
    },
    Row {
        program: "var d = new Date(2000, 0, 15); d.setYear(99, 5, 3); [d.getFullYear(), d.getMonth(), d.getDate()].join()",
        ironhorse: "1999,0,15",
        xs: "1999,5,3",
        v8: "1999,0,15",
        why: "Date.prototype.setYear reads only its year (B.2.3.2); XS's fx_Date_prototype_setYear also takes a month and a date, as setFullYear does",
    },
    Row {
        program: "var a = new Date(NaN), b = new Date(NaN); var bad = {valueOf: function () { throw 1; }}; try { a.setYear(bad); } catch (e) {} try { b.setFullYear(bad); } catch (e) {} [a.getTime(), b.getTime()].join()",
        ironhorse: "NaN,NaN",
        xs: "0,0",
        v8: "NaN,NaN",
        why: "Date.prototype.setYear and setFullYear convert their arguments before they change the date (B.2.3.2, ES2024 21.4.4.21); XS sets an invalid date to +0 first, which a conversion that throws leaves behind",
    },
    Row {
        program: "[new Date(0).setYear(4294967346), Date.UTC(4294967346, 0), new Date(4294967346, 0).getTime()].join()",
        ironhorse: "NaN,NaN,NaN",
        xs: "-631152000000,-631152000000,-631152000000",
        v8: "NaN,NaN,NaN",
        why: "Date.prototype.setYear, Date.UTC and the Date constructor take the year through ToIntegerOrInfinity, so 2**32 + 50 is outside TimeClip's range (B.2.3.2, ES2024 21.4.3.4, 21.4.2.1); XS's fxDateFullYear, which all three call, converts it with fxToInteger, which wraps it modulo 2**32 to 50, and maps that to 1950",
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
    Row {
        program: "[String(new DisposableStack()), String(new AsyncDisposableStack()), Object.prototype.hasOwnProperty.call(DisposableStack.prototype, 'toString'), Object.prototype.hasOwnProperty.call(AsyncDisposableStack.prototype, 'toString')].join('|')",
        ironhorse: "[object DisposableStack]|[object AsyncDisposableStack]|false|false",
        xs: "Error|Error|true|true",
        v8: "throw ReferenceError: DisposableStack is not defined",
        why: "the specification gives DisposableStack.prototype and AsyncDisposableStack.prototype no toString, so a stack stringifies by its @@toStringTag; XS gives each prototype its own toString answering \"Error\"; Node 22 has neither constructor",
    },
    Row {
        program: "var t = new Uint8Array(new SharedArrayBuffer(4, { maxByteLength: 8 })); Reflect.preventExtensions(t)",
        ironhorse: "false",
        xs: "true",
        v8: "true",
        why: "a TypedArray that tracks a growable SharedArrayBuffer is not fixed-length, so [[PreventExtensions]] refuses (ES2024 10.4.5.2, IsTypedArrayFixedLength); XS refuses only over a resizable ArrayBuffer, and Node 22 predates the rule",
    },
    Row {
        program: "var rab = new ArrayBuffer(16, { maxByteLength: 32 }); var ta = new Int32Array(rab); try { Atomics.store(ta, 3, { valueOf() { rab.resize(4); return 1; } }); 'ok' } catch (e) { e.constructor.name }",
        ironhorse: "RangeError",
        xs: "ok",
        v8: "TypeError",
        why: "RevalidateAtomicAccess throws a RangeError when an operand's coercion shrinks the buffer below the accessed element; XS writes past the buffer's new length, and Node 22 throws a TypeError",
    },
    Row {
        program: "var log = []; function C(ex) { ex(function (v) { log.push('res' + v); throw new Error('boom'); }, function (e) { log.push('rej' + e); }); } var out; try { Promise.try.call(C, function () { return 1; }); out = 'returned'; } catch (e) { out = 'threw ' + e.message; } out + '|' + log.join()",
        ironhorse: "threw boom|res1",
        xs: "returned|res1,rejError: boom",
        v8: "threw Cannot read properties of undefined (reading 'call')|",
        why: "Promise.try lets a throw from the capability's resolve propagate (ES2025 27.2.4.8 step 6); XS's fx_Promise_try calls resolve inside its catch and rejects with what it threw; Node 22 has no Promise.try",
    },
    Row {
        program: "var z = 0.5 - 0.5; [Object.is(Math.sumPrecise([z]), 0), Object.is(Math.sumPrecise([0]), 0)].join()",
        ironhorse: "true,true",
        xs: "false,true",
        v8: "throw TypeError: Math.sumPrecise is not a function",
        why: "Math.sumPrecise of +0 is +0, only -0 items leave the sum -0 (ES2026 21.3.2.34); XS's fx_Math_sumPrecise skips a +0 stored as a double, because C's +0.0 != -0.0 is false, and answers -0; Node 22 has no Math.sumPrecise",
    },
    Row {
        program: "var t; Number.prototype[Symbol.iterator] = function () { 'use strict'; t = typeof this; return [1][Symbol.iterator](); }; var s = Math.sumPrecise(5); t + ',' + s",
        ironhorse: "number,1",
        xs: "object,1",
        v8: "throw TypeError: Math.sumPrecise is not a function",
        why: "Math.sumPrecise gets its iterator from the items value itself, so a primitive's @@iterator sees the primitive as this (ES2026 21.3.2.34 step 2, GetIterator); XS's fx_Math_sumPrecise converts the items to an object first; Node 22 has no Math.sumPrecise",
    },
];

const KEPT: &[Row] = &[
    Row {
        program: "var log = []; var o = { m() { try { return super[{ toString() { log.push('s'); return 'x'; } }]; } catch (e) { log.push(e.constructor.name); } } }; Object.setPrototypeOf(o, null); o.m(); log.join()",
        ironhorse: "TypeError",
        xs: "TypeError",
        v8: "s,TypeError",
        why: "GetValue on a super reference converts its base, here a null [[Prototype]], before its key (ES2024 6.2.5.5 step 3), so the key's toString never runs; V8 converts the key first",
    },
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
];

/// Programs where Ironhorse's answer is wrong and XS's is the one to match:
/// gaps this branch found and left for follow-ups. XS's answer is the
/// specification's unless a row says otherwise, and V8 mostly agrees. A row
/// fails once either engine's answer moves, so closing a gap moves its row to
/// a passing test or to another table. A halt is recorded as `halt` and its
/// [`Halt`] label: these are guest-reachable `NotImplemented` halts.
const GAPS: &[Row] = &[
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
        program: "[typeof Uint8Array.prototype.toSorted, typeof Uint8Array.prototype.toReversed, typeof Uint8Array.prototype.with].join()",
        ironhorse: "undefined,undefined,undefined",
        xs: "function,function,function",
        v8: "function,function,function",
        why: "%TypedArray.prototype% lacks ES2023's toSorted, toReversed and with",
    },
    Row {
        program: "var s = new SharedArrayBuffer(4); [Object.getPrototypeOf(s) === SharedArrayBuffer.prototype, s instanceof SharedArrayBuffer, Reflect.ownKeys(SharedArrayBuffer.prototype).map(String).join('+')].join()",
        ironhorse: "true,true,constructor+byteLength+growable+maxByteLength+grow+slice+Symbol(Symbol.toStringTag)",
        xs: "true,true,byteLength+growable+maxByteLength+grow+slice+constructor+Symbol(Symbol.toStringTag)",
        v8: "true,true,constructor+byteLength+slice+maxByteLength+growable+grow+Symbol(Symbol.toStringTag)",
        why: "%SharedArrayBuffer.prototype% lists its members before `constructor`, as XS creates them; Ironhorse lists `constructor` first (the boot-roster order of the Map.prototype rows; V8 has its own order)",
    },
    Row {
        program: "var r = Proxy.revocable(() => 1, {}); r.revoke(); try { new r.proxy(); 'constructed' } catch (e) { e.message }",
        ironhorse: "(proxy).construct: no handler",
        xs: "new: proxy is not a constructor",
        v8: "r.proxy is not a constructor",
        why: "a Proxy keeps [[Construct]] from its target through revocation; Ironhorse drops the target on revocation and throws the revocation error",
    },
    Row {
        program: "var n = 0; try { Array.prototype.findLast.call(new Proxy({ length: 2 ** 53 - 1 }, { get(t, k) { if (k === 'length') return t.length; if (++n === 70000) throw 'stop ' + String(k) } }), function () { return false }) } catch (e) { e.constructor.name + ' after ' + (n > 60000 && n < 70000) }",
        ironhorse: "RangeError after true",
        xs: "String after false",
        v8: "String after false",
        why: "a Proxy is handed each probed index as a key, and above 2^32 - 1 Ironhorse interns that key as a name, so the walk meets the key space's guest ceiling after about 64k steps and throws, and every later new name in the program throws too; findLastIndex, lastIndexOf and reduceRight over such a Proxy meet it the same way (XS answers reduceRight without walking, the departure above)",
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
