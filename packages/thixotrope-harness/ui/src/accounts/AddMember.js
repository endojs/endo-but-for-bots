// @ts-check
/**
 * "Add subscription" for one pool (m4-interfaces.md 3.1, 10): choose an
 * active Secret from the catalogue, name the subscription, optionally
 * check that the Secret holds a credential of the pool's provider in the
 * expected format (the adapter reads it; this page sees only ok or a code,
 * shown in plain words), then add it with one call,
 * `SubscriptionsAdmin.addMember(pool, { label, credential })`, which
 * checks the pool rules and the credential before it makes anything. The
 * provider is the pool's. The Secret and pool presences go to the admin as
 * they are: nothing is looked up by name, and no secret content is ever
 * read here.
 *
 * A passing check is format only: the add's first usage read is what asks
 * the provider, and `MemberStatus` shows its result on the new member.
 *
 * A manager installed before `addMember` (`__getMethodNames__()` lacks
 * it) gets a plain note instead of the form.
 *
 * Members an interrupted add left in no pool (a crash between the
 * manager's make and add) of this provider are listed, only when there
 * are any, with Add and Retire.
 */
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { limits } from '../../../guest/lib/limits.js';
import {
  providerOfKind,
  subscriptionTextOf,
  subscriptionTexts,
} from '../../../guest/lib/subscription-texts.js';
/* eslint-enable import/no-relative-packages */
import { formatInstant } from './quota-projection.js';

/** The form's own words (harness texts). */
export const addMemberTexts = harden({
  open: 'Add subscription',
  cancel: 'Cancel',
  secret: 'Secret',
  choose: 'Choose a secret…',
  label: 'Subscription label',
  check: 'Check format',
  checking: 'Checking…',
  add: 'Add',
  adding: 'Adding…',
  loading: 'Reading secrets…',
  noSecrets: 'No active secrets. Add one under Secrets first.',
  needSecret: 'Choose a secret',
  needLabel: 'Enter a label for this subscription',
  added: 'Subscription added to the pool',
  unpooled: 'Interrupted adds',
  unpooledNote:
    'An earlier add was interrupted after the subscription was made: add it to this pool or retire it.',
  unpooledAgainNote:
    'An earlier add was interrupted after the subscription was made: add it again with the same secret and label (that finishes the add) or retire it.',
  addExisting: 'Add to this pool',
  retire: 'Retire',
  confirmRetire: 'Retire permanently (it leaves every pool)',
  tryAgain: 'Replace the secret and try again',
  tryAgainNote:
    'Replace the value of its secret under Secrets (sign in again first), then try again.',
  dismiss: 'Dismiss',
  /** @param {string} provider */
  provider: provider => `Provider: ${provider} (fixed by the pool)`,
  /** @param {string} name */
  addExistingNamed: name => `Add "${name}" to this pool`,
  /** @param {string} name */
  retireNamed: name => `Retire "${name}"`,
  /** @param {string} name */
  confirmRetireNamed: name => `Retire "${name}" permanently`,
  /** @param {string} name */
  tryAgainNamed: name => `Replace the secret of "${name}" and try again`,
  /** @param {string} name */
  statusOf: name => `Status of "${name}"`,
  usageRead: 'usage read',
  catalogRead: 'model list read',
});

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error =>
  error && typeof error === 'object' && 'message' in error
    ? String(/** @type {{ message: unknown }} */ (error).message)
    : String(error);

/**
 * @param {{ ok: boolean, code?: string }} check
 * @returns {string}
 */
export const checkText = check =>
  check.ok
    ? subscriptionTexts.credentialReady
    : subscriptionTextOf.credentialCheckFailed(String(check.code));

/**
 * One failed read in plain words: what failed, why (code and status),
 * when, and what to do, e.g. `usage read: the provider rejected the
 * credential (HTTP 401) at 2026-11-18 00:00 UTC; sign in again and replace
 * the secret`.
 * @param {string} what
 * @param {{ code: string, status?: number, at: string }} failure
 */
export const failureText = (what, failure) => {
  const ms = Date.parse(failure.at);
  const when = Number.isFinite(ms) ? ` at ${formatInstant(ms)}` : '';
  const advice = subscriptionTextOf.readFailureAdvice(failure);
  return `${what}: ${subscriptionTextOf.readFailure(failure)}${when}${
    advice ? `; ${advice}` : ''
  }`;
};

/**
 * The first usage read of a member just added, in plain words.
 * @param {Record<string, any> | undefined} account
 * @returns {{ state: 'ok' | 'pending' | 'failed', text: string }}
 */
export const firstReadOf = account => {
  const failure = account?.usageFailure;
  if (failure !== undefined)
    return {
      state: 'failed',
      text:
        failure.code === 'REJECTED'
          ? subscriptionTexts.firstReadRejected
          : `${subscriptionTexts.firstReadPending}; ${failureText(
              addMemberTexts.usageRead,
              failure,
            )}`,
    };
  if (account?.provenance === 'observed')
    return { state: 'ok', text: subscriptionTexts.firstReadOk };
  return { state: 'pending', text: subscriptionTexts.firstReadPending };
};

/**
 * An inline-confirmed Retire (the Secrets panel's pattern): Retire, then
 * "Retire permanently" and Cancel in its place.
 * @param {{
 *   name: string,
 *   disabled: boolean,
 *   onRetire: () => void,
 * }} props
 */
const RetireButton = ({ name, disabled, onRetire }) => {
  const [confirming, setConfirming] = useState(false);
  if (!confirming)
    return h(
      'button',
      {
        type: 'button',
        class: 'm4-btn',
        'data-action': 'retire-member',
        'aria-label': addMemberTexts.retireNamed(name),
        disabled,
        onClick: () => setConfirming(true),
      },
      addMemberTexts.retire,
    );
  return h(
    'span',
    { class: 'm4-row-form', 'data-form': 'retire' },
    h(
      'button',
      {
        type: 'button',
        class: 'm4-btn danger',
        'data-action': 'confirm-retire',
        'aria-label': addMemberTexts.confirmRetireNamed(name),
        disabled,
        onClick: () => {
          setConfirming(false);
          onRetire();
        },
      },
      addMemberTexts.confirmRetire,
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'm4-btn',
        'data-action': 'cancel-retire',
        disabled,
        onClick: () => setConfirming(false),
      },
      addMemberTexts.cancel,
    ),
  );
};

/**
 * What the pool's members' reads say, on each member that has something
 * to say: the first usage read of a member just added (accepted, not yet
 * read, or rejected with Retire and "replace the secret and try again"),
 * and every member's last failed usage and model list reads (codes,
 * statuses and times from the accounts view; an older adapter sends none
 * and nothing shows).
 *
 * @param {{
 *   feed: import('./feed.js').AccountsFeed,
 *   pool: Record<string, any>,
 *   added?: { label: string, member: any },
 *   onDone?: () => void,
 *   call?: (fn: () => Promise<any>) => Promise<any>,
 * }} props
 */
export const MemberStatus = ({
  feed,
  pool,
  added,
  onDone = () => {},
  call = fn => fn(),
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** @param {() => Promise<void>} body */
  const act = async body => {
    setBusy(true);
    setError('');
    await null;
    try {
      await call(body);
    } catch (thrown) {
      setError(messageOf(thrown));
    } finally {
      setBusy(false);
    }
  };
  const shown = /** @type {Record<string, any>[]} */ (pool.members).filter(
    account =>
      account.state !== 'retired' &&
      (account.label === added?.label ||
        account.usageFailure !== undefined ||
        account.catalogFailure !== undefined),
  );
  if (added !== undefined && !shown.some(a => a.label === added.label))
    shown.unshift({ label: added.label });
  if (shown.length === 0 && !error) return null;
  return h(
    'ul',
    { class: 'm4-member-status' },
    shown.map(account => {
      const name = String(account.label);
      const isNew = account.label === added?.label;
      const first = isNew ? firstReadOf(account) : undefined;
      const failures = [
        account.usageFailure !== undefined &&
        !(isNew && first?.state === 'failed')
          ? failureText(addMemberTexts.usageRead, account.usageFailure)
          : undefined,
        account.catalogFailure !== undefined
          ? failureText(addMemberTexts.catalogRead, account.catalogFailure)
          : undefined,
      ].filter(text => text !== undefined);
      const failed = first?.state === 'failed' || failures.length > 0;
      return h(
        'li',
        {
          key: name,
          class: failed ? 'failed' : (first?.state ?? ''),
          'data-member': name,
          ...(first ? { 'data-first-read': first.state } : {}),
          'aria-label': addMemberTexts.statusOf(name),
        },
        h('strong', null, name),
        first
          ? h(
              'div',
              {
                class: first.state === 'failed' ? 'm4-error' : 'm4-notice',
                role: first.state === 'failed' ? 'alert' : 'status',
              },
              first.text,
            )
          : null,
        ...failures.map(text =>
          h('div', { class: 'm4-error', 'data-failure': '' }, text),
        ),
        added !== undefined && isNew && first?.state === 'failed'
          ? h(
              'div',
              { class: 'm4-secret-actions' },
              h('span', { class: 'm4-note' }, addMemberTexts.tryAgainNote),
              h(
                'button',
                {
                  type: 'button',
                  class: 'm4-btn',
                  'data-action': 'try-again',
                  'aria-label': addMemberTexts.tryAgainNamed(name),
                  disabled: busy,
                  onClick: () => void act(() => feed.refresh(pool.backend)),
                },
                addMemberTexts.tryAgain,
              ),
              h(RetireButton, {
                name,
                disabled: busy,
                onRetire: () =>
                  void act(async () => {
                    await feed.retireMember(added.member);
                    onDone();
                    await feed.refresh(pool.backend);
                  }),
              }),
            )
          : null,
        isNew && first?.state === 'ok'
          ? h(
              'button',
              {
                type: 'button',
                class: 'm4-btn',
                'data-action': 'dismiss-first-read',
                onClick: onDone,
              },
              addMemberTexts.dismiss,
            )
          : null,
      );
    }),
    error ? h('li', { class: 'm4-error', role: 'alert' }, error) : null,
  );
};

/**
 * @param {{
 *   feed: import('./feed.js').AccountsFeed,
 *   pool: Record<string, any>,
 *   call?: (fn: () => Promise<any>) => Promise<any>,
 *   onAdded?: (added: { label: string, member: any }) => void,
 * }} props
 */
export const AddMember = ({
  feed,
  pool,
  call = fn => fn(),
  onAdded = () => {},
}) => {
  const provider = /** @type {Record<string, string>} */ (providerOfKind)[
    pool.kind
  ];
  /** @type {[boolean | undefined, (v: boolean | undefined) => void]} */
  const [canAdd, setCanAdd] = useState(
    /** @type {boolean | undefined} */ (undefined),
  );
  /** Who adds (`feed.addPath`): the manager, or the adapter over a pinned one. */
  /** @type {[string | undefined, (v: string | undefined) => void]} */
  const [path, setPath] = useState(
    /** @type {string | undefined} */ (undefined),
  );
  const [open, setOpen] = useState(false);
  /** @type {[any[] | undefined, (v: any[] | undefined) => void]} */
  const [secrets, setSecrets] = useState(
    /** @type {any[] | undefined} */ (undefined),
  );
  /** @type {[any[], (v: any[]) => void]} */
  const [unpooled, setUnpooled] = useState(/** @type {any[]} */ ([]));
  // The chosen Secret itself: a reloaded list cannot shift it to another.
  /** @type {[any, (v: any) => void]} */
  const [chosen, setChosen] = useState(/** @type {any} */ (undefined));
  const [label, setLabel] = useState('');
  /** @type {[{ ok: boolean, code?: string } | undefined, (v: any) => void]} */
  const [check, setCheck] = useState(
    /** @type {{ ok: boolean, code?: string } | undefined} */ (undefined),
  );
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Answers for an older opening or choice are dropped.
  const epoch = useRef(0);
  /** @type {{ current: any }} */
  const formRef = useRef(null);
  // Option values: one stable id per Secret presence (never its label).
  const ids = useRef(/** @type {WeakMap<object, string>} */ (new WeakMap()));
  const nextId = useRef(0);
  /** @param {any} secret */
  const idOf = secret => {
    let id = ids.current.get(secret);
    if (id === undefined) {
      nextId.current += 1;
      id = `s${nextId.current}`;
      ids.current.set(secret, id);
    }
    return id;
  };

  useEffect(() => {
    let live = true;
    call(() => feed.addPath()).then(
      answer => {
        if (!live) return;
        setPath(answer);
        setCanAdd(answer !== undefined);
      },
      () => {
        if (live) setCanAdd(false);
      },
    );
    return () => {
      live = false;
    };
  }, [feed]);

  const load = async () => {
    epoch.current += 1;
    const mine = epoch.current;
    try {
      const [entries, members] = await call(() =>
        Promise.all([feed.activeSecrets(), feed.unpooledMembers(provider)]),
      );
      if (mine !== epoch.current) return;
      setSecrets(entries);
      setUnpooled(members);
    } catch (thrown) {
      if (mine === epoch.current) {
        setSecrets([]);
        setError(messageOf(thrown));
      }
    }
  };

  useEffect(() => {
    if (open) void load();
    return () => {
      epoch.current += 1;
    };
  }, [open]);

  // Focus moves into the form when it opens (its first field once read).
  const ready = secrets !== undefined;
  useEffect(() => {
    if (!open) return;
    const field = formRef.current?.querySelector('select, input');
    (field ?? formRef.current?.querySelector('button'))?.focus();
  }, [open, ready]);

  // A chosen Secret no longer listed (revoked meanwhile) is no choice.
  const secret = secrets?.some(entry => entry.secret === chosen)
    ? chosen
    : undefined;

  /**
   * Run one action; errors shown inline.
   * @param {string} what the busy state
   * @param {() => Promise<void>} body
   */
  const act = async (what, body) => {
    setBusy(what);
    setError('');
    setNotice('');
    await null;
    try {
      await call(body);
    } catch (thrown) {
      setError(messageOf(thrown));
    } finally {
      setBusy('');
    }
  };

  /** The local refusals, before any call. */
  const missing = () => {
    if (secret === undefined) return addMemberTexts.needSecret;
    if (label.trim() === '') return addMemberTexts.needLabel;
    return '';
  };

  const runCheck = () => {
    if (secret === undefined) {
      setError(addMemberTexts.needSecret);
      return Promise.resolve();
    }
    const target = secret;
    return act('check', async () => {
      setCheck(undefined);
      const answer = await feed.checkCredential(pool.backend, target);
      if (target === secret) setCheck(answer);
    });
  };

  const add = () => {
    const refused = missing();
    if (refused) {
      setError(refused);
      return Promise.resolve();
    }
    const name = label.trim();
    return act('add', async () => {
      // One step: the manager refuses before it makes anything.
      const member = await feed.addSubscription(pool.backend, {
        secret,
        label: name,
      });
      setCheck(undefined);
      setChosen(undefined);
      setLabel('');
      setNotice(addMemberTexts.added);
      setOpen(false);
      onAdded({ label: name, member });
    });
  };

  /** @param {any} member */
  const addExisting = member =>
    act('add', async () => {
      try {
        await feed.addUnpooled(pool.backend, member);
        setNotice(addMemberTexts.added);
      } finally {
        await load();
      }
    });

  /** @param {any} member */
  const retire = member =>
    act('retire', async () => {
      try {
        await feed.retireMember(member);
      } finally {
        await load();
      }
    });

  /**
   * @param {string} action
   * @param {string} text
   * @param {() => void} onClick
   * @param {{ primary?: boolean, disabled?: boolean, name?: string }} [options]
   */
  const button = (action, text, onClick, { primary, disabled, name } = {}) =>
    h(
      'button',
      {
        type: 'button',
        class: primary ? 'm4-btn primary' : 'm4-btn',
        'data-action': action,
        ...(name === undefined ? {} : { 'aria-label': name }),
        disabled: busy !== '' || disabled === true,
        onClick,
      },
      text,
    );

  if (canAdd === false)
    return h(
      'p',
      { class: 'm4-note m4-add-member', 'data-note': 'manager-predates-add' },
      subscriptionTexts.managerPredatesAdd,
    );

  if (!open) {
    return h(
      'div',
      { class: 'm4-add-member' },
      button(
        'add-subscription',
        addMemberTexts.open,
        () => {
          setError('');
          setNotice('');
          setOpen(true);
        },
        { disabled: canAdd !== true },
      ),
      notice ? h('div', { class: 'm4-notice', role: 'status' }, notice) : null,
    );
  }

  const checkLine =
    check === undefined
      ? null
      : h(
          'div',
          {
            class: check.ok ? 'm4-notice' : 'm4-error',
            role: 'status',
            'data-check': check.ok ? 'ok' : String(check.code),
          },
          checkText(check),
        );

  return h(
    'form',
    {
      class: 'm4-add-member open',
      'data-pool': pool.label,
      ref: formRef,
      onSubmit: (/** @type {Event} */ event) => {
        event.preventDefault();
        void add();
      },
    },
    h('p', { class: 'm4-note' }, addMemberTexts.provider(provider)),
    secrets === undefined
      ? h('p', { class: 'm4-note' }, addMemberTexts.loading)
      : secrets.length === 0
        ? h('p', { class: 'm4-note' }, addMemberTexts.noSecrets)
        : h(
            'label',
            null,
            addMemberTexts.secret,
            h(
              'select',
              {
                class: 'm4-input',
                name: 'secret',
                value: secret === undefined ? '' : idOf(secret),
                disabled: busy !== '',
                onChange: (/** @type {any} */ event) => {
                  const value = String(event.currentTarget.value);
                  const entry = secrets.find(e => idOf(e.secret) === value);
                  setChosen(entry?.secret);
                  setCheck(undefined);
                  setError('');
                  if (label === '' && entry !== undefined)
                    setLabel(entry.label);
                },
              },
              h('option', { value: '' }, addMemberTexts.choose),
              secrets.map(entry =>
                h(
                  'option',
                  { key: idOf(entry.secret), value: idOf(entry.secret) },
                  entry.description
                    ? `${entry.label} — ${entry.description}`
                    : entry.label,
                ),
              ),
            ),
          ),
    h(
      'label',
      null,
      addMemberTexts.label,
      h('input', {
        class: 'm4-input',
        name: 'label',
        type: 'text',
        autocomplete: 'off',
        maxLength: limits.labelUnits,
        value: label,
        disabled: busy !== '',
        onInput: (/** @type {any} */ event) =>
          setLabel(event.currentTarget.value),
      }),
    ),
    checkLine,
    error ? h('div', { class: 'm4-error', role: 'alert' }, error) : null,
    notice ? h('div', { class: 'm4-notice', role: 'status' }, notice) : null,
    h(
      'div',
      { class: 'm4-secret-actions' },
      button(
        'check-credential',
        busy === 'check' ? addMemberTexts.checking : addMemberTexts.check,
        () => void runCheck(),
        { disabled: secret === undefined },
      ),
      button(
        'add-member',
        busy === 'add' ? addMemberTexts.adding : addMemberTexts.add,
        () => void add(),
        { primary: true, disabled: check !== undefined && !check.ok },
      ),
      button('cancel-add', addMemberTexts.cancel, () => {
        setOpen(false);
        setCheck(undefined);
        setError('');
      }),
    ),
    unpooled.length === 0
      ? null
      : h(
          'div',
          { class: 'm4-unpooled' },
          h('h4', null, addMemberTexts.unpooled),
          h(
            'p',
            { class: 'm4-note' },
            path === 'adapter'
              ? addMemberTexts.unpooledAgainNote
              : addMemberTexts.unpooledNote,
          ),
          h(
            'ul',
            null,
            unpooled.map(({ member, label: name }) =>
              h(
                'li',
                { key: idOf(member), 'data-unpooled': name },
                h('span', null, name),
                path === 'adapter'
                  ? null
                  : button(
                      'add-existing',
                      addMemberTexts.addExisting,
                      () => addExisting(member),
                      { name: addMemberTexts.addExistingNamed(name) },
                    ),
                h(RetireButton, {
                  name,
                  disabled: busy !== '',
                  onRetire: () => void retire(member),
                }),
              ),
            ),
          ),
        ),
  );
};
