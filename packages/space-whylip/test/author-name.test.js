// @ts-check

import '@endo/init/debug.js';
import test from 'ava';

import { makeAuthorName } from '../src/author-name.js';

test('bounded author names incorporate the full node, formula, and role', t => {
  const node = 'a'.repeat(64);
  const formula = 'b'.repeat(64);
  const locator = `endo://${node}/${formula}?type=host`;
  const story = makeAuthorName(locator, 'story');
  t.regex(story, /^whylip-[0-9a-f]{56}$/);
  t.is(story.length, 63);
  t.not(story, makeAuthorName(locator, 'task-0'));
  t.not(
    story,
    makeAuthorName(`endo://${node.slice(0, -1)}c/${formula}`, 'story'),
  );
  t.not(
    story,
    makeAuthorName(`endo://${node}/${formula.slice(0, -1)}c`, 'story'),
  );
  t.is(
    story,
    makeAuthorName(
      `endo://${node}/${formula}@tcp%3Alocalhost%3A8080?type=host`,
      'story',
    ),
  );
});
