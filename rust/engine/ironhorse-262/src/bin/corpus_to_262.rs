//! `corpus-to-262`: the mechanical corpus → test262-style case converter
//! (design [`designs/ironhorse-test262-convergence.md`] § Part 1,
//! "Conversion mechanics and corpus retirement").
//!
//! For each line of every `corpora/*.js` file it dual-runs the program once
//! against the XS oracle to record the completion (or abort) at conversion
//! time, then emits one standard test262 case under `cases/`:
//!
//! - a **positive** case whose body is `assert.sameValue((<expr>),
//!   <expected>)` when the completion is a primitive the oracle's `String()`
//!   coercion round-trips to a literal (number/boolean/string/undefined/null/
//!   bigint) and the source is a single parenthesizable expression — the
//!   spec-anchored + oracle-relative upgrade the design calls for;
//! - a **`raw`** case whose body is the source verbatim when the completion
//!   is a non-reconstructable value (object/array/function/symbol) or the
//!   source is a multi-statement program that cannot be inlined as an
//!   argument — the oracle-relative check the corpus already made, preserved
//!   exactly (identical bytecode → identical dual-run verdict and computrons);
//! - a **runtime negative** (`negative: { phase: runtime, type: <Ctor> }`)
//!   when the program throws a real `Error` subclass; a **parse negative**
//!   (`phase: parse, type: SyntaxError`, checked in inactive until the
//!   stage-5 compiler) when the oracle rejects it at compile time; and a
//!   **`raw`** shared-abort case for a bare primitive `throw` (test262's
//!   `negative.type` is constructor-name-shaped, so a primitive throw keeps a
//!   verbatim body the dual-run covers as a matching shared abort).
//!
//! Generation is strictly 1:1 — one corpus line in, one case file out,
//! nothing dropped silently — and the run prints the count the conversion
//! commit records. The meter contract never enters a case body: it is the
//! runner's job (design § "The meter assertion never enters the test body"),
//! carried here only as the `ironhorse-meter-exact` feature marker on the
//! bit-exact corpora.
//!
//! Usage: `corpus-to-262 [OUT_DIR]` (default `<crate>/cases`).

use ironhorse_262::xst::constructor_name;
use ironhorse_262::{dual_run, Agreement};
use std::fmt::Write as _;
use std::path::PathBuf;

/// One corpus file's placement and metering axis. `bucket` mirrors the
/// test262 directory idiom (`language/`, `built-ins/`); `meter_exact` is the
/// corpora that historically metered bit-exactly against the pin (everything
/// but the result-parity-only corpora — utf16 string values, transitive
/// harden, cross-compartment evaluation).
struct Entry {
    stem: &'static str,
    bucket: &'static str,
    meter_exact: bool,
}

const fn e(stem: &'static str, bucket: &'static str, meter_exact: bool) -> Entry {
    Entry {
        stem,
        bucket,
        meter_exact,
    }
}

/// The corpus manifest: every `corpora/*.js` line-corpus file, its case
/// bucket, and whether it carries the bit-exact meter evidence. The three
/// `false` entries are the result-parity-only corpora (their accessors assert
/// result agreement, not computron equality).
const MANIFEST: &[Entry] = &[
    e("arithmetic", "language", true),
    e("logic", "language", true),
    e("control-flow", "language", true),
    e("stage2-behavioral", "language", true),
    e("stage2-objects", "language", true),
    e("stage2b-functions", "language", true),
    e("stage2b-closures", "language", true),
    e("stage2b-exceptions", "language", true),
    e("stage3-language", "language", true),
    e("stage3-fundamentals", "built-ins", true),
    e("stage3-arrays", "built-ins", true),
    e("stage3-math", "built-ins", true),
    e("stage3-string", "built-ins", true),
    e("stage3-string-utf16", "built-ins", false),
    e("stage3-number", "built-ins", true),
    e("stage3-json", "built-ins", true),
    e("stage3b-json-metering", "built-ins", true),
    e("stage3-collections", "built-ins", true),
    e("stage3-bigint", "built-ins", true),
    e("stage3b-binary", "built-ins", true),
    e("stage3b-fundamentals-followup", "built-ins", true),
    e("stage3b-object-statics", "built-ins", true),
    e("stage3b-promises", "built-ins", true),
    e("stage3b-regexp", "built-ins", true),
    e("stage4-object-integrity", "built-ins", true),
    e("stage4-harden", "built-ins", false),
    e("stage4-new-target", "language", true),
    e("stage4-generators", "language", true),
    e("stage4-async-promises", "built-ins", true),
    e("stage4-async-await", "language", true),
    e("stage4-compartment", "built-ins", false),
];

/// The known ECMAScript `Error` constructor names a runtime negative's
/// `type` can carry (plus `Test262Error`, the harness's own). A thrown value
/// whose `String()` names one of these is a real Error subclass, mapped to a
/// `negative: { phase: runtime, type: <Ctor> }` case; anything else is a
/// primitive throw kept as a verbatim shared-abort body.
const ERROR_CTORS: &[&str] = &[
    "Error",
    "TypeError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "EvalError",
    "URIError",
    "AggregateError",
    "Test262Error",
];

/// The body shape chosen for one corpus line.
enum Shape {
    /// `assert.sameValue((<expr>), <lit>)` under the harness — spec-anchored.
    Assert { lit: String },
    /// The source verbatim, `flags: [raw]` — oracle-relative, bit-preserving.
    Raw,
    /// A runtime negative: verbatim throwing body + `negative: runtime/<ty>`.
    NegativeRuntime { ty: String },
    /// A parse negative: verbatim body + `negative: parse/SyntaxError`,
    /// checked in inactive until the stage-5 compiler (the runner skips it by
    /// that named reason today).
    NegativeParse,
}

/// The harness prelude (`sta.js` + `assert.js`) used to verify at conversion
/// time that a chosen `assert` body actually dual-runs the way the runner
/// will see it — bit-exact for a meter-exact corpus, result-agreeing
/// otherwise. A body that fails verification is downgraded to a verbatim
/// `raw` case so the generated set reproduces the corpus's covered / bit-exact
/// coverage exactly rather than introducing a wrapper-induced skip or gap.
struct Harness {
    prelude: String,
}

impl Harness {
    fn locate() -> Option<Harness> {
        let (_root, dir) = ironhorse_262::test262::locate_test262()?;
        let sta = std::fs::read_to_string(dir.join("sta.js")).ok()?;
        let assert = std::fs::read_to_string(dir.join("assert.js")).ok()?;
        Some(Harness {
            prelude: format!("{}\n{}\n", sta, assert),
        })
    }

    /// Would the runner see this `assert` body as Covered — and, when
    /// `meter_exact`, bit-exact against the oracle? Assembles the prelude +
    /// body exactly as `xst::assemble` does for a non-`raw` case and checks
    /// the dual run.
    fn assert_holds(&self, body: &str, meter_exact: bool) -> bool {
        let assembled = format!("{}{}", self.prelude, body);
        let run = match dual_run(&assembled) {
            Some(r) => r,
            None => return false,
        };
        if run.agreement != Agreement::BothComplete || !run.result_agrees {
            return false;
        }
        !meter_exact || run.computrons_agree
    }
}

fn main() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let corpora_dir = manifest_dir.join("corpora");
    // The harness prelude for conversion-time verification; if the checked-in
    // subset is absent, verification is skipped (asserts are emitted
    // unverified — the coverage-equivalence test still gates them in CI).
    let harness = Harness::locate();
    let out_dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest_dir.join("cases"));

    // Start from a clean tree so a re-run never leaves a stale case behind.
    if out_dir.exists() {
        std::fs::remove_dir_all(&out_dir).expect("clear cases dir");
    }

    let mut total_lines = 0usize;
    let mut total_cases = 0usize;
    let mut n_assert = 0usize;
    let mut n_raw = 0usize;
    let mut n_neg_runtime = 0usize;
    let mut n_neg_parse = 0usize;
    let mut n_oracle_error = 0usize;
    // Assert candidates the harness verification downgraded to `raw` because
    // the wrapper perturbed metering/completion.
    let mut n_downgraded = 0usize;

    for entry in MANIFEST {
        let path = corpora_dir.join(format!("{}.js", entry.stem));
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
        let lines = ironhorse_262::parse_corpus(&text);
        let case_dir = out_dir.join(entry.bucket).join(entry.stem);
        std::fs::create_dir_all(&case_dir).expect("create case dir");

        for (i, src) in lines.iter().enumerate() {
            total_lines += 1;
            let mut shape = match classify(src) {
                Some(s) => s,
                None => {
                    // The oracle machine itself failed to start — never
                    // expected for a curated corpus line; surface it loudly
                    // rather than dropping the line.
                    n_oracle_error += 1;
                    eprintln!("ORACLE-ERROR {}:{} {:?}", entry.stem, i + 1, src);
                    Shape::Raw
                }
            };
            // Verify a spec-anchored body against the harness the runner uses:
            // if the wrapper perturbs the metering (a meter-exact corpus) or
            // the completion (result-only), downgrade to a verbatim `raw` body
            // that reproduces the corpus's exact dual-run. This is what keeps
            // the generated bit-exact/covered set identical to the corpus's.
            if let (Shape::Assert { lit }, Some(h)) = (&shape, &harness) {
                let body = format!("assert.sameValue(({}), {});\n", src, lit);
                if !h.assert_holds(&body, entry.meter_exact) {
                    n_downgraded += 1;
                    shape = Shape::Raw;
                }
            }
            match &shape {
                Shape::Assert { .. } => n_assert += 1,
                Shape::Raw => n_raw += 1,
                Shape::NegativeRuntime { .. } => n_neg_runtime += 1,
                Shape::NegativeParse => n_neg_parse += 1,
            }
            let case = render_case(entry, i + 1, src, &shape);
            let file = case_dir.join(format!("{:03}.js", i + 1));
            std::fs::write(&file, case).expect("write case");
            total_cases += 1;
        }
        eprintln!("  {:<32} {} cases", entry.stem, lines.len());
    }

    // The count the conversion commit records: 1:1, nothing dropped.
    println!(
        "corpus-to-262: {} corpus lines -> {} cases",
        total_lines, total_cases
    );
    println!(
        "  assert(spec-anchored)={} raw(oracle-relative)={} negative-runtime={} negative-parse={}",
        n_assert, n_raw, n_neg_runtime, n_neg_parse
    );
    println!(
        "  (of the raw cases, {} were assert candidates downgraded by harness verification)",
        n_downgraded
    );
    if n_oracle_error > 0 {
        eprintln!(
            "WARNING: {} lines hit an oracle machine error",
            n_oracle_error
        );
    }
    assert_eq!(total_lines, total_cases, "conversion must be strictly 1:1");
    println!("wrote cases under {}", out_dir.display());
}

/// Dual-run `src` once on the oracle and choose its case shape.
fn classify(src: &str) -> Option<Shape> {
    let o = xs_oracle::run(src)?;
    if o.completed {
        // A completed program: try to spec-anchor it. The type comes from a
        // `typeof (<src>)` probe run on the oracle — which doubles as a parse
        // check that the source is a single parenthesizable expression (a
        // multi-statement program makes `typeof (...)` a syntax error, so the
        // probe cleanly declines and we fall back to a verbatim body).
        if let Some(lit) = reconstruct_literal(src, &o.result) {
            return Some(Shape::Assert { lit });
        }
        return Some(Shape::Raw);
    }
    // An abort at conversion time. An empty bytecode is a compile-time reject
    // (a parse negative); otherwise it is a runtime throw.
    if o.bytecode.is_empty() {
        return Some(Shape::NegativeParse);
    }
    let ctor = constructor_name(&o.error);
    if ERROR_CTORS.contains(&ctor) {
        return Some(Shape::NegativeRuntime {
            ty: ctor.to_string(),
        });
    }
    // A bare primitive throw (`throw 7`) has no constructor for `negative.type`
    // to name — kept as a verbatim body the dual-run covers as a matching
    // shared abort (design § frontmatter mapping).
    Some(Shape::Raw)
}

/// Reconstruct a JS literal for the completion value, given the oracle's
/// `String()` coercion `result` and a `typeof` probe of `src`. Returns `None`
/// when the value is not a reconstructable primitive or `src` is not a single
/// expression (so the caller emits a verbatim body instead).
fn reconstruct_literal(src: &str, result: &str) -> Option<String> {
    let probe = xs_oracle::run(&format!("typeof ({})", src))?;
    if !probe.completed {
        return None; // not a parenthesizable single expression
    }
    match probe.result.as_str() {
        "number" => match result {
            "NaN" => Some("NaN".to_string()),
            "Infinity" => Some("Infinity".to_string()),
            "-Infinity" => Some("-Infinity".to_string()),
            // `-0` coerces to `"0"`, which `SameValue` distinguishes from `+0`;
            // an `Object.is` probe on the oracle recovers the sign so the
            // literal is `-0`, not a `0` that would make the assert throw.
            "0" if is_negative_zero(src) => Some("-0".to_string()),
            // Every other finite `String(number)` (including `1e+21`) is a
            // valid numeric literal.
            _ if is_numeric_literal(result) => Some(result.to_string()),
            _ => None,
        },
        "boolean" => match result {
            "true" | "false" => Some(result.to_string()),
            _ => None,
        },
        "string" => Some(js_string_literal(result)),
        "undefined" => Some("undefined".to_string()),
        // `typeof null` is `"object"`; the only object we can reconstruct is
        // `null` itself (its `String()` is `"null"`).
        "object" if result == "null" => Some("null".to_string()),
        "bigint" if is_bigint_digits(result) => Some(format!("{}n", result)),
        _ => None,
    }
}

/// Is `s` a plain decimal/float numeric literal `String(number)` can produce?
fn is_numeric_literal(s: &str) -> bool {
    s.parse::<f64>().is_ok()
}

/// Does `src` evaluate to negative zero? Probed on the oracle with
/// `Object.is`, the only faithful `-0` vs `+0` discriminator.
fn is_negative_zero(src: &str) -> bool {
    match xs_oracle::run(&format!("Object.is(({}), -0)", src)) {
        Some(o) => o.completed && o.result == "true",
        None => false,
    }
}

/// Is `s` a `String(bigint)` — an optional `-` then digits?
fn is_bigint_digits(s: &str) -> bool {
    let body = s.strip_prefix('-').unwrap_or(s);
    !body.is_empty() && body.bytes().all(|b| b.is_ascii_digit())
}

/// A double-quoted JS string literal for `s`, escaping the characters a
/// test262 body must not carry raw.
fn js_string_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // A lone control char is emitted as a \u escape so the literal
            // stays ASCII-clean and unambiguous.
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Render one test262 case file: frontmatter + body.
fn render_case(entry: &Entry, line_no: usize, src: &str, shape: &Shape) -> String {
    let mut features = vec!["ironhorse-dual-run".to_string()];
    // The bit-exact corpora carry the historical computron evidence; the
    // negatives do not claim it (their abort verdict is constructor-name
    // shaped, never meter-gated), matching the runner's `evaluate_negative`.
    let claims_meter = entry.meter_exact && matches!(shape, Shape::Assert { .. } | Shape::Raw);
    if claims_meter {
        features.push("ironhorse-meter-exact".to_string());
        features.push("ironhorse-meter-determinism".to_string());
    }

    let (flags, negative, body): (Vec<&str>, Option<(&str, &str)>, String) = match shape {
        Shape::Assert { lit } => (
            // The harness assert cases retain the single sloppy mode the
            // source corpus measured.
            vec!["noStrict"],
            None,
            format!("assert.sameValue(({}), {});\n", src, lit),
        ),
        Shape::Raw => (vec!["raw"], None, format!("{}\n", src)),
        Shape::NegativeRuntime { ty } => (
            vec!["raw"],
            Some(("runtime", ty.as_str())),
            format!("{}\n", src),
        ),
        Shape::NegativeParse => (
            vec!["raw"],
            Some(("parse", "SyntaxError")),
            format!("{}\n", src),
        ),
    };

    let mut fm = String::new();
    fm.push_str("/*---\n");
    let _ = writeln!(
        fm,
        "description: {} corpus line {} converted to a test262 case",
        entry.stem, line_no
    );
    let _ = writeln!(fm, "flags: [{}]", flags.join(", "));
    let _ = writeln!(fm, "features: [{}]", features.join(", "));
    if let Some((phase, ty)) = negative {
        fm.push_str("negative:\n");
        let _ = writeln!(fm, "  phase: {}", phase);
        let _ = writeln!(fm, "  type: {}", ty);
    }
    // The original corpus line survives verbatim in `info:` (design § Part 1,
    // "the source line preserved in `info:`") for provenance.
    fm.push_str("info: |\n");
    let _ = writeln!(
        fm,
        "  Converted from corpora/{}.js line {}.",
        entry.stem, line_no
    );
    let _ = writeln!(fm, "  Source: {}", src);
    fm.push_str("---*/\n");
    fm.push_str(&body);
    fm
}
