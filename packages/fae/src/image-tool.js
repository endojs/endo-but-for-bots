// @ts-check

import { encodeBase64 } from '@endo/base64';
import { E } from '@endo/eventual-send';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import {
  encodeImageResult,
  MAX_IMAGE_BYTES,
} from '@endo/hosted-agent/image-result.js';

import { assertToolArguments } from './tool-arguments.js';

/** @param {Uint8Array} bytes */
const imageType = bytes => {
  const starts = signature => signature.every((value, i) => bytes[i] === value);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10]))
    return /** @type {const} */ ('image/png');
  if (starts([255, 216, 255])) return /** @type {const} */ ('image/jpeg');
  if (
    starts([82, 73, 70, 70]) &&
    bytes[8] === 87 &&
    bytes[9] === 69 &&
    bytes[10] === 66 &&
    bytes[11] === 80
  )
    return /** @type {const} */ ('image/webp');
  throw Error(
    'Unsupported image bytes. Render or convert to PNG, JPEG or WebP first; SVG and HTML are not raster images.',
  );
};

/**
 * Reads only a capability already held by the agent. No host filesystem or URL
 * fetch authority is introduced. Workspaces expose their tree via worktree();
 * mounts/trees expose lookup(path), while an adopted blob can be read directly.
 * @param {any} powers
 */
export const makeViewImageTool = powers => {
  const schema = harden({
    type: 'function',
    function: {
      name: 'viewImage',
      description:
        'Read a PNG, JPEG or WebP through an already-held Endo capability and see it as image input (requires a vision-capable model). Use petName for a blob, mount/tree, or git workspace; path is an optional array of relative file segments. For a workspace it reads through worktree(). Example: {"petName":"workspace","path":["screenshots","mobile.png"]}. Maximum 2 MiB; resize larger images first. For visual development, render in a browser, save desktop/mobile screenshots into the workspace, call viewImage, inspect browser errors, and iterate. Source code or a syntax check alone does not verify the rendered scene. This tool does not render HTML or fetch URLs.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          petName: { type: 'string', minLength: 1, maxLength: 256 },
          path: {
            type: 'array',
            minItems: 1,
            maxItems: 64,
            items: { type: 'string', minLength: 1, maxLength: 255 },
          },
        },
        required: ['petName'],
      },
    },
  });
  return harden({
    schema: () => schema,
    help: () => schema.function.description,
    async execute(args) {
      assertToolArguments(schema, args);
      const { petName, path } = args;
      if (
        typeof petName !== 'string' ||
        !petName.length ||
        petName.length > 256
      )
        throw Error(
          'petName must be a nonempty name of at most 256 characters',
        );
      if (
        path !== undefined &&
        (!Array.isArray(path) ||
          !path.length ||
          path.length > 64 ||
          path.some(
            segment =>
              typeof segment !== 'string' ||
              !segment.length ||
              segment.length > 255 ||
              segment === '.' ||
              segment === '..' ||
              /[/\\\0]/.test(segment),
          ))
      )
        throw Error(
          'path must contain relative file segments, not a host path',
        );
      let blob = await E(powers).lookup([petName]);
      if (path !== undefined) {
        // eslint-disable-next-line no-underscore-dangle
        const methods = await E(blob).__getMethodNames__();
        if (methods.includes('worktree')) blob = await E(blob).worktree();
        blob = await E(blob).lookup(harden(path));
      }
      // Check declared size when available, but count every streamed byte too:
      // a live file can grow after stat, and a custom blob can misreport size.
      // eslint-disable-next-line no-underscore-dangle
      const methods = await E(blob).__getMethodNames__();
      if (
        methods.includes('size') &&
        BigInt(await E(blob).size()) > BigInt(MAX_IMAGE_BYTES)
      )
        throw Error('Image exceeds the 2 MiB limit; resize it before reading');
      if (!methods.includes('streamBase64'))
        throw Error(
          'Image capability must expose streamBase64(); use a readable Endo blob',
        );
      // Bound retained memory independently of the producer's chunk sizes.
      // Keeping one array per chunk lets tiny or empty chunks defeat the byte
      // budget. Empty chunks also need a separate progress budget.
      const bytes = new Uint8Array(MAX_IMAGE_BYTES);
      let size = 0;
      let emptyChunks = 0;
      for await (const chunk of iterateBytesReader(blob, {
        stringLengthLimit: 4 * Math.ceil(MAX_IMAGE_BYTES / 3),
      })) {
        if (chunk.length === 0) {
          emptyChunks += 1;
          if (emptyChunks > 64)
            throw Error('Image stream yielded too many empty chunks');
        }
        if (chunk.length > MAX_IMAGE_BYTES - size)
          throw Error(
            'Image exceeds the 2 MiB limit; resize it before reading',
          );
        bytes.set(chunk, size);
        size += chunk.length;
      }
      const image = bytes.subarray(0, size);
      return encodeImageResult({
        mimeType: imageType(image),
        data: encodeBase64(image),
      });
    },
  });
};
harden(makeViewImageTool);
