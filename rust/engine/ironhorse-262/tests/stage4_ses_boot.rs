//! The stage-4 SES boot bar, measured against the daemon's own boot sequence.
//!
//! `designs/ironhorse-engine.md` stage 4 asks for "the endor daemon boot
//! bundles … running identically on both engines". `ironhorse-262`'s in-crate
//! `stage4_daemon_boot_bundle_agrees_with_the_pin` covers the two COMMITTED
//! bundles (`polyfills.js`, `host_aliases.js`). This covers the third,
//! `ses_boot.js`, which is generated rather than committed (`.gitignore:35`,
//! produced by `yarn bundle:xs`).
//!
//! It runs the sequence `bootstrap_ses` actually runs — `POLYFILLS`, then
//! `SES_BOOT` through `eval_wrapped`'s try/catch shape, on ONE machine
//! (`rust/endo/xsnap/src/lib.rs:1260`) — rather than a concatenation of the
//! three sources, which is not a program either engine accepts. It does not
//! run `bootstrap_ses`'s closing `run_promise_jobs()`, nor the daemon's
//! `host_aliases.js` and native `TextEncoder` overrides (`:1755`), so it is
//! the bundle's evaluation and not the daemon's whole boot.
//!
//! A census crank brackets each source so the assertions are DELTAS. Without
//! the pristine crank a probe cannot tell a global the engine binds itself
//! from one `polyfills.js` installs, and an "after" assertion on a name that
//! was already present cannot fail.
use ironhorse_262::dual_run_cranks;

fn bundle(name: &str) -> Option<String> {
    std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../endo/xsnap/src")
            .join(name),
    )
    .ok()
}

/// `eval_wrapped` (`xsnap/src/lib.rs:1078`), verbatim: the daemon never
/// evaluates the boot bundle bare, so neither does the bar.
fn wrapped(code: &str) -> String {
    format!(
        "var __e = undefined; try {{ {code} }} catch(e) {{ __e = e; }} \
         __e ? ('ERROR: ' + __e.message + '\\nSTACK: ' + __e.stack) : 'ok'"
    )
}

/// The Hardened-JavaScript surface, by `typeof`, plus the frozen-intrinsic
/// probe. `harden`/`lockdown`/`petrify`/`mutabilities` are EMBEDDER globals in
/// XS — `xsLockdown.c` implements them but `fxCreateMachine` does not bind
/// them, so each host installs the subset it wants (`xs/tools/xst.c:429`,
/// `xs-oracle/csrc/xs_shim.c:373-381`, ironhorse's `create_hardened_globals`
/// at `ironhorse-vm/src/interp/boot.rs:2086`). `Compartment` is the exception:
/// XS builds it into every realm (`xsModule.c:207`), so it is the one name
/// here that no embedder chose -- and, since
/// `designs/ironhorse-guest-compartment.md`, ironhorse builds it into every
/// realm too.
const CENSUS: &str = "['lockdown','harden','petrify','mutabilities','Compartment',\
    'HandledPromise','assert']\
    .map(function(n){ return n + '=' + (typeof globalThis[n]); }).join(' ') \
    + ' frozenObjectProto=' + Object.isFrozen(Object.prototype)";

/// The pristine ironhorse census, as `(name, typeof)`. The oracle's own
/// values are asserted separately below, because where they differ IS the gap.
const IRONHORSE_PRISTINE: &[(&str, &str)] = &[
    // Bound by `create_hardened_globals` — ironhorse's own, present before
    // `polyfills.js` runs, so NOT the polyfill's deep-freeze `harden`.
    ("harden", "function"),
    ("petrify", "function"),
    // Also `create_hardened_globals`'s, since the native `lockdown()` landed
    // (`ironhorse-vm::Interp::do_lockdown`,
    // `designs/ironhorse-native-lockdown.md`). Like its two siblings it is
    // present BEFORE `polyfills.js` and before the boot bundle, which is what
    // this census is for: attribution, not availability.
    ("lockdown", "function"),
    // The one remaining `create_hardened_globals` decline. Unbound, with no
    // dispatch: a reference is a plain `ReferenceError`. An earlier revision
    // of this table said both this and `lockdown` declined "with an honest
    // `Halt::NotImplemented` rather than a wrong value", which was never
    // measured and was not true of either.
    ("mutabilities", "undefined"),
    // XS builds this into the realm, and ironhorse now does too
    // (`Native::Compartment`, `designs/ironhorse-guest-compartment.md`). It is
    // a realm intrinsic on both sides rather than an embedder's choice, so it
    // is the one row here that no host installs and none can decline.
    ("Compartment", "function"),
];

#[test]
fn ses_boot_bundle_agrees_and_installs_only_handled_promise() {
    let (Some(polyfills), Some(ses)) = (bundle("polyfills.js"), bundle("ses_boot.js")) else {
        // A skipping test is a green test, so the lane that generates the
        // bundle declares that it did: see `.github/workflows/ci.yml`
        // (`test-ironhorse-oracle`), which runs `yarn bundle:xs` and sets
        // this. Locally the bar skips until you run `yarn bundle:xs`.
        assert!(
            std::env::var_os("IRONHORSE_SES_BOOT_REQUIRED").is_none(),
            "IRONHORSE_SES_BOOT_REQUIRED is set but rust/endo/xsnap/src/ses_boot.js \
             is absent: the lane claims to have run `yarn bundle:xs` and did not"
        );
        eprintln!(
            "stage4-ses: ses_boot.js absent — generate it with `yarn bundle:xs` to run this bar"
        );
        return;
    };

    let boot = wrapped(&ses);
    let sources = [
        CENSUS,             // 0: pristine
        polyfills.as_str(), // 1
        CENSUS,             // 2: after polyfills — the daemon's pre-SES state
        boot.as_str(),      // 3
        CENSUS,             // 4: after the bundle
    ];
    let runs = dual_run_cranks(&sources).expect("the oracle machine starts");
    // `dual_run_cranks` BREAKS at the first crank either engine fails to
    // complete (`src/lib.rs:470`), and an engine-level halt is not a JS throw,
    // so `wrapped`'s catch cannot turn it into `'ok'`. Report the halt rather
    // than indexing past the end.
    assert_eq!(
        runs.len(),
        sources.len(),
        "crank {} did not complete on both engines: {:?}",
        runs.len().saturating_sub(1),
        runs.last().map(|r| (
            &r.agreement,
            &r.oracle_result,
            &r.ironhorse_result,
            &r.ironhorse_halt
        )),
    );
    let (pristine, pre_ses, evaluated, after) = (&runs[0], &runs[2], &runs[3], &runs[4]);

    // (1) The bundle is at the bar: it evaluates without throwing on BOTH
    //     engines, `'ok'` being `eval_wrapped`'s contract for that.
    assert_eq!(
        evaluated.ironhorse_result, "ok",
        "the boot bundle must evaluate without throwing on ironhorse"
    );
    assert_eq!(
        evaluated.oracle_result, "ok",
        "the boot bundle must evaluate without throwing on the oracle"
    );

    // (2) What the bundle DOES, measured as a delta rather than a presence.
    //     `ses_boot.js` bundles `@endo/harden`, `@endo/env-options` and
    //     `@endo/eventual-send` — not the SES shim. Its ONLY `globalThis`
    //     write is `HandledPromise` (`@endo/harden`'s selector merely READS
    //     the `harden` `polyfills.js` already installed), so exactly one
    //     entry may move across the bundle, on both engines alike.
    for (engine, before, then) in [
        (
            "ironhorse",
            &pre_ses.ironhorse_result,
            &after.ironhorse_result,
        ),
        ("oracle", &pre_ses.oracle_result, &after.oracle_result),
    ] {
        // Both strings come from the same `CENSUS`, so a length mismatch
        // means one engine returned something other than a census — check it
        // rather than let `zip` truncate the comparison to the shorter one.
        assert_eq!(
            before.split(' ').count(),
            then.split(' ').count(),
            "on {engine} one census is not a census\n  before: {before}\n  after:  {then}"
        );
        let moved: Vec<_> = before
            .split(' ')
            .zip(then.split(' '))
            .filter(|(a, b)| a != b)
            .collect();
        assert_eq!(
            moved,
            vec![("HandledPromise=undefined", "HandledPromise=function")],
            "on {engine} the bundle must install HandledPromise and touch \
             nothing else in the census\n  before: {before}\n  after:  {then}"
        );
    }

    // (3) Attribution. `harden` and `petrify` are ironhorse's OWN bindings,
    //     not the polyfill's and not the bundle's — the pristine census, taken
    //     before any source runs, is the only crank that can show this.
    for (name, expected) in IRONHORSE_PRISTINE {
        let needle = format!("{name}={expected}");
        assert!(
            pristine.ironhorse_result.contains(&needle),
            "ironhorse's pristine census must read {needle}: {}",
            pristine.ironhorse_result
        );
    }

    // (4) The gap, pinned so it can neither widen nor close silently.
    //
    //     `mutabilities` is now the WHOLE of it, and it is an embedder's
    //     choice rather than a realm intrinsic: `xs_shim.c` installs it for
    //     differential testing and `create_hardened_globals` declines it, with
    //     its reason recorded there. `Compartment` used to be this row --
    //     the one entry XS builds into every realm and ironhorse lacked --
    //     and is not any more.
    //
    //     `rust/endo/xsnap` declares `fx_lockdown`/`fx_harden` in `ffi.rs:274`
    //     and calls neither (`lib.rs:917`), so the daemon's realm has no
    //     `lockdown` either. The oracle's `lockdown`/`mutabilities` are
    //     `xs_shim.c`'s installs, present for differential testing — they are
    //     NOT what the daemon runs on.
    //
    //     So stage 4's remaining work is not "make the bundle run", it is not
    //     "match the oracle's globals", it is no longer "plus whatever
    //     guest-visible `lockdown` the daemon decides it needs" — ironhorse
    //     binds one (`designs/ironhorse-native-lockdown.md`) — and it is no
    //     longer `Compartment` either
    //     (`designs/ironhorse-guest-compartment.md`). See
    //     `designs/ironhorse-ses-compartment-equivalence.md`.
    assert!(
        pristine.oracle_result.contains("Compartment=function"),
        "XS builds Compartment into every realm (xsModule.c:207): {}",
        pristine.oracle_result
    );
    // Rewritten to REQUIRE it, as the previous revision of this assertion
    // asked whoever landed it to do: it used to demand
    // `Compartment=undefined` and to say that a bar requiring the opposite
    // was the right response to a guest `Compartment` landing. A regression
    // that unbinds the global has to fail here rather than quietly reopening
    // the gap.
    assert!(
        after.ironhorse_result.contains("Compartment=function"),
        "ironhorse binds a guest Compartment (`Native::Compartment`), and the \
         boot bundle must not disturb it: {}",
        after.ironhorse_result
    );
    // Rewritten to REQUIRE it, as the previous revision of this assertion
    // asked whoever landed it to do. `ses-mode:lockdown-unimplemented` is gone
    // from `SesMode::unimplemented_skip` and `lockdown` from
    // `DEFAULT_ENDOR_SKIP_FEATURES`; a regression that unbinds the global has
    // to fail here rather than quietly reopening the gap.
    assert!(
        after.ironhorse_result.contains("lockdown=function"),
        "ironhorse binds its own guest lockdown (`Interp::do_lockdown`), and \
         the boot bundle must not disturb it: {}",
        after.ironhorse_result
    );

    eprintln!("stage4-ses: pristine  ih={}", pristine.ironhorse_result);
    eprintln!("stage4-ses: pre-ses   ih={}", pre_ses.ironhorse_result);
    eprintln!("stage4-ses: after     ih={}", after.ironhorse_result);
    eprintln!("stage4-ses: after   xs={}", after.oracle_result);
}
