//! Oracle-backed regressions for the explicit-resource-management methods on
//! the iterator prototypes (`%IteratorPrototype%[@@dispose]`,
//! `%AsyncIteratorPrototype%[@@asyncDispose]`) and the `disposed` getters of
//! `DisposableStack` and `AsyncDisposableStack`.

use ironhorse_262::{dual_run, dual_run_async, Agreement};

fn assert_oracle_result(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "agreement for {source}: oracle_error={:?}, ironhorse_halt={:?}",
        run.oracle_error,
        run.ironhorse_halt
    );
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
}

fn assert_async_signal(source: &str, expected: &str) {
    let run = dual_run_async(source, "g").expect("XS oracle machine");
    assert_eq!(run.run.agreement, Agreement::BothComplete, "{:?}", run.run);
    assert!(run.run.result_agrees, "{:?}", run.run);
    assert_eq!(run.ironhorse_signal.as_deref(), Some(expected), "{source}");
}

#[test]
fn iterator_dispose_is_an_own_method_that_calls_return() {
    assert_oracle_result(
        "var IP=Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())); \
         var d=Object.getOwnPropertyDescriptor(IP,Symbol.dispose); \
         var log=''; var it={__proto__:IP, return:function(){log+='r'+arguments.length+(this===it); return 5}}; \
         var r=it[Symbol.dispose](); \
         [typeof d.value, d.value.name, d.value.length, d.writable, d.enumerable, d.configurable, \
          log, r, IP[Symbol.dispose].call({})].join()",
        "function,[Symbol.dispose],0,true,false,true,r0true,,",
    );
}

#[test]
fn iterator_dispose_swallows_return_errors_like_xs() {
    // XS's `fx_Iterator_prototype_dispose` closes with `abrupt` set, so a
    // throwing `return` getter or call, a non-callable `return`, and a
    // non-object result are all swallowed.
    assert_oracle_result(
        "var IP=Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())); \
         var d=IP[Symbol.dispose]; var o=''; \
         [{get return(){o+='g'; throw new RangeError()}}, {return:1}, \
          {return(){o+='c'; throw new RangeError()}}, {return(){o+='p'; return 3}}, {return:null}] \
           .forEach(function(it){ var r=d.call(it); o+=String(r); }); o",
        "gundefinedundefinedcundefinedpundefinedundefined",
    );
}

#[test]
fn async_iterator_async_dispose_is_an_own_method() {
    assert_oracle_result(
        "async function* g(){} var AIP=Object.getPrototypeOf(Object.getPrototypeOf(g.prototype)); \
         var d=Object.getOwnPropertyDescriptor(AIP,Symbol.asyncDispose); \
         [typeof d.value, d.value.name, d.value.length, d.writable, d.enumerable, d.configurable, \
          AIP[Symbol.asyncDispose].call({}) instanceof Promise].join()",
        "function,[Symbol.asyncDispose],0,true,false,true,true",
    );
}

#[test]
fn async_iterator_async_dispose_resolves_the_return_result_like_xs() {
    assert_async_signal(
        "var g=''; async function* gen(){} \
         var AIP=Object.getPrototypeOf(Object.getPrototypeOf(gen.prototype)); \
         var it={__proto__:AIP, return:function(){g+='r'+arguments.length; return Promise.resolve(9)}}; \
         it[Symbol.asyncDispose]().then(function(v){g+=':'+v}); \
         AIP[Symbol.asyncDispose].call({return:function(){return Promise.reject(4)}}) \
           .then(undefined,function(e){g+=',x'+e}); \
         AIP[Symbol.asyncDispose].call({get return(){throw 6}}).then(undefined,function(e){g+=',y'+e}); \
         AIP[Symbol.asyncDispose].call({}).then(function(v){g+=',z'+v}); \
         undefined",
        "r0:9,x4,y6,zundefined",
    );
}

#[test]
fn disposable_stack_disposed_getters_track_disposal() {
    assert_oracle_result(
        "var out=[]; [DisposableStack, AsyncDisposableStack].forEach(function(C){ \
           var d=Object.getOwnPropertyDescriptor(C.prototype,'disposed'); \
           var s=new C(); var before=s.disposed; \
           if(C===DisposableStack) s.dispose(); else s.disposeAsync(); \
           var bad; try{d.get.call({}); bad='none'}catch(e){bad=e.name} \
           out.push([d.get.name, d.get.length, d.set, d.enumerable, d.configurable, before, s.disposed, bad].join('/')); }); \
         out.join()",
        "get disposed/0//false/true/false/true/TypeError,get disposed/0//false/true/false/true/TypeError",
    );
}
