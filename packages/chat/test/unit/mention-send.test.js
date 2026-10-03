// @ts-check

import '@endo/init/debug.js';

import test from 'ava';
import {
  assembleMentionSend,
  mentionChannelEdgeName,
} from '../../mention-send.js';

test('assembleMentionSend splits each slash-joined mention token into a pet-name path', t => {
  const result = assembleMentionSend({
    channelPetName: 'feature/foo',
    recap: {
      strings: ['', ': hi'],
      edgeNames: ['alice'],
      petNames: ['team/alice'],
    },
    instructions: '!',
  });
  // An edge name may not contain `/`, so the channel is labeled by its leaf.
  t.deepEqual(result.edgeNames, ['foo', 'alice']);
  t.deepEqual(result.petNamePaths, [
    ['feature', 'foo'],
    ['team', 'alice'],
  ]);
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

test('assembleMentionSend labels a nested channel by its leaf and keeps edges unique', t => {
  const result = assembleMentionSend({
    channelPetName: 'feature/general',
    recap: {
      strings: ['', '', ''],
      edgeNames: ['general', 'alice'],
      petNames: ['bob', 'team/alice'],
    },
    instructions: '',
  });
  t.deepEqual(result.edgeNames, ['general', 'general-author', 'alice']);
  t.deepEqual(result.petNamePaths, [
    ['feature', 'general'],
    ['bob'],
    ['team', 'alice'],
  ]);
  // The daemon's `send` refuses an edge name containing `/`.
  for (const edgeName of result.edgeNames) {
    t.false(edgeName.includes('/'), edgeName);
  }
});

test('mentionChannelEdgeName is the leaf of a slash-joined token', t => {
  t.is(mentionChannelEdgeName('feature/foo'), 'foo');
  t.is(mentionChannelEdgeName('general'), 'general');
});
