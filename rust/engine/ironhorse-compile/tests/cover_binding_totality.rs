//! Assignment references are not formal-parameter binding targets.

use ironhorse_compile::{compile_atoms_goal, Goal, ParseErrorKind, Parser};

#[test]
fn spread_in_an_ordinary_parenthesized_expression_is_a_syntax_error() {
    for source in [
        "(...items);",
        "(a,...items);",
        "((...items));",
        "new (...items);",
        "f((...items));",
        "async((...items));",
    ] {
        for (goal, strict) in [
            (Goal::Script, false),
            (Goal::Script, true),
            (Goal::Eval, false),
            (Goal::Eval, true),
            (Goal::Module, true),
        ] {
            let result = std::panic::catch_unwind(|| compile_atoms_goal(source, goal, strict));
            assert!(
                matches!(result, Ok(Err(ref error)) if error.kind == ParseErrorKind::Syntax),
                "{goal:?}, strict={strict}: {source}"
            );
        }
    }
}

#[test]
fn spread_and_rest_in_their_own_grammars_still_compile() {
    for source in [
        "(...items)=>items;",
        "(a,...items)=>items;",
        "async(...items);",
        "f(...items);",
        "[...items];",
        "({...items});",
    ] {
        for (goal, strict) in [
            (Goal::Script, false),
            (Goal::Script, true),
            (Goal::Eval, false),
            (Goal::Eval, true),
            (Goal::Module, true),
        ] {
            compile_atoms_goal(source, goal, strict)
                .unwrap_or_else(|error| panic!("{goal:?}, strict={strict}: {source}: {error:?}"));
        }
    }
}

#[test]
fn member_references_in_arrow_parameters_are_syntax_errors_not_compiler_panics() {
    let mut failures = Vec::new();
    let mut count = 0;
    for target in ["object.x", "object[key]", "this.#x"] {
        for parameters in [
            "TARGET",
            "TARGET=0",
            "...TARGET",
            "[TARGET]",
            "[TARGET=0]",
            "[...TARGET]",
            "{x:TARGET}",
            "{x:TARGET=0}",
            "{...TARGET}",
        ] {
            for prefix in ["", "async "] {
                let source = format!(
                    "class C {{ #x; m() {{ return {prefix}({}) => 0; }} }}",
                    parameters.replace("TARGET", target),
                );
                for (goal, strict) in [
                    (Goal::Script, false),
                    (Goal::Script, true),
                    (Goal::Eval, false),
                    (Goal::Eval, true),
                    (Goal::Module, true),
                ] {
                    let result =
                        std::panic::catch_unwind(|| compile_atoms_goal(&source, goal, strict));
                    if !matches!(result, Ok(Err(ref error)) if error.kind == ParseErrorKind::Syntax)
                    {
                        let outcome = match result {
                            Ok(Ok(_)) => "compiled".to_owned(),
                            Ok(Err(error)) => format!("{:?}", error.kind),
                            Err(_) => "panicked".to_owned(),
                        };
                        failures.push(format!("{goal:?}, strict={strict}: {source}: {outcome}"));
                    }
                    // Pin the rejection to parsing, not a downstream guard
                    // that happens to turn the coder's assertion into an error.
                    let module = goal == Goal::Module;
                    let mut parser = Parser::new(&source, strict || module, module).unwrap();
                    let parsed = if module {
                        parser.parse_module()
                    } else {
                        parser.parse_program(strict)
                    };
                    if !matches!(parsed, Err(ref error) if error.kind == ParseErrorKind::Syntax) {
                        failures.push(format!(
                            "parser accepted {goal:?}, strict={strict}: {source}"
                        ));
                    }
                    count += 1;
                }
            }
        }
    }
    assert_eq!(count, 270);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn arrow_binding_defaults_and_computed_keys_may_read_members() {
    let mut count = 0;
    for parameters in [
        "p=object.x",
        "[p=object[key]]",
        "{[object.x]:p}",
        "...[p]",
        "...{x:p}",
        "{x:p=this.#x}",
    ] {
        for prefix in ["", "async "] {
            let source = format!("class C {{ #x; m() {{ return {prefix}({parameters}) => p; }} }}");
            for (goal, strict) in [
                (Goal::Script, false),
                (Goal::Script, true),
                (Goal::Eval, false),
                (Goal::Eval, true),
                (Goal::Module, true),
            ] {
                compile_atoms_goal(&source, goal, strict).unwrap_or_else(|error| {
                    panic!("{goal:?}, strict={strict}: {source}: {error:?}")
                });
                count += 1;
            }
        }
    }
    assert_eq!(count, 60);
}

#[test]
fn the_same_member_references_remain_valid_assignment_targets() {
    let mut count = 0;
    for target in ["object.x", "object[key]", "this.#x"] {
        for statement in [
            "TARGET=0;",
            "(TARGET)=0;",
            "TARGET+=1;",
            "TARGET++;",
            "[TARGET]=source;",
            "[TARGET=0]=source;",
            "[...TARGET]=source;",
            "({x:TARGET}=source);",
            "({x:TARGET=0}=source);",
            "({...TARGET}=source);",
            "for(TARGET of source){}",
            "for(TARGET in source){}",
        ] {
            let source = format!(
                "class C {{ #x; m() {{ {} }} }}",
                statement.replace("TARGET", target)
            );
            for (goal, strict) in [
                (Goal::Script, false),
                (Goal::Script, true),
                (Goal::Eval, false),
                (Goal::Eval, true),
                (Goal::Module, true),
            ] {
                compile_atoms_goal(&source, goal, strict).unwrap_or_else(|error| {
                    panic!("{goal:?}, strict={strict}: {source}: {error:?}")
                });
                count += 1;
            }
        }
    }
    assert_eq!(count, 180);
}
