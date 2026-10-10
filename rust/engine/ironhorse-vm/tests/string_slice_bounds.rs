//! F044: bounded slicing preserves UTF-16 and observable coercion order.
use ironhorse_vm::{parse_symbols, Interp};

fn check(source: &str, expected: &str) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let out = vm.run(&code);
    assert!(out.completed, "{source}: {:?}", out.halt);
    assert_eq!(out.result, expected, "{source}");
}

#[test]
fn slice_and_substring_preserve_code_units_and_boundaries() {
    check(
        "var s='a\\ud800\\udc00\\udfffz'; \
         [s.slice(1,2).charCodeAt(0),s.substring(3,4).charCodeAt(0), \
          s.slice(-1),s.slice(4,1),s.substring(4,1).length, \
          s.slice(-Infinity,1),s.substring(Infinity,4), \
          s.slice(NaN,1),s.substring(-2,1),s.slice(1,undefined).length].join('|')",
        "55296|57343|z||3|a|z|a|a|4",
    );
}

#[test]
fn slicing_converts_receiver_then_start_then_end_and_retains_original_string() {
    for method in ["slice", "substring"] {
        check(
            &format!("var log='';var text='abc'; \
                var receiver={{toString(){{log+='r';return text}}}}; \
                var start={{valueOf(){{log+='s';text='changed';var a='x'.repeat(10000);return 1}}}}; \
                var end={{valueOf(){{log+='e';return 2}}}}; \
                var result=String.prototype.{method}.call(receiver,start,end);log+':'+result"),
            "rse:b",
        );
        check(
            &format!("var log='';try{{String.prototype.{method}.call('abc', \
                {{valueOf(){{throw 42}}}},{{valueOf(){{log+='e';return 2}}}})}}catch(e){{log+=e}}log"),
            "42",
        );
        check(
            &format!(
                "[String.prototype.{method}.call(123,1,2), \
                new String('abc').{method}(1,2), ''.{method}(1,2)].join('|')"
            ),
            "2|b|",
        );
        check(
            &format!(
                "var count=0;for(var value of [null,undefined]){{ \
                try{{String.prototype.{method}.call(value,{{valueOf(){{count+=10;return 0}}}})}} \
                catch(e){{if(e instanceof TypeError)count++}}}}count"
            ),
            "2",
        );
    }
}
