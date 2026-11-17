//! `halt-classification-lint [--root <repo>] [<file.rs>...]`
//!
//! With no files, lints every commit-path source under the repository
//! (default: the checkout this crate lives in) and reports stale allowlist
//! entries. With files, lints just those, under the same allowlist.
//!
//! Exit status: 0 clean, 1 on any finding, 2 when a source cannot be read
//! or parsed (so a CI step can tell "the rule is violated" from "the lint
//! broke").

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use halt_classification_lint::{lint_source, lint_tree, relative, Finding, LintError, ALLOWED};

fn main() -> ExitCode {
    let mut root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut files = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--root" => match args.next() {
                Some(dir) => root = PathBuf::from(dir),
                None => return usage(),
            },
            "-h" | "--help" => return usage(),
            _ => files.push(PathBuf::from(arg)),
        }
    }
    let root = match root.canonicalize() {
        Ok(root) => root,
        Err(e) => return broke(&LintError::Io(root, e)),
    };
    let result = if files.is_empty() {
        lint_tree(&root, ALLOWED)
    } else {
        lint_files(&root, &files)
    };
    match result {
        Ok(findings) if findings.is_empty() => ExitCode::SUCCESS,
        Ok(findings) => {
            for finding in &findings {
                eprintln!("{finding}");
            }
            eprintln!(
                "halt-classification-lint: {} finding(s); see designs/ironhorse-panic.md \
                 § The Formal `Panic` Category",
                findings.len()
            );
            ExitCode::from(1)
        }
        Err(e) => broke(&e),
    }
}

fn lint_files(root: &Path, files: &[PathBuf]) -> Result<Vec<Finding>, LintError> {
    let mut findings = Vec::new();
    for file in files {
        let path = file
            .canonicalize()
            .map_err(|e| LintError::Io(file.clone(), e))?;
        let source = std::fs::read_to_string(&path).map_err(|e| LintError::Io(path.clone(), e))?;
        findings.extend(lint_source(&relative(root, &path), &source, ALLOWED)?.findings);
    }
    Ok(findings)
}

fn usage() -> ExitCode {
    eprintln!("usage: halt-classification-lint [--root <repo>] [<file.rs>...]");
    ExitCode::from(2)
}

fn broke(e: &LintError) -> ExitCode {
    eprintln!("halt-classification-lint: {e}");
    ExitCode::from(2)
}
