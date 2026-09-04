//! Behavioral gate for invoking **native / bound** callables through
//! `Function.prototype.{call,apply,bind}` — the `native-callables` milestone of
//! the Ironhorse JS completion arc (garden `ironhorse-js26-milestone-native-callables`).
//! Prior to this milestone a native receiver/callback (or a non-callable bind
//! target) self-named an honest skip; these cases route the native receiver
//! through the existing `call_native` / `call_native_method` machinery and
//! produce the correct observable result.
//!
//! Each snippet is dual-run against the XS differential oracle; the gate is
//! **result agreement where the oracle accepts the program** (`BothComplete` +
//! `result_agrees`) per the accuracy-over-parity doctrine — computron agreement
//! is advisory for these re-entrant native invocations.

use ironhorse_262::{dual_run, Agreement};

/// Assert a program completes on BOTH engines with the SAME completion value.
fn agrees(source: &str) {
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

fn agrees_exact(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert!(run.result_agrees, "{source}: {run:?}");
    assert!(
        run.computrons_agree,
        "{source}: oracle={} ({}) ironhorse={} ({})",
        run.oracle_computrons,
        run.oracle_meter_raw,
        run.ironhorse_computrons,
        run.ironhorse_meter_raw,
    );
}

#[test]
fn callable_proxy_dispatch_is_metered_at_each_call_layer() {
    for source in [
        "var p=new Proxy(function(a){return a+1},{});p.call(null,1)",
        "var p=new Proxy(function(a){return a+1},{});p.apply(null,[1])",
        "var p=new Proxy(function(a){return a+1},{});p(1)",
        "var p=new Proxy(new Proxy(function(a){return a+1},{}),{});p(1)",
        "var p=new Proxy(function(a){return a+1},{apply:function(t,s,a){return Reflect.apply(t,s,a)}});p.call(null,1)",
        "var p=new Proxy(function(a){return a+1},{apply:function(t,s,a){return Reflect.apply(t,s,a)}});p(1)",
        "var b=(function(a){return a+1}).bind(null),p=new Proxy(b,{});p(1)",
        "var p=new Proxy(Math.max,{});p(1,2)",
        "var p=new Proxy(Math.max,{});p.call(null,1,2)",
    ] {
        agrees_exact(source);
    }
}

// -------------------------------------------------------------------------
// §1  Function.prototype.apply over a native receiver (dense-array forwarding).
// -------------------------------------------------------------------------

#[test]
fn native_apply_forwards_dense_array() {
    // A native constructor/value function receiver spreads a dense array.
    agrees("Math.max.apply(null, [3, 1, 4, 1, 5, 9, 2, 6])");
    agrees("Math.min.apply(null, [3, 1, 4, 1, 5, 9, 2, 6])");
    // Empty / absent argument arrays are the zero-argument subset.
    agrees("Math.max.apply(null, [])");
    agrees("Math.max.apply(null)");
    agrees("Math.max.apply(null, undefined)");
    agrees("Math.max.apply(null, null)");
    // CreateListFromArrayLike also accepts ordinary objects and reads holes or
    // materialized accessors through the full property MOP.
    agrees("Math.max.apply(null, {length:3,0:2,1:9,2:4})");
    agrees("Math.max.apply(null, [,7])");
    agrees(
        "var log=[];var a=[];a.length=2;Object.defineProperty(a,'0',{get:function(){log.push(0);return 8}}); \
         Math.max.apply(null,a)+':'+log.join(',')",
    );
    agrees("(function(){return Math.max.apply(null,arguments)})(2,9,4)");
    agrees("(function(a){return (function(x){return x}).apply(null,arguments)})(1)");
    agrees("(function(){delete arguments[1];arguments.length=1;return Math.max.apply(null,arguments)})(3,9)");
    agrees("(function(){Object.defineProperty(arguments,'length',{get:function(){return 1}});return Math.max.apply(null,arguments)})(3,9)");
    agrees(
        "var log=[];var args=new Proxy({length:2,0:3,1:8},{get:function(t,k){log.push(k);return t[k]}}); \
         Math.max.apply(null,args)+':'+log.join(',')",
    );
}

#[test]
fn apply_array_like_reads_are_computron_exact() {
    for source in [
        "Math.max.apply(null,{length:2,0:3,1:8})",
        "Math.max.apply(null,[,8])",
        "(function(a,b){return a+b}).apply(null,{length:2,0:3,1:8})",
        "var f=(function(a,b){return a+b}).bind(null);f.apply(null,{length:2,0:3,1:8})",
        "(function(){return Math.max.apply(null,arguments)})(3,8)",
    ] {
        agrees_exact(source);
    }
}

#[test]
fn native_method_apply_over_receiver() {
    // A native *method* receiver (`String.prototype.concat`) applied with a
    // string `this` and a forwarded argument array.
    agrees("String.prototype.concat.apply('a', ['b', 'c', 'd'])");
    // `Array.prototype.join` applied to a real array receiver.
    agrees("Array.prototype.join.apply([1, 2, 3], ['-'])");
}

// -------------------------------------------------------------------------
// §2  Function.prototype.call over a native receiver.
// -------------------------------------------------------------------------

#[test]
fn native_call_over_receiver() {
    agrees("Math.max.call(null, 3, 1, 4, 1, 5)");
    agrees("String.prototype.concat.call('a', 'b', 'c')");
}

// -------------------------------------------------------------------------
// §3  Function.prototype.bind step 2 — non-callable target throws TypeError.
// -------------------------------------------------------------------------

#[test]
fn bind_non_callable_target_throws_type_error() {
    agrees(
        "var ok; try { Function.prototype.bind.call({}); ok = false; } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
    agrees(
        "var ok; try { Function.prototype.bind.call(undefined, {}); ok = false; } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
    agrees(
        "var ok; try { Function.prototype.bind.call(null, {}); ok = false; } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
    // A plain object with an inherited `.bind` is still a non-callable target.
    agrees(
        "function Foo() {} var f = new Foo(); f.bind = Function.prototype.bind; \
         var ok; try { f.bind(); ok = false; } catch (e) { ok = e instanceof TypeError; } ok",
    );
}

// -------------------------------------------------------------------------
// §4  `new` on `Function.prototype.{call,apply}` — not a constructor.
// -------------------------------------------------------------------------

#[test]
fn new_on_call_apply_throws_type_error() {
    agrees(
        "var ok; try { new Function.prototype.call(); ok = false; } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
    agrees(
        "var ok; try { new Function.prototype.apply(); ok = false; } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
}

#[test]
fn reflect_construct_rejects_every_non_constructor_function_shape() {
    agrees(
        "var n=0;var values=[()=>{},function*(){},async function(){},async function*(){},({m(){}}).m,(()=>{}).bind(null),new Proxy(()=>{},{})];\
         for(var v of values){try{Reflect.construct(v,[])}catch(e){n+=e instanceof TypeError}}n",
    );
}

// -------------------------------------------------------------------------
// §5  A **native callable** passed as an Array-method callback — routed
//     through `call_native` (previously `callback:non-user-function`).
// -------------------------------------------------------------------------

#[test]
fn native_callable_as_array_callback() {
    // `String`/`Number` as a mapper — the callback receives (value, index, O).
    agrees("[1, 2, 3].map(String).join(',')");
    agrees("['1', '2', '3'].map(Number).join(',')");
    // `Boolean` as a filter predicate.
    agrees("[0, 1, '', 'a', null, 2].filter(Boolean).join(',')");
    // The canonical `map(parseInt)` foot-gun: radix is the element index, so
    // parseInt('10',0)=10, parseInt('10',1)=NaN, parseInt('10',2)=2. This
    // exercises full (element, index, array) argument forwarding to the native.
    agrees("['10', '10', '10'].map(parseInt).join(',')");
    // `forEach` with a native callable (its completion is undefined).
    agrees("var n = 0; [1, 2, 3].forEach(String); typeof [1,2,3].forEach(String)");
    // `some`/`every` predicates over a native callable.
    agrees("[0, 0, 0].some(Boolean)");
    agrees("[1, 2, 3].every(Boolean)");
}

// -------------------------------------------------------------------------
// §6  `new` on a **bound** function — construct the ultimate target with the
//     bound args prepended and `new.target` resolved to the target.
// -------------------------------------------------------------------------

#[test]
fn new_on_bound_function_constructs_target() {
    // Bound leading args form the former part of the construct arguments.
    agrees(
        "var func = function (x, y, z) { this.v = x + y + z; this.ok = arguments.length === 3; }; \
         var NF = Function.prototype.bind.call(func, {}, 'a', 'b', 'c'); \
         var i = new NF(); i.v + '/' + i.ok",
    );
    // Call args form the latter part.
    agrees(
        "var func = function (x, y, z) { this.v = x + y + z; this.ok = arguments.length === 3; }; \
         var NF = Function.prototype.bind.call(func, {}); \
         var i = new NF('a', 'b', 'c'); i.v + '/' + i.ok",
    );
    // Mixed: bound + call args concatenate in order.
    agrees(
        "function P(a, b, c, d) { this.s = a + b + c + d; } \
         var B = P.bind(null, 1, 2); var p = new B(3, 4); p.s",
    );
    // The instance's prototype is the target's prototype (not the bound fn's).
    // (Compared against a plain `new A()` rather than the `A.prototype` own
    // property, which ironhorse does not yet materialize — a pre-existing gap
    // orthogonal to bound construction.)
    agrees(
        "function A() {} var B = A.bind(); var b = new B(); \
         Object.getPrototypeOf(b) === Object.getPrototypeOf(new A())",
    );
    agrees("function A() {} var B = A.bind(); (new B()) instanceof A");
    // new.target chains through bound-of-bound to the innermost target.
    agrees(
        "var nt; function A() { nt = new.target; } \
         var B = A.bind(); var C = B.bind(); var c = new C(); \
         (nt === A) && (c instanceof A)",
    );
    // A constructor that returns an object overrides the constructed `this`.
    agrees(
        "function F() { return { tag: 'override' }; } \
         var B = F.bind(); (new B()).tag",
    );
}

// -------------------------------------------------------------------------
// §7  Primitive `thisArg` boxing through `call`/`apply` — a sloppy callee
//     ToObject-boxes Number/Boolean; a strict callee keeps the primitive.
// -------------------------------------------------------------------------

#[test]
fn primitive_this_boxing_via_call_apply() {
    // Sloppy callee: every primitive `this` is boxed to its object wrapper.
    agrees("function f() { return typeof this; } f.call(5)");
    agrees("function f() { return typeof this; } f.call(true)");
    agrees("function f() { return typeof this; } f.call('abc')");
    agrees("function f() { return typeof this; } f.call(Symbol('s'))");
    agrees("function f() { return typeof this; } f.call(12n)");
    agrees("function f() { return typeof this; } f.apply(42, [])");
    agrees("function f() { return this[1] + ':' + this.length; } f.apply('abc', [])");
    // The wrapped primitive round-trips through `valueOf` / coercion.
    agrees("function f(x) { return this.valueOf() + x; } f.call(10, 5)");
    agrees("function f() { return this.valueOf(); } f.call('abc')");
    agrees("var s=Symbol('s');function f(){return this.valueOf()===s}f.call(s)");
    agrees("function f() { return this.valueOf() + 1n; } f.call(12n)");
    agrees("function f(a, b) { return typeof this + ':' + (a + b); } f.apply(5, [2, 3])");
    agrees("function f() { return this instanceof Number; } f.call(7)");
    agrees("function f() { return this instanceof Boolean; } f.call(false)");
    agrees("function f() { return this instanceof String; } f.call('abc')");
    agrees("function f() { return this instanceof Symbol; } f.call(Symbol())");
    agrees("function f() { return this instanceof BigInt; } f.call(1n)");
    agrees("String.prototype.f=function(){return this[0]+this[1]};'abc'.f()");
    agrees("Symbol.prototype.f=function(){return this.valueOf()};var s=Symbol('s');s.f()===s");
    agrees("BigInt.prototype.f=function(){return this.valueOf()+1n};12n.f()");
    agrees("function f(){return this[1]}Reflect.apply(f,'abc',[])");
    agrees("function f(){return this[1]}f.bind('abc')()");
    // Strict callee: the primitive `this` is kept as-is (no boxing).
    agrees("function f() { 'use strict'; return typeof this; } f.call(5)");
    agrees("function f() { 'use strict'; return this; } f.call(5)");
    agrees("function f() { 'use strict'; return typeof this; } f.apply(true, [])");
    agrees("function f(){'use strict';return typeof this}f.call('abc')");
    agrees("function f(){'use strict';return typeof this}f.call(Symbol())");
    agrees("function f(){'use strict';return typeof this}f.call(1n)");
    agrees("String.prototype.f=function(){'use strict';return typeof this};'a'.f()");
    // `undefined` / `null` `this` in a sloppy callee binds to the global.
    agrees("function f() { return this === globalThis; } f.call(undefined)");
    agrees("function f() { return this === globalThis; } f.call(null)");
}

// -------------------------------------------------------------------------
// §8  `apply` with a non-object argArray throws TypeError
//     (CreateListFromArrayLike step 2).
// -------------------------------------------------------------------------

#[test]
fn apply_non_object_arg_array_throws() {
    agrees(
        "function fn() {} var ok; \
         try { fn.apply(null, true); ok = false; } catch (e) { ok = e instanceof TypeError; } ok",
    );
    agrees(
        "function fn() {} var ok; \
         try { fn.apply(null, 42); ok = false; } catch (e) { ok = e instanceof TypeError; } ok",
    );
    agrees(
        "function fn() {} var ok; \
         try { fn.apply(null, 'str'); ok = false; } catch (e) { ok = e instanceof TypeError; } ok",
    );
    // undefined / null argArray remain the zero-argument subset (no throw).
    agrees("function fn() { return arguments.length; } fn.apply(null)");
    agrees("function fn() { return arguments.length; } fn.apply(null, undefined)");
    agrees("function fn() { return arguments.length; } fn.apply(null, null)");
}

// -------------------------------------------------------------------------
// §9  Calling a bound **native** function dispatches the native in place.
// -------------------------------------------------------------------------

#[test]
fn calling_bound_native_dispatches_native() {
    // `Number.bind(null)` / `Boolean.bind(null)` called (not constructed).
    agrees("var bnc = Number.bind(null); bnc(42)");
    agrees("var bbc = Boolean.bind(null); bbc(true)");
    agrees("var bsc = String.bind(null); bsc(99)");
    // A native prototype method bound to its receiver, then called.
    agrees("var p = [1, 2]; var push = Array.prototype.push.bind(p); push(3); p.join(',')");
    agrees("var mx = Math.max.bind(null, 3); mx(1, 9, 2)");
    // Bound leading args prepend to the call args for a native.
    agrees("var pi = parseInt.bind(null, '101'); pi(2)");
}

// -------------------------------------------------------------------------
// §10  `apply` with an **array-like** argArray (CreateListFromArrayLike):
//      read `length` then each index; propagate a getter's abrupt throw.
// -------------------------------------------------------------------------

#[test]
fn apply_array_like_arg_array() {
    // A plain array-like object forwards its indexed elements.
    agrees(
        "function f(a, b, c) { return a + b + c; } \
         f.apply(null, {length: 3, 0: 1, 1: 2, 2: 3})",
    );
    // `length` is ToLength-coerced; missing indices read `undefined`.
    agrees(
        "function f() { return arguments.length; } \
         f.apply(null, {length: 4, 0: 'x'})",
    );
    agrees(
        "function f() { return String(arguments[0]) + '/' + arguments.length; } \
         f.apply(null, {length: 2})",
    );
    agrees(
        "function f(a,b){return String(a)+':'+b}var args=[,2];f.apply(null,args)",
    );
    agrees(
        "function f(a){return a}var old=Array.prototype[0];Array.prototype[0]=6; \
         var args=new Array(1),r=f.apply(null,args); \
         old===undefined?delete Array.prototype[0]:Array.prototype[0]=old;r",
    );
    // The `arguments` object of another call forwards through apply.
    agrees(
        "function g() { return function () { return arguments[0] + arguments[1]; }.apply(null, arguments); } \
         g(4, 5)",
    );
    // An abrupt `length` getter propagates.
    agrees(
        "function f() {} var o = { get length() { throw new RangeError('L'); } }; \
         var ok; try { f.apply(null, o); ok = false; } catch (e) { ok = e instanceof RangeError; } ok",
    );
    // `length` applies the observable ToNumber/ToLength path before any index
    // read, including object coercion and the BigInt TypeError boundary.
    agrees(
        "var log=[];function f(x){return x}var o={get length(){log.push('g');return {valueOf(){log.push('v');return 1}}},0:7};f.apply(null,o)+':'+log.join('')",
    );
    agrees(
        "var ok=false;try{(function(){}).apply(null,{length:1n})}catch(e){ok=e instanceof TypeError}ok",
    );
    // An abrupt index getter propagates.
    agrees(
        "function f() {} var o = { length: 1, get 0() { throw new TypeError('I'); } }; \
         var ok; try { f.apply(null, o); ok = false; } catch (e) { ok = e instanceof TypeError; } ok",
    );
}

// -------------------------------------------------------------------------
// §11  BoundFunction exotic dispatch composes through every Call site.
// -------------------------------------------------------------------------

#[test]
fn bound_function_call_chains() {
    // The innermost binding supplies `this`; bound arguments accumulate from
    // the innermost function outward and precede ordinary call arguments.
    agrees(
        "function f(a,b,c){return this.x+':'+a+':'+b+':'+c} \
         var b=f.bind({x:1},2).bind({x:9},3); b(4)",
    );
    // Chained wrappers can terminate at either a user or native callable.
    agrees("var f=Math.max.bind(null,3).bind(null,5); f(4,9)");
    // Binding the call/apply built-ins themselves performs their abstract
    // redispatch rather than entering a native-method placeholder body.
    agrees("Function.prototype.call.bind(function(a){return this.x+a})({x:2},3)");
    agrees("Function.prototype.apply.bind(Math.max)(null,[2,7,3])");
}

#[test]
fn bound_function_chains_work_at_abstract_call_sites() {
    // Array iteration invokes callbacks through the abstract Call operation.
    agrees(
        "function f(a,b,v){return a+b+v} \
         [3].map(f.bind(null,1).bind(null,2))[0]",
    );
    agrees("[3].map(Number.bind(null).bind(null))[0]");
    // `.call`/`.apply` ignore their explicit thisArg when the receiver is
    // bound, while preserving bound-leading then forwarded argument order.
    agrees(
        "function f(a,b){return this.x+a+b} \
         f.bind({x:1},2).call({x:9},3)",
    );
    agrees(
        "function f(a,b,c){return this.x+a+b+c} \
         f.bind({x:1},2).apply({x:9},{length:2,0:3,1:4})",
    );
    // Abrupt completion from the ultimate target still reaches the caller's
    // handler through both direct and callback re-entry.
    agrees(
        "var b=(function(){throw new RangeError('x')}).bind(null).bind(null); \
         var ok=false;try{b.call(null)}catch(e){ok=e instanceof RangeError}ok",
    );
    agrees(
        "var b=(function(){throw new RangeError('x')}).bind(null).bind(null); \
         var ok=false;try{[1].map(b)}catch(e){ok=e instanceof RangeError}ok",
    );
}
