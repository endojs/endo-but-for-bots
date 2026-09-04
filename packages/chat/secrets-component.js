// @ts-check

import { encodeBase64 } from '@endo/base64';
import { E } from '@endo/eventual-send';

import { h, renderConfined, unmount } from './setup-preact-container.js';

/** @import { SecretAdmin, SecretAuditEvent, SecretSummary } from '@endo/daemon' */

// Encoded with the same module the daemon canonicalizes against in
// `decodeSecret`, rather than a hand-rolled `btoa` over a writable global: the
// two sides of this wire format have to agree exactly or a well-formed secret
// is rejected as INVALID_SECRET_BYTES.
/** @param {string} text */
const textToBase64 = text => encodeBase64(new TextEncoder().encode(text));
harden(textToBase64);

/**
 * @typedef {object} SecretRow
 * @property {string} secretId
 * @property {SecretSummary} summary
 * @property {string[][]} petNamePaths
 * @property {string} descriptionDraft
 * @property {string} replacementDraft
 */

/**
 * Pure confined view. It receives summaries and opaque callbacks only; admin
 * capabilities remain in the host-side controller below.
 *
 * @param {object} props
 * @param {SecretRow[]} props.rows
 * @param {SecretAuditEvent[]} props.events
 * @param {boolean} props.loading
 * @param {string | null} props.error
 * @param {'cleared' | 'failed' | null} props.clipboardStatus
 * @param {{ name: string, description: string, value: string }} props.createDraft
 * @param {{ name: string, byteLength: number } | null} props.createFile
 *   Metadata only. The confined view is never given the file's bytes.
 * @param {(field: 'name' | 'description' | 'value', value: string) => void} props.onCreateInput
 * @param {() => void} props.onReadFile
 * @param {() => void} props.onClearFile
 * @param {(open: boolean) => void} props.onCreateToggle
 * @param {() => void} props.onCreate
 * @param {(secretId: string, description: string) => void} props.onDescriptionInput
 * @param {(secretId: string) => void} props.onDescription
 * @param {(secretId: string, value: string) => void} props.onReplaceInput
 * @param {(secretId: string, open: boolean) => void} props.onDangerToggle
 * @param {(secretId: string) => void} props.onReplace
 * @param {(secretId: string) => void} props.onRevoke
 * @param {(secretId: string) => void} props.onDelete
 * @param {() => void} props.onClearClipboard
 * @param {() => void} props.onRefresh
 */
const SecretsView = ({
  rows,
  events,
  loading,
  error,
  clipboardStatus,
  createDraft,
  createFile,
  onCreateInput,
  onReadFile,
  onClearFile,
  onCreateToggle,
  onCreate,
  onDescriptionInput,
  onDescription,
  onReplaceInput,
  onDangerToggle,
  onReplace,
  onRevoke,
  onDelete,
  onClearClipboard,
  onRefresh,
}) =>
  h(
    'main',
    { class: 'secrets-space' },
    h(
      'header',
      { class: 'secrets-header' },
      h(
        'div',
        null,
        h('h1', null, 'Secret blobs'),
        h(
          'p',
          null,
          'Manage opaque bytes and delegate their inventory capabilities. Stored values are never revealed.',
        ),
      ),
      h(
        'div',
        { class: 'secrets-header-actions' },
        h(
          'button',
          { type: 'button', onClick: onClearClipboard },
          'Clear clipboard',
        ),
        h(
          'button',
          { type: 'button', disabled: loading, onClick: onRefresh },
          'Refresh',
        ),
      ),
    ),
    clipboardStatus === 'cleared'
      ? h(
          'p',
          { class: 'secrets-clipboard-status', role: 'status' },
          'Clipboard overwritten with an empty string. Clipboard history may retain prior entries.',
        )
      : null,
    clipboardStatus === 'failed'
      ? h(
          'p',
          { class: 'secrets-error', role: 'alert' },
          'Could not clear the clipboard.',
        )
      : null,
    error ? h('div', { class: 'secrets-error', role: 'alert' }, error) : null,
    h(
      'details',
      {
        class: 'secret-create-panel',
        /** @param {{ currentTarget: { open: boolean } }} event */
        onToggle: event => {
          onCreateToggle(event.currentTarget.open);
        },
      },
      h('summary', null, 'Add a secret'),
      h(
        'form',
        {
          class: 'secret-create-form',
          autocomplete: 'off',
          /** @param {{ preventDefault: () => void }} event */
          onSubmit: event => {
            event.preventDefault();
            onCreate();
          },
        },
        h(
          'label',
          null,
          'Inventory name',
          h('input', {
            name: 'name',
            required: true,
            autocomplete: 'off',
            placeholder: 'github-release',
            value: createDraft.name,
            /** @param {{ target: { value: string } }} event */
            onInput: event => onCreateInput('name', event.target.value),
          }),
        ),
        h(
          'label',
          null,
          'Description (not secret)',
          h('input', {
            name: 'description',
            required: true,
            maxlength: 200,
            autocomplete: 'off',
            value: createDraft.description,
            /** @param {{ target: { value: string } }} event */
            onInput: event => onCreateInput('description', event.target.value),
          }),
        ),
        h(
          'label',
          null,
          'Secret value (UTF-8)',
          h('input', {
            type: 'password',
            name: 'value',
            // A chosen file supplies the bytes instead, so the typed field is
            // neither required nor editable while one is loaded.
            required: createFile === null,
            disabled: loading || createFile !== null,
            autocomplete: 'off',
            autocapitalize: 'off',
            'data-1p-ignore': 'true',
            'data-lpignore': 'true',
            spellcheck: false,
            value: createDraft.value,
            /** @param {{ target: { value: string } }} event */
            onInput: event => onCreateInput('value', event.target.value),
          }),
        ),
        h(
          'div',
          { class: 'secret-file-ingress' },
          h(
            'button',
            {
              type: 'button',
              disabled: loading,
              onClick: () => onReadFile(),
            },
            'Read from file…',
          ),
          createFile === null
            ? h(
                'span',
                { class: 'secret-file-status secret-file-empty' },
                'No file chosen. A file is sent byte for byte, so binary keys stay intact.',
              )
            : h(
                'span',
                { class: 'secret-file-status' },
                `${createFile.name} — ${createFile.byteLength} bytes`,
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: loading,
                    onClick: () => onClearFile(),
                  },
                  'Clear file',
                ),
              ),
        ),
        h('button', { type: 'submit', disabled: loading }, 'Store secret'),
      ),
    ),
    h(
      'section',
      { class: 'secret-catalog' },
      h('h2', null, 'Catalog'),
      loading && rows.length === 0 ? h('p', null, 'Loading…') : null,
      rows.length === 0 && !loading ? h('p', null, 'No secrets yet.') : null,
      ...rows.map(
        ({
          secretId,
          summary,
          petNamePaths,
          descriptionDraft,
          replacementDraft,
        }) =>
          h(
            'article',
            { class: `secret-card secret-${summary.state}`, key: secretId },
            h(
              'div',
              { class: 'secret-summary' },
              h(
                'code',
                // Only the prefix is rendered, and no `title` carries the
                // whole identifier: the design calls for a stable prefix, and
                // the full value is a durable record selector that has no
                // business sitting in the DOM.
                { class: 'secret-id' },
                secretId.slice(0, 12),
              ),
              h('span', { class: 'secret-state' }, summary.state),
              h('span', null, `generation ${summary.generation}`),
            ),
            h(
              'div',
              { class: 'secret-pet-names' },
              h('span', null, 'Inventory paths'),
              petNamePaths.length === 0
                ? h('span', { class: 'secret-path-missing' }, 'No known paths')
                : h(
                    'ul',
                    null,
                    ...petNamePaths.map(path =>
                      h(
                        'li',
                        { key: path.join('/') },
                        h('code', null, path.join('/')),
                      ),
                    ),
                  ),
            ),
            h(
              'form',
              {
                autocomplete: 'off',
                /** @param {{ preventDefault: () => void }} event */
                onSubmit: event => {
                  event.preventDefault();
                  onDescription(secretId);
                },
              },
              h('input', {
                'aria-label': 'Description (not secret)',
                name: 'description',
                value: descriptionDraft,
                maxlength: 200,
                disabled: loading || summary.state === 'revoked',
                /** @param {{ target: { value: string } }} event */
                onInput: event =>
                  onDescriptionInput(secretId, event.target.value),
              }),
              h(
                'button',
                {
                  type: 'submit',
                  disabled: loading || summary.state === 'revoked',
                },
                'Update description',
              ),
            ),
            h(
              'details',
              {
                class: 'secret-danger',
                /** @param {{ currentTarget: { open: boolean } }} event */
                onToggle: event =>
                  onDangerToggle(secretId, event.currentTarget.open),
              },
              h('summary', null, 'Danger zone'),
              summary.state === 'revoked'
                ? h(
                    'section',
                    { class: 'secret-danger-section secret-delete-section' },
                    h('h3', null, 'Delete record'),
                    h(
                      'p',
                      null,
                      'Remove this revoked record and its known inventory paths. Audit history remains.',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        class: 'secret-delete',
                        disabled: loading,
                        onClick: () => onDelete(secretId),
                      },
                      'Delete revoked secret',
                    ),
                  )
                : h(
                    'div',
                    { class: 'secret-danger-sections' },
                    h(
                      'section',
                      { class: 'secret-danger-section secret-replace-section' },
                      h('h3', null, 'Replace value'),
                      h(
                        'p',
                        null,
                        'Replacement changes the value returned to every holder of this secret capability.',
                      ),
                      h(
                        'form',
                        {
                          class: 'secret-replace-form',
                          autocomplete: 'off',
                          /** @param {{ preventDefault: () => void }} event */
                          onSubmit: event => {
                            event.preventDefault();
                            onReplace(secretId);
                          },
                        },
                        h(
                          'label',
                          null,
                          'Replacement secret value (UTF-8)',
                          h('input', {
                            type: 'password',
                            name: 'value',
                            required: true,
                            autocomplete: 'off',
                            autocapitalize: 'off',
                            'data-1p-ignore': 'true',
                            'data-lpignore': 'true',
                            spellcheck: false,
                            disabled: loading,
                            value: replacementDraft,
                            /** @param {{ target: { value: string } }} event */
                            onInput: event =>
                              onReplaceInput(secretId, event.target.value),
                          }),
                        ),
                        h(
                          'button',
                          { type: 'submit', disabled: loading },
                          'Replace value',
                        ),
                      ),
                    ),
                    h(
                      'section',
                      { class: 'secret-danger-section secret-revoke-section' },
                      h('h3', null, 'Revoke access'),
                      h(
                        'p',
                        null,
                        'Revocation permanently denies this secret capability, including delegated copies.',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          class: 'secret-revoke',
                          disabled: loading,
                          onClick: () => onRevoke(secretId),
                        },
                        'Confirm revocation',
                      ),
                    ),
                  ),
            ),
          ),
      ),
    ),
    h(
      'section',
      { class: 'secret-audit' },
      h('h2', null, 'Audit'),
      h(
        'table',
        null,
        h('caption', null, 'Secret operation history'),
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, 'Time'),
            h('th', null, 'Operation'),
            h('th', null, 'Outcome'),
            h('th', null, 'Secret'),
          ),
        ),
        h(
          'tbody',
          null,
          ...events.map(event =>
            h(
              'tr',
              { key: event.eventId },
              h('td', null, event.occurredAt),
              h('td', null, event.operation),
              h('td', null, event.outcome),
              h('td', null, event.secretId.slice(0, 12)),
            ),
          ),
        ),
      ),
    ),
  );
harden(SecretsView);

/**
 * Reading a file is a filesystem capability, so it stays on the host side of
 * the confinement boundary: `renderConfined` deliberately never hands a `File`
 * or a DOM node to a handler. The confined view only invokes an opaque
 * callback; the picker, the bytes, and their disposal all live out here.
 *
 * @param {Document} $document
 * @returns {() => Promise<{ name: string, bytes: Uint8Array } | null>}
 */
const makeFileReader = $document => async () => {
  const $input = $document.createElement('input');
  $input.type = 'file';
  $input.hidden = true;
  $document.body.appendChild($input);
  try {
    /** @type {File | null} */
    const file = await new Promise(resolve => {
      $input.addEventListener(
        'change',
        () => resolve($input.files && $input.files[0] ? $input.files[0] : null),
        { once: true },
      );
      // Fired when the picker is dismissed without a choice. Browsers without
      // it simply leave the promise pending until the next pick, which is the
      // pre-existing behavior of a file input.
      $input.addEventListener('cancel', () => resolve(null), { once: true });
      $input.click();
    });
    if (file === null) return null;
    return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
  } finally {
    $input.remove();
  }
};

/**
 * @param {HTMLElement} $parent
 * @param {unknown} rootPowers
 * @param {string[]} profilePath
 * @param {(text: string) => Promise<void>} [writeClipboard]
 * @param {() => Promise<{ name: string, bytes: Uint8Array } | null>} [readFile]
 * @returns {() => void}
 */
export const secretsComponent = (
  $parent,
  rootPowers,
  profilePath,
  writeClipboard = text => navigator.clipboard.writeText(text),
  readFile = makeFileReader($parent.ownerDocument),
) => {
  $parent.replaceChildren();
  let powers = rootPowers;
  for (const name of profilePath) {
    powers = E(/** @type {any} */ (powers)).lookup(name);
  }
  const $mount = $parent.ownerDocument.createElement('div');
  $mount.id = 'secrets-root';
  $parent.appendChild($mount);

  /** @type {Map<string, SecretAdmin>} */
  const admins = new Map();
  /** @type {SecretRow[]} */
  let rows = [];
  /** @type {SecretAuditEvent[]} */
  let events = [];
  let createDraft = { name: '', description: '', value: '' };
  // Holds the file's base64 payload host-side; only name and length are ever
  // passed into the confined view.
  /** @type {{ name: string, byteLength: number, base64: string } | null} */
  let createFile = null;
  /** @type {Map<string, string>} */
  const descriptionDrafts = new Map();
  const dirtyDescriptions = new Set();
  /** @type {Map<string, string>} */
  const replacementDrafts = new Map();
  let loading = true;
  /** @type {string | null} */
  let error = null;
  /** @type {'cleared' | 'failed' | null} */
  let clipboardStatus = null;
  let disposed = false;

  const render = () => {
    if (disposed) return;
    const viewRows = rows.map(row =>
      harden({
        ...row,
        descriptionDraft: descriptionDrafts.get(row.secretId) || '',
        replacementDraft: replacementDrafts.get(row.secretId) || '',
      }),
    );
    renderConfined(
      h(SecretsView, {
        rows: viewRows,
        events,
        loading,
        error,
        clipboardStatus,
        createDraft,
        createFile:
          createFile === null
            ? null
            : harden({
                name: createFile.name,
                byteLength: createFile.byteLength,
              }),
        onCreateInput: (field, value) => {
          createDraft = { ...createDraft, [field]: value };
          render();
        },
        onReadFile: () => {
          if (loading) return;
          void (async () => {
            try {
              const picked = await readFile();
              if (picked === null) return;
              createFile = {
                name: picked.name,
                byteLength: picked.bytes.length,
                base64: encodeBase64(picked.bytes),
              };
              picked.bytes.fill(0);
              error = null;
            } catch {
              // Never surface the caught error: a filesystem message can name
              // paths the operator did not mean to disclose.
              error = 'Could not read the selected file.';
            }
            render();
          })();
        },
        onClearFile: () => {
          createFile = null;
          render();
        },
        onCreateToggle: open => {
          if (!open && (createDraft.value !== '' || createFile !== null)) {
            createDraft = { ...createDraft, value: '' };
            createFile = null;
            render();
          }
        },
        onCreate: () => {
          if (loading) return;
          const { name, description, value } = createDraft;
          // A chosen file supplies the bytes verbatim; the typed field is
          // disabled while one is loaded, so it cannot also contribute.
          const bytesBase64 =
            createFile === null ? textToBase64(value) : createFile.base64;
          createDraft = { name: '', description: '', value: '' };
          createFile = null;
          render();
          void mutate(async () => {
            const importer = E(/** @type {any} */ (powers)).lookup([
              '@secrets',
              'create',
            ]);
            await E(importer).createBase64(name, description, bytesBase64);
          });
        },
        onDescriptionInput: (secretId, description) => {
          dirtyDescriptions.add(secretId);
          descriptionDrafts.set(secretId, description);
          render();
        },
        onDescription: secretId => {
          if (loading) return;
          const description = descriptionDrafts.get(secretId);
          if (description === undefined) return;
          void mutate(async () => {
            await E(requireAdmin(secretId)).setDescription(description);
            dirtyDescriptions.delete(secretId);
          });
        },
        onReplaceInput: (secretId, value) => {
          replacementDrafts.set(secretId, value);
          render();
        },
        onDangerToggle: (secretId, open) => {
          if (!open && replacementDrafts.get(secretId) !== '') {
            replacementDrafts.set(secretId, '');
            render();
          }
        },
        onReplace: secretId => {
          if (loading) return;
          const value = replacementDrafts.get(secretId);
          if (value === undefined) return;
          replacementDrafts.set(secretId, '');
          render();
          void mutate(async () =>
            E(requireAdmin(secretId)).replaceBase64(textToBase64(value)),
          );
        },
        onRevoke: secretId => {
          if (loading) return;
          void mutate(async () => E(requireAdmin(secretId)).revoke());
        },
        onDelete: secretId => {
          if (loading) return;
          void mutate(async () => E(requireAdmin(secretId)).delete());
        },
        onClearClipboard: () => clearClipboard(),
        onRefresh: () => {
          if (!loading) void refresh();
        },
      }),
      $mount,
    );
  };

  /** @param {string} secretId */
  const requireAdmin = secretId => {
    const admin = admins.get(secretId);
    if (admin === undefined) throw new Error('Secret management facet expired');
    return admin;
  };

  const clearClipboard = () => {
    clipboardStatus = null;
    render();
    /** @type {Promise<void>} */
    let result;
    try {
      result = writeClipboard('');
    } catch {
      clipboardStatus = 'failed';
      render();
      return;
    }
    void result.then(
      () => {
        clipboardStatus = 'cleared';
        render();
      },
      () => {
        clipboardStatus = 'failed';
        render();
      },
    );
  };

  const loadData = async () => {
    const [catalog, audit] = await Promise.all([
      E(/** @type {any} */ (powers)).lookup(['@secrets', 'catalog']),
      E(/** @type {any} */ (powers)).lookup(['@secrets', 'audit']),
    ]);
    const [entries, auditEvents] = await Promise.all([
      E(catalog).list(),
      E(audit).list(100n),
    ]);
    admins.clear();
    rows = entries.map(entry => {
      admins.set(entry.secretId, entry.admin);
      if (!dirtyDescriptions.has(entry.secretId)) {
        descriptionDrafts.set(entry.secretId, entry.summary.description);
      }
      if (!replacementDrafts.has(entry.secretId)) {
        replacementDrafts.set(entry.secretId, '');
      }
      return harden({
        secretId: entry.secretId,
        summary: entry.summary,
        petNamePaths: entry.petNamePaths || [],
        descriptionDraft: descriptionDrafts.get(entry.secretId) || '',
        replacementDraft: replacementDrafts.get(entry.secretId) || '',
      });
    });
    rows.sort((left, right) => {
      const leftRevoked = left.summary.state === 'revoked' ? 1 : 0;
      const rightRevoked = right.summary.state === 'revoked' ? 1 : 0;
      return leftRevoked - rightRevoked;
    });
    events = auditEvents;
  };

  const refresh = async () => {
    loading = true;
    error = null;
    render();
    await null;
    try {
      await loadData();
    } catch {
      error = 'Secret management is unavailable.';
    } finally {
      loading = false;
      render();
    }
  };

  /** @param {() => Promise<unknown>} operation */
  const mutate = async operation => {
    if (loading) return;
    loading = true;
    error = null;
    render();
    await null;
    try {
      await operation();
      await refresh();
    } catch {
      error = 'Secret operation failed.';
      try {
        await loadData();
      } catch {
        // Preserve the fixed operation error if refreshing also fails.
      }
      loading = false;
      render();
    }
  };

  render();
  void refresh();

  return () => {
    disposed = true;
    for (const input of $mount.querySelectorAll('input[type="password"]')) {
      /** @type {HTMLInputElement} */ (input).value = '';
    }
    createDraft = { ...createDraft, value: '' };
    admins.clear();
    descriptionDrafts.clear();
    dirtyDescriptions.clear();
    replacementDrafts.clear();
    unmount($mount);
    $mount.remove();
  };
};
harden(secretsComponent);
