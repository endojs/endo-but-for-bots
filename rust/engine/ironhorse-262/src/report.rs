//! Full-run reporting for `ironhorse-xst`: per-case records, run provenance,
//! stable machine-readable JSON, deterministic cross-batch aggregation, and a
//! self-contained static HTML report (maintainer request,
//! [kriskowal/garden#51]: "a *full* test262 suite with Ironhorse and produce
//! an HTML report to be included in kriscendobot gh-pages").
//!
//! The runner core ([`crate::xst`]) already classifies each case into the
//! xst-shaped verdict ([`crate::xst::Verdict`]). This module is the layer on
//! top that a *whole-tree* sweep needs and the aggregate YAML never carried:
//!
//! - a **per-case record** ([`CaseRecord`]) — path, declared `features:`, the
//!   observed outcome, the exact skip/fail reason, and the strict/computron
//!   telemetry — so a gap is a direct, actionable case identifier, not a count;
//! - a **provenance** block ([`Provenance`]) pinning the test262 SHA, the
//!   endo/Ironhorse SHA, the oracle build, the command/config, and timestamps,
//!   so a published report says exactly what produced it;
//! - a **category** ([`Category`]) that separates a genuine Ironhorse execution
//!   defect / language gap from a harness/oracle/infrastructure non-result — the
//!   distinction the maintainer asked the report to make explicit;
//! - **deterministic aggregation** ([`aggregate`]) that merges the per-batch
//!   JSON a bounded, resumable sweep writes (one batch per process, so the
//!   known XS-oracle process-RSS retention cannot OOM a whole-tree run) into one
//!   stable report, sorted by path;
//! - **discovery** ([`discover_batches`]) and **resume planning**
//!   ([`pending_batches`]) so the orchestrator can partition `test/**` into
//!   case-count-capped batches and skip the ones already on disk after an
//!   interruption.
//!
//! JSON is emitted by hand (like the sibling YAML in [`crate::xst`], keeping the
//! crate free of a serde dependency) and read back through `yaml-rust2` (JSON is
//! a subset of YAML, so the frontmatter parser's dependency doubles as the
//! reader) — see [`read_batch`] / [`read_provenance`].

use crate::xst::{CaseResult, Verdict};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use yaml_rust2::{Yaml, YamlLoader};

/// The observed outcome of one case, the section of the report it lands in.
/// The stable string form (`as_str`) is the JSON/HTML wire value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Outcome {
    /// Ran end-to-end and met the bar (observable agreement, or the expected
    /// negative abort).
    Covered,
    /// Skipped before running — a declared-unimplemented feature or an
    /// unmodelable structural shape (`module`, `onlyStrict`, an SES mode).
    PreSkip,
    /// Skipped after attempting the run, named by the exact opcode/value/reason
    /// that stopped it — the honest coverage-gap split.
    RunSkip,
    /// A real failure the bar forbids: a divergence from the oracle, an
    /// over-acceptance, a gated meter violation, or a determinism failure.
    Fail,
}

impl Outcome {
    /// The stable wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Covered => "covered",
            Outcome::PreSkip => "pre-skip",
            Outcome::RunSkip => "run-skip",
            Outcome::Fail => "fail",
        }
    }

    /// Parse the wire string back (aggregation reads its own batch files).
    pub fn parse(s: &str) -> Option<Outcome> {
        match s {
            "covered" => Some(Outcome::Covered),
            "pre-skip" => Some(Outcome::PreSkip),
            "run-skip" => Some(Outcome::RunSkip),
            "fail" => Some(Outcome::Fail),
            _ => None,
        }
    }
}

/// The provenance-of-outcome category — the maintainer's requested split
/// between a genuine Ironhorse limitation and a harness/oracle/infrastructure
/// non-result. Derived deterministically from `(outcome, reason)` by
/// [`classify`], so it is a pure function of the recorded verdict and needs no
/// extra state on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Category {
    /// Ran end-to-end and met the bar.
    Covered,
    /// A real Ironhorse execution defect the bar forbids (a divergence or an
    /// over-acceptance). These are the report's headline correctness failures.
    IronhorseFailure,
    /// Ironhorse did not implement the feature/opcode/surface the case reached
    /// — a genuine language-implementation gap (the actionable backlog).
    Unsupported,
    /// Declared or structural skip the run never attempted (a `feature:` on the
    /// skip list, a `module`/`onlyStrict`/SES-mode shape).
    Skipped,
    /// The oracle, the harness, or the infrastructure could not produce a
    /// comparison — explicitly **not** an Ironhorse gap (an oracle machine
    /// error, a missing harness file, an oracle-side surprise, an unreadable
    /// file).
    Infrastructure,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Category::Covered => "covered",
            Category::IronhorseFailure => "ironhorse-failure",
            Category::Unsupported => "unsupported",
            Category::Skipped => "skipped",
            Category::Infrastructure => "infrastructure",
        }
    }

    /// The categories in report order (covered first, then the failure the bar
    /// forbids, then the coverage gap, then the honest skips, then infra).
    pub fn all() -> [Category; 5] {
        [
            Category::Covered,
            Category::IronhorseFailure,
            Category::Unsupported,
            Category::Skipped,
            Category::Infrastructure,
        ]
    }
}

/// Map a recorded `(outcome, reason)` to its provenance [`Category`]. The
/// reason strings are the exact ones [`crate::xst`] emits; a prefix match keeps
/// this robust as new sub-reasons are added under a known family.
pub fn classify(outcome: Outcome, reason: &str) -> Category {
    match outcome {
        Outcome::Covered => Category::Covered,
        // Every `Verdict::Fail` is a bar-forbidden Ironhorse defect.
        Outcome::Fail => Category::IronhorseFailure,
        Outcome::PreSkip => {
            // A missing harness file or an unreadable case is infrastructure.
            if reason.starts_with("structural:missing-harness") || reason == "unreadable" {
                Category::Infrastructure
            } else if reason.starts_with("ses-mode:")
                || reason == "onlyStrict:strict-mode-unimplemented"
            {
                // An SES lockdown/compartment mode ironhorse cannot yet run, and
                // a strict-only case whose sole mode is the not-yet-implemented
                // strict mode, are genuine ENGINE gaps — the actionable backlog
                // — not declared/structural skips (round-2 must-fix #5). They
                // flip to covered the day the guest surface / strict compiler
                // lands, exactly like an `unsupported-opcode:*` run-skip.
                Category::Unsupported
            } else {
                // Everything else pre-skipped is a declared/structural skip (a
                // `feature:` on the skip list, a `module`/`async`/`can-block`
                // shape).
                Category::Skipped
            }
        }
        Outcome::RunSkip => {
            // Harness/oracle/infrastructure non-results — not an Ironhorse gap.
            const INFRA: &[&str] = &[
                "oracle-machine-error",
                "negative-oracle-unexpected",
                "oracle-shim-unsafe",
                "oracle-gate-off",
            ];
            if INFRA.iter().any(|prefix| reason.starts_with(prefix)) {
                Category::Infrastructure
            } else if reason.starts_with("unsupported-opcode:")
                || reason == "parse-or-decode"
                || reason.starts_with("non-primitive-completion")
                || reason.starts_with("builtin-coercion-computron-gap")
                || reason.starts_with("abort-value-differs")
                || reason.starts_with("ironhorse-aborted")
                || reason.starts_with("negative-")
                || reason.starts_with("async:")
            {
                // unsupported-opcode:*, parse-or-decode, non-primitive-completion,
                // builtin-coercion-computron-gap, abort-value-differs,
                // ironhorse-aborted*, negative-*:pending-compiler,
                // negative-type-unmatched:*, async:* — all Ironhorse coverage gaps.
                Category::Unsupported
            } else {
                // Unknown run skips must not be charged to Ironhorse. New
                // reason families stay honest until explicitly classified.
                Category::Infrastructure
            }
        }
    }
}

/// One case's full record, the atom of a full-run report. `path` is relative to
/// the test262 `test/` root, so it is a direct, stable case identifier a reader
/// can turn straight into a gap job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaseRecord {
    pub path: String,
    pub outcome: Outcome,
    /// The skip/fail reason (empty for a covered case).
    pub reason: String,
    /// The case's declared `features:` — the axis feature breakdowns group on.
    pub features: Vec<String>,
    pub strict_skipped: bool,
    pub computron_gap: bool,
}

impl CaseRecord {
    /// Build a record from a runner [`CaseResult`] and the case's path/features.
    pub fn from_result(path: &str, features: Vec<String>, r: &CaseResult) -> CaseRecord {
        let (outcome, reason) = match &r.verdict {
            Verdict::Covered => (Outcome::Covered, String::new()),
            Verdict::PreSkip(s) => (Outcome::PreSkip, s.clone()),
            Verdict::RunSkip(s) => (Outcome::RunSkip, s.clone()),
            Verdict::Fail(s) => (Outcome::Fail, s.clone()),
        };
        CaseRecord {
            path: path.to_string(),
            outcome,
            reason,
            features,
            strict_skipped: r.strict_skipped,
            computron_gap: r.computron_gap,
        }
    }

    pub fn category(&self) -> Category {
        classify(self.outcome, &self.reason)
    }
}

/// The run provenance recorded once at the top of an aggregate report — every
/// field the maintainer asked a published report to carry. All strings, filled
/// by the orchestrator (from `git rev-parse`, the pinned revision file, the
/// clock), so this module needs no environment access and stays deterministic
/// under test.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Provenance {
    /// The exact authoritative test262 commit the corpus was taken from.
    pub test262_sha: String,
    /// A human ref for it (e.g. `tc39/test262@be13516`).
    pub test262_ref: String,
    /// The endo/Ironhorse commit under test.
    pub endo_sha: String,
    /// The XS oracle build (e.g. `moddable 8.3.1 @ 23b4d6b`).
    pub oracle: String,
    /// The command line that produced the run.
    pub command: String,
    /// The runner config summary (e.g. `oracle=on ses-mode=none`).
    pub config: String,
    pub started_at: String,
    pub finished_at: String,
    pub host: String,
    /// The runner name (`ironhorse-xst`).
    pub runner: String,
    // --- Typed, load-bearing provenance the HTML renders from directly ------
    // (round-2 must-fix #4: authority claims must not be substring matches on
    // operator-controlled prose). These carry the report's scope and mode as
    // structured values so a crafted `config` string can never publish a false
    // whole-corpus / oracle-locked claim.
    /// The sweep scope: `whole-corpus`, or `subtree=<prefix>` for a partial run.
    pub scope: String,
    /// Whether the XS oracle gated the run: `on` or `off`.
    pub oracle_mode: String,
    /// The SES lockdown/compartment mode applied to every case (`none`/`l`/`lc`/`c`).
    pub ses_mode: String,
    /// Whether every discovered batch was present at aggregation: `complete`
    /// or `incomplete`.
    pub completion: String,
    /// The run identity every batch is stamped with — the fingerprint of the
    /// result-affecting inputs (corpus SHA, engine SHA, oracle mode, SES mode,
    /// batch cap, scope). Aggregation binds the report to this and rejects any
    /// batch stamped with a different identity (round-2 must-fix #1).
    pub run_id: String,
}

impl Provenance {
    /// True when the typed scope field marks a whole-corpus sweep. Reading the
    /// structured field — never a substring of the human `config` — is the
    /// round-2 must-fix #4 fix.
    pub fn is_whole_corpus(&self) -> bool {
        self.scope == "whole-corpus"
    }

    /// True when the XS oracle gated the run.
    pub fn is_oracle_locked(&self) -> bool {
        self.oracle_mode == "on"
    }
}

/// A full-run report: the provenance plus every case record. This is both the
/// aggregate wire shape (`--json`) and the in-memory model the HTML renders.
#[derive(Debug, Clone, Default)]
pub struct RunReport {
    pub provenance: Provenance,
    pub cases: Vec<CaseRecord>,
}

/// Per-category counts, the cell of every breakdown table.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CategoryCounts {
    pub covered: usize,
    pub ironhorse_failure: usize,
    pub unsupported: usize,
    pub skipped: usize,
    pub infrastructure: usize,
}

impl CategoryCounts {
    pub fn add(&mut self, c: Category) {
        match c {
            Category::Covered => self.covered += 1,
            Category::IronhorseFailure => self.ironhorse_failure += 1,
            Category::Unsupported => self.unsupported += 1,
            Category::Skipped => self.skipped += 1,
            Category::Infrastructure => self.infrastructure += 1,
        }
    }

    pub fn total(&self) -> usize {
        self.covered
            + self.ironhorse_failure
            + self.unsupported
            + self.skipped
            + self.infrastructure
    }

    pub fn get(&self, c: Category) -> usize {
        match c {
            Category::Covered => self.covered,
            Category::IronhorseFailure => self.ironhorse_failure,
            Category::Unsupported => self.unsupported,
            Category::Skipped => self.skipped,
            Category::Infrastructure => self.infrastructure,
        }
    }
}

impl RunReport {
    pub fn total(&self) -> usize {
        self.cases.len()
    }

    /// The top-line count in each observed outcome.
    pub fn totals_by_outcome(&self) -> BTreeMap<&'static str, usize> {
        let mut m = BTreeMap::new();
        for o in [
            Outcome::Covered,
            Outcome::Fail,
            Outcome::RunSkip,
            Outcome::PreSkip,
        ] {
            m.insert(o.as_str(), 0usize);
        }
        for c in &self.cases {
            *m.entry(c.outcome.as_str()).or_insert(0) += 1;
        }
        m
    }

    /// The top-line count in each provenance category.
    pub fn totals_by_category(&self) -> CategoryCounts {
        let mut counts = CategoryCounts::default();
        for c in &self.cases {
            counts.add(c.category());
        }
        counts
    }

    /// Category counts grouped by the first `depth` path components (e.g.
    /// `built-ins/Proxy` at depth 2). Deterministic (sorted keys).
    pub fn by_path(&self, depth: usize) -> BTreeMap<String, CategoryCounts> {
        let mut m: BTreeMap<String, CategoryCounts> = BTreeMap::new();
        for c in &self.cases {
            let key = path_prefix(&c.path, depth);
            m.entry(key).or_default().add(c.category());
        }
        m
    }

    /// Category counts grouped by each declared `feature:` a case carries (a
    /// case counts once per feature). Deterministic (sorted keys).
    pub fn by_feature(&self) -> BTreeMap<String, CategoryCounts> {
        let mut m: BTreeMap<String, CategoryCounts> = BTreeMap::new();
        for c in &self.cases {
            for f in &c.features {
                m.entry(f.clone()).or_default().add(c.category());
            }
        }
        m
    }

    /// Every bar-forbidden Ironhorse failure, with its detail — the report's
    /// headline correctness list.
    pub fn failures(&self) -> Vec<&CaseRecord> {
        let mut v: Vec<&CaseRecord> = self
            .cases
            .iter()
            .filter(|c| c.outcome == Outcome::Fail)
            .collect();
        v.sort_by(|a, b| a.path.cmp(&b.path));
        v
    }

    /// Skip/unsupported reasons → (count, up to `sample` example case paths),
    /// most-frequent first. Turns the honest split into actionable gap jobs.
    pub fn reasons(&self, want: Category, sample: usize) -> Vec<(String, usize, Vec<String>)> {
        let mut counts: BTreeMap<String, (usize, Vec<String>)> = BTreeMap::new();
        for c in &self.cases {
            if c.category() != want {
                continue;
            }
            let e = counts.entry(c.reason.clone()).or_insert((0, Vec::new()));
            e.0 += 1;
            if e.1.len() < sample {
                e.1.push(c.path.clone());
            }
        }
        let mut v: Vec<(String, usize, Vec<String>)> = counts
            .into_iter()
            .map(|(key, (count, examples))| (key, count, examples))
            .collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        v
    }

    /// The stable, machine-readable JSON: provenance, summary totals, and the
    /// full case array sorted by path. Key order is fixed and every collection
    /// is sorted, so the same run produces byte-identical output.
    pub fn to_json(&self) -> String {
        let mut cases = self.cases.clone();
        cases.sort_by(|a, b| a.path.cmp(&b.path));
        let counts = self.totals_by_category();
        let by_outcome = self.totals_by_outcome();

        let mut s = String::new();
        s.push_str("{\n");
        s.push_str("  \"schema\": \"ironhorse-test262-report/1\",\n");

        // provenance
        s.push_str("  \"provenance\": {\n");
        let p = &self.provenance;
        let fields = [
            ("runner", &p.runner),
            ("test262_sha", &p.test262_sha),
            ("test262_ref", &p.test262_ref),
            ("endo_sha", &p.endo_sha),
            ("oracle", &p.oracle),
            ("command", &p.command),
            ("config", &p.config),
            ("scope", &p.scope),
            ("oracle_mode", &p.oracle_mode),
            ("ses_mode", &p.ses_mode),
            ("completion", &p.completion),
            ("run_id", &p.run_id),
            ("started_at", &p.started_at),
            ("finished_at", &p.finished_at),
            ("host", &p.host),
        ];
        for (i, (k, v)) in fields.iter().enumerate() {
            let comma = if i + 1 < fields.len() { "," } else { "" };
            s.push_str(&format!("    {}: {}{}\n", json_str(k), json_str(v), comma));
        }
        s.push_str("  },\n");

        // summary
        s.push_str("  \"summary\": {\n");
        s.push_str(&format!("    \"total\": {},\n", self.total()));
        s.push_str("    \"by_outcome\": {\n");
        let bo: Vec<_> = by_outcome.iter().collect();
        for (i, (k, n)) in bo.iter().enumerate() {
            let comma = if i + 1 < bo.len() { "," } else { "" };
            s.push_str(&format!("      {}: {}{}\n", json_str(k), n, comma));
        }
        s.push_str("    },\n");
        s.push_str("    \"by_category\": {\n");
        let cats = Category::all();
        for (i, cat) in cats.iter().enumerate() {
            let comma = if i + 1 < cats.len() { "," } else { "" };
            s.push_str(&format!(
                "      {}: {}{}\n",
                json_str(cat.as_str()),
                counts.get(*cat),
                comma
            ));
        }
        s.push_str("    }\n");
        s.push_str("  },\n");

        // cases
        s.push_str("  \"cases\": [\n");
        for (i, c) in cases.iter().enumerate() {
            let comma = if i + 1 < cases.len() { "," } else { "" };
            let features = c
                .features
                .iter()
                .map(|f| json_str(f))
                .collect::<Vec<_>>()
                .join(", ");
            s.push_str(&format!(
                "    {{ \"path\": {}, \"outcome\": {}, \"category\": {}, \"reason\": {}, \"features\": [{}], \"strict_skipped\": {}, \"computron_gap\": {} }}{}\n",
                json_str(&c.path),
                json_str(c.outcome.as_str()),
                json_str(c.category().as_str()),
                json_str(&c.reason),
                features,
                c.strict_skipped,
                c.computron_gap,
                comma,
            ));
        }
        s.push_str("  ]\n");
        s.push_str("}\n");
        s
    }

    /// A batch file's JSON — just the case array, no provenance (the aggregate
    /// owns provenance). This is what `ironhorse-xst --json` writes per subtree.
    /// Equivalent to [`RunReport::batch_json_with_id`] with an empty identity;
    /// retained for the legacy aggregate callers/tests that do not bind a run.
    pub fn batch_json(cases: &[CaseRecord]) -> String {
        Self::batch_json_with_id("", cases)
    }

    /// A batch file's JSON stamped with the run identity `run_id`. A whole-tree
    /// sweep stamps every batch with the fingerprint of its result-affecting
    /// inputs so aggregation can bind the report to exactly one run and reject a
    /// batch left over from a different corpus/engine/oracle/scope (round-2
    /// must-fix #1). An empty `run_id` is omitted (the legacy shape).
    pub fn batch_json_with_id(run_id: &str, cases: &[CaseRecord]) -> String {
        let mut cases = cases.to_vec();
        cases.sort_by(|a, b| a.path.cmp(&b.path));
        let mut s = String::new();
        s.push_str("{ \"schema\": \"ironhorse-test262-batch/1\", ");
        if !run_id.is_empty() {
            s.push_str(&format!("\"run_id\": {}, ", json_str(run_id)));
        }
        s.push_str("\"cases\": [\n");
        for (i, c) in cases.iter().enumerate() {
            let comma = if i + 1 < cases.len() { "," } else { "" };
            let features = c
                .features
                .iter()
                .map(|f| json_str(f))
                .collect::<Vec<_>>()
                .join(", ");
            s.push_str(&format!(
                "  {{ \"path\": {}, \"outcome\": {}, \"reason\": {}, \"features\": [{}], \"strict_skipped\": {}, \"computron_gap\": {} }}{}\n",
                json_str(&c.path),
                json_str(c.outcome.as_str()),
                json_str(&c.reason),
                features,
                c.strict_skipped,
                c.computron_gap,
                comma,
            ));
        }
        s.push_str("] }\n");
        s
    }
}

/// The first `depth` path components joined with `/`; a shorter path is
/// returned whole. Used to group cases by subtree.
fn path_prefix(path: &str, depth: usize) -> String {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() <= depth {
        // Group loose files at this level under their directory.
        if parts.len() <= 1 {
            return path.to_string();
        }
        return parts[..parts.len().saturating_sub(1).max(1)].join("/");
    }
    parts[..depth].join("/")
}

/// JSON-quote a string, escaping the control set JSON requires.
fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ---------------------------------------------------------------------------
// Reading back (aggregation): JSON is a subset of YAML, so yaml-rust2 (already
// a dependency for frontmatter) reads our own emitted batch/provenance files.
// ---------------------------------------------------------------------------

fn yaml_str(node: &Yaml) -> String {
    node.as_str().unwrap_or_default().to_string()
}

fn yaml_str_vec(node: &Yaml) -> Vec<String> {
    node.as_vec()
        .map(|v| {
            v.iter()
                .filter_map(|n| n.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// Parse one case object (from a batch or an aggregate `cases` entry).
fn case_from_yaml(node: &Yaml) -> Option<CaseRecord> {
    let path = node["path"].as_str()?.to_string();
    let outcome = Outcome::parse(node["outcome"].as_str()?)?;
    Some(CaseRecord {
        path,
        outcome,
        reason: yaml_str(&node["reason"]),
        features: yaml_str_vec(&node["features"]),
        strict_skipped: node["strict_skipped"].as_bool().unwrap_or(false),
        computron_gap: node["computron_gap"].as_bool().unwrap_or(false),
    })
}

/// Read a batch file (`{ "cases": [...] }`) into its case records. A malformed
/// or unreadable file yields an empty vector (the orchestrator's resume treats
/// it as still-pending), never a panic.
pub fn read_batch(path: &Path) -> Vec<CaseRecord> {
    read_batch_checked(path).unwrap_or_default()
}

/// Read and validate a batch file. Validation requires the batch schema, a
/// `cases` array, and a valid record for every entry; an empty array is valid.
pub fn read_batch_checked(path: &Path) -> Result<Vec<CaseRecord>, String> {
    read_batch_full(path).map(|(_run_id, cases)| cases)
}

/// Read and validate a batch file, returning its stamped run identity (empty
/// when the batch carries none — the legacy shape) alongside its records. The
/// resume/aggregate identity gate ([`pending_batches_checked`], [`aggregate_plan`])
/// reads the `run_id` through this so a batch left over from a different
/// corpus/engine/oracle/scope is never mistaken for this run's work.
pub fn read_batch_full(path: &Path) -> Result<(String, Vec<CaseRecord>), String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(error) => return Err(error.to_string()),
    };
    let docs = YamlLoader::load_from_str(&text).map_err(|error| error.to_string())?;
    let doc = docs.first().ok_or_else(|| "empty document".to_string())?;
    if doc["schema"].as_str() != Some("ironhorse-test262-batch/1") {
        return Err("missing or unsupported batch schema".to_string());
    }
    let run_id = doc["run_id"].as_str().unwrap_or_default().to_string();
    let nodes = doc["cases"]
        .as_vec()
        .ok_or_else(|| "missing cases array".to_string())?;
    let cases = nodes
        .iter()
        .map(|node| case_from_yaml(node).ok_or_else(|| "invalid case record".to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((run_id, cases))
}

/// Parse the `cases` array out of a batch or aggregate JSON string.
pub fn read_cases_from_str(text: &str) -> Vec<CaseRecord> {
    let docs = match YamlLoader::load_from_str(text) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let doc = match docs.first() {
        Some(d) => d,
        None => return Vec::new(),
    };
    doc["cases"]
        .as_vec()
        .map(|v| v.iter().filter_map(case_from_yaml).collect())
        .unwrap_or_default()
}

/// Read a provenance JSON file (the flat object the orchestrator writes). A
/// missing/unreadable file yields a default provenance so aggregation still
/// produces a report (with empty provenance fields), never a panic.
pub fn read_provenance(path: &Path) -> Provenance {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return Provenance::default(),
    };
    let docs = match YamlLoader::load_from_str(&text) {
        Ok(d) => d,
        Err(_) => return Provenance::default(),
    };
    let doc = match docs.first() {
        Some(d) => d,
        None => return Provenance::default(),
    };
    let config = yaml_str(&doc["config"]);
    Provenance {
        test262_sha: yaml_str(&doc["test262_sha"]),
        test262_ref: yaml_str(&doc["test262_ref"]),
        endo_sha: yaml_str(&doc["endo_sha"]),
        oracle: yaml_str(&doc["oracle"]),
        command: yaml_str(&doc["command"]),
        // Prefer the typed fields; fall back to deriving from the human `config`
        // only for a legacy provenance file that predates them, so an old report
        // still renders. A current sweep always writes the typed fields.
        scope: {
            let s = yaml_str(&doc["scope"]);
            if !s.is_empty() {
                s
            } else if config.contains("subtree=<all>") {
                "whole-corpus".to_string()
            } else {
                String::new()
            }
        },
        oracle_mode: {
            let m = yaml_str(&doc["oracle_mode"]);
            if !m.is_empty() {
                m
            } else if config.contains("oracle=on") {
                "on".to_string()
            } else if config.contains("oracle=off") {
                "off".to_string()
            } else {
                String::new()
            }
        },
        ses_mode: yaml_str(&doc["ses_mode"]),
        completion: yaml_str(&doc["completion"]),
        run_id: yaml_str(&doc["run_id"]),
        config,
        started_at: yaml_str(&doc["started_at"]),
        finished_at: yaml_str(&doc["finished_at"]),
        host: yaml_str(&doc["host"]),
        runner: {
            let r = yaml_str(&doc["runner"]);
            if r.is_empty() {
                "ironhorse-xst".to_string()
            } else {
                r
            }
        },
    }
}

/// The batch-file basename for a subtree path: `/` → `__`, plus a `.json`
/// suffix. The inverse of what the orchestrator names each per-batch file, and
/// the key resume plans on.
pub fn batch_filename(subtree: &str) -> String {
    format!("{}.json", subtree.replace('/', "__"))
}

/// Maximum cases retained by one oracle process during a full sweep. This is
/// the SINGLE SOURCE OF TRUTH for the partition cap: discovery
/// ([`discover_batches`]) chunks on it, and the orchestrator reads it back
/// through [`batch_case_limit`] rather than repeating the literal, so the shell
/// `--batch-size` can never drift from the Rust chunk boundary (round-2
/// must-fix #2).
pub const BATCH_CASE_LIMIT: usize = 100;

/// The partition cap as a value the orchestrator can print and pass to
/// `ironhorse-xst --batch-size`, keeping discovery and execution single-sourced.
pub fn batch_case_limit() -> usize {
    BATCH_CASE_LIMIT
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/// Merge every batch file in `results_dir` (any `*.json` except a reserved
/// aggregate name) with the provenance, into one deterministic [`RunReport`].
/// Duplicate paths (a batch re-run after an interruption) collapse to the
/// last-read record; the final case list is sorted by path.
///
/// This is the directory-glob aggregation, retained for the legacy/unbound
/// path. A whole-tree sweep binds the report to an exact plan + run identity
/// with [`aggregate_plan`], which does not trust a directory glob.
pub fn aggregate(results_dir: &Path, provenance: Provenance) -> RunReport {
    let mut batch_files: Vec<PathBuf> = std::fs::read_dir(results_dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.extension().map(|e| e == "json").unwrap_or(false)
                        && p.file_name()
                            .map(|n| n != "report.json" && n != "provenance.json")
                            .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    batch_files.sort();

    // De-dup by path, deterministically: read in sorted file order, later wins.
    let mut by_path: BTreeMap<String, CaseRecord> = BTreeMap::new();
    for f in &batch_files {
        for rec in read_batch(f) {
            by_path.insert(rec.path.clone(), rec);
        }
    }
    RunReport {
        provenance,
        cases: by_path.into_values().collect(),
    }
}

/// Aggregate exactly the batches named in `plan` (the discovery list, batch
/// names `directory@@NNNN`) from `results_dir`, binding the report to the run
/// identity in `provenance.run_id`. This is the trustworthy aggregation
/// (round-2 must-fix #1): it never globs the directory, so a case from a
/// different corpus/engine/oracle/scope, or a stale batch file deleted from the
/// plan, cannot leak into the report; and a batch stamped with a different
/// `run_id` is rejected rather than merged under this run's provenance.
///
/// A batch file that is missing, unparseable, or identity-mismatched is skipped
/// and named in the returned `warnings` (the caller — the orchestrator's
/// completeness gate — decides whether that is fatal). Duplicate paths across
/// batches collapse to the last-read record; the case list is sorted by path.
pub fn aggregate_plan(
    results_dir: &Path,
    plan: &[String],
    provenance: Provenance,
) -> (RunReport, Vec<String>) {
    let expected = provenance.run_id.clone();
    let mut warnings = Vec::new();
    // Read in sorted batch-name order so duplicate-path resolution (last wins)
    // and the merged case list are deterministic regardless of plan order.
    let mut names: Vec<&String> = plan.iter().collect();
    names.sort();
    names.dedup();

    let mut by_path: BTreeMap<String, CaseRecord> = BTreeMap::new();
    for batch in names {
        // A batch name is `directory@@NNNN`; the file is that name with `/`→`__`.
        let file = results_dir.join(batch_filename(batch));
        match read_batch_full(&file) {
            Ok((run_id, cases)) => {
                if !expected.is_empty() && run_id != expected {
                    warnings.push(format!(
                        "batch {} has run_id {:?}, expected {:?} — rejected",
                        batch, run_id, expected
                    ));
                    continue;
                }
                for rec in cases {
                    by_path.insert(rec.path.clone(), rec);
                }
            }
            Err(error) => warnings.push(format!("batch {} unreadable: {}", batch, error)),
        }
    }
    (
        RunReport {
            provenance,
            cases: by_path.into_values().collect(),
        },
        warnings,
    )
}

// ---------------------------------------------------------------------------
// Discovery + resume planning
// ---------------------------------------------------------------------------

/// Discover bounded batches under a test262 `test/` root. Direct cases in each
/// directory are split into chunks of at most [`BATCH_CASE_LIMIT`], named
/// `directory@@NNNN`. `staging/` and its descendants are excluded.
///
/// The result is sorted, so the plan is reproducible.
pub fn discover_batches(test_root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    discover_into(test_root, test_root, &mut out);
    out.sort();
    out.dedup();
    out
}

fn discover_into(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut direct_case_count = 0usize;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().map(|n| n == "staging").unwrap_or(false) {
                continue;
            }
            subdirs.push(path);
        } else if path.is_file() && path.extension().map(|e| e == "js").unwrap_or(false) {
            // `is_file()` mirrors `collect_js_flat`'s predicate exactly, so
            // discovery's per-directory count and the runner's per-directory
            // slice agree on what a "case" is (round-2 must-fix #2, second half).
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if !name.ends_with("_FIXTURE.js") {
                direct_case_count += 1;
            }
        }
    }
    if direct_case_count > 0 {
        if let Ok(rel) = dir.strip_prefix(root) {
            let relative = rel.to_string_lossy().into_owned();
            if !relative.is_empty() {
                let chunks = direct_case_count.div_ceil(BATCH_CASE_LIMIT);
                for index in 0..chunks {
                    out.push(format!("{}@@{:04}", relative, index));
                }
            }
        }
    }
    subdirs.sort();
    for sub in subdirs {
        discover_into(root, &sub, out);
    }
}

/// The batches from `all` that have **not** yet been run — those whose result
/// file is absent or invalid in `results_dir`. This is the resume plan: after
/// an interruption, the completed bounded batch files remain on disk and
/// are skipped, so a re-run continues where it stopped.
pub fn pending_batches(results_dir: &Path, all: &[String]) -> Vec<String> {
    pending_batches_checked(results_dir, all, None)
}

/// The resume plan, additionally binding each completed batch to `expected_run_id`
/// when one is given. A batch whose file is absent/invalid is pending as before;
/// with `expected_run_id = Some(id)`, a batch stamped with a DIFFERENT identity
/// is also pending — so a results dir reused after a test262-pin/engine/oracle/
/// scope change re-runs the affected work rather than silently retaining the old
/// result (round-2 must-fix #1). A batch carrying no `run_id` (the legacy shape)
/// is treated as matching, so an unbound sweep is unchanged.
pub fn pending_batches_checked(
    results_dir: &Path,
    all: &[String],
    expected_run_id: Option<&str>,
) -> Vec<String> {
    all.iter()
        .filter(|b| {
            let f = results_dir.join(batch_filename(b));
            match read_batch_full(&f) {
                Err(_) => true,
                Ok((run_id, _)) => match expected_run_id {
                    Some(expected) if !expected.is_empty() && !run_id.is_empty() => {
                        run_id != expected
                    }
                    _ => false,
                },
            }
        })
        .cloned()
        .collect()
}

// ---------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------

/// HTML-escape text for a self-contained static report (no template engine).
fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

fn percentage(count: usize, total: usize) -> String {
    if total == 0 {
        "0.0%".to_string()
    } else {
        format!("{:.1}%", (count as f64) * 100.0 / (total as f64))
    }
}

/// Render the full-run report as one self-contained, accessible static HTML
/// document (inline CSS, no external assets — drops straight into gh-pages).
/// It carries the provenance, the outcome/category totals, breakdowns by
/// category, by subtree, and by feature, the named Ironhorse failures, and the
/// most-frequent unsupported reasons with sample case identifiers.
pub fn to_html(report: &RunReport) -> String {
    let provenance = &report.provenance;
    let total = report.total();
    let counts = report.totals_by_category();
    let mut s = String::new();

    s.push_str("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n");
    s.push_str("<meta charset=\"utf-8\">\n");
    s.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
    s.push_str("<title>Ironhorse test262 conformance report</title>\n");
    s.push_str("<style>\n");
    s.push_str(HTML_CSS);
    s.push_str("</style>\n</head>\n<body>\n<main>\n");

    s.push_str("<h1>Ironhorse test262 conformance report</h1>\n");
    // Authority claims are derived from the typed provenance fields, never a
    // substring of the operator-controlled `config` prose (round-2 must-fix #4).
    let whole_corpus = provenance.is_whole_corpus();
    let oracle_locked = provenance.is_oracle_locked();
    let scope = if whole_corpus {
        "The complete authoritative TC39 test262 corpus"
    } else {
        "The selected TC39 test262 subtree"
    };
    let oracle_description = if oracle_locked {
        ", oracle-locked to XS"
    } else {
        ", run without the XS oracle gate"
    };
    s.push_str(&format!(
        "<p class=\"lede\">{} run against the Ironhorse engine{}. {} cases.</p>\n",
        scope, oracle_description, total
    ));

    // Provenance.
    s.push_str("<section aria-labelledby=\"prov\">\n<h2 id=\"prov\">Run provenance</h2>\n<dl class=\"prov\">\n");
    let provenance_fields = [
        ("Runner", provenance.runner.as_str()),
        ("test262 revision", provenance.test262_ref.as_str()),
        ("test262 SHA", provenance.test262_sha.as_str()),
        ("endo / Ironhorse SHA", provenance.endo_sha.as_str()),
        ("XS oracle", provenance.oracle.as_str()),
        ("Scope", provenance.scope.as_str()),
        ("Oracle gate", provenance.oracle_mode.as_str()),
        ("SES mode", provenance.ses_mode.as_str()),
        ("Completion", provenance.completion.as_str()),
        ("Command", provenance.command.as_str()),
        ("Config", provenance.config.as_str()),
        ("Run identity", provenance.run_id.as_str()),
        ("Started", provenance.started_at.as_str()),
        ("Finished", provenance.finished_at.as_str()),
        ("Host", provenance.host.as_str()),
    ];
    for (key, value) in provenance_fields {
        s.push_str(&format!(
            "<div><dt>{}</dt><dd>{}</dd></div>\n",
            escape_html(key),
            if value.is_empty() {
                "&mdash;".into()
            } else {
                escape_html(value)
            }
        ));
    }
    s.push_str("</dl>\n</section>\n");

    // Category summary cards.
    s.push_str("<section aria-labelledby=\"totals\">\n<h2 id=\"totals\">Totals by category</h2>\n");
    s.push_str("<ul class=\"cards\">\n");
    let cards = [
        ("Covered", counts.covered, "covered"),
        ("Ironhorse failures", counts.ironhorse_failure, "fail"),
        ("Unsupported", counts.unsupported, "unsupported"),
        ("Skipped", counts.skipped, "skipped"),
        ("Infrastructure", counts.infrastructure, "infra"),
    ];
    for (label, n, cls) in cards {
        s.push_str(&format!(
            "<li class=\"card {}\"><span class=\"num\">{}</span><span class=\"lbl\">{}</span><span class=\"pct\">{}</span></li>\n",
            cls,
            n,
            escape_html(label),
            percentage(n, total)
        ));
    }
    s.push_str("</ul>\n");
    let covered_definition = if oracle_locked {
        "ran end-to-end and agreed bit-exactly with the XS oracle"
    } else {
        "ran end-to-end with the oracle gate disabled"
    };
    s.push_str(&format!(
        "<p class=\"note\">“Covered” = {}. “Ironhorse failures” are bar-forbidden divergences/over-acceptances. “Unsupported” are genuine language gaps (the actionable backlog). “Infrastructure” are oracle/harness non-results, <strong>not</strong> Ironhorse gaps. Totals sum to {} cases.</p>\n",
        covered_definition, total
    ));
    s.push_str("</section>\n");

    // Outcome table.
    s.push_str("<section aria-labelledby=\"outcomes\">\n<h2 id=\"outcomes\">Totals by observed outcome</h2>\n");
    s.push_str("<table>\n<thead><tr><th scope=\"col\">Outcome</th><th scope=\"col\">Count</th><th scope=\"col\">Share</th></tr></thead>\n<tbody>\n");
    for (k, n) in report.totals_by_outcome() {
        s.push_str(&format!(
            "<tr><th scope=\"row\">{}</th><td class=\"n\">{}</td><td class=\"n\">{}</td></tr>\n",
            escape_html(k),
            n,
            percentage(n, total)
        ));
    }
    s.push_str("</tbody>\n</table>\n</section>\n");

    // By subtree.
    s.push_str(
        "<section aria-labelledby=\"bypath\">\n<h2 id=\"bypath\">Breakdown by subtree</h2>\n",
    );
    s.push_str(&category_table(&report.by_path(2)));
    s.push_str("</section>\n");

    // By feature (top 60 by non-covered volume to keep the page bounded).
    s.push_str(
        "<section aria-labelledby=\"byfeature\">\n<h2 id=\"byfeature\">Breakdown by feature</h2>\n",
    );
    let features = report.by_feature();
    let mut feature_rows: Vec<(String, CategoryCounts)> = features.into_iter().collect();
    feature_rows.sort_by(|a, b| {
        let ga = a.1.unsupported + a.1.ironhorse_failure;
        let gb = b.1.unsupported + b.1.ironhorse_failure;
        gb.cmp(&ga).then(a.0.cmp(&b.0))
    });
    let shown = feature_rows.len().min(60);
    s.push_str(&format!(
        "<p class=\"note\">{} features total; showing the {} with the most gaps.</p>\n",
        feature_rows.len(),
        shown
    ));
    let feature_map: BTreeMap<String, CategoryCounts> = feature_rows.into_iter().take(60).collect();
    s.push_str(&category_table(&feature_map));
    s.push_str("</section>\n");

    // Ironhorse failures (named).
    let failures = report.failures();
    s.push_str(
        "<section aria-labelledby=\"failures\">\n<h2 id=\"failures\">Ironhorse failures</h2>\n",
    );
    if failures.is_empty() {
        s.push_str("<p class=\"ok\">None — no bar-forbidden divergence or over-acceptance on any case Ironhorse ran end-to-end.</p>\n");
    } else {
        s.push_str(&format!("<p class=\"note\">{} case(s).</p>\n<table>\n<thead><tr><th scope=\"col\">Case</th><th scope=\"col\">Detail</th></tr></thead>\n<tbody>\n", failures.len()));
        for c in &failures {
            s.push_str(&format!(
                "<tr><td class=\"path\">{}</td><td>{}</td></tr>\n",
                escape_html(&c.path),
                escape_html(&c.reason)
            ));
        }
        s.push_str("</tbody>\n</table>\n");
    }
    s.push_str("</section>\n");

    // Unsupported reasons (named, with samples).
    s.push_str("<section aria-labelledby=\"unsupported\">\n<h2 id=\"unsupported\">Unsupported reasons (language gaps)</h2>\n");
    s.push_str(&reason_table(&report.reasons(Category::Unsupported, 3)));
    s.push_str("</section>\n");

    // Pre-skip reasons (declared/structural).
    s.push_str("<section aria-labelledby=\"skipped\">\n<h2 id=\"skipped\">Skipped reasons (declared &amp; structural)</h2>\n");
    s.push_str(&reason_table(&report.reasons(Category::Skipped, 3)));
    s.push_str("</section>\n");

    // Infrastructure reasons.
    s.push_str("<section aria-labelledby=\"infra\">\n<h2 id=\"infra\">Infrastructure reasons (non-results)</h2>\n");
    s.push_str(&reason_table(&report.reasons(Category::Infrastructure, 3)));
    s.push_str("</section>\n");

    s.push_str("<footer><p>Generated by <code>ironhorse-262-report</code> from per-case <code>ironhorse-xst</code> output. This report is a snapshot; the machine-readable <code>report.json</code> alongside it carries every case.</p></footer>\n");
    s.push_str("</main>\n</body>\n</html>\n");
    s
}

fn category_table(map: &BTreeMap<String, CategoryCounts>) -> String {
    let mut s = String::new();
    s.push_str("<table>\n<thead><tr>");
    s.push_str("<th scope=\"col\">Key</th><th scope=\"col\">Total</th><th scope=\"col\">Covered</th><th scope=\"col\">Failures</th><th scope=\"col\">Unsupported</th><th scope=\"col\">Skipped</th><th scope=\"col\">Infra</th>");
    s.push_str("</tr></thead>\n<tbody>\n");
    // Sort rows by total descending for readability, ties by key.
    let mut rows: Vec<(&String, &CategoryCounts)> = map.iter().collect();
    rows.sort_by(|a, b| b.1.total().cmp(&a.1.total()).then(a.0.cmp(b.0)));
    for (key, counts) in rows {
        s.push_str(&format!(
            "<tr><th scope=\"row\" class=\"path\">{}</th><td class=\"n\">{}</td><td class=\"n\">{}</td><td class=\"n\">{}</td><td class=\"n\">{}</td><td class=\"n\">{}</td><td class=\"n\">{}</td></tr>\n",
            escape_html(key),
            counts.total(),
            counts.covered,
            counts.ironhorse_failure,
            counts.unsupported,
            counts.skipped,
            counts.infrastructure,
        ));
    }
    s.push_str("</tbody>\n</table>\n");
    s
}

fn reason_table(reasons: &[(String, usize, Vec<String>)]) -> String {
    let mut s = String::new();
    if reasons.is_empty() {
        s.push_str("<p class=\"ok\">None.</p>\n");
        return s;
    }
    s.push_str("<table>\n<thead><tr><th scope=\"col\">Reason</th><th scope=\"col\">Count</th><th scope=\"col\">Example cases</th></tr></thead>\n<tbody>\n");
    for (reason, n, examples) in reasons {
        let formatted_examples = examples
            .iter()
            .map(|example| format!("<code>{}</code>", escape_html(example)))
            .collect::<Vec<_>>()
            .join("<br>");
        s.push_str(&format!(
            "<tr><th scope=\"row\" class=\"reason\">{}</th><td class=\"n\">{}</td><td>{}</td></tr>\n",
            escape_html(reason),
            n,
            formatted_examples
        ));
    }
    s.push_str("</tbody>\n</table>\n");
    s
}

/// Inline stylesheet — accessible defaults: system fonts, high-contrast light
/// and dark palettes (`prefers-color-scheme`), semantic tables with a visible
/// focus ring, no color-only signalling (every category is also labelled).
const HTML_CSS: &str = r#"
:root {
  --bg: #ffffff; --fg: #1a1a1a; --muted: #555; --line: #d0d0d0;
  --card: #f4f4f5; --accent: #0b5cad;
  --covered: #1a7f37; --fail: #b3261e; --unsupported: #8a5a00;
  --skipped: #3a3a55; --infra: #555;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171a; --fg: #e8e8e8; --muted: #a8a8a8; --line: #333;
    --card: #1f242a; --accent: #6fb3ff;
    --covered: #4ac26b; --fail: #ff6b60; --unsupported: #e0a53a;
    --skipped: #b0b0d0; --infra: #a8a8a8;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
main { max-width: 72rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
h1 { font-size: 1.7rem; margin: 0 0 .25rem; }
h2 { font-size: 1.2rem; margin: 2rem 0 .75rem; border-bottom: 1px solid var(--line); padding-bottom: .25rem; }
.lede { color: var(--muted); margin-top: 0; }
.note { color: var(--muted); font-size: .9rem; }
.ok { color: var(--covered); font-weight: 600; }
dl.prov { display: grid; grid-template-columns: 1fr; gap: .25rem; margin: 0; }
dl.prov > div { display: grid; grid-template-columns: 12rem 1fr; gap: .5rem;
  padding: .3rem 0; border-bottom: 1px solid var(--line); }
dl.prov dt { font-weight: 600; margin: 0; }
dl.prov dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: .9rem; overflow-wrap: anywhere; }
ul.cards { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: .75rem; }
.card { background: var(--card); border: 1px solid var(--line);
  border-radius: .5rem; padding: .75rem 1rem; min-width: 8.5rem;
  display: flex; flex-direction: column; border-left: .35rem solid var(--muted); }
.card .num { font-size: 1.7rem; font-weight: 700; }
.card .lbl { font-size: .85rem; color: var(--muted); }
.card .pct { font-size: .8rem; color: var(--muted); }
.card.covered { border-left-color: var(--covered); }
.card.fail { border-left-color: var(--fail); }
.card.unsupported { border-left-color: var(--unsupported); }
.card.skipped { border-left-color: var(--skipped); }
.card.infra { border-left-color: var(--infra); }
table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; font-size: .92rem; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
thead th { border-bottom: 2px solid var(--line); position: sticky; top: 0; background: var(--bg); }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
.path, .reason, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; overflow-wrap: anywhere; }
a:focus, :focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
footer { margin-top: 3rem; color: var(--muted); font-size: .85rem; border-top: 1px solid var(--line); padding-top: 1rem; }
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(path: &str, outcome: Outcome, reason: &str, features: &[&str]) -> CaseRecord {
        CaseRecord {
            path: path.to_string(),
            outcome,
            reason: reason.to_string(),
            features: features.iter().map(|s| s.to_string()).collect(),
            strict_skipped: false,
            computron_gap: false,
        }
    }

    #[test]
    fn classify_separates_ironhorse_gaps_from_infrastructure() {
        assert_eq!(classify(Outcome::Covered, ""), Category::Covered);
        assert_eq!(
            classify(Outcome::Fail, "result divergence: ..."),
            Category::IronhorseFailure
        );
        assert_eq!(
            classify(Outcome::RunSkip, "unsupported-opcode:XS_CODE_PROXY"),
            Category::Unsupported
        );
        assert_eq!(
            classify(Outcome::RunSkip, "parse-or-decode"),
            Category::Unsupported
        );
        // Oracle/harness non-results are infrastructure, not Ironhorse gaps.
        assert_eq!(
            classify(Outcome::RunSkip, "oracle-machine-error"),
            Category::Infrastructure
        );
        assert_eq!(
            classify(Outcome::RunSkip, "negative-oracle-unexpected"),
            Category::Infrastructure
        );
        assert_eq!(
            classify(Outcome::PreSkip, "structural:missing-harness:sta.js:x"),
            Category::Infrastructure
        );
        // Declared/structural skips.
        assert_eq!(
            classify(Outcome::PreSkip, "feature:Temporal"),
            Category::Skipped
        );
        assert_eq!(
            classify(Outcome::PreSkip, "structural:module"),
            Category::Skipped
        );
    }

    #[test]
    fn json_round_trips_through_the_yaml_reader() {
        let hostile =
            "quote=\" slash=\\ controls=\n\r\t unicode=\u{85}\u{2028}\u{2029} astral=\u{1f680}";
        let report = RunReport {
            provenance: Provenance {
                test262_sha: "abc123".into(),
                runner: "ironhorse-xst".into(),
                ..Default::default()
            },
            cases: vec![
                rec(
                    "built-ins/Proxy/apply/a.js",
                    Outcome::RunSkip,
                    hostile,
                    &["Proxy", hostile],
                ),
                rec(
                    "language/expressions/addition/b.js",
                    Outcome::Covered,
                    "",
                    &[],
                ),
            ],
        };
        let json = report.to_json();
        // Machine-readable JSON is parseable by the reader, and the case array
        // reads back identically (sorted by path).
        let back = read_cases_from_str(&json);
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].path, "built-ins/Proxy/apply/a.js");
        assert_eq!(back[0].outcome, Outcome::RunSkip);
        assert_eq!(back[0].reason, hostile);
        assert_eq!(
            back[0].features,
            vec!["Proxy".to_string(), hostile.to_string()]
        );
        assert_eq!(back[1].outcome, Outcome::Covered);
        // Stable: emitting twice is byte-identical.
        assert_eq!(json, report.to_json());
    }

    #[test]
    fn provenance_reads_the_shell_wire_shape() {
        let dir = std::env::temp_dir().join(format!("ih262-provenance-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("provenance.json");
        std::fs::write(
            &path,
            r#"{
  "runner": "ironhorse-xst",
  "test262_sha": "abc123",
  "test262_ref": "tc39/test262@abc123",
  "endo_sha": "def456",
  "oracle": "moddable submodule @ 789abc",
  "command": "full-run.sh --subtree <all> --jobs 4 --oracle on",
  "config": "oracle=on max-cases-per-batch=100 jobs=4 subtree=<all>",
  "started_at": "2026-08-08T00:00:00Z",
  "finished_at": "2026-08-08T01:00:00Z",
  "host": "redacted"
}
"#,
        )
        .unwrap();
        let provenance = read_provenance(&path);
        assert_eq!(provenance.runner, "ironhorse-xst");
        assert_eq!(provenance.test262_sha, "abc123");
        assert_eq!(provenance.test262_ref, "tc39/test262@abc123");
        assert_eq!(provenance.endo_sha, "def456");
        assert_eq!(provenance.oracle, "moddable submodule @ 789abc");
        assert!(provenance.command.contains("--jobs 4"));
        assert!(provenance.config.contains("max-cases-per-batch=100"));
        assert_eq!(provenance.started_at, "2026-08-08T00:00:00Z");
        assert_eq!(provenance.finished_at, "2026-08-08T01:00:00Z");
        assert_eq!(provenance.host, "redacted");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn batch_json_reads_back() {
        let cases = vec![
            rec("z/c.js", Outcome::Fail, "over-acceptance", &[]),
            rec("a/b.js", Outcome::Covered, "", &["Symbol"]),
        ];
        let batch = RunReport::batch_json(&cases);
        let back = read_cases_from_str(&batch);
        // Sorted by path on emit.
        assert_eq!(back[0].path, "a/b.js");
        assert_eq!(back[0].features, vec!["Symbol".to_string()]);
        assert_eq!(back[1].outcome, Outcome::Fail);
    }

    #[test]
    fn aggregation_breakdowns_are_deterministic() {
        let report = RunReport {
            provenance: Provenance::default(),
            cases: vec![
                rec(
                    "built-ins/Proxy/a.js",
                    Outcome::RunSkip,
                    "unsupported-opcode:X",
                    &["Proxy"],
                ),
                rec(
                    "built-ins/Proxy/b.js",
                    Outcome::RunSkip,
                    "unsupported-opcode:X",
                    &["Proxy"],
                ),
                rec("built-ins/Array/c.js", Outcome::Covered, "", &[]),
                rec("language/x/d.js", Outcome::Fail, "result divergence", &[]),
            ],
        };
        let byp = report.by_path(2);
        assert_eq!(byp["built-ins/Proxy"].unsupported, 2);
        assert_eq!(byp["built-ins/Array"].covered, 1);
        assert_eq!(byp["language/x"].ironhorse_failure, 1);

        let byf = report.by_feature();
        assert_eq!(byf["Proxy"].unsupported, 2);

        let cc = report.totals_by_category();
        assert_eq!(cc.covered, 1);
        assert_eq!(cc.unsupported, 2);
        assert_eq!(cc.ironhorse_failure, 1);

        // Reasons carry sample case ids.
        let reasons = report.reasons(Category::Unsupported, 5);
        assert_eq!(reasons.len(), 1);
        assert_eq!(reasons[0].0, "unsupported-opcode:X");
        assert_eq!(reasons[0].1, 2);
        assert_eq!(reasons[0].2.len(), 2);
    }

    #[test]
    fn html_carries_provenance_totals_and_named_gaps() {
        let report = RunReport {
            provenance: Provenance {
                test262_sha: "be13516fb6".into(),
                test262_ref: "tc39/test262@be13516".into(),
                endo_sha: "deadbeef".into(),
                oracle: "moddable 8.3.1".into(),
                config: "oracle=on max-cases-per-batch=100 jobs=4 subtree=<all>".into(),
                scope: "whole-corpus".into(),
                oracle_mode: "on".into(),
                runner: "ironhorse-xst".into(),
                ..Default::default()
            },
            cases: vec![
                rec(
                    "built-ins/Proxy/apply/a.js",
                    Outcome::RunSkip,
                    "unsupported-opcode:XS_CODE_x",
                    &["Proxy"],
                ),
                rec(
                    "language/expressions/addition/b.js",
                    Outcome::Covered,
                    "",
                    &[],
                ),
                rec(
                    "built-ins/Array/z.js",
                    Outcome::Fail,
                    "result divergence: oracle=1 ironhorse=2",
                    &[],
                ),
            ],
        };
        let html = to_html(&report);
        // Provenance SHAs are present.
        assert!(html.contains("be13516fb6"));
        assert!(html.contains("tc39/test262@be13516"));
        assert!(html.contains("deadbeef"));
        assert!(html.contains("The complete authoritative TC39 test262 corpus"));
        assert!(html.contains("oracle-locked to XS"));
        // Totals and a named failure with its case id.
        assert!(html.contains("Totals by category"));
        assert!(html.contains("built-ins/Array/z.js"));
        assert!(html.contains("result divergence"));
        // A named unsupported reason with its Proxy case id.
        assert!(html.contains("unsupported-opcode:XS_CODE_x"));
        assert!(html.contains("built-ins/Proxy/apply/a.js"));
        // Well-formed enough: single doctype, balanced main/body/html close.
        assert!(html.starts_with("<!DOCTYPE html>"));
        assert!(html.trim_end().ends_with("</html>"));
        assert_eq!(html.matches("<!DOCTYPE html>").count(), 1);
        assert_eq!(html.matches("</html>").count(), 1);

        let scoped = RunReport {
            provenance: Provenance {
                config: "oracle=off max-cases-per-batch=100 jobs=1 subtree=built-ins/Proxy".into(),
                ..Default::default()
            },
            cases: Vec::new(),
        };
        let scoped_html = to_html(&scoped);
        assert!(scoped_html.contains("The selected TC39 test262 subtree"));
        assert!(scoped_html.contains("without the XS oracle gate"));
        assert!(!scoped_html.contains("The complete authoritative TC39 test262 corpus"));
    }

    #[test]
    fn aggregate_merges_batch_files_deterministically() {
        // Aggregation over a temp results dir with two batch files, one of
        // which is re-run (duplicate path collapses to last-read).
        let dir = std::env::temp_dir().join(format!("ih262-agg-{}-{}", std::process::id(), "t"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let b1 = RunReport::batch_json(&[rec(
            "built-ins__Proxy/a.js",
            Outcome::RunSkip,
            "unsupported-opcode:X",
            &["Proxy"],
        )]);
        let b2 = RunReport::batch_json(&[rec("language/b.js", Outcome::Covered, "", &[])]);
        std::fs::write(dir.join("built-ins__Proxy.json"), b1).unwrap();
        std::fs::write(dir.join("language.json"), b2).unwrap();
        let report = aggregate(&dir, Provenance::default());
        assert_eq!(report.total(), 2);
        assert_eq!(report.totals_by_category().unsupported, 1);
        assert_eq!(report.totals_by_category().covered, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn batch_filename_and_prefix() {
        assert_eq!(
            batch_filename("built-ins/Proxy/apply"),
            "built-ins__Proxy__apply.json"
        );
        assert_eq!(
            path_prefix("built-ins/Proxy/apply/a.js", 2),
            "built-ins/Proxy"
        );
        assert_eq!(path_prefix("language/expr/x.js", 2), "language/expr");
        assert_eq!(path_prefix("a.js", 2), "a.js");
    }

    #[test]
    fn pending_batches_is_the_resume_plan() {
        // The interrupted-run resume contract: only a valid parsed batch is
        // skipped. Empty, absent, and non-empty truncated files stay pending.
        let dir = std::env::temp_dir().join(format!("ih262-plan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let all = vec![
            "built-ins/Proxy".to_string(),
            "built-ins/Array".to_string(),
            "language/x".to_string(),
            "language/y".to_string(),
        ];
        // Proxy done; Array a zero-length partial; language/x absent.
        std::fs::write(
            dir.join(batch_filename("built-ins/Proxy")),
            RunReport::batch_json(&[]),
        )
        .unwrap();
        std::fs::write(dir.join(batch_filename("built-ins/Array")), "").unwrap();
        std::fs::write(
            dir.join(batch_filename("language/y")),
            "{ \"schema\": \"ironhorse-test262-batch/1\", \"cases\": [",
        )
        .unwrap();
        let pending = pending_batches(&dir, &all);
        assert_eq!(
            pending,
            vec![
                "built-ins/Array".to_string(),
                "language/x".to_string(),
                "language/y".to_string()
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn classify_unknown_run_skip_is_infrastructure_not_ironhorse() {
        // An unrecognized RunSkip reason must NOT be charged to Ironhorse: the
        // category split exists to separate an engine gap from an oracle/harness
        // non-result, so a new/unknown family stays Infrastructure until it is
        // explicitly classified (round-1 should-fix `assessor`, pinned here).
        assert_eq!(
            classify(Outcome::RunSkip, "some-brand-new-reason-family:x"),
            Category::Infrastructure
        );
        assert_eq!(classify(Outcome::RunSkip, ""), Category::Infrastructure);
        // A known Ironhorse family stays Unsupported.
        assert_eq!(
            classify(Outcome::RunSkip, "unsupported-opcode:XS_CODE_x"),
            Category::Unsupported
        );
    }

    #[test]
    fn classify_ses_and_strict_preskips_are_engine_gaps() {
        // Round-2 must-fix #5: an SES-mode / strict-only pre-skip is a genuine
        // engine gap (the actionable backlog), not a declared/structural skip.
        assert_eq!(
            classify(Outcome::PreSkip, "ses-mode:lockdown-unimplemented"),
            Category::Unsupported
        );
        assert_eq!(
            classify(Outcome::PreSkip, "ses-mode:compartment-unimplemented"),
            Category::Unsupported
        );
        assert_eq!(
            classify(Outcome::PreSkip, "onlyStrict:strict-mode-unimplemented"),
            Category::Unsupported
        );
        // A declared feature skip and a structural shape stay Skipped.
        assert_eq!(
            classify(Outcome::PreSkip, "feature:Temporal"),
            Category::Skipped
        );
        assert_eq!(
            classify(Outcome::PreSkip, "structural:module"),
            Category::Skipped
        );
    }

    #[test]
    fn batch_cap_is_single_sourced() {
        // The orchestrator reads the partition cap through this accessor rather
        // than repeating the literal, so `--batch-size` and discovery cannot
        // drift (round-2 must-fix #2).
        assert_eq!(batch_case_limit(), BATCH_CASE_LIMIT);
    }

    #[test]
    fn discovery_chunks_exactly_at_the_cap_boundary() {
        // The actual partition boundary, not a test-local restatement (round-2
        // must-fix #2/#7): a directory holding cap+1 direct cases discovers
        // exactly two chunks; cap cases discover one. This catches a discovery
        // cap that drifts from `BATCH_CASE_LIMIT`.
        let dir = std::env::temp_dir().join(format!("ih262-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sub = dir.join("test").join("built-ins").join("Boundary");
        std::fs::create_dir_all(&sub).unwrap();
        let cap = batch_case_limit();
        for i in 0..(cap + 1) {
            std::fs::write(sub.join(format!("case-{:05}.js", i)), "1;").unwrap();
        }
        // A `_FIXTURE.js` helper never counts toward the cap.
        std::fs::write(sub.join("helper_FIXTURE.js"), "0;").unwrap();
        let batches = discover_batches(&dir.join("test"));
        let boundary: Vec<&String> = batches
            .iter()
            .filter(|b| b.starts_with("built-ins/Boundary@@"))
            .collect();
        assert_eq!(
            boundary.len(),
            2,
            "cap+1 direct cases must partition into exactly 2 chunks, got {:?}",
            boundary
        );
        assert!(boundary.iter().any(|b| b.ends_with("@@0000")));
        assert!(boundary.iter().any(|b| b.ends_with("@@0001")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pending_is_run_identity_aware() {
        // A results dir reused after a result-affecting input changed must
        // re-run the affected batch, not retain the stale result (round-2
        // must-fix #1). A batch stamped with a DIFFERENT run_id is pending; the
        // same run_id is skipped; a legacy (unstamped) batch is skipped.
        let dir = std::env::temp_dir().join(format!("ih262-idpend-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let all = vec!["built-ins/Proxy".to_string(), "language/x".to_string()];
        std::fs::write(
            dir.join(batch_filename("built-ins/Proxy")),
            RunReport::batch_json_with_id("run-A", &[rec("built-ins/Proxy/a.js", Outcome::Covered, "", &[])]),
        )
        .unwrap();
        std::fs::write(
            dir.join(batch_filename("language/x")),
            RunReport::batch_json(&[rec("language/x/b.js", Outcome::Covered, "", &[])]),
        )
        .unwrap();
        // Same identity as the stamped batch: only the legacy one is not-mismatched
        // (both are treated as present).
        let same = pending_batches_checked(&dir, &all, Some("run-A"));
        assert!(same.is_empty(), "matching + legacy batches are complete: {:?}", same);
        // A different identity: the stamped batch is now pending; the legacy
        // (unstamped) batch is still treated as matching.
        let changed = pending_batches_checked(&dir, &all, Some("run-B"));
        assert_eq!(changed, vec!["built-ins/Proxy".to_string()]);
        // No expected identity: identity is ignored (the unbound path).
        assert!(pending_batches_checked(&dir, &all, None).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn aggregate_plan_binds_identity_and_ignores_foreign_files() {
        // The trustworthy aggregation (round-2 must-fix #1): aggregate exactly
        // the plan, collapse a duplicate path (last-read wins) counted once,
        // reject a batch stamped with a different identity, and never read a
        // stale file the plan does not name.
        let dir = std::env::temp_dir().join(format!("ih262-aggplan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Two batches at run-A; the SAME case path appears in both (a re-run),
        // once RunSkip then Covered — last-read (sorted file order) must win.
        std::fs::write(
            dir.join(batch_filename("a@@0000")),
            RunReport::batch_json_with_id(
                "run-A",
                &[rec("built-ins/Dup/x.js", Outcome::RunSkip, "unsupported-opcode:X", &["Proxy"])],
            ),
        )
        .unwrap();
        std::fs::write(
            dir.join(batch_filename("b@@0000")),
            RunReport::batch_json_with_id("run-A", &[rec("built-ins/Dup/x.js", Outcome::Covered, "", &[])]),
        )
        .unwrap();
        // A STALE/FOREIGN file not named by the plan: must be ignored entirely.
        std::fs::write(
            dir.join(batch_filename("foreign@@0000")),
            RunReport::batch_json_with_id("run-A", &[rec("language/foreign.js", Outcome::Fail, "x", &[])]),
        )
        .unwrap();
        let provenance = Provenance {
            run_id: "run-A".into(),
            ..Default::default()
        };
        let plan = vec!["a@@0000".to_string(), "b@@0000".to_string()];
        let (report, warnings) = aggregate_plan(&dir, &plan, provenance);
        assert!(warnings.is_empty(), "no warnings expected: {:?}", warnings);
        // Duplicate path collapsed to one, last-read (Covered) won, foreign
        // Fail excluded.
        assert_eq!(report.total(), 1);
        assert_eq!(report.cases[0].path, "built-ins/Dup/x.js");
        assert_eq!(report.cases[0].outcome, Outcome::Covered);
        assert_eq!(report.totals_by_category().ironhorse_failure, 0);

        // A batch stamped with a mismatched identity is rejected (warned), not merged.
        std::fs::write(
            dir.join(batch_filename("c@@0000")),
            RunReport::batch_json_with_id("run-OTHER", &[rec("language/c.js", Outcome::Covered, "", &[])]),
        )
        .unwrap();
        let provenance = Provenance {
            run_id: "run-A".into(),
            ..Default::default()
        };
        let plan = vec!["a@@0000".to_string(), "c@@0000".to_string(), "missing@@0000".to_string()];
        let (report, warnings) = aggregate_plan(&dir, &plan, provenance);
        assert_eq!(report.total(), 1, "only the matching batch merged");
        assert_eq!(warnings.len(), 2, "one identity-mismatch + one missing: {:?}", warnings);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_provenance_reads_the_typed_fields() {
        // The whole wire between full-run.sh's heredoc and the report, pinned on
        // the exact keys the shell writes (round-2 must-fix #4): the typed scope/
        // oracle/ses/completion/run_id fields read back as authored, and the HTML
        // authority claims derive from them.
        let dir = std::env::temp_dir().join(format!("ih262-typedprov-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("provenance.json");
        std::fs::write(
            &path,
            r#"{
  "runner": "ironhorse-xst",
  "test262_sha": "unknown",
  "test262_ref": "unverified",
  "endo_sha": "def456",
  "oracle": "moddable submodule @ 789abc",
  "command": "full-run.sh --subtree <all> --jobs 4 --oracle on",
  "config": "oracle=on max-cases-per-batch=100 jobs=4 subtree=<all>",
  "scope": "whole-corpus",
  "oracle_mode": "on",
  "ses_mode": "none",
  "completion": "complete",
  "run_id": "test262=unknown;endo=def456;oracle=on;ses=none;cap=100;scope=<all>",
  "started_at": "2026-08-08T00:00:00Z",
  "finished_at": "2026-08-08T01:00:00Z",
  "host": "redacted"
}
"#,
        )
        .unwrap();
        let p = read_provenance(&path);
        assert_eq!(p.scope, "whole-corpus");
        assert_eq!(p.oracle_mode, "on");
        assert_eq!(p.ses_mode, "none");
        assert_eq!(p.completion, "complete");
        assert!(p.run_id.contains("cap=100"));
        assert!(p.is_whole_corpus());
        assert!(p.is_oracle_locked());
        // The HTML renders the whole-corpus / oracle-locked claim from the typed
        // fields — NOT a substring of a crafted config.
        let html = to_html(&RunReport {
            provenance: p,
            cases: Vec::new(),
        });
        assert!(html.contains("The complete authoritative TC39 test262 corpus"));
        assert!(html.contains("oracle-locked to XS"));

        // A crafted config claiming the whole corpus, but typed fields saying
        // subtree/oracle-off, must render the HONEST (typed) claim.
        let crafted = Provenance {
            config: "oracle=on subtree=<all> (crafted)".into(),
            scope: "subtree=built-ins/Proxy".into(),
            oracle_mode: "off".into(),
            ..Default::default()
        };
        let crafted_html = to_html(&RunReport {
            provenance: crafted,
            cases: Vec::new(),
        });
        assert!(crafted_html.contains("The selected TC39 test262 subtree"));
        assert!(crafted_html.contains("without the XS oracle gate"));
        assert!(!crafted_html.contains("The complete authoritative TC39 test262 corpus"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discovery_partitions_the_whole_tree() {
        // Discovery-completeness: the bounded batches cover the ENTIRE
        // official `test/**` tree with no overlap and no curated-subtree filter
        // — the union of every batch's direct files equals the whole recursive
        // walk. This is the guard against silently hiding an unsupported
        // feature behind a filtered subtree.
        use crate::test262::{collect_js, collect_js_flat, locate_test262};
        use std::collections::BTreeSet;
        let (root, _harness) = match locate_test262() {
            Some(p) => p,
            None => {
                eprintln!("test262 subset absent; skipping discovery-completeness");
                return;
            }
        };
        let batches = discover_batches(&root);
        assert!(!batches.is_empty());
        // Proxy is discovered (the maintainer's explicit check target).
        assert!(
            batches
                .iter()
                .any(|batch| batch.starts_with("built-ins/Proxy@@")
                    || batch.starts_with("built-ins/Proxy/")),
            "built-ins/Proxy must be discovered"
        );
        // `staging/` is excluded, exactly as the runner excludes it.
        assert!(
            batches
                .iter()
                .all(|b| b != "staging" && !b.starts_with("staging/")),
            "staging/ must be excluded"
        );
        // Completeness + partition: every case appears in exactly one capped batch,
        // and the union is the whole tree.
        let mut from_batches: BTreeSet<PathBuf> = BTreeSet::new();
        for batch in &batches {
            let (directory, index_text) = batch.rsplit_once("@@").unwrap();
            let index: usize = index_text.parse().unwrap();
            let files = collect_js_flat(&root.join(directory));
            let chunk: Vec<PathBuf> = files
                .into_iter()
                .skip(index * BATCH_CASE_LIMIT)
                .take(BATCH_CASE_LIMIT)
                .collect();
            assert!(chunk.len() <= BATCH_CASE_LIMIT);
            for file in chunk {
                assert!(
                    from_batches.insert(file.clone()),
                    "case in two batches: {:?}",
                    file
                );
            }
        }
        let whole: BTreeSet<PathBuf> = collect_js(&root).into_iter().collect();
        assert_eq!(
            from_batches, whole,
            "bounded batches must partition the entire test/** tree"
        );
    }

    #[test]
    fn proxy_is_observed_unimplemented_via_oracle_slice() {
        // The maintainer's explicit Proxy check (kriskowal/garden#51: "Proxy is
        // evidently not implemented. Please check."), as a committed,
        // reproducible, real-oracle-backed slice: run a bounded set of OFFICIAL
        // Proxy cases through the full runner and REPORT the observed result
        // rather than assuming absence. Today the observed result is that no
        // Proxy case runs end-to-end (every one is an honest unsupported gap,
        // none a false covered/failure); this assertion flips the day Proxy
        // lands, turning the report's Proxy row green.
        use crate::test262::{collect_js, locate_test262};
        use crate::xst::{run_files, Config};
        let (root, harness) = match locate_test262() {
            Some(p) => p,
            None => {
                eprintln!("test262 subset absent; skipping the Proxy oracle slice");
                return;
            }
        };
        // Bounded slice (apply + revocable) so the oracle RSS stays contained;
        // the whole-tree Proxy sweep is the `ironhorse-xst`/full-run path.
        let mut files = Vec::new();
        for s in ["built-ins/Proxy/apply", "built-ins/Proxy/revocable"] {
            files.extend(collect_js(&root.join(s)));
        }
        assert!(
            !files.is_empty(),
            "the subset must carry official Proxy cases"
        );
        let rep = run_files(&Config::default(), &harness, &root, &files);
        let report = RunReport {
            provenance: Provenance::default(),
            cases: rep.cases.clone(),
        };
        let cc = report.totals_by_category();
        eprintln!(
            "Proxy oracle slice: total={} covered={} unsupported={} failures={} infra={}",
            report.total(),
            cc.covered,
            cc.unsupported,
            cc.ironhorse_failure,
            cc.infrastructure
        );
        for (reason, n, _ex) in report.reasons(Category::Unsupported, 1) {
            eprintln!("    {:>4}  {}", n, reason);
        }
        assert!(report.total() > 0);
        // Observed, not assumed: Proxy is not implemented.
        assert_eq!(cc.covered, 0, "no Proxy case runs end-to-end today");
        assert_eq!(
            cc.ironhorse_failure, 0,
            "the honest split never manufactures a Proxy failure"
        );
        assert!(
            cc.unsupported > 0,
            "Proxy cases are honest unsupported gaps, not infra non-results"
        );
    }
}
