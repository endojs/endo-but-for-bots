// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import {
  encodeImageResult,
  decodeImageResult,
  imageResultText,
  imageResultFromBlocks,
  anthropicToolContent,
  responsesToolOutput,
  MAX_IMAGE_BYTES,
} from '../src/image-result.js';
import {
  responsesApiItems,
  readResponsesApiItems,
} from '../src/transcript-records.js';
import { makeMcpBridge } from '../src/mcp-bridge.js';

const image = harden({
  mimeType: /** @type {const} */ ('image/png'),
  data: 'iVBORw0KGgo=',
});
const encoded = encodeImageResult(image);

test('versioned image result survives text journals and renders without base64', t => {
  t.deepEqual(decodeImageResult(JSON.parse(JSON.stringify(encoded))), image);
  t.is(decodeImageResult('ordinary text'), undefined);
  t.false(imageResultText(encoded).includes(image.data));
  t.deepEqual(
    decodeImageResult(imageResultFromBlocks(anthropicToolContent(encoded))),
    image,
  );
  t.deepEqual(
    decodeImageResult(imageResultFromBlocks(responsesToolOutput(encoded))),
    image,
  );
  t.is(
    imageResultFromBlocks([
      { type: 'text', text: 'before' },
      { type: 'image', ...image },
    ]),
    undefined,
  );
});

test('malformed and oversized image envelopes fail explicitly', t => {
  for (const data of [
    '',
    'A===',
    'AAAA\n',
    'https://example.com',
    'A'.repeat(4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 4),
  ]) {
    t.throws(() => encodeImageResult({ ...image, data }));
  }
  t.throws(() => decodeImageResult('\u001eendo-image-v1\n{}'));
  const large = encodeImageResult({ ...image, data: 'AAAA'.repeat(100_000) });
  t.deepEqual(decodeImageResult(large)?.data.length, 400_000);
});

test('unsupported native images retain an explicit omission receipt without poisoning replay', t => {
  const oversized = 'AAAA'.repeat(Math.ceil(MAX_IMAGE_BYTES / 3) + 1);
  for (const block of [
    { type: 'image', mimeType: 'image/gif', data: 'R0lGODlh' },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: oversized },
    },
    { type: 'image', mimeType: 'image/png', data: 'not base64' },
    { type: 'inputImage', imageUrl: 'data:image/gif;base64,R0lGODlh' },
    { type: 'input_image', image_url: 'https://example.com/image.png' },
  ]) {
    const receipt = imageResultFromBlocks([block]) ?? '';
    t.regex(receipt, /Native image omitted from portable transcript/);
    t.regex(receipt, /pixels are unavailable in this replay/);
    t.is(decodeImageResult(receipt), undefined);
    t.is(responsesToolOutput(receipt), receipt);
    t.is(anthropicToolContent(receipt), receipt);
  }
  t.deepEqual(
    decodeImageResult(imageResultFromBlocks(anthropicToolContent(encoded))),
    image,
  );
});

test('only explicitly truncated journal previews may render without decoding', t => {
  const preview = encoded.slice(0, -4);
  t.throws(() => imageResultText(preview));
  t.is(
    imageResultText(preview, { truncated: true }),
    '[Image result; bytes retained for model input]',
  );
  t.is(
    imageResultText('ordinary preview', { truncated: true }),
    'ordinary preview',
  );
  t.throws(() => anthropicToolContent(preview));
  t.throws(() => responsesToolOutput(preview));
});

test('Responses replay preserves image output tied to its tool call', t => {
  const records = harden([
    {
      kind: /** @type {const} */ ('tool-call'),
      id: 'shot',
      name: 'viewImage',
      args: '{}',
    },
    {
      kind: /** @type {const} */ ('tool-result'),
      id: 'shot',
      content: encoded,
    },
  ]);
  const items = responsesApiItems(records);
  t.deepEqual(items[1].output, responsesToolOutput(encoded));
  t.deepEqual(readResponsesApiItems(items), records);
});

test('MCP delivers images as image blocks, not truncated text', async t => {
  const bridge = makeMcpBridge({
    tools: { dynamicTools: [{ name: 'viewImage' }] },
    execute: async () => encoded,
  });
  const response = /** @type {any} */ (
    await bridge.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'viewImage', arguments: {} },
    })
  );
  t.deepEqual(response.result.content, [{ type: 'image', ...image }]);
  t.is(bridge.pendingCalls(), 0);
});
