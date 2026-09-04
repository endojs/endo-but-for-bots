//! Full test262 YAML frontmatter parse (design
//! [`designs/ironhorse-test262-convergence.md`] § Part 2: "a real YAML
//! dependency replaces `test262.rs`'s three-field hand parser").
//!
//! `xst262.c` reads the whole frontmatter through libyaml; the analogue
//! reads it through `yaml-rust2`, a pure-Rust YAML 1.2 parser, so the
//! crate's `#![forbid(unsafe_code)]` holds. This lifts the three fields
//! `test262.rs` hand-scanned (`flags`, `includes`, presence of `negative`)
//! to the full block the `endot-ih` verdict layer needs: the typed
//! `negative` (`phase` + `type`), `features` (the skip-list axis), and
//! `description`/`info` prose.

use yaml_rust2::{Yaml, YamlLoader};

/// A parsed `negative:` block — the test is expected to abort, and the
/// verdict compares the abort's kind against these fields (design § Part 2,
/// "Negative verdict").
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Negative {
    /// `parse`, `resolution`, or `runtime` — when the abort is expected.
    pub phase: String,
    /// The expected error constructor name, e.g. `SyntaxError`,
    /// `TypeError`, `RangeError`, `Test262Error`.
    pub ty: String,
}

/// The test262 frontmatter fields that drive assembly and the verdict.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Frontmatter {
    pub description: String,
    /// `onlyStrict`, `noStrict`, `module`, `raw`, `async`,
    /// `CanBlockIsFalse`, `generated`, …
    pub flags: Vec<String>,
    pub includes: Vec<String>,
    pub negative: Option<Negative>,
    /// The `features:` list — the axis the ironhorse skip list and
    /// `--features-include` opt-in select on.
    pub features: Vec<String>,
    pub info: String,
    /// `true` when a `/*--- … ---*/` block was present and parsed as a
    /// mapping. A file with no frontmatter (or an unparseable block) yields
    /// `present == false` and otherwise-default fields.
    pub present: bool,
}

/// Extract the `/*--- … ---*/` block and parse it as YAML. A file with no
/// block, or whose block does not parse as a YAML mapping, returns a
/// default (`present == false`) frontmatter — the caller treats that as "no
/// declared metadata", exactly as `xst262.c` runs an unannotated file.
pub fn parse(src: &str) -> Frontmatter {
    let mut fm = Frontmatter::default();
    let block = match extract_block(src) {
        Some(b) => b,
        None => return fm,
    };
    // yaml-rust2 returns one doc per `---`-separated document; the
    // frontmatter is a single mapping document. A scan error (a
    // malformed block) is treated as "no metadata", never a panic.
    let docs = match YamlLoader::load_from_str(block) {
        Ok(d) => d,
        Err(_) => return fm,
    };
    let doc = match docs.first() {
        Some(d) if d.as_hash().is_some() => d,
        _ => return fm,
    };
    fm.present = true;
    fm.description = doc["description"].as_str().unwrap_or_default().to_string();
    fm.flags = str_vec(&doc["flags"]);
    fm.includes = str_vec(&doc["includes"]);
    fm.features = str_vec(&doc["features"]);
    fm.info = doc["info"].as_str().unwrap_or_default().to_string();
    let neg = &doc["negative"];
    if neg.as_hash().is_some() {
        fm.negative = Some(Negative {
            phase: neg["phase"].as_str().unwrap_or_default().to_string(),
            ty: neg["type"].as_str().unwrap_or_default().to_string(),
        });
    }
    fm
}

/// The raw text between `/*---` and the following `---*/`.
fn extract_block(src: &str) -> Option<&str> {
    let start = src.find("/*---")? + "/*---".len();
    let rest = &src[start..];
    let end = rest.find("---*/")?;
    Some(&rest[..end])
}

/// A YAML node that is either a sequence of scalars (`[a, b]` or a block
/// list) or a single scalar, rendered as a `Vec<String>`. A missing/absent
/// node yields an empty vector.
fn str_vec(node: &Yaml) -> Vec<String> {
    if let Some(seq) = node.as_vec() {
        return seq
            .iter()
            .filter_map(|n| n.as_str().map(|s| s.to_string()))
            .collect();
    }
    match node.as_str() {
        Some(s) => vec![s.to_string()],
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flow_arrays_and_typed_negative() {
        let src = "\
/*---
description: block-scoped bindings reject redeclaration
flags: [onlyStrict, raw]
includes: [propertyHelper.js, compareArray.js]
features: [Symbol, let]
negative:
  phase: parse
  type: SyntaxError
info: |
  a multi-line
  info block
---*/
let x = 1;";
        let fm = parse(src);
        assert!(fm.present);
        assert_eq!(fm.description, "block-scoped bindings reject redeclaration");
        assert_eq!(fm.flags, vec!["onlyStrict", "raw"]);
        assert_eq!(fm.includes, vec!["propertyHelper.js", "compareArray.js"]);
        assert_eq!(fm.features, vec!["Symbol", "let"]);
        assert_eq!(
            fm.negative,
            Some(Negative {
                phase: "parse".into(),
                ty: "SyntaxError".into()
            })
        );
        assert!(fm.info.contains("multi-line"));
    }

    #[test]
    fn parses_block_sequences() {
        // The block (`- item`) sequence form the flow-only hand parser
        // could not read.
        let src = "\
/*---
flags:
  - noStrict
includes:
  - assert.js
  - sta.js
---*/
1;";
        let fm = parse(src);
        assert_eq!(fm.flags, vec!["noStrict"]);
        assert_eq!(fm.includes, vec!["assert.js", "sta.js"]);
        assert!(fm.negative.is_none());
    }

    #[test]
    fn runtime_negative_and_missing_block() {
        let runtime =
            parse("/*---\nnegative:\n  phase: runtime\n  type: TypeError\n---*/\nnull.x;");
        assert_eq!(
            runtime.negative,
            Some(Negative {
                phase: "runtime".into(),
                ty: "TypeError".into()
            })
        );

        let none = parse("1 + 1;");
        assert!(!none.present);
        assert!(none.flags.is_empty());
        assert!(none.negative.is_none());
    }
}
