//! Oracle-backed `built-ins/Object` regressions: `hasOwnProperty` coerces
//! its key before its receiver, `%Object.prototype%` is an immutable
//! prototype exotic object, and a Proxy script completion is not mistaken
//! for a null-prototype object the harness cannot render.

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
fn has_own_property_coerces_the_key_before_the_receiver() {
    assert_oracle_result(
        "var hint='',marker={},k={toString:function(){hint='s';throw marker}};var same=false;try{Object.prototype.hasOwnProperty.call(null,k)}catch(e){same=e===marker}same+':'+hint",
        "true:s",
    );
    assert_oracle_result(
        "var k={};k[Symbol.toPrimitive]=function(h){throw h};var r;try{Object.prototype.hasOwnProperty.call(undefined,k)}catch(e){r=e}r",
        "string",
    );
    assert_oracle_result(
        "try{Object.prototype.hasOwnProperty.call(null,'a');'none'}catch(e){e instanceof TypeError}",
        "true",
    );
}

#[test]
fn object_prototype_refuses_a_new_prototype() {
    assert_oracle_result(
        "var P=Object.prototype,r=[];try{Object.setPrototypeOf(P,Object.create(null));r.push('set')}catch(e){r.push(e instanceof TypeError)}r.push(Reflect.setPrototypeOf(P,{}));r.push(Reflect.setPrototypeOf(P,null));r.push(Object.getPrototypeOf(P)===null);r.join()",
        "true,false,true,true",
    );
    assert_oracle_result(
        "var r;try{Object.prototype.__proto__={};r='set'}catch(e){r=e instanceof TypeError}r+':'+(Object.getPrototypeOf(Object.prototype)===null)",
        "true:true",
    );
}

#[test]
fn proxy_completion_renders_through_its_target() {
    assert_oracle_result("new Proxy({}, {})", "[object Object]");
    assert_oracle_result("Object.seal(new Proxy({}, {}))", "[object Object]");
}
