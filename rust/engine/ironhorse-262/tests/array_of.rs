//! Oracle-backed `Array.of` regressions covering constructor selection,
//! element definitions, the final length assignment, and abrupt completion.

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
fn creates_arrays_from_items_and_exposes_standard_metadata() {
    assert_oracle_result(
        "var a=Array.of(3); a.length+':'+a[0]+':'+(a instanceof Array)",
        "1:3:true",
    );
    assert_oracle_result(
        "Array.of.length+':'+Array.of.name+':'+Object.prototype.propertyIsEnumerable.call(Array,'of')",
        "0:of:false",
    );
}

#[test]
fn custom_constructor_receives_length_and_nonconstructors_fall_back() {
    assert_oracle_result(
        "var calls=0,arg=-1;function C(n){calls++;arg=n}var r=Array.of.call(C,'a','b');calls+':'+arg+':'+(r instanceof C)+':'+r.length+':'+r[0]+r[1]",
        "1:2:true:2:ab",
    );
    assert_oracle_result(
        "var r=Array.of.call(Math.cos,1,2);(r instanceof Array)+':'+r.length+':'+r.join(',')",
        "true:2:1,2",
    );
}

#[test]
fn element_creation_bypasses_setters_and_redefines_configurable_properties() {
    assert_oracle_result(
        "var hits=0;function C(){Object.defineProperty(C.prototype,'0',{set:function(){hits++}})}var r=Array.of.call(C,7);hits+':'+r[0]+':'+Object.prototype.hasOwnProperty.call(r,'0')",
        "0:7:true",
    );
    assert_oracle_result(
        "function C(){Object.defineProperty(this,'0',{value:1,writable:false,enumerable:false,configurable:true})}var r=Array.of.call(C,2),d=Object.getOwnPropertyDescriptor(r,'0');r[0]+':'+d.writable+':'+d.enumerable+':'+d.configurable",
        "2:true:true:true",
    );
}

#[test]
fn proxy_observes_property_definitions_then_length_assignment() {
    assert_oracle_result(
        "var log=[];function C(){return new Proxy({}, {defineProperty:function(t,p,d){log.push('d'+p+':'+d.value);return Reflect.defineProperty(t,p,d)},set:function(t,p,v,r){log.push('s'+p+':'+v);return Reflect.set(t,p,v,r)}})}var r=Array.of.call(C,'x','y');log.join(',')+':'+r.length+':'+r[0]+r[1]",
        "d0:x,d1:y,slength:2,dlength:2:2:xy",
    );
}

#[test]
fn constructor_definition_and_length_failures_are_catchable() {
    assert_oracle_result(
        "var marker={};function C(){throw marker}var same=false;try{Array.of.call(C,1)}catch(e){same=e===marker}same",
        "true",
    );
    assert_oracle_result(
        "function C(){Object.preventExtensions(this)}try{Array.of.call(C,1);false}catch(e){e instanceof TypeError}",
        "true",
    );
    assert_oracle_result(
        "var marker={};function C(){return new Proxy({},{defineProperty:function(){throw marker}})}var same=false;try{Array.of.call(C,1)}catch(e){same=e===marker}same",
        "true",
    );
    assert_oracle_result(
        "var marker={};function C(){Object.defineProperty(this,'length',{set:function(){throw marker}})}var same=false;try{Array.of.call(C)}catch(e){same=e===marker}same",
        "true",
    );
}

#[test]
fn array_targets_honor_non_writable_length() {
    assert_oracle_result(
        "function C(){var a=[];Object.defineProperty(a,'length',{writable:false});return a}try{Array.of.call(C,1);false}catch(e){e instanceof TypeError}",
        "true",
    );
    assert_oracle_result(
        "function C(){var a=[];Object.defineProperty(a,'length',{writable:false});return a}try{Array.of.call(C);false}catch(e){e instanceof TypeError}",
        "true",
    );
}
