//! Standalone before/after probe, compiled against each regexp library revision.
use std::hint::black_box;
use std::time::Instant;

fn cases() -> Vec<(&'static str, String, &'static str)> {
    vec![
        ("literal", "abcdefgh".into(), ""),
        ("sequence", "a".repeat(1024), ""),
        (
            "alternation",
            (0..256)
                .map(|n| format!("word{n}"))
                .collect::<Vec<_>>()
                .join("|"),
            "",
        ),
        ("named_reparse", r"(?<word>[a-z]+)\s+\k<word>".into(), ""),
        ("unicode_sets", r"[\p{ASCII}&&\p{Letter}]+".into(), "v"),
        ("unicode_fold", r"[\u{10400}-\u{1044f}]+".into(), "iu"),
        (
            "class_strings",
            format!(
                r"[\q{{{}}}]",
                (0..128)
                    .map(|n| format!("a{n}"))
                    .collect::<Vec<_>>()
                    .join("|")
            ),
            "v",
        ),
        ("capture_lookbehind", "([a-z]+)(?<!ab)".repeat(32), ""),
        ("syntax_failure", "a".repeat(1024) + "(", ""),
    ]
}

fn run(pattern: &str, flags: &str, validation: bool) -> Result<(), ironhorse_regexp::CompileError> {
    #[cfg(validation_api)]
    if validation {
        return ironhorse_regexp::validate(black_box(pattern), black_box(flags));
    }
    #[cfg(not(validation_api))]
    assert!(!validation);
    ironhorse_regexp::compile(black_box(pattern), black_box(flags)).map(|_| ())
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let cases = cases();
    if args[1] == "snapshot" {
        for (name, pattern, flags) in cases {
            println!(
                "{name}: {:#?}",
                ironhorse_regexp::compile_checked(&pattern, flags, u64::MAX, None)
            );
        }
        return;
    }
    if args[1] == "cases" {
        for (name, _, _) in cases {
            println!("{name}");
        }
        return;
    }
    let validation = args[1] == "validate";
    assert!(validation || args[1] == "compile");
    let (_, pattern, flags) = cases.iter().find(|(name, _, _)| *name == args[2]).unwrap();
    let iterations: u32 = args[3].parse().unwrap();
    let expected = ironhorse_regexp::compile(pattern, flags).is_ok();
    for _ in 0..5 {
        assert_eq!(run(pattern, flags, validation).is_ok(), expected);
    }
    let start = Instant::now();
    for _ in 0..iterations {
        assert_eq!(black_box(run(pattern, flags, validation)).is_ok(), expected);
    }
    println!("{}", start.elapsed().as_nanos());
}
