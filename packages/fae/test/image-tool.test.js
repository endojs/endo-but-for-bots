// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { decodeBase64 } from '@endo/base64';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import {
  decodeImageResult,
  MAX_IMAGE_BYTES,
} from '@endo/hosted-agent/image-result.js';
import { makeViewImageTool } from '../src/image-tool.js';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1sAAAAASUVORK5CYII=';
const bytes = decodeBase64(PNG);

for (const kind of ['blob', 'mount', 'workspace']) {
  test(`viewImage reads a granted ${kind} as image input`, async t => {
    const blob = bytesReaderFromIterator([
      bytes.subarray(0, 9),
      bytes.subarray(9),
    ]);
    const tree = Far('Tree', {
      lookup: segments => {
        t.deepEqual(segments, ['shots', 'mobile.png']);
        return blob;
      },
      __getMethodNames__: () => harden(['lookup']),
    });
    const workspace = Far('Workspace', {
      worktree: () => tree,
      __getMethodNames__: () => harden(['worktree']),
    });
    const powers = Far('Powers', {
      lookup: name => {
        t.deepEqual(name, ['granted']);
        return kind === 'blob' ? blob : kind === 'mount' ? tree : workspace;
      },
    });
    const tool = makeViewImageTool(powers);
    const result = await tool.execute({
      petName: 'granted',
      ...(kind === 'blob' ? {} : { path: ['shots', 'mobile.png'] }),
    });
    t.deepEqual(decodeImageResult(result), {
      mimeType: 'image/png',
      data: PNG,
    });
    t.regex(tool.help(), /syntax check alone does not verify/);
  });
}

test('invalid paths and arguments never acquire authority', async t => {
  const tool = makeViewImageTool(
    Far('No authority', { lookup: () => t.fail('unexpected lookup') }),
  );
  for (const path of [
    ['..', 'secret'],
    ['/etc/passwd'],
    ['a/b'],
    ['.'],
    [],
    ['a\\b'],
    ['\0'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => tool.execute({ petName: 'mount', path }), {
      message: /path/,
    });
  }
  await t.throwsAsync(
    () => tool.execute({ petName: 'mount', url: 'https://example.com' }),
    { message: /Unexpected argument/ },
  );
});

test('non-image contents are rejected without rendering or network authority', async t => {
  const powers = Far('Powers', {
    lookup: () =>
      bytesReaderFromIterator([
        new TextEncoder().encode('<svg>not a raster</svg>'),
      ]),
  });
  await t.throwsAsync(
    () => makeViewImageTool(powers).execute({ petName: 'blob' }),
    { message: /Unsupported image bytes/ },
  );
});

test('overflow closes the stream and a later call can recover', async t => {
  let closed = false;
  let reads = 0;
  const powers = Far('Powers', {
    lookup: () => {
      reads += 1;
      if (reads > 1) return bytesReaderFromIterator([bytes]);
      function* chunks() {
        try {
          yield bytes;
          yield new Uint8Array(MAX_IMAGE_BYTES);
          t.fail('read past bound');
        } finally {
          closed = true;
        }
      }
      return bytesReaderFromIterator(chunks());
    },
  });
  const tool = makeViewImageTool(powers);
  await t.throwsAsync(() => tool.execute({ petName: 'blob' }), {
    message: /2 MiB limit/,
  });
  // Reader close propagates through the remote stream asynchronously.
  await new Promise(resolve => setTimeout(resolve, 0));
  t.true(closed);
  t.is(decodeImageResult(await tool.execute({ petName: 'blob' }))?.data, PNG);
});

test('real Endo mounts stream image bytes and reject a symlink escape', async t => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const { makeMount } = await import('@endo/daemon/src/mount.js');
  const { makeFilePowers } =
    await import('@endo/daemon/src/manager-node-powers.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fae-image-'));
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'inside'));
  fs.writeFileSync(path.join(root, 'inside', 'scene.png'), bytes);
  fs.writeFileSync(path.join(root, 'private.png'), bytes);
  fs.symlinkSync(
    path.join(root, 'private.png'),
    path.join(root, 'inside', 'escape.png'),
  );
  const mount = makeMount({
    rootPath: path.join(root, 'inside'),
    readOnly: true,
    filePowers: makeFilePowers({ fs, path }),
  });
  const tool = makeViewImageTool(Far('Powers', { lookup: () => mount }));
  t.deepEqual(
    decodeImageResult(
      await tool.execute({ petName: 'mount', path: ['scene.png'] }),
    ),
    { mimeType: 'image/png', data: PNG },
  );
  await t.throwsAsync(() =>
    tool.execute({ petName: 'mount', path: ['escape.png'] }),
  );
});
