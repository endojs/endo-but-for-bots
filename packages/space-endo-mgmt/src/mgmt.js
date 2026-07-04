// @ts-check
/* global harden */

import { E } from '@endo/far';
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

/** @import { ERef } from '@endo/far' */

/**
 * @typedef {object} MgmtConfig
 * @property {string} repoUrl
 * @property {string} defaultBranch
 * @property {string} deployDir
 * @property {boolean} configured
 */

/**
 * @typedef {object} MgmtStatus
 * @property {string} [phase]
 * @property {string} [message]
 * @property {string} [rev]
 * @property {string} [branch]
 * @property {string} [time]
 */

/** @param {string | undefined} rev */
const shortRev = rev => (rev && rev.length > 12 ? rev.slice(0, 12) : rev || '—');

/** @param {string | undefined} phase */
const phaseClass = phase => {
  if (phase === 'ok') return 'mgmt-badge mgmt-badge-ok';
  if (phase === 'error') return 'mgmt-badge mgmt-badge-error';
  if (phase === 'building') return 'mgmt-badge mgmt-badge-busy';
  return 'mgmt-badge';
};

/**
 * Hosted-Endo management view. Talks to the `controller-for-endo-mgmt`
 * capability in the agent's inventory (provisioned by the caplet setup) to
 * show deploy status and trigger updates/restarts.
 *
 * @param {object} props
 * @param {ERef<any>} props.powers - host (AGENT) powers
 */
export const MgmtView = ({ powers }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState(/** @type {MgmtStatus | null} */ (null));
  const [config, setConfig] = useState(/** @type {MgmtConfig | null} */ (null));
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState('');

  const controllerRef = useRef(/** @type {ERef<any> | null} */ (null));
  const branchTouched = useRef(false);

  const getController = () => {
    if (!controllerRef.current) {
      controllerRef.current = E(powers).lookup('controller-for-endo-mgmt');
    }
    return controllerRef.current;
  };

  const refresh = async () => {
    try {
      const result = await E(getController()).getStatus();
      setStatus(result.status || null);
      setConfig(result.config || null);
      setError('');
      if (
        !branchTouched.current &&
        result.config &&
        result.config.defaultBranch
      ) {
        setBranch(prev => prev || result.config.defaultBranch);
      }
    } catch (err) {
      setError(
        err && /** @type {Error} */ (err).message
          ? /** @type {Error} */ (err).message
          : String(err),
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let live = true;
    refresh();
    const id = setInterval(() => {
      if (live) refresh();
    }, 3000);
    return () => {
      live = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** @param {'update' | 'restart'} kind */
  const act = kind => {
    setBusy(kind);
    const p =
      kind === 'update'
        ? E(getController()).requestUpdate(branch)
        : E(getController()).requestRestart();
    p.then(
      () => refresh(),
      err =>
        setError(
          /** @type {Error} */ (err).message || String(err),
        ),
    ).finally(() => setBusy(''));
  };

  if (loading) {
    return h('div', { class: 'mgmt-root' }, h('p', { class: 'mgmt-muted' }, 'Loading…'));
  }

  const notConfigured = config && config.configured === false;

  return h(
    'div',
    { class: 'mgmt-root' },
    h(
      'div',
      { class: 'mgmt-header' },
      h('h1', { class: 'mgmt-title' }, 'Hosted Endo'),
      h(
        'button',
        {
          class: 'mgmt-refresh',
          title: 'Refresh',
          onClick: () => refresh(),
        },
        '↻',
      ),
    ),

    error ? h('div', { class: 'mgmt-error' }, error) : null,

    notConfigured
      ? h(
          'div',
          { class: 'mgmt-card' },
          h(
            'p',
            { class: 'mgmt-muted' },
            'This daemon is not configured for hosted management ',
            '(ENDO_DEPLOY_DIR is unset). Update/restart controls are ',
            'unavailable.',
          ),
        )
      : h(
          'div',
          { class: 'mgmt-card' },
          h(
            'div',
            { class: 'mgmt-row' },
            h('span', { class: 'mgmt-label' }, 'Status'),
            h(
              'span',
              { class: phaseClass(status && status.phase) },
              (status && status.phase) || 'unknown',
            ),
          ),
          h(
            'div',
            { class: 'mgmt-row' },
            h('span', { class: 'mgmt-label' }, 'Branch'),
            h('code', { class: 'mgmt-value' }, (status && status.branch) || '—'),
          ),
          h(
            'div',
            { class: 'mgmt-row' },
            h('span', { class: 'mgmt-label' }, 'Revision'),
            h('code', { class: 'mgmt-value' }, shortRev(status && status.rev)),
          ),
          status && status.message
            ? h(
                'div',
                { class: 'mgmt-row' },
                h('span', { class: 'mgmt-label' }, 'Message'),
                h('span', { class: 'mgmt-value' }, status.message),
              )
            : null,
          status && status.time
            ? h(
                'div',
                { class: 'mgmt-row' },
                h('span', { class: 'mgmt-label' }, 'Updated'),
                h('span', { class: 'mgmt-value' }, status.time),
              )
            : null,
          config && config.repoUrl
            ? h(
                'div',
                { class: 'mgmt-row' },
                h('span', { class: 'mgmt-label' }, 'Repo'),
                h('code', { class: 'mgmt-value mgmt-repo' }, config.repoUrl),
              )
            : null,
        ),

    notConfigured
      ? null
      : h(
          'div',
          { class: 'mgmt-controls' },
          h(
            'label',
            { class: 'mgmt-field' },
            h('span', { class: 'mgmt-label' }, 'Branch to deploy'),
            h('input', {
              type: 'text',
              class: 'mgmt-input',
              value: branch,
              placeholder: (config && config.defaultBranch) || 'llm',
              /** @param {{ target: { value: string } }} e */
              onInput: e => {
                branchTouched.current = true;
                setBranch(e.target.value);
              },
            }),
          ),
          h(
            'div',
            { class: 'mgmt-actions' },
            h(
              'button',
              {
                class: 'mgmt-btn mgmt-btn-primary',
                disabled: busy ? true : undefined,
                onClick: () => act('update'),
              },
              busy === 'update' ? 'Updating…' : 'Update & Restart',
            ),
            h(
              'button',
              {
                class: 'mgmt-btn',
                disabled: busy ? true : undefined,
                onClick: () => act('restart'),
              },
              busy === 'restart' ? 'Restarting…' : 'Restart',
            ),
          ),
          h(
            'p',
            { class: 'mgmt-hint' },
            'Update pulls the branch, rebuilds, and restarts with automatic ',
            'rollback on failure. The connection will briefly drop and ',
            'reconnect.',
          ),
        ),
  );
};
harden(MgmtView);
