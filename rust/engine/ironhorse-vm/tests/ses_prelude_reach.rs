//! How far the SES *shim* profile carries Ironhorse through the repo's
//! `ses-xs-parity` corpus — the third host of the axis
//! `packages/test262-runner` runs against `xst` and node.
//!
//! The axis's Ironhorse host (`scripts/run-ironhorse-host.js`) drives
//! `endot-ih -l`, which runs the engine's native `lockdown()`. The other
//! two hosts instead evaluate a generated SES prelude, and
//! `packages/test262-runner/src` carries a third: `ironhorse-prelude.js`.
//! This suite measures that shim path independently of native lockdown.
//!
//! This measures that route. It is not the axis itself — wiring the prelude
//! into `endot-ih` is the follow-up — but it pins how much the shim reaches
//! so the number can only move deliberately.
mod common;
use common::TestCompiler;

use ironhorse_vm::{parse_symbols, Interp};

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");

fn read(rel: &str) -> String {
    std::fs::read_to_string(format!("{ROOT}/{rel}")).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

/// The host ordering `package.json`'s `test262:xs:text-codec-arraybuffer`
/// documents: harness includes, then the prelude (which captures test262's
/// `assert` on the way past), then the case.
fn program_for(case: &Path) -> String {
    let includes = [
        "sta.js",
        "assert.js",
        "compareArray.js",
        "propertyHelper.js",
        // `ses-hosts.js` names this in its `includes:` front-matter. This
        // harness takes a fixed list rather than reading front-matter, so
        // leaving it out made that case fail here for a missing helper while
        // it passed under the real `test262-harness` — the reach number has
        // to mean the same thing in both places.
        "immutableArrayBufferViewMatrix.js",
    ]
    .iter()
    .map(|f| read(&format!("packages/test262-runner/test262/harness/{f}")))
    .collect::<Vec<_>>()
    .join("\n");
    let prelude = read("packages/test262-runner/prelude/ironhorse.js");
    let body = std::fs::read_to_string(case).expect("case");
    let body = match body.find("---*/") {
        Some(end) => &body[end + 5..],
        None => &body[..],
    };
    format!(
        "{includes}\n{prelude}\nvar __e; try {{ {body} }} catch(e) {{ __e = e; }} \
         __e ? ('FAIL: ' + __e.message) : 'PASS'"
    )
}

fn outcome(case: &Path) -> String {
    let program = program_for(case);
    let mut m = Interp::new();
    m.set_source_compiler(std::rc::Rc::new(TestCompiler));
    let Ok((code, symbols)) =
        ironhorse_compile::compile_atoms_goal(&program, ironhorse_compile::Goal::Script, false)
    else {
        return "COMPILE".into();
    };
    m.link_intrinsics(&parse_symbols(&symbols));
    let o = m.run(&code);
    if !o.completed {
        return format!("HALT {:?}", o.halt);
    }
    if o.result == "PASS" {
        "PASS".into()
    } else {
        "FAIL".into()
    }
}

use std::path::Path;

/// Pinned reach, by file name. `true` is "the case passes on Ironhorse
/// through the shim prelude".
///
/// `Symbol.toStringTag-lockdown.js` is false on Ironhorse AND on node -- the
/// node host reports 14/16 today, with both failures on that one file -- but
/// for DIFFERENT reasons, so do not read node's as an alibi for this one.
///
/// On node, `@endo/harden` finds no host `harden`, installs its own at
/// `Object[Symbol.for('harden')]`, and `repairIntrinsics` refuses outright.
/// On Ironhorse that slot stays `undefined`: the selector adopts the native
/// `globalThis.harden`, as `ironhorse-pre-shim.js` intends. `lockdown()`
/// instead throws `invalid descriptor` from `tame-function-constructors.js`,
/// because the native `harden` deep-freezes `Function.prototype` -- one
/// `harden({})` turns `constructor` from the spec's `configurable: true` into
/// `{writable: false, configurable: false}` -- so SES can no longer swap in
/// its inert constructor. That rejection is spec-correct; the freeze that
/// provoked it is the Ironhorse gap. See
/// `designs/ironhorse-ses-compartment-equivalence.md`.
const REACH: &[(&str, bool)] = &[
    ("byte-readers.js", true),
    ("native-or-emulated-shape.js", true),
    ("Symbol.toStringTag.js", true),
    ("Symbol.toStringTag-lockdown.js", false),
    // Passes since the `END` frame-base restore (xsRun.c:1063's
    // `mxStack = mxFrameEnd`): `passStyleOf` reaches this case's
    // `assert.sameValue(passStyleOf(bytes), 'byteArray')` through a `return`
    // out of a `switch (typeof ...)`, and the discriminant that `return`
    // abandoned used to land on the caller's pending operand.
    ("byte-array-brand.js", true),
    // Passes on its `ironhorse-ses` row plus `%TypedArray%.prototype.at`, the
    // only read an EMULATED immutable view answers.
    ("ses-hosts.js", true),
    // The `TextEncoder`/`TextDecoder` pair, which share this basename. Ironhorse
    // has no host text codecs; the prelude prepends `polyfills.js`'s codec
    // section, which now implements `encodeInto` and refuses an emulated
    // ArrayBuffer view it cannot read or write, as both cases require.
    ("immutable-arraybuffer-intersection.js", true),
];

/// Run `source` after the harness includes and the full SES prelude — so
/// after `lockdown()` — and return its completion value.
fn after_lockdown(source: &str) -> String {
    let includes = ["sta.js", "assert.js"]
        .iter()
        .map(|f| read(&format!("packages/test262-runner/test262/harness/{f}")))
        .collect::<Vec<_>>()
        .join("\n");
    let prelude = read("packages/test262-runner/prelude/ironhorse.js");
    let program = format!("{includes}\n{prelude}\n{source}");
    let mut m = Interp::new();
    m.set_source_compiler(std::rc::Rc::new(TestCompiler));
    let Ok((code, symbols)) =
        ironhorse_compile::compile_atoms_goal(&program, ironhorse_compile::Goal::Script, false)
    else {
        return "COMPILE".into();
    };
    m.link_intrinsics(&parse_symbols(&symbols));
    let o = m.run(&code);
    if !o.completed {
        return format!("HALT {:?}", o.halt);
    }
    o.result
}

/// The five lazy Iterator helpers survive `lockdown()` and work through it.
///
/// This is the payoff for implementing them. The prelude used to DELETE every
/// `Iterator.prototype` key and the `Iterator` global outright, because the
/// five lazy helpers halted the machine with `NotImplemented("Iterator.helper")`
/// and an engine halt is not catchable — so a guest could not even defend
/// itself with `try`/`catch`. With the helpers implemented that amputation is
/// gone, and this pins what replaced it.
///
/// Note the first case: SES's own `get-anonymous-intrinsics.js` discovers
/// `%IteratorHelperPrototype%` by EVALUATING `Iterator.from([]).take(0)`, so
/// lockdown itself now runs a lazy helper. If `take` were wrong, lockdown
/// would fail here rather than in guest code.
#[test]
fn the_lazy_iterator_helpers_survive_lockdown() {
    if !Path::new(&format!(
        "{ROOT}/packages/test262-runner/prelude/ironhorse.js"
    ))
    .exists()
    {
        eprintln!("ses-prelude: absent — `yarn workspace @endo/test262-runner build` to run this");
        return;
    }
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(|| {
            // `Iterator` is a real global again, not `undefined`.
            assert_eq!(after_lockdown("typeof Iterator"), "function");
            // And SES reached its helper prototype, which is what it hardens.
            assert_eq!(
                after_lockdown(
                    "String(Object.getPrototypeOf(Iterator.from([]).take(0)) === \
                     Object.getPrototypeOf([].values().map(function (v) { return v; })))"
                ),
                "true"
            );
            // Each helper runs, and a chain of them runs, under lockdown.
            for (source, expected) in [
                ("[...[1,2,3].values().map(function (v) { return v * 2; })].join(',')", "2,4,6"),
                ("[...[1,2,3,4].values().filter(function (v) { return v % 2 === 0; })].join(',')", "2,4"),
                ("[...[1,2,3,4].values().take(2)].join(',')", "1,2"),
                ("[...[1,2,3,4].values().drop(2)].join(',')", "3,4"),
                ("[...[1,2].values().flatMap(function (v) { return [v, v * 10]; })].join(',')", "1,10,2,20"),
                (
                    "[...[1,2,3,4,5,6].values().map(function (v) { return v * 2; })\
                     .filter(function (v) { return v > 4; }).drop(1).take(2)].join(',')",
                    "8,10",
                ),
            ] {
                assert_eq!(after_lockdown(source), expected, "{source}");
            }
            // A lazy helper is hardened by this path exactly as much as its
            // EAGER sibling and as `Array.prototype.map` — which on the shim
            // path is not at all. That is a pre-existing property of the shim
            // profile (`Object.prototype.hasOwnProperty`, a boot-bound method,
            // IS frozen; the lazily bound proto methods are not), not
            // something the lazy helpers introduce. Pinned as PARITY rather
            // than as an absolute, so this cannot quietly claim a hardening
            // guarantee the path does not deliver.
            let lazy = after_lockdown("String(Object.isFrozen(Iterator.prototype.map))");
            for sibling in [
                "String(Object.isFrozen(Iterator.prototype.reduce))",
                "String(Object.isFrozen(Array.prototype.map))",
            ] {
                assert_eq!(
                    lazy,
                    after_lockdown(sibling),
                    "a lazy helper must harden like {sibling}"
                );
            }
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn the_ses_shim_prelude_reaches_a_pinned_slice_of_the_parity_corpus() {
    let prelude = format!("{ROOT}/packages/test262-runner/prelude/ironhorse.js");
    if !Path::new(&prelude).exists() {
        assert!(
            std::env::var_os("IRONHORSE_SES_PRELUDE_REQUIRED").is_none(),
            "IRONHORSE_SES_PRELUDE_REQUIRED is set but {prelude} is absent: the \
             lane claims to have run `yarn workspace @endo/test262-runner build` \
             and did not"
        );
        eprintln!("ses-prelude: absent — `yarn workspace @endo/test262-runner build` to run this");
        return;
    }
    // A `read_dir` walk rather than a `grep -rl` shell-out. This is a pin
    // meant to move deliberately, so it should not be able to fail for a
    // reason unrelated to reach: no `grep` on PATH (Windows, minimal
    // containers) used to panic on `.expect("grep")`, and `-l`'s
    // line-per-file output is a GNU/BSD shape. No extension filter, so the
    // set matches what `grep -rl` over this tree returned.
    fn parity_files(dir: &Path, found: &mut Vec<String>) {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()))
            .map(|entry| entry.expect("dir entry").path())
            .collect();
        // `read_dir` yields in filesystem order; sort so the walk, and so the
        // per-case output below, is the same on every host.
        entries.sort();
        for path in entries {
            if path.is_dir() {
                parity_files(&path, found);
            } else if std::fs::read_to_string(&path)
                .is_ok_and(|text| text.contains("ses-xs-parity"))
            {
                found.push(path.to_string_lossy().into_owned());
            }
        }
    }
    let corpus = format!("{ROOT}/packages/test262-runner/test262/test");
    let mut files = Vec::new();
    parity_files(Path::new(&corpus), &mut files);
    assert_eq!(files.len(), 8, "the ses-xs-parity corpus moved: {files:?}");

    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || {
            let mut passed = 0;
            for f in &files {
                let path = Path::new(f);
                let name = path.file_name().unwrap().to_str().unwrap();
                let expected = REACH
                    .iter()
                    .find(|(n, _)| *n == name)
                    .unwrap_or_else(|| panic!("unpinned case {name}"))
                    .1;
                let got = outcome(path);
                eprintln!("  {name:<46} {got}");
                assert_eq!(
                    got == "PASS",
                    expected,
                    "{name}: reach moved (got {got}). Update REACH here, and the \
                     § What decides the profile section of \
                     designs/ironhorse-ses-compartment-equivalence.md."
                );
                passed += usize::from(got == "PASS");
            }
            eprintln!(
                "ses-shim-prelude: {passed}/{} of the parity corpus",
                files.len()
            );
        })
        .unwrap()
        .join()
        .unwrap();
}
