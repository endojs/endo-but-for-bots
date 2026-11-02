// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { Far } from '@endo/far';
import {
  makeFlootComposer,
  encodeChatDraft,
  decodeChatDraft,
} from '../../floot-mentions.js';
import { createDOM, tick } from '../helpers/dom-setup.js';

const dom = createDOM();

test.serial(
  'shared Chat composer restores chips, ignores IME, sends once, and disables input',
  async t => {
    t.timeout(5000);
    const edits = [];
    let sends = 0;
    const composer = makeFlootComposer({
      document: /** @type {any} */ (dom.document),
      powers: Far('Inventory', { list: () => harden(['docs']) }),
      onInput: d => edits.push(d),
      onSend: () => {
        sends += 1;
      },
    });
    dom.document.body.appendChild(/** @type {any} */ (composer.node));
    t.teardown(() => composer.dispose());
    const message = {
      strings: ['Read ', ''],
      petNames: ['folder/notes'],
      edgeNames: ['document'],
    };
    composer.sync(encodeChatDraft(message), false);
    const input = composer.node.querySelector('.floot-input');
    if (!input) throw Error('No input');
    t.is(
      input.querySelector('.chat-token')?.getAttribute('data-pet-name'),
      'folder/notes',
    );
    const enter = options =>
      input.dispatchEvent(
        /** @type {any} */ (
          new dom.window.KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
            ...options,
          })
        ),
      );
    enter({ isComposing: true });
    enter({ shiftKey: true });
    t.is(sends, 0);
    enter({});
    t.is(sends, 1);
    composer.sync('', true);
    enter({});
    t.is(sends, 1);
    composer.sync('', false);
    input.textContent = '@docs';
    input.dispatchEvent(
      /** @type {any} */ (new dom.window.Event('input', { bubbles: true })),
    );
    await tick();
    t.deepEqual(
      decodeChatDraft(edits.at(-1)).petNames,
      [],
      'typing a name is not attaching',
    );
  },
);

test.serial(
  'rich paste and drop insert only literal multiline text',
  async t => {
    t.timeout(5000);
    const edits = [];
    const composer = makeFlootComposer({
      document: /** @type {any} */ (dom.document),
      powers: Far('Inventory', { list: () => harden([]) }),
      onInput: d => edits.push(d),
      onSend: () => {},
    });
    dom.document.body.appendChild(/** @type {any} */ (composer.node));
    t.teardown(() => composer.dispose());
    composer.sync('', false);
    const input = /** @type {HTMLElement} */ (
      composer.node.querySelector('.floot-input')
    );
    input.focus();
    const range = dom.document.createRange();
    range.selectNodeContents(/** @type {any} */ (input));
    range.collapse(false);
    dom.window.getSelection().removeAllRanges();
    dom.window.getSelection().addRange(range);
    const html =
      '<span class="chat-token" data-pet-name="ENDO" data-edge-name="admin">ENDO</span>';
    for (const type of ['paste', 'drop']) {
      const event = new dom.window.Event(type, {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(
        event,
        type === 'paste' ? 'clipboardData' : 'dataTransfer',
        {
          value: {
            getData: format =>
              format === 'text/plain' ? 'first\nsecond' : html,
          },
        },
      );
      input.dispatchEvent(/** @type {any} */ (event));
      t.true(event.defaultPrevented);
      t.is(input.querySelectorAll('.chat-token').length, 0);
    }
    const parsed = decodeChatDraft(edits.at(-1));
    t.deepEqual(parsed.petNames, []);
    t.is(parsed.strings[0], 'first\nsecondfirst\nsecond');
  },
);

test.serial(
  'Backspace removal updates the saved draft and releases the document listener on disposal',
  async t => {
    t.timeout(5000);
    const edits = [];
    const added = new Set();
    const add = dom.document.addEventListener;
    const remove = dom.document.removeEventListener;
    dom.document.addEventListener = function (type, listener, options) {
      if (type === 'click') added.add(listener);
      return add.call(this, type, listener, options);
    };
    dom.document.removeEventListener = function (type, listener) {
      if (type === 'click') added.delete(listener);
      return remove.call(this, type, listener);
    };
    t.teardown(() => {
      dom.document.addEventListener = add;
      dom.document.removeEventListener = remove;
    });
    const composer = makeFlootComposer({
      document: /** @type {any} */ (dom.document),
      powers: Far('Inventory', { list: () => harden([]) }),
      onInput: value => edits.push(value),
      onSend: () => {},
    });
    dom.document.body.appendChild(/** @type {any} */ (composer.node));
    t.teardown(() => composer.dispose());
    const input = /** @type {HTMLElement} */ (
      composer.node.querySelector('.floot-input')
    );
    for (const boundary of ['text', 'element']) {
      composer.sync(
        encodeChatDraft({
          strings: ['Read ', ' after'],
          petNames: ['docs'],
          edgeNames: ['docs'],
        }),
        false,
      );
      input.focus();
      const range = dom.document.createRange();
      if (boundary === 'text')
        range.setStart(/** @type {any} */ (input.lastChild), 0);
      else range.setStart(/** @type {any} */ (input), 2);
      range.collapse(true);
      dom.window.getSelection().removeAllRanges();
      dom.window.getSelection().addRange(range);
      input.dispatchEvent(
        /** @type {any} */ (
          new dom.window.KeyboardEvent('keydown', {
            key: 'Backspace',
            bubbles: true,
            cancelable: true,
          })
        ),
      );
      t.is(input.querySelectorAll('.chat-token').length, 0);
      t.deepEqual(decodeChatDraft(edits.at(-1)).petNames, []);
    }
    t.true(added.size > 0);
    composer.dispose();
    t.is(added.size, 0);
  },
);
