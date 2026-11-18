// @ts-check
/**
 * The Secrets panel (P-58; R6-67, R7-22..R7-26, R7-63; m4-interfaces.md 4.1,
 * 9.1; W4.7). Write-only: it lists the catalogue (label, description,
 * generation, state, bytes: never a value, R7-26), creates a secret with an
 * optional first value, replaces a value with the generation it showed
 * (a stale one fails `GENERATION_CONFLICT`), edits a description, revokes,
 * deletes a revoked secret and pages the audit history (100 events a page,
 * newest first).
 *
 * Values: read from a password field or a file at the moment of sending,
 * checked (`values.js`: `browserSecretBytes`, UTF-8), passed to the
 * gateway's in-process secret writer (`daemon.js`) in one call and cleared
 * from the field. They
 * are never kept in component state, rendered or logged.
 */
import { E } from '@endo/far';
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { secretsOf } from './daemon.js';
import { readSecretFile, refuseBrowserValue } from './values.js';

/** @import { FeatureContext } from '../../../resources/agent-host/impl/gateway/contract-m3.js' */

/** The panel's own words (harness texts). */
export const secretsTexts = harden({
  title: 'Secrets',
  writeOnly: 'Values are write-only: this page never shows them.',
  label: 'Label',
  description: 'Description',
  value: 'Value',
  file: 'or a text file',
  create: 'Create',
  replace: 'Replace value',
  send: 'Send',
  cancel: 'Cancel',
  editDescription: 'Edit description',
  save: 'Save',
  revoke: 'Revoke',
  confirmRevoke: 'Revoke permanently (every grant stops working)',
  delete: 'Delete',
  confirmDelete: 'Delete this revoked secret',
  audit: 'Audit',
  auditAll: 'Audit of every secret',
  older: 'Older events',
  close: 'Close',
  more: 'More secrets',
  none: 'No secrets yet.',
  noValue: 'Enter a value or choose a file.',
  replaced: 'Value replaced.',
  created: 'Secret created.',
  noEvents: 'No audit events.',
});

/** Audit events per page (R7-63: the default page). */
export const AUDIT_PAGE = 100;

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error =>
  error && typeof error === 'object' && 'message' in error
    ? String(/** @type {{ message: unknown }} */ (error).message)
    : String(error);

/**
 * Errors the panel raised itself before anything was sent (a value over the
 * browser bound, a file that is not text, no value): the action then reads
 * nothing from the daemon either, so a refused value sends no frame at all
 * (m4-interfaces.md 17, acceptance 14).
 *
 * @type {WeakSet<object>}
 */
const localRefusals = new WeakSet();

/**
 * @param {string} text
 * @returns {Error}
 */
const refuseLocally = text => {
  const error = Error(text);
  localRefusals.add(error);
  return error;
};

/**
 * One audit event as a line (R7-24: fixed outcome and code, no bytes).
 *
 * @param {Record<string, any>} event
 */
export const auditLine = event =>
  [
    new Date(event.at).toISOString(),
    event.label,
    event.op,
    event.outcome,
    ...(event.code === undefined ? [] : [event.code]),
    ...(event.generation === undefined ? [] : [`gen ${event.generation}`]),
  ].join(' ');

/**
 * The value to send: the chosen file's text, else the field's text.
 * Both inputs are cleared whatever the outcome.
 *
 * @param {any} field the password input
 * @param {any} picker the file input
 * @returns {Promise<{ value: string } | { error: string } | { empty: true }>}
 */
const takeValue = async (field, picker) => {
  const file = picker && picker.files && picker.files[0];
  const typed = field ? String(field.value) : '';
  if (field) field.value = '';
  if (picker) picker.value = '';
  if (file) return readSecretFile(file);
  if (typed === '') return { empty: true };
  return { value: typed };
};

/**
 * @param {{ context: FeatureContext }} props
 */
export const SecretsPanel = ({ context }) => {
  const powers = context.powers;
  const [entries, setEntries] = useState(/** @type {any[]} */ ([]));
  const [next, setNext] = useState(
    /** @type {string | undefined} */ (undefined),
  );
  const [pages, setPages] = useState(1);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  /** @type {[{ secret: any, mode: string } | null, (v: any) => void]} */
  const [editing, setEditing] = useState(
    /** @type {{ secret: any, mode: string } | null} */ (null),
  );
  /** @type {[any, (v: any) => void]} */
  const [audit, setAudit] = useState(/** @type {any} */ (null));
  const loadEpoch = useRef(0);
  const createLabel = useRef(/** @type {any} */ (null));
  const createDescription = useRef(/** @type {any} */ (null));
  const createValue = useRef(/** @type {any} */ (null));
  const createFile = useRef(/** @type {any} */ (null));
  const rowValue = useRef(/** @type {any} */ (null));
  const rowFile = useRef(/** @type {any} */ (null));
  const rowDescription = useRef(/** @type {any} */ (null));

  /**
   * Read the first `count` catalogue pages again.
   *
   * @param {number} count
   */
  const load = async count => {
    if (!powers) return;
    loadEpoch.current += 1;
    const epoch = loadEpoch.current;
    const admin = /** @type {any} */ (
      await context.call(() => secretsOf(powers).admin())
    );
    /** @type {any[]} */
    const all = [];
    /** @type {string | undefined} */
    let cursor;
    let read = 0;
    for (; read < count; read += 1) {
      const page = /** @type {any} */ (
        // eslint-disable-next-line no-await-in-loop
        await context.call(() =>
          cursor === undefined ? E(admin).catalog() : E(admin).catalog(cursor),
        )
      );
      all.push(...page.entries);
      cursor = page.next;
      if (cursor === undefined) break;
    }
    if (epoch !== loadEpoch.current) return;
    setEntries(all);
    setNext(cursor);
    setPages(Math.max(1, Math.min(count, read + 1)));
  };

  /**
   * Run one action: errors shown in the panel (and the status bar, by
   * `context.call`), the catalogue read again afterwards.
   *
   * @param {() => Promise<string | void>} body answers a notice
   * @param {{ reload?: boolean }} [options]
   */
  const act = async (body, { reload = true } = {}) => {
    await null;
    setBusy(true);
    setError('');
    setNotice('');
    let refusedLocally = false;
    try {
      const said = await body();
      if (said) setNotice(said);
    } catch (thrown) {
      refusedLocally =
        typeof thrown === 'object' &&
        thrown !== null &&
        localRefusals.has(thrown);
      setError(messageOf(thrown));
    } finally {
      setBusy(false);
    }
    if (reload && !refusedLocally) {
      await load(pages).catch(thrown => setError(messageOf(thrown)));
    }
  };

  useEffect(() => {
    setEntries([]);
    setNext(undefined);
    setEditing(null);
    setAudit(null);
    load(1).catch(thrown => setError(messageOf(thrown)));
  }, [powers]);

  /**
   * Check and send one value through the writer.
   *
   * @param {any} secret
   * @param {number} expectedGeneration
   * @param {{ value: string }} taken
   */
  const write = async (secret, expectedGeneration, taken) => {
    const writer = /** @type {any} */ (
      await context.call(() => secretsOf(powers).writer())
    );
    await context.call(() =>
      E(writer).replace(secret, taken.value, expectedGeneration),
    );
  };

  /** @param {any} event */
  const onCreate = event => {
    event.preventDefault();
    act(async () => {
      const label = String(createLabel.current?.value ?? '').trim();
      const description = String(createDescription.current?.value ?? '');
      const taken = await takeValue(createValue.current, createFile.current);
      if ('error' in taken) throw refuseLocally(taken.error);
      if ('value' in taken) {
        const refusal = refuseBrowserValue(taken.value);
        if (refusal) throw refuseLocally(refusal);
      }
      const admin = await secretsOf(powers).admin();
      const secret = await context.call(() =>
        E(admin).create({ label, description }),
      );
      if ('value' in taken) await write(secret, 0, taken);
      if (createLabel.current) createLabel.current.value = '';
      if (createDescription.current) createDescription.current.value = '';
      return secretsTexts.created;
    });
  };

  /** @param {any} entry */
  const onReplace = entry =>
    act(async () => {
      const taken = await takeValue(rowValue.current, rowFile.current);
      if ('error' in taken) throw refuseLocally(taken.error);
      if ('empty' in taken) throw refuseLocally(secretsTexts.noValue);
      const refusal = refuseBrowserValue(taken.value);
      if (refusal) throw refuseLocally(refusal);
      await write(entry.secret, entry.generation, taken);
      setEditing(null);
      return secretsTexts.replaced;
    });

  /** @param {any} entry */
  const onDescribe = entry =>
    act(async () => {
      const text = String(rowDescription.current?.value ?? '');
      await context.call(() => E(entry.secret).setDescription(text));
      setEditing(null);
    });

  /** @param {any} entry */
  const onRevoke = entry =>
    act(async () => {
      await context.call(() => E(entry.secret).revoke());
      setEditing(null);
    });

  /** @param {any} entry */
  const onDelete = entry =>
    act(async () => {
      await context.call(() => E(entry.secret).delete());
      setEditing(null);
      if (audit && audit.secret === entry.secret) setAudit(null);
    });

  /**
   * Show the audit history, of one secret or all, from its newest event
   * (`before` undefined) or older than `before`.
   *
   * @param {{ secret?: any, label?: string }} scope
   * @param {number} [before]
   */
  const openAudit = (scope, before) =>
    act(
      async () => {
        const reader = /** @type {any} */ (
          await context.call(() => secretsOf(powers).reader())
        );
        /** @type {Record<string, any>} */
        const query = { limit: AUDIT_PAGE };
        if (scope.secret !== undefined) query.secret = scope.secret;
        if (before !== undefined) query.before = before;
        const page = /** @type {any} */ (
          await context.call(() => E(reader).page(harden(query)))
        );
        setAudit({
          ...scope,
          events:
            before === undefined
              ? page.events
              : [...(audit ? audit.events : []), ...page.events],
          next: page.next,
        });
      },
      { reload: false },
    );

  /**
   * @param {any} secret
   * @param {string} mode
   */
  const isEditing = (secret, mode) =>
    editing !== null && editing.secret === secret && editing.mode === mode;

  /**
   * @param {string} action
   * @param {string} text
   * @param {() => void} onClick
   * @param {string} [extra]
   */
  const button = (action, text, onClick, extra = '') =>
    h(
      'button',
      {
        type: 'button',
        class: `m4-btn${extra ? ` ${extra}` : ''}`,
        'data-action': action,
        disabled: busy,
        onClick,
      },
      text,
    );

  const valueInputs = (
    /** @type {any} */ valueRef,
    /** @type {any} */ fileRef,
  ) => [
    h('input', {
      type: 'password',
      class: 'm4-input',
      name: 'value',
      autocomplete: 'new-password',
      spellcheck: false,
      'aria-label': secretsTexts.value,
      placeholder: secretsTexts.value,
      ref: valueRef,
    }),
    h(
      'label',
      { class: 'm4-file' },
      secretsTexts.file,
      h('input', { type: 'file', name: 'file', ref: fileRef }),
    ),
  ];

  /** @param {any} entry */
  const rowEditor = entry => {
    if (isEditing(entry.secret, 'replace')) {
      return h(
        'div',
        { class: 'm4-row-form', 'data-form': 'replace' },
        ...valueInputs(rowValue, rowFile),
        button('send', secretsTexts.send, () => onReplace(entry)),
        button('cancel', secretsTexts.cancel, () => setEditing(null)),
      );
    }
    if (isEditing(entry.secret, 'describe')) {
      return h(
        'div',
        { class: 'm4-row-form', 'data-form': 'describe' },
        h('input', {
          class: 'm4-input',
          name: 'description',
          maxlength: 200,
          'aria-label': secretsTexts.description,
          value: entry.description,
          ref: rowDescription,
        }),
        button('save', secretsTexts.save, () => onDescribe(entry)),
        button('cancel', secretsTexts.cancel, () => setEditing(null)),
      );
    }
    if (isEditing(entry.secret, 'revoke')) {
      return h(
        'div',
        { class: 'm4-row-form', 'data-form': 'revoke' },
        button(
          'confirm-revoke',
          secretsTexts.confirmRevoke,
          () => onRevoke(entry),
          'danger',
        ),
        button('cancel', secretsTexts.cancel, () => setEditing(null)),
      );
    }
    if (isEditing(entry.secret, 'delete')) {
      return h(
        'div',
        { class: 'm4-row-form', 'data-form': 'delete' },
        button(
          'confirm-delete',
          secretsTexts.confirmDelete,
          () => onDelete(entry),
          'danger',
        ),
        button('cancel', secretsTexts.cancel, () => setEditing(null)),
      );
    }
    return null;
  };

  /** @param {any} entry */
  const row = entry => {
    const active = entry.state === 'active';
    /** @param {string} mode */
    const edit = mode => () => setEditing({ secret: entry.secret, mode });
    return h(
      'li',
      { class: `m4-secret ${entry.state}`, 'data-state': entry.state },
      h(
        'div',
        { class: 'm4-secret-head' },
        h('span', { class: 'm4-secret-label' }, entry.label),
        h(
          'span',
          { class: 'm4-secret-facts' },
          `gen ${entry.generation} · ${entry.bytes} bytes · ${entry.state}`,
        ),
      ),
      h('div', { class: 'm4-secret-description' }, entry.description),
      h(
        'div',
        { class: 'm4-secret-actions' },
        active
          ? button('replace', secretsTexts.replace, edit('replace'))
          : null,
        button('describe', secretsTexts.editDescription, edit('describe')),
        button('audit', secretsTexts.audit, () =>
          openAudit({ secret: entry.secret, label: entry.label }),
        ),
        active
          ? button('revoke', secretsTexts.revoke, edit('revoke'), 'danger')
          : button('delete', secretsTexts.delete, edit('delete'), 'danger'),
      ),
      rowEditor(entry),
    );
  };

  const auditView = () =>
    audit &&
    h(
      'section',
      { class: 'm4-audit', 'data-audit': audit.label ?? 'all' },
      h(
        'h3',
        null,
        audit.label === undefined
          ? secretsTexts.auditAll
          : `${secretsTexts.audit}: ${audit.label}`,
      ),
      audit.events.length === 0
        ? h('p', { class: 'm4-note' }, secretsTexts.noEvents)
        : h(
            'ol',
            { class: 'm4-audit-events' },
            audit.events.map(
              (/** @type {any} */ event, /** @type {number} */ index) =>
                h(
                  'li',
                  { key: index, class: `m4-audit-event ${event.outcome}` },
                  auditLine(event),
                ),
            ),
          ),
      audit.next === undefined
        ? null
        : button('older', secretsTexts.older, () =>
            openAudit({ secret: audit.secret, label: audit.label }, audit.next),
          ),
      button('close-audit', secretsTexts.close, () => setAudit(null)),
    );

  return h(
    'div',
    { class: 'm4-panel m4-secrets' },
    h('h2', null, secretsTexts.title),
    h('p', { class: 'm4-note' }, secretsTexts.writeOnly),
    error ? h('div', { class: 'm4-error', role: 'alert' }, error) : null,
    notice ? h('div', { class: 'm4-notice', role: 'status' }, notice) : null,
    h(
      'form',
      { class: 'm4-create', 'data-form': 'create', onSubmit: onCreate },
      h('input', {
        class: 'm4-input',
        name: 'label',
        required: true,
        maxlength: 256,
        'aria-label': secretsTexts.label,
        placeholder: secretsTexts.label,
        ref: createLabel,
      }),
      h('input', {
        class: 'm4-input',
        name: 'description',
        required: true,
        maxlength: 200,
        'aria-label': secretsTexts.description,
        placeholder: secretsTexts.description,
        ref: createDescription,
      }),
      ...valueInputs(createValue, createFile),
      h(
        'button',
        {
          type: 'submit',
          class: 'm4-btn primary',
          'data-action': 'create',
          disabled: busy,
        },
        secretsTexts.create,
      ),
    ),
    entries.length === 0
      ? h('p', { class: 'm4-note' }, secretsTexts.none)
      : h('ul', { class: 'm4-secret-list' }, entries.map(row)),
    next === undefined
      ? null
      : button('more', secretsTexts.more, () =>
          act(() => load(pages + 1), { reload: false }),
        ),
    h(
      'div',
      { class: 'm4-secret-actions' },
      button('audit-all', secretsTexts.auditAll, () => openAudit({})),
    ),
    auditView(),
  );
};
