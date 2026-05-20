// @ts-nocheck
/* global process */

import os from 'os';
import path from 'path';
import test from 'ava';
import url from 'url';
import { $ } from 'execa';

const dirname = url.fileURLToPath(new URL('.', import.meta.url)).toString();

const testRoot = path.join(dirname, 'tmp', 'endo-trace');
const endoEnv = {
  XDG_STATE_HOME: path.join(testRoot, 'state'),
  XDG_RUNTIME_DIR: path.join(testRoot, 'run'),
  XDG_CACHE_HOME: path.join(testRoot, 'cache'),
  ENDO_SOCK: path.join(os.tmpdir(), `endo-trace-${process.pid}.sock`),
  ENDO_ADDR: '127.0.0.1:0',
};

for (const [key, value] of Object.entries(endoEnv)) {
  process.env[key] = value;
}

test.serial(
  'endo trace --stats reports an aggregator on a fresh daemon',
  async t => {
    const execa = $({ cwd: dirname });
    await execa`endo purge -f`;
    await execa`endo start`;
    try {
      const result = await execa`endo trace --stats --json`;
      const stats = JSON.parse(result.stdout);
      t.is(typeof stats.workers, 'number');
      t.is(typeof stats.totalRecords, 'number');
      t.is(typeof stats.bytes, 'number');
      t.is(typeof stats.aliases, 'number');
    } finally {
      await execa`endo purge -f`;
    }
  },
);

test.serial(
  'endo trace --recent shows a worker emission after a failing eval',
  async t => {
    const execa = $({ cwd: dirname });
    await execa`endo purge -f`;
    await execa`endo start`;
    try {
      // Trigger a failing eval; the CLI exits non-zero, which execa
      // surfaces as a thrown ExecaError.
      await t.throwsAsync(
        execa`endo eval ${'throw new Error("trace-cli-boom")'}`,
      );

      const result = await execa`endo trace --recent --limit 5 --json`;
      /** @type {Array<{ message: string, workerId: string }>} */
      const list = JSON.parse(result.stdout);
      t.true(Array.isArray(list));
      t.true(Array.isArray(list) && list.length >= 1);
      const found = list.find(r => /trace-cli-boom/.test(r.message));
      t.truthy(
        found,
        `expected a record matching 'trace-cli-boom' in ${result.stdout}`,
      );
      // The aggregate stamps the worker's authoritative id; a worker
      // emission must not be filed under @daemon.
      t.true(found.workerId !== '@daemon');
    } finally {
      await execa`endo purge -f`;
    }
  },
);

test.serial(
  'endo eval surfaces the worker id, throw-site stack, and ses-unredacted info via trace inline',
  async t => {
    const execa = $({ cwd: dirname });
    await execa`endo purge -f`;
    await execa`endo start`;
    try {
      const error = await t.throwsAsync(
        execa`endo eval ${'throw new Error("eval-trace-inline")'}`,
      );
      // The original rejection still prints, then the trace section.
      t.regex(error.stderr, /eval-trace-inline/);
      // The trace section identifies the worker that emitted the error.
      t.regex(error.stderr, /Trace error:[^ ]+ \(worker [^)]+, site marshal\)/);
      t.regex(error.stderr, /\(end trace errorId=error:[^)]+\)/);
      // The worker id must not be the daemon stub: the rejection
      // originated in a worker, so the alias map should resolve to a
      // worker formula identifier.
      t.notRegex(error.stderr, /Trace error:[^ ]+ \(worker @daemon/);
      // The throw-site stack captured by the worker's
      // `Error.prepareStackTrace` hook surfaces the
      // `Compartment.evaluate` frames and the worker's own
      // `worker.js` frame — content SES's "concise" filter drops in
      // the default replay path.
      t.regex(error.stderr, /at Compartment\.evaluate/);
      t.regex(error.stderr, /packages\/daemon\/src\/worker\.js/);
      // The "emitted from" section locates the marshal/CapTP
      // emission frames so the operator sees the path the rejection
      // took out of the worker.
      t.regex(error.stderr, /-- emitted from --/);
      t.regex(error.stderr, /at encodeErrorCommon/);
      // The causal console replay used by the worker's pushTrace
      // surfaces the SES error tag and the "Sent as" annotation —
      // information that `err.stack` alone discards under the default
      // SES error taming.
      t.regex(error.stderr, /\(Error#\d+\)/);
      t.regex(error.stderr, /ERROR_NOTE: Sent as error:/);
    } finally {
      await execa`endo purge -f`;
    }
  },
);

test.serial(
  'endo eval trace section omits the CLI-side marshal decode stack',
  async t => {
    const execa = $({ cwd: dirname });
    await execa`endo purge -f`;
    await execa`endo start`;
    try {
      const error = await t.throwsAsync(
        execa`endo eval ${'throw new Error("eval-trace-clean")'}`,
      );
      // Grab just the trace block. Anything above it is the CLI's
      // CapTP onReject + console.error printout, which we expect to
      // contain the decode stack; anything below is bin/endo.cjs's
      // exit handler. We only care about the trace body itself.
      const traceMatch = error.stderr.match(
        /Trace error:[^\n]+\n([\s\S]*?)\(end trace errorId=[^)]+\)/,
      );
      t.truthy(
        traceMatch,
        `expected a trace block in stderr:\n${error.stderr}`,
      );
      const traceBody = traceMatch[1];

      // Sanity: the trace did surface worker-side context.
      t.regex(traceBody, /at Compartment\.evaluate/);
      t.regex(traceBody, /at encodeErrorCommon/);

      // None of the CLI-side decode frames may appear inside the
      // trace. Those tell the operator nothing about the worker
      // that actually emitted the error.
      const cliDecodeFrames = [
        /at decodeErrorCommon/,
        /at decodeErrorFromCapData/,
        /at decodeFromCapData/,
        /at fromCapData/,
        /at CTP_RETURN/,
        /packages\/daemon\/src\/connection\.js/,
      ];
      for (const pattern of cliDecodeFrames) {
        t.notRegex(
          traceBody,
          pattern,
          `trace body should not include ${pattern}, found:\n${traceBody}`,
        );
      }
    } finally {
      await execa`endo purge -f`;
    }
  },
);

test.serial(
  'endo trace <unknownId> exits non-zero with a friendly message',
  async t => {
    const execa = $({ cwd: dirname });
    await execa`endo purge -f`;
    await execa`endo start`;
    try {
      const error = await t.throwsAsync(
        execa`endo trace ${'error:does-not-exist#1'}`,
      );
      t.regex(error.stderr, /No trace recorded for/);
    } finally {
      await execa`endo purge -f`;
    }
  },
);

test.serial(
  'endo trace text-mode renders --stats, --recent, lookup, and usage hint',
  async t => {
    const execa = $({ cwd: dirname });
    await execa`endo purge -f`;
    await execa`endo start`;
    try {
      // No args: the command prints a usage hint to stderr and exits 1.
      const usageError = await t.throwsAsync(execa`endo trace`);
      t.regex(usageError.stderr, /Usage: endo trace/);

      // --stats text mode (no --json) prints labeled lines.
      const stats = await execa`endo trace --stats`;
      t.regex(stats.stdout, /workers:\s+\d+/);
      t.regex(stats.stdout, /totalRecords:\s+\d+/);
      t.regex(stats.stdout, /bytes:\s+\d+/);
      t.regex(stats.stdout, /aliases:\s+\d+/);

      // --recent text mode on an empty aggregate shows the placeholder.
      const emptyRecent = await execa`endo trace --recent`;
      t.regex(emptyRecent.stdout, /no recent error traces/);

      // Force an emission, then read --recent (text mode) and the
      // lookup-by-errorId text path.
      await t.throwsAsync(
        execa`endo eval ${'throw new Error("trace-text-boom")'}`,
      );

      const recentText = await execa`endo trace --recent --limit 5`;
      // Text mode prints `<errorId>` and a `worker: <id>` line.
      t.regex(recentText.stdout, /error:[^\s]+/);
      t.regex(recentText.stdout, /worker: /);
      t.regex(recentText.stdout, /site:\s+/);
      t.regex(recentText.stdout, /trace-text-boom/);

      // Pull an actual errorId out of the recent --json listing and
      // exercise the lookup happy-path text branch.
      const jsonRecent = await execa`endo trace --recent --limit 5 --json`;
      /** @type {Array<{ errorId: string, message: string }>} */
      const list = JSON.parse(jsonRecent.stdout);
      const target = list.find(r => /trace-text-boom/.test(r.message));
      t.truthy(target, `expected to find trace-text-boom emission`);
      const lookup = await execa`endo trace ${target.errorId}`;
      // Text mode wraps the body with `(end trace errorId=...)`.
      t.regex(lookup.stdout, /\(end trace errorId=/);
      t.regex(lookup.stdout, /trace-text-boom/);
    } finally {
      await execa`endo purge -f`;
    }
  },
);
