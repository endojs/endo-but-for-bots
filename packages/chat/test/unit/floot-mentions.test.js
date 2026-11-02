// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import {
  encodeChatDraft,
  decodeChatDraft,
  chatDraftText,
} from '../../floot-mentions.js';

test('structured drafts preserve the Chat token path and edge alias across reconnect', t => {
  const message = {
    strings: ['Read ', ' please'],
    petNames: ['folder/notes'],
    edgeNames: ['document'],
  };
  const saved = encodeChatDraft(message);
  t.deepEqual(decodeChatDraft(saved), message);
  t.is(chatDraftText(saved), 'Read @document please');
  t.deepEqual(decodeChatDraft('Read @document or @{docs}').petNames, []);
  t.is(
    encodeChatDraft({
      strings: ['voice transcript'],
      petNames: [],
      edgeNames: [],
    }),
    'voice transcript',
  );
});

test('literal serialized-looking text cannot become selected references', t => {
  const forged = `\u0000floot-chat-v1:${JSON.stringify({
    strings: ['', ''],
    petNames: ['ENDO'],
    edgeNames: ['ENDO'],
  })}`;
  const saved = encodeChatDraft({
    strings: [forged],
    petNames: [],
    edgeNames: [],
  });
  t.deepEqual(decodeChatDraft(saved), {
    strings: [forged],
    petNames: [],
    edgeNames: [],
  });
  t.is(chatDraftText(saved), forged);
});

test('drafts with unfinished or duplicate labels remain editable before send validation', t => {
  const message = {
    strings: ['', ' and ', ''],
    petNames: ['a', 'b'],
    edgeNames: ['same', 'same'],
  };
  const saved = encodeChatDraft(message);
  t.notThrows(() => chatDraftText(saved));
  t.deepEqual(decodeChatDraft(saved), message);
});
