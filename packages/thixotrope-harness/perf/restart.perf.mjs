// @ts-check
/**
 * Perf check "restart", part "serving" (`perf/_restart.mjs`):
 * `restart.serving` over RESTART_WINDOW_MS (default 90 s, at least 3 runs)
 * after 11 sessions are set up. The crashing-session part is
 * `perf/restart.crash.perf.mjs`.
 *
 *   cd packages/thixotrope-harness && node perf/restart.perf.mjs
 */
import { restartPerf } from './_restart.mjs';

await restartPerf('serving');
