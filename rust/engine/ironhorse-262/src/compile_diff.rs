//! The full-corpus **byte-identity differential harness** (stage-5 child
//! 7/7, the STAGE BAR). For every source in the conformance corpus, where
//! the XS oracle compiler *accepts* the file, this asserts that
//! `ironhorse_compile::compile(source)` equals `xs_oracle::run(source).bytecode`
//! **byte for byte** — XS's coder is the ground truth (design § roadmap
//! row 5; Design Decisions 4 and 5).
//!
//! **Stage bar** (design § Feasibility Verdict): `divergent == 0` *and*
//! accept/reject agreement, over the full corpus. A byte divergence on a
//! program both engines accept is the KILL CRITERION signal — it is never
//! skipped or hidden; every one is reported with a NAMED class and its
//! source identity so the supervisor can adjudicate.
//!
//! Panic discipline: the coder still `panic!`s on constructs outside the
//! ported surface (a loud fold, not a silent skip). The harness must be
//! total over arbitrary corpus input, so every `compile` call runs under
//! [`std::panic::catch_unwind`] with the process panic hook silenced for
//! the batch; a caught panic classifies as an `ironhorse-rejected` (coder
//! fold), never a harness abort. An oracle machine-startup failure
//! (`run` returns `None`) is the named `oracle-unavailable` outcome, also
//! not an abort.

use std::collections::BTreeMap;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};

/// How one source classified under the compile differential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompileVerdict {
    /// Both engines accept and the bytes are byte-identical (the bar).
    Identical,
    /// Both engines accept but the bytes differ — a KILL-CRITERION
    /// divergence. Carries the named class and a triage detail.
    Divergent { class: String, detail: String },
    /// The oracle rejected the source (a `SyntaxError` at parse). Bytes
    /// are not compared; accept/reject agreement is still checked.
    OracleRejected,
    /// The oracle accepted but ironhorse did not — a structured parse/scope
    /// rejection or a coder panic (the ported-surface fold). A bar
    /// violation (accept/reject disagreement); carries why.
    IronhorseRejected { detail: String },
    /// ironhorse accepted where the oracle rejected — the benign accept/reject
    /// disagreement direction, recorded, still a bar violation.
    OracleRejectedIronhorseAccepted,
    /// The oracle machine failed to start (`run` returned `None`) — not a
    /// finding, skipped from the ratio.
    OracleUnavailable,
}

/// The tally over a corpus, honest about every class (design § the honest
/// covered/skipped split, applied to bytes).
#[derive(Debug, Default, Clone)]
pub struct CompileReport {
    /// Programs classified (excludes `oracle-unavailable`).
    pub total: usize,
    pub identical: usize,
    pub divergent: usize,
    pub oracle_rejected: usize,
    pub ironhorse_rejected: usize,
    pub accept_disagreements: usize,
    pub oracle_unavailable: usize,
    /// Named divergence classes → count (byte-mismatch cases only).
    pub divergence_classes: BTreeMap<String, usize>,
    /// Per-item byte divergences: `(id, class, detail)`.
    pub divergences: Vec<(String, String, String)>,
    /// Per-item ironhorse rejections where the oracle accepted: `(id, why)`.
    pub ironhorse_rejections: Vec<(String, String)>,
    /// Per-item ironhorse-only accepts (oracle rejected): `(id, note)`.
    pub ironhorse_only_accepts: Vec<(String, String)>,
}

impl CompileReport {
    /// The stage bar: zero byte divergence AND full accept/reject
    /// agreement (no ironhorse-rejected, no ironhorse-only-accept) over every
    /// classified program.
    pub fn met_bar(&self) -> bool {
        self.divergent == 0 && self.ironhorse_rejected == 0 && self.accept_disagreements == 0
    }

    fn record(&mut self, id: &str, verdict: CompileVerdict) {
        match verdict {
            CompileVerdict::OracleUnavailable => {
                self.oracle_unavailable += 1;
                return;
            }
            _ => self.total += 1,
        }
        match verdict {
            CompileVerdict::Identical => self.identical += 1,
            CompileVerdict::Divergent { class, detail } => {
                self.divergent += 1;
                *self.divergence_classes.entry(class.clone()).or_default() += 1;
                self.divergences.push((id.to_string(), class, detail));
            }
            CompileVerdict::OracleRejected => self.oracle_rejected += 1,
            CompileVerdict::IronhorseRejected { detail } => {
                self.ironhorse_rejected += 1;
                self.ironhorse_rejections.push((id.to_string(), detail));
            }
            CompileVerdict::OracleRejectedIronhorseAccepted => {
                self.accept_disagreements += 1;
                self.ironhorse_only_accepts.push((
                    id.to_string(),
                    "ironhorse accepted; oracle rejected".to_string(),
                ));
            }
            CompileVerdict::OracleUnavailable => unreachable!(),
        }
    }
}

/// Whether the oracle *parsed* `source` (accepted it), returning the exact
/// XS bytecode on accept. `None` = machine startup failure (unavailable).
/// A runtime throw (e.g. a `ReferenceError` from an unbound global) still
/// counts as parsed — the bytecode was emitted.
fn oracle_compile(source: &str) -> Option<(bool, Vec<u8>)> {
    let o = xs_oracle::run(source)?;
    if o.completed {
        return Some((true, o.bytecode));
    }
    // An uncompleted run is a parse rejection only if the error is a
    // SyntaxError; any other error is a runtime throw of a parsed program.
    let parsed = !o.error.contains("SyntaxError");
    Some((parsed, o.bytecode))
}

/// Whether the oracle *compiled* `source` as a **Module** (accepted it),
/// returning the exact XS module bytecode on accept. `None` = machine
/// startup failure (unavailable); `Some((false, _))` = a `SyntaxError`.
fn oracle_compile_module(source: &str) -> Option<(bool, Vec<u8>)> {
    let o = xs_oracle::compile_module(source)?;
    Some((o.compiled, o.bytecode))
}

/// ironhorse's **Module** compile verdict for `source`, total over panics —
/// the module counterpart of [`ironhorse_compile`].
fn ironhorse_compile_module(source: &str) -> Result<Result<Vec<u8>, String>, String> {
    let caught = panic::catch_unwind(AssertUnwindSafe(|| {
        ironhorse_compile::compile_module(source)
    }));
    match caught {
        Ok(Ok(bytes)) => Ok(Ok(bytes)),
        Ok(Err(e)) => Ok(Err(format!("{:?}", e))),
        Err(payload) => Err(panic_message(payload)),
    }
}

/// ironhorse's compile verdict for `source`, total over panics. `Ok(Ok(bytes))`
/// = accepted; `Ok(Err(reason))` = structured rejection; `Err(reason)` =
/// coder panic (the ported-surface fold). The caller silences the panic
/// hook for the batch.
fn ironhorse_compile(source: &str) -> Result<Result<Vec<u8>, String>, String> {
    let caught = panic::catch_unwind(AssertUnwindSafe(|| ironhorse_compile::compile(source)));
    match caught {
        Ok(Ok(bytes)) => Ok(Ok(bytes)),
        Ok(Err(e)) => Ok(Err(format!("{:?}", e))),
        Err(payload) => Err(panic_message(payload)),
    }
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "coder panic (opaque payload)".to_string()
    }
}

/// Name the divergence class for a byte mismatch on a both-accept program.
/// Classes are coarse but named — the triage detail carries the exact
/// offset and bytes.
fn classify_divergence(oracle: &[u8], ironhorse: &[u8]) -> (String, String) {
    if oracle.len() != ironhorse.len() {
        let class = if ironhorse.len() < oracle.len() {
            "byte-length/ironhorse-shorter"
        } else {
            "byte-length/ironhorse-longer"
        };
        // Still locate the first divergence for triage.
        let first = first_diff(oracle, ironhorse);
        let detail = match first {
            Some(i) => format!(
                "len oracle={} ironhorse={}; first diff @{} oracle=0x{:02x} ironhorse=0x{:02x}",
                oracle.len(),
                ironhorse.len(),
                i,
                oracle.get(i).copied().unwrap_or(0),
                ironhorse.get(i).copied().unwrap_or(0),
            ),
            None => format!(
                "len oracle={} ironhorse={}; common prefix identical",
                oracle.len(),
                ironhorse.len()
            ),
        };
        (class.to_string(), detail)
    } else {
        let i = first_diff(oracle, ironhorse).unwrap_or(0);
        let class = format!(
            "opcode-mismatch@byte0x{:02x}",
            oracle.get(i).copied().unwrap_or(0)
        );
        let detail = format!(
            "same len {}; first diff @{} oracle=0x{:02x} ironhorse=0x{:02x}",
            oracle.len(),
            i,
            oracle.get(i).copied().unwrap_or(0),
            ironhorse.get(i).copied().unwrap_or(0),
        );
        (class, detail)
    }
}

fn first_diff(a: &[u8], b: &[u8]) -> Option<usize> {
    let n = a.len().min(b.len());
    (0..n)
        .find(|&i| a[i] != b[i])
        .or(if a.len() == b.len() { None } else { Some(n) })
}

/// Classify one `(id, source)` under the compile differential.
pub fn compile_one(source: &str) -> CompileVerdict {
    let (oracle_accepts, oracle_bytes) = match oracle_compile(source) {
        Some(v) => v,
        None => return CompileVerdict::OracleUnavailable,
    };
    let ironhorse = ironhorse_compile(source);
    let ironhorse_accepts = matches!(ironhorse, Ok(Ok(_)));

    // A **runtime** `SyntaxError` thrown by a *compiled* program is not a
    // compile rejection. A direct or indirect `eval` whose body fails
    // `EvalDeclarationInstantiation` (a `var`/lexical collision) or fails to
    // parse throws `SyntaxError` at run time — after XS has already emitted the
    // outer program's bytecode. The oracle path runs the program (`run`), so
    // `oracle_compile` sees the throw and, unable to know its phase,
    // conservatively reads any `SyntaxError` as a parse reject. Recover the
    // truth with positive evidence: if ironhorse compiled `source` to bytecode
    // byte-identical to XS's, both engines parsed AND coded it the same, so the
    // oracle's `SyntaxError` was necessarily post-compilation (runtime), and
    // this is the byte-clean compile ACCEPT it is. This can never mask a
    // genuine parse rejection — there ironhorse either rejects or produces
    // different bytes, so the exact-match guard fails and the normal
    // classification below applies. (The module goal — `compile_one_module` —
    // uses `compile_module`, a parse+code path with no run, so it needs no
    // such recovery.)
    if !oracle_accepts && !oracle_bytes.is_empty() {
        if let Ok(Ok(ironhorse_bytes)) = &ironhorse {
            if *ironhorse_bytes == oracle_bytes {
                return CompileVerdict::Identical;
            }
        }
    }

    match (oracle_accepts, ironhorse_accepts) {
        (true, true) => {
            let ironhorse_bytes = match ironhorse {
                Ok(Ok(b)) => b,
                _ => unreachable!(),
            };
            if ironhorse_bytes == oracle_bytes {
                CompileVerdict::Identical
            } else {
                let (class, detail) = classify_divergence(&oracle_bytes, &ironhorse_bytes);
                CompileVerdict::Divergent { class, detail }
            }
        }
        (true, false) => {
            let detail = match ironhorse {
                Ok(Err(e)) => format!("parse/scope reject: {}", e),
                Err(p) => format!("coder panic: {}", p),
                _ => unreachable!(),
            };
            CompileVerdict::IronhorseRejected { detail }
        }
        (false, true) => CompileVerdict::OracleRejectedIronhorseAccepted,
        (false, false) => CompileVerdict::OracleRejected,
    }
}

/// Classify one `(id, source)` under the **Module** compile differential —
/// the module-goal counterpart of [`compile_one`], comparing
/// `ironhorse_compile::compile_module` against `xs_oracle::compile_module`
/// (parse + code, no run) byte for byte.
pub fn compile_one_module(source: &str) -> CompileVerdict {
    let (oracle_accepts, oracle_bytes) = match oracle_compile_module(source) {
        Some(v) => v,
        None => return CompileVerdict::OracleUnavailable,
    };
    let ironhorse = ironhorse_compile_module(source);
    let ironhorse_accepts = matches!(ironhorse, Ok(Ok(_)));

    match (oracle_accepts, ironhorse_accepts) {
        (true, true) => {
            let ironhorse_bytes = match ironhorse {
                Ok(Ok(b)) => b,
                _ => unreachable!(),
            };
            if ironhorse_bytes == oracle_bytes {
                CompileVerdict::Identical
            } else {
                let (class, detail) = classify_divergence(&oracle_bytes, &ironhorse_bytes);
                CompileVerdict::Divergent { class, detail }
            }
        }
        (true, false) => {
            let detail = match ironhorse {
                Ok(Err(e)) => format!("module parse/scope reject: {}", e),
                Err(p) => format!("module coder panic: {}", p),
                _ => unreachable!(),
            };
            CompileVerdict::IronhorseRejected { detail }
        }
        (false, true) => CompileVerdict::OracleRejectedIronhorseAccepted,
        (false, false) => CompileVerdict::OracleRejected,
    }
}

/// Run the **Module** compile differential over an explicit list of `(id,
/// source)` module programs, silencing the panic hook for the batch.
pub fn module_compile_diff_programs(programs: &[(String, String)]) -> CompileReport {
    let prev_hook = panic::take_hook();
    panic::set_hook(Box::new(|_| {}));
    let mut report = CompileReport::default();
    for (id, source) in programs {
        report.record(id, compile_one_module(source));
    }
    panic::set_hook(prev_hook);
    report
}

/// The curated **module** corpus (`ironhorse-262/corpora-modules/*.js`) as
/// `(id, source)` pairs. Unlike the script corpora (one program per line),
/// each file holds one or more whole *module* programs separated by a line
/// that is exactly `// ---` (a module spans multiple lines and its
/// `import`/`export` declarations are goal-sensitive), so the file is read
/// as a delimiter-split sequence, not line by line.
pub fn module_corpora_programs() -> Vec<(String, String)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("corpora-modules");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().map(|x| x == "js").unwrap_or(false))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    let mut out = Vec::new();
    for file in &files {
        let name = file
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let contents = match std::fs::read_to_string(file) {
            Ok(c) => c,
            Err(_) => continue,
        };
        // Split the file into module chunks on `// ---` delimiter lines.
        let mut chunks: Vec<String> = Vec::new();
        let mut current = String::new();
        for line in contents.lines() {
            if line.trim() == "// ---" {
                chunks.push(std::mem::take(&mut current));
            } else {
                current.push_str(line);
                current.push('\n');
            }
        }
        chunks.push(current);
        let mut n = 0usize;
        for chunk in chunks {
            if chunk.trim().is_empty() {
                continue;
            }
            n += 1;
            out.push((format!("{}#{}", name, n), chunk));
        }
    }
    out
}

/// Run the compile differential over an explicit list of `(id, source)`
/// programs. Silences the panic hook for the batch so a coder fold does
/// not spew to stderr per program (each is still counted and named).
pub fn compile_diff_programs(programs: &[(String, String)]) -> CompileReport {
    let prev_hook = panic::take_hook();
    panic::set_hook(Box::new(|_| {}));
    let mut report = CompileReport::default();
    for (id, source) in programs {
        let verdict = compile_one(source);
        report.record(id, verdict);
    }
    panic::set_hook(prev_hook);
    report
}

/// Run the compile differential over a list of source *files*, compiling
/// each file's whole source as one program (the file is the corpus unit).
pub fn compile_diff_files(files: &[PathBuf]) -> CompileReport {
    let programs: Vec<(String, String)> = files
        .iter()
        .filter_map(|p| {
            std::fs::read_to_string(p)
                .ok()
                .map(|s| (p.display().to_string(), s))
        })
        .collect();
    compile_diff_programs(&programs)
}

/// The curated conformance-case programs as `(id, source)` pairs — the
/// bounded, known-covered byte-identity slice the in-crate `cargo test` gate
/// drives. The `corpora/*.js` line files these once came from retired into
/// the shared test262 tree under `test/ironhorse/` (design § Part 1); every converted case preserves its
/// original one-line program verbatim in an `info: Source: <program>`
/// frontmatter line, so the byte-identity gate reads the *same* programs from
/// the surviving cases with no change to what it covers.
pub fn corpora_programs() -> Vec<(String, String)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/test262-runner/test262/test/ironhorse");
    let mut files = crate::test262::collect_js(&dir);
    files.sort();
    let mut out = Vec::new();
    for file in &files {
        let contents = match std::fs::read_to_string(file) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if let Some(source) = case_source_line(&contents) {
            let id = file
                .strip_prefix(&dir)
                .unwrap_or(file)
                .to_string_lossy()
                .into_owned();
            out.push((id, source));
        }
    }
    out
}

/// The original corpus program a converted case preserves in its
/// `info: Source: <program>` frontmatter line (written by the `corpus-to-262`
/// converter). Returns `None` for a case without that line.
fn case_source_line(contents: &str) -> Option<String> {
    contents
        .lines()
        .find_map(|l| l.strip_prefix("  Source: ").map(|s| s.to_string()))
}

// ==================== symbols-atom byte identity ======================
//
// Stage-6 child 1 flips the dual-run default to `ironhorse-compile`, which now
// emits its OWN symbols atom instead of borrowing the oracle's. That atom
// must be byte-identical to the oracle's `SYMB` payload — the same
// guarantee the bytecode has, extended to the second half of the script.
// This is the committed, repeatable gate proving it, over the same curated
// corpus the bytecode gate uses.

/// The symbols-atom differential tally: how many both-accept programs had a
/// byte-identical SYMB atom, and every divergence with its triage detail.
#[derive(Debug, Default, Clone)]
pub struct SymbolsReport {
    /// Programs where both engines accepted and the atoms were compared.
    pub checked: usize,
    /// Of those, how many atoms were byte-identical.
    pub identical: usize,
    /// Byte-divergent atoms: `(id, detail)`.
    pub divergent: Vec<(String, String)>,
    /// Programs skipped from the atom comparison (oracle rejected, or ironhorse
    /// folded — the bytecode gate already owns those axes).
    pub skipped: usize,
}

impl SymbolsReport {
    /// The bar: zero symbols-atom divergence over every both-accept program.
    pub fn met_bar(&self) -> bool {
        self.divergent.is_empty()
    }
}

/// The oracle's `(parsed, symbols)` for `source` — the SYMB atom XS emits
/// alongside the bytecode. `None` = machine startup failure. Mirrors
/// [`oracle_compile`]'s accept test (a runtime throw still parsed).
fn oracle_symbols(source: &str) -> Option<(bool, Vec<u8>)> {
    let o = xs_oracle::run(source)?;
    if o.completed {
        return Some((true, o.symbols));
    }
    let parsed = !o.error.contains("SyntaxError");
    Some((parsed, o.symbols))
}

/// Compare ironhorse's emitted symbols atom to the oracle's, byte for byte, on
/// every program in `programs` where both engines accept. The bytecode gate
/// ([`compile_diff_programs`]) owns accept/reject and byte-of-code identity;
/// this layers the SYMB-atom identity the flipped default depends on.
/// Silences the panic hook for the batch so a coder fold is a skip, not a
/// stderr spew.
pub fn symbols_diff_programs(programs: &[(String, String)]) -> SymbolsReport {
    let prev_hook = panic::take_hook();
    panic::set_hook(Box::new(|_| {}));
    let mut report = SymbolsReport::default();
    for (id, source) in programs {
        let (oracle_parsed, oracle_syms) = match oracle_symbols(source) {
            Some(v) => v,
            None => {
                report.skipped += 1;
                continue;
            }
        };
        let ironhorse = panic::catch_unwind(AssertUnwindSafe(|| {
            ironhorse_compile::compile_atoms(source)
        }));
        let ironhorse_syms = match ironhorse {
            Ok(Ok((_, syms))) => syms,
            // ironhorse folded or rejected: the bytecode gate covers accept/reject
            // disagreement; nothing to compare here.
            _ => {
                report.skipped += 1;
                continue;
            }
        };
        // Recover the runtime-SyntaxError case exactly as `compile_one` does:
        // if the oracle "rejected" only because a compiled program threw at
        // runtime, its emitted SYMB is still the reference. We compare when
        // the oracle produced any atom (it always emits at least the 2-byte
        // count) and ironhorse accepted; a genuine parse reject yields no ironhorse
        // acceptance, so it was skipped above.
        if !oracle_parsed && oracle_syms.is_empty() {
            report.skipped += 1;
            continue;
        }
        report.checked += 1;
        if ironhorse_syms == oracle_syms {
            report.identical += 1;
        } else {
            let detail = symbols_divergence_detail(&oracle_syms, &ironhorse_syms);
            report.divergent.push((id.clone(), detail));
        }
    }
    panic::set_hook(prev_hook);
    report
}

/// A triage line for a SYMB-atom mismatch: lengths and the first differing
/// byte.
fn symbols_divergence_detail(oracle: &[u8], ironhorse: &[u8]) -> String {
    match first_diff(oracle, ironhorse) {
        Some(i) => format!(
            "len oracle={} ironhorse={}; first diff @{} oracle=0x{:02x} ironhorse=0x{:02x}",
            oracle.len(),
            ironhorse.len(),
            i,
            oracle.get(i).copied().unwrap_or(0),
            ironhorse.get(i).copied().unwrap_or(0),
        ),
        None => format!(
            "len oracle={} ironhorse={}; common prefix identical",
            oracle.len(),
            ironhorse.len()
        ),
    }
}

/// Pretty-print a [`SymbolsReport`] to a writer (the binary and the test
/// share this).
pub fn print_symbols_report(
    w: &mut dyn std::io::Write,
    report: &SymbolsReport,
    label: &str,
) -> std::io::Result<()> {
    writeln!(w, "{}", "-".repeat(72))?;
    writeln!(
        w,
        "symbols-atom byte identity [{}]: checked={} identical={} divergent={} (skipped={})",
        label,
        report.checked,
        report.identical,
        report.divergent.len(),
        report.skipped,
    )?;
    for (id, detail) in &report.divergent {
        writeln!(w, "  SYMB-DIVERGENT [{}]\n    {}", id, detail)?;
    }
    if report.met_bar() {
        writeln!(
            w,
            "SYMB BAR MET: {} identical, 0 divergent (of {} both-accept)",
            report.identical, report.checked
        )?;
    } else {
        writeln!(
            w,
            "SYMB BAR NOT MET: {} symbols-atom divergence(s)",
            report.divergent.len()
        )?;
    }
    Ok(())
}

/// Pretty-print a report to a writer (the binary and the test share this
/// so the honest split reads the same everywhere).
pub fn print_report(
    w: &mut dyn std::io::Write,
    report: &CompileReport,
    label: &str,
) -> std::io::Result<()> {
    writeln!(w, "{}", "=".repeat(72))?;
    writeln!(
        w,
        "compile byte-identity differential [{}]: total={} identical={} divergent={} oracle-rejected={} ironhorse-rejected={} accept-disagree={} (oracle-unavailable={})",
        label,
        report.total,
        report.identical,
        report.divergent,
        report.oracle_rejected,
        report.ironhorse_rejected,
        report.accept_disagreements,
        report.oracle_unavailable,
    )?;
    if !report.divergence_classes.is_empty() {
        writeln!(w, "{}", "-".repeat(72))?;
        writeln!(
            w,
            "NAMED divergence classes (byte mismatch on both-accept):"
        )?;
        for (class, n) in &report.divergence_classes {
            writeln!(w, "  {:>5}  {}", n, class)?;
        }
    }
    for (id, class, detail) in &report.divergences {
        writeln!(w, "  DIVERGENT [{}] {}\n    {}", class, id, detail)?;
    }
    for (id, why) in &report.ironhorse_rejections {
        writeln!(w, "  IRONHORSE-REJECTED [{}]\n    {}", id, why)?;
    }
    for (id, note) in &report.ironhorse_only_accepts {
        writeln!(w, "  IRONHORSE-ONLY-ACCEPT [{}] {}", id, note)?;
    }
    writeln!(w, "{}", "=".repeat(72))?;
    if report.met_bar() {
        writeln!(
            w,
            "BAR MET: {} identical, 0 divergent, full accept/reject agreement (of {} classified)",
            report.identical, report.total
        )?;
    } else {
        writeln!(
            w,
            "BAR NOT MET: {} divergent, {} ironhorse-rejected, {} accept-disagreements",
            report.divergent, report.ironhorse_rejected, report.accept_disagreements
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corpora_byte_identity_no_undocumented_divergence() {
        // The bounded, in-`cargo test` regression gate for the stage-5
        // byte-identity bar over the curated conformance corpora (every
        // non-comment line). The **stage bar** — `divergent == 0` AND full
        // accept/reject agreement — is now MET with **no documented fold
        // left on either axis**:
        //
        //   - Byte identity: the CESU-8 string-literal fold is CLOSED (the
        //     coder carries string values as UTF-16 code units and emits
        //     XS's CESU-8), so every both-accept program is byte-identical.
        //   - Accept/reject: the named coder folds are CLOSED too —
        //     `new.target` (`Target`), optional chaining (`Chain`/`Option`),
        //     the `for (let …)` declaring-scope refresh, and the nested
        //     function-declaration (`Define`) path all code byte-identically
        //     (stage-5 fix child, the named-coder-rejects slice), so the
        //     coder no longer folds on any construct the curated corpus
        //     reaches. The documented-fold allowlist is therefore **empty**.
        //
        // This gate now asserts **zero byte divergence** AND **zero
        // ironhorse-rejection** — so any NEW byte divergence (a regression in a
        // currently-identical program, including a CESU-8 regression) or ANY
        // coder panic (a re-opened fold or an accidental bug panic) fails the
        // build. The whole-`language/` sweep lives in the `compile-diff`
        // binary (bounded per subtree to contain oracle RSS).
        let programs = corpora_programs();
        assert!(
            !programs.is_empty(),
            "curated corpora must contain programs"
        );
        let report = compile_diff_programs(&programs);
        let mut buf = Vec::new();
        print_report(&mut buf, &report, "corpora").unwrap();
        eprintln!("{}", String::from_utf8_lossy(&buf));

        // Byte identity: zero divergence over the whole curated corpus —
        // the CESU-8 string fold is closed, no fold remains on this axis.
        assert_eq!(
            report.divergent, 0,
            "byte divergence(s) (the CESU-8 string fold must stay closed): {:#?}",
            report.divergences
        );

        // Accept/reject: zero ironhorse-rejection. The named coder folds are
        // closed, so there is no allowlist — any coder panic (a re-opened
        // fold or an accidental bug) fails this gate.
        assert_eq!(
            report.ironhorse_rejected, 0,
            "ironhorse-rejection(s) where the oracle accepts (a re-opened coder fold): {:#?}",
            report.ironhorse_rejections
        );

        // Accept/reject agreement in the benign direction must be perfect
        // (ironhorse never accepts what the oracle rejects), and the corpus is
        // overwhelmingly byte-identical.
        assert_eq!(
            report.accept_disagreements, 0,
            "ironhorse accepted program(s) the oracle rejected — a real bar violation"
        );
        assert!(
            report.identical > 0,
            "expected accepted programs in the corpora"
        );
        assert!(
            report.identical * 20 > report.total,
            "byte-identity should dominate the corpus (identical={} total={})",
            report.identical,
            report.total
        );
    }

    #[test]
    fn corpora_symbols_atom_byte_identity() {
        // Stage-6 child 1 gate: the SYMB atom `ironhorse-compile` now emits
        // (`compile_atoms`) must be byte-identical to the XS oracle's over
        // the whole curated corpus — the second half of the script, held to
        // the same bar as the bytecode. This is what lets the flipped
        // dual-run default stop borrowing `oracle.symbols`: ironhorse pairs its
        // own bytecode with its own symbols. Any byte divergence here would
        // mean the flipped default links intrinsics against a different
        // id→name table than the oracle, so it fails the build.
        let programs = corpora_programs();
        assert!(
            !programs.is_empty(),
            "curated corpora must contain programs"
        );
        let report = symbols_diff_programs(&programs);
        let mut buf = Vec::new();
        print_symbols_report(&mut buf, &report, "corpora").unwrap();
        eprintln!("{}", String::from_utf8_lossy(&buf));

        assert!(
            report.divergent.is_empty(),
            "symbols-atom divergence(s) — the flipped default would mislink \
             intrinsics: {:#?}",
            report.divergent
        );
        assert!(
            report.checked > 0,
            "expected both-accept programs to compare symbols atoms on"
        );
        // The atom identity must dominate (it is total on this corpus).
        assert_eq!(
            report.identical, report.checked,
            "every both-accept program must have a byte-identical symbols atom \
             (identical={} checked={})",
            report.identical, report.checked
        );
    }

    #[test]
    fn integer_index_object_keys_are_byte_identical() {
        // Class δ (fix3): an integer-valued object-literal key codes through
        // the integer-index property path (`INTEGER`/`AT`/`NEW_PROPERTY_AT`),
        // exactly as XS's `fxPropertyName`/`fxStringToIndex` classifies it. A
        // string key that is a canonical array index ("0", "1", "10") flips to
        // that path too; a non-canonical string ("01", "1.5", the 2^32-1
        // sentinel, a signed form) stays a string atom (`NEW_PROPERTY`). Each
        // program is compile-only byte-identical against the XS oracle (the
        // stage-limited ironhorse-vm cannot yet *run* integer-index property
        // access, so these live here, not in a dual-run corpus).
        let programs = [
            // The stage-5 divergence that motivated the fix: numeric `0`,
            // canonical-string `"1"`, and a plain identifier key together.
            r#"var o = {0 : 1, "1" : "x", o : {}};"#,
            r#"var o = {0: 1, "1": 2, "10": 3, 10: 4};"#,
            // Canonical string index at the top of the small-int range flips
            // to the integer path, matching the identical numeric key.
            r#"var o = {"2147483647": 1, 2147483647: 2};"#,
            // Non-canonical strings stay string atoms (never the index path).
            r#"var o = {"01": 1, "1.5": 2, "4294967295": 3, "-1": 4, "+1": 5};"#,
            // A getter/setter/method with a canonical-index name also flips.
            r#"var o = {get "1"() { return 7; }};"#,
            r#"var o = {"2"() { return 8; }};"#,
        ];
        for src in programs {
            assert_eq!(
                compile_one(src),
                CompileVerdict::Identical,
                "integer-index object key must be byte-identical to the oracle: {src}",
            );
        }
    }

    #[test]
    fn module_corpora_byte_identity_no_divergence() {
        // The stage-5 **module** byte-identity gate: every curated module
        // program (`corpora-modules/*.js`, delimiter-split) must compile to
        // module bytecode byte-identical to the XS oracle's module-compile
        // entry — default/named/namespace imports, named/default/re-export
        // forms, and live-binding access. Zero divergence AND zero
        // ironhorse-rejection where the oracle accepts (a coder fold in the
        // module path fails the build), exactly as the script gate does.
        let programs = module_corpora_programs();
        assert!(
            !programs.is_empty(),
            "curated module corpora must contain programs"
        );
        let report = module_compile_diff_programs(&programs);
        let mut buf = Vec::new();
        print_report(&mut buf, &report, "corpora-modules").unwrap();
        eprintln!("{}", String::from_utf8_lossy(&buf));

        assert_eq!(
            report.divergent, 0,
            "module byte divergence(s): {:#?}",
            report.divergences
        );
        assert_eq!(
            report.ironhorse_rejected, 0,
            "module ironhorse-rejection(s) where the oracle accepts (a module coder fold): {:#?}",
            report.ironhorse_rejections
        );
        assert_eq!(
            report.accept_disagreements, 0,
            "ironhorse accepted module program(s) the oracle rejected — a real bar violation"
        );
        // Every curated module program is both-accept and byte-identical.
        assert_eq!(
            report.identical, report.total,
            "every curated module program must be byte-identical (identical={} total={})",
            report.identical, report.total
        );
        assert!(report.identical > 0, "expected accepted module programs");
    }

    #[test]
    fn runtime_syntax_error_from_eval_is_a_compile_accept() {
        // A compiled program whose direct/indirect `eval` throws a **runtime**
        // `SyntaxError` (a `var`/lexical collision in
        // `EvalDeclarationInstantiation`, or an eval-body parse failure) is a
        // compile ACCEPT, not a parse rejection: XS emits the outer bytecode
        // and ironhorse compiles it byte-identically. `compile_one` must classify
        // these `Identical`, not `OracleRejected` — the eval-code fix5 slice.
        let cases = [
            "let x; eval('var x;');",         // sloppy var/lex collision at runtime
            "{ let x; { eval('var x;'); } }", // lower-scope collision
            "var x; (0,eval)(\"x = 1; x\\u000A++\");", // indirect eval parse failure
        ];
        for src in cases {
            // Precondition: the oracle runs it, emits bytecode, then throws a
            // *runtime* SyntaxError (the case this recovery targets).
            let o = xs_oracle::run(src).expect("oracle machine");
            assert!(!o.completed, "{src:?}: expected a runtime throw");
            assert!(
                o.error.contains("SyntaxError"),
                "{src:?}: expected SyntaxError, got {:?}",
                o.error
            );
            assert!(
                !o.bytecode.is_empty(),
                "{src:?}: oracle must have compiled it"
            );
            assert_eq!(
                compile_one(src),
                CompileVerdict::Identical,
                "{src:?}: a runtime-SyntaxError eval program with byte-identical \
                 compilation must classify Identical (compile accept), not a reject"
            );
        }
    }

    #[test]
    fn genuine_parse_rejection_is_not_reclassified() {
        // The recovery in `compile_one` fires ONLY on exact byte-identity, so a
        // real parse rejection (ironhorse rejects, or the bytes differ) is never
        // silently promoted to `Identical`. `var = ;` fails to parse in both
        // engines — it must stay a both-reject agreement (`OracleRejected`).
        assert_eq!(compile_one("var = ;"), CompileVerdict::OracleRejected);
    }
}

/// Walk `dir` collecting `.js` files (recursively, sorted), skipping
/// `staging/` and `_FIXTURE.js` — the same selection the dual-run runner
/// uses, re-exported here so the `compile-diff` binary can address a
/// test262 subtree without depending on the runner's private walker.
pub fn collect_js(dir: &Path) -> Vec<PathBuf> {
    crate::test262::collect_js(dir)
}
