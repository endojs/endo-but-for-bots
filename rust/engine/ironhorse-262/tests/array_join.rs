//! Array join regressions for separator and element coercion ordering.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{run:?}");
    assert!(
        run.result_agrees,
        "`{source}` diverged: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

fn ironhorse_result(source: &str, expected: &str) {
    let run = dual_run(source).expect("the pinned XS oracle must start");
    assert!(
        matches!(
            run.agreement,
            Agreement::BothComplete | Agreement::IronhorseOnlyComplete
        ),
        "{run:?}",
    );
    assert_eq!(run.ironhorse_result, expected, "for `{source}`");
}

#[test]
fn object_separator_precedes_live_element_reads() {
    agrees("var a=[{toString:function(){a[1]=9;return 1}},2]; var s={toString:function(){a.push(3);return '-'}}; a.join(s)");
    agrees("var a=[1]; var s={toString:function(){Object.defineProperty(a,'0',{get:function(){return 2}});return ','}}; a.join(s)");
}

#[test]
fn symbol_separator_throws_type_error() {
    agrees("try { [1,2].join(Symbol()); false } catch (e) { e instanceof TypeError }");
}

#[test]
fn generic_receivers_read_live_properties() {
    agrees(
        "var a=[1,,3]; Array.prototype[1]=2; var r=a.join('-'); \
         delete Array.prototype[1]; r",
    );
    agrees("Array.prototype.join.call({length:3,0:'a',2:'c'},'|')");
    agrees(
        "var log=[]; var o={ \
           get length(){log.push('length');return 2}, \
           get 0(){log.push('0');return 'a'}, \
           get 1(){log.push('1');return 'b'} \
         }; var sep={toString:function(){log.push('separator');return '-'}}; \
         Array.prototype.join.call(o,sep)+':'+log.join(',')",
    );
    agrees(
        "var log=[]; var p=new Proxy({length:2,0:'x',1:'y'},{ \
           get:function(t,k){log.push(String(k));return t[k]} \
         }); Array.prototype.join.call(p,'-')+':'+log.join(',')",
    );
}

#[test]
fn element_coercion_observes_mutation_and_abrupt_completion() {
    agrees(
        "var a=[{toString:function(){a[1]='changed';return 'first'}},'old']; \
         a.join(':')",
    );
    agrees(
        "var o={length:1,0:{valueOf:function(){return 1}, \
         toString:function(){return 'object'}}}; Array.prototype.join.call(o)",
    );
    agrees(
        "try { Array.prototype.join.call({length:1,0:Symbol()}); false } \
         catch (e) { e instanceof TypeError }",
    );
}

#[test]
fn primitive_typed_array_and_arguments_receivers() {
    agrees("Array.prototype.join.call('abc','-')");
    agrees("Array.prototype.join.call(new Uint8Array([1,2,3]),':')");
    agrees(
        "(function(a,b){b='z';return Array.prototype.join.call(arguments,':')})(1,2)",
    );
}

#[test]
fn coercion_order_and_errors_match_the_spec() {
    agrees(
        "var log=[]; var o={get length(){log.push('length');return 1}, \
         get 0(){log.push('element');return 1}}; \
         try { Array.prototype.join.call(o,Symbol()); } catch(e) {} log.join(',')",
    );
    // The pinned XS oracle applies its non-standard 32-bit practical-length
    // fallback here and skips the observable prefix. IronHorse follows
    // LengthOfArrayLike's safe-integer domain, so pin that behavior directly.
    ironhorse_result(
        "var log=[]; var p=new Proxy({length:9007199254740991},{ \
           get:function(t,k){log.push(String(k));if(k==='1')throw 7;return t[k]} \
         }); var caught; try { Array.prototype.join.call(p); } \
         catch(e){caught=e} caught+':'+log.join(',')",
        "7:length,0,1",
    );
    agrees(
        "try { Array.prototype.join.call(null); false } \
         catch (e) { e instanceof TypeError }",
    );
    agrees("var s='\\uD800'; [s].join().charCodeAt(0)===0xD800");
    agrees("['a','b'].join('\\uD800').charCodeAt(1)===0xD800");
}
