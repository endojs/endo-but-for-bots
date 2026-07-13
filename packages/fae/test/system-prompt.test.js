// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import {
  guestSystemPrompt,
  guestSystemPromptSections,
  makeGuestSystemPrompt,
} from '../src/system-prompt.js';

test('guest system prompt is assembled from named sections', t => {
  t.true(guestSystemPrompt.startsWith(guestSystemPromptSections.identity));
  t.true(
    guestSystemPrompt.includes(guestSystemPromptSections.namingConventions),
  );
  t.true(guestSystemPrompt.includes(guestSystemPromptSections.tools));
  t.true(
    guestSystemPrompt.endsWith(guestSystemPromptSections.responseGuidelines),
  );
});

test('guest system prompt keeps adoption and reply instructions explicit', t => {
  t.true(guestSystemPromptSections.adoption.includes('adoptTool'));
  t.true(guestSystemPromptSections.responseGuidelines.includes('reply'));
});

test('guest system prompt teaches petname and tool naming boundary', t => {
  t.true(
    guestSystemPromptSections.namingConventions.includes('timestamp-tool'),
  );
  t.true(guestSystemPromptSections.namingConventions.includes('timestampTool'));
  t.true(
    guestSystemPromptSections.adoption.includes('camelCase function name'),
  );
});

test('guest system prompt can replace one section for optimizer trials', t => {
  const prompt = makeGuestSystemPrompt({ adoption: '## Replacement' });
  t.true(prompt.includes('## Replacement'));
  t.false(prompt.includes(guestSystemPromptSections.adoption));
  t.true(prompt.includes(guestSystemPromptSections.tools));
});
