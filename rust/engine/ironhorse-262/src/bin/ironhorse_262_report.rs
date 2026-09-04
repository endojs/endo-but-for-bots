//! `ironhorse-262-report`: the whole-tree sweep's orchestration + reporting CLI
//! It is the deterministic,
//! oracle-free half of the full run — every subcommand is pure filesystem work,
//! unit-tested in [`ironhorse_262::report`] — leaving the heavy per-case oracle
//! execution to `endot-ih`, which the orchestrator (`scripts/full-run.sh`)
//! drives one batch per process so the XS oracle's retained RSS cannot OOM.
//! Run with `--help` for the single authoritative subcommand reference.

use ironhorse_262::report::{
    aggregate_plan, batch_case_count, batch_case_limit, discover_batches, pending_batches_checked,
    read_batch_with_run_id, read_provenance, to_html, CaseRecord, Provenance, RunReport, Verdict,
};
use ironhorse_262::test262::{collect_js_batch, locate_test262};
use std::path::PathBuf;
use std::process::exit;

fn main() {
    let mut arguments = std::env::args().skip(1);
    let command = arguments.next().unwrap_or_else(|| {
        eprintln!("{}", HELP);
        exit(2);
    });
    let rest: Vec<String> = arguments.collect();
    match command.as_str() {
        "discover" => command_discover(&rest),
        "plan" => command_plan(&rest),
        "validate" => command_validate(&rest),
        "aggregate" => command_aggregate(&rest),
        "batch-size" => println!("{}", batch_case_limit()),
        "batch-filename" => {
            let batch = rest
                .first()
                .unwrap_or_else(|| fail("batch-filename needs BATCH"));
            println!("{}", ironhorse_262::report::batch_filename(batch));
        }
        "batch-count" => {
            let batch = option_value(&rest, "--batch")
                .unwrap_or_else(|| fail("batch-count needs --batch BATCH"));
            let root = resolve_test_root(&rest);
            println!(
                "{}",
                batch_case_count(&root, &batch).unwrap_or_else(|error| fail(&error))
            );
        }
        "json-string" => {
            let value = rest
                .first()
                .unwrap_or_else(|| fail("json-string needs VALUE"));
            println!("{}", ironhorse_262::report::json_str(value));
        }
        "quarantine" => command_quarantine(&rest),
        "-h" | "--help" | "help" => println!("{}", HELP),
        other => {
            eprintln!("ironhorse-262-report: unknown subcommand: {}", other);
            eprintln!("{}", HELP);
            exit(2);
        }
    }
}

fn command_quarantine(arguments: &[String]) {
    let batch = option_value(arguments, "--batch")
        .unwrap_or_else(|| fail("quarantine needs --batch BATCH"));
    let run_id =
        option_value(arguments, "--run-id").unwrap_or_else(|| fail("quarantine needs --run-id ID"));
    let reason = option_value(arguments, "--reason")
        .unwrap_or_else(|| fail("quarantine needs --reason REASON"));
    let output = PathBuf::from(
        option_value(arguments, "--json").unwrap_or_else(|| fail("quarantine needs --json OUT")),
    );
    let root = resolve_test_root(arguments);
    let (directory, index_text) = batch
        .rsplit_once("@@")
        .unwrap_or_else(|| fail("invalid batch name"));
    let index = index_text
        .parse::<usize>()
        .unwrap_or_else(|_| fail("invalid batch index"));
    let files = collect_js_batch(&root.join(directory), index, batch_case_limit())
        .unwrap_or_else(|error| fail(&error));
    let cases: Vec<CaseRecord> = files
        .into_iter()
        .map(|path| CaseRecord {
            path: path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned(),
            outcome: Verdict::RunSkip,
            reason: reason.clone(),
            features: Vec::new(),
            strict_skipped: false,
            computron_gap: false,
        })
        .collect();
    std::fs::write(&output, RunReport::batch_json_with_id(&run_id, &cases))
        .unwrap_or_else(|error| fail(&format!("could not write {}: {}", output.display(), error)));
}

/// Minimal `--flag value` / `--flag` option scan. Returns the value after
/// `name`, or `None`.
fn option_value(arguments: &[String], name: &str) -> Option<String> {
    arguments
        .iter()
        .position(|a| a == name)
        .and_then(|i| arguments.get(i + 1).cloned())
}

/// Resolve the test262 `test/` root: `--test262-dir DIR` (with `test/`), else
/// the checked-in subset via [`locate_test262`].
fn resolve_test_root(arguments: &[String]) -> PathBuf {
    match option_value(arguments, "--test262-dir") {
        Some(directory) => {
            let root = PathBuf::from(&directory).join("test");
            if !root.is_dir() {
                fail(&format!("no test/ under --test262-dir {}", directory));
            }
            root
        }
        None => match locate_test262() {
            Some((root, _harness)) => root,
            None => fail("no --test262-dir given and no checked-in test262 subset found"),
        },
    }
}

/// Discover the batch list, optionally restricted to a `--subtree` prefix.
fn discover_scoped(arguments: &[String]) -> Vec<String> {
    let root = resolve_test_root(arguments);
    let mut batches = discover_batches(&root);
    if let Some(prefix) = option_value(arguments, "--subtree") {
        let prefix = prefix.trim_end_matches('/');
        batches.retain(|batch| {
            let directory = batch
                .rsplit_once("@@")
                .map_or(batch.as_str(), |pair| pair.0);
            directory == prefix || directory.starts_with(&format!("{}/", prefix))
        });
    }
    batches
}

fn command_discover(arguments: &[String]) {
    let batches = discover_scoped(arguments);
    for b in &batches {
        println!("{}", b);
    }
    eprintln!("ironhorse-262-report: discovered {} batches", batches.len());
}

fn command_plan(arguments: &[String]) {
    let results = PathBuf::from(
        option_value(arguments, "--results").unwrap_or_else(|| fail("plan needs --results DIR")),
    );
    let batches = discover_scoped(arguments);
    let run_id = option_value(arguments, "--run-id");
    if run_id
        .as_deref()
        .is_some_and(|identity| identity.trim().is_empty())
    {
        fail("--run-id must not be empty");
    }
    let pending = pending_batches_checked(&results, &batches, run_id.as_deref());
    for b in &pending {
        println!("{}", b);
    }
    eprintln!(
        "ironhorse-262-report: {} of {} batches pending (resume)",
        pending.len(),
        batches.len()
    );
}

fn command_validate(arguments: &[String]) {
    let batch = PathBuf::from(
        option_value(arguments, "--batch").unwrap_or_else(|| fail("validate needs --batch FILE")),
    );
    match read_batch_with_run_id(&batch) {
        Err(error) => fail(&format!("invalid batch {}: {}", batch.display(), error)),
        Ok((run_id, cases)) => {
            // With `--run-id`, a batch stamped with a different identity is not
            // a valid completion of this run.
            if let Some(expected) = option_value(arguments, "--run-id") {
                if expected.trim().is_empty() {
                    fail("--run-id must not be empty");
                }
                if run_id != expected {
                    fail(&format!(
                        "batch {} run_id {:?} != expected {:?}",
                        batch.display(),
                        run_id,
                        expected
                    ));
                }
            }
            if let Some(expected_count) = option_value(arguments, "--expected-count") {
                let expected_count = expected_count
                    .parse::<usize>()
                    .unwrap_or_else(|_| fail("--expected-count needs a non-negative integer"));
                if cases.len() != expected_count {
                    fail(&format!(
                        "batch {} has {} cases, expected {}",
                        batch.display(),
                        cases.len(),
                        expected_count
                    ));
                }
            }
        }
    }
}

fn command_aggregate(arguments: &[String]) {
    let results = PathBuf::from(
        option_value(arguments, "--results")
            .unwrap_or_else(|| fail("aggregate needs --results DIR")),
    );
    let json_out = PathBuf::from(
        option_value(arguments, "--json").unwrap_or_else(|| fail("aggregate needs --json OUT")),
    );
    let provenance: Provenance = match option_value(arguments, "--provenance") {
        Some(path) => read_provenance(&PathBuf::from(&path))
            .unwrap_or_else(|error| fail(&format!("invalid provenance {}: {}", path, error))),
        None => fail("aggregate needs --provenance FILE"),
    };
    // Aggregate only the exact discovery plan, bound to the provenance identity.
    let plan_path =
        option_value(arguments, "--plan").unwrap_or_else(|| fail("aggregate needs --plan FILE"));
    let report = {
        let text = std::fs::read_to_string(&plan_path)
            .unwrap_or_else(|e| fail(&format!("could not read plan {}: {}", plan_path, e)));
        let plan: Vec<String> = text
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string())
            .collect();
        let (report, warnings) = aggregate_plan(&results, &plan, provenance);
        for w in &warnings {
            eprintln!("ironhorse-262-report: WARNING {}", w);
        }
        if !warnings.is_empty() {
            fail(&format!(
                    "{} batch(es) rejected during aggregation; refusing to publish a report that misrepresents the run",
                    warnings.len()
                ));
        }
        if let Some(expected_total) = option_value(arguments, "--expected-total") {
            let expected_total = expected_total
                .parse::<usize>()
                .unwrap_or_else(|_| fail("--expected-total needs a non-negative integer"));
            if report.total() != expected_total {
                fail(&format!(
                    "aggregate contains {} cases, expected {} from discovery",
                    report.total(),
                    expected_total
                ));
            }
        }
        report
    };

    if let Err(e) = std::fs::write(&json_out, report.to_json()) {
        fail(&format!("could not write {}: {}", json_out.display(), e));
    }
    eprintln!(
        "ironhorse-262-report: wrote {} ({} cases)",
        json_out.display(),
        report.total()
    );
    if let Some(html_out) = option_value(arguments, "--html") {
        let html_out = PathBuf::from(html_out);
        if let Err(e) = std::fs::write(&html_out, to_html(&report)) {
            fail(&format!("could not write {}: {}", html_out.display(), e));
        }
        eprintln!("ironhorse-262-report: wrote {}", html_out.display());
    }

    // A concise console summary so a CI log carries the headline numbers.
    let counts = report.totals_by_category();
    eprintln!(
        "  covered={} ironhorse-failures={} unsupported={} skipped={} infrastructure={}",
        counts.covered,
        counts.ironhorse_failure,
        counts.unsupported,
        counts.skipped,
        counts.infrastructure
    );
}

fn fail(message: &str) -> ! {
    eprintln!("ironhorse-262-report: {}", message);
    exit(2);
}

const HELP: &str = "\
ironhorse-262-report: whole-tree test262 sweep orchestration + reporting

USAGE:
    ironhorse-262-report <SUBCOMMAND> [OPTIONS]

SUBCOMMANDS:
    discover   [--test262-dir DIR] [--subtree PREFIX]
        Print every case-count-capped batch under the test262 test/ tree.

    plan       --results DIR --test262-dir DIR [--subtree PREFIX] [--run-id ID]
        Print the batches not yet completed in the results dir (resume plan).
        With --run-id, a batch stamped with a different identity is pending.

    validate   --batch FILE [--run-id ID] [--expected-count N]
        Validate a complete batch file for atomic promotion/resume. With
        --run-id, also reject a batch stamped with a different identity.

    aggregate  --results DIR --provenance FILE --plan FILE --json OUT [--html OUT] [--expected-total N]
        Merge per-batch JSON into the stable report.json (+ optional HTML).
        Aggregate EXACTLY the batches the required plan names, bound to the
        provenance run identity — never a directory glob — and fail on any
        missing/mismatched batch. With --expected-total, fail unless the merged
        case count equals N (the discovery total).

    batch-size
        Print the single-source partition cap (cases per batch) the runner's
        --batch-size and discovery share.

    batch-filename BATCH
        Print the injective result-file basename for BATCH.

    batch-count --test262-dir DIR --batch BATCH
        Print the expected case count for one discovered batch.

    json-string VALUE
        Print VALUE as a JSON string literal.

    quarantine --test262-dir DIR --batch BATCH --run-id ID --reason REASON --json OUT
        Write an infrastructure-classified batch after repeated worker failures.

The oracle-heavy per-case execution is `endot-ih --direct-only --json`; this CLI
never runs a case, so every subcommand is deterministic and fast.
";
