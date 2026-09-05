//! Ordinary integer-indexed property names participate in the same own
//! enumerability query as other string keys.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
    assert!(run.result_agrees, "results must agree for {source}");
}

#[test]
fn integer_indexed_ordinary_properties_are_enumerable() {
    assert_result_agrees(
        "var object = { 1: 'one' }; object.propertyIsEnumerable('1') + ':' + object.propertyIsEnumerable('2')",
        "true:false",
    );
}

#[test]
fn computed_numeric_class_fields_are_enumerable() {
    assert_result_agrees(
        "var C = class { [10] = 'ten'; }; var c = new C(); c.propertyIsEnumerable('10')",
        "true",
    );
}

#[test]
fn boot_default_names_are_sound_own_property_queries() {
    assert_result_agrees(
        "Date.propertyIsEnumerable('UTC') + ':' + Date.prototype.propertyIsEnumerable('getTime') + ':' + ({hasOwnProperty: 1}).propertyIsEnumerable('hasOwnProperty')",
        "false:false:true",
    );
}

#[test]
fn primitive_receivers_and_keys_follow_to_object_and_to_property_key() {
    assert_result_agrees(
        "Object.prototype.propertyIsEnumerable.call('ab', 0) + ':' + Object.prototype.propertyIsEnumerable.call('ab', 'length') + ':' + ({true: 1}).propertyIsEnumerable(true)",
        "true:false:true",
    );
    assert_result_agrees(
        "var calls='';var key={toString:function(){calls+='k';return 'x'}};var threw=false;try{Object.prototype.propertyIsEnumerable.call(null,key)}catch(e){threw=e instanceof TypeError}threw+':'+calls",
        "true:k",
    );
}

#[test]
fn proxy_get_own_property_trap_controls_enumerability() {
    assert_result_agrees(
        "var log='';var p=new Proxy({x:1},{getOwnPropertyDescriptor:function(t,k){log+=k;return {value:1,writable:true,enumerable:false,configurable:true}}});p.propertyIsEnumerable('x')+':'+log",
        "false:x",
    );
}
