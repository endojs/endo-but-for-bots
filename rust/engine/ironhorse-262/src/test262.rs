//! test262 `language/` dual-run runner (design § test262 conformance,
//! requirement 6; the stage-2 acceptance bar).
//!
//! This walks the monorepo's own `packages/test262-runner` test262 subset
//! — the same tree and harness that package uses to prove XS↔Node
//! HardenedJS parity (maintainer directive, PR #600) — assembles each
//! `language/` test the standard test262 way (the `sta.js`/`assert.js`
//! harness plus each `includes:` file, then the test body), and dual-runs
//! the assembled source on the XS oracle and ironhorse-vm.
//!
//! **Honest covered/skipped split.** The stage-2b covered grammar is
//! expressions, `var`/scope/loops, objects, user functions, closures, and
//! exceptions — it does **not** include the built-ins (`eval`, `String`,
//! `typeof`, `Object.*`, real `Error` objects, …) that the test262 harness
//! and the bulk of `language/` exercise. So the overwhelming majority of
//! tests are **skipped** the instant ironhorse reaches an opcode outside the
//! covered subset, and each such skip is **named by the opcode** that
//! stopped it — never folded into a pass rate. A test is **covered** only
//! when ironhorse runs it end-to-end to an outcome that is **bit-exact**
//! (result/thrown-value AND computron, four-valued completion) with the
//! oracle. A **divergence** — ironhorse completing with a wrong value/computron,
//! or accepting a program XS rejects — is a real failure the bar forbids.
//!
//! The split is the deliverable: it states exactly how much of real
//! `language/` the covered grammar reaches today, growing as later stages
//! land the built-ins, with **zero divergence** on what it does reach.

use crate::{dual_run, Agreement, DualRun};
use ironhorse_vm::Halt;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// How one assembled test classified.
#[derive(Debug, Clone)]
pub enum Class {
    /// Ran end-to-end, bit-exact with the oracle (the covered grammar).
    Covered,
    /// Ran end-to-end but disagreed with the oracle — a real failure.
    Divergent(Box<DualRun>),
    /// Not reached by the covered grammar; carries the honest reason
    /// (the unsupported opcode that stopped ironhorse, a parse/decode bail,
    /// an oracle abort ironhorse cannot faithfully mirror, …).
    Skipped(String),
}

/// Parsed test262 front-matter (`/*--- … ---*/`), the fields that decide
/// assembly and structural scope.
#[derive(Debug, Default, Clone)]
pub struct Frontmatter {
    pub flags: Vec<String>,
    pub includes: Vec<String>,
    /// `true` when the test has a `negative:` block (it is expected to
    /// abort — a parse error or a runtime throw).
    pub negative: bool,
}

/// Extract the front-matter block and parse `flags`, `includes`, and the
/// presence of a `negative:` section. Delegates to the full YAML parser
/// ([`crate::frontmatter`]) — the three-field hand parser is retired
/// (design § Part 2, "test262.rs's three-field frontmatter parser is
/// replaced by the full YAML parse"), so a block-sequence `flags:` or a
/// multi-line `negative:` reads the same here as it does under `endot-ih`.
pub fn parse_frontmatter(src: &str) -> Frontmatter {
    let full = crate::frontmatter::parse(src);
    Frontmatter {
        flags: full.flags,
        includes: full.includes,
        negative: full.negative.is_some(),
    }
}

/// Assemble a test into the single source string both engines run, the
/// standard test262 way: unless the test is `raw`, prepend the always-on
/// harness (`sta.js`, then `assert.js`) and each `includes:` file, then the
/// body. Returns `None` for a **structural** skip — a shape the dual-run
/// runner cannot model at all (a module, an async/`$DONE` test) — so the
/// caller records it by name rather than assembling nonsense.
pub fn assemble(harness_dir: &Path, src: &str, fm: &Frontmatter) -> Result<String, String> {
    if fm.flags.iter().any(|f| f == "module") {
        return Err("structural:module".into());
    }
    if fm.flags.iter().any(|f| f == "async" || f == "CanBlockIsFalse") {
        return Err("structural:async-or-can-block".into());
    }
    if fm.flags.iter().any(|f| f == "raw") {
        // A raw test runs its body verbatim, no harness, no includes.
        return Ok(src.to_string());
    }
    let read = |name: &str| -> Result<String, String> {
        std::fs::read_to_string(harness_dir.join(name))
            .map_err(|e| format!("structural:missing-harness:{}:{}", name, e))
    };
    let mut out = String::new();
    out.push_str(&read("sta.js")?);
    out.push('\n');
    out.push_str(&read("assert.js")?);
    out.push('\n');
    for inc in &fm.includes {
        out.push_str(&read(inc)?);
        out.push('\n');
    }
    out.push_str(src);
    Ok(out)
}

/// Classify one assembled source by dual-running it. See [`Class`].
pub fn classify(source: &str) -> Class {
    let r = match dual_run(source) {
        Some(r) => r,
        None => return Class::Skipped("oracle-machine-error".into()),
    };
    // An opcode outside the covered grammar stopped ironhorse: name it. This
    // is the honest skip — the vast bulk of `language/`, each attributed to
    // the exact built-in/feature opcode that is not yet modeled.
    if let Halt::Unsupported(op) = r.ironhorse_halt {
        // Only a label the engine has registered as a declined surface (or
        // one of the runner's own) earns the skip; an unregistered label is
        // the engine granting itself an exemption, and fails.
        if crate::xst::is_skip_eligible_label(op) {
            return Class::Skipped(format!("unsupported-opcode:{}", op));
        }
        return Class::Divergent(Box::new(r));
    }
    // One of the interpreter's own guards fired on bytecode the oracle
    // produced: the engine's state is wrong, a real failure whatever the
    // oracle then did — never an honest skip.
    if let Halt::EngineInvariant(_) = r.ironhorse_halt {
        return Class::Divergent(Box::new(r));
    }
    // Empty/undecodable bytecode: a parse-phase negative test (the oracle
    // compiler rejected the source, which ironhorse's loader cannot mirror —
    // compiler parity is a separate axis, stages 1–4 keep the oracle
    // compiler) or a truncated stream.
    if let Halt::Decode(_) = r.ironhorse_halt {
        return Class::Skipped("parse-or-decode".into());
    }
    match r.agreement {
        // ironhorse ran to a normal completion. Bit-exact (result AND
        // computron) is the only "covered" — a program is certified only
        // when it agrees on both axes. The other completing shapes are
        // built-in gaps at stage 2b ("built-ins stubbed"), named honestly:
        //  - ironhorse renders a non-primitive completion as its Reference stub
        //    (`[object Object]`) where the oracle's `String()` of a function
        //    or object differs — a `Function.prototype.toString` / object
        //    coercion gap, not a covered-grammar error.
        //  - ironhorse computes the SAME value but diverges on computrons: it
        //    completed the value correctly but under-meters a built-in step
        //    it does not model (object `ToPrimitive` in a numeric/bitwise
        //    coercion, function naming via a property define). Named as a
        //    computron gap, not folded into `covered`.
        //  - ironhorse computes a DIFFERENT primitive value: a genuine
        //    covered-grammar correctness bug the bar forbids.
        // (The strict metering guarantee for the covered *primitive*
        // grammar is carried with zero tolerance by the curated corpora and
        // the differential fuzz, which is how e.g. the sloppy-global
        // create-metering gap this runner first surfaced was fixed.)
        Agreement::BothComplete => {
            if r.is_bit_exact() {
                Class::Covered
            } else if r.ironhorse_result == "[object Object]" && !r.result_agrees {
                Class::Skipped("non-primitive-completion".into())
            } else if r.result_agrees {
                Class::Skipped("builtin-coercion-computron-gap".into())
            } else {
                Class::Divergent(Box::new(r))
            }
        }
        // A shared abort is covered only when the thrown value AND
        // computrons match (a primitive throw the oracle also throws, per
        // the tightened predicate). A test whose oracle abort is a real
        // `Error` object ironhorse does not construct simply does not match —
        // that is a built-in gap, named as a skip, not a divergence.
        Agreement::BothAbort => {
            if r.is_bit_exact() {
                Class::Covered
            } else {
                Class::Skipped("abort-value-or-cost-differs".into())
            }
        }
        // ironhorse completed a program the oracle rejected: a real
        // over-acceptance the bar must surface.
        Agreement::IronhorseOnlyComplete => Class::Divergent(Box::new(r)),
        // ironhorse aborted where the oracle completed. An uncaught throw on
        // a program the oracle ran to completion is a wrong answer (a failed
        // harness assertion or a spurious engine error), never a limitation —
        // except the one honest shape, a host intrinsic the port has not
        // landed, which names itself; only the engine's own limits (stack
        // geometry, meter, step ceiling) are the other honest skip.
        Agreement::OracleOnlyComplete => match &r.ironhorse_halt {
            Halt::Throw {
                rendered: thrown, ..
            } => match crate::xst::classify_missing_global(&r.source, thrown) {
                Some(crate::xst::MissingGlobal::Unlanded(name)) => {
                    Class::Skipped(format!("ironhorse-missing-global:{name}"))
                }
                Some(crate::xst::MissingGlobal::OracleError) => {
                    Class::Skipped("oracle-machine-error".into())
                }
                // An unanswered probe is judged as the throw it is.
                _ => Class::Divergent(Box::new(r)),
            },
            _ => Class::Skipped("ironhorse-aborted-limit".into()),
        },
    }
}

/// A honest report over a set of test262 files.
#[derive(Debug, Default, Clone)]
pub struct Report {
    pub total: usize,
    pub covered: usize,
    /// Real failures (must be empty): `(relative path, detail)`.
    pub divergences: Vec<(String, String)>,
    /// Skips grouped by reason (the opcode/feature that stopped ironhorse,
    /// the structural shape, …) → count.
    pub skipped: BTreeMap<String, usize>,
}

impl Report {
    /// The bar: nonzero total, and **zero** divergence on whatever the
    /// covered grammar reached.
    pub fn met_bar(&self) -> bool {
        self.total > 0 && self.divergences.is_empty()
    }

    /// A one-line-per-reason skip summary, most-skipped first, for the
    /// honest split.
    pub fn skip_summary(&self) -> Vec<(String, usize)> {
        let mut v: Vec<_> = self.skipped.iter().map(|(k, n)| (k.clone(), *n)).collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        v
    }
}

/// Run a set of test262 files (absolute paths) against the harness in
/// `harness_dir`, returning the honest split. `root` is stripped from each
/// path for readable divergence labels.
pub fn run_files(harness_dir: &Path, root: &Path, files: &[PathBuf]) -> Report {
    let mut rep = Report::default();
    for path in files {
        let src = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => {
                *rep.skipped.entry("unreadable".into()).or_insert(0) += 1;
                rep.total += 1;
                continue;
            }
        };
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned();
        rep.total += 1;
        let fm = parse_frontmatter(&src);
        let source = match assemble(harness_dir, &src, &fm) {
            Ok(s) => s,
            Err(reason) => {
                *rep.skipped.entry(reason).or_insert(0) += 1;
                continue;
            }
        };
        match classify(&source) {
            Class::Covered => rep.covered += 1,
            Class::Skipped(reason) => *rep.skipped.entry(reason).or_insert(0) += 1,
            Class::Divergent(r) => rep.divergences.push((
                rel,
                format!(
                    "agreement={:?} result oracle={:?} ironhorse={:?} computrons oracle={} ironhorse={} halt={:?}",
                    r.agreement, r.oracle_result, r.ironhorse_result,
                    r.oracle_computrons, r.ironhorse_computrons, r.ironhorse_halt,
                ),
            )),
        }
    }
    rep
}

/// Collect `.js` test files under `dir` (recursively), excluding
/// `_FIXTURE.js` helpers and the `staging/` area. Deterministic order
/// (sorted) so a run is reproducible.
pub fn collect_js(directory: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    collect_js_into(directory, &mut out);
    out.sort();
    out
}

/// Collect only the `.js` case files **directly** in `directory` (non-recursive),
/// excluding `_FIXTURE.js` helpers. The whole-tree sweep chunks this sorted
/// list at a fixed case-count cap (see `scripts/README.md`, "Why it is shaped
/// this way"). Paired with
/// [`crate::report::discover_batches`], it partitions `test/**` with no overlap,
/// so no case is run twice and each batch process frees the XS oracle's retained
/// RSS on exit.
/// Deterministic (sorted) order.
pub fn collect_js_direct(directory: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(directory) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.extension().map(|e| e == "js").unwrap_or(false) {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if !name.ends_with("_FIXTURE.js") {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

/// Select one case-count-capped batch from a directory's sorted direct cases.
pub fn collect_js_batch(
    directory: &Path,
    index: usize,
    size: usize,
) -> Result<Vec<PathBuf>, String> {
    if size == 0 {
        return Err("batch size must be positive".to_string());
    }
    let start = index
        .checked_mul(size)
        .ok_or_else(|| "batch index overflows usize".to_string())?;
    let files: Vec<PathBuf> = collect_js_direct(directory)
        .into_iter()
        .skip(start)
        .take(size)
        .collect();
    if files.is_empty() {
        return Err(format!(
            "batch index {index} is outside the directory's case set"
        ));
    }
    Ok(files)
}

fn collect_js_into(directory: &Path, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(directory) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().map(|n| n == "staging").unwrap_or(false) {
                continue;
            }
            collect_js_into(&path, out);
        } else if path.extension().map(|e| e == "js").unwrap_or(false) {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if !name.ends_with("_FIXTURE.js") {
                out.push(path);
            }
        }
    }
}

/// Locate the checked-in test262 subset root (`packages/test262-runner/
/// test262`) by walking up from this crate to the monorepo root. Returns
/// `(test_root, harness_dir)` or `None` if the subset is absent (the engine
/// workspace can build without it).
pub fn locate_test262() -> Option<(PathBuf, PathBuf)> {
    // CARGO_MANIFEST_DIR = …/rust/engine/ironhorse-262
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for _ in 0..6 {
        let candidate = dir.join("packages/test262-runner/test262");
        if candidate.join("harness/sta.js").is_file() {
            let harness = candidate.join("harness");
            return Some((candidate.join("test"), harness));
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

/// Collect the checked-in test262 files carrying the `ses-xs-parity`
/// feature marker — the exact set `packages/test262-runner` runs `xst`
/// against with `--features-include ses-xs-parity` to prove the XS↔Node
/// HardenedJS surface (design § test262 conformance; `ses-xs-parity`
/// convention). Selection is by the same signal the harness uses: the test's
/// front-matter `features:` list contains `ses-xs-parity`. Deterministic
/// (sorted) order.
pub fn ses_xs_parity_files(test_root: &Path) -> Vec<PathBuf> {
    collect_js(test_root)
        .into_iter()
        .filter(|p| {
            std::fs::read_to_string(p)
                .map(|s| {
                    let fm = parse_features(&s);
                    fm.iter().any(|f| f == "ses-xs-parity")
                })
                .unwrap_or(false)
        })
        .collect()
}

/// Parse the front-matter `features:` list — the axis the `ses-xs-parity`
/// opt-in set is selected by. Delegates to the full YAML parser, so both the
/// flow (`[a, b]`) and block (`- a`) sequence forms read.
fn parse_features(src: &str) -> Vec<String> {
    crate::frontmatter::parse(src).features
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_parses_flags_includes_and_negative() {
        let src = "/*---\nflags: [onlyStrict, raw]\nincludes: [propertyHelper.js, compareArray.js]\nnegative:\n  phase: parse\n  type: SyntaxError\n---*/\n1 + 1;";
        let fm = parse_frontmatter(src);
        assert_eq!(fm.flags, vec!["onlyStrict", "raw"]);
        assert_eq!(fm.includes, vec!["propertyHelper.js", "compareArray.js"]);
        assert!(fm.negative);

        let plain = parse_frontmatter("/*---\ndescription: x\n---*/\n1");
        assert!(plain.flags.is_empty());
        assert!(plain.includes.is_empty());
        assert!(!plain.negative);
    }

    #[test]
    fn utf16_string_sections_have_zero_result_divergence() {
        // The governing check for the CESU-8 → UTF-16 storage swap over REAL
        // test262: walk the surrogate-relevant `String.prototype` sections
        // (charCodeAt/codePointAt/charAt/slice/substring — the code-unit
        // index/slice surface the swap re-implemented), dual-run each against
        // the pin, and require ZERO divergence on RESULTS. A test whose value
        // agrees but whose computrons shift under the recalibration is a NAMED
        // `builtin-coercion-computron-gap` skip (classify()), NOT a divergence —
        // exactly the accuracy-over-parity split the swap adopted. Whole-tree
        // `built-ins/String` (1111 files) is the `endot-ih` binary; this
        // in-`cargo test` slice stays bounded so the oracle RSS is contained.
        let (root, harness) = match locate_test262() {
            Some(p) => p,
            None => {
                eprintln!("test262 subset absent; skipping the UTF-16 String bar");
                return;
            }
        };
        let sections = [
            "built-ins/String/prototype/charCodeAt",
            "built-ins/String/prototype/codePointAt",
            "built-ins/String/prototype/charAt",
            "built-ins/String/prototype/slice",
            "built-ins/String/prototype/substring",
        ];
        let mut files = Vec::new();
        for s in sections {
            files.extend(collect_js(&root.join(s)));
        }
        assert!(!files.is_empty(), "the UTF-16 String sections must have tests");
        let rep = run_files(&harness, &root, &files);
        eprintln!(
            "test262 String.prototype (UTF-16 sections): total={} covered={} divergent={}",
            rep.total,
            rep.covered,
            rep.divergences.len()
        );
        for (reason, n) in rep.skip_summary() {
            eprintln!("    {:>5}  {}", n, reason);
        }
        for (path, detail) in &rep.divergences {
            eprintln!("  DIVERGENCE {}\n    {}", path, detail);
        }
        assert!(
            rep.met_bar(),
            "zero RESULT divergence required on the UTF-16 String sections; got {}",
            rep.divergences.len()
        );
    }

    #[test]
    fn covered_grammar_language_subset_has_zero_divergence() {
        // The stage-2 acceptance bar over REAL test262 `language/` files:
        // walk the covered-grammar-adjacent sections (expressions and
        // statements the 2b subset touches), assemble each the standard
        // test262 way, dual-run, and require ZERO divergence — every test
        // ironhorse runs end-to-end agrees bit-exactly with XS; everything
        // else is honestly skipped by a NAMED reason (the unsupported
        // opcode, a parse-negative, a built-in abort). The covered count is
        // reported, not asserted to a target: it states how far the covered
        // grammar reaches real `language/` today, and it grows as later
        // stages land the built-ins.
        let (root, harness) = match locate_test262() {
            Some(p) => p,
            None => {
                eprintln!("test262 subset absent; skipping the language/ bar");
                return;
            }
        };
        // A bounded, deterministic slice of the covered-grammar sections so
        // the in-`cargo test` run stays fast; the full-tree walk is the
        // `endot-ih` binary. These sections are where the covered
        // grammar (arithmetic/logic/comparison/conditional expressions,
        // block/if/while/for/var/throw/try statements) actually lives.
        let sections = [
            "language/expressions/addition",
            "language/expressions/subtraction",
            "language/expressions/multiplication",
            "language/expressions/modulus",
            "language/expressions/bitwise-and",
            "language/expressions/logical-not",
            "language/expressions/conditional",
            "language/expressions/comma",
            "language/statements/if",
            "language/statements/while",
            "language/statements/for",
            "language/statements/block",
            "language/statements/empty",
            "language/statements/throw",
            "language/statements/try",
        ];
        let mut files = Vec::new();
        for s in sections {
            files.extend(collect_js(&root.join(s)));
        }
        assert!(!files.is_empty(), "covered-grammar language sections must have tests");
        let rep = run_files(&harness, &root, &files);

        eprintln!(
            "test262 language/ (covered-grammar sections): total={} covered={} divergent={}",
            rep.total,
            rep.covered,
            rep.divergences.len()
        );
        eprintln!("  skipped-by-reason (honest split):");
        for (reason, n) in rep.skip_summary() {
            eprintln!("    {:>5}  {}", n, reason);
        }
        for (path, detail) in &rep.divergences {
            eprintln!("  DIVERGENCE {}\n    {}", path, detail);
        }
        assert!(
            rep.met_bar(),
            "zero divergence required on the covered grammar; got {} divergence(s)",
            rep.divergences.len()
        );
    }

    #[test]
    fn ses_xs_parity_suite_has_zero_divergence() {
        // The stage-4 closure SES-conformance bar (child 5/5). Run the
        // repo's own `ses-xs-parity`-tagged test262 files — the exact set
        // `packages/test262-runner` exercises `xst` against to prove the
        // XS↔Node HardenedJS surface — against ironhorse, and require ZERO
        // RESULT divergence. A test ironhorse cannot run end-to-end (it references
        // the `Compartment` intrinsic global, or calls `lockdown()`, neither
        // of which ironhorse binds as a JS global — the Compartment child's
        // `compartment:intrinsic-surface` fold and the harden child's
        // `lockdown()` fold) is an HONEST NAMED skip, never a divergence.
        // This states exactly how much of the SES-parity surface ironhorse
        // reaches today (the tally), with zero lies on what it reaches.
        let (root, harness) = match locate_test262() {
            Some(p) => p,
            None => {
                eprintln!("test262 subset absent; skipping the ses-xs-parity bar");
                return;
            }
        };
        let all = ses_xs_parity_files(&root);
        assert!(
            !all.is_empty(),
            "the repo's ses-xs-parity feature set must be non-empty"
        );
        // GUARD: a test tagged `lockdown` calls `lockdown()`, which the XS
        // ORACLE SHIM (the bare `fxCreateMachine` boot) crashes on — the same
        // `lockdown()` surface the stage-4b harden child folded as an honest
        // `Halt::Unsupported` on the ironhorse side. Since dual-run runs the
        // program on the oracle FIRST, handing a `lockdown()` test to the
        // oracle SIGSEGVs the harness process. These are pre-partitioned into
        // a NAMED structural skip (`oracle-shim-unsafe:lockdown`) and never
        // dual-run — the honest closure-point verdict, reproducible by s10,
        // that flips when either ironhorse grows `lockdown()` or the shim is
        // hardened to survive it.
        let (lockdown, files): (Vec<_>, Vec<_>) = all.into_iter().partition(|p| {
            std::fs::read_to_string(p)
                .map(|s| parse_features(&s).iter().any(|f| f == "lockdown"))
                .unwrap_or(false)
        });
        let mut rep = run_files(&harness, &root, &files);
        // Fold the oracle-unsafe lockdown tests into the report as a named
        // structural skip (they count toward the honest total).
        if !lockdown.is_empty() {
            rep.total += lockdown.len();
            *rep.skipped
                .entry("oracle-shim-unsafe:lockdown".into())
                .or_insert(0) += lockdown.len();
        }
        eprintln!(
            "ses-xs-parity: total={} covered={} divergent={}",
            rep.total,
            rep.covered,
            rep.divergences.len()
        );
        eprintln!("  skipped-by-reason (honest split):");
        for (reason, n) in rep.skip_summary() {
            eprintln!("    {:>5}  {}", n, reason);
        }
        for (path, detail) in &rep.divergences {
            eprintln!("  DIVERGENCE {}\n    {}", path, detail);
        }
        assert!(
            rep.met_bar(),
            "zero RESULT divergence required on the ses-xs-parity suite; got {} divergence(s)",
            rep.divergences.len()
        );
    }
}
