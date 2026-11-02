// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import {
  encodeImageResult,
  imageDataUrl,
} from '@endo/hosted-agent/image-result.js';
import { toOpenAICompatibleMessages } from '../providers/openai-compatible-messages.js';

const image = harden({
  mimeType: /** @type {const} */ ('image/png'),
  data: 'iVBORw0KGgo=',
});

test('parallel tool outputs stay together before Chat Completions image messages', t => {
  const messages = toOpenAICompatibleMessages([
    {
      role: 'assistant',
      tool_calls: [
        { id: 'shot', function: { name: 'viewImage', arguments: '{}' } },
        { id: 'check', function: { name: 'exec', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'shot', content: encodeImageResult(image) },
    { role: 'tool', tool_call_id: 'check', content: 'no browser errors' },
    { role: 'assistant', content: 'verified' },
  ]);
  t.deepEqual(
    messages.map(m => m.role),
    ['assistant', 'tool', 'tool', 'user', 'assistant'],
  );
  t.deepEqual(messages[3].content, [
    { type: 'text', text: 'Image returned by tool call shot:' },
    { type: 'image_url', image_url: { url: imageDataUrl(image) } },
  ]);
  t.false(JSON.stringify(messages[1]).includes(image.data));
});

test('image at the end of context is delivered, user text is never decoded', t => {
  const content = encodeImageResult(image);
  t.deepEqual(toOpenAICompatibleMessages([{ role: 'user', content }]), [
    { role: 'user', content },
  ]);
  t.is(
    toOpenAICompatibleMessages([
      { role: 'tool', tool_call_id: 'shot', content },
    ]).at(-1)?.role,
    'user',
  );
});
