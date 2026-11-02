// @ts-check
import { E } from '@endo/eventual-send';
import harden from '@endo/harden';
import { tokenAutocompleteComponent } from '@endo/spaces-util/token-autocomplete.js';
import { chatMessageText } from '@endo/floot/src/session-mentions.js';
import { unmount } from './setup-preact-container.js';

/** @import { ChatMessage } from '@endo/spaces-util/token-autocomplete.js' */
const PREFIX = '\u0000floot-chat-v1:';
/**
 * Internal draft encoding, never a user-facing mention syntax.
 * @param {ChatMessage} message
 */
export const encodeChatDraft = message =>
  message.petNames.length || message.strings.join('').startsWith(PREFIX)
    ? `${PREFIX}${JSON.stringify(message)}`
    : message.strings.join('');
harden(encodeChatDraft);
/** @param {string} draft @returns {ChatMessage} */
export const decodeChatDraft = draft => {
  if (!draft.startsWith(PREFIX))
    return { strings: [draft], petNames: [], edgeNames: [] };
  const message = JSON.parse(draft.slice(PREFIX.length));
  if (
    !Array.isArray(message.strings) ||
    !Array.isArray(message.edgeNames) ||
    message.strings.length !== message.edgeNames.length + 1 ||
    message.strings.some(part => typeof part !== 'string') ||
    message.edgeNames.some(name => typeof name !== 'string')
  )
    throw Error('Invalid saved chat message');
  if (
    !Array.isArray(message.petNames) ||
    message.petNames.length !== message.edgeNames.length ||
    message.petNames.some(name => typeof name !== 'string' || !name)
  )
    throw Error('Invalid saved chat references');
  return message;
};
harden(decodeChatDraft);
/** @param {string} draft */
export const chatDraftText = draft => {
  const message = decodeChatDraft(draft);
  return chatMessageText({
    strings: message.strings,
    names: message.edgeNames,
  });
};
harden(chatDraftText);

/**
 * Host-owned composer using the exact Chat token controller. Only selected
 * tokens become references; pasted @words and voice transcripts stay text.
 * @param {{document: Document, powers: any, onInput: (draft: string) => void, onSend: () => void}} options
 */
export const makeFlootComposer = ({ document, powers, onInput, onSend }) => {
  const node = document.createElement('div');
  node.className = 'floot-composer-editor';
  const input = document.createElement('div');
  input.className = 'floot-input';
  input.contentEditable = 'true';
  input.setAttribute('role', 'textbox');
  input.setAttribute('aria-label', 'Message Floot');
  input.setAttribute('aria-multiline', 'true');
  input.dataset.placeholder = 'Message Floot… Type @ to mention an object';
  const menu = document.createElement('div');
  menu.className = 'token-menu';
  node.append(input, menu);
  const names = [];
  const tokens = tokenAutocompleteComponent(input, menu, {
    E,
    powers,
    externalPetNames: names,
    // externalPetNames keeps stream ownership outside the shared picker.
    iterateReader: () => {
      throw Error('Unexpected inventory subscription');
    },
  });
  let disposed = false;
  let loading = false;
  let loaded = false;
  let current = '';
  const update = () => {
    if (input.contentEditable !== 'true') return;
    current = encodeChatDraft(tokens.getMessage());
    onInput(current);
    if (!loaded && !loading && (input.textContent || '').includes('@')) {
      loading = true;
      void (async () => {
        const found = await E(powers).list();
        if (disposed) return;
        names.length = 0;
        for (const name of found)
          if (typeof name === 'string') names.push(name);
        names.sort();
        loaded = true;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()
        .catch(error => {
          if (!disposed) {
            menu.textContent = `Cannot read inventory: ${error.message}`;
            menu.classList.add('visible');
          }
        })
        .finally(() => {
          loading = false;
        });
    }
  };
  input.addEventListener('input', update);
  input.addEventListener('focus', () => {
    loaded = false;
  });
  const insertText = text => {
    if (input.contentEditable !== 'true') return;
    input.focus();
    const selection = document.defaultView?.getSelection();
    if (
      !selection?.rangeCount ||
      !input.contains(selection.getRangeAt(0).commonAncestorContainer)
    )
      return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const inserted = document.createTextNode(text);
    range.insertNode(inserted);
    range.setStartAfter(inserted);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  input.addEventListener('paste', event => {
    event.preventDefault();
    insertText(event.clipboardData?.getData('text/plain') || '');
  });
  input.addEventListener('drop', event => {
    event.preventDefault();
    insertText(event.dataTransfer?.getData('text/plain') || '');
  });
  input.addEventListener('keydown', event => {
    if (
      event.isComposing ||
      event.defaultPrevented ||
      input.contentEditable !== 'true'
    )
      return;
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      insertText('\n');
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!tokens.isMenuVisible() && !loading) {
        update();
        onSend();
      }
    }
  });
  // DOM nodes must remain mutable; only the exported factory is hardened.
  return {
    node,
    read: () => encodeChatDraft(tokens.getMessage()),
    close: () => tokens.close?.(),
    sync(draft, disabled) {
      if (draft !== current) {
        tokens.setMessage?.(decodeChatDraft(draft));
        current = draft;
      }
      input.contentEditable = disabled ? 'false' : 'true';
      input.setAttribute('aria-disabled', `${!!disabled}`);
    },
    dispose() {
      disposed = true;
      tokens.dispose?.();
      names.length = 0;
      unmount(menu);
      node.remove();
    },
  };
};
harden(makeFlootComposer);
