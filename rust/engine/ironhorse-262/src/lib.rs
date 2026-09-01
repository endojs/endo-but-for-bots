#![forbid(unsafe_code)]
//! ironhorse-262: the dual-run harness (design § test262 conformance;
//! requirement 6).
//!
//! For each program it executes the source on the XS oracle
//! (`xs-oracle`) to obtain the reference `(result, run-only computrons)`
//! and, post stage-6 seam flip, runs ironhorse's **own** bytecode (compiled by
//! the default `ironhorse-compile` pipeline; the oracle's exact bytes remain a
//! selectable differential reference via [`Compiler::Oracle`]) on
//! `ironhorse-vm`, then records four-valued agreement plus computron
//! agreement. Matching the oracle's *fail*
//! vector matters as much as its pass vector: a program ironhorse completes
//! that XS throws on (or vice versa) is a divergence, never a silent
//! improvement.
//!
//! The bespoke per-stage corpus (`corpora/*.js` + the `stage*_corpus()`
//! accessors) that drove bring-up has **retired** into a test262-shaped
//! `packages/test262-runner/test262/test/ironhorse/` tree: the
//! `corpus-to-262` converter (bin) dual-runs each corpus line once and emits
//! one standard test262 case, and `endot-ih` ([`xst`]) runs that tree
//! with the same differential (design § Part 1, "the corpus becomes test262
//! cases"). The coverage-equivalence proof lives in
//! `tests/corpus_conversion_equivalence.rs`. Whole-section runs draw from the
//! monorepo's existing `packages/test262-runner` test262 subset and its
//! `ses-xs-parity` feature markers -- the same tree that package uses to
//! prove XS<->Node HardenedJS parity -- rather than a separate pinned test262
//! submodule (maintainer directive, PR #600, 2026-07-03; design section
//! "test262 conformance"). [`dual_run`] and [`parse_corpus`] remain the
//! differential and line-splitting primitives the converter and the runner
//! share.

use ironhorse_vm::{Halt, RunOutcome};

/// The [`ironhorse_vm::SourceCompiler`] the VM's runtime source-execution
/// bridge (a string `eval`, the `Function` constructor) drives to compile a
/// source string to bytecode in the running realm. It is ironhorse's own
/// front end ([`ironhorse_compile`]) — the same compiler the top-level
/// program rides — so an eval'd source is held to the identical pipeline.
///
/// Total over the coder's panics (`catch_unwind`): a deferred coder path
/// becomes an honest [`ironhorse_vm::SourceCompileError::Unsupported`]
/// (a coverage gap the VM surfaces as `Halt::Unsupported`), never a harness
/// crash. A structured parse reject splits on its kind exactly as
/// [`compile_for`] does: an `Unsupported` parse (an unported-but-valid
/// construct) is a coverage gap; every other reject is a genuine early error,
/// which the bridge throws as a realm-local, catchable `SyntaxError`.
pub struct IronhorseSourceCompiler;

impl ironhorse_vm::SourceCompiler for IronhorseSourceCompiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
    ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
        let source = source.to_string();
        let compiled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            ironhorse_compile::compile_atoms_with(&source, strict)
        }));
        match compiled {
            Ok(Ok((bytecode, symbols))) => {
                Ok(ironhorse_vm::CompiledSource { bytecode, symbols })
            }
            Ok(Err(e)) => {
                match e.kind {
                    ironhorse_compile::parser::ParseErrorKind::Unsupported => {
                        Err(ironhorse_vm::SourceCompileError::Unsupported(e.to_string()))
                    }
                    // Carry the bare diagnostic (`e.message`, no `line N:`
                    // prefix) so the bridge's realm-local `SyntaxError` renders
                    // with XS's exact wording — the pinned oracle's thrown
                    // `String(exception)` is `SyntaxError: <message>`, and the
                    // differential harness compares the whole string.
                    _ => Err(ironhorse_vm::SourceCompileError::Syntax(e.message)),
                }
            }
            Err(payload) => Err(ironhorse_vm::SourceCompileError::Unsupported(panic_message(
                payload.as_ref(),
            ))),
        }
    }
}

/// Construct a realm interpreter linked against `names` **and** armed with the
/// runtime source compiler, so a program that calls `eval` on a string (or the
/// `Function` constructor) executes it in-realm rather than reaching the honest
/// `eval:no-compiler` gap. This is the single wiring point that turns the
/// compiler/VM bridge on for the conformance harness.
fn interp_with_source_bridge(names: &[String]) -> ironhorse_vm::Interp {
    let mut interp = ironhorse_vm::Interp::new();
    interp.link_intrinsics(names);
    interp.set_source_compiler(std::rc::Rc::new(IronhorseSourceCompiler));
    interp
}

/// Run a program bytecode buffer with its symbols atom on a realm armed with
/// the runtime source bridge (so an in-program `eval` of a string executes).
/// Mirrors [`ironhorse_vm::run_program_with_symbols`] but installs the
/// compiler, and is the entry the differential run path uses.
fn run_program_with_symbols(bytecode: &[u8], symbols: &[u8]) -> RunOutcome {
    let names = ironhorse_vm::parse_symbols(symbols);
    interp_with_source_bridge(&names).run(bytecode)
}

pub mod compile_diff;
pub mod expectations;
pub mod frontmatter;
pub mod report;
pub mod test262;
pub mod xst;

/// The four-valued completion agreement (design § test262 conformance).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agreement {
    /// Both engines completed normally.
    BothComplete,
    /// Both engines aborted (threw / failed to parse).
    BothAbort,
    /// ironhorse completed where the oracle aborted.
    IronhorseOnlyComplete,
    /// The oracle completed where ironhorse aborted.
    OracleOnlyComplete,
}

/// How ironhorse's **own** front end (`ironhorse-compile`) reacted to the
/// program's source — the signal the early-error (parse/resolution) negative
/// verdict needs to tell an honest *compiler rejection* (ironhorse raised the
/// SyntaxError itself for a construct it implements) apart from an
/// *over-acceptance* (it emitted bytecode for a source the spec forbids) and a
/// *compiler coverage gap* (it panicked, or declined an unported-but-valid
/// construct via [`Self::Unsupported`]). Captured by `compile_for` and reached
/// through the public [`dual_run_with`]; meaningful only on the
/// [`Compiler::Ironhorse`] path (the default runner), [`Self::NotAttempted`] on
/// the oracle-reference path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IronhorseCompile {
    /// The oracle-compiler reference path: ironhorse-compile was not consulted,
    /// so no rejection/acceptance signal exists.
    NotAttempted,
    /// ironhorse-compile emitted bytecode — it *accepted* the source.
    Accepted,
    /// ironhorse-compile returned a structured parser/scoper early error (the
    /// SyntaxError its own front end raises) for a construct it *does*
    /// implement — a real early-error reproduction. The string is the rendered
    /// `ParseError`, for the report. Distinct from [`Self::Unsupported`] so a
    /// refusal to parse an unported construct is never miscounted as a correct
    /// early-error rejection.
    Rejected(String),
    /// ironhorse-compile returned a structured error whose kind is
    /// [`ironhorse_compile::parser::ParseErrorKind::Unsupported`] — the front
    /// end declined a construct that is *valid JS but not yet ported*, not a
    /// spec early error. This is an Ironhorse compiler coverage gap (grouped
    /// with [`Self::Panicked`] as `compiler-unimplemented:<phase>`), never a
    /// covered early error. The string is the rendered `ParseError`.
    Unsupported(String),
    /// ironhorse-compile **panicked** — it reached a deferred/unimplemented
    /// coder path (e.g. `static block with lexical declarations deferred`) and
    /// folded rather than emitting bytecode. This is an Ironhorse *compiler
    /// coverage gap*, not a covered early error and not a verdict; the string is
    /// the panic message (a gap label). Distinct from [`Self::Rejected`] (a
    /// clean SyntaxError) so a crash is never miscounted as a correct rejection.
    Panicked(String),
}

/// One program's dual-run record.
#[derive(Debug, Clone)]
pub struct DualRun {
    pub source: String,
    pub agreement: Agreement,
    /// Completion-value string agreement (only meaningful when both
    /// completed).
    pub result_agrees: bool,
    pub oracle_result: String,
    pub ironhorse_result: String,
    /// Computron agreement (only meaningful when both completed).
    pub computrons_agree: bool,
    pub oracle_computrons: u64,
    pub ironhorse_computrons: u64,
    /// Thrown-value agreement (only meaningful on a shared abort): the
    /// oracle's `String(exception)` versus ironhorse's `Halt::Throw` string.
    pub error_agrees: bool,
    /// The oracle's thrown value coerced to `String()` (valid when the
    /// oracle aborted).
    pub oracle_error: String,
    /// ironhorse's thrown value string, from a `Halt::Throw` halt (empty for
    /// any other halt).
    pub ironhorse_error: String,
    /// Raw 16.16 meter indices, for calibrating fractional
    /// (allocation/built-in) metering on a divergence.
    pub oracle_meter_raw: u64,
    pub ironhorse_meter_raw: u64,
    /// ironhorse's raw dispatched-opcode count (before the invocation
    /// baseline), for isolating a metering divergence.
    pub ironhorse_dispatched: u64,
    /// Why ironhorse stopped, verbatim, so an unsupported opcode names
    /// itself.
    pub ironhorse_halt: Halt,
    /// How ironhorse's own front end reacted to the source — the early-error
    /// negative verdict reads this to separate a real compiler rejection from
    /// an over-acceptance or a harness panic.
    pub ironhorse_compile: IronhorseCompile,
    /// The bytecode ironhorse **ran** — the *selected* compiler's output
    /// (`ironhorse-compile`'s on the default [`Compiler::Ironhorse`] path, the
    /// oracle's on the reference path), kept for disassembly on a divergence.
    /// NOT the oracle's bytes on the default runner; a verdict predicate that
    /// needs the oracle's own parse signal reads [`Self::oracle_parsed`], never
    /// this field.
    pub bytecode: Vec<u8>,
    /// Whether the XS **oracle** emitted bytecode — normally evidence that it
    /// parsed and coded the source. Some lexer-owned errors are represented by
    /// a small bytecode stub that throws the reported SyntaxError, so an early-
    /// error verdict also checks the oracle's explicit thrown constructor. This
    /// signal is retained independently of
    /// [`Self::bytecode`] (which under the default runner holds *ironhorse's*
    /// bytes). The early-error negative verdict and the host-abort exclusion both
    /// read this to tell an oracle *parse rejection* (early error) apart from an
    /// oracle *runtime abort* on a source XS parsed.
    pub oracle_parsed: bool,
}

impl DualRun {
    /// The acceptance-bar predicate for one program: same completion,
    /// same result string, same computrons.
    pub fn is_bit_exact(&self) -> bool {
        match self.agreement {
            Agreement::BothComplete => self.result_agrees && self.computrons_agree,
            // A shared abort is bit-exact only when ironhorse aborted for a
            // reason the oracle can share: a JS-level `Throw`. An
            // `Unsupported` (opcode outside the subset) or `Decode`
            // (truncated/invalid bytecode) halt means ironhorse bailed on
            // bytecode it cannot model — the oracle "also aborting"
            // (a parse error, a different throw) is not agreement and
            // must never pass silently.
            //
            // Now that 2b models real exceptions, the shared-abort arm is
            // tightened to the same standard as `BothComplete` (stage-2a
            // review observation 3): the thrown value must match (the
            // oracle's `String(exception)` == ironhorse's `Halt::Throw`
            // string) AND the computrons must match — the uncaught-throw
            // host-escape path is metered exactly (`interp` §
            // `THROW_HOST_ESCAPE_METERING`), and the oracle shim now
            // records the run-only computron count at the throw. A `Throw`
            // whose value or computrons diverge is a divergence, not a
            // silent pass.
            Agreement::BothAbort => {
                matches!(self.ironhorse_halt, Halt::Throw(_))
                    && self.error_agrees
                    && self.oracle_computrons == self.ironhorse_computrons
            }
            _ => false,
        }
    }
}

/// Which compiler produces the bytecode `ironhorse-vm` executes in the
/// dual-run runner — the **pipeline seam** (stage-5 child 7). Stage 5's
/// byte-identity bar (`ironhorse-compile` == the XS oracle over the whole
/// conformance corpus) is accepted, so `Ironhorse` is now the **default**: the
/// default runner runs ironhorse's *own* bytecode and *own* symbols atom
/// (stage-6 child 1, design § roadmap row 5). `Oracle` survives only as a
/// selectable differential REFERENCE — the byte-identity/dual-run harnesses
/// that compare ironhorse against the exact XS-emitted bytes.
///
/// In either mode the oracle is still *consulted* for the **reference**
/// result/computrons the run is compared against; the selection only
/// decides whose *bytecode* ironhorse runs — its own, or the oracle's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Compiler {
    /// The differential XS oracle compiler (`xs_oracle::run`): the
    /// exact XS-emitted bytecode. No longer a default execution path — a
    /// selectable reference for the byte-identity/dual-run differentials
    /// only.
    Oracle,
    /// The pure-Rust `ironhorse-compile` pipeline (lexer → parser → scoper →
    /// coder), now the **default**. Post stage 5 its bytes AND its symbols
    /// atom equal the oracle's, so the seam no longer borrows the oracle's
    /// SYMB payload; a compile fold (parser/scoper reject or a coder panic)
    /// yields empty bytecode the runner treats as an ironhorse abort.
    #[default]
    Ironhorse,
}

/// Compile `source` to `(bytecode, symbols)` under the selected compiler,
/// given the oracle outcome already in hand (the reference). The ironhorse
/// path is total over the coder's panics (`catch_unwind`); a fold returns
/// empty bytecode, which `ironhorse-vm` decodes as an abort — the honest
/// "ironhorse could not run its own output here" signal, never a harness
/// panic. The seam the default now rides lives entirely here.
fn compile_for(
    compiler: Compiler,
    source: &str,
    oracle: &xs_oracle::OracleOutcome,
) -> (Vec<u8>, Vec<u8>, IronhorseCompile) {
    match compiler {
        Compiler::Oracle => (
            oracle.bytecode.clone(),
            oracle.symbols.clone(),
            IronhorseCompile::NotAttempted,
        ),
        Compiler::Ironhorse => {
            // Ironhorse emits BOTH halves now — its own bytecode and its own
            // SYMB atom (`compile_atoms`) — so the flipped default no longer
            // borrows the oracle's `symbols`. Byte-identity of that atom
            // against the oracle is a committed gate
            // (`compile_diff::symbols_diff_programs`, exercised by
            // `corpora_symbols_atom_byte_identity`).
            let compiled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                ironhorse_compile::compile_atoms(source)
            }));
            match compiled {
                Ok(Ok((bytes, symbols))) => (bytes, symbols, IronhorseCompile::Accepted),
                // A structured reject. Empty bytecode -> ironhorse-vm aborts on
                // decode, mirroring "ironhorse rejected". Split on the error
                // *kind*: a real early error the front end implements is a
                // `Rejected` (countable as covered), but an `Unsupported` kind is
                // a refusal to parse an unported-but-valid construct — a compiler
                // coverage gap, never a covered early-error rejection.
                Ok(Err(e)) => {
                    let rendered = e.to_string();
                    let signal = match e.kind {
                        ironhorse_compile::parser::ParseErrorKind::Unsupported => {
                            IronhorseCompile::Unsupported(rendered)
                        }
                        _ => IronhorseCompile::Rejected(rendered),
                    };
                    (Vec::new(), Vec::new(), signal)
                }
                // A coder fold / panic: ironhorse-compile reached a deferred
                // path. Empty bytecode, and the panic payload becomes a compiler
                // coverage-gap label — distinct from a clean rejection so a crash
                // is never miscounted as a correct SyntaxError.
                Err(payload) => (
                    Vec::new(),
                    Vec::new(),
                    IronhorseCompile::Panicked(panic_message(payload.as_ref())),
                ),
            }
        }
    }
}

/// Best-effort render of a caught panic payload (the `dyn Any` behind the `Box`
/// from [`std::panic::catch_unwind`]) as a short one-line message, for a
/// compiler-gap label. Falls back to a generic string for a non-string payload.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    let msg = if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "panic".to_string()
    };
    // One line AND length-bounded — this becomes part of a report reason string
    // published into report.json/HTML, so a panic payload embedding a minified
    // source cannot land unbounded in the artifact.
    let line = msg.lines().next().unwrap_or("panic").trim();
    line.chars().take(200).collect()
}

/// Run one program on both engines and compare, using the default
/// compiler (now [`Compiler::Ironhorse`] — ironhorse runs its own bytecode, the
/// oracle stays the reference). Returns `None` only if the oracle machine
/// fails to start.
pub fn dual_run(source: &str) -> Option<DualRun> {
    dual_run_with(source, Compiler::default())
}

/// Run one program on both engines and compare, choosing which compiler
/// produces the bytecode ironhorse executes (the pipeline seam). Returns
/// `None` only if the oracle machine itself fails to start.
pub fn dual_run_with(source: &str, compiler: Compiler) -> Option<DualRun> {
    let oracle = xs_oracle::run(source)?;

    // The pipeline seam: the bytecode ironhorse runs comes from the selected
    // compiler. The default (oracle) path is the exact XS-emitted bytes;
    // the ironhorse path is `ironhorse-compile`'s own output.
    let (bytecode, symbols, compile) = compile_for(compiler, source, &oracle);

    // Pass the symbols atom so ironhorse relinks the program's intrinsic
    // references (`Object`, `Boolean`, the Error hierarchy, …) to its own
    // intrinsics by name — the XS compiler numbers those symbols
    // program-locally, so the id→name table is what makes `Boolean` mean the
    // native `Boolean` and not an undefined variable (design § fundamentals).
    // A clean early-error rejection by ironhorse-compile (`Rejected`) means the
    // source never runs: per the language, a program with an early SyntaxError
    // throws that SyntaxError before any evaluation, exactly as XS represents a
    // lexer-owned rejection with a small bytecode stub that throws. Running the
    // *empty* bytecode `compile_for` returns for a rejection would instead decode
    // past the end and surface a spurious `Halt::Decode` ("parse-or-decode"),
    // masking a correct, oracle-agreeing rejection (e.g. a RegExp literal whose
    // backreference is out of range). Present the rejection as the SyntaxError
    // throw it is — the same bare `SyntaxError` the runtime `new RegExp(bad)`
    // path already throws (`catchable_syntax_error`) — so the differential
    // compares two rejections rather than a crash.
    let ironhorse: RunOutcome = match &compile {
        IronhorseCompile::Rejected(_) => RunOutcome {
            completed: false,
            result: String::new(),
            computrons: 0,
            dispatched: 0,
            meter_raw: 0,
            halt: ironhorse_vm::Halt::Throw("SyntaxError".to_string()),
        },
        _ => run_program_with_symbols(&bytecode, &symbols),
    };

    Some(build_dual_run(source, oracle, ironhorse, compile, bytecode))
}

/// MULTI-CRANK differential mode (the wave-6 pattern-2 antidote): run
/// `sources` as SEQUENTIAL CRANKS on one machine per engine — XS keeps
/// one live machine across every crank (`xs_oracle::run_cranks`), and
/// ironhorse keeps one `Interp`, relinking each crank's oracle-emitted
/// bytecode (`relink_crank`, the managed-lifecycle path) — and compare
/// per crank. This is the harness's window onto CROSS-CRANK semantics
/// (state created by one crank observed by a later one), which
/// [`dual_run`] structurally cannot see: the class of divergence the
/// wave-6 analysis showed 1093 single-crank tests missed (an error
/// constructor's own `message` read by a LATER crank was its live
/// specimen).
///
/// Retained defining-crank bytecode extends the scope to function and
/// closure calls created by earlier cranks. Per-crank ironhorse
/// computrons are the RAW meter delta
/// across the crank (`meter_index`), matching the shim's per-crank
/// `meterIndex` reset. The run stops at the first crank where either
/// engine fails to complete (that crank's comparison is returned;
/// later sources are not run).
///
/// Returns `None` only if the oracle machine fails to start.
pub fn dual_run_cranks(sources: &[&str]) -> Option<Vec<DualRun>> {
    let oracle_outcomes = xs_oracle::run_cranks(sources)?;
    let mut interp: Option<ironhorse_vm::Interp> = None;
    let mut prev_raw: u64 = 0;
    let mut out = Vec::new();
    for (source, oracle) in sources.iter().zip(oracle_outcomes) {
        let bytecode = oracle.bytecode.clone();
        let names = ironhorse_vm::parse_symbols(&oracle.symbols);
        let mut ironhorse = if bytecode.is_empty() {
            // The oracle did not emit this crank (a parse failure, or a
            // prior crank aborted the run): present ironhorse's side as
            // the same non-run.
            RunOutcome {
                completed: false,
                result: String::new(),
                computrons: 0,
                dispatched: 0,
                meter_raw: 0,
                halt: ironhorse_vm::Halt::Throw("SyntaxError".to_string()),
            }
        } else {
            match interp.as_mut() {
                None => {
                    let mut m = interp_with_source_bridge(&names);
                    let o = m.run(&bytecode);
                    interp = Some(m);
                    o
                }
                Some(m) => match m.relink_crank(&bytecode, &names) {
                    Ok(relinked) => m.run(&relinked),
                    Err(e) => RunOutcome {
                        completed: false,
                        result: String::new(),
                        computrons: 0,
                        dispatched: 0,
                        meter_raw: 0,
                        halt: ironhorse_vm::Halt::Decode(format!("relink refused: {e:?}")),
                    },
                },
            }
        };
        // Per-crank metering: the raw delta across this crank, shifted
        // exactly as the shim shifts its per-crank reset index.
        let raw_now = interp.as_ref().map(|m| m.meter_index()).unwrap_or(0);
        let crank_raw = raw_now.saturating_sub(prev_raw);
        prev_raw = raw_now;
        ironhorse.computrons = crank_raw >> 16;
        ironhorse.meter_raw = crank_raw;
        let stop = !(oracle.completed && ironhorse.completed);
        out.push(build_dual_run(
            source,
            oracle,
            ironhorse,
            IronhorseCompile::NotAttempted,
            bytecode,
        ));
        if stop {
            break;
        }
    }
    Some(out)
}

/// Assemble a [`DualRun`] record from an oracle outcome and ironhorse's run of
/// (the compiler-selected) `bytecode`, computing the four-valued agreement plus
/// the result/computron/error comparisons. Shared by [`dual_run_with`] and
/// [`dual_run_async`], which differ only in whether they retain ironhorse's
/// interpreter afterward to read the async completion latch.
fn build_dual_run(
    source: &str,
    oracle: xs_oracle::OracleOutcome,
    ironhorse: RunOutcome,
    ironhorse_compile: IronhorseCompile,
    bytecode: Vec<u8>,
) -> DualRun {
    let agreement = match (oracle.completed, ironhorse.completed) {
        (true, true) => Agreement::BothComplete,
        (false, false) => Agreement::BothAbort,
        (false, true) => Agreement::IronhorseOnlyComplete,
        (true, false) => Agreement::OracleOnlyComplete,
    };

    // The oracle's own parse signal: XS emitted bytecode iff it parsed AND
    // coded the source. Captured before `oracle` is consumed below.
    let oracle_parsed = !oracle.bytecode.is_empty();

    let result_agrees =
        oracle.completed && ironhorse.completed && oracle.result == ironhorse.result;
    let computrons_agree =
        oracle.completed && ironhorse.completed && oracle.computrons == ironhorse.computrons;

    // ironhorse's thrown value string comes from a `Halt::Throw`; any other
    // halt yields no comparable error string.
    let ironhorse_error = match &ironhorse.halt {
        Halt::Throw(s) => s.clone(),
        _ => String::new(),
    };
    // The thrown value agrees only on a shared abort where ironhorse threw a
    // JS-level exception (`Halt::Throw`): compare the oracle's
    // `String(exception)` against ironhorse's throw string.
    let error_agrees = !oracle.completed
        && !ironhorse.completed
        && matches!(ironhorse.halt, Halt::Throw(_))
        && oracle.error == ironhorse_error;

    DualRun {
        source: source.to_string(),
        agreement,
        result_agrees,
        oracle_result: oracle.result,
        ironhorse_result: ironhorse.result,
        computrons_agree,
        oracle_computrons: oracle.computrons,
        ironhorse_computrons: ironhorse.computrons,
        error_agrees,
        oracle_error: oracle.error,
        ironhorse_error,
        oracle_meter_raw: oracle.meter_raw as u64,
        ironhorse_meter_raw: ironhorse.meter_raw,
        ironhorse_dispatched: ironhorse.dispatched,
        ironhorse_halt: ironhorse.halt,
        ironhorse_compile,
        bytecode,
        oracle_parsed,
    }
}

/// A dual-run that also retains the ironhorse-side async observations an
/// `async`-flagged test262 case needs (design § Part 2, the async row): the
/// `$DONE` completion sentinel a pure-JS async prelude records into a global,
/// and the unhandled-rejection latch mirroring XS's `the->rejection`. The
/// oracle shim already drains the promise job queue with metering accumulating
/// (`fxRunPromiseJobs`), and ironhorse's [`ironhorse_vm::Interp::run`] drains its own
/// (the stage-3b promise pump), so a computron agreement in `run` certifies
/// ironhorse reproduced the oracle's whole execution *including* the microtask
/// drain — the gate the async verdict layers on top of.
#[derive(Debug, Clone)]
pub struct AsyncDualRun {
    pub run: DualRun,
    /// The ironhorse async completion sentinel (`$DONE`'s outcome as the async
    /// prelude records it), rendered `String()`; `None` if the program never
    /// signaled (the did-not-run latch — `$DONE` was never called).
    pub ironhorse_signal: Option<String>,
    /// ironhorse saw a promise settle rejected that nothing ever observed
    /// (`the->rejection`-equivalent).
    pub ironhorse_unhandled_rejection: bool,
}

/// Run one async-harness `source` on both engines and, keeping ironhorse's
/// interpreter past the run, read the `$DONE` completion sentinel out of the
/// global named `signal_name` plus the unhandled-rejection latch. Uses the
/// default compiler ([`Compiler::Ironhorse`]) like [`dual_run`]; returns
/// `None` only if the oracle machine itself fails to start.
pub fn dual_run_async(source: &str, signal_name: &str) -> Option<AsyncDualRun> {
    let oracle = xs_oracle::run(source)?;
    let (bytecode, symbols, compile) = compile_for(Compiler::default(), source, &oracle);

    // Mirror `run_program_with_symbols`, but retain the interpreter so the
    // async completion latch can be read after the job drain.
    let names = ironhorse_vm::parse_symbols(&symbols);
    let mut interp = interp_with_source_bridge(&names);
    let ironhorse: RunOutcome = interp.run(&bytecode);

    let ironhorse_signal = interp.global_string(signal_name);
    let ironhorse_unhandled_rejection = interp.has_unhandled_rejection();

    Some(AsyncDualRun {
        run: build_dual_run(source, oracle, ironhorse, compile, bytecode),
        ironhorse_signal,
        ironhorse_unhandled_rejection,
    })
}

/// Run `source` on ironhorse ALONE — its own front end
/// ([`ironhorse_compile`]) then [`ironhorse_vm`], with **no oracle**.
///
/// The per-case wall-clock bound ([`crate::xst`] § the dispatch bound) runs
/// [`dual_run`] — the oracle AND ironhorse — on one thread, so a timeout there
/// does not say *which* engine failed to terminate. Re-running ironhorse alone
/// under the same bound attributes it: if ironhorse terminates on its own, the
/// non-termination was the **oracle's** (a host / infrastructure non-result the
/// differential cannot cover), not an ironhorse dispatch loop. A compiler
/// reject or coder panic yields no bytecode — itself a prompt terminal outcome
/// — so this returns quickly for every case except a genuine ironhorse VM
/// dispatch cycle, which never returns (the caller's wall-clock join bounds
/// that). Metering-neutral: it shares no engine state with any other run.
pub fn ironhorse_only_run(source: &str) -> Halt {
    let compiled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ironhorse_compile::compile_atoms(source)
    }));
    let (bytecode, symbols) = match compiled {
        Ok(Ok((b, s))) => (b, s),
        // A structured reject or a coder panic: ironhorse produced no bytecode,
        // a terminal (non-hanging) outcome — ironhorse did not fail to
        // terminate, so the hang, if any, was not on the ironhorse side.
        _ => return Halt::Decode("ironhorse-only: compile produced no bytecode".into()),
    };
    let names = ironhorse_vm::parse_symbols(&symbols);
    interp_with_source_bridge(&names).run(&bytecode).halt
}

/// Parse a corpus file: one program per non-empty, non-`//` line. Keeping
/// entries to a single line keeps the completion value (the last expression)
/// unambiguous. The per-stage `stage*_corpus()` accessors this once fed
/// retired with the corpus → test262 case conversion (design § Part 1); the
/// function survives because the `corpus-to-262` converter still reads the
/// `corpora/*.js` lines through it during a re-generation.
pub fn parse_corpus(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with("//"))
        .map(|l| l.to_string())
        .collect()
}

/// The **committed** daemon boot-bundle sources the endor daemon evaluates
/// during its bootstrap (design `daemon-endor-architecture.md` § Unified
/// runner, steps 6–7; § Embedded JS bundles). Returned as `(label, source)`
/// pairs so the stage-4 boot-bundle bar can dual-run each against the pin.
///
/// **Provenance.** These two files are the checked-in sources embedded via
/// `include_str!` by `rust/endo/xsnap/src/lib.rs` (`POLYFILLS`,
/// `HOST_ALIASES`) — read here verbatim from the same paths, so the bar runs
/// the *actual* bytes the daemon boots, not a copy that could drift. The
/// third boot step — **`ses_boot.js`** (SES `lockdown()` + the HandledPromise
/// shim) — is **not committed**: it is a ~1 MB build artifact the daemon
/// bundler (`rollup` over `@endo/*`) generates into `src/ses_boot.js` before
/// the `include_str!`, absent in a fresh checkout. Bundling the full SES
/// distribution is out of this engine workspace's scope, so `ses_boot.js` is
/// a **named, ledgered boot-bundle gap** (`boot:ses-lockdown-bundle`), not
/// dual-run here. `host_aliases.js` is a self-contained `globalThis` IIFE
/// that aliases only host functions that exist, so with no host powers
/// registered it completes to `undefined` — safe to dual-run in the engine.
pub fn daemon_boot_bundle_sources() -> Vec<(&'static str, String)> {
    // Relative to this file (`rust/engine/ironhorse-262/src/lib.rs`): up three to
    // `rust/`, then into the daemon crate's committed bundle sources.
    const POLYFILLS: &str = include_str!("../../../endo/xsnap/src/polyfills.js");
    const HOST_ALIASES: &str = include_str!("../../../endo/xsnap/src/host_aliases.js");
    vec![
        ("polyfills.js", POLYFILLS.to_string()),
        ("host_aliases.js", HOST_ALIASES.to_string()),
        // The boot prefix as the daemon evaluates it: polyfills, then the
        // host-alias shim, then a trailing sentinel so the completion value
        // is defined.
        (
            "boot-prefix (polyfills → host_aliases)",
            format!("{POLYFILLS}\n{HOST_ALIASES}\ntrue"),
        ),
    ]
}

/// One boot-bundle program's dual-run verdict, bucketed for the stage-4
/// boot-bundle bar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootVerdict {
    /// ironhorse ran the bundle end-to-end and agreed with the pin's completion
    /// value (the bar's green terminal state — reached once the ledgered
    /// engine gaps below land).
    Agrees,
    /// ironhorse honestly aborted with a self-named halt before diverging: the
    /// bundle references an engine surface ironhorse does not yet model. Carries
    /// the ledgered gap key. This is the doctrine's honest named skip — never
    /// a wrong value — and the current expected state of the committed
    /// bundle.
    NamedGap(String),
    /// ironhorse produced a WRONG value, or accepted a program the pin rejected:
    /// a real divergence the bar forbids. Carries a human detail string.
    Divergent(String),
}

/// Dual-run one boot-bundle source against the pin and bucket it. The gap key
/// on an honest abort is derived from ironhorse's self-named halt so a new
/// blocker names itself rather than hiding.
pub fn boot_bundle_verdict(source: &str) -> BootVerdict {
    let r = match dual_run(source) {
        Some(r) => r,
        None => return BootVerdict::NamedGap("oracle-machine-error".into()),
    };
    match r.agreement {
        Agreement::BothComplete => {
            if r.result_agrees {
                BootVerdict::Agrees
            } else {
                BootVerdict::Divergent(format!(
                    "ironhorse completed with a WRONG value: oracle={:?} ironhorse={:?}",
                    r.oracle_result, r.ironhorse_result
                ))
            }
        }
        Agreement::BothAbort => {
            // Both threw: a shared abort is not a boot divergence (the pin
            // itself rejects the program), reported as the pin's reason.
            BootVerdict::NamedGap(format!("both-abort:{}", r.oracle_error))
        }
        // ironhorse honestly aborted where the pin completed: the bundle hit an
        // engine surface ironhorse does not model. Name the gap from the halt.
        Agreement::OracleOnlyComplete => BootVerdict::NamedGap(boot_gap_key(&r)),
        // ironhorse completed a program the pin rejected: over-acceptance.
        Agreement::IronhorseOnlyComplete => BootVerdict::Divergent(format!(
            "ironhorse completed a program the pin rejected: ironhorse={:?} pin aborted={:?}",
            r.ironhorse_result, r.oracle_error
        )),
    }
}

/// Map an honest ironhorse abort on a boot-bundle program to a stable, ledgered
/// gap key (design's staged-roadmap follow-ups). An `Unsupported(op)` halt
/// self-names by opcode; a `Throw` on an unbound global names the missing
/// intrinsic; anything else carries its halt verbatim.
fn boot_gap_key(r: &DualRun) -> String {
    match &r.ironhorse_halt {
        Halt::Unsupported(op) => format!("boot:unsupported:{op}"),
        Halt::Throw(msg) if msg.contains("undefined variable") => {
            // Historical stage-4 gap: before stage-7 child 1 the committed
            // bundle's first statement (`globalThis`) had no live global-object
            // binding and every bundle stopped here. That binding has since
            // landed, so this key is retained only as the stable ledger name
            // for that (now-closed) gap; a bundle no longer reaches it.
            "boot:no-globalThis-global-object-binding".to_string()
        }
        Halt::Throw(msg) => format!("boot:throw:{msg}"),
        other => format!("boot:halt:{other:?}"),
    }
}

/// One program's compartment differential record: the oracle result and
/// the result each of two compartments over one shared-intrinsics machine
/// produced when it evaluated the oracle's exact bytecode.
#[derive(Debug, Clone)]
pub struct CompartmentDualRun {
    pub source: String,
    /// The oracle completed normally.
    pub oracle_completed: bool,
    pub oracle_result: String,
    /// Both compartments completed normally.
    pub both_completed: bool,
    /// Compartment A's completion value string.
    pub a_result: String,
    /// Compartment B's completion value string.
    pub b_result: String,
    /// The two compartments referenced the same machine intrinsics graph.
    pub shared_intrinsics: bool,
    /// Compartment A's computrons (same bytecode → same as the oracle's
    /// run-only count for a bit-exact program).
    pub a_computrons: u64,
    pub oracle_computrons: u64,
    pub a_halt: ironhorse_vm::Halt,
}

impl CompartmentDualRun {
    /// RESULT agreement (the compartment acceptance bar): the oracle and
    /// BOTH compartments completed with the same completion value, over
    /// one shared intrinsics graph. A completion mismatch or a
    /// cross-compartment disagreement is a divergence, never a silent
    /// pass.
    pub fn result_agrees(&self) -> bool {
        self.oracle_completed
            && self.both_completed
            && self.shared_intrinsics
            && self.a_result == self.oracle_result
            && self.b_result == self.oracle_result
    }

    /// The same bytecode evaluated in a compartment reproduces the
    /// oracle's run-only computron count (stricter telemetry the branch
    /// runner still gates — the compartment evaluator seeds no globals
    /// here, so it is byte-identical to the top-level realm run).
    pub fn computrons_agree(&self) -> bool {
        self.oracle_completed && self.both_completed && self.a_computrons == self.oracle_computrons
    }
}

/// Evaluate `source` in two compartments over one machine's shared
/// intrinsics and compare against the oracle reference. Post stage-6 flip
/// the bytecode/symbols the compartments evaluate come from the **default
/// (ironhorse) compiler** — this was the review ledger's standing residual
/// ("the ironhorse-vm compartment evaluate path still oracle-compiles"), a
/// default execution path that must run ironhorse's own output, not the
/// oracle's. The oracle is still *run* to supply the reference
/// result/computrons the compartments are checked against. Returns `None`
/// only if the oracle machine itself fails to start.
pub fn compartment_dual_run(source: &str) -> Option<CompartmentDualRun> {
    use ironhorse_vm::Machine;

    let oracle = xs_oracle::run(source)?;
    // The compartments run ironhorse's OWN bytecode + symbols (the flipped
    // default), never the oracle's; the oracle stays the reference.
    let (bytecode, symbols, _compile) = compile_for(Compiler::default(), source, &oracle);
    let machine = Machine::new();
    let a = machine.new_compartment();
    let b = machine.new_compartment();
    let shared_intrinsics = std::rc::Rc::ptr_eq(a.intrinsics(), b.intrinsics());

    let ra = a.evaluate_with_symbols(&bytecode, &symbols);
    let rb = b.evaluate_with_symbols(&bytecode, &symbols);

    Some(CompartmentDualRun {
        source: source.to_string(),
        oracle_completed: oracle.completed,
        oracle_result: oracle.result,
        both_completed: ra.completed && rb.completed,
        a_result: ra.result,
        b_result: rb.result,
        shared_intrinsics,
        a_computrons: ra.computrons,
        oracle_computrons: oracle.computrons,
        a_halt: ra.halt,
    })
}

/// A summary over a corpus run.
#[derive(Debug, Default, Clone)]
pub struct Summary {
    pub total: usize,
    pub bit_exact: usize,
    pub result_divergences: usize,
    pub computron_divergences: usize,
    pub completion_divergences: usize,
    pub unsupported: usize,
}

impl Summary {
    pub fn met_bar(&self) -> bool {
        self.total > 0 && self.bit_exact == self.total
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ironhorse_only_run_terminates_on_the_const_for_hang_source() {
        // The three `*-invalid-assignment-next-expression-for.js` cases hang the
        // ORACLE (XS itself loops forever on `for (const i=0; i<1; i++){}`), not
        // ironhorse. `ironhorse_only_run` is the attribution probe: ironhorse
        // must reach a terminal `Halt` on its own — if this test hangs, the
        // premise (ironhorse terminates alone) is false. No oracle involved.
        let halt = ironhorse_only_run("for (const i = 0; i < 1; i++) {}");
        assert!(
            !matches!(halt, Halt::StepLimit(_)),
            "ironhorse should terminate naturally, not by a step ceiling: {halt:?}"
        );
        // A compiler reject/panic is also terminal (empty bytecode → decode).
        let rejected = ironhorse_only_run("for (const {");
        assert!(matches!(
            rejected,
            Halt::Decode(_) | Halt::Return | Halt::Throw(_)
        ));
    }

    #[test]
    fn compiler_seam_endor_matches_oracle_on_byte_identical_programs() {
        // The pipeline seam (stage-5 child 7): running the dual-run through
        // the `Ironhorse` compiler must, on programs whose ironhorse bytecode is
        // byte-identical to the oracle's, execute the *same* bytecode and
        // reach the *same* agreement/result as the default `Oracle` path.
        // This proves the seam actually flips compilers and the ironhorse path
        // runs ironhorse's own output — not a no-op that always uses the oracle.
        let programs = [
            "1 + 2 * 3",
            "if (1) { 2 } else { 3 }",
            "(function(a){ return a + 1 })(4)",
        ];
        for src in programs {
            let oracle = dual_run_with(src, Compiler::Oracle).expect("oracle runs");
            let ironhorse = dual_run_with(src, Compiler::Ironhorse).expect("oracle reference runs");
            // The ironhorse path compiled with ironhorse-compile; its bytes must
            // equal the oracle's (the byte-identity bar) for these programs.
            assert_eq!(
                oracle.bytecode, ironhorse.bytecode,
                "seam: ironhorse-compile bytes must match the oracle's for {src:?}"
            );
            assert_eq!(
                oracle.agreement, ironhorse.agreement,
                "seam: same agreement via either compiler for {src:?}"
            );
            assert_eq!(
                oracle.ironhorse_result, ironhorse.ironhorse_result,
                "seam: same ironhorse result via either compiler for {src:?}"
            );
        }
    }

    #[test]
    fn compiler_seam_endor_fold_is_a_clean_abort_not_a_panic() {
        // A construct the coder folds on must, through the `Ironhorse` seam,
        // produce empty bytecode that ironhorse-vm treats as an abort — never a
        // harness panic. Private member *reads/writes* and the `#x in o`
        // brand check now code byte-identically (this child), so this uses a
        // still-deferred class-tail construct: a `static { … }` block with
        // its own lexical declarations, whose field-function frame
        // reservation is the remaining fold.
        let src = "class C { static { let x = 1; } } new C()";
        let ironhorse = dual_run_with(src, Compiler::Ironhorse).expect("oracle reference runs");
        assert!(
            ironhorse.bytecode.is_empty(),
            "an ironhorse coder fold must yield empty bytecode via the seam"
        );
        assert_ne!(
            ironhorse.agreement,
            Agreement::BothComplete,
            "an empty-bytecode ironhorse run must not spuriously complete like the oracle"
        );
    }

    #[test]
    fn compiler_seam_constructs_unsupported_for_valid_unported_syntax() {
        let source = "import.source('module');";
        let run = dual_run_with(source, Compiler::Ironhorse).expect("oracle reference runs");
        assert!(
            matches!(run.ironhorse_compile, IronhorseCompile::Unsupported(ref message) if message.contains("source-phase import")),
            "the production compiler seam must distinguish valid unported syntax: {:?}",
            run.ironhorse_compile
        );
    }

    /// js-04 helper: a source whose sloppy dual-run must agree with the XS
    /// oracle (BothComplete + observable agreement — a "covered" verdict).
    fn assert_covers_oracle(src: &str) {
        let r = dual_run(src).expect("oracle machine runs");
        assert_eq!(
            r.agreement,
            Agreement::BothComplete,
            "js-04: expected both engines to complete for {src:?} \
             (ironhorse_halt={:?}, ironhorse_result={:?})",
            r.ironhorse_halt,
            r.ironhorse_result,
        );
        assert!(
            r.result_agrees,
            "js-04: expected observable agreement for {src:?} \
             (oracle={:?} ironhorse={:?})",
            r.oracle_result, r.ironhorse_result,
        );
    }

    #[test]
    fn calling_a_non_callable_throws_a_catchable_type_error() {
        // ECMA-262 `Call` (7.3.14): invoking a non-callable is a *catchable*
        // TypeError, not an uncatchable host abort. Before js-04 the callee
        // gate raised `Halt::Throw("call: not a function")`, which `try`/`catch`
        // could not observe; now it raises a realm-correct `TypeError`.
        assert_covers_oracle(
            "var x = {}; var caught = false; \
             try { x(); } catch (e) { caught = e instanceof TypeError; } caught",
        );
        // The same gate fronts `new` on a non-constructable ordinary object.
        assert_covers_oracle(
            "var x = {}; var caught = false; \
             try { new x(); } catch (e) { caught = e instanceof TypeError; } caught",
        );
    }

    #[test]
    fn reading_an_unresolvable_reference_throws_a_catchable_reference_error() {
        // `GetValue` on an unresolvable Reference is a catchable ReferenceError
        // (6.2.5.5 → ResolveBinding). Before js-04 the `get_variable` miss
        // raised an uncatchable `Halt::Throw("get …: undefined variable")`.
        assert_covers_oracle(
            "var ok = false; \
             try { thisGlobalIsNotDefinedXYZ; } catch (e) { ok = e instanceof ReferenceError; } ok",
        );
    }

    #[test]
    fn to_instance_toobject_identity_null_typeerror_and_primitive_box() {
        // `XS_CODE_TO_INSTANCE` (ToObject, 7.1.18), emitted by object
        // destructuring (and the base-class constructor bind / `with`).
        // Object RHS → identity: the own property is read straight through.
        assert_covers_oracle("var { a } = { a: 5 }; a");
        // null / undefined RHS → catchable TypeError.
        assert_covers_oracle(
            "var ok = false; \
             try { var { b } = null; } catch (e) { ok = e instanceof TypeError; } ok",
        );
        assert_covers_oracle(
            "var ok = false; \
             try { var { c } = undefined; } catch (e) { ok = e instanceof TypeError; } ok",
        );
        // A base-class constructor bind (`TO_INSTANCE` on an already-object
        // constructor) also takes the identity arm — exercised end-to-end by
        // the boot-bundle ledger test, which now advances past `to_instance`.
        //
        // The boxed-primitive ToObject arm (string/number destructuring) is a
        // named `to_instance:primitive-box` skip, not covered here: the boxed
        // wrapper's exotic own properties are a later child's surface.
    }

    #[test]
    fn synchronous_iteration_uses_guest_protocol_and_closes_abruptly() {
        assert_covers_oracle(
            "var log = ''; var iterable = { \
               [Symbol.iterator]: function () { return this; }, \
               next: function () { log += 'n'; return { value: 1, done: false }; }, \
               return: function () { log += 'r'; return {}; } \
             }; var value; for (value of iterable) { log += value; break; } log",
        );
        // A lexical/destructuring head is reset to TDZ and initialized again
        // for every iteration (`RESET_LOCAL`), rather than retaining the
        // preceding iteration's value.
        assert_covers_oracle(
            "var values = []; for (let [value] of [[1], [2]]) { values.push(value); } \
             values.join(':')",
        );
    }

    #[test]
    fn generator_return_and_throw_resume_through_finally() {
        assert_covers_oracle(
            "var log = ''; function* g() { try { yield 1; } finally { log += 'f'; } } \
             var iterator = g(); iterator.next(); var result = iterator.return(9); \
             log + ':' + result.value + ':' + result.done",
        );
        assert_covers_oracle(
            "var log = ''; function* g() { try { yield 1; } catch (error) { log += error; } \
             finally { log += 'f'; } } var iterator = g(); iterator.next(); \
             var result = iterator.throw('x'); log + ':' + result.done",
        );
    }

    #[test]
    fn generator_yield_preserves_live_exception_handlers() {
        assert_covers_oracle(
            "function* g() { try { yield 1; throw 2; } catch (error) { yield error + 1; } } \
             var iterator = g(); iterator.next(); iterator.next().value",
        );
        assert_covers_oracle(
            "function* g() { return yield* [1, 2]; } var iterator = g(); \
             iterator.next().value + ':' + iterator.next().value + ':' + iterator.next(7).value",
        );
    }

    // A `DualRun` with the given agreement and ironhorse halt. For a
    // `Halt::Throw`, the oracle is modeled as throwing the same value with
    // the same computrons (the agreeing case), so `is_bit_exact` turns on
    // the halt kind; a non-`Throw` halt never agrees.
    fn abort_run(agreement: Agreement, ironhorse_halt: Halt) -> DualRun {
        let ironhorse_error = match &ironhorse_halt {
            Halt::Throw(s) => s.clone(),
            _ => String::new(),
        };
        let error_agrees = matches!(ironhorse_halt, Halt::Throw(_));
        DualRun {
            source: String::new(),
            agreement,
            result_agrees: false,
            oracle_result: String::new(),
            ironhorse_result: String::new(),
            computrons_agree: false,
            oracle_computrons: 0,
            ironhorse_computrons: 0,
            error_agrees,
            oracle_error: ironhorse_error.clone(),
            ironhorse_error,
            oracle_meter_raw: 0,
            ironhorse_meter_raw: 0,
            ironhorse_dispatched: 0,
            ironhorse_halt,
            ironhorse_compile: IronhorseCompile::NotAttempted,
            bytecode: Vec::new(),
            oracle_parsed: false,
        }
    }

    #[test]
    fn both_abort_bit_exact_only_when_endor_throws() {
        // A matching JS-level throw is a genuine shared abort.
        let throwing = abort_run(Agreement::BothAbort, Halt::Throw("boom".into()));
        assert!(
            throwing.is_bit_exact(),
            "BothAbort with a Throw is bit-exact"
        );

        // An `Unsupported` bail is not agreement even if the oracle also
        // aborted (finding 3): it must never pass silently.
        let unsupported = abort_run(Agreement::BothAbort, Halt::Unsupported("XS_CODE_CALL"));
        assert!(
            !unsupported.is_bit_exact(),
            "BothAbort with an Unsupported halt is not bit-exact"
        );

        // A `Decode` bail (truncated/invalid bytecode) is likewise not
        // agreement.
        let decode = abort_run(Agreement::BothAbort, Halt::Decode("truncated".into()));
        assert!(
            !decode.is_bit_exact(),
            "BothAbort with a Decode halt is not bit-exact"
        );
    }

    #[test]
    fn both_abort_throw_requires_error_and_computron_agreement() {
        // Observation 3: a shared `Throw` abort is bit-exact only when the
        // thrown value AND the computrons match, exactly like the
        // `BothComplete` arm — a matching halt kind alone is not enough.
        let mut r = abort_run(Agreement::BothAbort, Halt::Throw("7".into()));
        r.oracle_computrons = 6;
        r.ironhorse_computrons = 6;
        assert!(r.is_bit_exact(), "matching value + computrons is bit-exact");

        // Divergent thrown value: the oracle threw "8" where ironhorse threw "7".
        let mut wrong_value = r.clone();
        wrong_value.oracle_error = "8".into();
        wrong_value.error_agrees = false;
        assert!(
            !wrong_value.is_bit_exact(),
            "a divergent thrown value is not bit-exact"
        );

        // Divergent computrons on an otherwise-matching throw.
        let mut wrong_cost = r.clone();
        wrong_cost.ironhorse_computrons = 7;
        assert!(
            !wrong_cost.is_bit_exact(),
            "a divergent computron count is not bit-exact"
        );
    }

    #[test]
    fn non_throw_both_abort_is_counted_not_silent() {
        // The summary must count a non-`Throw` `BothAbort` (here under
        // `unsupported`) rather than let it slip through as bit-exact.
        let runs = [
            abort_run(Agreement::BothAbort, Halt::Unsupported("XS_CODE_CALL")),
            abort_run(Agreement::BothAbort, Halt::Decode("truncated".into())),
        ];
        let mut s = Summary::default();
        for r in &runs {
            s.total += 1;
            if r.is_bit_exact() {
                s.bit_exact += 1;
            } else {
                match r.agreement {
                    Agreement::BothComplete => {}
                    Agreement::BothAbort => s.unsupported += 1,
                    _ => s.completion_divergences += 1,
                }
            }
        }
        assert_eq!(s.bit_exact, 0, "neither run may count as bit-exact");
        assert_eq!(s.unsupported, 2, "both non-Throw aborts are counted");
        assert!(!s.met_bar());
    }

    // Arm a fresh ironhorse interpreter on the oracle's bytecode for `src`,
    // recording every computron value the meter host is consulted at and
    // whether the run was allowed to complete (`allow`) or refused at the
    // `refuse_at`-th consultation (1-based; 0 = never refuse). Returns
    // `(halt, completed, consulted_computrons)`.
    fn metered_run(
        src: &str,
        interval: u64,
        refuse_at: usize,
    ) -> (ironhorse_vm::Halt, bool, Vec<u64>) {
        use ironhorse_vm::Interp;
        use std::cell::RefCell;
        use std::rc::Rc;
        let oracle = xs_oracle::run(src).expect("oracle machine");
        let seen = Rc::new(RefCell::new(Vec::new()));
        let seen_cb = Rc::clone(&seen);
        let mut interp = Interp::new();
        interp.arm_meter(
            interval,
            Box::new(move |computrons| {
                let mut s = seen_cb.borrow_mut();
                s.push(computrons);
                refuse_at == 0 || s.len() < refuse_at
            }),
        );
        let out = interp.run(&oracle.bytecode);
        let consulted = seen.borrow().clone();
        (out.halt, out.completed, consulted)
    }

    #[test]
    fn no_meter_check_when_program_returns_to_c() {
        // A straight-line program (no backward branch, no call) has no
        // loop-closing point, so XS never checks the meter — its `return`
        // exits to the C caller unconditionally. An ironhorse armed to refuse
        // immediately therefore still *completes*: the host is never
        // consulted, proving the exit-to-C `return` carries no
        // `mxFirstCode` check (stage-2a review finding 1).
        let (halt, completed, consulted) = metered_run("1 + 2 * 3", 1, 1);
        assert_eq!(
            halt,
            ironhorse_vm::Halt::Return,
            "must complete: no check point"
        );
        assert!(completed);
        assert!(
            consulted.is_empty(),
            "the exit-to-C return must not check the meter"
        );
    }

    #[test]
    fn meter_checks_fire_at_call_entry_and_return_into_js() {
        // A single user-function call has exactly two `mxFirstCode` check
        // points: call entry (`run` installing the callee frame) and the
        // callee's `end` returning into the JS program frame. The
        // program's own final `return` (exit to C) does not check. So a
        // permissive armed run is consulted exactly twice and completes.
        let (halt, completed, consulted) = metered_run("(function(){return 1})()", 1, 0);
        assert_eq!(halt, ironhorse_vm::Halt::Return);
        assert!(completed);
        assert_eq!(
            consulted.len(),
            2,
            "call entry + return-into-JS check; the exit-to-C return does not check (got {:?})",
            consulted,
        );
    }

    #[test]
    fn armed_meter_aborts_at_call_entry_not_at_program_exit() {
        // Refusing at the first consultation (the call-entry `mxFirstCode`)
        // aborts the crank there — before the callee body's completion is
        // observed — rather than letting the program run to its exit-to-C
        // `return`. This is the abort-point determinism the check-placement
        // fix exists to guarantee.
        let (halt, completed, consulted) = metered_run("(function(){return 1})()", 1, 1);
        assert_eq!(
            halt,
            ironhorse_vm::Halt::MeterAbort,
            "must abort at the call-entry check"
        );
        assert!(
            !completed,
            "the call must not complete once refused at entry"
        );
        assert_eq!(
            consulted.len(),
            1,
            "aborts on the first (call-entry) consultation"
        );
    }

    #[test]
    fn armed_meter_aborts_at_backward_branch_in_a_loop() {
        // A loop's backward branch is a check point (as in stage 2a); a
        // function body containing a loop still aborts there under an armed
        // meter, never at the function's `end` exit or the program
        // `return`.
        let src = "var i=0; while(i<1000000){i=i+1} i";
        let (halt, completed, _consulted) = metered_run(src, 1, 3);
        assert_eq!(
            halt,
            ironhorse_vm::Halt::MeterAbort,
            "the backward branch must abort"
        );
        assert!(!completed);
    }

    #[test]
    fn uncaught_throw_is_a_bit_exact_shared_abort() {
        // Behavioural spot-check decoupled from the corpus: an uncaught
        // throw is a shared abort whose thrown-value string and run-only
        // computron count both match the oracle (the host-escape metering
        // and the shim's abort-path computron capture together make the
        // shared-abort arm bit-exact, not merely "ironhorse also threw").
        let r = dual_run("throw 7").expect("oracle");
        assert_eq!(r.agreement, Agreement::BothAbort);
        assert_eq!(r.ironhorse_error, "7");
        assert_eq!(r.oracle_error, "7");
        assert_eq!(
            r.oracle_computrons, r.ironhorse_computrons,
            "uncaught-throw computrons agree"
        );
        assert!(r.is_bit_exact(), "an agreeing uncaught throw is bit-exact");

        // A caught throw completes; its result and computrons agree.
        let c = dual_run("try { throw 7 } catch (e) { e + 1 }").expect("oracle");
        assert_eq!(c.agreement, Agreement::BothComplete);
        assert_eq!(c.ironhorse_result, "8");
        assert!(c.is_bit_exact());
    }

    #[test]
    fn closure_mutation_persists_and_activations_do_not_alias() {
        // Behavioural spot-checks decoupled from metering: a counter
        // closure's cell mutates across calls, and two counters built from
        // separate activations of the same factory keep independent cells.
        let one = dual_run(
            "var mk=function(){var c=0; return function(){c=c+1; return c}}; var f=mk(); f(); f()",
        )
        .expect("oracle");
        assert_eq!(
            one.ironhorse_result, "2",
            "the shared cell mutates across calls"
        );
        assert_eq!(one.oracle_result, "2");

        let two = dual_run(
            "var mk=function(){var n=0; return function(){return n=n+1}}; var a=mk(),b=mk(); a(); a(); b()",
        )
        .expect("oracle");
        assert_eq!(two.ironhorse_result, "1", "b's cell is independent of a's");
        assert_eq!(two.oracle_result, "1");
    }

    #[test]
    fn bound_function_in_call_apply_position_self_names_never_diverges() {
        // The loaded gun (`FuncInfo::default().body_start = 0`): a bound
        // function reshaped through `.call`/`.apply` used to dispatch at pc 0
        // — a SILENT completion divergence (never an abort, so worse than a
        // crash for the never-a-wrong-value invariant). Exactness is not
        // affordable now (the correct trampoline stacks the `.call`/`.apply`
        // re-dispatch onto the bound re-dispatch, two calibrated overheads),
        // so each must self-name `Halt::Unsupported("bind:bound-callback")` —
        // an honest skip, never a wrong value and never a dispatch at pc 0.
        let programs = [
            "var b=function(v){return v;}.bind(null); b.call(null)",
            "var b=function(v){return 7;}.bind(null); b.apply(null,[])",
            "function s(a,b){return a+b} var b=s.bind(null,1); b.call(null,2)",
            "function s(a,b){return a+b} var b=s.bind(null,1); b.apply(null,[2])",
        ];
        for p in programs {
            let r = dual_run(p).expect("oracle machine available");
            assert!(
                matches!(&r.ironhorse_halt, Halt::Unsupported(name) if *name == "bind:bound-callback"),
                "{p:?}: expected an honest bind:bound-callback skip (no abort, no wrong value), got halt={:?} result_agrees={} computrons_agree={}",
                r.ironhorse_halt, r.result_agrees, r.computrons_agree,
            );
        }
    }

    #[test]
    fn stage4_daemon_boot_bundle_never_diverges_and_names_its_gaps() {
        // The stage-4 closure boot-bundle bar (child 5/5; design
        // `daemon-endor-architecture.md` § Unified runner). Dual-run the
        // COMMITTED daemon boot-bundle sources (`polyfills.js`,
        // `host_aliases.js`, and the boot prefix as the daemon evaluates it)
        // against the pin. **Result agreement is the bar** — but the doctrine
        // (accuracy over parity) is what this test actually enforces: ironhorse
        // must NEVER complete a boot-bundle program with a wrong value or
        // accept one the pin rejects. Every program either agrees with the
        // pin or aborts with a SELF-NAMED halt.
        //
        // Verdict at this closure point: the committed bundle still does
        // **not** run identically on ironhorse — but the `globalThis` binding it
        // reads first has now LANDED (stage-7 child 1: a live global-object
        // binding), so every bundle advances PAST that read and stops at the
        // next real post-stage-4 engine gap: `polyfills.js` and the boot
        // prefix at the `to_instance` surface, `host_aliases.js` at the
        // computed-`at` property surface. Each remains a **named, ledgered
        // engine gap** (the downstream gaps the bundle would keep hitting —
        // `Reflect`, typed-array-from-iterable, symbol-keyed `defineProperty`,
        // class-instance construction — enumerated in the README stage-4
        // evidence block and reported to s10), NOT a divergence: ironhorse never
        // lies about the boot bundle, it honestly declines it. This test is
        // the regression guard on that safety property AND the ledger anchor
        // that advances as each successive gap lands.
        let bundles = daemon_boot_bundle_sources();
        assert!(!bundles.is_empty(), "boot-bundle sources must be present");
        let mut divergences = Vec::new();
        let mut gaps = std::collections::BTreeMap::new();
        let mut agree = 0usize;
        for (label, src) in &bundles {
            match boot_bundle_verdict(src) {
                BootVerdict::Agrees => {
                    eprintln!("boot-bundle {label}: AGREES with the pin");
                    agree += 1;
                }
                BootVerdict::NamedGap(key) => {
                    eprintln!("boot-bundle {label}: named gap `{key}`");
                    *gaps.entry(key).or_insert(0usize) += 1;
                }
                BootVerdict::Divergent(detail) => {
                    divergences.push(format!("{label}: {detail}"));
                }
            }
        }
        eprintln!(
            "boot-bundle verdict: {}/{} agree; named gaps: {:?}",
            agree,
            bundles.len(),
            gaps
        );
        // (1) The bar: ironhorse never diverges on a boot-bundle program.
        assert!(
            divergences.is_empty(),
            "boot-bundle divergence(s) forbidden by the accuracy-over-parity doctrine: {divergences:?}"
        );
        // (2) The ledger anchor, ADVANCED (stage-7 child 1): the `globalThis`
        // global-object binding now LANDS, so no committed bundle stops at that
        // gap any more — each advances past its first `globalThis` read to the
        // next real post-stage-4 engine gap. Those gaps stay honest, self-named
        // `Halt::Unsupported` aborts (never divergences, per assertion (1)):
        // `host_aliases.js` reaches the computed-`at` property surface. The
        // `to_instance` (ToObject) surface `polyfills.js` and the boot prefix
        // used to stop at LANDED (js-04 functions/constructors/base-classes),
        // then at the `class` opcode. Class definition now lands too, so the
        // remaining two probes reach the same computed-`at` surface.
        assert_eq!(
            gaps.get("boot:no-globalThis-global-object-binding")
                .copied(),
            None,
            "the `globalThis` global-object binding landed (stage-7 child 1); no committed \
             bundle should still stop at that gap, but got {gaps:?}"
        );
        assert_eq!(
            gaps.get("boot:unsupported:to_instance").copied(),
            None,
            "the `to_instance` (ToObject) surface landed (js-04); no committed bundle should \
             still stop at that gap, but got {gaps:?}"
        );
        let expected_gaps: std::collections::BTreeMap<String, usize> =
            [("boot:unsupported:at".to_string(), 2usize)]
                .into_iter()
                .collect();
        assert_eq!(
            gaps, expected_gaps,
            "expected the committed boot bundles to stop at the advanced gap \
             (2× at); got {gaps:?} (if a gap closed, advance the ledger)"
        );
    }

    #[test]
    fn compartments_isolate_their_own_globals_against_a_seeded_value() {
        // Global separation, differential against the oracle's notion of a
        // value: seed the SAME global id with a different value in each of
        // two compartments over one machine, evaluate the exact bytecode the
        // oracle emits for a program that reads that global, and confirm each
        // compartment renders ITS OWN binding — matching the oracle's
        // `String()` of that value, and diverging between the compartments.
        use ironhorse_vm::{Machine, Slot};

        // The oracle compiles `x` (a lone global reference) to the read-global
        // bytecode; we seed `x`'s program-local id per compartment. Two
        // literals whose `String()` the oracle certifies:
        let one = xs_oracle::run("String(11)").expect("oracle");
        let two = xs_oracle::run("String(22)").expect("oracle");
        assert_eq!(one.result, "11");
        assert_eq!(two.result, "22");

        // The read-global program addresses the global by its symbol id; we
        // reuse the compartment unit-test shape via the public seam.
        let read_x = {
            use ironhorse_vm::Opcode;
            let [lo, hi] = 7u16.to_le_bytes();
            vec![
                Opcode::XS_CODE_EVAL_REFERENCE as u8,
                lo,
                hi,
                Opcode::XS_CODE_GET_VARIABLE as u8,
                lo,
                hi,
                Opcode::XS_CODE_SET_RESULT as u8,
                Opcode::XS_CODE_END as u8,
            ]
        };

        let machine = Machine::new();
        let mut a = machine.new_compartment();
        let mut b = machine.new_compartment();
        a.define_global_id(7, Slot::integer(11));
        b.define_global_id(7, Slot::integer(22));
        let ra = a.evaluate(&read_x);
        let rb = b.evaluate(&read_x);
        assert!(ra.completed && rb.completed);
        // Each compartment observes its own global, matching the oracle's
        // `String()` of that value...
        assert_eq!(ra.result, one.result, "compartment A sees its own 11");
        assert_eq!(rb.result, two.result, "compartment B sees its own 22");
        // ...and the two compartments diverge over one shared intrinsics graph.
        assert_ne!(ra.result, rb.result);
        assert!(std::rc::Rc::ptr_eq(a.intrinsics(), b.intrinsics()));
    }

    #[test]
    fn utf16_meter_expectations_are_the_frozen_recalibrated_costs() {
        // The frozen recalibrated UTF-16 computron costs (the build's re-based
        // string metering), asserted against ironhorse DIRECTLY — NOT back-fitted
        // to the pin's CESU-8 byte length nor to the oracle. This locks the
        // per-release determinism of the meter: these numbers are ironhorse's own
        // UTF-16 cost and must not drift silently. Where a value differs from
        // the pin it is noted; the pin equality is neither required nor checked
        // here. If a legitimate metering change moves one, update it here
        // deliberately (that is the point of a frozen expectation).
        let cases: &[(&str, u64)] = &[
            // scalar reads that meter the same as CESU-8 for this content
            (r#""𝒜".length"#, 9),
            (r#""a𝒜b".codePointAt(1)"#, 13),
            (r#"[..."a𝒜b"].length"#, 93),
            // multi-unit cases whose cost is re-based off code-unit length
            // (these differ from the pin — the recalibration witnesses):
            (
                r#"var s0 = "a𝒜b"; var t0 = 0; for (var i = 0; i < s0.length; i++) { t0 += s0.charCodeAt(i); } t0"#,
                159,
            ),
            (
                r#"var s="";for(var i=0;i<3;i++){s=s.concat("𝒜")};s.length"#,
                105,
            ),
            (r#""a𝒜b".slice(1, 2).charCodeAt(0)"#, 19),
        ];
        for (src, expected) in cases {
            let oracle = xs_oracle::run(src).expect("oracle compiles the program");
            let a = run_program_with_symbols(&oracle.bytecode, &oracle.symbols);
            let b = run_program_with_symbols(&oracle.bytecode, &oracle.symbols);
            assert!(
                a.completed,
                "ironhorse completes {src:?} (halt={:?})",
                a.halt
            );
            assert_eq!(
                a.computrons, b.computrons,
                "determinism-per-release for {src:?}"
            );
            assert_eq!(
                a.computrons, *expected,
                "frozen UTF-16 computron cost for {src:?} (ironhorse's recalibrated value)",
            );
        }
    }
}
