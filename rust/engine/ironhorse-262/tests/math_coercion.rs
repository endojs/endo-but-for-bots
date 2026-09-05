//! Observable ECMAScript ToNumber behavior across the Math namespace.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (halt: {:?})",
        run.ironhorse_halt,
    );
    assert!(
        run.result_agrees,
        "`{source}` diverged: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

#[test]
fn unary_math_functions_apply_to_number() {
    for source in [
        "Math.abs('-3')",
        "Math.sqrt('81')",
        "Math.ceil(new Number(1.25))",
        "var n=0;Math.floor({valueOf:function(){n++;return '4.9'}})+':'+n",
        "var log='';Math.sin({valueOf:function(){log+='v';return {}},toString:function(){log+='s';return '0'}})+':'+log",
        "var hint='';Math.abs({[Symbol.toPrimitive]:function(h){hint=h;return '-7'}})+':'+hint",
        "try{Math.cos(Symbol())}catch(e){e instanceof TypeError}",
        "try{Math.trunc(1n)}catch(e){e instanceof TypeError}",
    ] {
        agrees(source);
    }
}

#[test]
fn multi_argument_math_coerces_left_to_right() {
    for source in [
        "var log='';var a={valueOf:function(){log+='a';return '2'}};var b={toString:function(){log+='b';return '3'}};Math.pow(a,b)+':'+log",
        "var log='';var a={valueOf:function(){log+='a';return '3'}};var b={valueOf:function(){log+='b';return '4'}};Math.hypot(a,b)+':'+log",
        "Math.imul('6','7')",
        "Math.atan2(new Number(0),'-1') === Math.PI",
        "var marker={};try{Math.pow({valueOf:function(){throw marker}},{valueOf:function(){throw 2}})}catch(e){e===marker}",
    ] {
        agrees(source);
    }
}

#[test]
fn extrema_coerce_all_arguments_even_after_nan() {
    for source in [
        "Math.max('2',new Number(3),true)",
        "Math.min('2',new Number(-3),false)",
        "var n=0;var r=Math.max(NaN,{valueOf:function(){n++;return 1}});String(r)+':'+n",
        "try{Math.min(NaN,Symbol())}catch(e){e instanceof TypeError}",
        "var log='';var a={valueOf:function(){log+='a';return NaN}};var b={valueOf:function(){log+='b';return 1}};String(Math.max(a,b))+':'+log",
        "var marker={};try{Math.max(NaN,{valueOf:function(){throw marker}})}catch(e){e===marker}",
    ] {
        agrees(source);
    }
}
