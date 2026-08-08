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
//!   per-directory batches and skip the ones already on disk after an
//!   interruption.
//!
//! JSON is emitted by hand (like the sibling YAML in [`crate::xst`], keeping the
//! crate free of a serde dependency) and read back through `yaml-rust2` (JSON is
//! a subset of YAML, so the frontmatter parser's dependency doubles as the
//! reader) — see [`read_report`] / [`read_provenance`].

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
            // A missing harness file or an unreadable case is infrastructure;
            // everything else pre-skipped is a declared/structural skip.
            if reason.starts_with("structural:missing-harness") || reason == "unreadable" {
                Category::Infrastructure
            } else {
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
                // The oracle could not RUN a valid source (a fatal host abort:
                // XS's fixed-geometry value-stack overflow on a wide frame), or
                // failed to TERMINATE where ironhorse does — an oracle / host
                // non-result on a program the differential cannot cover, never
                // an ironhorse gap. (Toggle knob: move these two prefixes out of
                // INFRA to score them `unsupported` instead.)
                "oracle-host-stack-limit",
                "oracle-nontermination",
                // A crash INSIDE ironhorse-compile while assembling a case is a
                // harness defect, not a language gap.
                "harness-assembly",
            ];
            if INFRA.iter().any(|p| reason.starts_with(p)) {
                Category::Infrastructure
            } else {
                // unsupported-opcode:*, parse-or-decode, non-primitive-completion,
                // builtin-coercion-computron-gap, abort-value-differs,
                // ironhorse-aborted*, negative-<phase>:runtime-reject,
                // negative-<phase>:oracle-compiler-path, negative-type-unmatched:*,
                // async:* — all Ironhorse coverage gaps.
                Category::Unsupported
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
        let mut cc = CategoryCounts::default();
        for c in &self.cases {
            cc.add(c.category());
        }
        cc
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
        let mut v: Vec<(String, usize, Vec<String>)> =
            counts.into_iter().map(|(k, (n, ex))| (k, n, ex)).collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        v
    }

    /// The stable, machine-readable JSON: provenance, summary totals, and the
    /// full case array sorted by path. Key order is fixed and every collection
    /// is sorted, so the same run produces byte-identical output.
    pub fn to_json(&self) -> String {
        let mut cases = self.cases.clone();
        cases.sort_by(|a, b| a.path.cmp(&b.path));
        let cc = self.totals_by_category();
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
                cc.get(*cat),
                comma
            ));
        }
        s.push_str("    }\n");
        s.push_str("  },\n");

        // cases
        s.push_str("  \"cases\": [\n");
        for (i, c) in cases.iter().enumerate() {
            let comma = if i + 1 < cases.len() { "," } else { "" };
            let feats = c
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
                feats,
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
    pub fn to_batch_json(cases: &[CaseRecord]) -> String {
        let mut cases = cases.to_vec();
        cases.sort_by(|a, b| a.path.cmp(&b.path));
        let mut s = String::new();
        s.push_str("{ \"cases\": [\n");
        for (i, c) in cases.iter().enumerate() {
            let comma = if i + 1 < cases.len() { "," } else { "" };
            let feats = c
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
                feats,
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
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    read_cases_from_str(&text)
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
    Provenance {
        test262_sha: yaml_str(&doc["test262_sha"]),
        test262_ref: yaml_str(&doc["test262_ref"]),
        endo_sha: yaml_str(&doc["endo_sha"]),
        oracle: yaml_str(&doc["oracle"]),
        command: yaml_str(&doc["command"]),
        config: yaml_str(&doc["config"]),
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

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/// Merge every batch file in `results_dir` (any `*.json` except a reserved
/// aggregate name) with the provenance, into one deterministic [`RunReport`].
/// Duplicate paths (a batch re-run after an interruption) collapse to the
/// last-read record; the final case list is sorted by path.
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

// ---------------------------------------------------------------------------
// Discovery + resume planning
// ---------------------------------------------------------------------------

/// Discover the per-directory batches under a test262 `test/` root: every
/// directory that **directly** contains at least one non-fixture `.js` case,
/// as a path relative to the root. `staging/` and its descendants are excluded
/// (the runner excludes them too). Per-directory granularity is the batching
/// that bounds the XS oracle's process-RSS retention — each batch is one
/// process that frees everything on exit — and gives fine-grained resume.
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
    let mut has_direct_case = false;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().map(|n| n == "staging").unwrap_or(false) {
                continue;
            }
            subdirs.push(path);
        } else if path.extension().map(|e| e == "js").unwrap_or(false) {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if !name.ends_with("_FIXTURE.js") {
                has_direct_case = true;
            }
        }
    }
    if has_direct_case {
        if let Ok(rel) = dir.strip_prefix(root) {
            let r = rel.to_string_lossy().into_owned();
            if !r.is_empty() {
                out.push(r);
            }
        }
    }
    subdirs.sort();
    for sub in subdirs {
        discover_into(root, &sub, out);
    }
}

/// The batches from `all` that have **not** yet been run — those whose result
/// file is absent (or empty) in `results_dir`. This is the resume plan: after
/// an interruption, the completed per-directory batch files remain on disk and
/// are skipped, so a re-run continues where it stopped.
pub fn pending_batches(results_dir: &Path, all: &[String]) -> Vec<String> {
    all.iter()
        .filter(|b| {
            let f = results_dir.join(batch_filename(b));
            match std::fs::metadata(&f) {
                Ok(m) => m.len() == 0,
                Err(_) => true,
            }
        })
        .cloned()
        .collect()
}

// ---------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------

/// HTML-escape text for a self-contained static report (no template engine).
fn h(s: &str) -> String {
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

fn pct(n: usize, total: usize) -> String {
    if total == 0 {
        "0.0%".to_string()
    } else {
        format!("{:.1}%", (n as f64) * 100.0 / (total as f64))
    }
}

/// Render the full-run report as one self-contained, accessible static HTML
/// document (inline CSS, no external assets — drops straight into gh-pages).
/// It carries the provenance, the outcome/category totals, breakdowns by
/// category, by subtree, and by feature, the named Ironhorse failures, and the
/// most-frequent unsupported reasons with sample case identifiers.
pub fn to_html(report: &RunReport) -> String {
    let p = &report.provenance;
    let total = report.total();
    let cc = report.totals_by_category();
    let mut s = String::new();

    s.push_str("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n");
    s.push_str("<meta charset=\"utf-8\">\n");
    s.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
    s.push_str("<title>Ironhorse test262 conformance report</title>\n");
    s.push_str("<style>\n");
    s.push_str(HTML_CSS);
    s.push_str("</style>\n</head>\n<body>\n<main>\n");

    s.push_str("<h1>Ironhorse test262 conformance report</h1>\n");
    s.push_str(&format!(
        "<p class=\"lede\">The complete authoritative TC39 test262 corpus run against the Ironhorse engine, oracle-locked to XS. {} cases.</p>\n",
        total
    ));

    // Provenance.
    s.push_str("<section aria-labelledby=\"prov\">\n<h2 id=\"prov\">Run provenance</h2>\n<dl class=\"prov\">\n");
    let prov = [
        ("Runner", p.runner.as_str()),
        ("test262 revision", p.test262_ref.as_str()),
        ("test262 SHA", p.test262_sha.as_str()),
        ("endo / Ironhorse SHA", p.endo_sha.as_str()),
        ("XS oracle", p.oracle.as_str()),
        ("Command", p.command.as_str()),
        ("Config", p.config.as_str()),
        ("Started", p.started_at.as_str()),
        ("Finished", p.finished_at.as_str()),
        ("Host", p.host.as_str()),
    ];
    for (k, v) in prov {
        s.push_str(&format!(
            "<div><dt>{}</dt><dd>{}</dd></div>\n",
            h(k),
            if v.is_empty() { "&mdash;".into() } else { h(v) }
        ));
    }
    s.push_str("</dl>\n</section>\n");

    // Category summary cards.
    s.push_str("<section aria-labelledby=\"totals\">\n<h2 id=\"totals\">Totals by category</h2>\n");
    s.push_str("<ul class=\"cards\">\n");
    let cards = [
        ("Covered", cc.covered, "covered"),
        ("Ironhorse failures", cc.ironhorse_failure, "fail"),
        ("Unsupported", cc.unsupported, "unsupported"),
        ("Skipped", cc.skipped, "skipped"),
        ("Infrastructure", cc.infrastructure, "infra"),
    ];
    for (label, n, cls) in cards {
        s.push_str(&format!(
            "<li class=\"card {}\"><span class=\"num\">{}</span><span class=\"lbl\">{}</span><span class=\"pct\">{}</span></li>\n",
            cls, n, h(label), pct(n, total)
        ));
    }
    s.push_str("</ul>\n");
    s.push_str(&format!(
        "<p class=\"note\">“Covered” = ran end-to-end and agreed bit-exactly with the XS oracle. “Ironhorse failures” are bar-forbidden divergences/over-acceptances. “Unsupported” are genuine language gaps (the actionable backlog). “Infrastructure” are oracle/harness non-results, <strong>not</strong> Ironhorse gaps. Totals sum to {} cases.</p>\n",
        total
    ));
    s.push_str("</section>\n");

    // Outcome table.
    s.push_str("<section aria-labelledby=\"outcomes\">\n<h2 id=\"outcomes\">Totals by observed outcome</h2>\n");
    s.push_str("<table>\n<thead><tr><th scope=\"col\">Outcome</th><th scope=\"col\">Count</th><th scope=\"col\">Share</th></tr></thead>\n<tbody>\n");
    for (k, n) in report.totals_by_outcome() {
        s.push_str(&format!(
            "<tr><th scope=\"row\">{}</th><td class=\"n\">{}</td><td class=\"n\">{}</td></tr>\n",
            h(k),
            n,
            pct(n, total)
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
    let feats = report.by_feature();
    let mut feat_rows: Vec<(String, CategoryCounts)> = feats.into_iter().collect();
    feat_rows.sort_by(|a, b| {
        let ga = a.1.unsupported + a.1.ironhorse_failure;
        let gb = b.1.unsupported + b.1.ironhorse_failure;
        gb.cmp(&ga).then(a.0.cmp(&b.0))
    });
    let shown = feat_rows.len().min(60);
    s.push_str(&format!(
        "<p class=\"note\">{} features total; showing the {} with the most gaps.</p>\n",
        feat_rows.len(),
        shown
    ));
    let feat_map: BTreeMap<String, CategoryCounts> = feat_rows.into_iter().take(60).collect();
    s.push_str(&category_table(&feat_map));
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
                h(&c.path),
                h(&c.reason)
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
    for (k, cc) in rows {
        s.push_str(&format!(
            "<tr><th scope=\"row\" class=\"path\">{}</th><td class=\"n\">{}</td><td class=\"n\">{}</td><td class=\"n\">{}</td><td class=\"n\">{}</td><td class=\"n\">{}</td><td class=\"n\">{}</td></tr>\n",
            h(k),
            cc.total(),
            cc.covered,
            cc.ironhorse_failure,
            cc.unsupported,
            cc.skipped,
            cc.infrastructure,
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
        let ex = examples
            .iter()
            .map(|e| format!("<code>{}</code>", h(e)))
            .collect::<Vec<_>>()
            .join("<br>");
        s.push_str(&format!(
            "<tr><th scope=\"row\" class=\"reason\">{}</th><td class=\"n\">{}</td><td>{}</td></tr>\n",
            h(reason),
            n,
            ex
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
                    "unsupported-opcode:XS_CODE_x",
                    &["Proxy"],
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
        assert_eq!(back[0].features, vec!["Proxy".to_string()]);
        assert_eq!(back[1].outcome, Outcome::Covered);
        // Stable: emitting twice is byte-identical.
        assert_eq!(json, report.to_json());
    }

    #[test]
    fn batch_json_reads_back() {
        let cases = vec![
            rec("z/c.js", Outcome::Fail, "over-acceptance", &[]),
            rec("a/b.js", Outcome::Covered, "", &["Symbol"]),
        ];
        let batch = RunReport::to_batch_json(&cases);
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
    }

    #[test]
    fn aggregate_merges_batch_files_deterministically() {
        // Aggregation over a temp results dir with two batch files, one of
        // which is re-run (duplicate path collapses to last-read).
        let dir = std::env::temp_dir().join(format!("ih262-agg-{}-{}", std::process::id(), "t"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let b1 = RunReport::to_batch_json(&[rec(
            "built-ins__Proxy/a.js",
            Outcome::RunSkip,
            "unsupported-opcode:X",
            &["Proxy"],
        )]);
        let b2 = RunReport::to_batch_json(&[rec("language/b.js", Outcome::Covered, "", &[])]);
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
        // The interrupted-run resume contract: a completed (non-empty) batch
        // file is skipped; an absent file OR a zero-length partial (a crashed
        // process before the atomic rename) is still pending.
        let dir = std::env::temp_dir().join(format!("ih262-plan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let all = vec![
            "built-ins/Proxy".to_string(),
            "built-ins/Array".to_string(),
            "language/x".to_string(),
        ];
        // Proxy done; Array a zero-length partial; language/x absent.
        std::fs::write(
            dir.join(batch_filename("built-ins/Proxy")),
            "{ \"cases\": [] }",
        )
        .unwrap();
        std::fs::write(dir.join(batch_filename("built-ins/Array")), "").unwrap();
        let pending = pending_batches(&dir, &all);
        assert_eq!(
            pending,
            vec!["built-ins/Array".to_string(), "language/x".to_string()]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discovery_partitions_the_whole_tree() {
        // Discovery-completeness: the per-directory batches cover the ENTIRE
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
                .any(|b| b == "built-ins/Proxy" || b.starts_with("built-ins/Proxy/")),
            "built-ins/Proxy must be discovered"
        );
        // `staging/` is excluded, exactly as the runner excludes it.
        assert!(
            batches
                .iter()
                .all(|b| b != "staging" && !b.starts_with("staging/")),
            "staging/ must be excluded"
        );
        // Completeness + partition: every case appears in exactly one batch,
        // and the union is the whole tree.
        let mut from_batches: BTreeSet<PathBuf> = BTreeSet::new();
        for b in &batches {
            for f in collect_js_flat(&root.join(b)) {
                assert!(
                    from_batches.insert(f.clone()),
                    "case in two batches: {:?}",
                    f
                );
            }
        }
        let whole: BTreeSet<PathBuf> = collect_js(&root).into_iter().collect();
        assert_eq!(
            from_batches, whole,
            "per-directory batches must partition the entire test/** tree"
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
