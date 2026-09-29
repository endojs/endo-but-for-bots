//! The classification-discipline lint for Ironhorse `Halt` values.
//!
//! Design `designs/ironhorse-panic.md` § The Formal `Panic` Category keeps
//! the flat diagnostic `Halt` variants (`StackOverflow`, `MeterAbort`,
//! `Decode`, ...) beside the nested `Halt::Panic(PanicKind)` and asks one
//! rule of every commit-path consumer: decide "terminate, do not commit"
//! through `Halt::is_panic()` or `ExecutionOutcome::classify`, never by
//! matching a variant shape. The rule is a convention, not a type-level
//! guarantee, so this lint is its enforcement: it fails the build when code
//! in scope names a `Halt` variant in a pattern (a `match` arm, `if let`,
//! `let`-`else`, `matches!`) or compares against one with `==`/`!=`.
//!
//! Clippy's `disallowed_*` lints cannot express "a pattern naming this
//! enum's variants", so the check is a `syn` pass over the source rather
//! than a Clippy configuration. It is syntactic: it recognizes `Halt` by
//! name (and by any `use ... Halt as X` or `type X = Halt` alias in the
//! same file), and it refuses variant imports (`use ...::Halt::*`), which
//! would let a bare identifier pattern slip past the path check.
//!
//! **Scope.** The commit path is the supervisor's release-or-discard
//! machinery, which lives in the root-workspace crates under `rust/`. The
//! engine workspace (`rust/engine`) produces `Halt` values and its
//! differential harnesses classify them for reporting; it is out of scope.
//! Test code (`tests/` directories, `#[cfg(test)]` items, `#[test]` fns) is
//! out of scope too: assertions about a specific variant are the point of
//! a test.
//!
//! **Allowlist.** [`ALLOWED`] names, per file, the few non-commit
//! functions that legitimately read variant shape (diagnostic rendering,
//! the sanctioned classifier itself). Each entry carries its reason. An
//! entry that no longer suppresses anything is itself a finding, so the
//! list cannot quietly outlive the code it excused.

use std::collections::BTreeSet;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

use proc_macro2::{Span, TokenStream, TokenTree};
use syn::parse::ParseStream;
use syn::punctuated::Punctuated;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{
    Attribute, BinOp, Expr, ExprBinary, ImplItemFn, ItemFn, ItemImpl, ItemMod, ItemUse, Macro,
    Meta, Pat, Path as SynPath, Token, Type, UseTree,
};

/// A function that may read `Halt` variant shape, and why.
#[derive(Debug, Clone, Copy)]
pub struct Allow {
    /// Repository-relative path of the file holding the function.
    pub file: &'static str,
    /// `Type::method` for an `impl` method, `name` for a free function.
    pub item: &'static str,
    /// Why this site is not a commit-path decision.
    pub reason: &'static str,
}

/// The reviewed exceptions. Adding one is a design decision: the entry
/// must explain why its function never decides commit versus discard.
pub const ALLOWED: &[Allow] = &[
    Allow {
        file: "rust/endo/src/ironhorse_engine.rs",
        item: "ExecutionOutcome::classify",
        reason: "the sanctioned Halt -> ExecutionOutcome constructor (design item 4); \
                 it delegates genuine panics to is_panic() and matches only the \
                 non-panic residue",
    },
    Allow {
        file: "rust/endo/src/ironhorse_engine.rs",
        item: "describe_halt",
        reason: "diagnostic rendering of a halt for the port's ledger; never reaches \
                 the commit decision",
    },
    Allow {
        file: "rust/endo/src/ironhorse_engine.rs",
        item: "refuse",
        reason: "names a limit-bearing meter refusal as MachineError::MeterAbort for \
                 reporting; every other halt is carried through unchanged",
    },
    Allow {
        file: "rust/endo/src/engine/js_machine.rs",
        item: "classify",
        reason: "maps a MachineError to the coarse JsMachineErrorKind reported to \
                 JsMachine callers; an error taxonomy, not a commit/discard decision",
    },
];

/// Directory walked for commit-path sources, relative to the repository.
pub const SCOPE_ROOT: &str = "rust";

/// Subtrees of [`SCOPE_ROOT`] that are not commit-path code.
pub const SCOPE_EXCLUDED: &[&str] = &[
    // The engine workspace: the producer of `Halt` and its harnesses.
    "rust/engine",
    // This crate's own fixtures deliberately violate the rule.
    "rust/halt-classification-lint",
];

/// Directory names skipped anywhere under the scope root.
const SKIPPED_DIRS: &[&str] = &[
    "tests",
    "benches",
    "examples",
    "fixtures",
    "target",
    "node_modules",
];

/// One violation of the classification discipline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub file: String,
    /// 1-based line, or 0 for a finding about the allowlist itself.
    pub line: usize,
    /// 1-based column, or 0 for a finding about the allowlist itself.
    pub column: usize,
    /// The enclosing function (`Type::method`, `name`, or `<item>`).
    pub item: String,
    pub message: String,
}

impl fmt::Display for Finding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}:{}:{}: error[halt-classification]: {} (in `{}`)",
            self.file, self.line, self.column, self.message, self.item
        )
    }
}

/// A source that could not be read or parsed. Distinct from a finding so
/// the command line can tell "the rule is violated" from "the lint broke".
#[derive(Debug)]
pub enum LintError {
    Io(PathBuf, io::Error),
    Parse(String, syn::Error),
}

impl fmt::Display for LintError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LintError::Io(path, e) => write!(f, "{}: {e}", path.display()),
            LintError::Parse(file, e) => {
                let at = e.span().start();
                write!(f, "{file}:{}:{}: parse error: {e}", at.line, at.column + 1)
            }
        }
    }
}

impl std::error::Error for LintError {}

/// The result of linting one source: its findings, and the indices of the
/// allowlist entries that suppressed at least one match.
#[derive(Debug, Default)]
pub struct SourceReport {
    pub findings: Vec<Finding>,
    pub allows_used: BTreeSet<usize>,
}

const REMEDY: &str = "route the decision through `Halt::is_panic()` or \
                      `ExecutionOutcome::classify`, not variant shape \
                      (designs/ironhorse-panic.md § The Formal `Panic` Category)";

/// Lint one source text. `file` is the repository-relative label used in
/// findings and matched against [`Allow::file`].
pub fn lint_source(file: &str, source: &str, allowed: &[Allow]) -> Result<SourceReport, LintError> {
    let ast = syn::parse_file(source).map_err(|e| LintError::Parse(file.to_string(), e))?;
    let mut aliases = AliasCollector {
        names: vec!["Halt".to_string()],
    };
    aliases.visit_file(&ast);
    let mut linter = Linter {
        file,
        allowed,
        halt_names: aliases.names,
        impl_types: Vec::new(),
        items: Vec::new(),
        report: SourceReport::default(),
    };
    linter.visit_file(&ast);
    Ok(linter.report)
}

/// Every in-scope `.rs` file under `repo`, repository-relative, sorted.
pub fn scope_files(repo: &Path) -> Result<Vec<String>, LintError> {
    let mut out = Vec::new();
    walk(repo, &repo.join(SCOPE_ROOT), &mut out)?;
    out.sort();
    Ok(out)
}

fn walk(repo: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), LintError> {
    let entries = std::fs::read_dir(dir).map_err(|e| LintError::Io(dir.to_path_buf(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| LintError::Io(dir.to_path_buf(), e))?;
        let path = entry.path();
        let rel = relative(repo, &path);
        let kind = entry
            .file_type()
            .map_err(|e| LintError::Io(path.clone(), e))?;
        if kind.is_dir() {
            let name = entry.file_name();
            let skipped = SKIPPED_DIRS.iter().any(|s| name == **s)
                || SCOPE_EXCLUDED.iter().any(|x| rel == *x);
            if !skipped {
                walk(repo, &path, out)?;
            }
        } else if kind.is_file() && rel.ends_with(".rs") {
            out.push(rel);
        }
    }
    Ok(())
}

/// A repository-relative, `/`-separated label for `path`.
pub fn relative(repo: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(repo).unwrap_or(path);
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// Lint every in-scope file under `repo`, then report any allowlist entry
/// that suppressed nothing.
pub fn lint_tree(repo: &Path, allowed: &[Allow]) -> Result<Vec<Finding>, LintError> {
    let mut findings = Vec::new();
    let mut used = BTreeSet::new();
    for file in scope_files(repo)? {
        let path = repo.join(&file);
        let source = std::fs::read_to_string(&path).map_err(|e| LintError::Io(path, e))?;
        let report = lint_source(&file, &source, allowed)?;
        findings.extend(report.findings);
        used.extend(report.allows_used);
    }
    for (index, allow) in allowed.iter().enumerate() {
        if !used.contains(&index) {
            findings.push(Finding {
                file: allow.file.to_string(),
                line: 0,
                column: 0,
                item: allow.item.to_string(),
                message: "stale allowlist entry: it suppressed no `Halt` variant match; \
                          remove it so it cannot later excuse a new commit-path match"
                    .to_string(),
            });
        }
    }
    Ok(findings)
}

/// First pass: names that denote `Halt` in this file (`use ... Halt as X`,
/// `type X = Halt`).
struct AliasCollector {
    names: Vec<String>,
}

impl<'ast> Visit<'ast> for AliasCollector {
    fn visit_use_tree(&mut self, tree: &'ast UseTree) {
        if let UseTree::Rename(rename) = tree {
            if rename.ident == "Halt" {
                self.names.push(rename.rename.to_string());
            }
        }
        visit::visit_use_tree(self, tree);
    }

    fn visit_item_type(&mut self, item: &'ast syn::ItemType) {
        if let Type::Path(ty) = &*item.ty {
            if ty.path.segments.last().is_some_and(|s| s.ident == "Halt") {
                self.names.push(item.ident.to_string());
            }
        }
        visit::visit_item_type(self, item);
    }
}

struct Linter<'a> {
    file: &'a str,
    allowed: &'a [Allow],
    halt_names: Vec<String>,
    /// Self type of each enclosing `impl`, innermost last.
    impl_types: Vec<String>,
    /// Enclosing function labels, innermost last.
    items: Vec<String>,
    report: SourceReport,
}

impl Linter<'_> {
    fn is_halt(&self, ident: &syn::Ident) -> bool {
        self.halt_names.iter().any(|n| ident == n)
    }

    /// `Some(variant)` when `path` names a variant of `Halt`
    /// (`Halt::X`, `engine::Halt::X`, an alias `H::X`).
    fn halt_variant(&self, path: &SynPath) -> Option<String> {
        let segs: Vec<_> = path.segments.iter().collect();
        (1..segs.len())
            .find(|&i| self.is_halt(&segs[i - 1].ident))
            .map(|i| format!("{}::{}", segs[i - 1].ident, segs[i].ident))
    }

    fn item_label(&self) -> String {
        self.items
            .last()
            .cloned()
            .unwrap_or_else(|| "<item>".to_string())
    }

    fn flag(&mut self, span: Span, message: String) {
        let item = self.item_label();
        if let Some(index) = self
            .allowed
            .iter()
            .position(|a| a.file == self.file && a.item == item)
        {
            self.report.allows_used.insert(index);
            return;
        }
        let at = span.start();
        self.report.findings.push(Finding {
            file: self.file.to_string(),
            line: at.line,
            column: at.column + 1,
            item,
            message,
        });
    }

    /// A `Halt` variant named by an expression operand (`Halt::X`,
    /// `Halt::X(..)`, `Halt::X { .. }`, behind any `&`/parens).
    fn operand_variant(&self, expr: &Expr) -> Option<(Span, String)> {
        match expr {
            Expr::Path(p) => self.halt_variant(&p.path).map(|v| (p.span(), v)),
            Expr::Call(c) => self.operand_variant(&c.func),
            Expr::Struct(s) => self.halt_variant(&s.path).map(|v| (s.span(), v)),
            Expr::Reference(r) => self.operand_variant(&r.expr),
            Expr::Paren(p) => self.operand_variant(&p.expr),
            Expr::Group(g) => self.operand_variant(&g.expr),
            _ => None,
        }
    }

    fn check_comparison(&mut self, left: &Expr, right: &Expr) {
        for side in [left, right] {
            if let Some((span, variant)) = self.operand_variant(side) {
                self.flag(
                    span,
                    format!("equality test against raw `{variant}`; {REMEDY}"),
                );
            }
        }
    }

    fn with_item(&mut self, label: String, f: impl FnOnce(&mut Self)) {
        self.items.push(label);
        f(self);
        self.items.pop();
    }
}

/// `#[test]`, `#[cfg(test)]`, or `#[cfg(all(.., test, ..))]`: code that is
/// compiled only into tests. `cfg(not(test))` is production code.
fn is_test_only(attrs: &[Attribute]) -> bool {
    attrs.iter().any(|attr| {
        if attr.path().is_ident("test") {
            return true;
        }
        if !attr.path().is_ident("cfg") {
            return false;
        }
        let Meta::List(list) = &attr.meta else {
            return false;
        };
        cfg_requires_test(list.tokens.clone())
    })
}

fn cfg_requires_test(tokens: TokenStream) -> bool {
    let trees: Vec<TokenTree> = tokens.into_iter().collect();
    match trees.as_slice() {
        [TokenTree::Ident(i)] => i == "test",
        [TokenTree::Ident(all), TokenTree::Group(g)] if all == "all" => {
            // Split the `all(...)` arguments at top-level commas.
            let mut arg = TokenStream::new();
            for tt in g.stream() {
                if matches!(&tt, TokenTree::Punct(p) if p.as_char() == ',') {
                    if cfg_requires_test(std::mem::take(&mut arg)) {
                        return true;
                    }
                } else {
                    arg.extend(std::iter::once(tt));
                }
            }
            cfg_requires_test(arg)
        }
        _ => false,
    }
}

type MatchesBody = (Expr, Pat, Option<Expr>);

fn parse_matches(input: ParseStream) -> syn::Result<MatchesBody> {
    let scrutinee: Expr = input.parse()?;
    input.parse::<Token![,]>()?;
    let pat = Pat::parse_multi_with_leading_vert(input)?;
    let guard = if input.peek(Token![if]) {
        input.parse::<Token![if]>()?;
        Some(input.parse()?)
    } else {
        None
    };
    input.parse::<Option<Token![,]>>()?;
    Ok((scrutinee, pat, guard))
}

impl<'ast> Visit<'ast> for Linter<'_> {
    fn visit_item_mod(&mut self, item: &'ast ItemMod) {
        if !is_test_only(&item.attrs) {
            visit::visit_item_mod(self, item);
        }
    }

    fn visit_item_impl(&mut self, item: &'ast ItemImpl) {
        if is_test_only(&item.attrs) {
            return;
        }
        let ty = match &*item.self_ty {
            Type::Path(p) => p
                .path
                .segments
                .last()
                .map(|s| s.ident.to_string())
                .unwrap_or_default(),
            _ => String::new(),
        };
        self.impl_types.push(ty);
        visit::visit_item_impl(self, item);
        self.impl_types.pop();
    }

    fn visit_impl_item_fn(&mut self, item: &'ast ImplItemFn) {
        if is_test_only(&item.attrs) {
            return;
        }
        let name = item.sig.ident.to_string();
        let label = match self.impl_types.last() {
            Some(ty) if !ty.is_empty() => format!("{ty}::{name}"),
            _ => name,
        };
        self.with_item(label, |this| visit::visit_impl_item_fn(this, item));
    }

    fn visit_item_fn(&mut self, item: &'ast ItemFn) {
        if is_test_only(&item.attrs) {
            return;
        }
        let label = item.sig.ident.to_string();
        self.with_item(label, |this| visit::visit_item_fn(this, item));
    }

    fn visit_item_use(&mut self, item: &'ast ItemUse) {
        if !is_test_only(&item.attrs) {
            visit::visit_item_use(self, item);
        }
    }

    fn visit_use_tree(&mut self, tree: &'ast UseTree) {
        if let UseTree::Path(path) = tree {
            if self.is_halt(&path.ident) {
                self.flag(
                    path.span(),
                    format!(
                        "imports `{}` variants, which lets a bare identifier pattern \
                         bypass this lint; {REMEDY}",
                        path.ident
                    ),
                );
                return;
            }
        }
        visit::visit_use_tree(self, tree);
    }

    fn visit_pat(&mut self, pat: &'ast Pat) {
        let named = match pat {
            Pat::Path(p) => self.halt_variant(&p.path).map(|v| (p.span(), v)),
            Pat::TupleStruct(p) => self.halt_variant(&p.path).map(|v| (p.path.span(), v)),
            Pat::Struct(p) => self.halt_variant(&p.path).map(|v| (p.path.span(), v)),
            _ => None,
        };
        if let Some((span, variant)) = named {
            self.flag(
                span,
                format!("pattern matches raw `{variant}` variant shape; {REMEDY}"),
            );
        }
        visit::visit_pat(self, pat);
    }

    fn visit_expr_binary(&mut self, expr: &'ast ExprBinary) {
        if matches!(expr.op, BinOp::Eq(_) | BinOp::Ne(_)) {
            self.check_comparison(&expr.left, &expr.right);
        }
        visit::visit_expr_binary(self, expr);
    }

    fn visit_macro(&mut self, mac: &'ast Macro) {
        let name = mac
            .path
            .segments
            .last()
            .map(|s| s.ident.to_string())
            .unwrap_or_default();
        if name == "matches" {
            if let Ok((scrutinee, pat, guard)) = mac.parse_body_with(parse_matches) {
                self.visit_expr(&scrutinee);
                self.visit_pat(&pat);
                if let Some(guard) = guard {
                    self.visit_expr(&guard);
                }
            }
            return;
        }
        // Any other expression-argument macro (`assert!`, `format!`, ...):
        // lint its arguments as expressions so a nested `matches!` or `==`
        // is still seen.
        if let Ok(args) = mac.parse_body_with(Punctuated::<Expr, Token![,]>::parse_terminated) {
            let args: Vec<Expr> = args.into_iter().collect();
            if matches!(
                name.as_str(),
                "assert_eq" | "assert_ne" | "debug_assert_eq" | "debug_assert_ne"
            ) && args.len() >= 2
            {
                self.check_comparison(&args[0], &args[1]);
            }
            for arg in &args {
                self.visit_expr(arg);
            }
        }
    }
}
