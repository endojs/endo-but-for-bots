use xs_oracle::{is_resource_abort, run, run_cranks};

#[test]
fn ordinary_empty_and_undefined_throws_are_not_host_aborts() {
    for (source, rendered) in [
        ("throw ''", ""),
        ("throw undefined", "undefined"),
        (
            "throw 'Maximum call stack size exceeded'",
            "Maximum call stack size exceeded",
        ),
        (
            "throw {toString(){throw undefined}}",
            "(exception stringification threw)",
        ),
    ] {
        let outcome = run(source).expect("oracle starts");
        assert!(!outcome.completed, "{source}");
        assert_eq!(outcome.exit_status, 0, "{source}");
        assert!(!is_resource_abort(outcome.exit_status));
        assert_eq!(outcome.error, rendered, "{source}");
    }
    let outcomes = run_cranks(&["1", "throw undefined"]).expect("oracle starts");
    assert!(outcomes[0].completed);
    assert_eq!(outcomes[1].exit_status, 0);
    assert_eq!(outcomes[1].error, "undefined");
}

#[test]
fn actual_stack_exhaustion_carries_the_original_resource_status() {
    let source = "function recurse(){return 1+recurse()} recurse()";
    let outcome = run(source).expect("oracle starts");
    assert!(!outcome.completed);
    assert!(!outcome.bytecode.is_empty());
    assert!(is_resource_abort(outcome.exit_status), "{outcome:?}");
    let outcomes = run_cranks(&["1", source]).expect("oracle starts");
    assert_eq!(outcomes[1].exit_status, outcome.exit_status);
    // A failure during diagnostic rendering must not relabel the original
    // guest throw as a fatal resource abort.
    let diagnostic =
        run("throw {toString(){function recurse(){return 1+recurse()}return recurse()}}").unwrap();
    assert_eq!(diagnostic.exit_status, 0);
    assert_eq!(diagnostic.error, "(exception stringification threw)");
    assert!(!is_resource_abort(0));
    assert!(!is_resource_abort(-1));
    assert!(!is_resource_abort(i32::MAX));
}

#[test]
fn module_rejection_does_not_use_undefined_as_fulfillment() {
    struct Fixture(std::path::PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let fixture = Fixture(std::env::temp_dir().join(format!(
        "xs-oracle-exit-status-modules-{}",
        std::process::id()
    )));
    std::fs::create_dir_all(&fixture.0).unwrap();
    for (index, source, completed, error) in [
        (0, "throw undefined", false, "undefined"),
        (1, "throw ''", false, ""),
        (2, "await Promise.reject(undefined)", false, "undefined"),
        (3, "globalThis.result = 'ok'", true, ""),
        (
            4,
            "throw {toString(){function recurse(){return 1+recurse()}return recurse()}}",
            false,
            "(exception stringification threw)",
        ),
        (
            5,
            "throw {toString(){throw undefined}}",
            false,
            "(exception stringification threw)",
        ),
    ] {
        let name = format!("main{index}.js");
        std::fs::write(fixture.0.join(&name), source).unwrap();
        let outcome = xs_oracle::run_module_dir(&fixture.0, &name).expect("oracle starts");
        assert_eq!(outcome.completed, completed, "{source}: {outcome:?}");
        assert_eq!(outcome.exit_status, 0, "{source}");
        assert_eq!(outcome.error, error, "{source}");
        if completed {
            assert_eq!(outcome.result, "ok");
        }
    }
}
