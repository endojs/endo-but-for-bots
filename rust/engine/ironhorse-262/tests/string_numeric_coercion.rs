//! Oracle-backed regressions for the `ToIntegerOrInfinity` boundary shared by
//! String indexing, slicing, searching, and repetition methods.

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
fn string_methods_coerce_string_and_wrapper_positions() {
    for source in [
        "'abc'.charAt('1')",
        "'abc'.charCodeAt(new Number(1))",
        "String.fromCodePoint(0x1F600).codePointAt('0')",
        "'abc'.at(new String('-1'))",
        "'abcdef'.slice('1', new Number(4))",
        "'abcdef'.substring(new Number(4), '1')",
        "'ab'.repeat(new Number(3))",
        "'abcdef'.startsWith('bc', new Number(1))",
        "'abcdef'.endsWith('cd', '4')",
        "'abcdef'.includes('cd', new Number(2))",
    ] {
        agrees(source);
    }
}

#[test]
fn string_position_coercion_observes_to_primitive_order() {
    for source in [
        "var log=[]; var p={valueOf:function(){log.push('valueOf');return {}},toString:function(){log.push('toString');return '1'}}; 'abc'.at(p)+':'+log.join(',')",
        "var log=[]; var a={valueOf:function(){log.push('start');return '1'}}; var b={valueOf:function(){log.push('end');return '4'}}; 'abcdef'.slice(a,b)+':'+log.join(',')",
        "var log=[]; var p={ [Symbol.toPrimitive]:function(h){log.push(h);return 2} }; 'abc'.charAt(p)+':'+log.join(',')",
    ] {
        agrees(source);
    }
}

#[test]
fn string_position_errors_are_catchable() {
    for source in [
        "try { 'abc'.at(Symbol()); false } catch (e) { e instanceof TypeError }",
        "try { 'abc'.charAt(0n); false } catch (e) { e instanceof TypeError }",
        "try { 'abc'.slice({valueOf:function(){return 0n}}); false } catch (e) { e instanceof TypeError }",
        "var marker={}; try { 'abc'.includes('a',{valueOf:function(){throw marker}}); false } catch(e) { e===marker }",
        "try { 'abc'.repeat(-1); false } catch (e) { e instanceof RangeError }",
        "try { 'abc'.repeat(Infinity); false } catch (e) { e instanceof RangeError }",
    ] {
        agrees(source);
    }
}
