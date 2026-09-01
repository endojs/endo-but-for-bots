// @ts-check

import harden from '@endo/harden';
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { E } from '@endo/eventual-send';
import {
  collectFormValues,
  fieldKind,
  initialFormValues,
} from '@endo/spaces-util/form-fields.js';

/** @import { VNode } from 'preact' */

// Answer a run's pending approval without leaving the workflow space.
//
// AUTHORITY. The space still cannot steer a run: it holds only the read-only
// `WorkflowRun` facet, and nothing here touches it. What this panel does is
// surface the form the run already sent to the OPERATOR'S OWN INBOX and let the
// viewer answer it with the viewer's own `submit` authority. If the viewer is
// not the operator, the message is not in their inbox, there is nothing to
// answer, and the panel says so rather than offering a control that would fail.
//
// So the run advances because its operator answered their mail — exactly as it
// would from the inbox — and the space remains a viewer.

/**
 * The pending `ask` effects of a live state, in form mode.
 *
 * Two shapes reach here and they differ, which is why this keys off the
 * CORRELATION rather than the effect kind:
 *
 * - the run facet's `status()` projects a flattened record with `kind` at the
 *   top level;
 * - the client-side fold — what this space actually renders from, via
 *   `makeRunSyncClient` — stores the raw effect record, where the kind is
 *   nested at `record.effect.kind`.
 *
 * Reading `kind` at the top level therefore matched nothing in the space, and
 * the panel never appeared. `correlation.mode === 'form'` is present in both,
 * is what the engine journals, and is the thing actually being tested: there
 * is a form waiting to be answered.
 *
 * @param {any[] | undefined} pending
 * @returns {any[]}
 */
export const formAsks = pending =>
  (Array.isArray(pending) ? pending : []).filter(record => {
    if (!record || !record.correlation) return false;
    if (record.correlation.mode !== 'form') return false;
    // Accept either shape; tolerate a record that carries no kind at all
    // rather than silently rendering nothing again.
    const kind = record.kind ?? (record.effect && record.effect.kind);
    return kind === undefined || kind === 'ask';
  });
harden(formAsks);

/**
 * Match a pending ask to a message in the viewer's own inbox by message id.
 * Returns undefined when the viewer is not the recipient.
 *
 * @param {any[]} messages
 * @param {any} ask
 * @returns {any}
 */
export const matchInboxMessage = (messages, ask) => {
  const wanted = ask && ask.correlation && ask.correlation.messageId;
  if (wanted === undefined) return undefined;
  return (Array.isArray(messages) ? messages : []).find(
    message =>
      message &&
      message.type === 'form' &&
      String(message.messageId) === String(wanted),
  );
};
harden(matchInboxMessage);

/**
 * @param {{ powers: unknown, pending: any[], runId: string | undefined }} props
 * @returns {VNode | null}
 */
export const ApprovalPanel = ({ powers, pending, runId }) => {
  const asks = formAsks(pending);
  const ask = asks[0];
  const [message, setMessage] = useState(/** @type {any} */ (undefined));
  const [values, setValues] = useState(
    /** @type {Record<string, string | boolean>} */ ({}),
  );
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const askId = ask ? String(ask.correlation.messageId) : '';

  // Re-read the inbox whenever the waiting ask changes. A run can ask more than
  // once (attestation after a failed apply), and the answer to the previous ask
  // must not linger in the fields.
  useEffect(() => {
    if (powers === undefined || askId === '') {
      setMessage(undefined);
      return undefined;
    }
    let disposed = false;
    setError('');
    E(/** @type {any} */ (powers))
      .listMessages()
      .then(
        (/** @type {any[]} */ messages) => {
          if (disposed) return;
          const found = matchInboxMessage(messages, ask);
          setMessage(found);
          setValues(
            found
              ? initialFormValues(fieldsOf(found))
              : /** @type {any} */ ({}),
          );
        },
        () => {
          if (!disposed) setMessage(undefined);
        },
      );
    return () => {
      disposed = true;
    };
    // `ask` is a fresh object every poll; key the effect on the message id.
  }, [powers, askId]);

  if (ask === undefined) return null;

  const description = ask.description || (message && message.description) || '';

  if (message === undefined) {
    return h(
      'div',
      { class: 'wf-approval wf-approval-elsewhere' },
      h('div', { class: 'wf-approval-title' }, 'Waiting on approval'),
      description ? h('p', { class: 'wf-approval-desc' }, description) : null,
      h(
        'p',
        { class: 'wf-approval-note' },
        'This run is waiting on its operator. The form is in their inbox, not yours.',
      ),
    );
  }

  const fields = fieldsOf(message);

  const submit = () => {
    setSubmitting(true);
    setError('');
    E(/** @type {any} */ (powers))
      .submit(message.number, collectFormValues(fields, values))
      .then(
        () => {
          setSubmitting(false);
          setMessage(undefined);
        },
        (/** @type {Error} */ err) => {
          setSubmitting(false);
          setError(err.message);
        },
      );
  };

  return h(
    'div',
    { class: 'wf-approval' },
    h('div', { class: 'wf-approval-title' }, `Approval — ${runId ?? ''}`),
    description ? h('p', { class: 'wf-approval-desc' }, description) : null,
    h(
      'div',
      { class: 'wf-approval-fields' },
      fields.map(field =>
        fieldKind(field) === 'boolean'
          ? h(
              'label',
              { key: field.name, class: 'wf-approval-check' },
              h('input', {
                type: 'checkbox',
                checked: values[field.name] === true,
                onChange: (/** @type {any} */ event) =>
                  setValues(previous => ({
                    ...previous,
                    [field.name]: event.target.checked === true,
                  })),
              }),
              field.label || field.name,
            )
          : h(
              'label',
              { key: field.name, class: 'wf-approval-text' },
              h('span', null, field.label || field.name),
              h('input', {
                type: 'text',
                value:
                  typeof values[field.name] === 'string'
                    ? values[field.name]
                    : '',
                placeholder: field.example || '',
                onInput: (/** @type {any} */ event) =>
                  setValues(previous => ({
                    ...previous,
                    [field.name]: event.target.value,
                  })),
              }),
            ),
      ),
    ),
    error ? h('div', { class: 'wf-approval-error' }, error) : null,
    h(
      'div',
      { class: 'wf-approval-actions' },
      h(
        'button',
        {
          type: 'button',
          class: 'wf-approval-submit',
          disabled: submitting,
          onClick: submit,
        },
        submitting ? 'Submitting…' : 'Submit',
      ),
    ),
  );
};
harden(ApprovalPanel);

/**
 * @param {any} message
 * @returns {any[]}
 */
function fieldsOf(message) {
  const fields = message && message.fields;
  return Array.isArray(fields) ? fields : [];
}
