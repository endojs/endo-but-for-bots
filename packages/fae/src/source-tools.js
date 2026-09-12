// @ts-check
/* eslint-disable no-await-in-loop */

import { E } from '@endo/eventual-send';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';

import { assertToolArguments } from './tool-arguments.js';

const MAX_BYTES = 1024 * 1024;
const MAX_CHARACTERS = 8000;
const MAX_ITEMS = 8;
// The response is itself JSON text embedded inside a durable journal event.
// At most 48k serialized characters leaves room for a second escaping layer
// (at most 96k) and metadata under the journal's 128 Ki character profile.
const MAX_RESPONSE_SIZE = 48_000;

/** @param {unknown} value */
const assertPetName = value => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw Error('petName must be a nonempty string of at most 256 characters');
  }
  return value;
};

/** @param {any} powers */
export const makeDescribeCapabilityTool = powers => {
  const schema = harden({
    type: 'function',
    function: {
      name: 'describeCapability',
      description:
        'Discover callable methods and existing capability documentation. Supply method to obtain its signature/examples. Does not invoke that method. Example for an Endo mount: {"petName":"review-source","method":"readText"}. Invoke with exec/endo_exec: const ref = await E(powers).lookup("review-source"); return await E(ref).readText(["README.md"]); an Endo mount readText takes ONE path argument, not line numbers. Other capabilities may have different signatures: follow their help documentation. Prefer readSources for bounded mount reads/search.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { petName: { type: 'string' }, method: { type: 'string' } },
        required: ['petName'],
      },
    },
  });
  return harden({
    schema: () => schema,
    help: () => schema.function.description,
    async execute(args) {
      assertToolArguments(schema, args);
      const ref = await E(powers).lookup([assertPetName(args.petName)]);
      const names = /** @type {unknown[]} */ (
        // eslint-disable-next-line no-underscore-dangle
        await E(ref).__getMethodNames__()
      );
      if (!Array.isArray(names))
        throw Error('Capability returned an invalid method list');
      const methods = names
        .filter(name => typeof name === 'string')
        .slice(0, 128);
      if (args.method !== undefined && !methods.includes(args.method)) {
        throw Error('Requested method is not in the callable method list');
      }
      let documentation =
        'Documentation is unavailable; do not guess method signatures.';
      let documentationScope = 'unavailable';
      if (methods.includes('help')) {
        try {
          const text = await E(ref).help(
            ...(args.method === undefined ? [] : [args.method]),
          );
          if (typeof text === 'string') {
            documentation = text;
            documentationScope =
              args.method === undefined ? 'overview' : 'method';
          }
        } catch {
          // Some guarded capabilities support only zero-argument help().
          if (args.method !== undefined) {
            try {
              const text = await E(ref).help();
              if (typeof text === 'string') {
                documentation = text;
                documentationScope = 'overview';
              }
            } catch {
              // Preserve the discovered callable interface even without docs.
            }
          }
        }
      }
      const description = {
        methods: methods.map(name => name.slice(0, 128)),
        documentation: String(documentation).slice(0, MAX_CHARACTERS),
        documentationScope,
        example:
          documentationScope === 'overview'
            ? 'const ref = await E(powers).lookup(petName); return await E(ref).help();'
            : 'const ref = await E(powers).lookup(petName); return await E(ref).help(method);',
        truncated:
          names.length > methods.length ||
          documentation.length > MAX_CHARACTERS ||
          methods.some(name => name.length > 128),
      };
      while (JSON.stringify(description).length > MAX_RESPONSE_SIZE) {
        description.truncated = true;
        if (description.documentation.length > 0) {
          description.documentation = description.documentation.slice(
            0,
            Math.floor(description.documentation.length / 2),
          );
        } else description.methods.pop();
      }
      return JSON.stringify(description);
    },
  });
};
harden(makeDescribeCapabilityTool);

/**
 * Preserve the leading source lines while bounding their actual serialized
 * size, including quotes, backslashes, and escaped control characters.
 * @template {{ lines: Array<{line: number, text: string}>, outputTruncated: boolean }} T
 * @param {T} result
 * @param {number} limit
 */
const boundSourceResult = (result, limit) => {
  if (JSON.stringify(result).length <= limit) return result;
  result.outputTruncated = true;
  while (result.lines.length > 0) {
    const last = result.lines.pop();
    if (!last) break;
    if (JSON.stringify(result).length <= limit) {
      const shortened = { ...last, text: '' };
      result.lines.push(shortened);
      if (JSON.stringify(result).length > limit) {
        result.lines.pop();
        return result;
      }
      let low = 0;
      let high = last.text.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        shortened.text = last.text.slice(0, middle);
        if (JSON.stringify(result).length <= limit) low = middle;
        else high = middle - 1;
      }
      shortened.text = last.text.slice(0, low);
      return result;
    }
  }
  return result;
};

/**
 * Read a prefix through the existing flow-controlled blob capability. No host
 * filesystem authority or whole-file text read is introduced. The input scan
 * limit is 1 MiB, in addition to output/line limits; a later range outside that
 * prefix is explicitly incomplete, never reported as absent.
 * @param {any} blob
 */
const readPrefix = async blob => {
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let scanTruncated = false;
  for await (const chunk of iterateBytesReader(blob)) {
    const remaining = MAX_BYTES - bytes;
    const accepted = chunk.subarray(0, remaining);
    text += decoder.decode(accepted, { stream: true });
    bytes += accepted.length;
    if (bytes === MAX_BYTES) {
      scanTruncated = true;
      break;
    }
  }
  text += decoder.decode();
  return { text, scanTruncated };
};

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} maximum
 */
const boundedInteger = (value, fallback, maximum) => {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== 'number' ||
    !Number.isInteger(result) ||
    result < 1 ||
    result > maximum
  ) {
    throw Error(
      `Line/count arguments must be integers between 1 and ${maximum}`,
    );
  }
  return result;
};

/** @param {any} powers */
export const makeReadSourcesTool = powers => {
  const itemSchema = harden({
    type: 'object',
    additionalProperties: false,
    properties: {
      path: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 64,
      },
      startLine: { type: 'integer', minimum: 1, maximum: 1_000_000 },
      lineCount: { type: 'integer', minimum: 1, maximum: 200 },
      search: {
        type: 'string',
        description:
          'Optional literal, case-sensitive substring (not a regular expression).',
      },
    },
    required: ['path'],
  });
  const schema = harden({
    type: 'function',
    function: {
      name: 'readSources',
      description:
        'Read or literal-search explicit file paths under an already-held Endo mount petName. Up to 8 items; each independently returns lines with 1-based numbers or an error, so one missing file does not discard other results. Defaults startLine=1, lineCount=80; maximum 200 returned lines and 8000 text characters per item, scans at most 1 MiB per file. A 48000-character serialized response budget, including escaping, is divided evenly across items. Truncation flags distinguish incomplete scans from no matches. Paths are arrays of relative segments, never host paths or petnames. Example: {"petName":"review-source","items":[{"path":["README.md"],"startLine":1,"lineCount":40},{"path":["src","agent.js"],"search":"checkpoint"}]}. Use mount glob via exec/endo_exec to discover paths first.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          petName: { type: 'string' },
          items: {
            type: 'array',
            items: itemSchema,
            minItems: 1,
            maxItems: MAX_ITEMS,
          },
        },
        required: ['petName', 'items'],
      },
    },
  });
  return harden({
    schema: () => schema,
    help: () => schema.function.description,
    async execute(args) {
      assertToolArguments(schema, args);
      const petName = assertPetName(args.petName);
      const items = /** @type {unknown[]} */ (args.items);
      if (
        !Array.isArray(items) ||
        items.length < 1 ||
        items.length > MAX_ITEMS
      ) {
        throw Error('items must contain between 1 and 8 requests');
      }
      const mount = await E(powers).lookup([petName]);
      // Leave 100 characters for the outer result envelope and separators.
      const itemBudget = Math.floor((MAX_RESPONSE_SIZE - 100) / items.length);
      const results = [];
      for (const [index, rawItem] of items.entries()) {
        let reading = false;
        try {
          assertToolArguments(
            { function: { name: 'readSources item', parameters: itemSchema } },
            rawItem,
          );
          const item =
            /** @type {{path: string[], startLine?: number, lineCount?: number, search?: string}} */ (
              rawItem
            );
          if (
            !Array.isArray(item.path) ||
            item.path.length < 1 ||
            item.path.length > 64 ||
            item.path.some(
              segment =>
                typeof segment !== 'string' ||
                segment.length < 1 ||
                segment.length > 255 ||
                /[/\\\0]/.test(segment) ||
                segment === '.' ||
                segment === '..',
            )
          ) {
            throw Error(
              'path must contain 1–64 relative segments without slash, backslash, NUL, dot, or dot-dot',
            );
          }
          const startLine = boundedInteger(item.startLine, 1, 1_000_000);
          const lineCount = boundedInteger(item.lineCount, 80, 200);
          if (
            item.search !== undefined &&
            (typeof item.search !== 'string' ||
              item.search.length < 1 ||
              item.search.length > 256)
          ) {
            throw Error(
              'search must be a nonempty literal string of at most 256 characters',
            );
          }
          reading = true;
          const blob = await E(mount).lookup(harden(item.path));
          const { text, scanTruncated } = await readPrefix(blob);
          const sourceLines = text.split('\n');
          const lines = [];
          let characters = 0;
          let outputTruncated = false;
          for (
            let offset = startLine - 1;
            offset < sourceLines.length;
            offset += 1
          ) {
            const line = sourceLines[offset];
            if (item.search !== undefined && !line.includes(item.search))
              // eslint-disable-next-line no-continue
              continue;
            if (lines.length === lineCount || characters === MAX_CHARACTERS) {
              outputTruncated = true;
              break;
            }
            const rendered = line.slice(0, MAX_CHARACTERS - characters);
            characters += rendered.length;
            lines.push({ line: offset + 1, text: rendered });
            if (rendered.length < line.length) outputTruncated = true;
          }
          results.push(
            boundSourceResult(
              {
                index,
                ok: true,
                lines,
                scanTruncated,
                outputTruncated,
              },
              itemBudget,
            ),
          );
        } catch (error) {
          // No stack, locator, credentials, or arbitrary thrown object data.
          const message =
            !reading && error instanceof Error
              ? error.message
              : 'Could not read this source path. Verify the path and that the capability supports readable blob streaming.';
          results.push({ index, ok: false, error: message.slice(0, 512) });
        }
      }
      return JSON.stringify({ results });
    },
  });
};
harden(makeReadSourcesTool);
