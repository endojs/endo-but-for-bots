//! Stage-7 child 3/7 behavioral gate: `Promise.prototype.finally` and the
//! promise combinators (`Promise.all`/`allSettled`/`race`/`any`) on the landed
//! 5-slot native-reaction path (design [`designs/ironhorse-engine.md`] §
//! promises; the review ledger's promise residuals).
//!
//! Each combinator builds a result capability, consumes the input's live
//! iterator, resolves each yielded value through the constructor's observable
//! `resolve` method, and folds each element settlement into the shared
//! `remainingElementsCount` / results state. Native Promise reactions run at
//! the pump-loop drain; callbacks passed to an arbitrary custom `then` run when
//! that method calls them, as required by the specification.
//!
//! Two gates per the accuracy-over-parity doctrine:
//!   1. **Result agreement** — the program's completion value agrees with the
//!      XS oracle where the oracle accepts it (`BothComplete` +
//!      `result_agrees`); the combinator/finally programs complete `undefined`
//!      synchronously (the native result promise settles at the drain), so this
//!      certifies ironhorse reproduces the oracle's whole execution *including* the
//!      microtask drain.
//!   2. **Observable resolution** — the combinator's *resolved value* is read
//!      out of a post-drain global (`g`, rendered as ironhorse's async signal) and
//!      checked against the analytically-known value XS's combinators produce.
//! Plus a **determinism** gate: identical computrons across repeated ironhorse runs
//! (the meter is deterministic-per-release; oracle agreement is advisory).

use ironhorse_262::{dual_run, Agreement};

fn assert_oracle_result(source: &str, expected: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert!(run.result_agrees, "{source}: {run:?}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
    assert_deterministic(source);
}

/// Run `source` on both engines, assert they both complete with an agreeing
/// completion value, and assert ironhorse's post-drain global `g` renders to
/// `expected` — the resolved/observed value the combinator produced at the
/// drain. Also asserts the ironhorse meter is deterministic across repeated runs.
fn assert_drains_to(source: &str, expected: &str) {
    let a = ironhorse_262::dual_run_async(source, "g").expect("the XS oracle machine must start");
    assert_eq!(
        a.run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        a.run.ironhorse_halt,
        a.run.oracle_result,
        a.run.ironhorse_result,
    );
    assert!(
        a.run.result_agrees,
        "`{source}` completion divergence: oracle={:?} ironhorse={:?}",
        a.run.oracle_result, a.run.ironhorse_result,
    );
    assert_eq!(
        a.ironhorse_signal.as_deref(),
        Some(expected),
        "`{source}` post-drain global `g`: expected {:?}",
        expected,
    );
    assert_deterministic(source);
}

/// The ironhorse meter must be deterministic across repeated runs of the same
/// program (identical computrons) — the deterministic-per-release meter gate.
fn assert_deterministic(source: &str) {
    let a = dual_run(source)
        .expect("oracle machine")
        .ironhorse_computrons;
    let b = dual_run(source)
        .expect("oracle machine")
        .ironhorse_computrons;
    assert_eq!(
        a, b,
        "`{source}` ironhorse computrons must be deterministic across runs"
    );
}

// -------------------------------------------------------------------------
// §1  `Promise.prototype.finally`.
// -------------------------------------------------------------------------

#[test]
fn finally_passes_a_fulfillment_through_after_running_on_finally() {
    // `onFinally` runs (side effect) then the original value passes through.
    assert_drains_to(
        "var order=''; var g; \
         Promise.resolve(7).finally(function(){order+='f';}).then(function(v){g=order+':'+v;}); \
         undefined",
        "f:7",
    );
}

#[test]
fn finally_passes_a_rejection_through() {
    // A rejected receiver: `onFinally` runs, then the reason passes through to
    // the `onRejected` handler (finally does not swallow the rejection).
    assert_drains_to(
        "var g; \
         Promise.reject(9).finally(function(){}).then(function(v){g='F'+v;}, function(e){g='R'+e;}); \
         undefined",
        "R9",
    );
}

#[test]
fn finally_return_value_is_ignored() {
    // `onFinally`'s (non-thenable) return value is discarded — the original
    // fulfillment value is what flows on.
    assert_drains_to(
        "var g; Promise.resolve(4).finally(function(){return 99;}).then(function(v){g=''+v;}); undefined",
        "4",
    );
}

#[test]
fn finally_awaits_returned_promises_before_restoring_the_original_settlement() {
    assert_drains_to(
        "var g; Promise.resolve(7).finally(function(){return Promise.resolve(99);}).then(function(v){g='F'+v;},function(e){g='R'+e;}); undefined",
        "F7",
    );
    assert_drains_to(
        "var g; Promise.reject(8).finally(function(){return Promise.resolve(99);}).then(function(v){g='F'+v;},function(e){g='R'+e;}); undefined",
        "R8",
    );
}

#[test]
fn finally_returned_rejection_overrides_the_original_settlement() {
    assert_drains_to(
        "var g; Promise.resolve(7).finally(function(){return Promise.reject(9);}).then(function(v){g='F'+v;},function(e){g='R'+e;}); undefined",
        "R9",
    );
    assert_drains_to(
        "var g; Promise.reject(8).finally(function(){return Promise.reject(9);}).then(function(v){g='F'+v;},function(e){g='R'+e;}); undefined",
        "R9",
    );
}

#[test]
fn finally_observes_a_returned_promises_custom_then() {
    assert_drains_to(
        "var g,calls=0,p=Promise.resolve(11); p.then=function(resolve){calls++;resolve(12);}; Promise.resolve(7).finally(function(){return p;}).then(function(v){g=calls+':F'+v;},function(e){g=calls+':R'+e;}); undefined",
        "1:F7",
    );
    assert_drains_to(
        "var g,calls=0,p=Promise.resolve(11); p.then=function(resolve,reject){calls++;reject(12);resolve(13);}; Promise.resolve(7).finally(function(){return p;}).then(function(v){g=calls+':F'+v;},function(e){g=calls+':R'+e;}); undefined",
        "1:R12",
    );
}

#[test]
fn finally_assimilates_returned_thenables() {
    assert_drains_to(
        "var g; Promise.resolve(7).finally(function(){return {then:function(resolve){resolve(12);}};}).then(function(v){g='F'+v;},function(e){g='R'+e;}); undefined",
        "F7",
    );
    assert_drains_to(
        "var g; Promise.resolve(7).finally(function(){return {then:function(resolve,reject){reject(12);}};}).then(function(v){g='F'+v;},function(e){g='R'+e;}); undefined",
        "R12",
    );
}

#[test]
fn finally_rejects_when_returned_promise_observation_throws() {
    assert_drains_to(
        "var g,marker={},p=Promise.resolve(1); Object.defineProperty(p,'constructor',{get:function(){throw marker}}); Promise.resolve(7).finally(function(){return p;}).then(function(){g='F';},function(e){g='R'+(e===marker);}); undefined",
        "Rtrue",
    );
    assert_drains_to(
        "var g,marker={},p=Promise.resolve(1); Object.defineProperty(p,'then',{get:function(){throw marker}}); Promise.resolve(7).finally(function(){return p;}).then(function(){g='F';},function(e){g='R'+(e===marker);}); undefined",
        "Rtrue",
    );
}

#[test]
fn finally_uses_the_selected_species_for_result_resolution() {
    assert_drains_to(
        "var g='',calls=0;function C(executor){var n=++calls;executor(function(v){g+=n+'r'+v+','},function(e){g+=n+'j'+e+','});return {tag:n,then:function(resolve){resolve('ok')}}}var p=Promise.resolve(7);p.constructor={};p.constructor[Symbol.species]=C;var q=p.finally(function(){return 11});var same=q.tag===1;undefined",
        "2r11,1r7,",
    );
}

#[test]
fn finally_rejects_custom_species_capabilities_when_the_handler_throws() {
    assert_drains_to(
        "var g='',marker={};function C(executor){executor(function(v){g='r'+v},function(e){g='j'+(e===marker)});return {}}var p=Promise.resolve(7);p.constructor={};p.constructor[Symbol.species]=C;p.finally(function(){throw marker});undefined",
        "jtrue",
    );
}

#[test]
fn finally_accepts_bound_callable_handlers_returning_promises() {
    assert_drains_to(
        "var g,f=Promise.resolve.bind(Promise,13); Promise.resolve(7).finally(f).then(function(v){g='F'+v;},function(e){g='R'+e;}); undefined",
        "F7",
    );
}

#[test]
fn finally_with_non_callable_is_a_pass_through() {
    // A non-callable `onFinally` (`this.then(x, x)`): pure pass-through.
    assert_drains_to(
        "var g; Promise.resolve(3).finally(undefined).then(function(v){g=''+v;}); undefined",
        "3",
    );
}

#[test]
fn finally_with_non_callable_invokes_a_generic_receivers_then() {
    assert_oracle_result(
        "var result={},seen='',o={then:function(a,b){seen=(this===o)+':'+(a===7)+':'+(b===7)+':'+arguments.length;return result}};var r=Promise.prototype.finally.call(o,7);seen+':'+(r===result)",
        "true:true:true:2:true",
    );
}

#[test]
fn finally_rejects_primitive_receivers_and_observes_then_failures() {
    assert_oracle_result(
        "var n=0;for(var v of [undefined,null,1,'x']){try{Promise.prototype.finally.call(v)}catch(e){n+=e.name==='TypeError'}}n",
        "4",
    );
    assert_oracle_result(
        "var marker={},p=Promise.resolve(1),r='';Object.defineProperty(p,'then',{get:function(){throw marker}});try{Promise.prototype.finally.call(p)}catch(e){r=''+(e===marker)}r",
        "true",
    );
}

// -------------------------------------------------------------------------
// §2  `Promise.all` — resolve with the ordered values, reject on the first.
// -------------------------------------------------------------------------

#[test]
fn all_resolves_with_the_ordered_values() {
    assert_drains_to(
        "var g; Promise.all([1,2,3]).then(function(a){g=''+a[0]+a[1]+a[2];}); undefined",
        "123",
    );
}

#[test]
fn all_places_values_by_index_not_settle_order() {
    // A later index resolved synchronously and an earlier one through a
    // promise: the result Array is still index-ordered.
    assert_drains_to(
        "var g; Promise.all([Promise.resolve(10), 20]).then(function(a){g=''+(a[0]+a[1]);}); undefined",
        "30",
    );
}

#[test]
fn all_rejects_on_the_first_rejection() {
    assert_drains_to(
        "var g; Promise.all([1, Promise.reject(5), 3]).then(function(a){g='F';}, function(e){g='R'+e;}); undefined",
        "R5",
    );
}

#[test]
fn all_of_empty_resolves_with_an_empty_array() {
    assert_drains_to(
        "var g; Promise.all([]).then(function(a){g='len'+a.length;}); undefined",
        "len0",
    );
}

// -------------------------------------------------------------------------
// §3  `Promise.allSettled` — a status record per element, never rejects.
// -------------------------------------------------------------------------

#[test]
fn all_settled_records_fulfilled_and_rejected() {
    assert_drains_to(
        "var g; Promise.allSettled([1, Promise.reject(2)]).then(function(a){\
         g=a[0].status+','+a[0].value+','+a[1].status+','+a[1].reason;}); undefined",
        "fulfilled,1,rejected,2",
    );
}

#[test]
fn all_settled_of_empty_resolves_empty() {
    assert_drains_to(
        "var g; Promise.allSettled([]).then(function(a){g='n'+a.length;}); undefined",
        "n0",
    );
}

// -------------------------------------------------------------------------
// §4  `Promise.race` — the first element to settle wins.
// -------------------------------------------------------------------------

#[test]
fn race_settles_with_the_first_fulfillment() {
    assert_drains_to(
        "var g; Promise.race([1,2]).then(function(v){g='v'+v;}, function(e){g='e'+e;}); undefined",
        "v1",
    );
}

#[test]
fn race_settles_with_the_first_rejection() {
    assert_drains_to(
        "var g; Promise.race([Promise.reject(8), 2]).then(function(v){g='v'+v;}, function(e){g='e'+e;}); undefined",
        "e8",
    );
}

// -------------------------------------------------------------------------
// §5  `Promise.any` — the first fulfillment wins; else an AggregateError.
// -------------------------------------------------------------------------

#[test]
fn any_settles_with_the_first_fulfillment() {
    assert_drains_to(
        "var g; Promise.any([1,2]).then(function(v){g='v'+v;}, function(e){g='e';}); undefined",
        "v1",
    );
}

#[test]
fn any_rejects_with_an_aggregate_error_when_all_reject() {
    assert_drains_to(
        "var g; Promise.any([Promise.reject(1), Promise.reject(2)]).then(\
         function(v){g='v'+v;}, function(e){g=e.name+':'+e.errors.length+':'+e.errors[0]+e.errors[1];}); undefined",
        "AggregateError:2:12",
    );
}

#[test]
fn any_of_empty_rejects_with_an_empty_aggregate_error() {
    assert_drains_to(
        "var g; Promise.any([]).then(function(v){g='v';}, function(e){g=e.name+e.errors.length;}); undefined",
        "AggregateError0",
    );
}

// -------------------------------------------------------------------------
// §6  Rejection propagation and async resume boundaries.
// -------------------------------------------------------------------------

#[test]
fn thrown_reaction_rejects_the_derived_promise() {
    assert_drains_to(
        "var g; Promise.resolve(1).then(function(){throw 7;}).then(undefined,function(e){g='e'+e;}); undefined",
        "e7",
    );
}

#[test]
fn throwing_thenable_rejects_the_adopting_promise() {
    assert_drains_to(
        "var g; Promise.resolve({then:function(){throw 8;}}).then(undefined,function(e){g='e'+e;}); undefined",
        "e8",
    );
}

#[test]
fn native_promise_resolution_is_adopted_asynchronously() {
    assert_drains_to(
        "var g; Promise.resolve(Promise.resolve(9)).then(function(v){g='v'+v;}); undefined",
        "v9",
    );
}

#[test]
fn native_promise_with_own_then_uses_thenable_assimilation() {
    assert_drains_to(
        "var g,p=Promise.resolve(1); p.then=function(resolve){resolve(9);}; new Promise(function(resolve){resolve(p);}).then(function(v){g=v;}); undefined",
        "9",
    );
}

#[test]
fn await_preserves_try_catch_across_suspension() {
    assert_drains_to(
        "var g; (async function(){try{await Promise.reject(10);}catch(e){g='e'+e;}})(); undefined",
        "e10",
    );
}

#[test]
fn resolving_a_promise_with_itself_rejects_with_type_error() {
    assert_drains_to(
        "var g,r,p=new Promise(function(resolve){r=resolve;}); r(p); p.then(undefined,function(e){g=e.name;}); undefined",
        "TypeError",
    );
}

#[test]
fn static_combinator_does_not_consult_constructor_species() {
    let run = dual_run(
        "function C(executor){executor(function(){},function(){});} Object.defineProperty(C,Symbol.species,{get:function(){throw 1;}}); Promise.all.call(C,[])",
    )
    .expect("the XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete);
    assert!(
        run.result_agrees,
        "custom static capability result must agree"
    );
}

#[test]
fn static_combinators_build_and_return_custom_capabilities() {
    assert_drains_to(
        "var g='',same=false,calls=0,result={};function C(executor){calls++;executor(function(v){g=same+':'+calls+':r'+v.join(',')},function(e){g='j'+e});return result}C.resolve=function(v){return Promise.resolve(v)};var p=Promise.all.call(C,[1,2]);same=p===result;undefined",
        "true:1:r1,2",
    );
    assert_drains_to(
        "var g='',same=false,result={};function C(executor){executor(function(v){g=same+':r'+v[0].status+v[1].status},function(e){g='j'+e});return result}C.resolve=function(v){return Promise.resolve(v)};var p=Promise.allSettled.call(C,[1,Promise.reject(2)]);same=p===result;undefined",
        "true:rfulfilledrejected",
    );
    assert_drains_to(
        "var g='',same=false,result={};function C(executor){executor(function(v){g='r'+v},function(e){g=same+':j'+e.name+e.errors.join(',')});return result}C.resolve=function(v){return Promise.resolve(v)};var p=Promise.any.call(C,[Promise.reject(3),Promise.reject(4)]);same=p===result;undefined",
        "true:jAggregateError3,4",
    );
}

#[test]
fn custom_combinator_capabilities_observe_each_specification_call() {
    assert_drains_to(
        "var g='',result={};function C(executor){executor(function(v){g+='r'+v+','},function(e){g+='j'+e+','});return result}C.resolve=function(v){return Promise.resolve(v)};Promise.race.call(C,[1,2]);undefined",
        "r1,r2,",
    );
    assert_drains_to(
        "var g='',result={};function C(executor){executor(function(v){g+='r'+v+','},function(e){g+='j'+e+','});return result}C.resolve=function(v){return Promise.resolve(v)};Promise.all.call(C,[Promise.reject(1),Promise.reject(2)]);undefined",
        "j1,j2,",
    );
    assert_drains_to(
        "var g='',result={};function C(executor){executor(function(v){g+='r'+v+','},function(e){g+='j'+e+','});return result}C.resolve=function(v){return Promise.resolve(v)};Promise.any.call(C,[1,2]);undefined",
        "r1,r2,",
    );
}

#[test]
fn combinator_element_callbacks_run_synchronously_and_once() {
    assert_oracle_result(
        "var calls=0,element;function C(executor){executor(function(v){calls+=v[0]===1},function(){})}C.resolve=function(v){return v};var item={then:function(f){element=f;f(1);f(2)}};Promise.all.call(C,[item]);calls+':'+typeof element",
        "1:function",
    );
    assert_oracle_result(
        "var element;function C(executor){executor(function(){},function(){})}C.resolve=function(v){return v};Promise.all.call(C,[{then:function(f){element=f}}]);element.name+':'+element.length+':'+Object.prototype.hasOwnProperty.call(element,'prototype')",
        ":1:false",
    );
    assert_oracle_result(
        "var saved,seen='';function C(executor){executor(function(v){seen=v.join(',')},function(){})}C.resolve=function(v){return v};var a={then:function(f){saved=f}},b={then:function(f){saved('a');f('b')}},c={then:function(f){f('c')}};Promise.all.call(C,[a,b,c]);seen",
        "a,b,c",
    );
    assert_oracle_result(
        "var f;function C(executor){executor(function(){},function(){})}C.resolve=function(v){return v};Promise.allSettled.call(C,[{then:function(resolve){f=resolve}}]);try{new f();false}catch(e){e instanceof TypeError}",
        "true",
    );
}

#[test]
fn custom_combinator_setup_failures_reject_the_new_capability() {
    assert_oracle_result(
        "var result={},seen='';function C(executor){executor(function(){},function(e){seen=e.name});return result}var p=Promise.all.call(C,[]);seen+':'+(p===result)",
        "TypeError:true",
    );
    assert_oracle_result(
        "var n=0;for(var v of [undefined,null,1,'x',()=>{}]){try{Promise.all.call(v,[])}catch(e){n+=e.name==='TypeError'}}n",
        "5",
    );
    assert_oracle_result(
        "var marker={};function C(){throw marker}try{Promise.race.call(C,[]);false}catch(e){e===marker}",
        "true",
    );
}

#[test]
fn combinators_accept_string_iterables_by_code_point() {
    assert_drains_to(
        r#"var g; Promise.all('a\uD83D\uDE00').then(function(v){g=v.length+':'+v[0]+v[1];}); undefined"#,
        "2:a😀",
    );
}

#[test]
fn non_iterable_combinator_input_rejects_with_type_error() {
    assert_drains_to(
        "var g; Promise.all(1).then(undefined,function(e){g=e.name;}); undefined",
        "TypeError",
    );
    assert_drains_to(
        "var g,a=[]; a[Symbol.iterator]=null; Promise.race(a).then(undefined,function(e){g=e.name;}); undefined",
        "TypeError",
    );
}

#[test]
fn iterator_method_returning_a_primitive_rejects_capability() {
    assert_drains_to(
        "var g,o={}; o[Symbol.iterator]=function(){return 1;}; Promise.any(o).then(undefined,function(e){g=e.name;}); undefined",
        "TypeError",
    );
}

#[test]
fn combinators_consume_custom_iterator_protocols() {
    assert_drains_to(
        "var g,o={}; o[Symbol.iterator]=function(){var i=0;return {next:function(){return i<3?{value:++i,done:false}:{done:true}}}}; Promise.all(o).then(function(a){g=a.join(',')}); undefined",
        "1,2,3",
    );
    assert_drains_to(
        "var g,o={}; o[Symbol.iterator]=function(){var i=0;return {next:function(){return i<2?{value:++i,done:false}:{done:true}}}}; Promise.allSettled(o).then(function(a){g=a[0].status+':'+a[1].value}); undefined",
        "fulfilled:2",
    );
    assert_drains_to(
        "var g,o={}; o[Symbol.iterator]=function(){var i=0;return {next:function(){return i<2?{value:++i,done:false}:{done:true}}}}; Promise.race(o).then(function(v){g=''+v}); undefined",
        "1",
    );
    assert_drains_to(
        "var g,o={}; o[Symbol.iterator]=function(){var i=0;return {next:function(){return i<2?{value:++i,done:false}:{done:true}}}}; Promise.any(o).then(function(v){g=''+v}); undefined",
        "1",
    );
}

#[test]
fn promise_resolve_is_read_once_before_iterator_acquisition() {
    assert_drains_to(
        "var g,log='',old=Promise.resolve,o={}; Object.defineProperty(Promise,'resolve',{configurable:true,get:function(){log+='r';return old}}); o[Symbol.iterator]=function(){log+='i';return {next:function(){log+='n';return {done:true}}}}; Promise.all(o).then(function(){g=log}); undefined",
        "rin",
    );
}

#[test]
fn iterator_step_failures_reject_without_closing() {
    assert_drains_to(
        "var g,closed=0,marker={},o={}; o[Symbol.iterator]=function(){return {next:function(){throw marker},return:function(){closed++;return {}}}}; Promise.all(o).then(undefined,function(e){g=(e===marker)+':'+closed}); undefined",
        "true:0",
    );
    assert_drains_to(
        "var g,closed=0,marker={},step={value:1}; Object.defineProperty(step,'done',{get:function(){throw marker}}); var o={}; o[Symbol.iterator]=function(){return {next:function(){return step},return:function(){closed++;return {}}}}; Promise.race(o).then(undefined,function(e){g=(e===marker)+':'+closed}); undefined",
        "true:0",
    );
    assert_drains_to(
        "var g,closed=0,marker={},step={done:false}; Object.defineProperty(step,'value',{get:function(){throw marker}}); var o={}; o[Symbol.iterator]=function(){return {next:function(){return step},return:function(){closed++;return {}}}}; Promise.allSettled(o).then(undefined,function(e){g=(e===marker)+':'+closed}); undefined",
        "true:0",
    );
}

#[test]
fn element_processing_failures_close_before_rejecting() {
    assert_drains_to(
        "var g,closed=0,marker={},old=Promise.resolve,o={}; Promise.resolve=function(){throw marker}; o[Symbol.iterator]=function(){return {next:function(){return {value:1,done:false}},return:function(){closed++;return {}}}}; Promise.all(o).then(undefined,function(e){g=(e===marker)+':'+closed}); Promise.resolve=old; undefined",
        "true:1",
    );
    assert_drains_to(
        "var g,closed=0,marker={},p=Promise.resolve(1),o={}; Object.defineProperty(p,'then',{get:function(){throw marker}}); var old=Promise.resolve; Promise.resolve=function(){return p}; o[Symbol.iterator]=function(){return {next:function(){return {value:1,done:false}},return:function(){closed++;return {}}}}; Promise.race(o).then(undefined,function(e){g=(e===marker)+':'+closed}); Promise.resolve=old; undefined",
        "true:1",
    );
}

#[test]
fn array_iteration_observes_growth_caused_by_promise_resolve() {
    assert_drains_to(
        "var g,a=[1],old=Promise.resolve; Promise.resolve=function(v){if(v===1)a.push(2);return old.call(Promise,v)}; Promise.all(a).then(function(v){g=v.join(',')}); Promise.resolve=old; undefined",
        "1,2",
    );
}

#[test]
fn custom_then_methods_drive_each_combinator() {
    assert_drains_to(
        "var g; Promise.resolve=function(v){return {then:function(f){f(v+1)}}}; Promise.all([1,2]).then(function(v){g=v.join(',')}); undefined",
        "2,3",
    );
    assert_drains_to(
        "var g; Promise.resolve=function(v){return {then:function(f,r){f(v);r(9)}}}; Promise.allSettled([1]).then(function(v){g=v[0].status+':'+v[0].value}); undefined",
        "fulfilled:1",
    );
    assert_drains_to(
        "var g; Promise.resolve=function(v){return {then:function(f,r){if(v===1)r(7);else f(v)}}}; Promise.race([1,2]).then(function(v){g='f'+v},function(e){g='r'+e}); undefined",
        "r7",
    );
    assert_drains_to(
        "var g; Promise.resolve=function(v){return {then:function(f,r){if(v===1)r(7);else f(v)}}}; Promise.any([1,2]).then(function(v){g='f'+v},function(e){g='r'}); undefined",
        "f2",
    );
}

#[test]
fn captured_element_callback_remains_live_after_iteration() {
    assert_drains_to(
        "var g,fulfill; Promise.resolve=function(){return {then:function(f){fulfill=f}}}; var p=Promise.all([1]); fulfill(4); fulfill(5); p.then(function(v){g=v.join(',')}); undefined",
        "4",
    );
}

#[test]
fn promise_constructor_rejects_non_callable_executors() {
    assert_oracle_result(
        "var n=0;for(var v of [undefined,null,1,'x',{}]){try{new Promise(v)}catch(e){n+=e.name==='TypeError'}}n",
        "5",
    );
}

#[test]
fn promise_then_requires_a_branded_promise_receiver() {
    assert_oracle_result(
        "var n=0;for(var v of [undefined,null,{},Promise.prototype]){try{Promise.prototype.then.call(v)}catch(e){n+=e.name==='TypeError'}}n",
        "4",
    );
}

#[test]
fn promise_statics_require_constructor_receivers() {
    assert_oracle_result(
        "var n=0;for(var v of [undefined,null,1,'x',true,Symbol(),eval,()=>{},function*(){},async function(){},async function*(){},({m(){}}).m]){try{Promise.resolve.call(v,1)}catch(e){n+=e.name==='TypeError'}}n",
        "12",
    );
    assert_oracle_result(
        "var n=0;for(var v of [undefined,null,1,'x',true,Symbol(),eval,()=>{},function*(){},async function(){},async function*(){},({m(){}}).m]){try{Promise.reject.call(v,1)}catch(e){n+=e.name==='TypeError'}}n",
        "12",
    );
}

#[test]
fn promise_resolve_observes_native_promises_constructor_for_identity() {
    assert_oracle_result(
        "var p=Promise.resolve(1),q=Promise.resolve(p);''+(p===q)",
        "true",
    );
    assert_oracle_result(
        "var p=Promise.resolve(1);p.constructor=null;var q=Promise.resolve(p);''+(p===q)",
        "false",
    );
    assert_oracle_result(
        "var p=Promise.resolve(1),marker={},seen='';Object.defineProperty(p,'constructor',{get:function(){throw marker}});try{Promise.resolve(p)}catch(e){seen=''+(e===marker)}seen",
        "true",
    );
}

#[test]
fn promise_statics_build_custom_capabilities() {
    assert_oracle_result(
        "var log=[];function C(executor){log.push(typeof executor,executor.name,executor.length,'prototype' in executor,Object.isExtensible(executor));executor(function(v){log.push('r'+v)},function(e){log.push('j'+e)});return {tag:1}}var p=Promise.resolve.call(C,42);log.push(p.tag);log.join(':')",
        "function::2:false:true:r42:1",
    );
    assert_oracle_result(
        "var log=[];function C(executor){executor(function(v){log.push('r'+v)},function(e){log.push('j'+e)});return {tag:2}}var p=Promise.reject.call(C,17);log.push(p.tag);log.join(':')",
        "j17:2",
    );
    assert_oracle_result(
        "var marker={};function C(){throw marker}try{Promise.resolve.call(C,1);false}catch(e){e===marker}",
        "true",
    );
    assert_oracle_result(
        "var marker={};function C(executor){executor(function(){throw marker},function(){});return {}}try{Promise.resolve.call(C,1);false}catch(e){e===marker}",
        "true",
    );
}

#[test]
fn capability_executor_enforces_single_nonempty_capture() {
    assert_oracle_result(
        "var log='';Promise.resolve.call(function(executor){log+='a';executor();log+='b';executor(function(){},function(){});log+='c';return {}},1);log",
        "abc",
    );
    assert_oracle_result(
        "var log='';try{Promise.resolve.call(function(executor){log+='a';executor(undefined,function(){});log+='b';executor(function(){},function(){});log+='c';return {}},1)}catch(e){log+=':'+e.name}log",
        "ab:TypeError",
    );
}

#[test]
fn promise_subclass_static_resolution_preserves_brand_and_prototype() {
    assert_oracle_result(
        "class P extends Promise{}var p=P.resolve(1);''+(p instanceof P)+':'+(p.constructor===P)+':'+(P.resolve(p)===p)",
        "true:true:true",
    );
}

#[test]
fn promise_then_uses_the_selected_species_capability() {
    assert_drains_to(
        "var g='',result={tag:1};function C(executor){executor(function(v){g='r'+v},function(e){g='j'+e});return result}var p=Promise.resolve(1);p.constructor={};p.constructor[Symbol.species]=C;var q=p.then(function(v){return v+41});var same=q===result;undefined",
        "r42",
    );
    assert_oracle_result(
        "var result={};function C(executor){executor(function(){},function(){});return result}var p=Promise.resolve(1);p.constructor={};p.constructor[Symbol.species]=C;p.then()===result",
        "true",
    );
}

#[test]
fn promise_then_propagates_species_and_capability_errors_synchronously() {
    assert_oracle_result(
        "var p=Promise.resolve(1);p.constructor=null;try{p.then();false}catch(e){e instanceof TypeError}",
        "true",
    );
    assert_oracle_result(
        "var marker={},p=Promise.resolve(1);Object.defineProperty(p,'constructor',{get:function(){throw marker}});try{p.then();false}catch(e){e===marker}",
        "true",
    );
    assert_oracle_result(
        "var p=Promise.resolve(1);p.constructor={};p.constructor[Symbol.species]=function C(executor){executor(function(){},function(){});executor(function(){},function(){});return {}};try{p.then();false}catch(e){e instanceof TypeError}",
        "true",
    );
}

#[test]
fn promise_catch_invokes_the_observable_then_method() {
    assert_oracle_result(
        "var log='',result={},o={then:function(a,b){log+=(this===o)+':'+(a===undefined)+':'+b+':'+arguments.length;return result}};var r=Promise.prototype.catch.call(o,7);log+':'+(r===result)",
        "true:true:7:2:true",
    );
    assert_oracle_result(
        "var log='';Number.prototype.then=function(a,b){log=this.valueOf()+':'+(a===undefined)+':'+b};Promise.prototype.catch.call(3,9);delete Number.prototype.then;log",
        "3:true:9",
    );
}

#[test]
fn promise_catch_propagates_get_and_call_failures() {
    assert_oracle_result(
        "var marker={},a={},b={then:function(){throw marker}},r='';Object.defineProperty(a,'then',{get:function(){throw marker}});try{Promise.prototype.catch.call(a)}catch(e){r+=(e===marker)}try{Promise.prototype.catch.call(b)}catch(e){r+=':'+(e===marker)}try{Promise.prototype.catch.call({})}catch(e){r+=':'+(e.name==='TypeError')}r",
        "true:true:true",
    );
}
