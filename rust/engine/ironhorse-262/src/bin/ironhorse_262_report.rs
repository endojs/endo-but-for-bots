//! `ironhorse-262-report`: the whole-tree sweep's orchestration + reporting CLI
//! (maintainer request, kriskowal/garden#51). It is the deterministic,
//! oracle-free half of the full run — every subcommand is pure filesystem work,
//! unit-tested in [`ironhorse_262::report`] — leaving the heavy per-case oracle
//! execution to `ironhorse-xst`, which the orchestrator (`scripts/full-run.sh`)
//! drives one batch per process so the XS oracle's retained RSS cannot OOM.
//!
//! Subcommands:
//!   discover   --test262-dir DIR [--subtree PREFIX]
//!       Print, one per line, every per-directory batch under the test262
//!       `test/` tree (each a directory holding direct `.js` cases). This is
//!       the discovery audit: it covers the entire official `test/**` tree with
//!       no curated-subtree filter, so no unsupported feature is hidden.
//!
//!   plan       --results DIR --test262-dir DIR [--subtree PREFIX]
//!       Print the batches NOT yet on disk in the results dir — the resume plan.
//!       After an interruption the completed per-batch JSON files remain, so a
//!       re-run continues where it stopped.
//!
//!   aggregate  --results DIR [--provenance FILE] --json OUT [--html OUT]
//!       Merge every per-batch JSON in the results dir (deterministically,
//!       sorted by path) with the provenance into the stable machine-readable
//!       `report.json` and the self-contained static HTML report.

use ironhorse_262::report::{
    aggregate, discover_batches, pending_batches, read_provenance, to_html, Provenance,
};
use ironhorse_262::test262::locate_test262;
use std::path::PathBuf;
use std::process::exit;

fn main() {
    let mut args = std::env::args().skip(1);
    let cmd = args.next().unwrap_or_else(|| {
        eprintln!("{}", HELP);
        exit(2);
    });
    let rest: Vec<String> = args.collect();
    match cmd.as_str() {
        "discover" => cmd_discover(&rest),
        "plan" => cmd_plan(&rest),
        "aggregate" => cmd_aggregate(&rest),
        "-h" | "--help" | "help" => println!("{}", HELP),
        other => {
            eprintln!("ironhorse-262-report: unknown subcommand: {}", other);
            eprintln!("{}", HELP);
            exit(2);
        }
    }
}

/// Minimal `--flag value` / `--flag` option scan. Returns the value after
/// `name`, or `None`.
fn opt(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

/// Resolve the test262 `test/` root: `--test262-dir DIR` (with `test/`), else
/// the checked-in subset via [`locate_test262`].
fn resolve_test_root(args: &[String]) -> PathBuf {
    match opt(args, "--test262-dir") {
        Some(dir) => {
            let root = PathBuf::from(&dir).join("test");
            if !root.is_dir() {
                fail(&format!("no test/ under --test262-dir {}", dir));
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
fn discover_scoped(args: &[String]) -> Vec<String> {
    let root = resolve_test_root(args);
    let mut batches = discover_batches(&root);
    if let Some(prefix) = opt(args, "--subtree") {
        let prefix = prefix.trim_end_matches('/');
        batches.retain(|b| b == prefix || b.starts_with(&format!("{}/", prefix)));
    }
    batches
}

fn cmd_discover(args: &[String]) {
    let batches = discover_scoped(args);
    for b in &batches {
        println!("{}", b);
    }
    eprintln!("ironhorse-262-report: discovered {} batches", batches.len());
}

fn cmd_plan(args: &[String]) {
    let results =
        PathBuf::from(opt(args, "--results").unwrap_or_else(|| fail("plan needs --results DIR")));
    let batches = discover_scoped(args);
    let pending = pending_batches(&results, &batches);
    for b in &pending {
        println!("{}", b);
    }
    eprintln!(
        "ironhorse-262-report: {} of {} batches pending (resume)",
        pending.len(),
        batches.len()
    );
}

fn cmd_aggregate(args: &[String]) {
    let results = PathBuf::from(
        opt(args, "--results").unwrap_or_else(|| fail("aggregate needs --results DIR")),
    );
    let json_out =
        PathBuf::from(opt(args, "--json").unwrap_or_else(|| fail("aggregate needs --json OUT")));
    let provenance: Provenance = match opt(args, "--provenance") {
        Some(p) => read_provenance(&PathBuf::from(p)),
        None => Provenance::default(),
    };
    let report = aggregate(&results, provenance);

    if let Err(e) = std::fs::write(&json_out, report.to_json()) {
        fail(&format!("could not write {}: {}", json_out.display(), e));
    }
    eprintln!(
        "ironhorse-262-report: wrote {} ({} cases)",
        json_out.display(),
        report.total()
    );
    if let Some(html_out) = opt(args, "--html") {
        let html_out = PathBuf::from(html_out);
        if let Err(e) = std::fs::write(&html_out, to_html(&report)) {
            fail(&format!("could not write {}: {}", html_out.display(), e));
        }
        eprintln!("ironhorse-262-report: wrote {}", html_out.display());
    }

    // A concise console summary so a CI log carries the headline numbers.
    let cc = report.totals_by_category();
    eprintln!(
        "  covered={} ironhorse-failures={} unsupported={} skipped={} infrastructure={}",
        cc.covered, cc.ironhorse_failure, cc.unsupported, cc.skipped, cc.infrastructure
    );
}

fn fail(msg: &str) -> ! {
    eprintln!("ironhorse-262-report: {}", msg);
    exit(2);
}

const HELP: &str = "\
ironhorse-262-report: whole-tree test262 sweep orchestration + reporting

USAGE:
    ironhorse-262-report <SUBCOMMAND> [OPTIONS]

SUBCOMMANDS:
    discover   --test262-dir DIR [--subtree PREFIX]
        Print every per-directory batch under the test262 test/ tree.

    plan       --results DIR --test262-dir DIR [--subtree PREFIX]
        Print the batches not yet completed in the results dir (resume plan).

    aggregate  --results DIR [--provenance FILE] --json OUT [--html OUT]
        Merge per-batch JSON into the stable report.json (+ optional HTML).

The oracle-heavy per-case execution is `ironhorse-xst --flat --json`; this CLI
never runs a case, so every subcommand is deterministic and fast.
";
