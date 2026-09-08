//! Every named corruption refusal needs an assertion or a reviewed exception.
//! This deliberately has no Rust-parser dependency: unknown dynamic producers
//! fail closed, and the lexer ignores comments and string contents as code.
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

#[derive(Clone, Debug, PartialEq)]
enum Token {
    Word(String),
    String(String),
    Punct(char),
}
fn lex(source: &str) -> Vec<Token> {
    let bytes = source.as_bytes();
    let mut i = 0;
    let mut out = Vec::new();
    while i < bytes.len() {
        if bytes[i].is_ascii_whitespace() {
            i += 1;
        } else if bytes[i..].starts_with(b"//") {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else if bytes[i..].starts_with(b"/*") {
            i += 2;
            let mut depth = 1;
            while depth > 0 {
                assert!(i < bytes.len(), "unterminated comment");
                if bytes[i..].starts_with(b"/*") {
                    depth += 1;
                    i += 2;
                } else if bytes[i..].starts_with(b"*/") {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
        } else if bytes[i] == b'"'
            || (bytes[i] == b'r' && {
                let mut quote = i + 1;
                while bytes.get(quote) == Some(&b'#') {
                    quote += 1;
                }
                bytes.get(quote) == Some(&b'"')
            })
        {
            let raw = bytes[i] == b'r';
            let mut hashes = 0;
            if raw {
                i += 1;
                while bytes[i] == b'#' {
                    hashes += 1;
                    i += 1;
                }
            }
            assert_eq!(bytes[i], b'"');
            i += 1;
            let mut value = Vec::new();
            loop {
                assert!(i < bytes.len(), "unterminated string");
                if bytes[i] == b'"'
                    && (!raw || bytes.get(i + 1..i + 1 + hashes) == Some(&vec![b'#'; hashes]))
                {
                    i += 1 + hashes;
                    break;
                }
                if !raw && bytes[i] == b'\\' {
                    i += 1;
                    value.push(match bytes[i] {
                        b'n' => b'\n',
                        b'r' => b'\r',
                        b't' => b'\t',
                        b => b,
                    });
                } else {
                    value.push(bytes[i]);
                }
                i += 1;
            }
            out.push(Token::String(String::from_utf8(value).unwrap()));
        } else if bytes[i] == b'\''
            && (bytes.get(i + 2) == Some(&b'\'')
                || (bytes.get(i + 1) == Some(&b'\\') && bytes.get(i + 3) == Some(&b'\'')))
        {
            i += if bytes[i + 1] == b'\\' { 4 } else { 3 };
        } else if bytes[i].is_ascii_alphabetic() || bytes[i] == b'_' {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            out.push(Token::Word(source[start..i].into()));
        } else {
            out.push(Token::Punct(bytes[i] as char));
            i += 1;
        }
    }
    out
}
fn word(t: &Token, s: &str) -> bool {
    matches!(t, Token::Word(w) if w == s)
}
fn end_group(tokens: &[Token], start: usize) -> usize {
    let close = match tokens[start] {
        Token::Punct('(') => ')',
        Token::Punct('{') => '}',
        Token::Punct('[') => ']',
        _ => panic!("expected group"),
    };
    let mut i = start + 1;
    while i < tokens.len() {
        match tokens[i] {
            Token::Punct(c) if c == close => return i,
            Token::Punct('(' | '{' | '[') => i = end_group(tokens, i),
            _ => {}
        }
        i += 1;
    }
    panic!("unclosed group");
}
// Split arguments at top-level commas; nested calls are not label expressions.
fn arguments(tokens: &[Token]) -> Vec<&[Token]> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < tokens.len() {
        match tokens[i] {
            Token::Punct('(' | '{' | '[') => i = end_group(tokens, i),
            Token::Punct(',') => {
                out.push(&tokens[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    if start < tokens.len() {
        out.push(&tokens[start..]);
    }
    out
}
fn literal_labels(tokens: &[Token]) -> Option<BTreeSet<String>> {
    if let [Token::String(name)] = tokens {
        return Some(BTreeSet::from([name.clone()]));
    }
    // The two conditional promise-cluster labels have literal-only branches.
    if tokens.first().is_some_and(|t| word(t, "if")) {
        let open = tokens.iter().position(|t| *t == Token::Punct('{'))?;
        let close = end_group(tokens, open);
        if !tokens.get(close + 1).is_some_and(|t| word(t, "else"))
            || tokens.get(close + 2) != Some(&Token::Punct('{'))
        {
            return None;
        }
        let last = end_group(tokens, close + 2);
        if last + 1 != tokens.len() {
            return None;
        }
        let [Token::String(a)] = &tokens[open + 1..close] else {
            return None;
        };
        let [Token::String(b)] = &tokens[close + 3..last] else {
            return None;
        };
        return Some(BTreeSet::from([a.clone(), b.clone()]));
    }
    None
}
fn source_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            source_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}
fn split_tests(tokens: &[Token]) -> (Vec<Token>, Vec<Token>) {
    let marker = lex("#[cfg(test)] mod");
    let mut production = Vec::new();
    let mut tests = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        if tokens[i..].starts_with(&marker)
            && matches!(tokens.get(i + marker.len() + 1), Some(Token::Punct('{')))
        {
            let start = i + marker.len() + 1;
            let end = end_group(tokens, start);
            tests.extend_from_slice(&tokens[start + 1..end]);
            i = end + 1;
        } else {
            production.push(tokens[i].clone());
            i += 1;
        }
    }
    (production, tests)
}
fn inventory(tokens: &[Token]) -> (BTreeSet<String>, BTreeMap<String, usize>) {
    let mut names = BTreeSet::new();
    let mut forwarded = BTreeMap::new();
    for i in 0..tokens.len().saturating_sub(1) {
        let direct = word(&tokens[i], "Corrupt");
        let wrapper = [
            "file_corrupt",
            "read_small_section",
            "ascending",
            "present_and_non_empty",
            "read_block",
            "row_len",
        ]
        .iter()
        .any(|w| word(&tokens[i], w));
        let cursor = i >= 3 && tokens[i - 3..=i] == lex("Cursor::new");
        assert!(
            !direct || tokens[i + 1] == Token::Punct('('),
            "Corrupt constructor aliases are not supported by the refusal registry"
        );
        if wrapper || cursor {
            let declaration = (i > 0 && word(&tokens[i - 1], "fn"))
                || (i > 0 && word(&tokens[i - 1], "mut") && tokens[i + 1] == Token::Punct('='))
                || (i > 0 && word(&tokens[i - 1], "let") && tokens[i + 1] == Token::Punct('='));
            assert!(
                declaration || tokens[i + 1] == Token::Punct('('),
                "refusal wrapper aliases are not supported: {:?}",
                tokens[i]
            );
        }
        if !(direct || wrapper || cursor) || tokens[i + 1] != Token::Punct('(') {
            continue;
        }
        // Function declarations describe dynamic forwarding, not call sites.
        if i > 0 && word(&tokens[i - 1], "fn") {
            continue;
        }
        let end = end_group(tokens, i + 1);
        let all_args = arguments(&tokens[i + 2..end]);
        let label_index = if cursor
            || ["present_and_non_empty", "read_block", "row_len"]
                .iter()
                .any(|w| word(&tokens[i], w))
        {
            1
        } else if word(&tokens[i], "ascending") {
            2
        } else {
            0
        };
        let args = *all_args
            .get(label_index)
            .expect("missing refusal label argument");
        if let Some(literals) = literal_labels(args) {
            names.extend(literals);
        } else {
            // These are the complete, audited forwarding expressions. Adding
            // another expression must extend this registry's data-flow model.
            let dynamic = if direct {
                ["self.what", "what", "name", "&'static str"]
                    .iter()
                    .any(|s| args == lex(s))
            } else {
                word(&tokens[i], "file_corrupt") && args == lex("what")
            };
            assert!(
                dynamic,
                "unregistered dynamic refusal producer: {:?}({args:?})",
                tokens[i]
            );
            *forwarded
                .entry(format!("{:?}({args:?})", tokens[i]))
                .or_insert(0) += 1;
        }
    }
    (names, forwarded)
}
// Recognize only a positive, literal expected error, not arbitrary mentions
// inside a condition or an assertion's diagnostic message.
fn expected_label(tokens: &[Token]) -> Option<String> {
    let open = tokens.iter().position(|t| *t == Token::Punct('('))?;
    if open == 0 || end_group(tokens, open) + 1 != tokens.len() {
        return None;
    }
    if !tokens[..open]
        .iter()
        .all(|t| matches!(t, Token::Word(_) | Token::Punct(':')))
    {
        return None;
    }
    let inside = &tokens[open + 1..tokens.len() - 1];
    if word(&tokens[open - 1], "Corrupt") {
        if let [Token::String(label)] = inside {
            return Some(label.clone());
        }
    } else if ["Err", "Snapshot"]
        .iter()
        .any(|w| word(&tokens[open - 1], w))
    {
        return expected_label(inside);
    }
    None
}
fn asserted(tokens: &[Token]) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for i in 0..tokens.len().saturating_sub(2) {
        if !["assert", "assert_eq"].iter().any(|w| word(&tokens[i], w))
            || tokens[i + 1] != Token::Punct('!')
        {
            continue;
        }
        let end = end_group(tokens, i + 2);
        let args = arguments(&tokens[i + 3..end]);
        if word(&tokens[i], "assert_eq") && args.len() >= 2 {
            let a = expected_label(args[0]);
            let b = expected_label(args[1]);
            match (a, b) {
                (Some(label), None) | (None, Some(label)) => {
                    names.insert(label);
                }
                _ => {}
            }
        } else if let Some(condition) = args.first() {
            if condition.len() < 3
                || !word(&condition[0], "matches")
                || condition[1] != Token::Punct('!')
                || condition[2] != Token::Punct('(')
                || end_group(condition, 2) + 1 != condition.len()
            {
                continue;
            }
            let matches = arguments(&condition[3..condition.len() - 1]);
            if matches.len() == 2 {
                if let Some(label) = expected_label(matches[1]) {
                    names.insert(label);
                }
            }
        }
    }
    names
}
#[test]
fn every_named_corruption_is_asserted_or_explicitly_allowlisted() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    source_files(&root.join("src"), &mut files);
    let mut names = BTreeSet::new();
    let mut coverage = BTreeSet::new();
    for path in files {
        let (production, tests) = split_tests(&lex(&std::fs::read_to_string(&path).unwrap()));
        let (found, forwarded) = inventory(&production);
        let expected: &[(&str, &str, usize)] = match path.file_name().unwrap().to_str().unwrap() {
            "image.rs" => &[("Corrupt", "self.what", 7), ("Corrupt", "what", 2)],
            "store.rs" => &[("Corrupt", "name", 4)],
            "store_file.rs" => &[("Corrupt", "what", 1), ("file_corrupt", "what", 4)],
            "format.rs" => &[("Corrupt", "&'static str", 1)],
            _ => &[],
        };
        let expected: BTreeMap<_, _> = expected
            .iter()
            .map(|(callee, args, count)| {
                (
                    format!("{:?}({:?})", Token::Word((*callee).into()), lex(args)),
                    *count,
                )
            })
            .collect();
        assert_eq!(
            forwarded,
            expected,
            "forwarding sites changed in {}: audit their call-site inventory",
            path.display()
        );
        names.extend(found);
        coverage.extend(asserted(&tests));
    }
    let mut tests = Vec::new();
    source_files(&root.join("tests"), &mut tests);
    for path in tests {
        if path.file_name().unwrap() != "refusal_registry.rs" {
            coverage.extend(asserted(&lex(&std::fs::read_to_string(path).unwrap())));
        }
    }
    let mut exceptions = BTreeSet::new();
    for line in include_str!("refusal_allowlist.tsv")
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
    {
        let (name, reason) = line.split_once('\t').expect("name<TAB>reason");
        assert!(reason.len() >= 20, "explain the exception for {name}");
        assert!(names.contains(name), "stale exception: {name}");
        assert!(
            !coverage.contains(name),
            "remove now-covered exception: {name}"
        );
        assert!(
            exceptions.insert(name.to_owned()),
            "duplicate exception: {name}"
        );
    }
    let uncovered: Vec<_> = names
        .difference(&coverage)
        .filter(|n| !exceptions.contains(*n))
        .cloned()
        .collect();
    assert!(
        uncovered.is_empty(),
        "unasserted Corrupt names (add a regression assertion or explain an exception):\n{}",
        uncovered.join("\n")
    );
    assert!(names.len() > 100, "inventory unexpectedly empty");
}
#[test]
fn scanner_detects_new_refusals_and_ignores_comments() {
    assert_eq!(
        inventory(&lex(
            "Err(SnapshotError::Corrupt(\"new refusal\")) // Corrupt(\"fake\")"
        ))
        .0,
        BTreeSet::from(["new refusal".into()])
    );
    assert!(asserted(&lex("let expected = Corrupt(\"not asserted\");")).is_empty());
    assert_eq!(
        asserted(&lex(
            "assert!(matches!(result, Err(Corrupt(\"covered\"))));"
        )),
        BTreeSet::from(["covered".into()])
    );
}
#[test]
#[should_panic(expected = "unregistered dynamic refusal producer")]
fn new_dynamic_producers_require_registry_support() {
    inventory(&lex("SnapshotError::Corrupt(new_dynamic_name)"));
}

#[test]
fn mixed_dynamic_labels_are_rejected() {
    for source in [
        "Corrupt(if flag { \"known\" } else { new_dynamic_name })",
        "Corrupt(name.unwrap_or(\"fallback\"))",
        "Cursor::new(\"unrelated\", dynamic_name)",
        "present_and_non_empty(make_rows(\"unrelated\"), dynamic_name)",
    ] {
        assert!(
            std::panic::catch_unwind(|| inventory(&lex(source))).is_err(),
            "{source}"
        );
    }
    assert!(asserted(&lex("assert_ne!(result, Err(Corrupt(\"not covered\")));")).is_empty());
}

#[test]
fn constructor_aliases_are_rejected() {
    for source in [
        "use SnapshotError::Corrupt as Invalid; Invalid(\"new label\")",
        "let refuse = SnapshotError::Corrupt; refuse(\"new label\")",
    ] {
        assert!(std::panic::catch_unwind(|| inventory(&lex(source))).is_err());
    }
}

#[test]
fn negative_assertions_and_wrapper_aliases_do_not_count() {
    for source in [
        "assert!(result != Err(Corrupt(\"x\")))",
        "assert_eq!(matches!(result, Err(Corrupt(\"x\"))), false)",
        "assert!(!matches!(result, Err(Corrupt(\"x\"))))",
        "assert!(true, \"diagnostic {:?}\", Corrupt(\"x\"))",
    ] {
        assert!(asserted(&lex(source)).is_empty(), "{source}");
    }
    for source in [
        "let fail = file_corrupt; fail(\"x\")",
        "let cursor = Cursor::new; cursor(bytes, \"x\")",
    ] {
        assert!(std::panic::catch_unwind(|| inventory(&lex(source))).is_err());
    }
}
