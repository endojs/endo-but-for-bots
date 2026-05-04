# Open Endo Issues — Classification Report

This report groups the 338 open issues mirrored under `issues/*.md` by
the component or concern they most directly touch.
Classification is based on the issue title, GitHub labels, and a skim
of the issue body.
Each issue appears in exactly one primary bucket; where an issue spans
multiple areas, the bucket is the one where the change would most
likely land.

## Summary

| Area                                          | Count |
| --------------------------------------------- | ----- |
| SES lockdown, taming, and intrinsics          |    43 |
| Compartments and module loading               |    26 |
| Compartment mapper and bundler                |    30 |
| Errors, assertions, and debugging             |    35 |
| Marshal, pass-style, and patterns             |    23 |
| Eventual send, CapTP, and streams             |    14 |
| Daemon, CLI, and Familiar                     |    25 |
| AI safety initiative (3019–3027)              |     8 |
| OCapN                                         |     5 |
| Ecosystem compatibility (XS, Hermes, RN, etc) |    17 |
| TypeScript and types                          |    18 |
| Tooling, lint, and CI                         |    42 |
| Documentation                                 |    22 |
| Performance                                   |     9 |
| TC39 / standards work                         |     3 |
| Tracking / epic / meta                        |     6 |
| **Total**                                     | **338** |

Counts add up to more than 338 because a handful of tracking issues
are listed both under their topical bucket and under "Tracking".

## SES lockdown, taming, and intrinsics

Work on the SES shim itself: `lockdown()`, the primordial permits
table, anonymous intrinsics, `harden`, Proxy repair, and taming of
individual globals such as `Promise.resolve`, `Object.freeze`, or
`async_hooks`.

- [#105](./105.md) — Propose to tc39 without override mistake
- [#1081](./1081.md) — Harden module exports namespaces
- [#1130](./1130.md) — Tame `Promise.resolve`
- [#1199](./1199.md) — Mark as native function after lockdown
- [#1200](./1200.md) — Start compartment direct `eval` detection
- [#1240](./1240.md) — Symbol-key scope proxy regression test
- [#1346](./1346.md) — New option: do not try to eval anything
- [#1522](./1522.md) — Strict scope terminator may not be strict enough
- [#1688](./1688.md) — Less intrusive async_hooks mitigation in `unsafe-fast`
- [#1756](./1756.md) — Repair Proxy with stamping power
- [#1912](./1912.md) — `harden` as a new integrity level
- [#22](./22.md) — Decide earliest platforms supported
- [#2315](./2315.md) — `atob()` return not limited to ASCII
- [#2319](./2319.md) — Importing `@endo/errors` without importing SES
- [#2428](./2428.md) — Permit intrinsics from explicit-resource-management
- [#2635](./2635.md) — Hardened URL vetted shim
- [#2653](./2653.md) — `async_hooks` fails obscurely when double initialized
- [#2711](./2711.md) — Move Node `async_hooks` taming to SES
- [#2752](./2752.md) — Tighten SES distribution to source code
- [#2760](./2760.md) — `hardenIntrinsics()` twice emits `ses_already_locked_down`
- [#2771](./2771.md) — Lockdown option for strict scope terminator global check
- [#2813](./2813.md) — Hardened `TextDecoder` with Node fast path
- [#2858](./2858.md) — Throw `AggregateError` for module load errors
- [#2968](./2968.md) — Warn when post-lockdown `harden` implicitly hardens prototypes
- [#2983](./2983.md) — Decouple lockdown from Endo's hardened modules
- [#3101](./3101.md) — Lockdown compat with libp2p-yamux `AsyncGenerator.return`
- [#3202](./3202.md) — `setFloat16`/`setFloat32` zero-byte regression for NaN
- [#319](./319.md) — Are we safe from `document.all`?
- [#390](./390.md) — Replacement for `get-intrinsics.test.js`
- [#448](./448.md) — Imports named `__proto__` in `StaticModuleRecord`
- [#490](./490.md) — Wiring up `panic()` at the SES level
- [#551](./551.md) — Permit `WeakRef`/`FinalizationGroup` only in start compartment
- [#630](./630.md) — Override-mistake explainer and issue template
- [#662](./662.md) — Detect if SES is being transformed
- [#676](./676.md) — Replace `toString` overrides with `@@toStringTag`
- [#73](./73.md) — Agoric evaluate: global object leaking between tests
- [#791](./791.md) — Permit unshared magic (`WeakRef`, `Atomics`)
- [#797](./797.md) — Ensure no new anonIntrinsics creep in
- [#841](./841.md) — `makeHardener` as an arrow function
- [#842](./842.md) — Reflexive assertions on SES permits
- [#847](./847.md) — Rename `sloppyGlobalsMode`
- [#882](./882.md) — Tame XS `Object.freeze`
- [#902](./902.md) — Syntax-based anonIntrinsics vs transpilers
- [#903](./903.md) — Fail-safe for environments without `unsafe-eval` CSP
- [#909](./909.md) — `harden` 262-style tests (order, atomicity)
- [#923](./923.md) — Trojan-Source risk for SES/Jessie users
- [#2951](./2951.md) — SES v8 sniff test too weak

## Compartments and module loading

The SES `Compartment` and the ecosystem surrounding
`StaticModuleRecord`, `importHook`, module namespaces, live bindings,
and module-source protocol.

- [#1124](./1124.md) — Opaque errors for hidden identifier censorship
- [#1551](./1551.md) — Compartments with no evaluators exposed
- [#1583](./1583.md) — Why modules instantiate uniquely per compartment
- [#1706](./1706.md) — Expose `re-export` field in `StaticModuleRecord`
- [#1805](./1805.md) — `static-module-record`: invalid transformation
- [#1837](./1837.md) — Valid JS considered an HTML comment
- [#1995](./1995.md) — `compartment.globalThis.AsyncFunction`
- [#2110](./2110.md) — Import attribute portability
- [#2201](./2201.md) — Add `importNowHook` to SES `Compartment`
- [#2259](./2259.md) — Test parity between XS and SES `Compartment`
- [#2466](./2466.md) — `importNowHook` optimizations
- [#2590](./2590.md) — Forbid top-level-await in `__syncModuleProgram__`
- [#2721](./2721.md) — `import.meta.resolve`
- [#2900](./2900.md) — Support `import with { type: ... }` attributes
- [#2912](./2912.md) — Unexpectedly undefined `import.meta`
- [#300](./300.md) — Grand-child compartments (import-map inheritance)
- [#306](./306.md) — Compartment support for top-level await
- [#522](./522.md) — Remove `location` arg from `StaticModuleRecord`
- [#52](./52.md) — Test: setting prototype of namespaces disallowed
- [#59](./59.md) — Unresolved star re-exports
- [#64](./64.md) — Live bindings across imported/exported identifiers
- [#815](./815.md) — Just one `makeCompartmentConstructor`
- [#890](./890.md) — Module statics like unhardened primordials
- [#911](./911.md) — Propagating globals through child compartments
- [#912](./912.md) — Module shim lexicals leak live bindings object
- [#960](./960.md) — Static module types in `moduleMap`/`moduleMapHook`

## Compartment mapper and bundler

`@endo/compartment-mapper`, `@endo/bundle-source`, `@endo/import-bundle`,
archive format, evasive transforms, policy types, source maps.

- [#1054](./1054.md) — Performance of `bundleSource`/`importBundle` in XS
- [#1079](./1079.md) — LavaMoat/TOFU policy support
- [#1100](./1100.md) — Integration test with publish + install
- [#1123](./1123.md) — Compartment-mapper parity with Node.js ecosystem
- [#1153](./1153.md) — `import.meta.url` and `require.resolve`
- [#1217](./1217.md) — Evasive transform for HTML comments in strings
- [#1238](./1238.md) — Show import graph path when bundler can't find a module
- [#1364](./1364.md) — Conflicting `"."`/`"./"` in npm exports
- [#1420](./1420.md) — `importHook` for Node-internal modules
- [#1460](./1460.md) — Bundles with ESM exports
- [#1482](./1482.md) — Policy `write` option for globals
- [#1596](./1596.md) — Source-transformation error
- [#1625](./1625.md) — Externalize eventual-send in bundles
- [#1653](./1653.md) — Compartment maps and host modules
- [#1656](./1656.md) — Bundle auditing tool (`endo unbundle`)
- [#1776](./1776.md) — Policy types
- [#1816](./1816.md) — `bundle-source` strips comments from `type.js`
- [#1845](./1845.md) — Better diagnostic when `package.json` has no `name`
- [#1882](./1882.md) — SourceMap cache key must vary by source + context
- [#1906](./1906.md) — `importBundle` unconditional source map URL
- [#1926](./1926.md) — Bundle transform mishandles trailing comments
- [#2036](./2036.md) — Bundler integration tests
- [#2116](./2116.md) — On-disk module sources transparent in VSCode
- [#2117](./2117.md) — Module sources transparent to auditors
- [#2127](./2127.md) — Non-sequential, non-deterministic package ids
- [#2203](./2203.md) — Support `imports` in `package.json`
- [#2252](./2252.md) — XS/Node bundler parity tests
- [#2254](./2254.md) — Move Babel from `bundleSource` to `importBundle`
- [#2265](./2265.md) — Subpath pattern exports
- [#2343](./2343.md) — Bundle one version per (name[, version])
- [#2388](./2388.md) — Migrate compartment-map tags to conditions
- [#2410](./2410.md) — Tolerate non-normative `compartment-map.json` fields
- [#2411](./2411.md) — Import tracer
- [#2431](./2431.md) — Live bindings for `export let`
- [#2586](./2586.md) — Modules declaring required lockdown/Endo
- [#2649](./2649.md) — `import.meta.url` does not work for class methods
- [#2671](./2671.md) — Relax compartment-map validation for new fields
- [#2736](./2736.md) — Evasive transform: evade hashbangs
- [#2756](./2756.md) — Bundler simulates SES censorship
- [#2800](./2800.md) — Extract evasive-transform core API
- [#2886](./2886.md) — `captureFromMap` incompatible with dynamic requires
- [#2894](./2894.md) — Compartment-map transforms
- [#2896](./2896.md) — Narrow constraints for `Policy` type args
- [#2898](./2898.md) — Support `package.json` `imports` field
- [#2899](./2899.md) — Support floating `package.json` for module-type inference
- [#3125](./3125.md) — Support Yarn PnP
- [#3190](./3190.md) — Parses happen once per specifier instead of per module
- [#423](./423.md) — Thread powers by policy
- [#629](./629.md) — Package-name integrity in maps/policies
- [#670](./670.md) — Archived apps composed of archived libraries
- [#953](./953.md) — Piecemeal Endo archive transport

## Errors, assertions, and debugging

Error taming, `assert`, causal console, stack handling, error
annotation, and the error-serialization story that motivates the new
[error-tracing design](../docs/error-tracing-design.md).

- [#1093](./1093.md) — Bad source position for stack frames in our functions
- [#1208](./1208.md) — `TypeError#1` with React + Styled Components
- [#1244](./1244.md) — `track-turns` vs overridden `.catch`
- [#1429](./1429.md) — Error codes not discoverable
- [#154](./154.md) — V8/Chrome "unexpected scope handler trap: splice"
- [#1568](./1568.md) — Tame `Promise.all` for causal tracing
- [#1798](./1798.md) — Use `prepareStackTrace` for v8 error taming
- [#1810](./1810.md) — Error stack strings not consistent
- [#1843](./1843.md) — Error serialization issue (extra unpassed props)
- [#1879](./1879.md) — Usable traces across workers — **addressed by [error-tracing design](../docs/error-tracing-design.md)**
- [#2329](./2329.md) — SES source maps
- [#2339](./2339.md) — Export `Details` type from `@endo/errors`
- [#2430](./2430.md) — `SES_IMPORT_REJECTED` lacks location
- [#2656](./2656.md) — Assert expected names of console methods
- [#2891](./2891.md) — Self-identification for errors
- [#2941](./2941.md) — SES error censorship issues
- [#371](./371.md) — Ava failed-assertion stacks under safe error taming
- [#486](./486.md) — User docs for assert/console/Error
- [#488](./488.md) — Source-prefix stackframe filter
- [#492](./492.md) — Annotate errors with originating compartment
- [#505](./505.md) — Serialization errors disappear without a trace
- [#529](./529.md) — Collate distributed error annotations
- [#579](./579.md) — Tests comparing console output text
- [#636](./636.md) — Node console confused when `constructor` is an accessor
- [#677](./677.md) — Reevaluate `", got ${}"` style systematically
- [#730](./730.md) — Use `Compartment.p.evaluate` instead of eight magic lines (XS)
- [#731](./731.md) — Exception unsealer for SES console
- [#805](./805.md) — SES logs all error lines to Node stderr
- [#839](./839.md) — Type errors from `freeze(causalConsole)`
- [#913](./913.md) — Decouple `stackFiltering` from `stackShortening`
- [#915](./915.md) — Bundle label for debugging
- [#929](./929.md) — IDE breakpoints when debugging Endo archives
- [#944](./944.md) — Bare `Error` instance logs wrong
- [#945](./945.md) — Separate console taming from causal console
- [#979](./979.md) — Base console level

## Marshal, pass-style, and patterns

`@endo/marshal`, `@endo/pass-style`, `@endo/patterns`, CapData /
smallcaps, remotables, ranks, `kindOf`.

- [#1193](./1193.md) — Revise terminology of `Far`
- [#1295](./1295.md) — Function/method guards
- [#1312](./1312.md) — Marshal: allow promise stand-ins
- [#1339](./1339.md) — Redundancy between `confirmedRemotables` and `passStyleMemo`
- [#1478](./1478.md) — Define CapData / smallcaps terms
- [#1582](./1582.md) — `makeMarshal` for es2017 / Apps Script
- [#1648](./1648.md) — Heap exo state storing non-Passables
- [#1739](./1739.md) — `passStyleOf` must validate `isWellFormed`
- [#1747](./1747.md) — `compactOrdered decodePassable` parsing cost
- [#1752](./1752.md) — `CopyRecord` comparison Pareto order
- [#1782](./1782.md) — Expose `CapDataShape`
- [#2096](./2096.md) — `isPassable` without try/catch
- [#2112](./2112.md) — Schema compression for redundant data
- [#2113](./2113.md) — Compare strings by codepoint
- [#2448](./2448.md) — Utility to combine extant exos
- [#2600](./2600.md) — `compactOrdered` `"~"` encoding prefix
- [#2611](./2611.md) — `mustMatch` support for `TypedPattern`
- [#2883](./2883.md) — `compareRank` vs `compareRankRemotablesTied`
- [#2884](./2884.md) — Abstract `canBeMethodName`
- [#2974](./2974.md) — Pass-by-ref type "note"
- [#2991](./2991.md) — CapData with top-level iface info
- [#3046](./3046.md) — Rank cover over partial tuple prefix
- [#3051](./3051.md) — `kindOf` looks at inherited props
- [#3052](./3052.md) — `getRankCover(kindMatcher)` treats `copyBag` as pass style
- [#3054](./3054.md) — Light smallcaps
- [#3072](./3072.md) — Discriminated-union patterns with better errors
- [#3079](./3079.md) — Limited regular-expression matcher
- [#3156](./3156.md) — Pass-style: `document.all` not undefined
- [#414](./414.md) — Port Caja Ejectors / Guards / Trademarks
- [#691](./691.md) — UTF-16 canonicalization
- [#991](./991.md) — Triage old marshal issues

## Eventual send, CapTP, and streams

`@endo/eventual-send`, `@endo/captp`, `@endo/stream`, track-turns,
pubsub.

- [#1003](./1003.md) — `E.when` analog for malicious streams
- [#1035](./1035.md) — Migrate `Notifier` from Agoric SDK
- [#1176](./1176.md) — Wrap errors when target resolution throws
- [#1181](./1181.md) — `await`/`E.when` vs evil promise reentrancy
- [#1182](./1182.md) — Are updaters the dual of iterators?
- [#1444](./1444.md) — Minimal pubsub from `@endo/stream`
- [#1652](./1652.md) — Plan for improved eventual-send
- [#1686](./1686.md) — Terminate CapTP in non-hardened realm
- [#2336](./2336.md) — `E.sendOnly` void return type
- [#2371](./2371.md) — Refactor for `Promise.withResolvers`
- [#2397](./2397.md) — `zone.slot()` abstraction
- [#2869](./2869.md) — Eventual-send pinhole `then` protocol
- [#2986](./2986.md) — Eventual-send types should map the result

## Daemon, CLI, and Familiar

`@endo/daemon`, `@endo/cli`, the `familiar` Electron shell, pet
stores, hosts, guests, workers, mail.

- [#1042](./1042.md) — Endo Chrome Extension
- [#1610](./1610.md) — Endo Pet Daemon spikes
- [#2021](./2021.md) — `eval`-mediated worker names do not resolve
- [#2023](./2023.md) — Dot-delimited petname paths
- [#2041](./2041.md) — Termination hook on `lookup` formula
- [#2074](./2074.md) — `endo cancel` propagation
- [#2098](./2098.md) — One lookup formula per path segment
- [#2128](./2128.md) — Content-address `readable-blob` formula id
- [#2167](./2167.md) — Consider locator format
- [#2207](./2207.md) — Test formula write failure and recovery
- [#2215](./2215.md) — `followLocatorNameChanges()` incomplete
- [#2216](./2216.md) — Consumers can end subscriptions
- [#2218](./2218.md) — Immediate reincarnation of cancelled subgraphs
- [#2242](./2242.md) — Daemon CapTP EPIPE on write
- [#2249](./2249.md) — Daemon hang using TCP
- [#2289](./2289.md) — Guest access to evaluate / makeBundle / storeValue / storeBlob
- [#2426](./2426.md) — Stepping-debugger support in workers
- [#3027](./3027.md) — Filesystem capability
- [#3081](./3081.md) — Dead code in CLI `run` command
- [#3181](./3181.md) — Flake: daemon lifecycle fails on macOS with EPIPE
- [#879](./879.md) — Epic: Endo Pet Daemon / Familiar Chat

## AI safety initiative

The 2024–2026 arc of work safely empowering AI-written code, largely
consecutively numbered.

- [#3019](./3019.md) — Safely empower AI-written code with Endo
- [#3020](./3020.md) — Familiar Chat Capp
- [#3021](./3021.md) — Create Endo AI Agent Capp
- [#3022](./3022.md) — Demo instructions
- [#3023](./3023.md) — LLM prompt for worker confined execution
- [#3024](./3024.md) — Pet dæmon improvements
- [#3025](./3025.md) — Guest code evaluation requests
- [#1830](./1830.md) — Prototype orthogonal persistence on the web

## OCapN

Conformance with the OCapN spec, syrup, and Capability Transport
Protocol interop.

- [#1587](./1587.md) — `@endo/pass-style` changes for OCapN conformance
- [#1588](./1588.md) — Marshal spec / interop tests
- [#1602](./1602.md) — `-0` round-tripping in pass-style
- [#1996](./1996.md) — Track OCapN spec consensus
- [#3038](./3038.md) — Ocap glossary

## Ecosystem compatibility

Keeping SES and Endo running on non-v8 engines and in ecosystems
whose idioms are not pure ESM: XS, Hermes, React Native, iOS Safari,
Node/Windows, cosmos scaffolds, Webpack.

- [#1066](./1066.md) — Sync XS dynamic module loading
- [#1984](./1984.md) — Non-iterator string ops slow in XS
- [#2033](./2033.md) — `create-cosmos-app` lockdown failure
- [#2037](./2037.md) — Ecosystem compatibility tracking (2024-02-05 onward)
- [#2169](./2169.md) — Minified-lockdown not reachable via `ses` exports
- [#2259](./2259.md) — Test parity between XS and SES `Compartment` *(cross-listed)*
- [#2761](./2761.md) — SES Hermes improvements tracking
- [#2823](./2823.md) — `package.json` scripts on Windows
- [#2859](./2859.md) — Document supported platforms
- [#400](./400.md) — XS native compartments for Agoric vat workers
- [#661](./661.md) — React Native tracking
- [#681](./681.md) — Migrate xsnap to Endo
- [#739](./739.md) — Test zip library under xsnap
- [#848](./848.md) — XS snapshots + native compartments
- [#934](./934.md) — XS interpretation of `Date()`/`Math.random()`
- [#947](./947.md) — iOS Safari lockdown fix
- [#23](./23.md) — Web Workers support
- [#1368](./1368.md) — Upgrade Webpack in SES integration tests
- [#2230](./2230.md) — Test pre-release platforms

## TypeScript and types

JSDoc types, `tsconfig`, `harden()` readonly, `tsc` and TypeDoc/TSDoc,
IDE hover.

- [#1191](./1191.md) — TypeScript environment for Endo
- [#1254](./1254.md) — Export explicit types
- [#1392](./1392.md) — Assert members lack JSDoc in IDE
- [#1755](./1755.md) — jsdoc/check-types in `@endo/eslint-plugin`
- [#2178](./2178.md) — Arrow-function JSDoc missing in IDE
- [#2183](./2183.md) — `ses` assert docs don't show via typedoc
- [#2244](./2244.md) — `harden()` readonly type
- [#2270](./2270.md) — `compilerOptions.lib` / `target` note for SES
- [#2579](./2579.md) — Wrong TS interface for `Compartment.evaluate` options
- [#2651](./2651.md) — `ts-blank-space` loader hook
- [#2698](./2698.md) — One package causing type errors elsewhere
- [#2712](./2712.md) — Harmonize TypeScript configs
- [#2834](./2834.md) — `bundleSource` type doesn't capture `cacheSourceMaps`
- [#2847](./2847.md) — Error/warn on type-only global var declarations
- [#2921](./2921.md) — False-positive type references
- [#2979](./2979.md) — Combine Remotable types
- [#3060](./3060.md) — Arrays typed `readonly` aren't Passable
- [#600](./600.md) — "No any" lint rule

## Tooling, lint, and CI

`@endo/eslint-plugin`, CI workflows, flake management, repo hygiene,
test262 scaffolding, integration tests, docs linting.

- [#1100](./1100.md) — Integration test with publish + install *(cross-listed)*
- [#1226](./1226.md) — Lint rule for safe logging with `details`/`q`
- [#1298](./1298.md) — Endo tests missing `@endo/init`
- [#132](./132.md) — Copy Caja tests into SES repo
- [#164](./164.md) — SES command-line REPL
- [#1761](./1761.md) — Integration tests in dependent repos on changes
- [#1857](./1857.md) — Endo library scaffold
- [#1861](./1861.md) — Publish pre-release builds to npm
- [#1866](./1866.md) — Agoric integration testing
- [#2129](./2129.md) — Browser tests on canary browsers
- [#2196](./2196.md) — Remove package cycles
- [#2197](./2197.md) — Cross-implementation microbenchmarking tool
- [#2243](./2243.md) — Re-enable Windows CI
- [#2331](./2331.md) — Upgrade some actions
- [#2335](./2335.md) — Add sha256 like base64
- [#2390](./2390.md) — `harden-exports` mishandles many exports
- [#242](./242.md) — Investigate test262 exclusion lists
- [#2457](./2457.md) — GitHub composite action for CI
- [#2632](./2632.md) — `harden-exports` knows Pattern makers are hardened
- [#2634](./2634.md) — Flake: loopback gc
- [#2682](./2682.md) — Upgrade ESLint to v9
- [#2697](./2697.md) — `CHANGELOG.md` template accidentally updated
- [#26](./26.md) — Epic: shift tests to test262
- [#2740](./2740.md) — `@endo/eslint-plugin` flat recommended config
- [#2749](./2749.md) — Disable `require-param` for TS files
- [#2759](./2759.md) — Lint `.md` docs
- [#2805](./2805.md) — Coverage for `importNow`/`import`
- [#2807](./2807.md) — Possible flaky test
- [#2879](./2879.md) — Per-compartment env-options setting test
- [#2890](./2890.md) — "install engines" step is flaky
- [#2904](./2904.md) — Another frequent CI flake
- [#2925](./2925.md) — Copilot instructions
- [#3007](./3007.md) — Eslint-plugin for import typedefs
- [#3050](./3050.md) — OpenSSF Security Scorecard
- [#3071](./3071.md) — No-bigint-literal lint rule for Apps Script
- [#3151](./3151.md) — `eslint-plugin-jsdoc` and TypeDoc/TSDoc tags
- [#1387](./1387.md) — Integration test for unpkg
- [#1755](./1755.md) — `jsdoc/check-types` *(cross-listed under Types)*
- [#2328](./2328.md) — `compartment-mapper` build fails with pnpm
- [#692](./692.md) — Coverage over `compareByteArrays`
- [#87](./87.md) — Harden: test objects with getters/setters
- [#870](./870.md) — SES test262 conformance suite
- [#922](./922.md) — Fix `@agoric/harden` deprecation notice

## Documentation

User- and contributor-facing docs, tutorials, glossaries, stale docs.

- [#1237](./1237.md) — Provide / link a tutorial
- [#1379](./1379.md) — Hardened JS escape-room feedback
- [#1682](./1682.md) — `env-options` README
- [#1695](./1695.md) — Clarify extent of hardening guarantees
- [#1769](./1769.md) — Docs say `lockdown()` freezes `globalThis`
- [#1948](./1948.md) — Document platform math determinism limits
- [#2299](./2299.md) — Document `CopySet`/`CopyTagged`
- [#2742](./2742.md) — Document `Compartment` availability / OOM limits
- [#289](./289.md) — "Would be nice to know why this is useful"
- [#302](./302.md) — Document `Compartment` and translators
- [#310](./310.md) — SES docs stale since before Compartments
- [#3140](./3140.md) — API maturity policy
- [#6](./6.md) — How to build SES distribution files
- [#808](./808.md) — Update `draft-standalone-spec.md`
- [#825](./825.md) — Document how to safely use `harden`
- [#957](./957.md) — Required order for `lockdown()` in ESM
- [#1583](./1583.md) — Why modules are per-compartment *(cross-listed)*
- [#1429](./1429.md) — Error codes not discoverable *(cross-listed)*
- [#486](./486.md) — User docs for assert/console/Error *(cross-listed)*
- [#1478](./1478.md) — Define CapData / smallcaps *(cross-listed)*
- [#3038](./3038.md) — Ocap glossary *(cross-listed)*
- [#2859](./2859.md) — Document supported platforms *(cross-listed)*

## Performance

Issues labeled `performance` or whose primary concern is wall-clock,
memory, or throughput.

- [#1339](./1339.md) — Redundant weak-set/map *(cross-listed)*
- [#1530](./1530.md) — Optimize `bestEffortStringify`
- [#1747](./1747.md) — `compactOrdered decodePassable` reparsing *(cross-listed)*
- [#1848](./1848.md) — Pattern labeling nested contexts
- [#1999](./1999.md) — Optimized base64 on Node
- [#2197](./2197.md) — Microbenchmarking tool *(cross-listed)*
- [#2466](./2466.md) — `importNowHook` optimizations *(cross-listed)*
- [#3190](./3190.md) — Parses once per specifier *(cross-listed)*
- [#1054](./1054.md) — `bundleSource`/`importBundle` in XS *(cross-listed)*

## TC39 / standards work

Proposals upstream to ECMA-262.

- [#1954](./1954.md) — Mark transparent scope objects for `with` blocks
- [#819](./819.md) — ECMA-262 invariant for proxy handlers
- [#105](./105.md) — Propose TC39 without override mistake *(cross-listed)*

## Tracking / epic / meta

Long-lived tracking issues and epics that gather other issues.

- [#2037](./2037.md) — Ecosystem compatibility (2024-02-05 onward)
- [#2761](./2761.md) — SES Hermes improvements tracking
- [#661](./661.md) — React Native compat tracking
- [#681](./681.md) — Migrate xsnap to Endo
- [#879](./879.md) — Epic: Endo Pet Daemon / Familiar Chat
- [#26](./26.md) — Epic: shift tests to test262

## Cross-cutting observations

- **Error legibility dominates the long tail.**
  Thirty-five issues live in the errors/debugging bucket, and a
  further handful in daemon (e.g. #1879) and marshal (e.g. #1843,
  #505).
  A cross-cutting investment in correlation identifiers, causal
  traces, and stack-filter defaults would retire a noticeable
  fraction of the backlog at once.
  The [error-tracing design](../docs/error-tracing-design.md) added
  in this branch addresses the worker/daemon slice.
- **The compartment-mapper is the largest component surface.**
  Thirty issues touch bundling/mapping, including several near-term
  bugs (#1926, #2981, #2982, #3190).
  A modest cleanup sprint could retire a double-digit count.
- **Ecosystem compatibility is sticky and long-running.**
  XS, Hermes, and React Native each have dedicated tracking issues
  (#2761, #661, #2037).
  These are not closable individually; they organize recurring
  triage.
- **AI-safety issues are a coherent arc.**
  #3019–#3027 collectively describe the Familiar + guest-evaluation
  + filesystem-capability stack; they should be read as a single
  program rather than individual features.
- **"kriskowal-review-2024-01" is the dominant label.**
  One hundred twelve issues carry it, which reflects a triage pass
  from early 2024 rather than a topical bucket; it is not used in
  this report.
