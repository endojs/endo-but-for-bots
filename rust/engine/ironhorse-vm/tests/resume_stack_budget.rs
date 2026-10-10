//! F095: reinstalling a suspended activation must admit its saved slots.
use ironhorse_vm::{parse_symbols, Halt, Interp};

fn locals(count: usize) -> String {
    (0..count).map(|i| format!("var v{i}=0; ")).collect()
}

fn run(source: &str, overflow: bool) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let out = vm.run(&code);
    if overflow {
        assert!(matches!(out.halt, Halt::StackOverflow(_)), "{:?}", out.halt);
        assert!(!out.completed);
        assert_eq!(vm.global_string("after").as_deref(), Some("no"));
    } else {
        assert!(out.completed, "{:?}", out.halt);
        assert_eq!(vm.global_string("after").as_deref(), Some("yes"));
    }
}

#[test]
fn generator_resume_admits_saved_locals_before_running_body() {
    for (count, overflow) in [(200, false), (3800, true)] {
        run(
            &format!(
                "var after='no'; function* g() {{ {} yield 1; after='yes'; }} \
             var it=g(); it.next(); function driver() {{ {} it.next(); }} driver();",
                locals(count),
                locals(400),
            ),
            overflow,
        );
    }
}

#[test]
fn async_generator_resume_admits_saved_locals_before_running_body() {
    for (count, overflow) in [(200, false), (3800, true)] {
        run(
            &format!(
                "var after='no'; async function* g() {{ {} yield 1; after='yes'; }} \
             var it=g(); it.next().then(function() {{ {} it.next(); }});",
                locals(count),
                locals(400),
            ),
            overflow,
        );
    }
}

#[test]
fn async_function_resume_admits_saved_locals_before_running_body() {
    for (count, overflow) in [(200, false), (4100, true)] {
        run(
            &format!(
                "var after='no'; async function f() {{ {} await 1; after='yes'; }} f();",
                locals(count),
            ),
            overflow,
        );
    }
}
