//! Oracle-backed `Symbol.for` and `Symbol.keyFor` coercion regressions.

use ironhorse_262::{dual_run, Agreement};

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

#[test]
fn symbol_for_coerces_primitive_keys_to_strings() {
    assert_oracle_result(
        "(Symbol.for(1)===Symbol.for('1'))+':' +\
         (Symbol.for(true)===Symbol.for('true'))+':' +\
         (Symbol.for(null)===Symbol.for('null'))+':' +\
         (Symbol.for(undefined)===Symbol.for('undefined'))+':' +\
         (Symbol.for(12n)===Symbol.for('12'))",
        "true:true:true:true:true",
    );
}

#[test]
fn symbol_for_uses_string_hint_and_propagates_abrupt_completion() {
    assert_oracle_result(
        "var log=[]; var key={\
           [Symbol.toPrimitive]:function(hint){log.push(hint);return 'shared'}\
         }; var same=Symbol.for(key)===Symbol.for('shared'); same+':'+log.join(',')",
        "true:string",
    );
    assert_oracle_result(
        "var marker={}; var same=false; try{\
           Symbol.for({toString:function(){throw marker}})\
         }catch(e){same=e===marker} same",
        "true",
    );
}

#[test]
fn symbol_keys_are_rejected_and_key_for_requires_a_symbol() {
    assert_oracle_result(
        "var a=false,b=false; try{Symbol.for(Symbol('x'))}catch(e){\
           a=e instanceof TypeError\
         } try{Symbol.keyFor('x')}catch(e){b=e instanceof TypeError} a+':'+b",
        "true:true",
    );
}

#[test]
fn key_for_distinguishes_registered_and_local_symbols() {
    assert_oracle_result(
        "Symbol.keyFor(Symbol.for('é'))+':'+(Symbol.keyFor(Symbol('é'))===undefined)",
        "é:true",
    );
}
