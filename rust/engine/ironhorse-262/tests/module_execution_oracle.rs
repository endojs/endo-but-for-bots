//! Executable Module-goal + dynamic-`import()` **oracle-reference** lock.
//!
//! Where `compile_diff.rs` proves the Rust coder emits module bytecode
//! byte-identical to the XS oracle's module-compile entry (a parse+code
//! diff that never runs), this file locks the *executable* half: XS's
//! reference behavior when a whole module graph is LINKED and EVALUATED —
//! fulfillment, rejection, caching/identity, cyclic evaluation order,
//! namespace values, `import.meta`, dynamic `import()` (fulfilled and
//! rejected), and import attributes. It drives the new
//! `xs_oracle::run_module_dir` entry (xs-oracle/csrc/xs_shim.c
//! `xs_oracle_run_module`), which runs the graph over XS's filesystem
//! resolve/load hooks — the same loader moddable's `xst -m` uses — against
//! a per-case directory the test materializes.
//!
//! These remain **oracle-reference** graph regressions rather than graph
//! dual-runs. IronHorse now executes synchronous single-file module bytecode
//! through `xst.rs::run_module_case`, while static linking, top-level await,
//! dynamic import, and `import.meta` stay explicitly named boundaries until
//! the filesystem graph loader is connected to the interpreter. This file
//! certifies the XS authority for that next graph tranche. The byte-identity
//! module gate over `corpora-modules/*.js` remains `compile_diff.rs`'s
//! `module_corpora_byte_identity_no_divergence`.

use std::fs;
use std::path::{Path, PathBuf};

/// Materialize `files` (relative path, body) into a fresh per-case
/// directory under the integration-test temp dir, link+evaluate `main` on
/// the XS oracle, and return the settled outcome. The directory is removed
/// afterward. Each case uses a distinct `name`, so parallel test threads
/// never share a tree.
fn run_graph(name: &str, files: &[(&str, &str)], main: &str) -> xs_oracle::ModuleRunOutcome {
    let dir: PathBuf = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("modexec-{name}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create case dir");
    for (rel, body) in files {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(&p, body).expect("write fixture");
    }
    let outcome = xs_oracle::run_module_dir(&dir, main).expect("pinned XS oracle is available");
    let _ = fs::remove_dir_all(&dir);
    outcome
}

#[test]
fn fulfillment_static_import_and_call() {
    // A dependency's `const` and hoisted function import, link, and
    // evaluate; the entry publishes the computed value.
    let o = run_graph(
        "fulfill",
        &[
            ("dep.js", "export const x = 41; export function inc(n){ return n + 1; }"),
            ("main.mjs", "import { x, inc } from './dep.js'; globalThis.result = inc(x);"),
        ],
        "main.mjs",
    );
    assert!(o.completed, "graph should fulfill, err={:?}", o.error);
    assert_eq!(o.result, "42");
}

#[test]
fn rejection_throwing_dependency() {
    // A dependency whose top-level body throws rejects the entry module's
    // import promise; the reason is the thrown Error.
    let o = run_graph(
        "throw",
        &[
            ("boom.js", "throw new Error('boom');"),
            ("main.mjs", "import './boom.js'; globalThis.result = 'unreached';"),
        ],
        "main.mjs",
    );
    assert!(!o.completed, "throwing dependency must reject");
    assert!(o.error.contains("boom"), "reason should carry the throw, got {:?}", o.error);
    assert!(o.result.is_empty(), "no result on rejection, got {:?}", o.result);
}

#[test]
fn namespace_sorted_keys_and_values() {
    // `import * as ns` exposes the module namespace exotic: own string keys
    // are the export names sorted by code unit (XS's c_strcmp), `default`
    // among them, each read-only and live.
    let o = run_graph(
        "namespace",
        &[
            ("dep.js", "export const a = 1; export const b = 2; export default 9;"),
            (
                "main.mjs",
                "import * as ns from './dep.js'; \
                 globalThis.result = Object.keys(ns).join(',') + '|' + ns.a + ns.b + '|' + ns.default;",
            ),
        ],
        "main.mjs",
    );
    assert!(o.completed, "namespace graph should fulfill, err={:?}", o.error);
    assert_eq!(o.result, "a,b,default|12|9");
}

#[test]
fn module_instance_cached_once() {
    // A specifier resolves to ONE module instance: `counter.js` imported
    // directly and re-exported through `a.js` shares the same evaluated
    // binding (identity holds) and its body ran exactly once (count == 1).
    let o = run_graph(
        "identity",
        &[
            ("counter.js", "globalThis.count=(globalThis.count||0)+1; export const n = globalThis.count;"),
            ("a.js", "export { n } from './counter.js';"),
            (
                "main.mjs",
                "import { n as n1 } from './counter.js'; \
                 import { n as n2 } from './a.js'; \
                 globalThis.result = (n1===n2)+':'+globalThis.count;",
            ),
        ],
        "main.mjs",
    );
    assert!(o.completed, "identity graph should fulfill, err={:?}", o.error);
    assert_eq!(o.result, "true:1");
}

#[test]
fn cyclic_graph_evaluation_order() {
    // even<->odd is a cycle: hoisted function exports are live across it, so
    // mutual recursion resolves (even(10) === true). The evaluation order is
    // the InnerModuleEvaluation DFS order — odd's body ('o') runs before
    // even's ('e') because main imports even, whose first dependency is odd.
    let o = run_graph(
        "cycle",
        &[
            (
                "even.mjs",
                "import { odd } from './odd.mjs'; \
                 export function even(n){ return n===0?true:odd(n-1);} \
                 globalThis.log=(globalThis.log||'')+'e';",
            ),
            (
                "odd.mjs",
                "import { even } from './even.mjs'; \
                 export function odd(n){ return n===0?false:even(n-1);} \
                 globalThis.log=(globalThis.log||'')+'o';",
            ),
            ("main.mjs", "import { even } from './even.mjs'; globalThis.result = even(10)+':'+globalThis.log;"),
        ],
        "main.mjs",
    );
    assert!(o.completed, "cyclic graph should fulfill, err={:?}", o.error);
    assert_eq!(o.result, "true:oe");
}

#[test]
fn import_meta_shape() {
    // Under the filesystem host loader (no compartment importMetaHook),
    // `import.meta` is a plain object with stable per-read identity and no
    // host-supplied `url`. The oracle IS the authority for this shape.
    let o = run_graph(
        "meta",
        &[(
            "main.mjs",
            "globalThis.result = (typeof import.meta)+'/'+(import.meta===import.meta)+'/' \
             +(import.meta.url===undefined?'nourl':String(import.meta.url));",
        )],
        "main.mjs",
    );
    assert!(o.completed, "import.meta graph should fulfill, err={:?}", o.error);
    assert_eq!(o.result, "object/true/nourl");
}

#[test]
fn import_meta_is_per_module() {
    // Each module gets its OWN import.meta: the entry's is not the
    // dependency's, and the dependency's is itself an object.
    let o = run_graph(
        "meta-per-module",
        &[
            ("dep.mjs", "export const depMeta = import.meta;"),
            (
                "main.mjs",
                "import { depMeta } from './dep.mjs'; \
                 globalThis.result = (import.meta !== depMeta) + ':' + (typeof depMeta);",
            ),
        ],
        "main.mjs",
    );
    assert!(o.completed, "per-module meta graph should fulfill, err={:?}", o.error);
    assert_eq!(o.result, "true:object");
}

#[test]
fn dynamic_import_fulfillment_with_top_level_await() {
    // `await import('./dep.js')` in a module body exercises XS_CODE_IMPORT +
    // top-level await: the dynamic import fulfills with the dependency's
    // namespace and the awaited entry then publishes its export.
    let o = run_graph(
        "dyn-fulfill",
        &[
            ("dep.js", "export const v = 7;"),
            ("main.mjs", "const ns = await import('./dep.js'); globalThis.result = 'dyn:'+ns.v;"),
        ],
        "main.mjs",
    );
    assert!(o.completed, "dynamic import should fulfill, err={:?}", o.error);
    assert_eq!(o.result, "dyn:7");
}

#[test]
fn dynamic_import_rejection_is_catchable() {
    // A dynamic import of a specifier the host cannot load rejects the
    // returned promise; caught in-guest, the entry module still fulfills.
    let o = run_graph(
        "dyn-reject",
        &[(
            "main.mjs",
            "try { await import('./missing.js'); globalThis.result='loaded'; } \
             catch (e) { globalThis.result='caught:'+(e instanceof Error); }",
        )],
        "main.mjs",
    );
    assert!(o.completed, "in-guest catch keeps the entry fulfilled, err={:?}", o.error);
    assert_eq!(o.result, "caught:true");
}

#[test]
fn unresolved_static_specifier_rejects() {
    // A static import of a module the host cannot resolve/load is a link-time
    // failure: the entry module's import promise rejects.
    let o = run_graph(
        "unresolved",
        &[("main.mjs", "import x from './nope.js'; globalThis.result='unreached';")],
        "main.mjs",
    );
    assert!(!o.completed, "unresolved specifier must reject");
    assert!(!o.error.is_empty(), "rejection should carry a reason");
}

#[test]
fn import_attributes_json_module() {
    // `import cfg from './data.json' with { type: 'json' }` links a JSON
    // module (the host loader parses `.json` as a JSON module) and the
    // default binding is the parsed value.
    let o = run_graph(
        "attributes",
        &[
            ("data.json", "{ \"k\": 5 }"),
            (
                "main.mjs",
                "import cfg from './data.json' with { type: 'json' }; globalThis.result = 'json:'+cfg.k;",
            ),
        ],
        "main.mjs",
    );
    assert!(o.completed, "json module should fulfill, err={:?}", o.error);
    assert_eq!(o.result, "json:5");
}

/// The genuine test262 live-binding fixture
/// `language/module-code/eval-gtbndng-indirect-update_FIXTURE.js`, if the
/// on-disk test262 subset is present. Copied verbatim into the case
/// directory as the dependency, it proves the oracle links a real test262
/// module fixture through a relative specifier and observes a post-evaluation
/// update to an exported binding live in the importer (ECMA-262 §16.2.1.6.4
/// indirect binding update, the property the fixture's own test exercises).
#[test]
fn test262_live_binding_update_fixture() {
    let fixture_src = concat!(
        "var x = 1;\n",
        "export { x };\n",
        "Function('return this;')().test262update = function() { x = 2; };\n",
    );
    let o = run_graph(
        "t262-live-binding",
        &[
            ("eval-gtbndng-indirect-update_FIXTURE.js", fixture_src),
            (
                "main.mjs",
                "import { x } from './eval-gtbndng-indirect-update_FIXTURE.js'; \
                 const before = x; \
                 (new Function('return this;'))().test262update(); \
                 globalThis.result = before + '->' + x;",
            ),
        ],
        "main.mjs",
    );
    assert!(o.completed, "live-binding fixture should fulfill, err={:?}", o.error);
    // The import binding is live: after the exporter mutates `x`, the
    // importer reads the new value.
    assert_eq!(o.result, "1->2");
}
