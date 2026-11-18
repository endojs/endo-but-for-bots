// @ts-check
/**
 * Perf check "restart", part "crash" (`perf/_restart.mjs`):
 * `restart.crashingSession` over CRASH_WINDOW_MS (default 120 s, at least 3
 * runs) after one idle session is set up. Exits 1 while a crashing session's
 * restart misses 15 s (core candidates C-8, C-9), by design.
 *
 *   cd packages/thixotrope-harness && node perf/restart.crash.perf.mjs
 */
import { restartPerf } from './_restart.mjs';

await restartPerf('crash');
