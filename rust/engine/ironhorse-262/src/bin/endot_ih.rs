//! `endot-ih`: the xst-analogue test262 runner (design
//! [`designs/ironhorse-test262-convergence.md`] § Part 2). It plays for
//! the Rust engine the role `xs/tools/xst.c` + `xst262.c` play for XS —
//! full YAML frontmatter, the not-yet-implemented feature skip list,
//! sloppy+strict mode selection, negative verdicts, the xst-shaped `-o` YAML
//! report — plus the one thing `xst` never had: a differential oracle
//! (`--oracle`, default on) whose verdict + observable agreement gate the
//! build and whose computron comparison is advisory.
//!
//! It subsumes `test262-language`: the same positional-subtree walk, the
//! same per-subtree-process memory bounding, the same honest covered /
//! skipped / divergent split — now with the full verdict and report layer.
//!
//! Usage:
//!   endot-ih                                  # all of language/ (default)
//!   endot-ih expressions/addition             # a language/ subtree
//!   endot-ih built-ins/Boolean                # a built-ins/ subtree
//!   endot-ih --features-include ses-xs-parity built-ins/Object
//!   endot-ih --repeat 3 --gate-meter-exact language/expressions/addition
//!   endot-ih -o report.yaml language/statements
//!   endot-ih --test262-dir /path/to/test262 --no-oracle built-ins/Math
//!   endot-ih -l --feature-filter ses-xs-parity --features-include ses-xs-parity built-ins
//!
//! The last line is the third-host `ses-xs-parity` invocation: ironhorse joins
//! `xst -l` and node-with-SES-prelude as the third `packages/test262-runner`
//! host on that parity axis (design § Staging step 4). The guest
//! `lockdown()`/`Compartment` surface the mode needs is a named scope fold
//! ironhorse does not yet expose, so today every such case is an honest named
//! skip (`feature:Compartment` / `ses-mode:lockdown-unimplemented`); coverage
//! lights up automatically when that guest surface lands.
//!
//! Positional paths are subtrees under the located test262 root; a bare path
//! defaults under `language/` for back-compat with `test262-language`. Exit
//! code is nonzero on any failure (a divergence, an over-acceptance, a
//! meter-exact-gate or determinism violation), so CI/nightly can gate.
//!
//! Memory note (inherited from `test262-language`): the XS oracle
//! accumulates process memory across the tens of thousands of machine
//! create/destroy cycles a whole-tree run makes, so the full sweep caps the
//! number of cases per process; each subprocess frees everything on exit.

use ironhorse_262::expectations::{compare, Expectations, Header};
use ironhorse_262::report::RunReport;
use ironhorse_262::test262::{collect_js, collect_js_batch, collect_js_direct, locate_test262};
use ironhorse_262::xst::{run_files, Config, SesMode, DEFAULT_CASE_TIMEOUT_SECONDS};
use std::path::PathBuf;

fn main() {
    let mut cfg = Config::default();
    // CLI policy: opt in to the per-case wall-clock bound the library leaves off
    // by default (overridable with `--case-timeout`, `0` = unbounded).
    cfg.per_case_timeout_seconds = DEFAULT_CASE_TIMEOUT_SECONDS;
    let mut test262_dir: Option<PathBuf> = None;
    let mut report_path: Option<PathBuf> = None;
    let mut json_path: Option<PathBuf> = None;
    let mut direct_only = false;
    let mut batch_index: Option<usize> = None;
    let mut batch_size: Option<usize> = None;
    let mut run_id: String = String::new();
    let mut expectations_path: Option<PathBuf> = None;
    let mut update_expectations: Option<PathBuf> = None;
    let mut strict_skip_reasons = false;
    let mut subtrees: Vec<String> = Vec::new();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--oracle" => cfg.oracle = true,
            "--no-oracle" => cfg.oracle = false,
            "--case-timeout" => {
                cfg.per_case_timeout_seconds =
                    args.next().and_then(|n| n.parse().ok()).unwrap_or_else(|| {
                        fail("--case-timeout needs a non-negative integer (seconds; 0 = unbounded)")
                    });
            }
            "--gate-meter-exact" => cfg.gate_meter_exact = true,
            "--repeat" => {
                cfg.repeat = args
                    .next()
                    .and_then(|n| n.parse().ok())
                    .filter(|&n| n >= 1)
                    .unwrap_or_else(|| fail("--repeat needs a positive integer"));
            }
            "--features-include" => {
                let v = args
                    .next()
                    .unwrap_or_else(|| fail("--features-include needs a feature"));
                // Comma-separated or repeated: both accepted.
                cfg.features_include.extend(
                    v.split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty()),
                );
            }
            "--feature-filter" => {
                let v = args
                    .next()
                    .unwrap_or_else(|| fail("--feature-filter needs a feature"));
                cfg.feature_filter.extend(
                    v.split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty()),
                );
            }
            // SES lockdown/compartment modes — the `xst262.c` `-l`/`-lc`/`-c`
            // analogues; `--ses-mode <l|lc|c>` is the long form.
            "-l" => cfg.ses_mode = SesMode::Lockdown,
            "-lc" | "-cl" => cfg.ses_mode = SesMode::LockdownCompartment,
            "-c" => cfg.ses_mode = SesMode::Compartment,
            "--ses-mode" => {
                let v = args
                    .next()
                    .unwrap_or_else(|| fail("--ses-mode needs one of l|lc|c"));
                cfg.ses_mode =
                    SesMode::parse(&v).unwrap_or_else(|| fail("--ses-mode must be l, lc, or c"));
            }
            "--test262-dir" => {
                test262_dir = Some(PathBuf::from(
                    args.next()
                        .unwrap_or_else(|| fail("--test262-dir needs a path")),
                ));
            }
            "-o" | "--report" => {
                report_path = Some(PathBuf::from(
                    args.next().unwrap_or_else(|| fail("-o needs a path")),
                ));
            }
            "--json" => {
                json_path = Some(PathBuf::from(
                    args.next().unwrap_or_else(|| fail("--json needs a path")),
                ));
            }
            "--direct-only" => direct_only = true,
            "--run-id" => {
                run_id = args
                    .next()
                    .unwrap_or_else(|| fail("--run-id needs a value"));
            }
            "--batch-index" => {
                batch_index = Some(
                    args.next()
                        .and_then(|value| value.parse().ok())
                        .unwrap_or_else(|| fail("--batch-index needs a non-negative integer")),
                );
            }
            "--batch-size" => {
                batch_size = Some(
                    args.next()
                        .and_then(|value| value.parse().ok())
                        .filter(|size| *size > 0)
                        .unwrap_or_else(|| fail("--batch-size needs a positive integer")),
                );
            }
            "--expectations" => {
                expectations_path = Some(PathBuf::from(
                    args.next()
                        .unwrap_or_else(|| fail("--expectations needs a path")),
                ));
            }
            "--update-expectations" => {
                update_expectations =
                    Some(PathBuf::from(args.next().unwrap_or_else(|| {
                        fail("--update-expectations needs a path")
                    })));
            }
            "--strict-skip-reasons" => strict_skip_reasons = true,
            "-h" | "--help" => {
                print!("{}", HELP);
                return;
            }
            other if other.starts_with('-') => fail(&format!("unknown flag: {}", other)),
            other => subtrees.push(other.to_string()),
        }
    }

    // Locate the test262 root + harness dir: the `--test262-dir` override, or
    // the checked-in `packages/test262-runner/test262` subset.
    let (root, harness) = match test262_dir {
        Some(dir) => {
            let harness = dir.join("harness");
            if !harness.join("sta.js").is_file() {
                fail(&format!("no test262 harness under {}", harness.display()));
            }
            (dir.join("test"), harness)
        }
        None => match locate_test262() {
            Some(p) => p,
            None => fail("test262 subset not found under packages/test262-runner/test262"),
        },
    };

    // Default to all of `language/` (test262-language's default); a bare
    // subpath resolves under `language/`, `language/…` and `built-ins/…`
    // from the root.
    if subtrees.is_empty() {
        subtrees.push("language".to_string());
    }

    let mut files = Vec::new();
    for sub in &subtrees {
        // A positional that already names an existing filesystem path (a case
        // file or a directory of cases — e.g. the generated `ironhorse-262/cases`
        // tree) is run directly, exactly as `xst` takes case paths. Otherwise
        // it resolves as a subtree under the located test262 root.
        let direct = PathBuf::from(sub);
        let target = if direct.exists() {
            direct
        } else if sub.starts_with("language") || sub.starts_with("built-ins") {
            root.join(sub)
        } else {
            root.join("language").join(sub)
        };
        let found = if batch_index.is_some() {
            Vec::new()
        } else if target.is_file() {
            vec![target.clone()]
        } else if target.is_dir() {
            if direct_only {
                collect_js_direct(&target)
            } else {
                collect_js(&target)
            }
        } else {
            Vec::new()
        };
        let found = match (batch_index, batch_size) {
            (Some(index), Some(size)) => {
                if subtrees.len() != 1 {
                    fail("batching accepts exactly one positional directory");
                }
                if !target.is_dir() {
                    fail("batching requires one positional directory");
                }
                collect_js_batch(&target, index, size).unwrap_or_else(|error| fail(&error))
            }
            (None, None) => found,
            _ => fail("--batch-index and --batch-size must be used together"),
        };
        if found.is_empty() {
            eprintln!("warning: no test files under {}", sub);
        }
        files.extend(found);
    }
    files.sort();
    files.dedup();
    if files.is_empty() {
        fail("no test files to run");
    }

    eprintln!(
        "endot-ih: running {} test262 files (oracle={}, repeat={}, gate-meter-exact={}, ses-mode={})",
        files.len(),
        cfg.oracle,
        cfg.repeat,
        cfg.gate_meter_exact,
        cfg.ses_mode.short(),
    );
    let rep = run_files(&cfg, &harness, &root, &files);

    println!("{}", "=".repeat(72));
    println!(
        "endot-ih: total={} covered={} failed={} skipped={}",
        rep.total,
        rep.covered,
        rep.failures.len(),
        rep.total - rep.covered - rep.failures.len(),
    );
    println!(
        "  mode: sloppy-run={} strict-skipped-by-policy={} ses-mode={}",
        rep.sloppy_run,
        rep.strict_skipped,
        rep.ses_mode.short()
    );
    println!("  advisory: computron-gap={}", rep.computron_advisories);
    println!("{}", "-".repeat(72));
    println!("skip: (pre-run feature/flag/structural skips — named, not folded into a rate)");
    for (reason, n) in rep.skip_summary() {
        println!("  {:>6}  {}", n, reason);
    }
    println!("skip-detail: (post-run honest split by opcode/value/reason)");
    for (reason, n) in rep.skip_detail_summary() {
        println!("  {:>6}  {}", n, reason);
    }
    if !rep.failures.is_empty() {
        println!("{}", "-".repeat(72));
        println!("fail: ({}):", rep.failures.len());
        for (path, detail) in &rep.failures {
            println!("  {}\n    {}", path, detail);
        }
    }
    println!("{}", "=".repeat(72));

    if let Some(path) = &report_path {
        match std::fs::write(path, rep.to_yaml()) {
            Ok(()) => eprintln!("wrote report to {}", path.display()),
            Err(e) => fail(&format!(
                "could not write report to {}: {}",
                path.display(),
                e
            )),
        }
    }

    // `--json`: the per-case batch file the whole-tree sweep aggregates. Written
    // BEFORE the bar-check exit below so a batch that contains a failure still
    // records its cases (the orchestrator gates on the aggregate, not per-batch
    // exit status), and so an interrupted sweep can resume from what completed.
    if let Some(path) = &json_path {
        match std::fs::write(path, RunReport::batch_json_with_id(&run_id, &rep.cases)) {
            Ok(()) => eprintln!(
                "wrote {} case records to {}",
                rep.cases.len(),
                path.display()
            ),
            Err(e) => fail(&format!(
                "could not write json to {}: {}",
                path.display(),
                e
            )),
        }
    }

    let mut gate_failed = !rep.met_bar();

    // Expectation-list mode (design `designs/test262-fixture-consolidation.md`):
    // `--update-expectations` writes the observed run as the committed list;
    // `--expectations` compares the run to a committed list and gates on the
    // two-directional ratchet (progress AND regression both surface, so
    // neither is silently absorbed).
    if let Some(path) = &update_expectations {
        let header = Header {
            engine: "ironhorse".to_string(),
            features: features_label(&cfg.features_include),
            corpus: subtrees.join(","),
            tip: std::env::var("GARDEN_TEST262_TIP").unwrap_or_else(|_| "unknown".to_string()),
        };
        let mut exp = Expectations::new(header);
        exp.entries = rep.observed.clone();
        match std::fs::write(path, exp.to_text()) {
            Ok(()) => eprintln!(
                "wrote {} expectation entries to {}",
                exp.entries.len(),
                path.display()
            ),
            Err(e) => fail(&format!(
                "could not write expectations to {}: {}",
                path.display(),
                e
            )),
        }
    }
    if let Some(path) = &expectations_path {
        let text = std::fs::read_to_string(path)
            .unwrap_or_else(|e| fail(&format!("could not read {}: {}", path.display(), e)));
        let exp = Expectations::parse(&text)
            .unwrap_or_else(|e| fail(&format!("bad expectation list {}: {}", path.display(), e)));
        let events = compare(&rep.observed, &exp);
        let gating: Vec<_> = events
            .iter()
            .filter(|ev| ev.is_gating(strict_skip_reasons))
            .collect();
        println!("{}", "-".repeat(72));
        println!(
            "expectations: {} entries, {} ratchet event(s) ({} gating)",
            exp.entries.len(),
            events.len(),
            gating.len()
        );
        for ev in &events {
            println!("  {}", ev.describe());
        }
        if !gating.is_empty() {
            println!(
                "RATCHET: {} gating drift(s); re-baseline with --update-expectations {}",
                gating.len(),
                path.display()
            );
            gate_failed = true;
        }
    }

    if !gate_failed {
        println!(
            "BAR MET: {} covered, 0 failed (of {} total; {} skipped by named reason)",
            rep.covered,
            rep.total,
            rep.total - rep.covered
        );
    } else {
        if !rep.met_bar() {
            println!("BAR NOT MET: {} failure(s)", rep.failures.len());
        }
        std::process::exit(1);
    }
}

/// The `features=` label a committed list header carries: the opted-in feature
/// set, or `default` when the run used the default skip set.
fn features_label(features_include: &[String]) -> String {
    if features_include.is_empty() {
        "default".to_string()
    } else {
        features_include.join("+")
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("endot-ih: {}", msg);
    std::process::exit(2);
}

const HELP: &str = "\
endot-ih: the xst-analogue test262 runner (design § Part 2)

USAGE:
    endot-ih [OPTIONS] [SUBTREE...]

SUBTREE:
    A subtree under the test262 root. `language/…` and `built-ins/…` resolve
    from the root; a bare path resolves under `language/`. Default: language/

OPTIONS:
    --oracle                 gate on XS oracle agreement (default on)
    --no-oracle              do not gate on oracle agreement
    --case-timeout SECS      hard per-case wall-clock bound; an Ironhorse-only
                             non-terminator is an ironhorse-hang failure, while
                             an oracle-only one is an infrastructure skip
                             (default 10; 0 = off)
    --gate-meter-exact       fail ironhorse-meter-exact cases on a computron drift
    --repeat N               re-run ironhorse N times; require identical computrons
    --features-include F[,F] opt features OUT of the skip set (e.g. ses-xs-parity)
    --feature-filter F[,F]   run ONLY cases carrying a feature (test262-harness
                             --features-include semantics; e.g. ses-xs-parity)
    -l | -lc | -c            SES lockdown / lockdown+compartment / compartment
    --ses-mode l|lc|c        mode (xst262.c -l/-lc/-c analogues); guest surface
                             not yet landed, so each is a named whole-case skip
    --test262-dir DIR        use DIR as the test262 root (has harness/, test/)
    -o, --report FILE        write the xst-shaped YAML report to FILE
    --json FILE              write the per-case JSON batch file (for the
                             whole-tree sweep's aggregator) to FILE
    --run-id ID              stamp the --json batch with this run identity so
                             the aggregator can bind the report to one run
    --direct-only            for a directory positional, run only its DIRECT
                             .js cases (non-recursive)
    --batch-index N          zero-based chunk of the directory's sorted DIRECT cases (implies --direct-only)
    --batch-size N           positive maximum files in that chunk
    --expectations FILE      gate on a committed parameterized expectation list
                             (green iff observed == expected per (case, mode);
                             both progress and regression surface as a ratchet)
    --update-expectations FILE
                             write the observed run as a committed list at FILE
                             (the re-baseline that accepts a ratchet drift)
    --strict-skip-reasons    also gate when a skip's named reason moves (off by
                             default while the opcode surface still grows)
    -h, --help               print this help

THIRD-HOST (ses-xs-parity axis, alongside `xst -l` and node+SES prelude):
    endot-ih -l --feature-filter ses-xs-parity --features-include ses-xs-parity built-ins
";
