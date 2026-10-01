// @ts-check

import '@endo/init/debug.js';

import test from 'ava';
import { assembleMentionSend } from '../../mention-send.js';

test('assembleMentionSend keeps a slash in each pet name as one segment', t => {
  const result = assembleMentionSend({
    channelPetName: 'feature/foo',
    recap: {
      strings: ['', ': hi'],
      edgeNames: ['alice'],
      petNames: ['team/alice'],
    },
    instructions: '!',
  });
  t.deepEqual(result.edgeNames, ['feature/foo', 'alice']);
  t.deepEqual(result.petNamePaths, [['feature/foo'], ['team/alice']]);
  t.deepEqual(result.strings, ['You were mentioned in ', ':\n\n', ': hi!']);
});

test('assembleMentionSend disambiguates a recap edge name equal to the channel', t => {
  const result = assembleMentionSend({
    channelPetName: 'general',
    recap: { strings: ['', ''], edgeNames: ['general'], petNames: ['bob'] },
    instructions: '',
  });
  t.deepEqual(result.edgeNames, ['general', 'general-author']);
  t.deepEqual(result.petNamePaths, [['general'], ['bob']]);
});

test('assembleMentionSend keeps three or more colliding edge names distinct', t => {
  const result = assembleMentionSend({
    channelPetName: 'general',
    recap: {
      strings: ['', '', '', '', ''],
      edgeNames: ['bob', 'bob', 'bob', 'general'],
      petNames: ['bob', 'bob-2', 'bob-3', 'carol'],
    },
    instructions: '',
  });
  t.deepEqual(result.edgeNames, [
    'general',
    'bob',
    'bob-author',
    'bob-author-2',
    'general-author',
  ]);
  t.is(new Set(result.edgeNames).size, result.edgeNames.length);
});

test('assembleMentionSend with no recap sends only the channel reference', t => {
  const result = assembleMentionSend({
    channelPetName: 'general',
    recap: { strings: [], edgeNames: [], petNames: [] },
    instructions: '[info]',
  });
  t.deepEqual(result, {
    strings: ['You were mentioned in ', '[info]'],
    edgeNames: ['general'],
    petNamePaths: [['general']],
  });
});
