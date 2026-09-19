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
/// Which `lockdown()`, if any, the realm ran before the case did.
///
/// The prelude itself never calls one -- see `REACH`'s note and
/// `POST_LOCKDOWN`'s -- so this is the harness's choice, not the prelude's.
#[derive(Clone, Copy, PartialEq)]
enum Lock {
    /// What the prelude leaves behind, and what `REACH` pins.
    No,
    /// SES's defaults, which is `overrideTaming: 'moderate'`.
    Defaults,
    /// The options `dist-ironhorse/boot.js` ships, and so the realm the
    /// Ironhorse worker's guests actually run in.
    Worker,
}

impl Lock {
    fn statement(self) -> &'static str {
        match self {
            Lock::No => "",
            // Swallowed rather than propagated: a case that calls `lockdown()`
            // itself must reach its own call and report its own verdict, not
            // die here on SES's refusal of a second one.
            Lock::Defaults => "try { lockdown(); } catch (e) {}\n",
            Lock::Worker => {
                "try { lockdown({ errorTaming: 'safe', reporting: 'none', \
                             overrideTaming: 'min' }); } catch (e) {}\n"
            }
        }
    }
}

fn program_for(case: &Path, lock: Lock) -> String {
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
    let lockdown = lock.statement();
    format!(
        "{includes}\n{prelude}\n{lockdown}var __e; try {{ {body} }} catch(e) {{ __e = e; }} \
         __e ? ('FAIL: ' + __e.message) : 'PASS'"
    )
}

fn outcome(case: &Path, lock: Lock) -> String {
    let program = program_for(case, lock);
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
/// `Symbol.toStringTag-lockdown.js` is the whole corpus's lockdown case, and
/// it passes here while still failing on node -- the two hosts were red on it
/// for DIFFERENT reasons, which is why node's number is not a ceiling for this
/// one.
///
/// On node, `@endo/harden` finds no host `harden`, installs its own at
/// `Object[Symbol.for('harden')]`, and `repairIntrinsics` refuses outright.
/// Ironhorse used to fail it the other way: the selector adopted the NATIVE
/// `globalThis.harden`, a faithful port of XS's `fx_hardenFreezeAndTraverse`
/// that walks prototype chains, so one `harden({})` during prelude evaluation
/// turned `Function.prototype.constructor` from the spec's
/// `configurable: true` into `{writable: false, configurable: false}` and
/// `tame-function-constructors.js` could no longer install its inert
/// constructor -- `lockdown()` died with `invalid descriptor`.
///
/// The prelude now takes that in two parts, and the split is the
/// point. `@endo/ironhorse-prelude` -- the prologue the SHIPPED worker also
/// bundles -- DELETES the native `harden` before the shim is evaluated, so the
/// shim builds and keeps its own, which traverses. Installing a gentle
/// hardener there instead would have handed it to the shim for the life of the
/// realm, since `packages/ses/src/make-hardener.js:142-147` adopts an existing
/// `globalThis.harden` and `lockdown.js:85` calls it at module scope --
/// `lockdown()` does not replace it.
///
/// `packages/test262-runner/src/install-pre-lockdown-harden.js` then supplies
/// `@endo/harden`'s `makeHardener({ traversePrototypes: false })` AFTER the
/// shim, which is present (so nothing installs into the poisoning slot) and
/// gentle (so the intrinsics lockdown still has to tame survive), and withdraws
/// it in a `lockdown` wrapper (so `initProperty` does not see two definitions
/// of `harden` and throw `Conflicting definitions of harden`). The rejection
/// was always spec-correct; the freeze was the problem, and it is the
/// pre-lockdown harden that had to change.
///
/// XS needs none of this: it has a native `lockdown` (`fx_lockdown`,
/// `c/moddable/xs/sources/xsLockdown.c`) that rewires those constructors with
/// direct slot writes, below `[[DefineOwnProperty]]`. Ironhorse has since
/// ported that `lockdown` (steps 1, 2 and 5) but not a guest `Compartment`,
/// which the shim supplies alongside `lockdown`, so this shim route is still
/// the SES profile.
/// See `designs/ironhorse-ses-compartment-equivalence.md`.
const REACH: &[(&str, bool)] = &[
    ("byte-readers.js", true),
    ("native-or-emulated-shape.js", true),
    ("Symbol.toStringTag.js", true),
    ("Symbol.toStringTag-lockdown.js", true),
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

/// A `read_dir` walk rather than a `grep -rl` shell-out. This is a pin meant to
/// move deliberately, so it should not be able to fail for a reason unrelated
/// to reach: no `grep` on PATH (Windows, minimal containers) used to panic on
/// `.expect("grep")`, and `-l`'s line-per-file output is a GNU/BSD shape. No
/// extension filter, so the set matches what `grep -rl` over this tree
/// returned.
fn parity_files(dir: &Path, found: &mut Vec<String>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()))
        .map(|entry| entry.expect("dir entry").path())
        .collect();
    // `read_dir` yields in filesystem order; sort so the walk, and so the
    // per-case output, is the same on every host -- and so both pins below
    // enumerate in the same order.
    entries.sort();
    for path in entries {
        if path.is_dir() {
            parity_files(&path, found);
        } else if std::fs::read_to_string(&path).is_ok_and(|text| text.contains("ses-xs-parity")) {
            found.push(path.to_string_lossy().into_owned());
        }
    }
}

/// Run `source` after the harness includes, the SES prelude, AND a real
/// `lockdown()` — using the same `Lock` the reach pins use, because the
/// prelude does NOT lock down on its own. An earlier version of this helper
/// omitted the call and still claimed "after lockdown"; it was measuring a
/// realm with the shim merely evaluated.
fn after_lockdown(source: &str) -> String {
    let includes = ["sta.js", "assert.js"]
        .iter()
        .map(|f| read(&format!("packages/test262-runner/test262/harness/{f}")))
        .collect::<Vec<_>>()
        .join("\n");
    let prelude = read("packages/test262-runner/prelude/ironhorse.js");
    let lockdown = Lock::Defaults.statement();
    let program = format!("{includes}\n{prelude}\n{lockdown}{source}");
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
/// This is the payoff for implementing them. The prologue used to DELETE every
/// `Iterator.prototype` key and the `Iterator` global outright, because the
/// five lazy helpers halted the machine with `NotImplemented("Iterator.helper")`
/// and an engine halt is not catchable — so a guest could not even defend
/// itself with `try`/`catch`. With the helpers implemented that amputation is
/// gone from `@endo/ironhorse-prelude`, which both the corpus and the shipped
/// worker bundle, and this pins what replaced it.
///
/// Note the second case: SES's own `get-anonymous-intrinsics.js` discovers
/// `%IteratorHelperPrototype%` by EVALUATING `Iterator.from([]).take(0)`, so
/// lockdown itself runs a lazy helper. If `take` were wrong, lockdown would
/// fail here rather than in guest code.
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
            // The lockdown really happened, so the rest of this test means
            // what it says.
            assert_eq!(after_lockdown("String(typeof harden)"), "function");
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
            // Each helper runs, and a chain of them runs, after lockdown.
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
            // EAGER sibling and as `Array.prototype.map`. Pinned as PARITY
            // rather than as an absolute, so this cannot quietly claim a
            // hardening guarantee the path does not deliver.
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
                let got = outcome(path, Lock::No);
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

/// Post-lockdown reach, by corpus-relative path: `(case, worker, defaults)`.
///
/// **Why this exists separately from `REACH`.** The prelude deliberately leaves
/// the realm UN-locked-down (`packages/test262-runner/src/ironhorse-prelude.js`
/// wraps `globalThis.lockdown` but never calls it), because
/// `Symbol.toStringTag.js` asserts a descriptor `lockdown()` changes. The
/// SHIPPED worker is the other way round: `dist-ironhorse/boot.js` calls
/// `lockdown()` on the line after the shim, so every guest it runs is in a
/// locked-down realm. `REACH` above therefore measures a realm the worker does
/// not have, and on its own it would let the worker's realm regress unwatched.
///
/// **The `Worker` column is the ratchet.** It is the corpus run in the realm
/// the worker ships, and it is expected to go UP and never down.
///
/// **The `Defaults` column is a second ratchet, on an engine gap.** Four cases
/// halt under SES's default `overrideTaming: 'moderate'` with
/// `native-call:TypedArray:from-array-like`, and pass under the worker's
/// `'min'`. That is not two facts but one: `bundle-ironhorse-worker.mjs` picked
/// `'min'` for exactly this reason -- its comment says Ironhorse's typed-array
/// copy profile refuses accessor-based iterator overrides, which is what
/// `'moderate'` installs on `Array.prototype`. When the engine implements that
/// native call, these four flip to `PASS` and the column ratchets with them.
/// Until then it names the gap rather than hiding behind the option that dodges
/// it.
///
/// An earlier revision of `packages/test262-runner/README.md` reported the
/// `Defaults` column as if it were unconditional -- "four are blocked
/// post-lockdown by an unrelated engine gap" -- which understated the shipped
/// configuration, where those four pass. Measured here rather than asserted, so
/// the README cannot drift from it again.
const POST_LOCKDOWN: &[(&str, &str, &str)] = &[
    // The corpus's own lockdown case. It calls `lockdown()` itself, so a realm
    // that already locked down is a configuration it cannot run in at all --
    // SES refuses the second call. That is a real fact about the case, not a
    // harness artifact to paper over: the worker's guests cannot use it.
    (
        "built-ins/Compartment/prototype/Symbol.toStringTag-lockdown.js",
        "FAIL",
        "FAIL",
    ),
    // The one case that genuinely requires a PRE-lockdown realm, under BOTH
    // option sets: it wants `Compartment.prototype[Symbol.toStringTag]` still
    // `configurable: true`, and `lockdown()` is what makes it not. This single
    // case is why the prelude must not lock down.
    (
        "built-ins/Compartment/prototype/Symbol.toStringTag.js",
        "FAIL",
        "FAIL",
    ),
    (
        "built-ins/ImmutableArrayBuffer/pass-style-bytes/byte-array-brand.js",
        "PASS",
        "HALT:native-call:TypedArray:from-array-like",
    ),
    (
        "built-ins/ImmutableArrayBuffer/pass-style-bytes/byte-readers.js",
        "PASS",
        "HALT:native-call:TypedArray:from-array-like",
    ),
    (
        "built-ins/ImmutableArrayBuffer/pass-style-bytes/native-or-emulated-shape.js",
        "PASS",
        "HALT:native-call:TypedArray:from-array-like",
    ),
    (
        "built-ins/ImmutableArrayBuffer/view-behavior-matrix/ses-hosts.js",
        "PASS",
        "PASS",
    ),
    (
        "built-ins/TextDecoder/immutable-arraybuffer-intersection.js",
        "PASS",
        "HALT:native-call:TypedArray:from-array-like",
    ),
    (
        "built-ins/TextEncoder/immutable-arraybuffer-intersection.js",
        "PASS",
        "PASS",
    ),
];

/// Normalize an outcome to a token stable enough to pin.
///
/// A halt carries its reason, because the reason IS the ratchet -- it names the
/// engine gap that has to close. A `FAIL` does not: the message is SES's or
/// test262's prose and would make the pin brittle across an upstream bump, so
/// the reason lives in the per-case comment above and the full string is
/// printed on every run.
fn token(outcome: &str) -> String {
    if outcome == "PASS" {
        return "PASS".into();
    }
    let Some(halt) = outcome.strip_prefix("HALT ") else {
        return "FAIL".into();
    };
    match (halt.find('"'), halt.rfind('"')) {
        (Some(open), Some(close)) if close > open => format!("HALT:{}", &halt[open + 1..close]),
        _ => format!("HALT:{halt}"),
    }
}

#[test]
fn the_shim_prelude_reaches_a_pinned_slice_of_the_corpus_after_lockdown() {
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
    let corpus = format!("{ROOT}/packages/test262-runner/test262/test");
    let mut files = Vec::new();
    parity_files(Path::new(&corpus), &mut files);
    assert_eq!(files.len(), 8, "the ses-xs-parity corpus moved: {files:?}");

    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || {
            let mut rows = Vec::new();
            let (mut worker_pass, mut defaults_pass) = (0, 0);
            for f in &files {
                let path = Path::new(f);
                let name = f
                    .rsplit_once("/test262/test/")
                    .expect("case under the corpus root")
                    .1
                    .to_owned();
                let worker = outcome(path, Lock::Worker);
                let defaults = outcome(path, Lock::Defaults);
                eprintln!("  {name}\n      worker={worker}\n      defaults={defaults}");
                worker_pass += usize::from(worker == "PASS");
                defaults_pass += usize::from(defaults == "PASS");
                rows.push((name, token(&worker), token(&defaults)));
            }
            eprintln!(
                "ses-shim-prelude post-lockdown: {worker_pass}/{} under the worker's options, \
                 {defaults_pass}/{} under SES defaults",
                files.len(),
                files.len()
            );

            let pinned: Vec<_> = POST_LOCKDOWN
                .iter()
                .map(|(n, w, d)| ((*n).to_owned(), (*w).to_owned(), (*d).to_owned()))
                .collect();
            if rows != pinned {
                // A ratchet's failure should hand over its own replacement, so
                // a deliberate move is a copy-paste and an accidental one is
                // still legible.
                let mut replacement = String::new();
                for (name, worker, defaults) in &rows {
                    replacement.push_str(&format!(
                        "    (\n        \"{name}\",\n        \"{worker}\",\n        \
                         \"{defaults}\",\n    ),\n"
                    ));
                }
                panic!(
                    "post-lockdown reach moved.\n\nIf this is deliberate, POST_LOCKDOWN \
                     becomes:\n\n{replacement}\nAnd § The Ironhorse lockdown shim in \
                     packages/test262-runner/README.md must say so -- it quotes these \
                     numbers."
                );
            }
        })
        .unwrap()
        .join()
        .unwrap();
}
