//! Numeric intrinsic constants retain their attributes through lazy linking.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle starts");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "{source}: oracle={:?}, ironhorse={:?}, halt={:?}",
        run.oracle_result,
        run.ironhorse_result,
        run.ironhorse_halt,
    );
    assert!(
        run.result_agrees,
        "{source}: oracle={:?}, ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

#[test]
fn math_and_number_constant_descriptors_are_immutable() {
    for (owner, names) in [
        ("Math", "E,LN10,LN2,LOG10E,LOG2E,PI,SQRT1_2,SQRT2"),
        (
            "Number",
            "EPSILON,MAX_SAFE_INTEGER,MAX_VALUE,MIN_SAFE_INTEGER,MIN_VALUE,NaN,NEGATIVE_INFINITY,POSITIVE_INFINITY",
        ),
    ] {
        for name in names.split(',') {
            assert_result_agrees(&format!(
                "var descriptor=Object.getOwnPropertyDescriptor({owner},'{name}');\
                 [Object.is(descriptor.value,{owner}['{name}']),descriptor.writable,\
                  descriptor.enumerable,descriptor.configurable,\
                  'get' in descriptor,'set' in descriptor].join(',');"
            ));
        }
    }
}

#[test]
fn typed_array_constant_descriptors_match_on_constructor_and_prototype() {
    for constructor in [
        "Int8Array",
        "Uint8Array",
        "Uint8ClampedArray",
        "Int16Array",
        "Uint16Array",
        "Int32Array",
        "Uint32Array",
        "Float32Array",
        "Float64Array",
        "BigInt64Array",
        "BigUint64Array",
    ] {
        for suffix in ["", ".prototype"] {
            assert_result_agrees(&format!(
                "var descriptor=Object.getOwnPropertyDescriptor({constructor}{suffix},'BYTES_PER_ELEMENT');\
                 [descriptor.value,descriptor.writable,descriptor.enumerable,descriptor.configurable].join(',');"
            ));
        }
    }
}

#[test]
fn constants_reject_assignment_deletion_and_redefinition() {
    for expression in [
        "Math.PI",
        "Number.MAX_VALUE",
        "Uint8Array.BYTES_PER_ELEMENT",
        "Uint8Array.prototype.BYTES_PER_ELEMENT",
    ] {
        assert_result_agrees(&format!(
            "function check() {{ 'use strict'; var caught=false;\
             try {{ {expression}=0; }} catch(error) {{ caught=error instanceof TypeError; }}\
             return caught; }} check();"
        ));
    }
    assert_result_agrees(
        "var initial=Math.PI; Math.PI=0;\
         [Math.PI===initial,delete Math.PI,\
          Reflect.defineProperty(Math,'PI',{value:0}),\
          Reflect.defineProperty(Math,'PI',{value:initial})].join(',');",
    );
}

#[test]
fn own_key_materialization_does_not_enumerate_constants_as_descriptors() {
    for owner in ["Math", "Number", "Uint8Array", "Uint8Array.prototype"] {
        for operation in [
            "Object.create(null,source)",
            "Object.defineProperties({},source)",
        ] {
            assert_result_agrees(&format!(
                "var source={owner},seen=false;\
                 Object.defineProperty(source,'entry',{{get(){{seen=this===source;return {{value:42}};}},enumerable:true}});\
                 var result={operation}; [seen,result.entry,Object.getOwnPropertyNames(result).join(',')].join(':');"
            ));
        }
    }
}

#[test]
fn runtime_linking_and_eval_preserve_constant_attributes() {
    assert_result_agrees(
        "var owner=globalThis['Ma'+'th']; Reflect.ownKeys(owner);\
         eval('Math.PI=0');\
         var descriptor=Object.getOwnPropertyDescriptor(owner,'P'+'I');\
         [descriptor.value>3,descriptor.writable,descriptor.enumerable,descriptor.configurable].join(',');",
    );
}
