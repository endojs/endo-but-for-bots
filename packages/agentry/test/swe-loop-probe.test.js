// @ts-check

/**
 * Smoke tests for the swe-loop-probe gap-revealing prototype.
 *
 * These tests verify that the probe functions import and behave as
 * documented — the clear-path functions compose, and the gap-path
 * functions throw with the expected gap message. No contract tests
 * are written against the unfinalized design (per the probe skill's
 * § Notes).
 */

import test from '@endo/ses-ava/prepare-endo.js';

import {
  probeClone,
  probeWorktreeAuthority,
  probeExec,
  probeFileWrite,
  probeFileRead,
  probeAddCommit,
  probePush,
  probeFileWriteSurface,
} from '../src/execute/swe-loop-probe.js';

// ---------------------------------------------------------------------------
// Gap stubs throw with the documented gap message
// ---------------------------------------------------------------------------

test('probeClone throws — clone is not available on any code-mode capability surface', async t => {
  await t.throwsAsync(probeClone({}), {
    message: /clone is not available on any code-mode capability surface/,
  });
});

test('probeExec throws — no exec/spawn power is exposed as a code-mode lexical capability', async t => {
  await t.throwsAsync(probeExec({}), {
    message:
      /no exec\/spawn power is exposed as a code-mode lexical capability/,
  });
});

test('probePush throws — push requires a GitRemote cap that is not accessible from code-mode', async t => {
  await t.throwsAsync(probePush({}), {
    message:
      /push requires a GitRemote cap that is not accessible from code-mode/,
  });
});

// ---------------------------------------------------------------------------
// Clear-path stubs import without error (smoke — no live daemon available)
// ---------------------------------------------------------------------------

test('probeFileWrite is a callable function', t => {
  t.is(typeof probeFileWrite, 'function');
});

test('probeFileRead is a callable function', t => {
  t.is(typeof probeFileRead, 'function');
});

test('probeAddCommit is a callable function', t => {
  t.is(typeof probeAddCommit, 'function');
});

test('probeWorktreeAuthority is a callable function', t => {
  t.is(typeof probeWorktreeAuthority, 'function');
});

test('probeFileWriteSurface is a callable function', t => {
  t.is(typeof probeFileWriteSurface, 'function');
});
