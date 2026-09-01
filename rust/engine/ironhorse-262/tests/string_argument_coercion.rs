//! Oracle-backed regressions for String argument `ToString` and `IsRegExp`
//! semantics.

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
fn concat_stringifies_ordinary_values_and_wrappers() {
    for source in [
        "'x'.concat(1, true, null, undefined, 2n)",
        "'x'.concat(new Number(3))",
        "'x'.concat(new Boolean(false))",
        "'x'.concat(new String('y'))",
        "String.prototype.concat.call(12, 34)",
        "'x'.concat(Object(4n))",
    ] {
        agrees(source);
    }
}

#[test]
fn native_wrapper_to_string_methods_keep_their_receiver() {
    for source in [
        "String(new Number(3))",
        "Number.prototype.toString.call(new Number(3))",
        "Boolean.prototype.toString.call(new Boolean(false))",
        "String.prototype.toString.call(new String('y'))",
    ] {
        agrees(source);
    }
}

#[test]
fn implicit_to_primitive_methods_stay_deleted_across_eval_relink() {
    agrees(
        "delete Number.prototype.toString; delete Number.prototype.valueOf; eval('0'); try { String(new Number(3)); false } catch (e) { e instanceof TypeError }",
    );
}

#[test]
fn concat_observes_left_to_right_coercion_and_errors() {
    for source in [
        "var log=[]; var a={toString:function(){log.push('a');return 'A'}}; var b={ [Symbol.toPrimitive]:function(h){log.push('b:'+h);return 'B'} }; 'x'.concat(a,b)+':'+log.join(',')",
        "try { 'x'.concat(Symbol()); false } catch (e) { e instanceof TypeError }",
        "var marker={}; try { 'x'.concat({toString:function(){throw marker}}); false } catch(e) { e===marker }",
    ] {
        agrees(source);
    }
}

#[test]
fn search_methods_stringify_non_regexp_values() {
    for source in [
        "'a1b'.includes(1)",
        "'atrueb'.startsWith(true, 1)",
        "'abc12'.endsWith(new Number(12))",
        "var log=[]; var s={toString:function(){log.push('search');return 'b'}}; var p={valueOf:function(){log.push('position');return 1}}; 'abc'.includes(s,p)+':'+log.join(',')",
        "try { 'abc'.includes(Symbol()); false } catch (e) { e instanceof TypeError }",
    ] {
        agrees(source);
    }
}

#[test]
fn search_methods_apply_is_regexp_before_to_string() {
    for source in [
        "try { 'abc'.includes(/b/); false } catch (e) { e instanceof TypeError }",
        "try { 'abc'.startsWith({[Symbol.match]:true}); false } catch (e) { e instanceof TypeError }",
        "var r=/b/; r[Symbol.match]=false; 'a/b/c'.includes(r)",
        "var log=[]; var s={get [Symbol.match](){log.push('match');return false},toString:function(){log.push('string');return 'b'}}; 'abc'.endsWith(s)+':'+log.join(',')",
        "var marker={}; var s={get [Symbol.match](){throw marker}}; try { 'abc'.includes(s); false } catch(e) { e===marker }",
    ] {
        agrees(source);
    }
}
