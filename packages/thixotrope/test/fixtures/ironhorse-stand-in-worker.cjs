#!/usr/bin/env node
// A stand-in for thixotrope-ironhorse-worker that speaks its two protocols
// and ends however a test tells it to, so the engine's reading of a worker's
// death can be tested without the real binary.
//
// As the lease helper (`--lock-state dir`) it reports the lock on its error
// stream, answers `prepare`, and lives until its input ends. As a worker it
// answers `ready`, then one reply per request; the text a frame carries names
// what to do instead.
//
// The engine runs a private copy of this file under another name, so it is
// CommonJS, which needs no extension to be recognised, and imports nothing
// by relative path.
const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const [first, second, lease] = process.argv.slice(2);
const textDecoder = new TextDecoder();

const dieBySignal = () => process.kill(process.pid, 'SIGKILL');

if (first === '--lock-state') {
  process.stderr.write('{"op":"locked"}\n');
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', () => {
    mkdirSync(join(second, 'heaps', 'incarnations'), { recursive: true });
    process.stderr.write('{"op":"ready"}\n');
  });
  process.stdin.on('end', () => process.exit(0));
} else {
  // A test leaves a file beside the lease to say how the next boot ends.
  /** @param {string} name */
  const marker = name => existsSync(join(dirname(lease), name));
  if (marker('boot-exits-with-status')) {
    process.stderr.write('worker failed: cannot open heap\n');
    process.exit(1);
  }
  if (marker('boot-dies-by-signal')) dieBySignal();
  // The engine copies the heap to make a snapshot of it.
  if (!existsSync(first)) writeFileSync(first, 'stand-in heap');

  /** @param {object} message */
  const reply = message => process.stdout.write(`${JSON.stringify(message)}\n`);
  reply({ op: 'ready', features: ['deliver-v1'] });

  let dieOnNextInput = false;
  let buffered = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (dieOnNextInput) dieBySignal();
    buffered += chunk;
    for (;;) {
      const end = buffered.indexOf('\n');
      if (end === -1) return;
      const request = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      if (request.op === 'close') process.exit(0);
      // The engine sends thixotropeDispatch("<the message, as JSON>");
      const message = JSON.parse(JSON.parse(request.source.slice(19, -2)));
      const text =
        message.t === 'f'
          ? textDecoder.decode(
              Uint8Array.from(atob(message.b64), char => char.charCodeAt(0)),
            )
          : '';
      const command = text.split(' ')[0];
      if (command === 'die-by-signal') dieBySignal();
      if (command === 'exit-with-status') process.exit(1);
      if (command === 'halt') {
        // As the worker does for a crank that did not complete: say so,
        // then leave without committing it.
        process.stdout.write(
          `${JSON.stringify({ op: 'fatal', message: 'guest crank halted' })}\n`,
          () => process.exit(1),
        );
        return;
      }
      if (command === 'hang') return;
      if (command === 'die-mid-reply') {
        process.stdout.write('{"op":"result","resu', dieBySignal);
        return;
      }
      if (command === 'die-idle') setTimeout(dieBySignal, 0);
      if (command === 'die-on-next-input') dieOnNextInput = true;
      reply({ op: 'result', result: '[]' });
    }
  });
}
