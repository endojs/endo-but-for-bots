// @ts-check

import { E } from '@endo/eventual-send';

import { h, renderConfined, unmount } from './setup-preact-container.js';

/** @import { SecretAdmin, SecretAuditEvent, SecretSummary } from '@endo/daemon' */

/** @param {string} text */
const textToBase64 = text => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};
harden(textToBase64);

/**
 * @typedef {object} SecretRow
 * @property {string} secretId
 * @property {SecretSummary} summary
 * @property {string} purposeDraft
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
 * @param {{ name: string, purpose: string, value: string }} props.createDraft
 * @param {(field: 'name' | 'purpose' | 'value', value: string) => void} props.onCreateInput
 * @param {() => void} props.onCreate
 * @param {(secretId: string, purpose: string) => void} props.onPurposeInput
 * @param {(secretId: string) => void} props.onPurpose
 * @param {(secretId: string, value: string) => void} props.onReplaceInput
 * @param {(secretId: string) => void} props.onReplace
 * @param {(secretId: string) => void} props.onRevoke
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
  onCreateInput,
  onCreate,
  onPurposeInput,
  onPurpose,
  onReplaceInput,
  onReplace,
  onRevoke,
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
        h('button', { type: 'button', onClick: onRefresh }, 'Refresh'),
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
      h('h2', null, 'Add a secret'),
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
        'Purpose (not secret)',
        h('input', {
          name: 'purpose',
          required: true,
          maxlength: 200,
          autocomplete: 'off',
          value: createDraft.purpose,
          /** @param {{ target: { value: string } }} event */
          onInput: event => onCreateInput('purpose', event.target.value),
        }),
      ),
      h(
        'label',
        null,
        'Secret value (UTF-8)',
        h('input', {
          type: 'password',
          name: 'value',
          required: true,
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
      h('button', { type: 'submit', disabled: loading }, 'Store secret'),
    ),
    h(
      'section',
      { class: 'secret-catalog' },
      h('h2', null, 'Catalog'),
      loading && rows.length === 0 ? h('p', null, 'Loading…') : null,
      rows.length === 0 && !loading ? h('p', null, 'No secrets yet.') : null,
      ...rows.map(({ secretId, summary, purposeDraft, replacementDraft }) =>
        h(
          'article',
          { class: `secret-card secret-${summary.state}`, key: secretId },
          h(
            'div',
            { class: 'secret-summary' },
            h('strong', null, summary.purpose),
            h('span', { class: 'secret-state' }, summary.state),
            h('span', null, `generation ${summary.generation}`),
          ),
          h(
            'form',
            {
              autocomplete: 'off',
              /** @param {{ preventDefault: () => void }} event */
              onSubmit: event => {
                event.preventDefault();
                onPurpose(secretId);
              },
            },
            h('input', {
              name: 'purpose',
              value: purposeDraft,
              maxlength: 200,
              disabled: summary.state === 'revoked',
              /** @param {{ target: { value: string } }} event */
              onInput: event => onPurposeInput(secretId, event.target.value),
            }),
            h(
              'button',
              { type: 'submit', disabled: summary.state === 'revoked' },
              'Update purpose',
            ),
          ),
          h(
            'form',
            {
              autocomplete: 'off',
              /** @param {{ preventDefault: () => void }} event */
              onSubmit: event => {
                event.preventDefault();
                onReplace(secretId);
              },
            },
            h('input', {
              type: 'password',
              name: 'value',
              required: true,
              autocomplete: 'off',
              autocapitalize: 'off',
              'data-1p-ignore': 'true',
              'data-lpignore': 'true',
              spellcheck: false,
              placeholder: 'Replacement value',
              disabled: summary.state === 'revoked',
              value: replacementDraft,
              /** @param {{ target: { value: string } }} event */
              onInput: event => onReplaceInput(secretId, event.target.value),
            }),
            h(
              'button',
              { type: 'submit', disabled: summary.state === 'revoked' },
              'Replace value',
            ),
          ),
          summary.state === 'revoked'
            ? null
            : h(
                'details',
                { class: 'secret-danger' },
                h('summary', null, 'Danger zone'),
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
                    onClick: () => onRevoke(secretId),
                  },
                  'Confirm revocation',
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
 * @param {HTMLElement} $parent
 * @param {unknown} rootPowers
 * @param {string[]} profilePath
 * @param {(text: string) => Promise<void>} [writeClipboard]
 * @returns {() => void}
 */
export const secretsComponent = (
  $parent,
  rootPowers,
  profilePath,
  writeClipboard = text => navigator.clipboard.writeText(text),
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
  let createDraft = { name: '', purpose: '', value: '' };
  /** @type {Map<string, string>} */
  const purposeDrafts = new Map();
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
        purposeDraft: purposeDrafts.get(row.secretId) || '',
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
        onCreateInput: (field, value) => {
          createDraft = { ...createDraft, [field]: value };
          render();
        },
        onCreate: () => {
          const { name, purpose, value } = createDraft;
          createDraft = { name: '', purpose: '', value: '' };
          render();
          void mutate(async () => {
            const importer = E(/** @type {any} */ (powers)).lookup([
              '@secrets',
              'create',
            ]);
            await E(importer).createBase64(name, purpose, textToBase64(value));
          });
        },
        onPurposeInput: (secretId, purpose) => {
          purposeDrafts.set(secretId, purpose);
          render();
        },
        onPurpose: secretId => {
          const purpose = purposeDrafts.get(secretId);
          if (purpose === undefined) return;
          void mutate(async () =>
            E(requireAdmin(secretId)).setPurpose(purpose),
          );
        },
        onReplaceInput: (secretId, value) => {
          replacementDrafts.set(secretId, value);
          render();
        },
        onReplace: secretId => {
          const value = replacementDrafts.get(secretId);
          if (value === undefined) return;
          replacementDrafts.set(secretId, '');
          render();
          void mutate(async () =>
            E(requireAdmin(secretId)).replaceBase64(textToBase64(value)),
          );
        },
        onRevoke: secretId => {
          void mutate(async () => E(requireAdmin(secretId)).revoke());
        },
        onClearClipboard: () => clearClipboard(),
        onRefresh: () => void refresh(),
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

  const refresh = async () => {
    loading = true;
    error = null;
    render();
    await null;
    try {
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
        if (!purposeDrafts.has(entry.secretId)) {
          purposeDrafts.set(entry.secretId, entry.summary.purpose);
        }
        if (!replacementDrafts.has(entry.secretId)) {
          replacementDrafts.set(entry.secretId, '');
        }
        return harden({
          secretId: entry.secretId,
          summary: entry.summary,
          purposeDraft: purposeDrafts.get(entry.secretId) || '',
          replacementDraft: replacementDrafts.get(entry.secretId) || '',
        });
      });
      events = auditEvents;
    } catch {
      error = 'Secret management is unavailable.';
    } finally {
      loading = false;
      render();
    }
  };

  /** @param {() => Promise<unknown>} operation */
  const mutate = async operation => {
    loading = true;
    error = null;
    render();
    await null;
    try {
      await operation();
      await refresh();
    } catch {
      error = 'Secret operation failed.';
      loading = false;
      render();
    }
  };

  render();
  void refresh();

  return () => {
    disposed = true;
    admins.clear();
    purposeDrafts.clear();
    replacementDrafts.clear();
    unmount($mount);
    $mount.remove();
  };
};
harden(secretsComponent);
