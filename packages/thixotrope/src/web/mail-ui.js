// @ts-check
/** @import { CompartmentEndowments } from '@endo/preact-container/compartment' */

/** @typedef {{name: string, token: string, localName?: string}} ValuePart */
/** @typedef {{id: string, content: readonly (string | ValuePart)[], from?: string, to?: string, status?: string, error?: string}} Message */
/** @typedef {{name: string, status: string}} Contact */
/** @typedef {{workspace: string, inbox: Message[], outbox: Message[], contacts: Contact[], attachments: string[], inventory: [string, string][]}} MailSnapshot */
/** @typedef {{snapshot: () => Promise<MailSnapshot>, adopt: (token: string, name: string) => Promise<string>, send: (name: string, text: string, attachment: string) => Promise<string>}} MailUiApi */

/**
 * Evaluated in a fresh SES compartment. Its only powers are the renderer's
 * hooks and the mail and adoption operations the host passes as props.
 * @param {CompartmentEndowments} tools
 * @param {{api: MailUiApi}} props
 */
export const MailUi = ({ h, useState, useEffect, useRef }, { api }) => {
  const [data, setData] = useState(
    /** @type {MailSnapshot | undefined} */ (undefined),
  );
  const [folder, setFolder] = useState('inbox');
  const [selected, setSelected] = useState('');
  const [composing, setComposing] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [attachment, setAttachment] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [adopting, setAdopting] = useState(
    /** @type {ValuePart | undefined} */ (undefined),
  );
  const [localName, setLocalName] = useState('');
  const [adoptError, setAdoptError] = useState('');
  const [adoptBusy, setAdoptBusy] = useState(false);
  const adoptPending = useRef(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      setData(await api.snapshot());
    } catch (reason) {
      setError(/** @type {Error} */ (reason).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let active = true;
    api.snapshot().then(
      value => {
        if (active) setData(value);
      },
      reason => {
        if (active) setError(reason.message);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  /** @param {{preventDefault: () => void}} event */
  const send = async event => {
    event.preventDefault();
    if (sending.current || busy || !recipient || !text.trim()) return;
    sending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.send(recipient, text, attachment);
      setText('');
      setComposing(false);
      setFolder('outbox');
      setSelected('');
      setNotice('Message queued. Refresh Sent to check delivery.');
    } catch (reason) {
      setError(
        `${/** @type {Error} */ (reason).message} Check Sent before sending again.`,
      );
    } finally {
      setBusy(false);
    }
    sending.current = false;
    // Refresh failure must not turn an accepted send into a retryable draft.
    try {
      setData(await api.snapshot());
    } catch (_reason) {
      /* Manual refresh remains available. */
    }
  };
  /** @param {ValuePart} part */
  const showAdoption = part => {
    setAdopting(part);
    setLocalName(part.name);
    setAdoptError('');
  };
  const closeAdoption = () => {
    if (!adoptPending.current) setAdopting(undefined);
  };
  /** @param {{preventDefault: () => void}} event */
  const adopt = async event => {
    event.preventDefault();
    if (!adopting || adoptPending.current || !localName.trim()) return;
    adoptPending.current = true;
    setAdoptBusy(true);
    setAdoptError('');
    try {
      const name = await api.adopt(adopting.token, localName);
      setAdopting(undefined);
      setNotice(`Adopted as ${name}.`);
      try {
        setData(await api.snapshot());
      } catch (_reason) {
        setError('The value was adopted. Refresh to update the inventory.');
      }
    } catch (reason) {
      setAdoptError(/** @type {Error} */ (reason).message);
    } finally {
      adoptPending.current = false;
      setAdoptBusy(false);
    }
  };
  const messages = data ? (folder === 'inbox' ? data.inbox : data.outbox) : [];
  const message = messages.find(item => item.id === selected);
  const contacts =
    data?.contacts.filter(contact => contact.status === 'ready') ?? [];
  /** @param {string} next */
  const openFolder = next => {
    setFolder(next);
    setSelected('');
    setComposing(false);
  };
  return h(
    'main',
    { class: 'mail' },
    h(
      'aside',
      { class: 'inventory', 'aria-label': 'Inventory' },
      h('p', { class: 'eyebrow' }, 'YOUR WORKSPACE'),
      h('h2', null, 'Inventory'),
      h('p', { class: 'hint' }, 'The names you know.'),
      ...(data?.inventory ?? []).map(([name, summary]) =>
        h(
          'div',
          { key: name, class: 'inventory-entry' },
          h('strong', null, name),
          h('span', { class: 'hint' }, summary),
        ),
      ),
      data &&
        !data.inventory.length &&
        h('p', { class: 'hint' }, 'Your inventory is empty.'),
    ),
    h(
      'div',
      { class: 'mail-area' },
      h(
        'div',
        {
          class: 'mail-content',
          'aria-hidden': adopting ? 'true' : undefined,
        },
        h(
          'header',
          { class: 'masthead' },
          h(
            'div',
            null,
            h('p', { class: 'eyebrow' }, 'THIXOTROPE'),
            h('h1', null, 'Mail'),
          ),
          h(
            'div',
            { class: 'header-actions' },
            h('span', { class: 'workspace' }, data?.workspace ?? 'Connecting…'),
            h(
              'button',
              { type: 'button', onClick: refresh, disabled: busy },
              'Refresh',
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'primary',
                disabled: busy,
                onClick: () => {
                  setComposing(true);
                  setNotice('');
                },
              },
              'Compose',
            ),
          ),
        ),
        h(
          'div',
          { role: 'status', 'aria-live': 'polite', class: 'notice' },
          notice,
        ),
        error && h('p', { role: 'alert', class: 'error' }, error),
        h(
          'div',
          { class: 'layout' },
          h(
            'nav',
            { 'aria-label': 'Mail folders' },
            ...[
              ['inbox', 'Inbox', data?.inbox.length ?? 0],
              ['outbox', 'Sent', data?.outbox.length ?? 0],
            ].map(([key, label, count]) =>
              h(
                'button',
                {
                  type: 'button',
                  class:
                    folder === key && !composing ? 'folder active' : 'folder',
                  'aria-pressed': folder === key && !composing,
                  onClick: () => openFolder(String(key)),
                },
                label,
                h('span', null, count),
              ),
            ),
          ),
          composing
            ? h(
                'section',
                { class: 'compose', 'aria-label': 'Compose message' },
                h('h2', null, 'New message'),
                h(
                  'form',
                  { onSubmit: send },
                  h(
                    'label',
                    null,
                    'To',
                    h(
                      'select',
                      {
                        required: true,
                        value: recipient,
                        disabled: busy,
                        onChange: event => setRecipient(event.target.value),
                      },
                      h('option', { value: '' }, 'Choose a contact'),
                      ...contacts.map(contact =>
                        h(
                          'option',
                          { key: contact.name, value: contact.name },
                          contact.name,
                        ),
                      ),
                    ),
                  ),
                  !contacts.length &&
                    h(
                      'p',
                      { class: 'hint' },
                      'No ready contacts. Introduce a correspondent with thix invite / accept, then refresh.',
                    ),
                  h(
                    'label',
                    null,
                    'Value (optional)',
                    h(
                      'select',
                      {
                        value: attachment,
                        disabled: busy,
                        onChange: event => setAttachment(event.target.value),
                      },
                      h('option', { value: '' }, 'Text only'),
                      ...(data?.attachments ?? []).map(name =>
                        h('option', { key: name, value: name }, name),
                      ),
                    ),
                  ),
                  h(
                    'p',
                    { class: 'hint' },
                    'Send text on its own, or include a value you have explicitly granted.',
                  ),
                  h(
                    'label',
                    null,
                    'Message',
                    h('textarea', {
                      required: true,
                      maxLength: 4096,
                      rows: 10,
                      value: text,
                      disabled: busy,
                      placeholder: 'Write a message…',
                      onInput: event => setText(event.target.value),
                    }),
                  ),
                  h(
                    'div',
                    { class: 'compose-footer' },
                    h('span', { class: 'hint' }, `${text.length} / 4096`),
                    h(
                      'button',
                      {
                        type: 'button',
                        disabled: busy,
                        onClick: () => setComposing(false),
                      },
                      'Cancel',
                    ),
                    h(
                      'button',
                      {
                        type: 'submit',
                        class: 'primary',
                        disabled: busy || !recipient || !text.trim(),
                      },
                      busy ? 'Sending…' : 'Send message',
                    ),
                  ),
                ),
              )
            : h(
                'section',
                {
                  class: 'messages',
                  'aria-label': folder === 'inbox' ? 'Inbox' : 'Sent messages',
                },
                h(
                  'div',
                  { class: 'message-list' },
                  !messages.length &&
                    h(
                      'p',
                      { class: 'empty' },
                      data
                        ? folder === 'inbox'
                          ? 'Your inbox is empty.'
                          : 'No sent messages yet.'
                        : 'Loading mail…',
                    ),
                  ...[...messages].reverse().map(item =>
                    h(
                      'button',
                      {
                        type: 'button',
                        key: item.id,
                        class:
                          item.id === selected
                            ? 'message-row selected'
                            : 'message-row',
                        onClick: () => setSelected(item.id),
                      },
                      h('strong', null, item.from ?? item.to),
                      h(
                        'span',
                        { class: 'preview' },
                        item.content
                          .map(part =>
                            typeof part === 'string'
                              ? part
                              : `[${part.localName ?? part.name}]`,
                          )
                          .join(''),
                      ),
                      item.status && h('small', null, item.status),
                    ),
                  ),
                ),
                h(
                  'article',
                  { class: 'reader', 'aria-label': 'Message' },
                  message
                    ? [
                        h(
                          'p',
                          { class: 'eyebrow' },
                          folder === 'inbox' ? 'FROM' : 'TO',
                        ),
                        h('h2', null, message.from ?? message.to),
                        message.status &&
                          h('p', { class: 'hint' }, message.status),
                        h(
                          'div',
                          { class: 'message-body' },
                          ...message.content.map((part, index) =>
                            typeof part === 'string'
                              ? h('span', { key: index }, part)
                              : part.localName !== undefined
                                ? h(
                                    'span',
                                    {
                                      key: index,
                                      class: 'shared-value known-value',
                                      title: 'In your inventory',
                                    },
                                    part.localName,
                                  )
                                : h(
                                    'button',
                                    {
                                      key: index,
                                      type: 'button',
                                      class: 'shared-value unknown-value',
                                      title:
                                        'Unknown value — adopt into your inventory',
                                      'aria-label': `Adopt ${part.name}`,
                                      onClick: () => showAdoption(part),
                                    },
                                    h(
                                      'span',
                                      {
                                        class: 'unknown-marker',
                                        'aria-hidden': 'true',
                                      },
                                      '?',
                                    ),
                                    part.name,
                                  ),
                          ),
                        ),
                        message.error &&
                          h('p', { class: 'error' }, message.error),
                      ]
                    : h('p', { class: 'empty' }, 'Select a message to read.'),
                ),
              ),
        ),
      ),
      adopting &&
        h(
          'div',
          {
            class: 'adoption-shade',
            onKeyDown: event => {
              if (event.key === 'Escape') closeAdoption();
            },
          },
          h(
            'section',
            {
              class: 'adoption-modal',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-labelledby': 'adoption-title',
            },
            h('p', { class: 'eyebrow' }, 'UNKNOWN VALUE'),
            h('h2', { id: 'adoption-title' }, 'Adopt a value'),
            h(
              'p',
              { class: 'hint' },
              `The sender calls this “${adopting.name}”. Choose your own name to keep it in your inventory.`,
            ),
            h(
              'form',
              { onSubmit: adopt },
              h(
                'label',
                null,
                'Your name',
                h('input', {
                  autoFocus: true,
                  required: true,
                  maxLength: 128,
                  value: localName,
                  disabled: adoptBusy,
                  onInput: event => setLocalName(event.currentTarget.value),
                }),
              ),
              adoptError &&
                h('p', { class: 'error', role: 'alert' }, adoptError),
              h(
                'div',
                { class: 'compose-footer' },
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: adoptBusy,
                    onClick: closeAdoption,
                  },
                  'Cancel',
                ),
                h(
                  'button',
                  {
                    type: 'submit',
                    class: 'primary',
                    disabled: adoptBusy || !localName.trim(),
                  },
                  adoptBusy ? 'Adopting…' : 'Adopt value',
                ),
              ),
            ),
          ),
        ),
    ),
  );
};
harden(MailUi);
