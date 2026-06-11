/**
 * Contract test (#290): the highest-risk, least-covered seam.
 *
 * `packages/familiar/scripts/bundle.mjs` bundles `packages/lal/setup.js` (as
 * CJS) and `packages/lal/agent.js` (as an ESM caplet the daemon worker
 * `import()`s at runtime via `makeUnconfined`). Since #290 rewrote agent.js
 * onto genie's pi-agent harness, agent.js now imports `agent-round.js`,
 * `transcript-persistence.js`, and the `@earendil-works/pi-*` packages. If
 * the bundler cannot resolve and inline those into a single loadable caplet,
 * the familiar app's agent loop is broken at runtime even though every unit
 * test passes — a failure mode no other test in the repo catches.
 *
 * This test runs the real familiar bundle step as a subprocess, then asserts
 * the emitted artifacts:
 *   - the ESM agent.js bundle parses as a module (`node --check`),
 *   - it inlined the new lal modules and the pi packages (no dangling
 *     unresolved import to a file the worker cannot reach),
 *   - the CJS setup.js bundle parses,
 *   - the bundle's only runtime externals are node builtins plus the known
 *     optional native deps the bundle config marks external.
 *
 * Uses Node's built-in `node:test` runner so the familiar package needs no
 * new test dependency. Run with: `node --test test/bundle-smoke.test.mjs`
 * from `packages/familiar/` (or wire `"test": "node --test test/"`).
 *
 * The bundle step is slow (it also bundles the cli/daemon/worker). The test
 * carries a generous timeout; CI should give it room or split the lal-only
 * bundle into its own script if this proves too coarse.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const familiarRoot = path.resolve(dirname, '..');
const bundlesDir = path.join(familiarRoot, 'bundles');
const agentBundle = path.join(bundlesDir, 'agent.js');
const setupBundle = path.join(bundlesDir, 'endo-lal-setup.cjs');

// Run the real bundle step once before the assertions.
test('familiar bundle step succeeds (lal agent + setup caplets)', () => {
  // `node scripts/bundle.mjs` is the `step:bundle` script. execFileSync
  // throws on non-zero exit, which fails the test with the build error.
  execFileSync('node', ['scripts/bundle.mjs'], {
    cwd: familiarRoot,
    stdio: 'pipe',
    timeout: 5 * 60 * 1000,
  });
  assert.ok(existsSync(agentBundle), 'agent.js ESM caplet was emitted');
  assert.ok(existsSync(setupBundle), 'endo-lal-setup.cjs was emitted');
});

test('emitted agent.js caplet parses as an ES module', () => {
  // `node --check` over stdin as a module: the worker import()s this file as
  // ESM, so it must be syntactically valid module source.
  execFileSync('node', ['--check', '--input-type=module'], {
    input: readFileSync(agentBundle),
    stdio: 'pipe',
  });
});

test('emitted setup.js bundle parses as CJS', () => {
  execFileSync('node', ['--check', setupBundle], { stdio: 'pipe' });
});

test('agent.js caplet inlined the new lal modules and pi packages', () => {
  const src = readFileSync(agentBundle, 'utf8');
  // The #290 modules and the pi harness must be inlined into the single
  // caplet — not left as bare imports the runtime worker cannot resolve.
  for (const marker of [
    'runAgentRound', // from ./agent-round.js
    'persistTurnDelta', // from ./transcript-persistence.js
    'loadPersistedTranscript', // from ./transcript-persistence.js
  ]) {
    assert.ok(
      src.includes(marker),
      `expected the bundle to inline "${marker}"; a bare/unresolved import ` +
        `here means the worker would fail to load the caplet at runtime`,
    );
  }
  // No dangling ESM import of a sibling lal source file should survive
  // bundling (those must be inlined, not left as ./agent-round.js etc.).
  assert.ok(
    !/from\s+["']\.\/agent-round\.js["']/.test(src),
    'agent-round.js should be inlined, not left as a bare relative import',
  );
  assert.ok(
    !/from\s+["']\.\/transcript-persistence\.js["']/.test(src),
    'transcript-persistence.js should be inlined, not a bare relative import',
  );
});

test('agent.js caplet top-level externals are node builtins + known optionals', async () => {
  const src = readFileSync(agentBundle, 'utf8');
  // The contract that matters at runtime: every module the worker caplet
  // genuinely defers to a runtime `require()` must be resolvable in the
  // worker's environment (node builtins) or be a guarded optional. esbuild
  // rewrites internal cross-module references to a private `__require(...)`
  // shim, so a naive `__require("X")` scan over the whole bundle catches
  // false positives (a package's own self-name require, doc-comment strings).
  //
  // We therefore restrict the check to the bundle's BANNER-LEVEL `require`
  // (the createRequire shim) plus the small set of genuinely-external bare
  // requires that survive esbuild's bundling: those are the ones marked
  // `external` in scripts/bundle.mjs plus transitive optionals required in a
  // try/catch (color/auth). The allow-list below is the deliberate contract;
  // a NEW non-builtin, NON-guarded external would be the regression we want
  // to catch, and a reviewer should confirm any addition is guarded.
  const { builtinModules } = await import('node:module');
  const builtins = new Set(builtinModules.map(n => n.replace(/^node:/, '')));
  // NOTE: this allow-list is curated BY HAND on purpose, and the test failing
  // loudly when a new external appears is the feature, not a bug. Each entry
  // is a non-builtin module the bundle legitimately defers to a runtime
  // require — an optional native dep marked `external` in scripts/bundle.mjs
  // (bufferutil, utf-8-validate) or a transitive optional required in a
  // try/catch (supports-color) or inlined-but-self-requiring (the pi-ai
  // google-auth-library provider). When a NEW external surfaces here, the
  // intended action is to REVIEW it first (confirm it is genuinely inlined or
  // guarded so the worker caplet — which has no node_modules — will not crash
  // at load), THEN add it deliberately with a one-line justification. Do not
  // silence the failure by reflexively widening the set; the loud failure is
  // exactly the regression signal this smoke test exists to raise.
  const KNOWN_OPTIONAL_EXTERNALS = new Set([
    'bufferutil', // optional ws native, marked external in bundle.mjs
    'utf-8-validate', // optional ws native, marked external in bundle.mjs
    'supports-color', // debug's color probe, required in try/catch
    'google-auth-library', // pi-ai Gemini/Vertex provider, inlined+self-req
  ]);

  // Heuristic external scan, reported as DIAGNOSTIC rather than a hard fail
  // on the heuristic itself: assert only that every flagged non-builtin is on
  // the reviewed allow-list. New unreviewed externals fail loudly here.
  const externals = new Set();
  for (const m of src.matchAll(/\b(?:__)?require\(["']([^"']+)["']\)/g)) {
    const name = m[1].replace(/^node:/, '');
    // Skip obvious non-specifiers (absolute/relative paths, doc-comment
    // example strings that happen to look like requires).
    if (!name.startsWith('/') && !name.startsWith('.')) {
      externals.add(name);
    }
  }
  const unreviewed = [...externals].filter(
    e => !builtins.has(e) && !KNOWN_OPTIONAL_EXTERNALS.has(e),
  );
  assert.deepEqual(
    unreviewed,
    [],
    `bundle defers unreviewed non-builtin module(s) to runtime require: ` +
      `${unreviewed.join(', ')}. The worker caplet has no node_modules; ` +
      `confirm each is inlined or guarded (try/catch), then add it to ` +
      `KNOWN_OPTIONAL_EXTERNALS with a one-line justification.`,
  );
});
