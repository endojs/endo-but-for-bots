use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` diverged: oracle={:?} ironhorse={:?}",
        run.oracle_result,
        run.ironhorse_result,
    );
    assert_eq!(
        run.oracle_result, run.ironhorse_result,
        "`{source}` result differs"
    );
}

#[test]
fn nullish_operands_throw_before_property_key_coercion() {
    for source in [
        "try { Object.getOwnPropertyDescriptor(null, 'x'); false } catch (e) { e instanceof TypeError }",
        "try { Object.getOwnPropertyDescriptor(undefined, 'x'); false } catch (e) { e instanceof TypeError }",
        "var touched=false; var key={toString:function(){touched=true;return 'x'}}; var type; try { Object.getOwnPropertyDescriptor(null,key) } catch(e) { type=e instanceof TypeError } type && !touched",
    ] {
        agrees(source);
    }
}

#[test]
fn non_string_primitives_box_to_objects_without_own_properties() {
    for source in [
        "Object.getOwnPropertyDescriptor(true, 'valueOf') === undefined",
        "Object.getOwnPropertyDescriptor(123, 'toString') === undefined",
        "Object.getOwnPropertyDescriptor(Symbol('x'), 'description') === undefined",
        "Object.getOwnPropertyDescriptor(123n, 'toString') === undefined",
        "var log=[]; var key={toString:function(){log.push('key');return 'x'}}; Object.getOwnPropertyDescriptor(1,key); log.join(',')",
    ] {
        agrees(source);
    }
}

#[test]
fn string_primitives_expose_utf16_indices_and_length_descriptors() {
    for source in [
        "var d=Object.getOwnPropertyDescriptor('foo','0'); d.value+','+d.writable+','+d.enumerable+','+d.configurable",
        "var d=Object.getOwnPropertyDescriptor('foo','length'); d.value+','+d.writable+','+d.enumerable+','+d.configurable",
        "Object.getOwnPropertyDescriptor('', '0') === undefined",
        "Object.getOwnPropertyDescriptor('a', '1') === undefined",
        "var s=String.fromCodePoint(0x1F600); var a=Object.getOwnPropertyDescriptor(s,'0').value.charCodeAt(0); var b=Object.getOwnPropertyDescriptor(s,'1').value.charCodeAt(0); a+','+b",
    ] {
        agrees(source);
    }
}
