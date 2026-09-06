//! The error model, differentially against the XS oracle.
//!
//! Every program here exercises a seam the architecture review's finding 3
//! ("the error and control-transfer model leaks into results") named: an
//! engine raise inside a nested dispatch, an inline engine `TypeError`, a
//! promise executor or thenable under a live guest `try`, a throwing
//! `toString`/`valueOf`/setter reached from a native, member access on a
//! nullish base, a non-callable call with a second code segment live. Each
//! must COMPLETE or ABORT exactly as XS does (result string, or the thrown
//! value's rendering). Computrons are deliberately not compared: these
//! paths produced wrong answers before, so their metering has never been
//! calibrated against the oracle — that is the review's W4 work, and the
//! per-path constants belong with it.
//!
//! `KNOWN_DIVERGENCES` lists the programs the sweep found divergent for
//! reasons OUTSIDE finding 3, each with the review item it belongs to. A
//! new entry needs a reason; a fixed one must be removed (the test fails
//! either way), so the list is a ratchet, not a skip.

use ironhorse_262::{dual_run, Agreement};

/// Programs known to diverge from XS for a reason outside this net's
/// subject, with that reason. Verified on the pinned oracle.
const KNOWN_DIVERGENCES: &[(&str, &str)] = &[
    (
        "function f(){ var r=0; try { [1,2].map(function(){ return undefinedVar }) } catch(e){ r=String(e) } return r } f()",
        "String(err) renders `Error: …` for a subclass error whose intrinsic the source never names (review F029 / lazy intrinsic link)",
    ),
    (
        "var r=0; function f(){ 'use strict'; var o=Object.freeze({x:1}); try{ with(o){ } }catch(e){ r='caught' } } r",
        "early SyntaxError text: the compile-time abort carries no XS message (review F151)",
    ),
    (
        "var r='ok'; for (var k in null) { r='iterated' } r",
        "for-in over a nullish base is a named `Unsupported(\"for_in\")` gap",
    ),
    (
        "var r=0; function f(){ 'use strict'; var s='abc'; try { s[0] = 'x'; r=s } catch(e){ r=e instanceof TypeError } } f(); r",
        "strict indexed write to a primitive string is a silent no-op; XS throws (property_at_set on primitives, adjacent to F007)",
    ),
    (
        "var o={toString(){ throw 5 }}; throw o",
        "the oracle shim reports a throwing exception-stringification as its own marker; the port renders the fallback stub (F026/F093)",
    ),
    (
        "throw Symbol('s')",
        "the oracle shim reports a throwing exception-stringification as its own marker; the port renders `[object Object]` for a symbol (F085-adjacent)",
    ),
    (
        "var r=0; function f(){ 'use strict'; try { undeclared = 1 } catch(e){ r=e.name+':'+e.message } } f(); r",
        "strict assignment to an undeclared name does not throw (SET_VARIABLE strict miss; not in finding 3)",
    ),
    (
        "var r=0; try { const c = 1; c = 2 } catch(e){ r=e.name } r",
        "XS 8.3.1 does not throw on a top-level const reassignment in a script; the port follows the spec",
    ),
];

#[test]
fn error_model_agrees_with_the_oracle() {
    let programs: &[&str] = &[
        // --- raise depth (F001) ---
        "function f(){ var r=0; try { [1].forEach(function(){ nosuchvar; }) } catch(e) { r='caught' } return r } f()",
        "var r=0; function g(){ try { [1].forEach(function(){ throw 1 }) } catch(e) { r='inner:'+e } } try { g() } catch(e) { r='outer:'+e } r",
        "var r=0; var o={get x(){ nosuchvar }}; function f(){ try { return o.x } catch(e){ return 'caught' } } r=f(); r",
        "var r=0; function* g(){ try { yield 1; nosuchvar } finally { r='fin' } } var it=g(); it.next(); try { it.next() } catch(e){ r+=':caught' } r",
        "var r=0; var p=new Proxy({}, {get(t,k){ if(k==='x') nosuchvar; return 1 }}); function f(){ try { return p.x } catch(e){ return 'caught' } } f()",
        "var r=[]; function f(){ try { [1].forEach(function(){ try { nosuchvar } finally { r.push('f1') } }) } catch(e){ r.push('c') } finally { r.push('f2') } } f(); r.join()",
        // --- catchable engine errors (F004/F005) ---
        "var r=0; try { Object.create(1) } catch(e){ r=(e instanceof TypeError)+':'+e.name+':'+e.message } r",
        "var r=0; try { Object.defineProperty({},'x',1) } catch(e){ r=e.name+':'+e.message } r",
        "var r=0; try { Object.defineProperties(1,{}) } catch(e){ r=e.name+':'+e.message } r",
        "var r=0; try { Reflect.isExtensible(1) } catch(e){ r=e instanceof TypeError } r",
        "var r=0; try { Object.getOwnPropertyDescriptor(null,'x') } catch(e){ r=e instanceof TypeError } r",
        "var log=[]; var p=new Promise(function(){ Object.create(1) }); p.then(null, function(e){ log.push(e instanceof TypeError) }); log.length",
        "var r; try { for (var x of 5) {} } catch(e) { r = e instanceof TypeError } r",
        "var r; var it={[Symbol.iterator](){ return 1 }}; try { for (var x of it) {} } catch(e) { r = e.name+':'+e.message } r",
        "var r; var it={[Symbol.iterator](){ return { next(){ return 1 } } }}; try { for (var x of it) {} } catch(e) { r = e.name+':'+e.message } r",
        "var r; try { var [a] = {}; } catch(e) { r = e instanceof TypeError } r",
        "var r; try { ({}).x.y.z } catch(e) { r = e.name+':'+e.message } r",
        // --- native try fence (F023) ---
        "var r=0; var p; try { p = new Promise(function(){ throw 1; }); } catch(e){ r='caught:'+e; } r",
        "var r=0; try { new Promise(function(){ throw 1; }); throw 3; } catch(e){ r='caught:'+e; } r",
        "var r=0; try { Promise.resolve({ get then(){ throw 5 } }) ; r='ok' } catch(e){ r='caught:'+e } r",
        "var r=0; try { Promise.all({ [Symbol.iterator](){ throw 7 } }); r='ok' } catch(e){ r='caught:'+e } r",
        "var r=0; function* g(){ try { yield new Promise(function(){ throw 1 }) } catch(e) { r='gen-caught' } } g().next(); r",
        "var r=0; try { new Promise(function(res){ res(1); throw 2 }); r='ok' } catch(e){ r='caught:'+e } r",
        "var r=0; async function f(){ try { new Promise(function(){ throw 1 }) } catch(e) { r='caught' } r='after' } f(); r",
        "var r=0; var o={ [Symbol.dispose](){ throw 1 } }; try { { using x = o; } } catch(e){ r='caught:'+e } r",
        "var r=0; try { Array.from({ get length(){ throw 9 } }) } catch(e){ r='caught:'+e } r",
        "var r=0; try { Array.fromAsync({ get length(){ throw 9 } }); r='ok' } catch(e){ r='caught:'+e } r",
        "var r=0; try { Object.fromEntries({ [Symbol.iterator](){ throw 4 } }) } catch(e){ r='caught:'+e } r",
        // --- resume consumption (F006) ---
        "var r=0; var o={toString(){throw 2;}}; try{`${o}`}catch(e){r='caught:'+e} r",
        "var r=0; var o={set x(v){throw 5;}}; with(o){ try{ x=1 }catch(e){r='caught:'+e} } r",
        "var r=0; var o={valueOf(){throw 7;}}; try{ o++ }catch(e){r='caught:'+e} r",
        "var r=0; var o={valueOf(){throw 7;}}; try{ +o }catch(e){r='caught:'+e} r",
        "var r=0; var o={valueOf(){throw 7;}}; try{ o*2 }catch(e){r='caught:'+e} r",
        "var r=0; var o={toString(){throw 3;}}; var t={}; try{ t[o]=1 }catch(e){r='caught:'+e} r",
        "var r=0; var o={toString(){throw 3;}}; try{ 'a'+o }catch(e){r='caught:'+e} r",
        "var r=0; var o={[Symbol.toPrimitive](){throw 3;}}; try{ o+1 }catch(e){r='caught:'+e} r",
        "var r=0; var o={ get [Symbol.iterator](){ throw 4 } }; try { for (var x of o) {} } catch(e) { r='caught:'+e } r",
        "var r=0; var o={ get [Symbol.iterator](){ throw 4 } }; try { [...o] } catch(e) { r='caught:'+e } r",
        "var r=0; var o={ get x(){ throw 8 } }; try { var {x} = o } catch(e) { r='caught:'+e } r",
        "var r=0; var o={ get x(){ throw 8 } }; try { with(o) { x } } catch(e) { r='caught:'+e } r",
        "var r=0; function f(){ 'use strict'; var o=Object.freeze({x:1}); try{ o.x=2 }catch(e){ r=e instanceof TypeError } } f(); r",
        // --- nullish (F007) ---
        "var r=0; try { null.f } catch(e){ r=e.name+':'+e.message } r",
        "var r=0; try { undefined.f = 1 } catch(e){ r=e.name+':'+e.message } r",
        "var r=0; var k='f'; try { null[k] } catch(e){ r=e.name+':'+e.message } r",
        "var r=0; var s=Symbol(); try { null[s] } catch(e){ r=e.name+':'+e.message } r",
        "var r=0; try { null.x += 1 } catch(e){ r=e.name+':'+e.message } r",
        "var r=0; try { undefined.x++ } catch(e){ r=e.name+':'+e.message } r",
        "var log=[]; function f(){ log.push('rhs'); return 1 } try { null.x = f() } catch(e){ log.push('threw') } log.join()",
        "var r=0; try { var {a} = null } catch(e){ r=e.name+':'+e.message } r",
        "var r=0; try { 'x' in null } catch(e){ r=e.name+':'+e.message } r",
        "var r=0; try { delete null.x } catch(e){ r=e.name+':'+e.message } r",
        "var r=0; try { null?.x.y; r='ok' } catch(e){ r=e.name+':'+e.message } r",
        "var r=0; var a=null; try { a?.[0]; r='ok' } catch(e){ r='threw' } r",
        "var r='ok'; try { ({...null}) } catch(e){ r='threw' } r",
        "var r=0; try { null.f() } catch(e){ r=e.name+':'+e.message } r",
        "var r=0; try { true.x } catch(e){ r='threw' } r === 0 ? 'undef-ok' : r",
        "var r=0; try { (5).x } catch(e){ r='threw' } r === 0 ? 'undef-ok' : r",
        "var r=0; try { 'abc'.x } catch(e){ r='threw' } r === 0 ? 'undef-ok' : r",
        "var r=0; class A { m(){ return super.x } } try { new A().m(); r='ok' } catch(e){ r='threw' } r",
        "var r=0; try { null[0] = 1 } catch(e){ r=e.name+':'+e.message } r",
        // --- cross segment (F024) ---
        "eval('function g(){}'); function f(){ var r=0; var o={}; try { o(); } catch(e){ r = e instanceof TypeError } return r } f()",
        "eval('function g(){}'); function f(){ var r=0; try { (1)(); } catch(e){ r = e instanceof TypeError } return r } f()",
        "eval('function g(){}'); function f(){ var r=0; var o={}; try { new o(); } catch(e){ r = e instanceof TypeError } return r } f()",
        "eval('var h = function(){ return 3 }'); function f(){ return h() } f()",
        "var r=0; function f(){ var o={}; try { o.m() } catch(e) { r=e instanceof TypeError } } f(); r",
        // --- uncaught escapes (rendering) ---
        "throw new TypeError('x')",
        "Object.create(1)",
        "null.f",
        "function f(){ [1].forEach(function(){ nosuchvar }) } f()",
        "new Promise(function(){ throw 1 }); 'done'",
        "throw {toString(){ return 'obj' }}",
        // --- fence edge cases, disposers, eval and generator value carrying ---
        // handlers left behind on a native try (debug_assert hunting)
        "var r=0; new Promise(function(){ try { return 1 } catch(e) {} }); r='ok'; r",
        "var r=0; new Promise(function(){ try { return 1 } finally { r='fin' } }); r",
        "var r=0; new Promise(function(){ function* g(){ try { yield 1 } finally { r='gfin' } } var it=g(); it.next(); }); r",
        "var r=0; new Promise(function(){ (async function(){ try { await 1 } finally { r='afin' } })() }); r",
        "var r=0; new Promise(function(){ (async function(){ try { throw 1 } catch(e) { r='acaught' } })() }); r",
        "var r=0; new Promise(function(){ for (var x of [1,2]) { try { break } finally { r='bfin' } } }); r",
        "var r=0; new Promise(function(){ label: try { break label } finally { r='lfin' } }); r",
        "var r=0; new Promise(function(){ try { eval('throw 1') } catch(e) { r='caught:'+e } }); r",
        "var r=0; var p = new Promise(function(){ eval('nosuchvar') }); r='ok'; r",
        "var r=0; new Promise(function(){ var it=(function*(){ try { throw 1 } catch(e){ r='gcaught' } })(); it.next() }); r",
        "var r=0; function* g(){ yield 1 } var it=g(); new Promise(function(){ try { it.throw(2) } catch(e){ r='caught:'+e } }); r",
        "var r=0; function* g(){ try { yield 1 } catch(e) { r='gc:'+e } } var it=g(); it.next(); new Promise(function(){ it.throw(2) }); r",
        "var r=0; new Promise(function(){ [1].forEach(function(){ try { throw 1 } catch(e){ r='inner' } }) }); r",
        "var r=0; try { new Promise(function(){ [1].forEach(function(){ nosuchvar }) }); r='ok' } catch(e){ r='caught' } r",
        "var r=0; try { new Promise(function(){ new Proxy({}, { get(){ throw 3 } }).x }); r='ok' } catch(e){ r='caught' } r",
        "var r=0; try { new Promise(function(){ with({get x(){ throw 4 }}) { x } }); r='ok' } catch(e){ r='caught' } r",
        // disposers aggregate, never leak to a guest handler mid-loop
        "var r; try { { using a = {[Symbol.dispose](){ throw 1 }}; using b = {[Symbol.dispose](){ throw 2 }}; } } catch(e) { r = e.constructor.name + ':' + e.error + ':' + e.suppressed } r",
        "var r; try { { using a = {[Symbol.dispose](){ throw 1 }}; } } catch(e) { r = 'caught:'+e } r",
        "var r=[]; try { { using a = {[Symbol.dispose](){ r.push('a'); throw 1 }}; using b = {[Symbol.dispose](){ r.push('b') }}; } } catch(e) { r.push('c') } r.join()",
        // reaction / finally / combinator paths under a live handler
        "var r=0; try { Promise.reject(1).finally(function(){ throw 2 }); r='ok' } catch(e){ r='caught' } r",
        "var r=0; try { Promise.all({ [Symbol.iterator](){ return { next(){ throw 7 } } } }); r='ok' } catch(e){ r='caught:'+e } r",
        "var r=0; try { Promise.race([{ get then(){ throw 8 } }]); r='ok' } catch(e){ r='caught:'+e } r",
        "var r=0; try { Promise.allSettled(1); r='ok' } catch(e){ r='caught' } r",
        "var r=0; var p=Promise.resolve(1); try { p.then({ get call(){ throw 9 } }); r='ok' } catch(e){ r='caught:'+e } r",
        "var r=0; try { new Promise(function(res){ res({ get then(){ throw 5 } }) }); r='ok' } catch(e){ r='caught:'+e } r",
        "var r=0; try { new Promise(function(res){ res({ then(){ throw 6 } }) }); r='ok' } catch(e){ r='caught:'+e } r",
        "var r=0; try { Promise.resolve(1).then(function(){ throw 1 }); r='ok' } catch(e){ r='caught' } r",
        "var r=0; async function f(){ await { get then(){ throw 11 } } } try { f(); r='ok' } catch(e){ r='caught' } r",
        "var r=0; async function f(){ try { await { get then(){ throw 11 } } } catch(e) { r='acaught:'+e } } f(); r",
        // meter check at catch landing must not change counts
        "var r=0; for (var i=0;i<3;i++){ try { throw i } catch(e){ r+=e } } r",
        "var r=0; for (var i=0;i<3;i++){ try { null.x } catch(e){ r++ } } r",
        // Halt::Throw value through eval re-raise
        "var r=0; try { eval('null.x') } catch(e){ r=e.name+':'+e.message } r",
        "var r=0; try { eval('throw 1') } catch(e){ r='caught:'+e } r",
        "var r=0; try { (0,eval)('Object.create(1)') } catch(e){ r=e.name+':'+e.message } r",
        "var r=0; try { new Function('null.x')() } catch(e){ r=e.name+':'+e.message } r",
        // generator throw carries value
        "var r=0; function* g(){ null.x } try { g().next() } catch(e){ r=e.name+':'+e.message } r",
        "var r=0; async function f(){ null.x } f().then(null, function(e){ r=e.name }); r",
        "var r=0; function f(){ 'use strict'; try { undeclared = 1 } catch(e){ r=e.name+':'+e.message } } f(); r",
        "var r=0; try { const c = 1; c = 2 } catch(e){ r=e.name } r",
        "var r=0; try { x; let x = 1 } catch(e){ r=e.name } r",
        "var r=0; try { class A extends null { constructor(){ super() } } new A() } catch(e){ r=e.name } r",
        "var r=0; try { new (class extends Object { constructor(){ } }) } catch(e){ r=e.name } r",
        "var r=0; try { ({}).x.y } catch(e){ r=e.stack !== undefined } r",
    ];
    let mut bad = Vec::new();
    let mut stale_allowlist = Vec::new();
    for src in programs.iter().chain(KNOWN_DIVERGENCES.iter().map(|(p, _)| p)) {
        let run = dual_run(src).expect("the pinned XS oracle machine must start");
        let same = match run.agreement {
            Agreement::BothComplete => run.result_agrees,
            Agreement::BothAbort => run.error_agrees,
            _ => false,
        };
        let known = KNOWN_DIVERGENCES.iter().find(|(p, _)| p == src);
        match (same, known) {
            (true, None) => {}
            (false, Some(_)) => {}
            (true, Some((_, why))) => stale_allowlist.push(format!("  {src}\n    ({why})")),
            (false, None) => bad.push(format!(
                "  {src}\n    agreement={:?}\n    oracle:    result={:?} error={:?}\n    ironhorse: result={:?} error={:?} halt={:?}",
                run.agreement,
                run.oracle_result,
                run.oracle_error,
                run.ironhorse_result,
                run.ironhorse_error,
                run.ironhorse_halt
            )),
        }
    }
    assert!(
        bad.is_empty(),
        "programs whose completion or thrown value differs from XS:\n{}",
        bad.join("\n")
    );
    assert!(
        stale_allowlist.is_empty(),
        "KNOWN_DIVERGENCES entries that now agree with XS — remove them:\n{}",
        stale_allowlist.join("\n")
    );
}
