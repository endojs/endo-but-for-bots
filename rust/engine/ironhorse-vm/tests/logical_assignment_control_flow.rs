//! F063: removing the coder's optional-target unwraps must preserve both
//! logical-assignment branches, reference evaluation and expression values.

use ironhorse_vm::{parse_symbols_checked, Interp};

#[test]
fn logical_assignment_preserves_values_and_evaluation_counts() {
    for (operator, initial, assigned) in [
        ("&&=", "false", false),
        ("&&=", "true", true),
        ("&&=", "0", false),
        ("||=", "false", true),
        ("||=", "true", false),
        ("||=", "0", true),
        ("??=", "null", true),
        ("??=", "undefined", true),
        ("??=", "0", false),
        ("??=", "false", false),
    ] {
        for (target, stored, accessor, computed) in [
            ("local", "local", false, false),
            ("this.#value", "this.#value", false, false),
            ("object.p", "value", true, false),
            ("object[key()]", "value", true, true),
            ("super.p", "value", true, false),
            ("super[key()]", "value", true, true),
        ] {
            for use_ in [
                "var result=(EXPR);",
                "EXPR; var result=STORED;",
                "for(let i=0;i<1;EXPR){i++;} var result=STORED;",
            ] {
                let body = use_
                    .replace("EXPR", &format!("{target} {operator} rhs()"))
                    .replace("STORED", stored);
                let source = format!(
                    "var value={initial}, right=0, gets=0, sets=0, keys=0;
                     function rhs(){{right++; return 7;}}
                     function key(){{keys++; return 'p';}}
                     var object={{get p(){{gets++; return value;}},
                                  set p(v){{sets++; value=v;}}}};
                     class Base {{ get p(){{gets++; return value;}}
                                   set p(v){{sets++; value=v;}} }}
                     class C extends Base {{
                         #value={initial};
                         method(){{
                             let local={initial};
                             {body}
                             return String(result)+','+String({stored})+','+
                                 right+','+gets+','+sets+','+keys;
                         }}
                     }}
                     new C().method();"
                );
                let (code, symbols) = ironhorse_compile::compile_atoms(&source).unwrap();
                let mut vm = Interp::new();
                vm.link_intrinsics(&parse_symbols_checked(&symbols).unwrap());
                let out = vm.run(&code);
                assert!(out.completed, "{source}: {:?}", out.halt);
                let expected = if assigned { "7" } else { initial };
                assert_eq!(
                    out.result,
                    format!(
                        "{expected},{expected},{},{},{},{}",
                        u8::from(assigned),
                        u8::from(accessor),
                        u8::from(accessor && assigned),
                        u8::from(computed),
                    ),
                    "{source}",
                );
            }
        }
    }
}
