//! Observable native-error properties are read only at the host throw seam.
use ironhorse_262::{dual_run, Agreement};

#[test]
fn uncaught_native_errors_observe_mutated_properties_and_hooks() {
    for (source, expected) in [
        ("try { (0)() } catch(e) { e.message += ' context'; throw e }", "TypeError: call: not a function context"),
        ("try { (0)() } catch(e) { e.name='Changed'; e.message='detail'; throw e }", "Changed: detail"),
        ("try { (0)() } catch(e) { Object.defineProperty(e,'message',{get(){return 'getter detail'}}); throw e }", "TypeError: getter detail"),
        ("try { (0)() } catch(e) { Object.defineProperty(e,'name',{get(){return 'GetterName'}}); throw e }", "GetterName: call: not a function"),
        ("try { (0)() } catch(e) { e.toString=function(){return 'custom'}; throw e }", "custom"),
        ("(0)()", "TypeError: call: not a function"),
    ] {
        let run = dual_run(source).expect("oracle starts");
        assert_eq!(run.agreement, Agreement::BothAbort, "{source}: {run:?}");
        assert_eq!(run.oracle_error, expected, "XS: {source}");
        assert_eq!(run.ironhorse_error, expected, "IH: {source}");
    }
}

#[test]
fn caught_native_errors_do_not_run_host_rendering_hooks() {
    let run=dual_run("var calls=0;try { try {(0)()}catch(e){e.toString=function(){calls++;return 'custom'};throw e} }catch(e){} calls").unwrap();
    assert_eq!(run.agreement, Agreement::BothComplete, "{run:?}");
    assert_eq!(run.oracle_result, "0");
    assert_eq!(run.ironhorse_result, "0");
}
