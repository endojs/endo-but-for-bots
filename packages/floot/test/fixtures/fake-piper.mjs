#!/usr/bin/env node
// @ts-nocheck
// Stand-in for the piper binary used by tts-server-caplet tests. Mimics the
// wire shape the caplet depends on: one utterance per stdin line, "audio"
// streamed to stdout as each line lands, exit 0 on stdin EOF. Each process
// start appends a line to $FAKE_PIPER_LOG so tests can assert how many times
// the caplet spawned it. Output per line is `[<line>]` — not real PCM, but the
// caplet only frames and base64s the bytes, so tests can reassemble and check
// ordering across chunk boundaries.
import { appendFileSync } from 'node:fs';

if (process.env.FAKE_PIPER_LOG) {
  appendFileSync(process.env.FAKE_PIPER_LOG, 'spawn\n');
}

let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  buffered += data;
  let nl = buffered.indexOf('\n');
  while (nl !== -1) {
    const line = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    if (line) process.stdout.write(`[${line}]`);
    nl = buffered.indexOf('\n');
  }
});
process.stdin.on('end', () => {
  process.exit(0);
});
