// @ts-check
import test from 'ava';

import { linkify } from '../src/MessageList.js';

// A Preact anchor VNode produced by linkify for a matched URL.
const anchors = parts =>
  parts.filter(part => part && typeof part === 'object' && part.type === 'a');

test('plain text with no URL stays a single text node', t => {
  const parts = linkify('just some words');
  t.deepEqual(parts, ['just some words']);
  t.is(anchors(parts).length, 0);
});

test('an http(s) URL becomes a safe new-tab anchor', t => {
  const parts = linkify('see http://127.0.0.1:8080/abc/ for the site');
  const links = anchors(parts);
  t.is(links.length, 1);
  const [link] = links;
  t.is(link.props.href, 'http://127.0.0.1:8080/abc/');
  t.is(link.props.target, '_blank');
  t.is(link.props.rel, 'noopener noreferrer');
  t.is(link.props.children, 'http://127.0.0.1:8080/abc/');
  // Surrounding words remain text nodes.
  t.is(parts[0], 'see ');
  t.is(parts[parts.length - 1], ' for the site');
});

test('trailing sentence punctuation is not swallowed into the link', t => {
  const parts = linkify('open https://example.com/page.');
  const [link] = anchors(parts);
  t.is(link.props.href, 'https://example.com/page');
  t.is(parts[parts.length - 1], '.');
});

test('multiple URLs each linkify independently', t => {
  const parts = linkify('a https://one.example b https://two.example c');
  const links = anchors(parts);
  t.deepEqual(
    links.map(l => l.props.href),
    ['https://one.example', 'https://two.example'],
  );
});

test('a non-http scheme is left as text (no javascript: links)', t => {
  const parts = linkify('run javascript:alert(1) now');
  t.is(anchors(parts).length, 0);
});
