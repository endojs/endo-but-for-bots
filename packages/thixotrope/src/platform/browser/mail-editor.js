// @ts-check

/** @import { ValuePart, MailEditor, EditorSnapshot } from '../../web/mail-ui.js' */

/**
 * A plain-text editor with atomic inline reference pills. Only immutable
 * descriptions cross into the guest; DOM selection stays in this closure.
 * @returns {{editor: MailEditor, mount: (root: HTMLElement) => void}}
 */
export const makeMailEditor = () => {
  const surface = document.createElement('div');
  surface.className = 'inline-mail-editor';
  surface.contentEditable = 'true';
  surface.setAttribute('role', 'textbox');
  surface.setAttribute('aria-label', 'Message');
  surface.setAttribute('aria-multiline', 'true');
  const values = new Map();
  /** @type {((state: EditorSnapshot) => void) | undefined} */
  let listener;
  /** @type {Range | undefined} */
  let completion;
  let query = '';

  /** @param {Node} node @returns {(string | ValuePart)[]} */
  const read = node => {
    /** @type {(string | ValuePart)[]} */
    const parts = [''];
    /** @param {string} text */
    const appendText = text => {
      const last = parts[parts.length - 1];
      if (typeof last === 'string') parts[parts.length - 1] = last + text;
    };
    /** @param {Node} child */
    const visit = child => {
      if (child instanceof Element && child.hasAttribute('data-value-token')) {
        const value = values.get(child.getAttribute('data-value-token'));
        if (value) parts.push(value, '');
      } else if (child.nodeType === Node.TEXT_NODE) {
        appendText(child.textContent ?? '');
      } else if (child instanceof HTMLBRElement) {
        appendText('\n');
      } else {
        for (const next of child.childNodes) visit(next);
      }
    };
    visit(node);
    return parts;
  };
  const publish = () => {
    completion = undefined;
    query = '';
    const selection = document.getSelection();
    if (
      selection?.isCollapsed &&
      selection.rangeCount &&
      surface.contains(selection.anchorNode)
    ) {
      const caret = selection.getRangeAt(0);
      const prefix = caret.cloneRange();
      prefix.selectNodeContents(surface);
      prefix.setEnd(caret.endContainer, caret.endOffset);
      const parts = read(prefix.cloneContents());
      const last = parts[parts.length - 1];
      const match =
        typeof last === 'string' && /(?:^|\s)@([^@\n]*)$/.exec(last);
      if (match) {
        query = match[1];
        // Walk back from the caret across text nodes, retaining the actual
        // range so clicking a suggestion cannot lose the insertion point.
        const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
        let remaining = prefix.toString().length - query.length - 1;
        let node = walker.nextNode();
        while (node) {
          const length = node.textContent?.length ?? 0;
          if (remaining <= length) {
            completion = caret.cloneRange();
            completion.setStart(node, remaining);
            break;
          }
          remaining -= length;
          node = walker.nextNode();
        }
      }
    }
    listener?.(
      harden({ parts: read(surface), query: completion ? query : undefined }),
    );
  };

  surface.addEventListener('input', publish);
  surface.addEventListener('keyup', event => {
    if (event.key !== 'Escape') publish();
  });
  surface.addEventListener('mouseup', publish);
  surface.addEventListener('paste', event => {
    event.preventDefault();
    // Never import markup or arbitrary reference-looking elements from paste.
    document.execCommand(
      'insertText',
      false,
      event.clipboardData?.getData('text/plain') ?? '',
    );
    publish();
  });
  surface.addEventListener('drop', event => event.preventDefault());
  surface.addEventListener('keydown', event => {
    if (event.isComposing) {
      event.stopPropagation();
      return;
    }
    if (event.key === 'Escape') {
      completion = undefined;
      listener?.(harden({ parts: read(surface), query: undefined }));
    } else if (event.key === 'Enter') {
      // The confined UI handles Enter while completion is open. Otherwise
      // keep newlines as text instead of browser-dependent nested divs.
      if (!completion) {
        event.preventDefault();
        document.execCommand('insertText', false, '\n');
      }
    }
  });

  const editor = harden({
    /** @param {(state: EditorSnapshot) => void} next */
    subscribe: next => {
      listener = next;
      publish();
      return harden(() => {
        if (listener === next) listener = undefined;
      });
    },
    /** @param {ValuePart} value */
    insert: value => {
      if (!completion || surface.contentEditable !== 'true') return;
      const selection = document.getSelection();
      surface.focus();
      selection?.removeAllRanges();
      selection?.addRange(completion);
      values.set(value.token, harden({ name: value.name, token: value.token }));
      const pill = document.createElement('span');
      pill.className = 'shared-value known-value';
      pill.contentEditable = 'false';
      pill.setAttribute('data-value-token', value.token);
      pill.textContent = value.name;
      // HTML is produced exclusively from this element, with textContent
      // escaping the label. Native insertion preserves the browser undo stack.
      document.execCommand('insertHTML', false, `${pill.outerHTML} `);
      publish();
    },
    clear: () => {
      surface.replaceChildren();
      publish();
    },
  });
  return harden({
    editor,
    mount: root => {
      const slot = root.querySelector('.draft-editor');
      if (!slot) return;
      if (surface.parentNode !== slot) slot.append(surface);
      surface.contentEditable =
        slot.getAttribute('data-disabled') === 'true' ? 'false' : 'true';
    },
  });
};
harden(makeMailEditor);
