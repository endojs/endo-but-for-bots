use ironhorse_regexp::{compile, compile_checked, match_regexp, CompileError};

#[test]
fn oversized_numeric_references_are_syntax_errors() {
    assert_eq!(r"(a)\2147483648".len(), 14);
    for number in [
        "2",
        "2147483647",
        "2147483648",
        "4294967295",
        "4294967296",
        "4294967297",
        "18446744073709551616",
        "999999999999999999999999999999999999999999",
    ] {
        for flags in ["", "u", "v"] {
            for pattern in [format!(r"(a)\{number}"), format!(r"(?<=\{number}(a))b")] {
                assert!(
                    matches!(compile(&pattern, flags), Err(CompileError::Syntax(_))),
                    "{pattern:?} / {flags}"
                );
            }
        }
    }
}

#[test]
fn ordinary_and_unset_references_still_match() {
    for (pattern, text) in [
        (r"(a)\1", "aa"),
        (r"\1(a)", "a"),
        (r"(?<=\1(a))b", "aab"),
        (r"(?<x>a)\k<x>", "aa"),
        (r"\k<x>(?<x>a)", "a"),
        (r"(?<=\k<x>(?<x>a))b", "aab"),
    ] {
        for flags in ["", "u", "v"] {
            let program = compile(pattern, flags).unwrap();
            let out = match_regexp(&program, text.as_bytes(), 0);
            assert!(out.matched && !out.aborted, "{pattern} / {flags}: {out:?}");
        }
    }
}

#[test]
fn oversized_quantifiers_clamp_without_wrapping_or_losing_order() {
    for bounds in [
        "2147483648",
        "4294967296",
        "4294967297",
        "9007199254740991",
        "18446744073709551616",
        "9007199254740991,",
        "9007199254740991,9007199254740991",
        "4294967296,4294967297",
        "0004294967297,4294967297",
        "2147483647,2147483648",
    ] {
        for flags in ["", "u", "v"] {
            let pattern = format!("b{{{bounds}}}");
            let program = compile(&pattern, flags)
                .unwrap_or_else(|error| panic!("{pattern:?} / {flags}: {error:?}"));
            for subject in ["", "a", "b", "bbbb"] {
                let out = match_regexp(&program, subject.as_bytes(), 0);
                assert!(
                    !out.matched && !out.aborted && !out.resource_limit,
                    "{pattern:?} / {flags} on {subject:?}: {out:?}"
                );
            }
        }
    }
    for bounds in [
        "4294967297,4294967296",
        "2147483649,2147483648",
        "2147483648,2147483647",
        "18446744073709551616,9007199254740991",
        "10,09",
    ] {
        for flags in ["", "u", "v"] {
            assert!(
                matches!(
                    compile(&format!("a{{{bounds}}}"), flags),
                    Err(CompileError::Syntax(_))
                ),
                "{bounds} / {flags}"
            );
        }
    }
}

#[test]
fn overflowing_decimal_remains_subject_to_work_admission() {
    let pattern = format!(r"(a)\{}", "9".repeat(10_000));
    assert_eq!(
        compile_checked(&pattern, "u", pattern.len() as u64 + 100, None)
            .result
            .unwrap_err(),
        CompileError::BudgetExceeded
    );
}
