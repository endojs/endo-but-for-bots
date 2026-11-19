// @ts-check
// The `viewImage` adapter tool (resources/agent-host/impl/tools/view-image.js;
// designs/m8-interfaces.md 6.2, 6.3, 8 (I1-I3), 9 and 14): formats, the
// size bounds, empty and short pages, the deadline, the descent through
// `openImage(path)` and `lookup(path)`, lost sources, the path checks, the
// staged envelope and its receipt, the quota, and the disk at the image
// kill points. Sources are built with the `ImageSource` guard (review rule
// 4); a source without `size()` or a hostile one cannot be built from the
// guard (it lists `size` and checks its own answers), so those are `Far`.
// Node, real files in a temporary directory.
import '../unit/_m1a-prelude.js';

import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { imageLimits } from '../../guest/lib/guards/images.js';
import {
  IMAGE_ENVELOPE_PREFIX,
  imageTextOf,
  imageTexts,
} from '../../guest/lib/image-guards.js';
import {
  environmentInterfaces,
  gitReaderMethodNames,
} from '../../guest/lib/guards/environments.js';
import { HUB_RETIRED_MESSAGE } from '../../guest/lib/retired.js';
/* eslint-enable import/no-relative-packages */
import {
  imageGuards,
  imageTypeOf,
  makeImageTool,
} from '../../resources/agent-host/impl/tools/view-image.js';
import { makeBlobStore } from '../../resources/agent-host/impl/blobs.js';
import { makeTimers } from '../../resources/agent-host/impl/timers.js';
import {
  filesIn,
  makeFakeBlobSink,
  makeTestBlobs,
  partsIn,
} from './_m1b-blobs.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makeExo, matches } = /** @type {GuestGlobals} */ (globalThis);

const MiB = 1024 * 1024;
const MAX = imageLimits.maxImageBytes;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Bytes of `size` that start with `magic`, the rest a fixed pattern.
 * @param {number} size
 * @param {number[]} [magic]
 */
const imageBytes = (size, magic = PNG_MAGIC) => {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + 7) % 256;
  bytes.set(magic.slice(0, size), 0);
  return bytes;
};
const JPEG = () => imageBytes(4096, [0xff, 0xd8, 0xff, 0xe0]);
const WEBP = () => {
  const bytes = imageBytes(4096, [0x52, 0x49, 0x46, 0x46]);
  bytes.set([0x00, 0x10, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50], 4);
  return bytes;
};

/**
 * The page a byte source answers: at most `pageBytes` (or `maxBytes`) of
 * `bytes` from `offset`.
 * @param {Buffer} bytes
 * @param {{ offset: number, maxBytes: number }} range
 * @param {number} pageBytes
 */
const pageOf = (bytes, { offset, maxBytes }, pageBytes) => {
  const end = Math.min(bytes.length, offset + Math.min(maxBytes, pageBytes));
  return harden({
    data: bytes.subarray(offset, end).toString('base64'),
    done: end >= bytes.length,
  });
};

/**
 * An `ImageSource` over `bytes`, built with the guard; it counts its calls
 * and the bytes it served.
 * @param {Buffer} bytes
 * @param {{ pageBytes?: number, size?: number }} [options]
 */
const makeSource = (
  bytes,
  { pageBytes = imageLimits.readPageBytes, size = bytes.length } = {},
) => {
  const counts = { reads: 0, sizes: 0, served: 0 };
  const source = makeExo('ImageSource', imageGuards.ImageSource, {
    /** @param {{ offset: number, maxBytes: number }} range */
    readBase64: async range => {
      counts.reads += 1;
      const page = pageOf(bytes, range, pageBytes);
      counts.served += Buffer.from(page.data, 'base64').length;
      return page;
    },
    size: async () => {
      counts.sizes += 1;
      return size;
    },
  });
  return { source, counts };
};

/**
 * A source without `size()` (the protocol makes it optional), over
 * `length` bytes made on demand: it never holds more than a page.
 * @param {number} length
 */
const makeLongSource = length => {
  const counts = { reads: 0, served: 0 };
  const source = Far('ImageSource', {
    /** @param {{ offset: number, maxBytes: number }} range */
    readBase64: ({ offset, maxBytes }) => {
      counts.reads += 1;
      const end = Math.min(length, offset + maxBytes);
      counts.served += end - offset;
      const bytes =
        offset === 0 ? imageBytes(end) : Buffer.alloc(end - offset, 1);
      return harden({ data: bytes.toString('base64'), done: end >= length });
    },
  });
  return { source, counts };
};

/** A session presence: the staging owner. */
const makeSession = () => Far('Session', {});

/**
 * Timers whose `after` fires only when the test says so.
 */
const makeManualTimers = () => {
  /** @type {Array<{ ms: number, fn: () => void, live: boolean }>} */
  const pending = [];
  const timers = harden({
    delay: () => Promise.resolve(),
    /**
     * @param {number} ms
     * @param {() => void} fn
     */
    after: (ms, fn) => {
      const entry = { ms, fn, live: true };
      pending.push(entry);
      return () => {
        entry.live = false;
      };
    },
  });
  return {
    timers,
    pending,
    fire: () => {
      for (const entry of pending) if (entry.live) entry.fn();
    },
  };
};

/**
 * A tool over a fresh blob store.
 * @param {Parameters<typeof makeTestBlobs>[0] & { timers?: any }} [options]
 */
const setup = ({ timers = makeTimers(), ...blobOptions } = {}) => {
  const blobs = makeTestBlobs(blobOptions);
  const session = makeSession();
  /** @type {Array<[string, any]>} */
  const events = [];
  const tool = makeImageTool({
    blobs: blobs.store,
    session,
    timers,
    log: (name, fields) => events.push([name, fields]),
  });
  return { ...blobs, session, tool, events };
};

/**
 * @param {any} tool
 * @param {any} target
 * @param {unknown} [path] given as the model's JSON text
 * @returns {Promise<any>}
 */
const view = (tool, target, path) =>
  E(tool).view(
    harden({
      opId: 'op1',
      target,
      ...(path === undefined ? {} : { path: JSON.stringify(path) }),
    }),
  );

/**
 * The envelope a successful outcome names, decoded.
 * @param {any} store
 * @param {any} outcome
 * @param {any} session
 */
const envelopeOf = async (store, outcome, session) => {
  const textValue = await store.read(outcome.text.blob, session);
  if (!textValue.startsWith(IMAGE_ENVELOPE_PREFIX)) throw Error('no prefix');
  const { mimeType, data } = JSON.parse(
    textValue.slice(IMAGE_ENVELOPE_PREFIX.length),
  );
  return { mimeType, bytes: Buffer.from(data, 'base64') };
};

// ---------------------------------------------------------------- formats

test('imageTypeOf: PNG, JPEG and WebP by their magic; SVG, HTML and short input are not images', t => {
  t.is(imageTypeOf(imageBytes(16)), 'image/png');
  t.is(imageTypeOf(JPEG()), 'image/jpeg');
  t.is(imageTypeOf(WEBP()), 'image/webp');
  t.is(
    imageTypeOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    undefined,
  );
  t.is(imageTypeOf(Buffer.from('<!doctype html><html></html>')), undefined);
  t.is(imageTypeOf(Buffer.from([0x89, 0x50, 0x4e])), undefined);
  t.is(imageTypeOf(Buffer.from('RIFF\0\0\0\0WAVE')), undefined);
});

test('a PNG, a JPEG and a WebP are staged as the envelope with the receipt as preview', async t => {
  const { store, session, tool, cleanup } = setup();
  t.teardown(cleanup);
  for (const [bytes, mediaType] of /** @type {const} */ ([
    [imageBytes(1 * MiB), 'image/png'],
    [JPEG(), 'image/jpeg'],
    [WEBP(), 'image/webp'],
  ])) {
    const { source } = makeSource(bytes);
    // eslint-disable-next-line no-await-in-loop
    const outcome = await view(tool, source);
    t.is(outcome.status, 'ok', mediaType);
    t.true(matches(outcome, imageGuards.ToolOutcome));
    t.is(outcome.text.preview, imageTextOf.receipt(mediaType));
    // The outcome stays far below a frame: only the handle and the receipt.
    t.true(JSON.stringify({ ...outcome.text, blob: 'b' }).length < 4096);
    // eslint-disable-next-line no-await-in-loop
    const envelope = await envelopeOf(store, outcome, session);
    t.is(envelope.mimeType, mediaType);
    t.true(envelope.bytes.equals(bytes), mediaType);
  }
});

test('an SVG and an HTML file named .png are refused as unsupported', async t => {
  const { tool, cleanup, blobDir } = setup();
  t.teardown(cleanup);
  for (const textValue of [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    '<!doctype html><title>x</title>',
  ]) {
    const { source } = makeSource(Buffer.from(textValue));
    const dir = Far('Directory', { lookup: () => source });
    // eslint-disable-next-line no-await-in-loop
    const outcome = await view(tool, dir, ['shot.png']);
    t.deepEqual(outcome, { status: 'failed', text: imageTexts.unsupported });
  }
  t.deepEqual(filesIn(blobDir), []);
});

// ---------------------------------------------------------------- bounds

test('size() over 2 MiB refuses before any read', async t => {
  const { tool, cleanup } = setup();
  t.teardown(cleanup);
  const { source, counts } = makeSource(imageBytes(64), { size: MAX + 1 });
  t.deepEqual(await view(tool, source), {
    status: 'failed',
    text: imageTexts.tooLarge,
  });
  t.is(counts.sizes, 1);
  t.is(counts.reads, 0);
});

test('exactly 2 MiB is accepted', async t => {
  const { tool, cleanup } = setup();
  t.teardown(cleanup);
  const { source } = makeSource(imageBytes(MAX));
  t.is((await view(tool, source)).status, 'ok');
});

test('a 10 MiB source without size() stops at 2 MiB + 1 byte; nothing is staged', async t => {
  const { tool, cleanup, blobDir } = setup();
  t.teardown(cleanup);
  const { source, counts } = makeLongSource(10 * MiB);
  t.deepEqual(await view(tool, source), {
    status: 'failed',
    text: imageTexts.tooLarge,
  });
  t.is(counts.served, MAX + 1);
  t.deepEqual(filesIn(blobDir), []);
  t.deepEqual(partsIn(blobDir), []);
});

test('pages totalling 3 MiB stop at the page that passes 2 MiB', async t => {
  const { tool, cleanup, blobDir } = setup();
  t.teardown(cleanup);
  // Its size() understates the length; its pages follow each ask.
  const { source, counts } = makeSource(imageBytes(3 * MiB), {
    size: 1024,
  });
  t.deepEqual(await view(tool, source), {
    status: 'failed',
    text: imageTexts.tooLarge,
  });
  t.true(counts.served <= MAX + 1);
  t.deepEqual(filesIn(blobDir), []);
});

test('a source answering one 10 MiB page is refused at the page check', async t => {
  const { tool, cleanup } = setup();
  t.teardown(cleanup);
  const big = Buffer.alloc(10 * MiB, 0x41).toString('base64');
  // Hostile: no guard checks its own answer.
  const hostile = Far('ImageSource', {
    readBase64: () => harden({ data: big, done: true }),
  });
  t.deepEqual(await view(tool, hostile), {
    status: 'failed',
    text: imageTexts.badPage,
  });
  // Built with the guard, the same answer breaks the source's own call.
  const guarded = makeExo('ImageSource', imageGuards.ImageSource, {
    readBase64: async () => harden({ data: big, done: true }),
    size: async () => 10,
  });
  t.deepEqual(await view(tool, guarded), {
    status: 'failed',
    text: imageTexts.badPage,
  });
});

test('pages that are not base64, too long for their ask, or not records are badPage', async t => {
  const { tool, cleanup } = setup();
  t.teardown(cleanup);
  for (const answer of [
    'abc',
    harden({ data: 'not base64!', done: true }),
    harden({ data: 'AAA', done: true }),
    harden({ data: 'AA==AA==', done: true }),
    harden({ data: 'AAAA', done: 'yes' }),
    harden({ data: 42, done: true }),
  ]) {
    const source = Far('ImageSource', { readBase64: () => answer });
    // eslint-disable-next-line no-await-in-loop
    const outcome = await view(tool, source);
    t.deepEqual(
      outcome,
      { status: 'failed', text: imageTexts.badPage },
      JSON.stringify(answer),
    );
  }
});

test('64 empty pages then the image is read; 65 empty pages are refused', async t => {
  const { tool, cleanup } = setup();
  t.teardown(cleanup);
  const bytes = imageBytes(2048);
  /** @param {number} empties */
  const flaky = empties => {
    let left = empties;
    let reads = 0;
    const source = makeExo('ImageSource', imageGuards.ImageSource, {
      /** @param {{ offset: number, maxBytes: number }} range */
      readBase64: async range => {
        reads += 1;
        if (left > 0) {
          left -= 1;
          return harden({ data: '', done: false });
        }
        return pageOf(bytes, range, range.maxBytes);
      },
      size: async () => bytes.length,
    });
    return { source, reads: () => reads };
  };
  const ok = flaky(imageLimits.maxEmptyReads);
  t.is((await view(tool, ok.source)).status, 'ok');
  const refused = flaky(imageLimits.maxEmptyReads + 1);
  t.deepEqual(await view(tool, refused.source), {
    status: 'failed',
    text: imageTexts.tooManyEmptyReads,
  });
  t.is(refused.reads(), imageLimits.maxEmptyReads + 1);
});

test('a source that never answers times out at the read deadline', async t => {
  const manual = makeManualTimers();
  const { tool, cleanup } = setup({ timers: manual.timers });
  t.teardown(cleanup);
  let calls = 0;
  const hanging = makeExo('ImageSource', imageGuards.ImageSource, {
    readBase64: () => {
      calls += 1;
      return new Promise(() => {});
    },
    size: async () => 100,
  });
  const pending = view(tool, hanging);
  while (calls === 0) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
  t.deepEqual(
    manual.pending.map(entry => entry.ms),
    [imageLimits.readTimeoutMs],
  );
  manual.fire();
  t.deepEqual(await pending, {
    status: 'failed',
    text: imageTexts.readTimeout,
  });
});

test('the deadline is cancelled when the read ends', async t => {
  const manual = makeManualTimers();
  const { tool, cleanup } = setup({ timers: manual.timers });
  t.teardown(cleanup);
  const { source } = makeSource(imageBytes(100));
  t.is((await view(tool, source)).status, 'ok');
  t.deepEqual(
    manual.pending.map(entry => entry.live),
    [false],
  );
});

test('short pages of 15,360 bytes, as a source in a vat answers, are read to the end', async t => {
  const { store, session, tool, cleanup } = setup();
  t.teardown(cleanup);
  const bytes = imageBytes(1 * MiB + 123);
  const { source, counts } = makeSource(bytes, { pageBytes: 15_360 });
  const outcome = await view(tool, source);
  t.is(outcome.status, 'ok');
  t.is(counts.reads, Math.ceil(bytes.length / 15_360));
  t.true((await envelopeOf(store, outcome, session)).bytes.equals(bytes));
});

test('pages ask readPageBytes, and the last ask never passes one byte over the limit', async t => {
  const { tool, cleanup } = setup();
  t.teardown(cleanup);
  /** @type {number[]} */
  const asks = [];
  const bytes = imageBytes(MAX);
  const source = makeExo('ImageSource', imageGuards.ImageSource, {
    /** @param {{ offset: number, maxBytes: number }} range */
    readBase64: async range => {
      asks.push(range.maxBytes);
      return pageOf(bytes, range, range.maxBytes);
    },
    size: async () => bytes.length,
  });
  t.is((await view(tool, source)).status, 'ok');
  t.is(asks[0], imageLimits.readPageBytes);
  t.is(asks.at(-1), MAX + 1 - imageLimits.readPageBytes * (asks.length - 1));
});

// ---------------------------------------------------------------- descent

/**
 * A workspace reader built from the environments `GitReader` guard: every
 * method but `openImage` refuses.
 * @param {(path: string[]) => any} openImage
 */
const makeWorkspaceReader = openImage => {
  /** @type {Record<string, (...args: any[]) => any>} */
  const methods = {};
  for (const name of gitReaderMethodNames) {
    methods[name] = async () => {
      throw Error(`${name} is not part of this fake`);
    };
  }
  methods.openImage = async path => openImage(path);
  return makeExo(
    'GitReader',
    environmentInterfaces.GitReader,
    /** @type {any} */ (methods),
  );
};

test('with a path, a workspace is read through openImage(path) with the checked segments', async t => {
  const { store, session, tool, cleanup } = setup();
  t.teardown(cleanup);
  const bytes = imageBytes(50_000);
  /** @type {any[]} */
  const asked = [];
  const workspace = makeWorkspaceReader(path => {
    asked.push(path);
    return makeSource(bytes).source;
  });
  const outcome = await view(tool, workspace, ['screenshots', 'mobile.png']);
  t.is(outcome.status, 'ok');
  t.deepEqual(asked, [['screenshots', 'mobile.png']]);
  t.true((await envelopeOf(store, outcome, session)).bytes.equals(bytes));
});

test('with a path, a directory-like object is read through lookup(path)', async t => {
  const { tool, cleanup } = setup();
  t.teardown(cleanup);
  /** @type {any[]} */
  const asked = [];
  const dir = Far('Directory', {
    /** @param {string[]} path */
    lookup: path => {
      asked.push(path);
      return makeSource(imageBytes(100)).source;
    },
  });
  t.is((await view(tool, dir, ['a', 'b.png'])).status, 'ok');
  t.deepEqual(asked, [['a', 'b.png']]);
});

test('a path on a target with neither method, or one the target refuses, is notFound', async t => {
  const { tool, cleanup } = setup();
  t.teardown(cleanup);
  const { source } = makeSource(imageBytes(100));
  t.deepEqual(await view(tool, source, ['x.png']), {
    status: 'failed',
    text: imageTexts.notFound,
  });
  const refusing = makeWorkspaceReader(() => {
    throw Error('gitPathRefused');
  });
  t.deepEqual(await view(tool, refusing, ['.git', 'x.png']), {
    status: 'failed',
    text: imageTexts.notFound,
  });
});

test('a target without readBase64 is notReadable', async t => {
  const { tool, cleanup } = setup();
  t.teardown(cleanup);
  t.deepEqual(await view(tool, Far('Thing', { ping: () => 1 })), {
    status: 'failed',
    text: imageTexts.notReadable,
  });
  const dir = Far('Directory', { lookup: () => Far('Other', {}) });
  t.deepEqual(await view(tool, dir, ['x.png']), {
    status: 'failed',
    text: imageTexts.notReadable,
  });
});

test('a lost source or target answers sourceLost, never a rejection', async t => {
  const { tool, cleanup } = setup();
  t.teardown(cleanup);
  const lostReader = makeExo('ImageSource', imageGuards.ImageSource, {
    readBase64: async () => {
      throw Error(HUB_RETIRED_MESSAGE);
    },
    size: async () => 100,
  });
  t.deepEqual(await view(tool, lostReader), {
    status: 'failed',
    text: imageTexts.sourceLost,
  });
  const lostSize = makeExo('ImageSource', imageGuards.ImageSource, {
    readBase64: async () => harden({ data: '', done: true }),
    size: async () => {
      throw Error(HUB_RETIRED_MESSAGE);
    },
  });
  t.deepEqual(await view(tool, lostSize), {
    status: 'failed',
    text: imageTexts.sourceLost,
  });
  const lostWorkspace = makeWorkspaceReader(() => {
    throw Error(HUB_RETIRED_MESSAGE);
  });
  t.deepEqual(await view(tool, lostWorkspace, ['a.png']), {
    status: 'failed',
    text: imageTexts.sourceLost,
  });
  // A message that merely quotes the break text is an ordinary refusal.
  const quoting = makeExo('ImageSource', imageGuards.ImageSource, {
    readBase64: async () => {
      throw Error(`not ${HUB_RETIRED_MESSAGE}`);
    },
    size: async () => 100,
  });
  t.deepEqual(await view(tool, quoting), {
    status: 'failed',
    text: imageTexts.badPage,
  });
});

// ---------------------------------------------------------------- the path

test('bad paths are refused before any call on the target', async t => {
  const { tool, cleanup } = setup();
  t.teardown(cleanup);
  let calls = 0;
  const target = Far('Directory', {
    lookup: () => {
      calls += 1;
      return undefined;
    },
  });
  const texts = [
    JSON.stringify(Array.from({ length: 65 }, () => 'a')),
    JSON.stringify(['..', 'x.png']),
    JSON.stringify(['.']),
    JSON.stringify(['a/b.png']),
    JSON.stringify(['a\\b.png']),
    JSON.stringify(['a\0b.png']),
    JSON.stringify(['ok', 7]),
    JSON.stringify([]),
    JSON.stringify(['']),
    JSON.stringify(['x'.repeat(256)]),
    JSON.stringify({ path: ['x.png'] }),
    JSON.stringify('x.png'),
    '["x.png"',
  ];
  for (const path of texts) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await E(tool).view(harden({ opId: 'op1', target, path }));
    t.deepEqual(outcome, { status: 'failed', text: imageTexts.badPath }, path);
  }
  t.is(calls, 0);
});

// ---------------------------------------------------------------- staging

test('a staging refused by the session quota answers notStaged; nothing stays on disk', async t => {
  const { tool, cleanup, blobDir } = setup({
    quota: { sessionBytes: 64 * 1024, daemonBytes: 64 * MiB },
  });
  t.teardown(cleanup);
  const { source } = makeSource(imageBytes(100_000));
  t.deepEqual(await view(tool, source), {
    status: 'failed',
    text: imageTexts.notStaged,
  });
  t.deepEqual(filesIn(blobDir), []);
  t.deepEqual(partsIn(blobDir), []);
  // A smaller image still fits.
  t.is((await view(tool, makeSource(imageBytes(1000)).source)).status, 'ok');
});

test('the staging is charged to the session', async t => {
  const { store, session, tool, cleanup } = setup();
  t.teardown(cleanup);
  const outcome = await view(tool, makeSource(imageBytes(30_000)).source);
  t.is(outcome.status, 'ok');
  t.is(store.usage(session).session, outcome.text.bytes);
  const { bytes } = /** @type {{ bytes: number }} */ (outcome.text);
  t.true(bytes > 40_000 && bytes < 41_000);
});

// ---------------------------------------------------------------- kill points

/**
 * The blob directory as a SIGKILL at the traced step would leave it: the
 * trace copies every file of the directory into `atKill` at that step.
 * Then a new store over `atKill` (the next adapter incarnation) sweeps.
 * @param {string} step
 */
const killAt = async step => {
  /** @type {string | undefined} */
  let blobDir;
  /** @type {string | undefined} */
  let atKill;
  const fake = makeFakeBlobSink();
  const blobs = makeTestBlobs({
    sink: fake.sink,
    trace: traced => {
      if (traced !== step || blobDir === undefined || atKill !== undefined)
        return;
      atKill = join(blobs.root, 'at-kill');
      mkdirSync(atKill, { recursive: true });
      for (const name of [...filesIn(blobDir), ...partsIn(blobDir)])
        copyFileSync(join(blobDir, name), join(atKill, name));
    },
  });
  blobDir = blobs.blobDir;
  const session = makeSession();
  const tool = makeImageTool({
    blobs: blobs.store,
    session,
    timers: makeTimers(),
  });
  const outcome = await view(tool, makeSource(imageBytes(10_000)).source);
  if (atKill === undefined) throw Error(`step ${step} was not traced`);
  const atKillFiles = { files: filesIn(atKill), parts: partsIn(atKill) };
  const next = makeBlobStore({ dir: atKill, sink: fake.sink });
  await next.sweep();
  return {
    outcome,
    atKillFiles,
    afterRestart: { files: filesIn(atKill), parts: partsIn(atKill) },
    cleanup: blobs.cleanup,
  };
};

test('I1: a kill while the pages are read leaves nothing on disk', async t => {
  const { tool, cleanup, blobDir } = setup();
  t.teardown(cleanup);
  /** @type {(value?: any) => void} */
  let release = () => {};
  let reading = false;
  const bytes = imageBytes(4096);
  const slow = makeExo('ImageSource', imageGuards.ImageSource, {
    /** @param {{ offset: number, maxBytes: number }} range */
    readBase64: async range => {
      reading = true;
      await new Promise(resolve => {
        release = resolve;
      });
      return pageOf(bytes, range, range.maxBytes);
    },
    size: async () => bytes.length,
  });
  const pending = view(tool, slow);
  while (!reading) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
  t.deepEqual(filesIn(blobDir), []);
  t.deepEqual(partsIn(blobDir), []);
  release();
  t.is((await pending).status, 'ok');
});

test('I2: a kill after the envelope .part is written leaves a .part the next start deletes', async t => {
  const { atKillFiles, afterRestart, cleanup } = await killAt('rename');
  t.teardown(cleanup);
  t.is(atKillFiles.parts.length, 1);
  t.deepEqual(atKillFiles.files, []);
  t.deepEqual(afterRestart, { files: [], parts: [] });
});

test('I3: a kill after the envelope is committed leaves one unnamed file, kept for the collection sweep', async t => {
  const { outcome, atKillFiles, afterRestart, cleanup } = await killAt('bind');
  t.teardown(cleanup);
  t.is(outcome.status, 'ok');
  t.is(atKillFiles.files.length, 1);
  t.deepEqual(afterRestart, { files: atKillFiles.files, parts: [] });
});

test('the tool logs a start and an end or a refusal, never bytes', async t => {
  const { tool, cleanup, events } = setup();
  t.teardown(cleanup);
  await view(tool, makeSource(imageBytes(100)).source);
  await view(tool, makeSource(Buffer.from('<svg/>')).source);
  t.deepEqual(
    events.map(([name]) => name),
    [
      'image-view-start',
      'image-view-end',
      'image-view-start',
      'image-view-refused',
    ],
  );
  t.true(JSON.stringify(events).length < limits.inlineBytes);
});
