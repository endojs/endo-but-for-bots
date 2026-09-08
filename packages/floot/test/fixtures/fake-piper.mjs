#!/usr/bin/env node
// @ts-nocheck
// Stand-in for the piper binary used by tts-server-caplet tests. Mimics the
// wire shape the caplet depends on: one utterance per stdin line, "audio"
// streamed to stdout as each line lands, exit 0 on stdin EOF. Output per line
// is `[<line>]` — not real PCM, but the caplet only frames and base64s the
// bytes, so tests can reassemble and check ordering across chunk boundaries.
//
// The voice directory (from `--model`) doubles as the test's control channel,
// so concurrent tests never share state: each process start appends `spawn`
// to `<dir>/spawns.log` and a SIGTERM appends `sigterm`, and an optional
// `<dir>/fake-piper.json` selects a failure mode:
//   { "exitCode": 1 }  exit with that code as soon as the process starts
//   { "split": true }  write each line's audio in two odd-length pieces, a
//                      moment apart, so the caplet's sample-alignment carry
//                      is exercised
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const modelDir = dirname(process.argv[process.argv.indexOf('--model') + 1]);
const log = join(modelDir, 'spawns.log');
let mode = {};
try {
  mode = JSON.parse(readFileSync(join(modelDir, 'fake-piper.json'), 'utf-8'));
} catch {
  // No control file: behave like a healthy piper.
}
appendFileSync(log, 'spawn\n');
if (typeof mode.exitCode === 'number') process.exit(mode.exitCode);
process.on('SIGTERM', () => {
  appendFileSync(log, 'sigterm\n');
  process.exit(143);
});

// Writes are queued so a split write's second half lands before the next
// line's audio and before exit.
let pending = Promise.resolve();
const emit = audio => {
  pending = pending.then(
    () =>
      new Promise(resolve => {
        if (!mode.split) {
          process.stdout.write(audio, () => resolve());
          return;
        }
        process.stdout.write(audio.slice(0, 3));
        setTimeout(
          () => process.stdout.write(audio.slice(3), () => resolve()),
          25,
        );
      }),
  );
};

let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  buffered += data;
  let nl = buffered.indexOf('\n');
  while (nl !== -1) {
    const line = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    if (line) emit(`[${line}]`);
    nl = buffered.indexOf('\n');
  }
});
process.stdin.on('end', () => {
  pending.then(() => process.exit(0));
});
