//! `ironhorse-xst`: the xst-analogue test262 runner for the Rust engine
//! (design [`designs/ironhorse-test262-convergence.md`] § Part 2,
//! "Harness -> `ironhorse-xst`"). It plays for ironhorse exactly the role
//! `xs/tools/xst.c` + `xst262.c` (@ `48ee02d8cfe0`) play for XS, plus the
//! one thing `xst` never had: a differential oracle.
//!
//! This module is the runner core (rollout step 1): full YAML frontmatter
//! ([`crate::frontmatter`]), the ironhorse not-yet-implemented feature skip list
//! + `--features-include`, sloppy+strict double-run mode selection, negative
//! verdicts (constructor name vs `negative.type`, stack/memory aborts accepted for an expected
//! `RangeError`), the dual-run oracle wiring (verdict + observable agreement
//! gating, computron advisory, `--gate-meter-exact`, `--repeat N`
//! determinism), and the xst-shaped YAML report (`mode:` / `skip:` /
//! `fail:` plus the ironhorse `advisory:` and `skip-detail:` extensions).
//!
//! It subsumes the dual-run harness rather than sitting beside it: the same
//! `assemble()` order (`sta.js`, `assert.js`, includes, body) and the same
//! [`crate::dual_run`] differential, with the verdict layer grown on top.
//! The oracle and Ironhorse both execute source-level programs. Parse-phase
//! negatives therefore compare the two front ends directly.

use crate::frontmatter::{self, Frontmatter, Negative};
use crate::report::CaseRecord;
use crate::{dual_run, dual_run_async, Agreement, AsyncDualRun, DualRun, IronhorseCompile};
use ironhorse_vm::Halt;
use std::collections::{BTreeMap, HashSet};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};

/// The ironhorse not-yet-implemented feature skip list — the analogue of
/// `xst262.c`'s 13-entry `gxFeatures`. A test whose frontmatter `features:`
/// names any of these is skipped before it runs, reported in the report's
/// `skip:` section by feature name (design § Part 2, "ironhorse skip list").
///
/// This is deliberately the coarse, well-known not-landed surface, not an
/// exhaustive enumeration of every unimplemented feature: the honest split
/// still names everything else at the exact unsupported opcode when a run
/// reaches it (`skip-detail:`), so an under-inclusive list only moves a skip
/// from `feature:` to `unsupported-opcode:`, never hides it. Trimmed as the
/// stage ladder lands each surface; `--features-include <feature>` opts a
/// set back in (e.g. `ses-xs-parity` once stage-4 lockdown/Compartment
/// lands), matching the npm `test262-harness` idiom the repo drives `xst`
/// with.
pub const DEFAULT_ENDOR_SKIP_FEATURES: &[&str] = &[
    // xst `gxFeatures` analogues — surfaces ironhorse does not implement.
    "Temporal",
    "ShadowRealm",
    // `Atomics`/`SharedArrayBuffer` are now implemented single-agent
    // (`ironhorse-vm::interp` `create_atomics` + the `SharedArrayBuffer`
    // constructor). The truly multi-agent slice (`$262.agent`) is a structural
    // host exclusion below, not a feature pre-skip.
    "tail-call-optimization",
    "IsHTMLDDA",
    // The guest Hardened-JavaScript surface ironhorse does not yet expose as a
    // guest-callable intrinsic: `lockdown()` (a named scope fold in
    // `ironhorse-vm::interp::create_hardened_globals`) and the `Compartment`
    // constructor (a named scope fold in `ironhorse-vm::compartment`, modeled as
    // a host-side Rust realm API, not a guest intrinsic). ironhorse DOES land the
    // guest `harden`/`petrify` globals, so those are never skipped. This is
    // the direct `xst262.c` `gxFeatures` analogue — a feature the *engine*
    // does not implement — and is trimmed as the guest surface lands. A
    // `ses-xs-parity` test that needs either self-names `feature:Compartment`
    // / `feature:lockdown` here rather than a generic run-time abort.
    "lockdown",
    "Compartment",
    // Hardened-JavaScript / SES parity opt-in set: needs the stage-4
    // lockdown/Compartment surface, not yet landed. Opt in explicitly with
    // `--features-include ses-xs-parity` once it does.
    "ses-xs-parity",
];

/// The SES lockdown/compartment mode — ironhorse-xst's analogue of `xst262.c`'s
/// `-l` / `-lc` / `-c` (design § Part 2, the lockdown/compartment row). It
/// selects the Hardened-JavaScript setup applied to every case before it
/// runs, exactly as `xst` calls `lockdown()` and/or evaluates the body in a
/// `Compartment`. This is the engine-side entry point of the "ironhorse as a
/// third `packages/test262-runner` host alongside `xst` and `node`" the
/// engine design promises: the `ses-xs-parity` axis runs `xst -l`, `node`
/// with the SES prelude, and `ironhorse-xst -l`.
///
/// Because the guest surface these modes need (`lockdown()`, the
/// `Compartment` intrinsic) is a named scope fold ironhorse does not yet expose
/// (only the host-side realm API + the guest `harden`/`petrify` globals are
/// landed), a case run under a mode other than [`SesMode::None`] is a
/// whole-case *named* pre-skip ([`SesMode::unimplemented_skip`]) rather than
/// a generic abort or a false failure — the honest split. When the guest
/// `lockdown`/`Compartment`
/// surface lands, `unimplemented_skip` returns `None` and the mode's prelude
/// ([`SesMode::prelude`]) is applied to the assembled source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SesMode {
    /// No lockdown/compartment setup (the default; `xst` with no `-l`/`-c`).
    #[default]
    None,
    /// `-l`: `lockdown()` before the case (freeze the shared intrinsics).
    Lockdown,
    /// `-c`: evaluate the case body in a fresh `Compartment`.
    Compartment,
    /// `-lc`: `lockdown()`, then evaluate the body in a `Compartment`.
    LockdownCompartment,
}

impl SesMode {
    /// Parse the `xst`-shaped mode token (`l` / `lc` / `c`), as it appears
    /// after the `-` on the CLI or as the `--ses-mode` value.
    pub fn parse(token: &str) -> Option<SesMode> {
        match token {
            "l" => Some(SesMode::Lockdown),
            "c" => Some(SesMode::Compartment),
            "lc" | "cl" => Some(SesMode::LockdownCompartment),
            _ => None,
        }
    }

    /// The short `xst` name of the mode (`l` / `lc` / `c`), for the report's
    /// `mode:` section; `none` for [`SesMode::None`].
    pub fn short(self) -> &'static str {
        match self {
            SesMode::None => "none",
            SesMode::Lockdown => "l",
            SesMode::Compartment => "c",
            SesMode::LockdownCompartment => "lc",
        }
    }

    /// The Hardened-JavaScript prelude/wrap the mode applies to the assembled
    /// case — `xst`'s `lockdown()` call and/or `Compartment` evaluation. This
    /// is the shape that runs *once the guest surface lands*; today
    /// [`Self::unimplemented_skip`] short-circuits before it is reached, so it
    /// is the documented target, exercised by a unit test but not yet on the
    /// live run path. `{body}` is where the assembled source is spliced.
    pub fn prelude(self) -> &'static str {
        match self {
            SesMode::None => "{body}",
            SesMode::Lockdown => "lockdown();\n{body}",
            // The compartment wrap evaluates the assembled body in a fresh
            // compartment over the (optionally locked-down) shared intrinsics
            // — `new Compartment().evaluate(<body>)` in `xst`. ironhorse splices
            // the body directly (not as a string) since the guest evaluator
            // is what lands; until then this is unreached.
            SesMode::Compartment => "new Compartment().evaluate(function(){\n{body}\n});",
            SesMode::LockdownCompartment => {
                "lockdown();\nnew Compartment().evaluate(function(){\n{body}\n});"
            }
        }
    }

    /// The honest named skip a mode incurs while its guest surface is a scope
    /// fold, or `None` once ironhorse exposes the guest `lockdown`/`Compartment`
    /// surface. This is the single seam that flips these modes from
    /// whole-case named skips to real runs when the surface lands — remove a
    /// match arm (and the matching entry in [`DEFAULT_ENDOR_SKIP_FEATURES`])
    /// as each guest builtin is implemented.
    pub fn unimplemented_skip(self) -> Option<&'static str> {
        match self {
            SesMode::None => None,
            SesMode::Lockdown => Some("ses-mode:lockdown-unimplemented"),
            SesMode::Compartment => Some("ses-mode:compartment-unimplemented"),
            SesMode::LockdownCompartment => Some("ses-mode:lockdown-compartment-unimplemented"),
        }
    }
}

/// Runner configuration, derived from the CLI (design § Part 2, "dual-run
/// oracle wiring").
#[derive(Debug, Clone)]
pub struct Config {
    /// `--oracle` (default on) / `--no-oracle`: gate on verdict + observable
    /// agreement with the XS oracle. With it off, ironhorse's own verdict
    /// stands and an oracle disagreement cannot fail the build (it is
    /// demoted to a named skip).
    pub oracle: bool,
    /// `--gate-meter-exact`: tighten `ironhorse-meter-exact`-tagged cases to the
    /// historical bit-exact computron bar (a divergence fails). Off, the
    /// computron comparison is advisory only.
    pub gate_meter_exact: bool,
    /// `--repeat N`: re-run ironhorse N times and require identical computrons
    /// across runs — the unconditional determinism gate. Default 1 (no
    /// extra runs).
    pub repeat: u32,
    /// `--features-include <feature>`: features to remove from the skip set
    /// (opt them into the run).
    pub features_include: Vec<String>,
    /// `-l` / `-lc` / `-c` / `--ses-mode <l|lc|c>`: the SES lockdown/
    /// compartment mode applied to every case (the third-host `ses-xs-parity`
    /// axis runs `-l`). Default [`SesMode::None`].
    pub ses_mode: SesMode,
    /// `--feature-filter <feature>`: run **only** cases whose frontmatter
    /// `features:` lists this (the `test262-harness --features-include`
    /// semantics the repo drives `xst`/`node` with — distinct from
    /// ironhorse-xst's skip-list `--features-include`). Empty = no filter. Used
    /// to restrict a whole-tree walk to the `ses-xs-parity` axis.
    pub feature_filter: Vec<String>,
    /// `--case-timeout SECS`: the hard per-case wall-clock bound. Both the XS
    /// oracle and the ironhorse VM can non-terminate on a pathological source
    /// (e.g. `for (const i = 0; i < 1; i++) {}`, where a missing
    /// assign-to-const `TypeError` spins the loop), so each case is dispatched
    /// under this deadline. An Ironhorse-only non-terminator is an
    /// `ironhorse-hang` failure; an oracle-only one is an infrastructure skip.
    /// Either outcome avoids wedging the whole per-directory batch process. `0`
    /// disables the bound (an unbounded inline run), which is the **library
    /// default**: an in-process caller runs exactly as it did before this field
    /// existed. The
    /// bound is CLI *policy* — `ironhorse-xst` (and the sweep it drives) opts in
    /// to [`DEFAULT_CASE_TIMEOUT_SECONDS`], so a bound is never imposed on a
    /// caller that did not ask for one and a case's verdict never becomes
    /// load-dependent behind its back.
    pub per_case_timeout_seconds: u64,
}

/// The `ironhorse-xst` CLI's default per-case wall-clock bound (seconds).
/// Comfortably above the millisecond a normal dual-run takes — a case that needs
/// longer is non-terminating, not slow. This is CLI policy only; the library
/// [`Config::default`] leaves the bound off (see [`Config::per_case_timeout_seconds`]).
pub const DEFAULT_CASE_TIMEOUT_SECONDS: u64 = 10;

/// The native stack pinned on each bounded per-case worker thread. Matches the
/// repo's engine-thread convention (`rust/endo/src/endo.rs`, `inproc.rs`): 32
/// MiB, comfortably above the main thread's ~8 MiB, so relocating a case onto a
/// spawned thread never shrinks the stack the recursive-descent parser and the
/// XS oracle's C parser recurse on.
const CASE_THREAD_STACK_BYTES: usize = 32 * 1024 * 1024;

impl Default for Config {
    fn default() -> Self {
        Config {
            oracle: true,
            gate_meter_exact: false,
            repeat: 1,
            features_include: Vec::new(),
            ses_mode: SesMode::None,
            feature_filter: Vec::new(),
            // Off by default: the library imposes no bound on a caller that did
            // not ask for one. The CLI opts in to DEFAULT_CASE_TIMEOUT_SECONDS.
            per_case_timeout_seconds: 0,
        }
    }
}

/// One case's verdict — the section of the xst-shaped report it lands in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Ran end-to-end and met the bar (positive: observable agreement with
    /// the oracle; negative: the expected-type abort). The report's covered
    /// tally.
    Covered,
    /// Skipped before running — a declared-unimplemented feature, a
    /// structural shape (`module`) or an unavailable SES mode. The report's
    /// `skip:` section (xst's feature/flag skips).
    PreSkip(String),
    /// Skipped after attempting the run, named by the exact opcode / value /
    /// structural reason that stopped it — the honest split the port's
    /// progress instrument. The report's `skip-detail:` section (an ironhorse
    /// extension over `xst`).
    RunSkip(String),
    /// A real failure the bar forbids: a divergence from the oracle verdict
    /// or observable, an over-acceptance, a gated meter-exact violation, or
    /// a determinism failure. The report's `fail:` section.
    Fail(String),
}

/// The outcome of running one case through the mode/verdict machinery.
#[derive(Debug, Clone)]
pub struct CaseResult {
    pub verdict: Verdict,
    /// A strict variant was selected but deliberately omitted by a mode policy
    /// (currently the exact-metering corpus or an unavailable SES mode).
    pub strict_skipped: bool,
    /// The case was covered but ironhorse's computrons differed from the
    /// oracle's — advisory telemetry, never a failure by itself (design §
    /// Metering, accuracy-over-parity). Feeds the `advisory:` section.
    pub computron_gap: bool,
}

fn preskip(reason: &str) -> CaseResult {
    CaseResult {
        verdict: Verdict::PreSkip(reason.to_string()),
        strict_skipped: false,
        computron_gap: false,
    }
}

/// The effective feature skip set: the default not-implemented list minus
/// anything `--features-include` opted back in.
fn effective_skip_features(cfg: &Config) -> HashSet<String> {
    let opted: HashSet<&str> = cfg.features_include.iter().map(|s| s.as_str()).collect();
    DEFAULT_ENDOR_SKIP_FEATURES
        .iter()
        .filter(|f| !opted.contains(**f))
        .map(|f| f.to_string())
        .collect()
}

/// Strict-mode selection from a case's `flags` — ironhorse's mirror of
/// `xst262.c`'s default two-run (sloppy then strict) with the `onlyStrict` /
/// `noStrict` / `raw` selectors. Returns `(run_sloppy, run_strict,
/// only_strict)`. `module` is handled as a structural pre-skip before this
/// is consulted.
pub fn strict_mode_status(flags: &[String]) -> (bool, bool, bool) {
    let has = |name: &str| flags.iter().any(|f| f == name);
    if has("onlyStrict") {
        return (false, true, true);
    }
    // `raw` runs the body verbatim (no harness, no "use strict" prologue);
    // `noStrict` selects the single sloppy run.
    if has("noStrict") || has("raw") {
        return (true, false, false);
    }
    // The test262 default: two runs, sloppy then strict.
    (true, true, false)
}

/// The constructor name carried by a stringified thrown value —
/// `String(new TypeError("m"))` is `"TypeError: m"`, so the constructor is
/// the text before the first `:`; a bare `"RangeError"` (empty message) is
/// itself. This is the same shape `xst262.c`'s verdict compares against
/// `negative.type`.
pub fn constructor_name(err: &str) -> &str {
    match err.find(':') {
        Some(i) => err[..i].trim(),
        None => err.trim(),
    }
}

fn looks_like_overflow(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("stack") || e.contains("overflow") || e.contains("memory") || e.contains("allocat")
}

fn ironhorse_completed(a: Agreement) -> bool {
    matches!(
        a,
        Agreement::BothComplete | Agreement::IronhorseOnlyComplete
    )
}

fn oracle_completed(a: Agreement) -> bool {
    matches!(a, Agreement::BothComplete | Agreement::OracleOnlyComplete)
}

/// Does the oracle's run satisfy an expected runtime negative of type `ty`?
/// The oracle must have aborted with a thrown value whose constructor name
/// is `ty`, or — for an expected `RangeError` — exited on a memory/stack
/// abort (`xst262.c` accepts a machine memory/stack exit for a `RangeError`).
pub fn oracle_negative_ok(ty: &str, run: &DualRun) -> bool {
    if oracle_completed(run.agreement) {
        return false;
    }
    if constructor_name(&run.oracle_error) == ty {
        return true;
    }
    ty == "RangeError" && (run.oracle_error.is_empty() || looks_like_overflow(&run.oracle_error))
}

/// Does ironhorse's run satisfy an expected runtime negative of type `ty`? A
/// JS-level `Throw` whose constructor name is `ty`, or — for an expected
/// `RangeError` — ironhorse's fixed-geometry stack overflow or meter abort,
/// which map to XS's memory/stack-exit acceptance (design § Part 2,
/// "Negative verdict").
pub fn ironhorse_negative_ok(ty: &str, run: &DualRun) -> bool {
    match &run.ironhorse_halt {
        Halt::Throw(s) => constructor_name(s) == ty,
        Halt::StackOverflow(_) | Halt::MeterAbort => ty == "RangeError",
        _ => false,
    }
}

/// Assemble the sloppy source both engines run — the standard test262 order
/// (`sta.js`, `assert.js`, each `includes:` file, the body), or the body
/// verbatim for a `raw` test. Structural shapes the differential cannot
/// model (`module`, `async`) are handled by the caller before this; a
/// missing harness file is a named structural skip.
fn assemble(harness_dir: &Path, src: &str, fm: &Frontmatter) -> Result<String, String> {
    if fm.flags.iter().any(|f| f == "raw") {
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

/// Assemble the strict variant of a normal test262 script.  The directive is
/// inserted at the beginning of the executed Script. The harness is part of
/// that Script in this runner, so putting it before only the body would be
/// inert rather than a Directive Prologue.
fn assemble_strict(harness_dir: &Path, src: &str, fm: &Frontmatter) -> Result<String, String> {
    Ok(format!(
        "\"use strict\";\n{}",
        assemble(harness_dir, src, fm)?
    ))
}

struct Eval {
    outcome: Verdict,
    ironhorse_computrons: u64,
    computron_gap: bool,
}

/// Compute one case's verdict from a dual-run record already in hand and its
/// frontmatter (the negative/positive split). Shared by the synchronous
/// [`evaluate`] path and the async path ([`run_async_case`]), which supplies
/// its own dual-run so it can additionally read the completion latch.
fn verdict_for(cfg: &Config, run: &DualRun, fm: &Frontmatter, meter_exact_gate: bool) -> Verdict {
    match &fm.negative {
        Some(neg) => evaluate_negative(cfg, run, neg),
        None => evaluate_positive(cfg, run, meter_exact_gate),
    }
}

/// Evaluate one assembled sloppy source against the oracle differential.
fn evaluate(cfg: &Config, source: &str, fm: &Frontmatter, meter_exact_gate: bool) -> Eval {
    let run = match dual_run(source) {
        Some(r) => r,
        None => {
            return Eval {
                outcome: Verdict::RunSkip("oracle-machine-error".into()),
                ironhorse_computrons: 0,
                computron_gap: false,
            }
        }
    };
    let outcome = verdict_for(cfg, &run, fm, meter_exact_gate);
    // The computron comparison is advisory (accuracy-over-parity): a covered
    // case whose computrons drift from the oracle's is telemetry, folded
    // into the report's `advisory:` section, never a failure on its own.
    let computron_gap =
        matches!(outcome, Verdict::Covered) && run.oracle_computrons != run.ironhorse_computrons;
    Eval {
        outcome,
        ironhorse_computrons: run.ironhorse_computrons,
        computron_gap,
    }
}

fn evaluate_positive(cfg: &Config, run: &DualRun, meter_exact_gate: bool) -> Verdict {
    // Structural ironhorse stops name themselves — the honest skip.
    match &run.ironhorse_halt {
        Halt::Unsupported(op) => return Verdict::RunSkip(format!("unsupported-opcode:{}", op)),
        Halt::Decode(_) => return Verdict::RunSkip("parse-or-decode".into()),
        _ => {}
    }
    let meter_violation = |run: &DualRun| -> Verdict {
        Verdict::Fail(format!(
            "meter-exact violation: oracle={} ironhorse={} computrons",
            run.oracle_computrons, run.ironhorse_computrons
        ))
    };
    match run.agreement {
        Agreement::BothComplete => {
            if run.result_agrees {
                // Observable agreement (gating) met. Computron is advisory,
                // unless a meter-exact gate is armed for this case.
                if meter_exact_gate && run.oracle_computrons != run.ironhorse_computrons {
                    meter_violation(run)
                } else {
                    Verdict::Covered
                }
            } else if run.ironhorse_result == "[object Object]" {
                // A non-primitive completion ironhorse renders as its Reference
                // stub where the oracle's `String()` differs — a built-in
                // coercion gap, honestly named, not a covered-grammar error.
                Verdict::RunSkip("non-primitive-completion".into())
            } else {
                Verdict::Fail(format!(
                    "result divergence: oracle={:?} ironhorse={:?}",
                    run.oracle_result, run.ironhorse_result
                ))
            }
        }
        Agreement::BothAbort => match &run.ironhorse_halt {
            Halt::Throw(_) => {
                if run.error_agrees {
                    // A meter-exact gate outranks every abort disposition: an
                    // armed case that burns a different computron budget is a
                    // violation even when both engines threw the same value, so
                    // it is checked before the Test262Error shape below.
                    if meter_exact_gate && run.oracle_computrons != run.ironhorse_computrons {
                        meter_violation(run)
                    } else if constructor_name(&run.oracle_error) == "Test262Error" {
                        // Both engines threw the harness's own assertion error:
                        // the test's assertions failed identically in XS and in
                        // ironhorse. That is a *shared* conformance gap ironhorse
                        // must still close (the harness ran ironhorse far enough
                        // to assert and it lost), never a covered pass.
                        Verdict::RunSkip("shared-test262-failure".into())
                    } else {
                        Verdict::Covered
                    }
                } else {
                    // Both aborted but ironhorse threw a different value — the
                    // oracle's real Error object ironhorse does not construct, a
                    // built-in gap, not a covered-grammar divergence. An oracle
                    // `Test262Error` paired with a divergent ironhorse throw
                    // lands here, not in `shared-test262-failure`: nothing is
                    // actually shared, so the divergence stays visible.
                    Verdict::RunSkip("abort-value-differs".into())
                }
            }
            // ironhorse aborted for a limit reason (stack/meter) the oracle
            // cannot share: an ironhorse limitation, not a semantic lie.
            _ => Verdict::RunSkip("ironhorse-aborted-limit".into()),
        },
        // ironhorse completed a source the oracle rejected — the over-acceptance
        // the differential exists to catch (gating under `--oracle`) — UNLESS
        // the oracle did not *reject* the source at all but *failed to run* it:
        // a fatal host abort (a value-stack overflow / OOM inside XS's fixed
        // 4096-slot geometry, `fxAbort(XS_JAVASCRIPT_STACK_OVERFLOW_EXIT)`),
        // which longjmps with NO JavaScript exception object. Its signature is
        // exact and distinct from a language rejection: the oracle *emitted
        // bytecode* (it parsed and coded the source cleanly — not a parse-phase
        // reject, which yields empty bytecode) yet its abort carries an *empty*
        // thrown value (a real runtime throw stringifies to a non-empty error).
        // A program XS cannot execute for want of stack is a host / oracle
        // limitation on a valid source, never an ironhorse over-acceptance — the
        // symmetric twin of `OracleOnlyComplete`'s `ironhorse-aborted` skip
        // (ironhorse's own limit the oracle cannot share). This is the "host-only
        // exclusion" the acceptance bar carves out, named so the report groups
        // it as an oracle non-result rather than an ironhorse defect.
        Agreement::IronhorseOnlyComplete => {
            if cfg.oracle {
                if oracle_host_aborted(run) {
                    Verdict::RunSkip("oracle-host-stack-limit".into())
                } else {
                    Verdict::Fail(
                        "over-acceptance: ironhorse completed a source the oracle rejected".into(),
                    )
                }
            } else {
                Verdict::RunSkip("oracle-gate-off:ironhorse-only-complete".into())
            }
        }
        // ironhorse aborted where the oracle completed — an ironhorse limitation.
        Agreement::OracleOnlyComplete => Verdict::RunSkip("ironhorse-aborted".into()),
    }
}

/// Did the oracle fail to complete because of a **fatal host abort** (a value-
/// stack overflow / OOM inside XS's fixed 4096-slot geometry) rather than a
/// language rejection? The signature is exact: XS emitted bytecode (it parsed
/// AND coded the source — a parse-phase *rejection* yields empty bytecode) yet
/// its abort carries an **empty** thrown value (`fxAbort` longjmps with no
/// `mxException`; a genuine runtime throw stringifies to a non-empty error).
/// True only for the "the oracle could not run this valid program" shape, so a
/// real over-acceptance — the oracle rejecting a source ironhorse wrongly ran —
/// is never masked (it either yields empty oracle bytecode or a non-empty
/// thrown value).
///
/// The parse conjunct reads the **oracle's own** parse signal
/// ([`DualRun::oracle_parsed`], set from `oracle.bytecode`), NOT `run.bytecode`
/// — the latter is ironhorse's bytecode on the default runner, which under
/// `Agreement::IronhorseOnlyComplete` is necessarily non-empty and so would
/// make the conjunct vacuous.
///
/// Known residual: `oracle_error.is_empty()` also holds for a genuine
/// `throw undefined` / `throw ''` (the XS shim stringifies those to `""`). A
/// tighter form gates on the oracle's abort *exit status*, which the shim does
/// not yet surface across the FFI; a follow-up should thread
/// `XS_JAVASCRIPT_STACK_OVERFLOW_EXIT` out of `xs_shim.c` rather than infer a
/// host abort from an empty string.
fn oracle_host_aborted(run: &DualRun) -> bool {
    run.oracle_parsed && run.oracle_error.is_empty()
}

fn evaluate_negative(cfg: &Config, run: &DualRun, neg: &Negative) -> Verdict {
    // Parse/resolution-phase negatives are *early errors*: the spec forbids the
    // source before it ever runs. `ironhorse-compile` now IS ironhorse's own
    // front end, so the runner executes it and reads its reaction
    // (`run.ironhorse_compile`) directly rather than deferring with a blanket
    // `pending-compiler` skip.
    if neg.phase == "parse" || neg.phase == "resolution" {
        return evaluate_negative_early(cfg, run, neg);
    }
    // A runtime negative ironhorse never reached (an unsupported opcode / decode
    // stop) is an honest opcode skip, not a verdict.
    match &run.ironhorse_halt {
        Halt::Unsupported(op) => return Verdict::RunSkip(format!("unsupported-opcode:{}", op)),
        Halt::Decode(_) => return Verdict::RunSkip("parse-or-decode".into()),
        _ => {}
    }
    let oracle_ok = oracle_negative_ok(&neg.ty, run);
    let ironhorse_ok = ironhorse_negative_ok(&neg.ty, run);
    if ironhorse_completed(run.agreement) {
        // ironhorse did not abort where a throw was expected.
        if cfg.oracle && oracle_ok {
            Verdict::Fail(format!(
                "negative over-acceptance: ironhorse completed; expected a {} throw",
                neg.ty
            ))
        } else {
            Verdict::RunSkip("negative-oracle-unexpected".into())
        }
    } else if ironhorse_ok && (!cfg.oracle || oracle_ok) {
        Verdict::Covered
    } else if ironhorse_ok {
        // ironhorse got the expected type but the oracle did not — an
        // oracle-side surprise, not an ironhorse failure.
        Verdict::RunSkip("negative-oracle-unexpected".into())
    } else {
        // ironhorse aborted with a value not of the expected type — its Error
        // surface is incomplete here, honestly named.
        Verdict::RunSkip(format!("negative-type-unmatched:{}", neg.ty))
    }
}

/// Verdict for an **early-error** (parse/resolution-phase) negative: the spec
/// forbids the source before it runs. The signal is ironhorse's own front-end
/// reaction (`run.ironhorse_compile`), which the default runner now executes
/// via `ironhorse-compile`; the XS oracle is the differential authority for
/// whether the source really is an early error. The outcomes the design asks us
/// to keep distinct:
///
/// * **compiler rejection** — ironhorse-compile raised its own SyntaxError for a
///   construct it implements; when the oracle agrees the source is an early
///   error, that is `Covered`.
/// * **over-acceptance** — ironhorse-compile *accepted* (emitted bytecode for) a
///   source the oracle rejected at parse; a `Fail` the oracle differential
///   catches (the bar-forbidden defect this instrument exists to surface). The
///   verdict is decided at the **parse phase**, not by whether the assembled
///   program ran to completion: test262 prepends `$DONOTEVALUATE()`
///   (`harness/sta.js`) which throws at RUN, so neither engine "completes" the
///   assembled program even when it wrongly parsed — completion is the wrong
///   discriminator (it made this arm unreachable for ~99.5% of the corpus).
/// * **oracle surprise** — the XS oracle did NOT reject a source test262 marks as
///   an early error; the differential authority disagrees, so we do not claim
///   coverage (`negative-oracle-unexpected`).
/// * **compiler coverage gap** — ironhorse-compile panicked, or declined an
///   unported-but-valid construct ([`IronhorseCompile::Unsupported`]); either is
///   an Ironhorse compiler gap named `compiler-unimplemented:<phase>` (→
///   `Category::Unsupported`), never a covered early error. A refusal to *parse*
///   an unported construct must not be counted as a correct *rejection* of a
///   forbidden one.
fn evaluate_negative_early(cfg: &Config, run: &DualRun, neg: &Negative) -> Verdict {
    // A parse/resolution negative expects the oracle (XS) to reject the source
    // at the PARSE phase. Usually XS emits no bytecode, but some lexer-owned
    // literals (notably a RegExp whose backreference is out of range) emit a
    // small error stub while reporting the SyntaxError. Accept that explicit,
    // expected constructor as the rejection signal too. This deliberately does
    // NOT use bare `!oracle_completed`: the assembled program's leading
    // `$DONOTEVALUATE()` throws a non-SyntaxError at run when XS wrongly parsed
    // (accepted) the source, so it cannot turn an over-rejection into coverage.
    let oracle_parse_rejected = !run.oracle_parsed || oracle_negative_ok(&neg.ty, run);

    match &run.ironhorse_compile {
        // ironhorse-compile reached a deferred/unimplemented path — it either
        // folded (panicked) or returned a structured `Unsupported`-kind error
        // for an unported-but-valid construct. Both are an Ironhorse *compiler
        // coverage gap*, named `compiler-unimplemented:<phase>` (→
        // `Category::Unsupported`), never a covered early error and never
        // silently relabeled a pass: a front end that merely cannot parse the
        // construct has not *rejected* the forbidden one.
        IronhorseCompile::Panicked(_) | IronhorseCompile::Unsupported(_) => {
            Verdict::RunSkip(format!("compiler-unimplemented:{}", neg.phase))
        }

        // ironhorse's own front end raised the early error.
        IronhorseCompile::Rejected(_) => {
            if !cfg.oracle || oracle_parse_rejected {
                Verdict::Covered
            } else {
                // ironhorse rejected but the oracle parsed (accepted) the source
                // — the differential authority disagrees it is an early error.
                Verdict::RunSkip("negative-oracle-unexpected".into())
            }
        }

        // ironhorse-compile ACCEPTED the source (emitted bytecode) — its parser
        // did not reject a source test262 marks as a parse-phase early error.
        // Decide at the parse phase: whether the assembled program then ran to
        // completion is irrelevant, because `$DONOTEVALUATE()` throws at run.
        IronhorseCompile::Accepted => {
            if cfg.oracle && oracle_parse_rejected {
                // ironhorse parsed a source XS rejected at parse: the
                // bar-forbidden parser over-acceptance the differential exists to
                // surface.
                Verdict::Fail(format!(
                    "negative over-acceptance: ironhorse-compile accepted a source expected to be a {}-phase early error",
                    neg.phase
                ))
            } else {
                if cfg.oracle {
                    Verdict::RunSkip("negative-oracle-unexpected".into())
                } else {
                    Verdict::RunSkip("oracle-gate-off:negative-over-acceptance".into())
                }
            }
        }

        // The oracle-compiler reference path does not exercise ironhorse's front
        // end, so the early-error differential is unavailable there.
        IronhorseCompile::NotAttempted => {
            Verdict::RunSkip(format!("negative-{}:oracle-compiler-path", neg.phase))
        }
    }
}

/// Re-run ironhorse `repeat` times and report whether its computrons ever differ
/// from `baseline` — the unconditional determinism gate (design § Part 2:
/// identical computrons per build). The oracle is deterministic too, so a
/// plain re-`dual_run` isolates any ironhorse nondeterminism.
fn determinism_violation(source: &str, repeat: u32, baseline: u64) -> bool {
    for _ in 1..repeat {
        match dual_run(source) {
            Some(r) if r.ironhorse_computrons != baseline => return true,
            _ => {}
        }
    }
    false
}

/// The name of the global the async prelude records the `$DONE` completion
/// into, read back off ironhorse after the job drain
/// ([`crate::AsyncDualRun::ironhorse_signal`]). Assigned as an *implicit* sloppy
/// global (no `var`) so it is a pure global-object property on both engines,
/// never a frame local that closure-cell aliasing could shadow.
const ASYNC_SIGNAL_NAME: &str = "__endorAsyncSignal";

/// The pure-JS async harness prelude, prepended to an `async`-flagged case
/// (design § Part 2, the async row: "`$DONE` host function + did-not-run
/// latch"). Because the oracle compiles the assembled source and ironhorse runs
/// that exact bytecode, `$DONE`/`print` are defined **once, in JS** — so the
/// two engines run byte-identically (no host-function metering to calibrate)
/// and the completion is observed by reading [`ASYNC_SIGNAL_NAME`] off ironhorse
/// after the drain, gated by the dual-run's computron agreement.
///
/// `$DONE` mirrors `doneprintHandle.js`'s classification exactly; a test that
/// lists `doneprintHandle.js` in its `includes:` simply redeclares `$DONE`
/// (a hoisted function) to route through `print`, which this prelude also
/// defines to write the same sentinel — so either path records the same
/// `Test262:AsyncTest{Complete,Failure:…}` marker string.
const ASYNC_PRELUDE: &str = r#"function $DONE(error) {
  if (error) {
    if (typeof error === 'object' && error !== null && 'name' in error) {
      __endorAsyncSignal = 'Test262:AsyncTestFailure:' + error.name + ': ' + error.message;
    } else {
      __endorAsyncSignal = 'Test262:AsyncTestFailure:Test262Error: ' + error;
    }
  } else {
    __endorAsyncSignal = 'Test262:AsyncTestComplete';
  }
}
function print(msg) { __endorAsyncSignal = '' + msg; }
"#;

/// Run one case (source text) through the full mode/verdict machinery.
pub fn run_case(cfg: &Config, harness_dir: &Path, src: &str) -> CaseResult {
    let fm = frontmatter::parse(src);

    // Feature pre-skip: a declared feature ironhorse does not implement.
    let skip_set = effective_skip_features(cfg);
    if let Some(f) = fm.features.iter().find(|f| skip_set.contains(f.as_str())) {
        return preskip(&format!("feature:{}", f));
    }

    // Modules use their own syntactic goal.  Drive both real front ends now,
    // rather than feeding module syntax to the Script runner or reporting the
    // former blanket `structural:module` pre-skip.  Parse-phase negatives are
    // complete executions of the applicable phase; accepted modules proceed
    // to the explicitly named linker/evaluator boundary below.
    if fm.flags.iter().any(|f| f == "module") {
        return run_module_case(cfg, src, &fm);
    }
    // `CanBlockIsFalse` marks the `$262.agent`/Atomics blocking-agent tests,
    // which need a threading story ironhorse does not have — a named structural
    // skip. (`async` no longer rides this pre-skip; it runs below.)
    if fm.flags.iter().any(|f| f == "CanBlockIsFalse") {
        return preskip("structural:can-block");
    }
    // The multi-agent Atomics/SharedArrayBuffer slice drives a second agent
    // through the `$262.agent` host contract (`$262.agent.start`/`broadcast`/
    // `receiveBroadcast`/`report`), and the blocking-agent primitives
    // `Atomics.wait`/`notify`/`waitAsync` coordinate across agents. ironhorse
    // is single-agent, so these are a standards-grounded host exclusion (a
    // spec-optional host capability — the agent-cluster API and blocking are
    // not required of a conforming implementation; `Atomics.wait` on a
    // non-`can-block` agent is itself a spec TypeError). A named structural
    // skip rather than a divergence, and it also keeps the oracle off the
    // `wait` cases where XS blocks past the watchdog. The single-agent Atomics
    // surface (load/store/add/…) runs and is covered.
    if src.contains("$262.agent")
        || src.contains("Atomics.wait")
        || src.contains("Atomics.notify")
    {
        return preskip("structural:multi-agent");
    }

    let (mut run_sloppy, mut run_strict, only_strict) = strict_mode_status(&fm.flags);
    let mut strict_skipped = false;
    // The proprietary exact-meter corpus records the meter of the literal
    // source file, not test262's synthetic second (`"use strict"`) variant.
    // Preserve that byte/meter identity contract while official test262 files
    // continue to execute every mode selected by their flags.
    if fm.features.iter().any(|f| f == "ironhorse-meter-exact") {
        if only_strict {
            return preskip("structural:only-strict-meter-exact");
        }
        strict_skipped = run_strict;
        run_sloppy = true;
        run_strict = false;
    }

    // SES lockdown/compartment mode (`-l`/`-lc`/`-c`): the mode's guest
    // surface (`lockdown()`, the `Compartment` intrinsic) is a named scope
    // fold ironhorse does not yet expose, so a case run under any mode is a
    // whole-case named pre-skip — the honest split. When the guest surface
    // lands, this seam
    // ([`SesMode::unimplemented_skip`]) returns `None` and the mode's
    // [`SesMode::prelude`] is applied to the assembled source instead.
    if let Some(reason) = cfg.ses_mode.unimplemented_skip() {
        return CaseResult {
            verdict: Verdict::PreSkip(reason.into()),
            strict_skipped: run_strict,
            computron_gap: false,
        };
    }

    let meter_exact_gate =
        cfg.gate_meter_exact && fm.features.iter().any(|f| f == "ironhorse-meter-exact");

    // `async`-flagged case: assemble with the `$DONE` prelude, run the dual-run
    // (both engines drain the promise job queue — the fxRunLoop-equivalent —
    // per case), and layer the async completion verdict on the differential.
    if fm.flags.iter().any(|f| f == "async") {
        let sloppy =
            run_sloppy.then(|| run_async_case(cfg, harness_dir, src, &fm, false, meter_exact_gate));
        let strict =
            run_strict.then(|| run_async_case(cfg, harness_dir, src, &fm, true, meter_exact_gate));
        let mut result = combine_mode_results(sloppy, strict);
        result.strict_skipped |= strict_skipped;
        return result;
    }

    let run_mode = |source: &str| {
        let eval = evaluate(cfg, source, &fm, meter_exact_gate);
        let outcome = if cfg.repeat > 1
            && determinism_violation(source, cfg.repeat, eval.ironhorse_computrons)
        {
            Verdict::Fail(format!(
                "nondeterministic computrons across {} runs",
                cfg.repeat
            ))
        } else {
            eval.outcome
        };
        Eval {
            outcome,
            ironhorse_computrons: eval.ironhorse_computrons,
            computron_gap: eval.computron_gap,
        }
    };

    let sloppy = if run_sloppy {
        match assemble(harness_dir, src, &fm) {
            Ok(source) => Some(run_mode(&source)),
            Err(reason) => return preskip(&reason),
        }
    } else {
        None
    };
    let strict = if run_strict {
        match assemble_strict(harness_dir, src, &fm) {
            Ok(source) => Some(run_mode(&source)),
            Err(reason) => return preskip(&reason),
        }
    } else {
        None
    };

    let (verdict, computron_gap) = match (sloppy, strict) {
        (Some(sloppy), Some(strict)) => {
            let verdict = match (&sloppy.outcome, &strict.outcome) {
                (Verdict::Covered, Verdict::Covered) => Verdict::Covered,
                (Verdict::Fail(reason), _) => Verdict::Fail(reason.clone()),
                (_, Verdict::Fail(reason)) => Verdict::Fail(format!("strict:{reason}")),
                (Verdict::Covered, Verdict::RunSkip(reason)) => {
                    Verdict::RunSkip(format!("strict:{reason}"))
                }
                (Verdict::Covered, Verdict::PreSkip(reason)) => {
                    Verdict::PreSkip(format!("strict:{reason}"))
                }
                (other, _) => other.clone(),
            };
            (verdict, sloppy.computron_gap || strict.computron_gap)
        }
        (Some(eval), None) | (None, Some(eval)) => (eval.outcome, eval.computron_gap),
        (None, None) => unreachable!("strict_mode_status always selects a mode"),
    };

    CaseResult {
        verdict,
        strict_skipped,
        computron_gap,
    }
}

/// Execute the Module-goal phase of one official test262 case against both
/// compilers.  XS's console parser emits a SyntaxError throw stub for malformed
/// modules; [`xs_oracle::compile_module`] recognizes the absence of the
/// `MODULE; SET_RESULT; END` trailer and reports that as a rejection.  This
/// makes parse-negative coverage a genuine XS differential rather than a
/// frontmatter-based relabel.
///
/// Static resolution and evaluation remain separate, honestly named run
/// skips.  In particular, compiling a positive module is never called
/// "covered": fixture loading, namespace creation, top-level-await ordering,
/// and dynamic import must all execute before that claim is available.
fn run_module_case(cfg: &Config, src: &str, fm: &Frontmatter) -> CaseResult {
    let oracle = match xs_oracle::compile_module(src) {
        Some(outcome) => outcome,
        None => {
            return CaseResult {
                verdict: Verdict::RunSkip("oracle-machine-error".into()),
                strict_skipped: false,
                computron_gap: false,
            };
        }
    };

    let ironhorse = panic::catch_unwind(AssertUnwindSafe(|| {
        ironhorse_compile::compile_module_atoms(src)
    }));

    if let Some(negative) = &fm.negative {
        if negative.phase == "parse" {
            let ironhorse_rejected = match &ironhorse {
                Ok(Err(error)) => {
                    if matches!(
                        error.kind,
                        ironhorse_compile::parser::ParseErrorKind::Unsupported
                    ) {
                        return CaseResult {
                            verdict: Verdict::RunSkip("compiler-unimplemented:parse".into()),
                            strict_skipped: false,
                            computron_gap: false,
                        };
                    }
                    true
                }
                Err(_) => {
                    return CaseResult {
                        verdict: Verdict::RunSkip("compiler-unimplemented:parse".into()),
                        strict_skipped: false,
                        computron_gap: false,
                    };
                }
                Ok(Ok(_)) => false,
            };

            let verdict = match (oracle.compiled, ironhorse_rejected) {
                (false, true) => Verdict::Covered,
                (false, false) if cfg.oracle => Verdict::Fail(
                    "negative over-acceptance: ironhorse module compiler accepted a source XS rejected"
                        .into(),
                ),
                (false, false) => {
                    Verdict::RunSkip("oracle-gate-off:negative-over-acceptance".into())
                }
                (true, _) => Verdict::RunSkip("negative-oracle-unexpected".into()),
            };
            return CaseResult {
                verdict,
                strict_skipped: false,
                computron_gap: false,
            };
        }

        if negative.phase == "resolution" {
            return CaseResult {
                verdict: Verdict::RunSkip("module:resolution-linking".into()),
                strict_skipped: false,
                computron_gap: false,
            };
        }
    }

    let verdict = match ironhorse {
        Ok(Ok((bytes, symbols))) if oracle.compiled => {
            if cfg.oracle && (bytes != oracle.bytecode || symbols != oracle.symbols) {
                Verdict::RunSkip("module:compiler-byte-divergence".into())
            } else {
                Verdict::RunSkip("module:evaluation".into())
            }
        }
        Ok(Ok(_)) if cfg.oracle => {
            Verdict::Fail("module over-acceptance: XS rejected the source".into())
        }
        Ok(Ok(_)) => Verdict::RunSkip("oracle-gate-off:module-over-acceptance".into()),
        Ok(Err(error))
            if matches!(
                error.kind,
                ironhorse_compile::parser::ParseErrorKind::Unsupported
            ) =>
        {
            Verdict::RunSkip("compiler-unimplemented:module".into())
        }
        Ok(Err(_)) => Verdict::RunSkip("module:compiler-rejected".into()),
        Err(_) => Verdict::RunSkip("compiler-unimplemented:module".into()),
    };

    CaseResult {
        verdict,
        strict_skipped: false,
        computron_gap: false,
    }
}

/// Run one `async`-flagged case: prepend the [`ASYNC_PRELUDE`] to the standard
/// assembly, dual-run it (each engine drains its own promise job queue), and
/// resolve the verdict as the base differential verdict *refined* by ironhorse's
/// `$DONE` completion latch. The refinement only ever *narrows* a `Covered`
/// base to an honest skip — never manufactures a failure — so ironhorse cannot lie
/// about an async case (a genuine ironhorse divergence is already caught by the
/// completion/computron differential in [`verdict_for`]).
fn run_async_case(
    cfg: &Config,
    harness_dir: &Path,
    src: &str,
    fm: &Frontmatter,
    strict_mode: bool,
    meter_exact_gate: bool,
) -> CaseResult {
    let assembled = match if strict_mode {
        assemble_strict(harness_dir, src, fm)
    } else {
        assemble(harness_dir, src, fm)
    } {
        Ok(s) => s,
        Err(reason) => {
            return CaseResult {
                verdict: Verdict::PreSkip(reason),
                strict_skipped: false,
                computron_gap: false,
            }
        }
    };
    let source = format!("{ASYNC_PRELUDE}{assembled}");

    let async_run = match dual_run_async(&source, ASYNC_SIGNAL_NAME) {
        Some(a) => a,
        None => {
            return CaseResult {
                verdict: Verdict::RunSkip("oracle-machine-error".into()),
                strict_skipped: false,
                computron_gap: false,
            }
        }
    };

    let base = verdict_for(cfg, &async_run.run, fm, meter_exact_gate);
    let computron_gap = matches!(base, Verdict::Covered)
        && async_run.run.oracle_computrons != async_run.run.ironhorse_computrons;

    // A `Covered` differential means ironhorse reproduced the oracle's full
    // execution (script + microtask drain) — only then is the async completion
    // latch meaningful; a divergence keeps its base Fail/skip.
    let outcome = match base {
        Verdict::Covered => refine_async(&async_run),
        other => other,
    };

    // The determinism gate runs over the same prelude-bearing source.
    let verdict = if cfg.repeat > 1
        && determinism_violation(&source, cfg.repeat, async_run.run.ironhorse_computrons)
    {
        Verdict::Fail(format!(
            "nondeterministic computrons across {} runs",
            cfg.repeat
        ))
    } else {
        outcome
    };

    CaseResult {
        verdict,
        strict_skipped: false,
        computron_gap,
    }
}

/// Fold the official sloppy/strict pair into one file verdict.  Full coverage
/// requires both selected modes to be covered; a failure in either mode stays
/// a failure, and a strict-only gap is labelled so reports retain the causal
/// mode instead of silently treating the sloppy pass as file coverage.
fn combine_mode_results(sloppy: Option<CaseResult>, strict: Option<CaseResult>) -> CaseResult {
    match (sloppy, strict) {
        (Some(sloppy), Some(strict)) => {
            let verdict = match (&sloppy.verdict, &strict.verdict) {
                (Verdict::Covered, Verdict::Covered) => Verdict::Covered,
                (Verdict::Fail(reason), _) => Verdict::Fail(reason.clone()),
                (_, Verdict::Fail(reason)) => Verdict::Fail(format!("strict:{reason}")),
                (Verdict::Covered, Verdict::RunSkip(reason)) => {
                    Verdict::RunSkip(format!("strict:{reason}"))
                }
                (Verdict::Covered, Verdict::PreSkip(reason)) => {
                    Verdict::PreSkip(format!("strict:{reason}"))
                }
                (other, _) => other.clone(),
            };
            CaseResult {
                verdict,
                strict_skipped: false,
                computron_gap: sloppy.computron_gap || strict.computron_gap,
            }
        }
        (Some(result), None) | (None, Some(result)) => result,
        (None, None) => unreachable!("strict_mode_status always selects a mode"),
    }
}

/// Refine a differentially-`Covered` async case by its `$DONE` completion
/// latch (the did-not-run / success / failure trichotomy `xst262.c` computes
/// after `fxRunLoop`), plus the unhandled-rejection latch. Only the clean
/// success path counts as covered; every other shape is an honest named skip —
/// never a `Fail`, because on a `Covered` base the oracle *agreed* with ironhorse,
/// so a non-success signal reflects the shared execution (an oracle-side
/// failure or a test that never signaled), not an ironhorse defect.
fn refine_async(async_run: &AsyncDualRun) -> Verdict {
    if async_run.ironhorse_unhandled_rejection {
        return Verdict::RunSkip("async:unhandled-rejection".into());
    }
    match async_run.ironhorse_signal.as_deref() {
        Some("Test262:AsyncTestComplete") => Verdict::Covered,
        Some(s) if s.starts_with("Test262:AsyncTestFailure") => {
            Verdict::RunSkip("async:reported-failure".into())
        }
        // A signal that is neither the success marker nor a known failure
        // marker: some other `print` output — honestly named, not covered.
        Some(_) => Verdict::RunSkip("async:unexpected-signal".into()),
        // The did-not-run latch: `$DONE` was never called (nor `print`), so the
        // async test never signaled completion on the shared execution.
        None => Verdict::RunSkip("async:no-completion-signal".into()),
    }
}

/// The xst-shaped report over a set of cases: `mode:` / `skip:` / `fail:`
/// plus the ironhorse `advisory:` and `skip-detail:` extensions (design § Part
/// 2, "dual-run oracle wiring" + "the honest-split discipline").
#[derive(Debug, Default, Clone)]
pub struct XstReport {
    pub total: usize,
    /// Cases covered (ran end-to-end, met the bar).
    pub covered: usize,
    /// Cases that attempted a sloppy run (covered + run-skips + failures).
    pub sloppy_run: usize,
    /// Strict-mode runs named-skipped (mode: section).
    pub strict_skipped: usize,
    /// `fail:` — real failures: `(path, detail)`. Must be empty to meet the bar.
    pub failures: Vec<(String, String)>,
    /// `skip:` — pre-run feature/flag/structural skips -> count.
    pub pre_skips: BTreeMap<String, usize>,
    /// `skip-detail:` — post-run honest named skips -> count.
    pub run_skips: BTreeMap<String, usize>,
    /// `advisory:` — covered cases whose computrons drifted from the oracle.
    pub computron_advisories: usize,
    /// The SES lockdown/compartment mode this run applied (`-l`/`-lc`/`-c`),
    /// surfaced in the report's `mode:` section so a reader sees which
    /// Hardened-JavaScript axis produced it. [`SesMode::None`] for a plain run.
    pub ses_mode: SesMode,
    /// Every case's full record — the per-case wire the whole-tree sweep emits
    /// as JSON (`ironhorse-xst --json`) for [`crate::report`] to aggregate.
    /// Populated by [`XstReport::record_case`] and by [`XstReport::record`];
    /// legacy aggregate callers record an empty feature list.
    pub cases: Vec<CaseRecord>,
}

impl XstReport {
    /// The bar: a nonzero total with zero failures (design's honest-split
    /// discipline — zero divergence on whatever the covered grammar reaches).
    pub fn met_bar(&self) -> bool {
        self.total > 0 && self.failures.is_empty()
    }

    /// Fold one case's result in, attributed to `path`, retaining a per-case
    /// record with an empty feature list for legacy aggregate callers/tests.
    pub fn record(&mut self, path: &str, result: CaseResult) {
        self.record_case(path, Vec::new(), result);
    }

    /// Fold one case's result in and retain its full [`CaseRecord`] (with the
    /// declared `features:`) for the per-case JSON a whole-tree sweep emits.
    pub fn record_case(&mut self, path: &str, features: Vec<String>, result: CaseResult) {
        self.cases
            .push(CaseRecord::from_result(path, features, &result));
        self.total += 1;
        if result.strict_skipped {
            self.strict_skipped += 1;
        }
        if result.computron_gap {
            self.computron_advisories += 1;
        }
        match result.verdict {
            Verdict::Covered => {
                self.covered += 1;
                self.sloppy_run += 1;
            }
            Verdict::RunSkip(reason) => {
                *self.run_skips.entry(reason).or_insert(0) += 1;
                self.sloppy_run += 1;
            }
            Verdict::PreSkip(reason) => {
                *self.pre_skips.entry(reason).or_insert(0) += 1;
            }
            Verdict::Fail(detail) => {
                self.failures.push((path.to_string(), detail));
                self.sloppy_run += 1;
            }
        }
    }

    fn sorted(map: &BTreeMap<String, usize>) -> Vec<(String, usize)> {
        let mut v: Vec<_> = map.iter().map(|(k, n)| (k.clone(), *n)).collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        v
    }

    /// The pre-run feature/flag skips, most-skipped first.
    pub fn skip_summary(&self) -> Vec<(String, usize)> {
        Self::sorted(&self.pre_skips)
    }

    /// The post-run honest named skips, most-skipped first.
    pub fn skip_detail_summary(&self) -> Vec<(String, usize)> {
        Self::sorted(&self.run_skips)
    }

    /// The xst-shaped YAML report — `mode:` / `skip:` / `fail:` plus the
    /// ironhorse `advisory:` and `skip-detail:` sections. Tooling that reads an
    /// `xst` `-o` report reads this unchanged; the two ironhorse sections are
    /// additive.
    pub fn to_yaml(&self) -> String {
        let mut s = String::new();
        s.push_str("runner: ironhorse-xst\n");
        s.push_str(&format!("total: {}\n", self.total));
        s.push_str(&format!("covered: {}\n", self.covered));
        s.push_str(&format!("bar-met: {}\n", self.met_bar()));
        s.push_str("mode:\n");
        s.push_str(&format!("  sloppy-run: {}\n", self.sloppy_run));
        s.push_str(&format!(
            "  strict-skipped-by-policy: {}\n",
            self.strict_skipped
        ));
        s.push_str(&format!("  ses-mode: {}\n", self.ses_mode.short()));
        s.push_str("fail:\n");
        for (path, detail) in &self.failures {
            s.push_str(&format!("  - path: {}\n", yaml_quote(path)));
            s.push_str(&format!("    detail: {}\n", yaml_quote(detail)));
        }
        s.push_str("skip:\n");
        for (reason, n) in self.skip_summary() {
            s.push_str(&format!("  {}: {}\n", yaml_quote(&reason), n));
        }
        s.push_str("skip-detail:\n");
        for (reason, n) in self.skip_detail_summary() {
            s.push_str(&format!("  {}: {}\n", yaml_quote(&reason), n));
        }
        s.push_str("advisory:\n");
        s.push_str(&format!("  computron-gap: {}\n", self.computron_advisories));
        s
    }
}

/// Double-quote a YAML scalar, escaping `\` and `"` so a colon/bracket in a
/// path or a detail string never breaks the mapping.
fn yaml_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Run one case under a hard wall-clock bound (design § the per-case dispatch
/// bound). The case is dispatched on its own thread and joined with `timeout`;
/// a timeout becomes either a recorded `ironhorse-hang` **failure** (when
/// Ironhorse also fails to terminate alone) or an `oracle-nontermination`
/// infrastructure skip. This avoids wedging the whole per-directory batch
/// process — the batch's other cases still run and its JSON is still written
/// atomically, so a resumable sweep never loses a directory to one
/// non-terminating case. The thread is spawned fresh per case,
/// so the non-hanging path shares no engine state across cases (metering and
/// determinism are identical to an unbounded run); only a genuine hang leaks its
/// thread (stuck in C / a VM dispatch cycle, so uncancellable), reclaimed when
/// the batch process exits.
///
/// The worker is pinned to a large stack ([`CASE_THREAD_STACK_BYTES`], the
/// repo's engine-thread convention): both `ironhorse-compile`'s recursive-descent
/// parser and the XS oracle's C parser recurse on *this* thread's native stack,
/// and a spawned thread otherwise inherits Rust's 2 MiB default — a quarter of
/// the main thread's ~8 MiB — so a deeply-nested source that ran before would
/// overflow and SIGSEGV the whole batch (uncatchable by `catch_unwind`), the
/// exact wedge the bound exists to prevent.
fn run_case_bounded(
    cfg: &Config,
    harness_dir: &Path,
    src: &str,
    timeout: std::time::Duration,
) -> CaseResult {
    let (tx, rx) = std::sync::mpsc::channel();
    let owned_config = cfg.clone();
    let owned_harness_directory = harness_dir.to_path_buf();
    let owned_source = src.to_string();
    let spawn = std::thread::Builder::new()
        .name("ironhorse-xst-case".into())
        .stack_size(CASE_THREAD_STACK_BYTES)
        .spawn(move || {
            // The receiver may already be gone (we timed out): a failed send is
            // expected, never a panic.
            let _ = tx.send(run_case(
                &owned_config,
                &owned_harness_directory,
                &owned_source,
            ));
        });
    let handle = match spawn {
        Ok(h) => h,
        // Thread exhaustion: fall back to an unbounded inline run so the case is
        // never dropped (forfeits the bound for this one case only).
        Err(_) => return run_case(cfg, harness_dir, src),
    };
    match rx.recv_timeout(timeout) {
        Ok(r) => {
            let _ = handle.join();
            r
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            // Leak the worker (stuck in an uncancellable native dispatch cycle);
            // it dies with the batch process. But `run_case` timed out inside
            // `dual_run`, which runs the ORACLE and ironhorse on one thread — so
            // this bound alone cannot say *which* engine failed to terminate.
            // Attribute it: re-run ironhorse ALONE under the same bound. If
            // ironhorse terminates on its own, the non-termination was the
            // oracle's (e.g. XS's own infinite loop on
            // `for (const i=0; i<1; i++){}`) — a host / infrastructure non-result
            // the differential cannot cover, not the bar-forbidden ironhorse
            // dispatch loop. Only when ironhorse *also* fails to terminate is it
            // the `ironhorse-hang` failure the bar forbids.
            drop(handle);
            let verdict = if ironhorse_terminates_alone(harness_dir, src, timeout) {
                Verdict::RunSkip(format!(
                    "oracle-nontermination: oracle failed to terminate within {}s (ironhorse terminates alone)",
                    timeout.as_secs()
                ))
            } else {
                Verdict::Fail(format!(
                    "ironhorse-hang: no verdict within {}s (non-terminating dispatch)",
                    timeout.as_secs()
                ))
            };
            CaseResult {
                verdict,
                strict_skipped: false,
                computron_gap: false,
            }
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            // A worker panic can originate in the VM under test; keep it in
            // the bar-forbidden category rather than laundering it as infra.
            let _ = handle.join();
            CaseResult {
                verdict: Verdict::Fail("ironhorse-worker-panic".into()),
                strict_skipped: false,
                computron_gap: false,
            }
        }
    }
}

/// Attribute a per-case wall-clock hang: does ironhorse terminate on this
/// source *alone* (no oracle) within `timeout`? Reassembles every mode selected
/// for the case and runs [`crate::ironhorse_only_run`] on its own
/// wall-clock-bounded thread. `true`
/// means ironhorse terminates independently, so the timeout was the oracle's
/// non-termination, not ironhorse's. A missing-harness assembly error is itself
/// a prompt terminal (ironhorse never even ran a dispatch loop → `true`); a
/// worker panic (`Disconnected`, the sender dropped before sending) is *also* a
/// prompt terminal — ironhorse stopped, it did not hang — so it counts as
/// terminated (`true`), never a `false` that would mislabel an oracle hang as
/// the bar-forbidden `ironhorse-hang`. A thread-spawn failure forfeits
/// attribution conservatively toward `ironhorse-hang` (`false`).
fn ironhorse_terminates_alone(harness_dir: &Path, src: &str, timeout: std::time::Duration) -> bool {
    let fm = frontmatter::parse(src);
    let (mut run_sloppy, mut run_strict, only_strict) = strict_mode_status(&fm.flags);
    if fm.features.iter().any(|feature| feature == "ironhorse-meter-exact") {
        if only_strict {
            return true;
        }
        run_sloppy = true;
        run_strict = false;
    }
    let mut sources = Vec::new();
    if run_sloppy {
        if let Ok(source) = assemble(harness_dir, src, &fm) {
            sources.push(source);
        }
    }
    if run_strict {
        if let Ok(source) = assemble_strict(harness_dir, src, &fm) {
            sources.push(source);
        }
    }
    let attribution_started = std::time::Instant::now();
    for mut source in sources {
        if fm.flags.iter().any(|flag| flag == "async") {
            source = format!("{ASYNC_PRELUDE}{source}");
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let spawn = std::thread::Builder::new()
            .name("ironhorse-xst-attribute".into())
            .stack_size(CASE_THREAD_STACK_BYTES)
            .spawn(move || {
                let _ = tx.send(crate::ironhorse_only_run(&source));
            });
        if spawn.is_err() {
            return false;
        }
        let Some(remaining) = timeout.checked_sub(attribution_started.elapsed()) else {
            return false;
        };
        match rx.recv_timeout(remaining) {
            Ok(_) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => return false,
        }
    }
    true
}

/// Run a set of test262 files (absolute paths) against the harness in
/// `harness_dir`, returning the xst-shaped report. `root` is stripped from
/// each path for readable failure labels. The primary differential runs under
/// `cfg.per_case_timeout_seconds` (0 = unbounded, the library default); a
/// timeout permits one additional bound for Ironhorse-only attribution (see
/// [`run_case_bounded`]).
pub fn run_files(cfg: &Config, harness_dir: &Path, root: &Path, files: &[PathBuf]) -> XstReport {
    let mut rep = XstReport::default();
    rep.ses_mode = cfg.ses_mode;
    for path in files {
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned();
        let src = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => {
                rep.record(&rel, preskip("unreadable"));
                continue;
            }
        };
        // Parse the frontmatter once, up front: its `features:` list drives
        // both the optional `--feature-filter` and the per-case record's
        // feature breakdown.
        let fm = frontmatter::parse(&src);
        // `--feature-filter` (the `test262-harness --features-include`
        // semantics): a case that does not carry a required feature is out of
        // scope for this run — not recorded, so it never enters `total`.
        if !cfg.feature_filter.is_empty() {
            let carries = cfg
                .feature_filter
                .iter()
                .any(|want| fm.features.iter().any(|f| f == want));
            if !carries {
                continue;
            }
        }
        let r = if cfg.per_case_timeout_seconds == 0 {
            run_case(cfg, harness_dir, &src)
        } else {
            run_case_bounded(
                cfg,
                harness_dir,
                &src,
                std::time::Duration::from_secs(cfg.per_case_timeout_seconds),
            )
        };
        rep.record_case(&rel, fm.features.clone(), r);
    }
    rep
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_parse_negative_runs_both_module_front_ends() {
        let source = "/*---\nflags: [module]\nnegative:\n  phase: parse\n  type: SyntaxError\n---*/\nexport const = ;";
        let result = run_case(&Config::default(), Path::new("."), source);
        assert_eq!(result.verdict, Verdict::Covered);
    }

    #[test]
    fn accepted_module_reaches_named_evaluation_boundary() {
        let source = "/*---\nflags: [module]\n---*/\nexport const value = 1;";
        let result = run_case(&Config::default(), Path::new("."), source);
        assert_eq!(
            result.verdict,
            Verdict::RunSkip("module:evaluation".into())
        );
    }

    #[test]
    fn module_resolution_negative_reaches_named_linking_boundary() {
        let source = "/*---\nflags: [module]\nnegative:\n  phase: resolution\n  type: SyntaxError\n---*/\nimport { missing } from './fixture.js';";
        let result = run_case(&Config::default(), Path::new("."), source);
        assert_eq!(
            result.verdict,
            Verdict::RunSkip("module:resolution-linking".into())
        );
    }

    #[test]
    fn mode_selection_mirrors_xst() {
        assert_eq!(strict_mode_status(&[]), (true, true, false)); // default: both
        assert_eq!(
            strict_mode_status(&["onlyStrict".into()]),
            (false, true, true)
        );
        assert_eq!(
            strict_mode_status(&["noStrict".into()]),
            (true, false, false)
        );
        assert_eq!(strict_mode_status(&["raw".into()]), (true, false, false));
    }

    #[test]
    fn constructor_name_extracts_the_type() {
        assert_eq!(constructor_name("TypeError: cannot read x"), "TypeError");
        assert_eq!(constructor_name("RangeError"), "RangeError");
        assert_eq!(
            constructor_name("Test262Error: Expected a TypeError"),
            "Test262Error"
        );
    }

    #[test]
    fn ses_mode_parses_the_xst_tokens() {
        assert_eq!(SesMode::parse("l"), Some(SesMode::Lockdown));
        assert_eq!(SesMode::parse("c"), Some(SesMode::Compartment));
        assert_eq!(SesMode::parse("lc"), Some(SesMode::LockdownCompartment));
        assert_eq!(SesMode::parse("cl"), Some(SesMode::LockdownCompartment));
        assert_eq!(SesMode::parse("x"), None);
        assert_eq!(SesMode::None.short(), "none");
        assert_eq!(SesMode::Lockdown.short(), "l");
        assert_eq!(SesMode::LockdownCompartment.short(), "lc");
    }

    #[test]
    fn ses_mode_prelude_and_skip_seam() {
        // The default runs the body verbatim and needs no guest surface.
        assert_eq!(SesMode::None.prelude(), "{body}");
        assert_eq!(SesMode::None.unimplemented_skip(), None);
        // A lockdown mode's prelude calls the guest `lockdown()` — the shape
        // that runs once the guest surface lands.
        assert!(SesMode::Lockdown.prelude().starts_with("lockdown();"));
        assert!(SesMode::Compartment.prelude().contains("Compartment"));
        // Until it lands, every non-None mode is a distinct named skip.
        assert_eq!(
            SesMode::Lockdown.unimplemented_skip(),
            Some("ses-mode:lockdown-unimplemented")
        );
        assert_eq!(
            SesMode::Compartment.unimplemented_skip(),
            Some("ses-mode:compartment-unimplemented")
        );
        assert_eq!(
            SesMode::LockdownCompartment.unimplemented_skip(),
            Some("ses-mode:lockdown-compartment-unimplemented")
        );
    }

    #[test]
    fn ses_mode_makes_a_case_a_named_preskip() {
        // With a lockdown mode armed, a plain covered-grammar case is a whole-
        // case named pre-skip (the guest `lockdown()` surface is a scope
        // fold), never a failure — even though the case itself runs fine with
        // no mode. The harness dir is irrelevant: the mode short-circuits
        // before assembly.
        let mut cfg = Config::default();
        cfg.ses_mode = SesMode::Lockdown;
        let r = run_case(&cfg, Path::new("/nonexistent"), "1 + 1;");
        assert_eq!(
            r.verdict,
            Verdict::PreSkip("ses-mode:lockdown-unimplemented".into())
        );
    }

    #[test]
    fn guest_lockdown_and_compartment_are_skip_features() {
        // The two real `ses-xs-parity` tests in the subset declare
        // `Compartment` / `lockdown` features; ironhorse lacks the guest surface,
        // so they are named `feature:*` skips (the `gxFeatures` analogue) even
        // when `ses-xs-parity` itself is opted in.
        let mut cfg = Config::default();
        cfg.features_include = vec!["ses-xs-parity".into()];
        let skip = effective_skip_features(&cfg);
        assert!(skip.contains("Compartment"));
        assert!(skip.contains("lockdown"));
        assert!(!skip.contains("ses-xs-parity"));
    }

    #[test]
    fn report_yaml_carries_the_ses_mode() {
        let mut rep = XstReport::default();
        rep.ses_mode = SesMode::Lockdown;
        assert!(rep.to_yaml().contains("ses-mode: l"));
        let plain = XstReport::default();
        assert!(plain.to_yaml().contains("ses-mode: none"));
    }

    #[test]
    fn features_include_opts_a_feature_back_in() {
        let mut cfg = Config::default();
        assert!(effective_skip_features(&cfg).contains("ses-xs-parity"));
        cfg.features_include = vec!["ses-xs-parity".into()];
        assert!(!effective_skip_features(&cfg).contains("ses-xs-parity"));
        // A never-listed feature is never in the skip set.
        assert!(!effective_skip_features(&cfg).contains("Symbol"));
    }

    #[test]
    fn ironhorse_range_error_accepts_stack_and_meter_aborts() {
        // A synthetic dual-run with ironhorse stack overflow: an expected
        // RangeError negative is satisfied on ironhorse's side.
        let run = synthetic_abort(Halt::StackOverflow(4), "");
        assert!(ironhorse_negative_ok("RangeError", &run));
        assert!(!ironhorse_negative_ok("TypeError", &run));

        let meter = synthetic_abort(Halt::MeterAbort, "");
        assert!(ironhorse_negative_ok("RangeError", &meter));

        let thrown = synthetic_abort(Halt::Throw("TypeError: bad".into()), "TypeError: bad");
        assert!(ironhorse_negative_ok("TypeError", &thrown));
        assert!(!ironhorse_negative_ok("RangeError", &thrown));
    }

    fn early_negative(phase: &str) -> Negative {
        Negative {
            phase: phase.to_string(),
            ty: "SyntaxError".to_string(),
        }
    }

    #[test]
    fn early_error_compiler_rejection_is_covered() {
        // ironhorse-compile raised its own SyntaxError AND the oracle rejected
        // the source: a real early-error reproduction — the covered outcome that
        // replaces the old blanket `pending-compiler` skip.
        // ironhorse rejected AND the oracle rejected at parse (emitted no
        // bytecode): both agree it is an early error. `oracle_parsed = false`.
        let run = synthetic_early(
            Agreement::BothAbort,
            false,
            IronhorseCompile::Rejected("line 1: unexpected token".into()),
        );
        let cfg = Config::default();
        assert_eq!(
            evaluate_negative_early(&cfg, &run, &early_negative("parse")),
            Verdict::Covered
        );
        assert_eq!(
            evaluate_negative_early(&cfg, &run, &early_negative("resolution")),
            Verdict::Covered
        );
    }

    #[test]
    fn early_error_partial_oracle_code_with_expected_syntax_error_is_covered() {
        // XS can emit an error stub when a lexer-owned literal (for example
        // `/\\11/`) raises its SyntaxError. The explicit expected
        // constructor is still authoritative evidence of parse rejection.
        let mut run = synthetic_early(
            Agreement::BothAbort,
            true,
            IronhorseCompile::Rejected("invalid reference number".into()),
        );
        run.oracle_error = "SyntaxError: invalid reference number".into();
        let cfg = Config::default();
        assert_eq!(
            evaluate_negative_early(&cfg, &run, &early_negative("parse")),
            Verdict::Covered
        );
    }

    #[test]
    fn early_error_runtime_abort_after_parse_is_not_a_rejection_signal() {
        // A normally assembled early-negative starts with `$DONOTEVALUATE()`.
        // If XS accepted the source, that helper aborts at run; a generic
        // runtime Error must not be confused with the expected SyntaxError.
        let mut run = synthetic_early(
            Agreement::BothAbort,
            true,
            IronhorseCompile::Rejected("unexpected token".into()),
        );
        run.oracle_error = "Test262Error: This statement should not be evaluated.".into();
        let cfg = Config::default();
        assert_eq!(
            evaluate_negative_early(&cfg, &run, &early_negative("parse")),
            Verdict::RunSkip("negative-oracle-unexpected".into())
        );
    }

    #[test]
    fn early_error_over_acceptance_is_a_failure() {
        // ironhorse-compile ACCEPTED a source the oracle rejected at parse
        // (`oracle_parsed = false`): the bar-forbidden parser over-acceptance the
        // differential exists to catch. The realistic corpus shape is
        // `BothAbort` — the assembled program's leading `$DONOTEVALUATE()` throws
        // at run, so neither engine "completes" even though ironhorse wrongly
        // PARSED it. The verdict is decided at the parse phase, so this Fail is
        // reachable (the old `IronhorseOnlyComplete` premise never was).
        let run = synthetic_early(Agreement::BothAbort, false, IronhorseCompile::Accepted);
        let cfg = Config::default();
        match evaluate_negative_early(&cfg, &run, &early_negative("parse")) {
            Verdict::Fail(m) => assert!(m.contains("over-acceptance"), "got {m}"),
            other => panic!("expected Fail, got {other:?}"),
        }
    }

    /// Build a positive-test `DualRun` where ironhorse completed and the oracle
    /// did not (`IronhorseOnlyComplete`), with a chosen oracle-parse signal
    /// (`oracle_parsed`: did XS emit bytecode?) and thrown-value string — the two
    /// axes `oracle_host_aborted` reads.
    fn synthetic_ironhorse_only_complete(oracle_parsed: bool, oracle_error: &str) -> DualRun {
        let mut run = synthetic_abort(Halt::Return, "");
        run.agreement = Agreement::IronhorseOnlyComplete;
        run.oracle_parsed = oracle_parsed;
        run.oracle_error = oracle_error.to_string();
        run
    }

    #[test]
    fn oracle_host_stack_overflow_is_a_host_exclusion_not_over_acceptance() {
        // XS emitted bytecode (it parsed AND coded the source cleanly) then
        // aborted at RUN with an empty thrown value — the `fxAbort` value-stack
        // overflow signature (the 16 `start-unicode-*` cases: >3912 top-level
        // decls overflow XS's fixed 4096-slot geometry on a valid program). The
        // oracle could not RUN a valid source, so it is a host / oracle
        // non-result the differential cannot cover — NOT an ironhorse
        // over-acceptance — and it scores `infrastructure`, never
        // `ironhorse-failure`.
        let run = synthetic_ironhorse_only_complete(true, "");
        assert!(oracle_host_aborted(&run));
        let cfg = Config::default();
        assert_eq!(
            evaluate_positive(&cfg, &run, false),
            Verdict::RunSkip("oracle-host-stack-limit".into())
        );
        assert_eq!(
            crate::report::classify(crate::report::Verdict::RunSkip, "oracle-host-stack-limit"),
            crate::report::Category::Infrastructure
        );
    }

    #[test]
    fn genuine_over_acceptance_still_fails() {
        // The host-abort refinement must NOT mask a real over-acceptance. Two
        // distinct non-host shapes stay `Fail`:
        //  * the oracle REJECTED at parse — emitted no bytecode (a real early
        //    error ironhorse wrongly ran to completion);
        let parse_reject = synthetic_ironhorse_only_complete(false, "");
        assert!(!oracle_host_aborted(&parse_reject));
        //  * the oracle threw a real runtime value — a non-empty thrown string
        //    (ironhorse missed a runtime throw the oracle raised).
        let runtime_throw = synthetic_ironhorse_only_complete(true, "TypeError: nope");
        assert!(!oracle_host_aborted(&runtime_throw));
        let cfg = Config::default();
        for run in [parse_reject, runtime_throw] {
            match evaluate_positive(&cfg, &run, false) {
                Verdict::Fail(m) => assert!(m.contains("over-acceptance"), "got {m}"),
                other => panic!("expected Fail, got {other:?}"),
            }
        }
    }

    #[test]
    fn oracle_nontermination_maps_to_infrastructure() {
        // A hang attributed to the ORACLE (ironhorse terminates alone) is a host
        // non-result, never the bar-forbidden `ironhorse-hang` failure.
        assert_eq!(
            crate::report::classify(
                crate::report::Verdict::RunSkip,
                "oracle-nontermination: oracle failed to terminate within 10s (ironhorse terminates alone)"
            ),
            crate::report::Category::Infrastructure
        );
    }

    #[test]
    fn early_error_oracle_also_parsed_is_not_a_failure() {
        // ironhorse-compile accepted AND the oracle also parsed the source
        // (`oracle_parsed = true`): both front ends accepted a source test262
        // marks as a parse negative, so there is no parse-phase differential
        // authority to fail on — a skip, never a Fail and never covered. (Under
        // the old `!oracle_completed` signal this synthetic `BothAbort` shape —
        // both aborting on the `$DONOTEVALUATE()` throw — was miscounted as an
        // oracle rejection and Failed.)
        let run = synthetic_early(Agreement::BothAbort, true, IronhorseCompile::Accepted);
        let cfg = Config::default();
        assert_eq!(
            evaluate_negative_early(&cfg, &run, &early_negative("parse")),
            Verdict::RunSkip("negative-oracle-unexpected".into())
        );
    }

    #[test]
    fn early_error_unsupported_construct_is_a_named_compiler_gap_not_covered() {
        // ironhorse-compile returned an `Unsupported`-kind error: it declined to
        // parse a construct that is valid JS but not yet ported. That is a
        // compiler coverage gap, NOT a covered early error — a refusal to parse
        // an unported construct must never be counted as a correct rejection of
        // a forbidden one, even when the oracle also rejects.
        let run = synthetic_early(
            Agreement::BothAbort,
            false,
            IronhorseCompile::Unsupported("line 1: unsupported: arrow function".into()),
        );
        let cfg = Config::default();
        let v = evaluate_negative_early(&cfg, &run, &early_negative("parse"));
        assert_eq!(v, Verdict::RunSkip("compiler-unimplemented:parse".into()));
        assert_eq!(
            crate::report::classify(
                crate::report::Verdict::RunSkip,
                "compiler-unimplemented:parse"
            ),
            crate::report::Category::Unsupported
        );
    }

    #[test]
    fn early_error_oracle_surprise_is_not_covered() {
        // ironhorse rejected but the oracle ACCEPTED (parsed) the source
        // (`oracle_parsed = true`, and it completed): the differential authority
        // disagrees it is an early error, so we do not claim coverage.
        let run = synthetic_early(
            Agreement::OracleOnlyComplete,
            true,
            IronhorseCompile::Rejected("line 1: unexpected token".into()),
        );
        let cfg = Config::default();
        assert_eq!(
            evaluate_negative_early(&cfg, &run, &early_negative("parse")),
            Verdict::RunSkip("negative-oracle-unexpected".into())
        );
    }

    #[test]
    fn early_error_compile_panic_is_a_named_compiler_gap() {
        // A deferred/unimplemented coder path (a panic caught by the compile
        // seam) is an Ironhorse compiler coverage gap — a named `unsupported`,
        // never a covered early error and never silently a pass.
        let run = synthetic_early(
            Agreement::BothAbort,
            false,
            IronhorseCompile::Panicked("static block with lexical declarations deferred".into()),
        );
        let cfg = Config::default();
        let v = evaluate_negative_early(&cfg, &run, &early_negative("parse"));
        assert_eq!(v, Verdict::RunSkip("compiler-unimplemented:parse".into()));
        assert_eq!(
            crate::report::classify(
                crate::report::Verdict::RunSkip,
                "compiler-unimplemented:parse"
            ),
            crate::report::Category::Unsupported
        );
    }

    #[test]
    fn early_error_no_oracle_trusts_ironhorse_rejection() {
        // With the oracle gate off, ironhorse's own rejection stands as covered
        // even though the oracle is not consulted as authority (the oracle-parse
        // signal is irrelevant here).
        let run = synthetic_early(
            Agreement::OracleOnlyComplete,
            true,
            IronhorseCompile::Rejected("line 1: unexpected token".into()),
        );
        let cfg = Config {
            oracle: false,
            ..Config::default()
        };
        assert_eq!(
            evaluate_negative_early(&cfg, &run, &early_negative("parse")),
            Verdict::Covered
        );
    }

    #[test]
    fn per_case_bound_records_a_hang_without_wedging() {
        // Load-bearing: drive a *genuinely* non-terminating source through the
        // bound and assert it returns an `ironhorse-hang` Fail in bounded
        // wall-clock — this actually exercises the `RecvTimeoutError::Timeout`
        // arm, so deleting that arm (or the bound) makes the test hang and fail
        // rather than pass. `while (true) {}` spins the engine forever; a 2s
        // bound is far above the millisecond a real dual-run takes.
        let cfg = Config::default();
        if let Some((_root, harness)) = crate::test262::locate_test262() {
            // A trivial program completes well within the bound.
            let quick =
                run_case_bounded(&cfg, &harness, "1 + 1;", std::time::Duration::from_secs(2));
            assert!(!matches!(&quick.verdict, Verdict::Fail(m) if m.contains("ironhorse-hang")));

            // A non-terminator is recorded as a hang, in bounded time.
            let started = std::time::Instant::now();
            let hung = run_case_bounded(
                &cfg,
                &harness,
                "while (true) {}",
                std::time::Duration::from_secs(2),
            );
            assert!(
                started.elapsed() < std::time::Duration::from_secs(30),
                "the bound must return promptly, not block on the hang"
            );
            match &hung.verdict {
                Verdict::Fail(m) => assert!(
                    m.contains("ironhorse-hang"),
                    "a non-terminating case must be a recorded hang, got: {m}"
                ),
                other => panic!("expected an ironhorse-hang Fail, got {other:?}"),
            }
        }
        // The hang verdict maps to the bar-forbidden ironhorse-failure category.
        assert_eq!(
            crate::report::classify(
                crate::report::Verdict::Fail,
                "ironhorse-hang: no verdict within 2s (non-terminating dispatch)"
            ),
            crate::report::Category::IronhorseFailure
        );
    }

    #[test]
    fn strict_only_hang_attribution_probes_the_strict_variant() {
        // Regression for the sloppy-only attribution bug: an `onlyStrict` case
        // runs *only* the strict variant (`strict_mode_status` → run_sloppy
        // false), so `ironhorse_terminates_alone` must probe the STRICT
        // assembly. Probing the sloppy assembly instead would judge the wrong
        // mode and mislabel a real strict-only ironhorse hang as an
        // `oracle-nontermination` infrastructure skip — the exact category
        // error the attribution exists to prevent.
        let Some((_root, harness)) = crate::test262::locate_test262() else {
            return;
        };

        // `with (…) {}` diverges by mode: a SyntaxError early error under
        // strict (ironhorse terminates at parse), an infinite loop under
        // sloppy. An `onlyStrict` case therefore must report `true` — the
        // buggy sloppy-only probe would run the loop and hang to `false`.
        let strict_diverges =
            "/*---\nflags: [onlyStrict]\n---*/\nwith ({}) { while (true) {} }\n";
        assert!(
            ironhorse_terminates_alone(&harness, strict_diverges, std::time::Duration::from_secs(10)),
            "an onlyStrict case must be probed via its strict assembly (a strict early error terminates), not the sloppy infinite loop"
        );

        // And a genuine strict-only non-terminator is still caught as a hang
        // (ironhorse does not terminate), never laundered onto the oracle.
        let strict_hang = "/*---\nflags: [onlyStrict]\n---*/\nwhile (true) {}\n";
        assert!(
            !ironhorse_terminates_alone(&harness, strict_hang, std::time::Duration::from_secs(2)),
            "a strict-only infinite loop is an ironhorse hang, not oracle non-termination"
        );
    }

    #[test]
    fn report_yaml_has_the_xst_sections() {
        let mut rep = XstReport::default();
        rep.record(
            "language/a.js",
            CaseResult {
                verdict: Verdict::Covered,
                strict_skipped: true,
                computron_gap: true,
            },
        );
        rep.record(
            "language/b.js",
            CaseResult {
                verdict: Verdict::RunSkip("unsupported-opcode:XS_CODE_FOO".into()),
                strict_skipped: true,
                computron_gap: false,
            },
        );
        rep.record(
            "language/c.js",
            CaseResult {
                verdict: Verdict::PreSkip("feature:Temporal".into()),
                strict_skipped: false,
                computron_gap: false,
            },
        );
        let y = rep.to_yaml();
        assert!(y.contains("runner: ironhorse-xst"));
        assert!(y.contains("mode:"));
        assert!(y.contains("strict-skipped-by-policy: 2"));
        assert!(y.contains("skip:"));
        assert!(y.contains("skip-detail:"));
        assert!(y.contains("advisory:"));
        assert!(y.contains("computron-gap: 1"));
        assert!(rep.met_bar());
    }

    #[test]
    fn covered_grammar_sections_have_zero_failures_through_xst() {
        // The ironhorse-xst analogue of test262.rs's covered-grammar bar: walk a
        // bounded, deterministic slice of the covered-grammar sections
        // through the full mode/verdict/oracle machinery and require ZERO
        // failures — every case ironhorse runs end-to-end either meets the bar
        // (covered) or is honestly named-skipped; nothing diverges. The
        // covered count is reported, not asserted to a target (it grows as
        // stages land the built-ins). The full-tree walk is the `ironhorse-xst`
        // binary; this in-`cargo test` slice stays bounded so the oracle RSS
        // is contained.
        use crate::test262::{collect_js, locate_test262};
        let (root, harness) = match locate_test262() {
            Some(p) => p,
            None => {
                eprintln!("test262 subset absent; skipping the ironhorse-xst covered-grammar bar");
                return;
            }
        };
        let sections = [
            "language/expressions/addition",
            "language/expressions/logical-not",
            "language/statements/throw",
            "language/statements/if",
        ];
        let mut files = Vec::new();
        for s in sections {
            files.extend(collect_js(&root.join(s)));
        }
        assert!(
            !files.is_empty(),
            "covered-grammar sections must have tests"
        );
        let cfg = Config::default();
        let rep = run_files(&cfg, &harness, &root, &files);
        eprintln!(
            "ironhorse-xst covered-grammar slice: total={} covered={} failed={} advisory-computron-gap={}",
            rep.total,
            rep.covered,
            rep.failures.len(),
            rep.computron_advisories,
        );
        for (reason, n) in rep.skip_detail_summary() {
            eprintln!("    {:>5}  {}", n, reason);
        }
        for (path, detail) in &rep.failures {
            eprintln!("  FAIL {}\n    {}", path, detail);
        }
        // The report YAML must be well-formed enough to re-parse its own
        // shape (a smoke check on the emitter).
        let y = rep.to_yaml();
        assert!(y.contains("runner: ironhorse-xst") && y.contains("bar-met: true"));
        assert!(
            rep.met_bar(),
            "zero failures required through the xst runner; got {}",
            rep.failures.len()
        );
    }

    /// A `DualRun` in a shared-abort shape for exercising the negative
    /// verdict helpers without an oracle machine.
    fn synthetic_abort(ironhorse_halt: Halt, ironhorse_error: &str) -> DualRun {
        DualRun {
            source: String::new(),
            agreement: Agreement::BothAbort,
            result_agrees: false,
            oracle_result: String::new(),
            ironhorse_result: String::new(),
            computrons_agree: false,
            oracle_computrons: 0,
            ironhorse_computrons: 0,
            error_agrees: false,
            oracle_error: String::new(),
            ironhorse_error: ironhorse_error.to_string(),
            oracle_meter_raw: 0,
            ironhorse_meter_raw: 0,
            ironhorse_dispatched: 0,
            ironhorse_halt,
            ironhorse_compile: IronhorseCompile::NotAttempted,
            bytecode: Vec::new(),
            oracle_parsed: false,
        }
    }

    /// A `DualRun` shaped for the early-error (parse/resolution) negative
    /// verdict: the caller supplies the four-valued `agreement` (whether each
    /// engine completed), whether the XS **oracle** parsed the source
    /// (`oracle_parsed`, its own parse signal), and ironhorse's own front-end
    /// reaction (`ironhorse_compile`) — the axes `evaluate_negative`'s
    /// early-error arm reads.
    fn synthetic_early(
        agreement: Agreement,
        oracle_parsed: bool,
        compile: IronhorseCompile,
    ) -> DualRun {
        let mut run = synthetic_abort(Halt::Decode("empty".into()), "");
        run.agreement = agreement;
        run.oracle_parsed = oracle_parsed;
        run.ironhorse_compile = compile;
        run
    }

    #[test]
    fn positive_shared_test262_error_is_not_covered() {
        let mut run = synthetic_abort(
            Halt::Throw("Test262Error: assertion failed".into()),
            "Test262Error: assertion failed",
        );
        run.oracle_error = "Test262Error: assertion failed".into();
        run.error_agrees = true;
        assert_eq!(
            evaluate_positive(&Config::default(), &run, false),
            Verdict::RunSkip("shared-test262-failure".into())
        );
    }

    #[test]
    fn oracle_test262_error_with_divergent_ironhorse_throw_is_not_shared() {
        // Oracle throws the harness assertion error; ironhorse throws a
        // different value (a real divergence). Nothing is shared, so this must
        // stay `abort-value-differs` (-> the Ironhorse backlog), never be
        // laundered into `shared-test262-failure`.
        let mut run = synthetic_abort(
            Halt::Throw("TypeError: not a function".into()),
            "TypeError: not a function",
        );
        run.oracle_error = "Test262Error: assertion failed".into();
        run.error_agrees = false;
        assert_eq!(
            evaluate_positive(&Config::default(), &run, false),
            Verdict::RunSkip("abort-value-differs".into())
        );
    }

    #[test]
    fn shared_test262_error_still_yields_to_an_armed_meter_gate() {
        // With a meter-exact gate armed, a differing computron budget is a
        // violation even when both engines threw the same Test262Error — the
        // gate outranks the shared-abort shape.
        let mut run = synthetic_abort(
            Halt::Throw("Test262Error: assertion failed".into()),
            "Test262Error: assertion failed",
        );
        run.oracle_error = "Test262Error: assertion failed".into();
        run.error_agrees = true;
        run.oracle_computrons = 100;
        run.ironhorse_computrons = 101;
        assert!(matches!(
            evaluate_positive(&Config::default(), &run, true),
            Verdict::Fail(_)
        ));
    }

    /// An `AsyncDualRun` wrapping a trivially-agreeing dual-run with a chosen
    /// completion signal and rejection latch — for the pure `refine_async`
    /// trichotomy without an oracle machine.
    fn synthetic_async(signal: Option<&str>, unhandled: bool) -> AsyncDualRun {
        AsyncDualRun {
            run: synthetic_abort(Halt::Return, ""),
            ironhorse_signal: signal.map(|s| s.to_string()),
            ironhorse_unhandled_rejection: unhandled,
        }
    }

    #[test]
    fn refine_async_only_narrows_covered_to_honest_skips() {
        // The clean `$DONE()` success is the only covered shape.
        assert_eq!(
            refine_async(&synthetic_async(Some("Test262:AsyncTestComplete"), false)),
            Verdict::Covered
        );
        // A reported async failure, an unexpected signal, and the did-not-run
        // latch each become a NAMED skip — never a `Fail` (on a `Covered` base
        // the oracle agreed with ironhorse, so a non-success signal is a shared
        // outcome, not an ironhorse defect).
        assert!(matches!(
            refine_async(&synthetic_async(Some("Test262:AsyncTestFailure:X"), false)),
            Verdict::RunSkip(r) if r == "async:reported-failure"
        ));
        assert!(matches!(
            refine_async(&synthetic_async(Some("something else"), false)),
            Verdict::RunSkip(r) if r == "async:unexpected-signal"
        ));
        assert!(matches!(
            refine_async(&synthetic_async(None, false)),
            Verdict::RunSkip(r) if r == "async:no-completion-signal"
        ));
        // The unhandled-rejection latch wins even over a would-be success.
        assert!(matches!(
            refine_async(&synthetic_async(Some("Test262:AsyncTestComplete"), true)),
            Verdict::RunSkip(r) if r == "async:unhandled-rejection"
        ));
    }

    #[test]
    fn async_prelude_records_done_through_the_drain() {
        // The `$DONE` sentinel + job-drain wiring, exercised end-to-end through
        // the real oracle differential (no test262 tree needed). Each source
        // prepends the async prelude, dual-runs, and the ironhorse completion latch
        // is read after the promise pump drains.
        let done = |body: &str| {
            let src = format!("{ASYNC_PRELUDE}{body}");
            dual_run_async(&src, ASYNC_SIGNAL_NAME).expect("oracle machine available")
        };

        // A synchronous success signals `AsyncTestComplete`.
        let s = done("$DONE();");
        assert_eq!(
            s.ironhorse_signal.as_deref(),
            Some("Test262:AsyncTestComplete")
        );
        assert!(!s.ironhorse_unhandled_rejection);

        // An awaited primitive then `$DONE()` — the resume runs at the drain.
        let a = done("(async function(){ await 1; $DONE(); })();");
        assert_eq!(a.run.agreement, Agreement::BothComplete);
        assert_eq!(
            a.ironhorse_signal.as_deref(),
            Some("Test262:AsyncTestComplete")
        );

        // A resolved-promise reaction feeding `$DONE` — drained the same way.
        let p = done("Promise.resolve(1).then(function(){ $DONE(); }, $DONE);");
        assert_eq!(
            p.ironhorse_signal.as_deref(),
            Some("Test262:AsyncTestComplete")
        );

        // Never signals: the did-not-run latch reads `None`.
        assert_eq!(done("1 + 1;").ironhorse_signal, None);

        // A rejected promise nothing observes trips the unhandled-rejection
        // latch (mirroring `the->rejection`), and never signals `$DONE`.
        let r = done("Promise.reject(new Error('x'));");
        assert!(r.ironhorse_unhandled_rejection);
        assert_eq!(r.ironhorse_signal, None);
    }

    #[test]
    fn async_sections_have_zero_failures_through_xst() {
        // The async analogue of `covered_grammar_sections_have_zero_failures_
        // through_xst`: walk a bounded slice of the async surface (which used
        // to pre-skip wholesale as `structural:async-or-can-block`) through the
        // full runner and require ZERO failures — every `async` case ironhorse runs
        // to a real `$DONE` completion is covered, everything else is honestly
        // named-skipped, nothing diverges. The covered count is reported, not
        // pinned (it grows as the async surface lands more built-ins).
        use crate::test262::{collect_js, locate_test262};
        let (root, harness) = match locate_test262() {
            Some(p) => p,
            None => {
                eprintln!("test262 subset absent; skipping the ironhorse-xst async bar");
                return;
            }
        };
        // Bounded async directories (whole-tree `built-ins/Promise` is large;
        // the await + async-function statement sections are a representative,
        // deterministic slice that stays inside the oracle RSS budget).
        let sections = [
            "language/expressions/await",
            "language/statements/async-function",
        ];
        let mut files = Vec::new();
        for s in sections {
            files.extend(collect_js(&root.join(s)));
        }
        assert!(!files.is_empty(), "async sections must have tests");
        let cfg = Config::default();
        let rep = run_files(&cfg, &harness, &root, &files);
        eprintln!(
            "ironhorse-xst async slice: total={} covered={} failed={}",
            rep.total,
            rep.covered,
            rep.failures.len(),
        );
        for (reason, n) in rep.skip_detail_summary() {
            eprintln!("    {:>5}  {}", n, reason);
        }
        for (path, detail) in &rep.failures {
            eprintln!("  FAIL {}\n    {}", path, detail);
        }
        assert!(
            rep.covered > 0,
            "the async surface has landed; expected some covered async cases"
        );
        assert!(
            rep.failures.is_empty(),
            "zero failures required through the async xst runner; got {}",
            rep.failures.len()
        );
    }
}
