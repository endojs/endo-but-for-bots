// @ts-check
// The exec program (M1b W1b.3; designs/m1b-interfaces.md 3.4, 6.1, 6.2,
// 8.1): bundled within execProgramBytes and free of the source forms SES
// refuses, then run from the bundle alone in a Node Compartment that has only
// the guest prelude (what a vat has), with fake Content, BlobWriters and
// Timer. Covers the persistent scope, the async-body wrapper, the
// endowments, the busy answer, result rendering, the R4-46 cut and staging,
// staged sources read in pages, the source size refusal and the argument
// texts. What only a vat can show (persistence across restarts, the halts)
// is the W1b.3 vat check (JOURNAL J-0330..J-0339).
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import path from 'node:path';

import { bundleGuest } from '../../scripts/bundle-guest.mjs';
import { guestPrelude } from '../../scripts/guest-prelude.js';
import { harnessRoot } from '../_helpers.js';
/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import {
  execArgumentNames,
  texts,
  textOf,
} from '../../guest/lib/interfaces.js';
import {
  boundToolOutput,
  previewText,
  utf8Bytes,
} from '../../guest/lib/bounded.js';
import { HUB_RETIRED_MESSAGE } from '../../guest/lib/retired.js';
import {
  describeParseFailure,
  renderToolResult,
  stripCodeFence,
} from '../../guest/exec/render.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { GuestBundle } from '../../scripts/bundle-guest.mjs' */
const { E, Far, M, makeExo, makePromiseKit } = /** @type {GuestGlobals} */ (
  globalThis
);

const entry = path.join(harnessRoot, 'guest', 'exec', 'main.js');

/** @type {Promise<{ bundle: GuestBundle, namespace: any }> | undefined} */
let loaded;
/** The bundle, evaluated once with the prelude alone. */
const load = () => {
  if (!loaded)
    loaded = (async () => {
      const bundle = await bundleGuest(entry);
      const namespace = new Compartment({
        globals: harden({ ...guestPrelude, TextEncoder }),
        __options__: true,
      }).evaluate(bundle.source);
      return { bundle, namespace };
    })();
  return loaded;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Fake adapter objects for one test: blobs, a Content that pages them by
 * UTF-8 byte offsets (whole code points), writers that record pieces, and a
 * Timer that records delays and settles when told.
 * @param {{ failOpen?: boolean, failAppend?: boolean, failRead?: Error }} [options]
 */
const makeAdapter = ({ failOpen, failAppend, failRead } = {}) => {
  /** @type {Map<any, string>} */
  const blobs = new Map();
  /** @type {{ offset: number, maxBytes: number }[]} */
  const reads = [];
  /** @type {string[][]} */
  const written = [];
  /** @type {number[]} */
  const sleeps = [];
  /** @type {(() => void)[]} */
  const sleepers = [];
  let aborted = 0;
  let manualSleep = false;

  /**
   * @param {string} text
   * @param {number} [previewUnits]
   */
  const stage = (text, previewUnits = 256) => {
    const blob = Far('Blob', {});
    blobs.set(blob, text);
    return harden({
      blob,
      preview: previewText(text, previewUnits),
      bytes: utf8Bytes(text),
    });
  };
  const content = Far('Content', {
    /**
     * @param {any} blob
     * @param {{ offset: number, maxBytes: number }} range
     */
    read: (blob, { offset, maxBytes }) => {
      reads.push({ offset, maxBytes });
      if (failRead) throw failRead;
      const text = blobs.get(blob);
      if (text === undefined) throw Error(texts.blobUnknown);
      const bytes = encoder.encode(text);
      let end = Math.min(bytes.length, offset + maxBytes);
      // eslint-disable-next-line no-bitwise
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
      return harden({
        text: decoder.decode(bytes.subarray(offset, end)),
        next: end,
        done: end === bytes.length,
      });
    },
  });
  const writers = Far('BlobWriters', {
    open: () => {
      if (failOpen) throw Error('no writers');
      /** @type {string[]} */
      const pieces = [];
      written.push(pieces);
      let closed = false;
      return Far('BlobWriter', {
        /** @param {string} piece */
        append: piece => {
          if (closed) throw Error(texts.writerClosed);
          if (failAppend) throw Error(HUB_RETIRED_MESSAGE);
          pieces.push(piece);
        },
        close: () => {
          closed = true;
          return stage(pieces.join(''));
        },
        abort: () => {
          closed = true;
          aborted += 1;
        },
      });
    },
  });
  const timer = Far('Timer', {
    /** @param {number} ms */
    sleep: ms => {
      sleeps.push(ms);
      if (!manualSleep) return undefined;
      const { promise, resolve } = makePromiseKit();
      sleepers.push(() => resolve(undefined));
      return promise;
    },
  });
  return {
    blobs,
    reads,
    written,
    sleeps,
    stage,
    content,
    writers,
    timer,
    aborted: () => aborted,
    holdSleeps: () => {
      manualSleep = true;
    },
    wake: () => {
      for (const wake of sleepers.splice(0)) wake();
    },
  };
};

/** @param {string} code */
const argsOf = code => JSON.stringify({ code });

/**
 * A fresh scope from the bundle and an adapter.
 * @param {Parameters<typeof makeAdapter>[0]} [options]
 */
const fresh = async options => {
  const { namespace } = await load();
  const scope = namespace.makeExecScope();
  const adapter = makeAdapter(options);
  /**
   * @param {string | object} args
   * @param {{ notice?: string, withContent?: boolean }} [extra]
   */
  const run = (args, { notice, withContent = true } = {}) =>
    E(scope).run(
      harden({
        args,
        writers: adapter.writers,
        timer: adapter.timer,
        ...(withContent ? { content: adapter.content } : {}),
        ...(notice === undefined ? {} : { notice }),
      }),
    );
  /** @param {string} code */
  const exec = code => run(argsOf(code));
  return { scope, adapter, run, exec, namespace };
};

/** A lone surrogate anywhere. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('the exec program bundles within execProgramBytes, ASCII, with no source form SES refuses', async t => {
  const { bundle, namespace } = await load();
  t.log(
    JSON.stringify({
      metric: 'exec.program',
      bytes: bundle.bytes,
      budget: limits.execProgramBytes,
      modules: bundle.modules,
    }),
  );
  t.true(bundle.bytes <= limits.execProgramBytes);
  t.true([...bundle.source].every(c => c.charCodeAt(0) < 128));
  t.notRegex(bundle.source, /\bimport\s*(?:\(|\/[/*])/);
  t.notRegex(bundle.source, /<!--|-->/);
  t.is(typeof namespace.makeExecScope, 'function');
});

test('globalThis bindings persist across calls; top-level const and let are per call', async t => {
  const { exec } = await fresh();
  t.deepEqual(await exec('globalThis.x = 5; return "set";'), {
    status: 'ok',
    text: '"set"',
  });
  t.deepEqual(await exec('return x;'), { status: 'ok', text: '5' });
  t.deepEqual(await exec('const a = 1; let b = 2; return a + b;'), {
    status: 'ok',
    text: '3',
  });
  t.deepEqual(await exec('const a = 10; return a;'), {
    status: 'ok',
    text: '10',
  });
  t.deepEqual(await exec('return typeof a;'), {
    status: 'ok',
    text: '"undefined"',
  });
  t.deepEqual(await exec('x += 1; return await Promise.resolve(x);'), {
    status: 'ok',
    text: '6',
  });
  // A second scope (another vat) does not see the first one's bindings.
  const other = await fresh();
  t.deepEqual(await other.exec('return typeof x;'), {
    status: 'ok',
    text: '"undefined"',
  });
});

test('the scope is confined: no prelude, host or program names; endowments as specified', async t => {
  const { exec, adapter } = await fresh();
  const names = [
    'makeExo',
    'M',
    'Far',
    'makeExecScope',
    'setTimeout',
    'process',
    'require',
    'fetch',
  ];
  const outcome = await exec(
    `return [${names.map(n => `typeof ${n}`).join(', ')}];`,
  );
  t.deepEqual(
    JSON.parse(outcome.text),
    names.map(() => 'undefined'),
  );
  t.deepEqual(
    await exec(
      'return [typeof powers, Object.keys(powers).length, Object.isFrozen(powers), typeof E, typeof harden, typeof sleep, typeof BigInt];',
    ),
    {
      status: 'ok',
      text: JSON.stringify(
        ['object', 0, true, 'function', 'function', 'function', 'function'],
        null,
        2,
      ),
    },
  );
  // console accepts anything and discards it (decision 16.3).
  t.deepEqual(
    await exec(
      'console.log("a", { b: 1 }); console.info(); console.warn(1n); console.error(new Error("e")); console.debug(powers); return "logged";',
    ),
    { status: 'ok', text: '"logged"' },
  );
  // sleep goes to the call's Timer, clamped to 0..maxDelayMs.
  t.deepEqual(
    await exec(
      'await sleep(250); await sleep(-5); await sleep(1e12); await sleep("soon"); await sleep(); await sleep(1n); return "slept";',
    ),
    { status: 'ok', text: '"slept"' },
  );
  t.deepEqual(adapter.sleeps, [250, 0, limits.maxDelayMs, 0, 0, 1]);
});

test('results render as Fae renders them; undefined is the no-return text', async t => {
  const { exec } = await fresh();
  t.deepEqual(await exec('return 1;'), { status: 'ok', text: '1' });
  t.deepEqual(await exec('return { n: 12345678901234567890n, s: "x" };'), {
    status: 'ok',
    text: '{\n  "n": "12345678901234567890",\n  "s": "x"\n}',
  });
  t.deepEqual(await exec('1 + 1;'), {
    status: 'ok',
    text: texts.execNoReturn,
  });
  t.deepEqual(await exec('return null;'), { status: 'ok', text: 'null' });
  t.deepEqual(await exec('return () => 1;'), {
    status: 'ok',
    text: '() => 1',
  });
  // A markdown fence around the code is stripped (one wrapping fence).
  t.deepEqual(await exec('```js\nreturn 2;\n```'), { status: 'ok', text: '2' });
});

test('a remote capability renders as its method names', async t => {
  const thing = makeExo(
    'Thing',
    M.interface('Thing', {
      alpha: M.call().returns(),
      beta: M.call().returns(),
    }),
    { alpha() {}, beta() {} },
  );
  const text = await renderToolResult(thing);
  t.true(text.startsWith('[remote capability] callable methods: '), text);
  t.true(text.includes('"alpha"') && text.includes('"beta"'), text);
  t.is(await renderToolResult(harden({})), '{}');
  t.is(stripCodeFence('```\nreturn 1\n```'), 'return 1');
  t.is(stripCodeFence('say ```return 1```'), 'say ```return 1```');
});

test('thrown errors and parse failures fail the call with their texts', async t => {
  const { exec } = await fresh();
  t.deepEqual(await exec('throw new Error("boom");'), {
    status: 'failed',
    text: 'boom',
  });
  t.deepEqual(await exec('throw "plain";'), {
    status: 'failed',
    text: 'plain',
  });
  t.deepEqual(await exec('await Promise.reject(new TypeError("later"));'), {
    status: 'failed',
    text: 'later',
  });
  const parse = await exec('return );');
  t.is(parse.status, 'failed');
  t.true(parse.text.startsWith('Could not parse the code ('), parse.text);
  t.true(
    parse.text.endsWith('Check the code for syntax errors and send it again.'),
  );
  const template = await exec('const s = `a ` b`; return s;');
  t.true(template.text.includes('The code uses template literals.'));
  const fenced = await exec('Here is the code: ```js\nreturn 1;\n```');
  t.true(fenced.text.includes('without markdown fences'));
  const importing = await exec(['return imp', 'ort("x");'].join(''));
  t.is(importing.status, 'failed');
  t.true(
    importing.text.includes(['refuses the characters "imp', 'ort("'].join('')),
    importing.text,
  );
  t.is(
    describeParseFailure('x', 'SES_HTML_COMMENT_REJECTED'),
    [
      'Could not parse the code (SES_HTML_COMMENT_REJECTED). The source contains an HTML comment marker (<!',
      '-- or --',
      '>), which this evaluator refuses even inside a string. Write it as "<!" + "--" and "--" + ">".',
    ].join(''),
  );
  // The scope still works after every failure.
  t.deepEqual(await exec('return "fine";'), { status: 'ok', text: '"fine"' });
});

test('argument texts: not JSON, not an object, unexpected key, missing or empty code', async t => {
  const { run, namespace } = await fresh();
  const notJson = await run('{"code": ');
  t.is(notJson.status, 'failed');
  t.true(
    notJson.text.startsWith('could not parse tool arguments as JSON ('),
    notJson.text,
  );
  t.deepEqual(await run('[1]'), {
    status: 'failed',
    text: namespace.NOT_AN_OBJECT_TEXT,
  });
  t.deepEqual(await run('{"code":"return 1","x":1}'), {
    status: 'failed',
    text: textOf.unexpectedArgument('x', 'exec', execArgumentNames),
  });
  for (const args of ['{}', '{"code":""}', '{"code":5}', '{"code":null}']) {
    // eslint-disable-next-line no-await-in-loop
    t.deepEqual(await run(args), {
      status: 'failed',
      text: texts.execCodeRequired,
    });
  }
});

test('a second run while one is unsettled answers busy and evaluates nothing', async t => {
  const { exec, adapter } = await fresh();
  adapter.holdSleeps();
  const first = exec('await sleep(30000); return "first";');
  // Let the first call reach its sleep.
  await new Promise(resolve => setImmediate(resolve));
  t.deepEqual(adapter.sleeps, [30_000]);
  t.deepEqual(await exec('globalThis.touched = true; return 1;'), {
    status: 'busy',
  });
  adapter.wake();
  t.deepEqual(await first, { status: 'ok', text: '"first"' });
  t.deepEqual(await exec('return typeof touched;'), {
    status: 'ok',
    text: '"undefined"',
  });
});

test('a notice is put first in the result', async t => {
  const { run } = await fresh();
  t.deepEqual(await run(argsOf('return 1;'), { notice: texts.execBusyReset }), {
    status: 'ok',
    text: `${texts.execBusyReset}\n\n1`,
  });
  t.deepEqual(
    await run(argsOf('throw Error("no");'), { notice: texts.execBusyReset }),
    { status: 'failed', text: `${texts.execBusyReset}\n\nno` },
  );
});

test('results up to inlineBytes are inline; larger ones are staged in pieces of at most blobPieceBytes', async t => {
  const { exec, adapter } = await fresh();
  // JSON quotes make the text 2 units longer than the string.
  const atLimit = await exec(`return "z".repeat(${limits.inlineBytes - 2});`);
  t.is(atLimit.status, 'ok');
  t.is(atLimit.text.length, limits.inlineBytes);
  t.is(adapter.written.length, 0);

  const over = await exec(`return "z".repeat(${limits.inlineBytes - 1});`);
  t.is(over.status, 'ok');
  t.is(typeof over.text, 'object');
  t.is(over.text.bytes, limits.inlineBytes + 1);
  t.is(adapter.written.length, 1);
  t.is(
    adapter.blobs.get(over.text.blob),
    `"${'z'.repeat(limits.inlineBytes - 1)}"`,
  );
  t.is(over.text.preview.length, limits.toolPreviewUnits);

  // A 3-byte character: 2,731 units are 8,193 bytes, staged.
  const wide = await exec('return "\\u20ac".repeat(2731);');
  t.is(typeof wide.text, 'object');
  t.is(wide.text.bytes, 2731 * 3 + 2);
});

test('acceptance 2: 100,000 characters are cut to 32,768 units with the R4-46 marker, staged, no split pair', async t => {
  const { exec, adapter } = await fresh();
  const outcome = await exec('return "x".repeat(100000);');
  t.is(outcome.status, 'ok');
  const full = JSON.stringify('x'.repeat(100_000));
  const expected = boundToolOutput(full);
  const text = adapter.blobs.get(outcome.text.blob);
  t.is(text, expected);
  t.is(text?.length, limits.toolOutputUnits);
  t.true(text?.endsWith(textOf.truncationMarker(full.length)));
  t.is(outcome.text.bytes, utf8Bytes(expected));
  const pieces = adapter.written[0];
  t.is(pieces.length, Math.ceil(utf8Bytes(expected) / limits.blobPieceBytes));
  for (const piece of pieces) t.true(utf8Bytes(piece) <= limits.blobPieceBytes);

  // Astral characters: the cut and the pieces never split a pair.
  const astral = await exec('return "a" + "\\u{1F600}".repeat(50000);');
  const astralText = adapter.blobs.get(astral.text.blob) ?? '';
  t.true(astralText.length <= limits.toolOutputUnits);
  t.true(astralText.endsWith(textOf.truncationMarker(100_003)));
  t.notRegex(astralText, LONE_SURROGATE);
  for (const piece of adapter.written[1]) {
    t.true(utf8Bytes(piece) <= limits.blobPieceBytes);
    t.notRegex(piece, LONE_SURROGATE);
  }
});

test('a large error is staged as the complete model-facing result', async t => {
  const { exec } = await fresh();
  const outcome = await exec('throw new Error("e".repeat(40000));');
  t.is(outcome.status, 'failed');
  t.is(typeof outcome.text, 'object');
  // The staged text is `Error: <message>` cut by boundToolOutput.
  t.is(
    outcome.text.preview,
    previewText(textOf.errorResult('e'.repeat(40_000)), 256),
  );
  t.is(
    outcome.text.bytes,
    utf8Bytes(boundToolOutput(textOf.errorResult('e'.repeat(40_000)))),
  );
});

test('a staging failure fails the call with stagingFailed and aborts the writer', async t => {
  const noWriters = await fresh({ failOpen: true });
  t.deepEqual(await noWriters.exec('return "w".repeat(9000);'), {
    status: 'failed',
    text: textOf.stagingFailed('no writers'),
  });
  const broken = await fresh({ failAppend: true });
  t.deepEqual(await broken.exec('return "w".repeat(9000);'), {
    status: 'failed',
    text: textOf.stagingFailed(HUB_RETIRED_MESSAGE),
  });
  t.is(broken.adapter.aborted(), 1);
  // Not busy afterwards.
  t.deepEqual(await broken.exec('return 1;'), { status: 'ok', text: '1' });
});

test('a staged source is read in pages of at most blobPageBytes, joined and evaluated', async t => {
  const { run, adapter } = await fresh();
  // About 60 KB of 2-byte characters in a comment, then the code.
  const code = `// ${'\u00e9'.repeat(30_000)}\nglobalThis.big = 1;\nreturn 6 * 7;`;
  const args = adapter.stage(argsOf(code));
  t.true(args.bytes > 2 * limits.blobPageBytes);
  t.deepEqual(await run(args), { status: 'ok', text: '42' });
  t.true(adapter.reads.length >= Math.ceil(args.bytes / limits.blobPageBytes));
  t.true(
    adapter.reads.length <= Math.ceil(args.bytes / (limits.blobPageBytes - 3)),
  );
  t.is(adapter.reads[0].offset, 0);
  for (const read of adapter.reads) t.is(read.maxBytes, limits.blobPageBytes);
  t.deepEqual(await run(argsOf('return big;')), { status: 'ok', text: '1' });
});

test('a staged source over execSourceBytes is refused without reading it', async t => {
  const { run, adapter } = await fresh();
  const blob = Far('Blob', {});
  const tooLarge = harden({
    blob,
    preview: '{"code":"',
    bytes: limits.execSourceBytes + 1,
  });
  t.deepEqual(await run(tooLarge), {
    status: 'failed',
    text: textOf.execSourceTooLarge(
      limits.execSourceBytes + 1,
      limits.execSourceBytes,
    ),
  });
  t.is(adapter.reads.length, 0);

  // A blob longer than its StagedText says: refused once the pages pass the bound.
  const long = adapter.stage(argsOf(`return ${'1 + '.repeat(70_000)}1;`));
  const understated = harden({ ...long, bytes: 1000 });
  const outcome = await run(understated);
  t.is(outcome.status, 'failed');
  t.true(outcome.text.startsWith('exec source too large ('), outcome.text);
  t.true(
    adapter.reads.length <=
      Math.ceil(limits.execSourceBytes / (limits.blobPageBytes - 3)) + 1,
  );
});

test('a staged source without Content, or whose read fails, fails the call and frees the scope', async t => {
  const { run, adapter } = await fresh();
  const args = adapter.stage(argsOf(`return "${'s'.repeat(9000)}".length;`));
  const { namespace } = await load();
  t.deepEqual(await run(args, { withContent: false }), {
    status: 'failed',
    text: namespace.NO_CONTENT_TEXT,
  });
  t.deepEqual(await run(args), { status: 'ok', text: '9000' });

  const restarted = await fresh({ failRead: Error(HUB_RETIRED_MESSAGE) });
  const blobArgs = harden({
    blob: Far('Blob', {}),
    preview: '',
    bytes: 9000,
  });
  t.deepEqual(await restarted.run(blobArgs), {
    status: 'failed',
    text: HUB_RETIRED_MESSAGE,
  });
  t.deepEqual(await restarted.exec('return 1;'), { status: 'ok', text: '1' });
});

test('the ExecScope guard refuses requests outside the contract', async t => {
  const { scope, adapter } = await fresh();
  const base = { writers: adapter.writers, timer: adapter.timer };
  await t.throwsAsync(() =>
    E(scope).run(harden({ ...base, args: argsOf('return 1;'), extra: 1 })),
  );
  await t.throwsAsync(() =>
    E(scope).run(harden({ ...base, args: 'x'.repeat(limits.inlineBytes + 1) })),
  );
  await t.throwsAsync(() =>
    E(scope).run(harden({ args: argsOf('return 1;'), timer: adapter.timer })),
  );
  // Still usable.
  t.deepEqual(
    await E(scope).run(harden({ ...base, args: argsOf('return 1;') })),
    { status: 'ok', text: '1' },
  );
});

/** Let queued promise jobs run (the fakes answer in later turns). */
const settleJobs = async () => {
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
};

test('M1b QC (J-0391): model code cannot outlive its call; a kept sleep is dead', async t => {
  const { exec, adapter } = await fresh();
  adapter.holdSleeps();
  // The reviewer's background loop: returns at once, then sleeps forever.
  const answer = await exec(
    [
      'globalThis.ticks = 0; globalThis.kept = sleep;',
      '(async () => { for (;;) { for (let i = 0; i < 3; i += 1) sleep(600000);',
      '  await sleep(0); globalThis.ticks += 1; } })();',
      'return 1;',
    ].join('\n'),
  );
  t.deepEqual(answer, { status: 'ok', text: '1' });
  const asked = adapter.sleeps.length;
  t.is(asked, 4, 'only what the call asked for while it ran');
  // The timer answers every sleep: the loop takes at most one more step,
  // then its next sleeps are dead and it stops.
  adapter.wake();
  await settleJobs();
  adapter.wake();
  await settleJobs();
  t.deepEqual(await exec('return ticks;'), { status: 'ok', text: '1' });
  t.is(adapter.sleeps.length, asked, 'no sleep was sent after the call ended');
  // A sleep kept on globalThis never settles in a later call and sends
  // nothing; the call's own sleep still reaches the timer.
  t.deepEqual(
    await exec(
      'globalThis.kept(0).then(() => { globalThis.ticks = -1; }); sleep(5); return 2;',
    ),
    { status: 'ok', text: '2' },
  );
  t.deepEqual(adapter.sleeps.slice(asked), [5], 'only the live sleep was sent');
  adapter.wake();
  await settleJobs();
  t.deepEqual(await exec('return ticks;'), { status: 'ok', text: '1' });
});

test('M1b QC (J-0391): abandon ends the running call; the scope and its bindings stay', async t => {
  const { exec, adapter, scope } = await fresh();
  adapter.holdSleeps();
  t.deepEqual(await exec('globalThis.x = 5; return "set";'), {
    status: 'ok',
    text: '"set"',
  });
  // A long sleep, as acceptance 3's cancelled call, and a loop after it.
  const pending = exec(
    'await sleep(30000); globalThis.after = 1; await sleep(1); globalThis.after = 2; return "late";',
  );
  await settleJobs();
  t.deepEqual(
    await exec('return x;'),
    { status: 'busy' },
    'busy while it runs',
  );
  await E(scope).abandon();
  t.deepEqual(await pending, { status: 'failed', text: texts.execAbandoned });
  // The next call runs in the same scope at once (no busy, no reset).
  t.deepEqual(await exec('return x;'), { status: 'ok', text: '5' });
  // The abandoned call's sleep in flight still answers: its code runs to its
  // next sleep, which is dead ("its effects may still happen").
  const sent = adapter.sleeps.length;
  adapter.wake();
  await settleJobs();
  adapter.wake();
  await settleJobs();
  t.deepEqual(await exec('return after;'), { status: 'ok', text: '1' });
  t.is(adapter.sleeps.length, sent, 'the abandoned code sent nothing more');
  // Abandon with nothing running does nothing.
  await E(scope).abandon();
  t.deepEqual(await exec('return x + 1;'), { status: 'ok', text: '6' });
});

test('M1b QC (J-0391): a staged source abandoned while it is read is never evaluated', async t => {
  const { scope, adapter, exec } = await fresh();
  const staged = adapter.stage(argsOf('globalThis.y = 7; return 1;'));
  /** @type {(() => void)[]} */
  const gates = [];
  // A Content whose pages arrive only when the test lets them.
  const slowContent = Far('Content', {
    /**
     * @param {any} blob
     * @param {any} range
     */
    read: (blob, range) => {
      const kit = makePromiseKit();
      gates.push(() => kit.resolve(E(adapter.content).read(blob, range)));
      return kit.promise;
    },
  });
  const pending = E(scope).run(
    harden({
      args: staged,
      writers: adapter.writers,
      timer: adapter.timer,
      content: slowContent,
    }),
  );
  await settleJobs();
  t.is(gates.length, 1, 'the first page was asked for');
  await E(scope).abandon();
  t.deepEqual(await pending, { status: 'failed', text: texts.execAbandoned });
  for (const open of gates.splice(0)) open();
  await settleJobs();
  t.deepEqual(await exec('return typeof y;'), {
    status: 'ok',
    text: '"undefined"',
  });
});

test('M1b QC (J-0390): an exhausted name table answers exhausted, from arguments, parse or body', async t => {
  const { namespace } = await load();
  t.true(namespace.isKeysExhausted(RangeError('property key space exhausted')));
  t.false(namespace.isKeysExhausted(RangeError('Invalid array length')));
  const { exec } = await fresh();
  // The engine's error is simulated: Node has no 64 Ki name table.
  t.deepEqual(await exec('throw RangeError("property key space exhausted");'), {
    status: 'exhausted',
  });
  t.deepEqual(
    await exec(
      'try { throw RangeError("property key space exhausted"); } catch (e) { return "swallowed"; }',
    ),
    { status: 'ok', text: '"swallowed"' },
    'model code that swallows it is not seen (residual, J-0390)',
  );
  // Not busy afterwards.
  t.deepEqual(await exec('return 2;'), { status: 'ok', text: '2' });
});

// ---- M1b follow-ups (JOURNAL J-9367, J-9368)

test('M1b follow-ups (J-9367): model code does not see Compartment, lockdown, repairIntrinsics or HandledPromise', async t => {
  const { exec, namespace } = await fresh();
  t.deepEqual(
    [...namespace.HIDDEN_GLOBALS],
    ['Compartment', 'lockdown', 'repairIntrinsics', 'HandledPromise'],
  );
  const seen = await exec(
    'return ["Compartment", "lockdown", "repairIntrinsics", "HandledPromise"].map(n => typeof globalThis[n] + " " + (n in globalThis && globalThis[n] !== undefined));',
  );
  t.deepEqual(JSON.parse(/** @type {string} */ (seen.text)), [
    'undefined false',
    'undefined false',
    'undefined false',
    'undefined false',
  ]);
  // A fresh name list, for the record (the vat's list is the integration
  // file's; Node's compartment has more).
  const names = await exec(
    'return Object.getOwnPropertyNames(globalThis).filter(n => globalThis[n] !== undefined).sort();',
  );
  t.log(names.text);
  // The endowments are still there.
  t.deepEqual(
    await exec(
      'return [typeof powers, typeof E, typeof harden, typeof console, typeof sleep].join(" ");',
    ),
    { status: 'ok', text: '"object function function object function"' },
  );
});

test('M1b follow-ups (J-9367): host file paths in error text and stacks reach the model as file names only', async t => {
  const { exec, namespace } = await fresh();
  t.is(typeof namespace.makeExecScope, 'function');
  const thrown = await exec(
    "throw Error('cannot open /Users/someone/dev/endo/packages/ses/src/x.js:12:3 or file:///home/u/app/b.cjs:1:2');",
  );
  t.deepEqual(thrown, {
    status: 'failed',
    text: 'cannot open <host>/x.js:12:3 or <host>/b.cjs:1:2',
  });
  const returned = await exec(
    "return 'at f (/private/var/folders/q/T/bundle.cjs:4:5) GET /api/v1/items';",
  );
  t.deepEqual(returned, {
    status: 'ok',
    text: '"at f (<host>/bundle.cjs:4:5) GET /api/v1/items"',
  });
  // A real stack: whatever this engine puts in it, no host root survives.
  const stack = await exec("return new Error('x').stack;");
  t.notRegex(
    /** @type {string} */ (stack.text),
    /\/(?:Users|home|private|tmp|var|nix)\//,
  );
});

test('M1b follow-ups (J-9368): the one step an abandoned call takes after its sleep answers cannot send', async t => {
  const { exec, adapter, scope } = await fresh();
  adapter.holdSleeps();
  // The call sleeps, then (once abandoned and its sleep answered) takes its
  // one more step: a scope write and an eventual send to a target it holds.
  const pending = exec(
    [
      'globalThis.hits = [];',
      "const target = harden({ hit: () => { globalThis.hits.push('sent'); } });",
      'await sleep(30000);',
      "globalThis.hits.push('stepped');",
      'E(target).hit();',
      'E.sendOnly(target).hit();',
      "return 'late';",
    ].join('\n'),
  );
  await settleJobs();
  await E(scope).abandon();
  t.deepEqual(await pending, { status: 'failed', text: texts.execAbandoned });
  adapter.wake();
  await settleJobs();
  await settleJobs();
  t.deepEqual(await exec('return hits;'), {
    status: 'ok',
    text: JSON.stringify(['stepped'], null, 2),
  });
  // A call's E kept on globalThis is dead in a later call; the later call's
  // own E sends.
  t.deepEqual(
    await exec(
      [
        'globalThis.keptE = E;',
        "globalThis.box = harden({ hit: () => { globalThis.hits.push('kept'); } });",
        'return 1;',
      ].join('\n'),
    ),
    { status: 'ok', text: '1' },
  );
  t.deepEqual(
    await exec(
      [
        'keptE(box).hit();',
        "E(harden({ hit: () => { globalThis.hits.push('live'); } })).hit();",
        'await null; await null; await null;',
        'return hits;',
      ].join('\n'),
    ),
    { status: 'ok', text: JSON.stringify(['stepped', 'live'], null, 2) },
  );
});

test('M1b follow-ups (J-9368): 100 answered sleeps from one body (Node timing, per-call E fence)', async t => {
  const { exec } = await fresh();
  const code = [
    'const all = [];',
    'for (let i = 0; i < 100; i += 1) all.push(sleep(0));',
    'await Promise.all(all);',
    'return all.length;',
  ].join('\n');
  /** @type {number[]} */
  const ms = [];
  for (let i = 0; i < 20; i += 1) {
    const t0 = performance.now();
    // eslint-disable-next-line no-await-in-loop
    const out = await exec(code);
    ms.push(performance.now() - t0);
    t.deepEqual(out, { status: 'ok', text: '100' });
  }
  ms.sort((a, b) => a - b);
  t.log(
    JSON.stringify({
      metric: 'exec.sends.answered.node',
      unit: 'ms',
      n: ms.length,
      median: Math.round(ms[10] * 100) / 100,
      p95: Math.round(ms[18] * 100) / 100,
    }),
  );
});
