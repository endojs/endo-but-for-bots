//! Committed, parameterized test262 expectation lists and the
//! two-directional ratchet (design
//! [`designs/test262-fixture-consolidation.md`] § The expectation-list
//! mechanism).
//!
//! Today the runner is green iff it produces zero `Fail`
//! ([`crate::xst::XstReport::met_bar`]); a case that flips skip->covered or
//! covered->skip is silently absorbed into the aggregate counts. This module
//! externalizes the per-(case, mode) expectation into a committed, diff-
//! friendly list so **both** flip directions surface as a reviewable ratchet
//! event, keyed by the tuple the directive names: engine, mode, feature-set.
//!
//! The list format is a flat text file, one entry per line, so a ratchet
//! shows up as a small patch to the committed list:
//!
//! ```text
//! # engine=ironhorse features=default corpus=upstream tip=<sha>
//! language/expressions/addition/S11.6.1_A1.js sloppy skip:unsupported-opcode:add
//! language/expressions/addition/S11.6.1_A1.js strict skip:strict-unimplemented
//! language/expressions/addition/11.6.1-1.js  sloppy pass
//! ```
//!
//! The header records the `corpus` a list scores, so every annotated slice of
//! the shared test262 tree uses the same parser and comparator.

use std::collections::BTreeMap;

/// The per-(case, mode) outcome an expectation records. `Skip` carries the
/// honest named reason (the unsupported opcode, the structural shape, the
/// not-implemented feature) so the committed list *is* the serialized
/// honest-skip ledger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Pass,
    Fail,
    Skip(String),
}

impl Outcome {
    /// Serialize to the list token: `pass` / `fail` / `skip:<reason>`.
    pub fn serialize(&self) -> String {
        match self {
            Outcome::Pass => "pass".to_string(),
            Outcome::Fail => "fail".to_string(),
            Outcome::Skip(reason) => format!("skip:{}", reason),
        }
    }

    /// Parse a list token back to an outcome. A `skip` with no reason reads
    /// as an empty-reason skip; anything else is `None`.
    pub fn parse(token: &str) -> Option<Outcome> {
        match token {
            "pass" => Some(Outcome::Pass),
            "fail" => Some(Outcome::Fail),
            _ => token
                .strip_prefix("skip:")
                .or_else(|| (token == "skip").then_some(""))
                .map(|reason| Outcome::Skip(reason.to_string())),
        }
    }
}

/// The two run modes `xst262.c`'s default two-run selects between (design §
/// Parameterization axes). `raw`/`noStrict`/`onlyStrict` collapse the pair
/// upstream in [`crate::xst::strict_mode_status`]; this type only names the
/// axis a recorded outcome sits on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Mode {
    Sloppy,
    Strict,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Sloppy => "sloppy",
            Mode::Strict => "strict",
        }
    }

    pub fn parse(token: &str) -> Option<Mode> {
        match token {
            "sloppy" => Some(Mode::Sloppy),
            "strict" => Some(Mode::Strict),
            _ => None,
        }
    }
}

/// A committed list's provenance header: the tuple it scores and the tip it
/// was generated at (design § File format).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Header {
    pub engine: String,
    pub features: String,
    pub corpus: String,
    pub tip: String,
}

/// The key an expectation is stored under: a corpus-relative case path plus
/// the mode. Ordered so serialization is deterministic (a stable diff).
pub type Key = (String, Mode);

/// A committed expectation list, or the observed outcomes of a run (the two
/// share the map shape so a run serializes directly to a list).
#[derive(Debug, Default, Clone)]
pub struct Expectations {
    pub header: Header,
    pub entries: BTreeMap<Key, Outcome>,
}

impl Expectations {
    pub fn new(header: Header) -> Expectations {
        Expectations {
            header,
            entries: BTreeMap::new(),
        }
    }

    /// Record one observed (case, mode) outcome. A later record for the same
    /// key overwrites (a run visits each key once).
    pub fn record(&mut self, path: &str, mode: Mode, outcome: Outcome) {
        self.entries.insert((path.to_string(), mode), outcome);
    }

    /// Serialize to the flat committed-list text. Deterministic order
    /// (`BTreeMap`), so re-generation at the same state is a byte-identical
    /// file and a ratchet is a minimal diff.
    pub fn to_text(&self) -> String {
        let mut s = String::new();
        s.push_str(&format!(
            "# engine={} features={} corpus={} tip={}\n",
            self.header.engine, self.header.features, self.header.corpus, self.header.tip
        ));
        for ((path, mode), outcome) in &self.entries {
            s.push_str(&format!(
                "{} {} {}\n",
                path,
                mode.as_str(),
                outcome.serialize()
            ));
        }
        s
    }

    /// Parse a committed list. Blank lines and `#` comment lines are ignored
    /// except a leading `# key=value ...` header line, whose recognized keys
    /// populate [`Header`]. A malformed entry line is an error naming the
    /// line, so a hand-edit typo fails loudly rather than silently dropping a
    /// case from the gate.
    pub fn parse(text: &str) -> Result<Expectations, String> {
        let mut exp = Expectations::default();
        for (i, raw) in text.lines().enumerate() {
            let line = raw.trim();
            if line.is_empty() {
                continue;
            }
            if let Some(rest) = line.strip_prefix('#') {
                // Only the first comment carrying `engine=`/`corpus=` is read
                // as the header; other comments are free text.
                if rest.contains("engine=") || rest.contains("corpus=") {
                    for kv in rest.split_whitespace() {
                        match kv.split_once('=') {
                            Some(("engine", v)) => exp.header.engine = v.to_string(),
                            Some(("features", v)) => exp.header.features = v.to_string(),
                            Some(("corpus", v)) => exp.header.corpus = v.to_string(),
                            Some(("tip", v)) => exp.header.tip = v.to_string(),
                            _ => {}
                        }
                    }
                }
                continue;
            }
            let mut parts = line.splitn(3, char::is_whitespace);
            let path = parts.next().unwrap_or("");
            let mode = parts
                .next()
                .and_then(Mode::parse)
                .ok_or_else(|| format!("line {}: bad or missing mode: {:?}", i + 1, raw))?;
            let outcome = parts
                .next()
                .and_then(Outcome::parse)
                .ok_or_else(|| format!("line {}: bad or missing outcome: {:?}", i + 1, raw))?;
            exp.entries.insert((path.to_string(), mode), outcome);
        }
        Ok(exp)
    }
}

/// One drift between an observed run and a committed expectation (design §
/// The gate and the two-directional ratchet).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ratchet {
    /// Observed a `fail` where the list did not expect one. Always red.
    NewFail { path: String, mode: Mode },
    /// Expected `pass`, observed a skip: a regression (the case ran before
    /// and no longer does). Red.
    Regression {
        path: String,
        mode: Mode,
        now: String,
    },
    /// Expected a skip, observed `pass`: progress (a landed opcode/feature).
    /// Red until the list is re-baselined, so progress is never silently
    /// absorbed; the maintainer accepts it by committing the regenerated list.
    Progress {
        path: String,
        mode: Mode,
        was: String,
    },
    /// Both sides skip, but the named reason moved. Soft by default (the case
    /// still does not run); gates only under `strict_skip_reasons`.
    SkipReasonChanged {
        path: String,
        mode: Mode,
        from: String,
        to: String,
    },
    /// A listed (case, mode) the run did not produce: a removed or renamed
    /// case. Red (the list is stale).
    Missing { path: String, mode: Mode },
    /// An observed (case, mode) absent from the list: a new case. Red (the
    /// list must gain it).
    Unexpected {
        path: String,
        mode: Mode,
        outcome: String,
    },
}

impl Ratchet {
    /// Whether this event reddens the build. Every event gates except a bare
    /// skip-reason move, which gates only when `strict_skip_reasons` is set
    /// (skip-reason churn is expected while the opcode surface still grows).
    pub fn is_gating(&self, strict_skip_reasons: bool) -> bool {
        match self {
            Ratchet::SkipReasonChanged { .. } => strict_skip_reasons,
            _ => true,
        }
    }

    pub fn describe(&self) -> String {
        match self {
            Ratchet::NewFail { path, mode } => {
                format!("NEW-FAIL   {} [{}]", path, mode.as_str())
            }
            Ratchet::Regression { path, mode, now } => {
                format!("REGRESSION {} [{}] pass -> {}", path, mode.as_str(), now)
            }
            Ratchet::Progress { path, mode, was } => {
                format!("PROGRESS   {} [{}] {} -> pass", path, mode.as_str(), was)
            }
            Ratchet::SkipReasonChanged {
                path,
                mode,
                from,
                to,
            } => format!("SKIP-MOVED {} [{}] {} -> {}", path, mode.as_str(), from, to),
            Ratchet::Missing { path, mode } => {
                format!(
                    "MISSING    {} [{}] (in list, not observed)",
                    path,
                    mode.as_str()
                )
            }
            Ratchet::Unexpected {
                path,
                mode,
                outcome,
            } => format!(
                "UNEXPECTED {} [{}] observed {} (not in list)",
                path,
                mode.as_str(),
                outcome
            ),
        }
    }
}

/// Compare observed outcomes to a committed expectation, returning every
/// drift in a deterministic (sorted-by-key) order. An empty result is a green
/// run (observed == expected for every (case, mode)).
pub fn compare(observed: &BTreeMap<Key, Outcome>, expected: &Expectations) -> Vec<Ratchet> {
    let mut events = Vec::new();
    // Keys present on either side, deduplicated and ordered.
    let mut keys: Vec<&Key> = observed.keys().chain(expected.entries.keys()).collect();
    keys.sort();
    keys.dedup();

    for key in keys {
        let (path, mode) = key;
        match (observed.get(key), expected.entries.get(key)) {
            (Some(obs), Some(exp)) if obs == exp => {}
            (Some(obs), Some(exp)) => {
                events.push(classify_change(path, *mode, exp, obs));
            }
            (Some(obs), None) => events.push(Ratchet::Unexpected {
                path: path.clone(),
                mode: *mode,
                outcome: obs.serialize(),
            }),
            (None, Some(_)) => events.push(Ratchet::Missing {
                path: path.clone(),
                mode: *mode,
            }),
            (None, None) => unreachable!("key came from one of the two maps"),
        }
    }
    events
}

/// Classify a same-key expected-vs-observed disagreement into a ratchet event.
fn classify_change(path: &str, mode: Mode, expected: &Outcome, observed: &Outcome) -> Ratchet {
    match (expected, observed) {
        // A newly-observed failure, whatever the list expected (an expected
        // `fail` that still fails is `expected == observed`, handled by the
        // caller before this point).
        (_, Outcome::Fail) => Ratchet::NewFail {
            path: path.to_string(),
            mode,
        },
        (Outcome::Pass, Outcome::Skip(now)) => Ratchet::Regression {
            path: path.to_string(),
            mode,
            now: now.clone(),
        },
        (Outcome::Skip(was), Outcome::Pass) => Ratchet::Progress {
            path: path.to_string(),
            mode,
            was: was.clone(),
        },
        (Outcome::Skip(from), Outcome::Skip(to)) => Ratchet::SkipReasonChanged {
            path: path.to_string(),
            mode,
            from: from.clone(),
            to: to.clone(),
        },
        // An expected `fail` (quarantine entry) that no longer fails is
        // progress: the case now passes or skips. Surface it so the
        // quarantine entry is removed from the list.
        (Outcome::Fail, Outcome::Pass) => Ratchet::Progress {
            path: path.to_string(),
            mode,
            was: "fail".to_string(),
        },
        (Outcome::Fail, Outcome::Skip(to)) => Ratchet::SkipReasonChanged {
            path: path.to_string(),
            mode,
            from: "fail".to_string(),
            to: to.clone(),
        },
        // Pass observed where pass expected is `expected == observed`, handled
        // by the caller; this arm is unreachable but keeps the match total.
        (Outcome::Pass, Outcome::Pass) => Ratchet::Missing {
            path: path.to_string(),
            mode,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skip(r: &str) -> Outcome {
        Outcome::Skip(r.to_string())
    }

    #[test]
    fn outcome_round_trips() {
        for o in [Outcome::Pass, Outcome::Fail, skip("unsupported-opcode:add")] {
            assert_eq!(Outcome::parse(&o.serialize()), Some(o));
        }
        assert_eq!(Outcome::parse("skip"), Some(Outcome::Skip(String::new())));
        assert_eq!(Outcome::parse("nonsense"), None);
    }

    #[test]
    fn list_text_round_trips() {
        let mut e = Expectations::new(Header {
            engine: "ironhorse".into(),
            features: "default".into(),
            corpus: "upstream".into(),
            tip: "abc1234".into(),
        });
        e.record(
            "language/expressions/addition/a.js",
            Mode::Sloppy,
            Outcome::Pass,
        );
        e.record(
            "language/expressions/addition/a.js",
            Mode::Strict,
            skip("strict-unimplemented"),
        );
        e.record(
            "language/expressions/addition/b.js",
            Mode::Sloppy,
            skip("unsupported-opcode:add"),
        );
        let text = e.to_text();
        let parsed = Expectations::parse(&text).expect("parse");
        assert_eq!(parsed.header, e.header);
        assert_eq!(parsed.entries, e.entries);
        // Byte-stable: re-serializing the parse reproduces the text.
        assert_eq!(parsed.to_text(), text);
    }

    #[test]
    fn parse_rejects_malformed_lines() {
        assert!(Expectations::parse("a.js sloppy pass\n").is_ok());
        assert!(Expectations::parse("a.js bogusmode pass\n").is_err());
        assert!(Expectations::parse("a.js sloppy bogusoutcome\n").is_err());
        assert!(Expectations::parse("a.js sloppy\n").is_err());
    }

    #[test]
    fn identical_run_is_green() {
        let mut e = Expectations::default();
        e.record("a.js", Mode::Sloppy, Outcome::Pass);
        e.record("b.js", Mode::Sloppy, skip("unsupported-opcode:add"));
        let observed = e.entries.clone();
        assert!(compare(&observed, &e).is_empty());
    }

    #[test]
    fn detects_both_ratchet_directions() {
        let mut e = Expectations::default();
        e.record("prog.js", Mode::Sloppy, skip("unsupported-opcode:add"));
        e.record("reg.js", Mode::Sloppy, Outcome::Pass);
        let mut observed = BTreeMap::new();
        // prog.js: opcode landed -> now passes (progress).
        observed.insert(("prog.js".into(), Mode::Sloppy), Outcome::Pass);
        // reg.js: regressed to a skip.
        observed.insert(
            ("reg.js".into(), Mode::Sloppy),
            skip("unsupported-opcode:add"),
        );
        let events = compare(&observed, &e);
        assert_eq!(events.len(), 2);
        assert!(events
            .iter()
            .any(|ev| matches!(ev, Ratchet::Progress { path, .. } if path == "prog.js")));
        assert!(events
            .iter()
            .any(|ev| matches!(ev, Ratchet::Regression { path, .. } if path == "reg.js")));
        // Both directions gate.
        assert!(events.iter().all(|ev| ev.is_gating(false)));
    }

    #[test]
    fn new_fail_always_gates() {
        let mut e = Expectations::default();
        e.record("a.js", Mode::Sloppy, Outcome::Pass);
        let mut observed = BTreeMap::new();
        observed.insert(("a.js".into(), Mode::Sloppy), Outcome::Fail);
        let events = compare(&observed, &e);
        assert_eq!(
            events,
            vec![Ratchet::NewFail {
                path: "a.js".into(),
                mode: Mode::Sloppy
            }]
        );
        assert!(events[0].is_gating(false));
    }

    #[test]
    fn skip_reason_move_is_soft_by_default() {
        let mut e = Expectations::default();
        e.record("a.js", Mode::Sloppy, skip("unsupported-opcode:add"));
        let mut observed = BTreeMap::new();
        observed.insert(
            ("a.js".into(), Mode::Sloppy),
            skip("unsupported-opcode:sub"),
        );
        let events = compare(&observed, &e);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], Ratchet::SkipReasonChanged { .. }));
        assert!(!events[0].is_gating(false)); // soft by default
        assert!(events[0].is_gating(true)); // gates under --strict-skip-reasons
    }

    #[test]
    fn missing_and_unexpected_gate() {
        let mut e = Expectations::default();
        e.record("listed.js", Mode::Sloppy, Outcome::Pass);
        let mut observed = BTreeMap::new();
        observed.insert(("fresh.js".into(), Mode::Sloppy), Outcome::Pass);
        let events = compare(&observed, &e);
        assert!(events
            .iter()
            .any(|ev| matches!(ev, Ratchet::Missing { path, .. } if path == "listed.js")));
        assert!(events
            .iter()
            .any(|ev| matches!(ev, Ratchet::Unexpected { path, .. } if path == "fresh.js")));
        assert!(events.iter().all(|ev| ev.is_gating(false)));
    }
}
