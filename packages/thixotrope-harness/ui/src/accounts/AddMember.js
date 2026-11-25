// @ts-check
/**
 * "Add subscription" for one pool (m4-interfaces.md 3.1, 10): choose an
 * active Secret from the catalogue, name the subscription, check that the
 * Secret holds a credential of the pool's provider (the adapter reads it;
 * this page sees only ok or a code, shown in plain words), then add it.
 * The provider is the pool's. The Secret and pool presences go to the
 * admin as they are: nothing is looked up by name, and no secret content
 * is ever read here.
 *
 * Members left in no pool (a break between `makeMember` and
 * `addPoolMember`) of this provider are listed with Add and Retire.
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

/** The form's own words (harness texts). */
export const addMemberTexts = harden({
  open: 'Add subscription',
  cancel: 'Cancel',
  secret: 'Secret',
  choose: 'Choose a secret…',
  label: 'Subscription label',
  check: 'Check',
  checking: 'Checking…',
  add: 'Add',
  adding: 'Adding…',
  loading: 'Reading secrets…',
  noSecrets: 'No active secrets. Add one under Secrets first.',
  needSecret: 'Choose a secret',
  needLabel: 'Enter a label for this subscription',
  added: 'Subscription added to the pool',
  unpooled: 'Not in a pool yet',
  addExisting: 'Add to this pool',
  retire: 'Retire',
  /** @param {string} provider */
  provider: provider => `Provider: ${provider} (fixed by the pool)`,
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
 * @param {{
 *   feed: import('./feed.js').AccountsFeed,
 *   pool: Record<string, any>,
 *   call?: (fn: () => Promise<any>) => Promise<any>,
 * }} props
 */
export const AddMember = ({ feed, pool, call = fn => fn() }) => {
  const provider = /** @type {Record<string, string>} */ (providerOfKind)[
    pool.kind
  ];
  const [open, setOpen] = useState(false);
  /** @type {[any[] | undefined, (v: any[] | undefined) => void]} */
  const [secrets, setSecrets] = useState(
    /** @type {any[] | undefined} */ (undefined),
  );
  /** @type {[any[], (v: any[]) => void]} */
  const [unpooled, setUnpooled] = useState(/** @type {any[]} */ ([]));
  const [chosen, setChosen] = useState(-1);
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

  const secret = secrets?.[chosen]?.secret;

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
      if (secrets?.[chosen]?.secret === target) setCheck(answer);
    });
  };

  const add = () => {
    const refused = missing();
    if (refused) {
      setError(refused);
      return Promise.resolve();
    }
    return act('add', async () => {
      try {
        await feed.addSubscription(pool.backend, {
          secret,
          label: label.trim(),
          provider,
        });
      } catch (thrown) {
        // A refused add may have left the member in no pool: show it.
        void load();
        throw thrown;
      }
      setCheck(undefined);
      setChosen(-1);
      setLabel('');
      setNotice(addMemberTexts.added);
      await load();
    });
  };

  /** @param {any} member */
  const addExisting = member =>
    act('add', async () => {
      try {
        await feed.addMember(pool.backend, member);
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
   * @param {{ primary?: boolean, disabled?: boolean }} [options]
   */
  const button = (action, text, onClick, { primary, disabled } = {}) =>
    h(
      'button',
      {
        type: 'button',
        class: primary ? 'm4-btn primary' : 'm4-btn',
        'data-action': action,
        disabled: busy !== '' || disabled === true,
        onClick,
      },
      text,
    );

  if (!open) {
    return h(
      'div',
      { class: 'm4-add-member' },
      button('add-subscription', addMemberTexts.open, () => {
        setError('');
        setNotice('');
        setOpen(true);
      }),
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
                value: String(chosen),
                disabled: busy !== '',
                onChange: (/** @type {any} */ event) => {
                  const index = Number(event.currentTarget.value);
                  setChosen(index);
                  setCheck(undefined);
                  setError('');
                  if (label === '' && index >= 0)
                    setLabel(secrets[index].label);
                },
              },
              h('option', { value: '-1' }, addMemberTexts.choose),
              secrets.map((entry, index) =>
                h(
                  'option',
                  { key: index, value: String(index) },
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
            'ul',
            null,
            unpooled.map(({ member, label: name }, index) =>
              h(
                'li',
                { key: index, 'data-unpooled': name },
                h('span', null, name),
                button('add-existing', addMemberTexts.addExisting, () =>
                  addExisting(member),
                ),
                button('retire-member', addMemberTexts.retire, () =>
                  retire(member),
                ),
              ),
            ),
          ),
        ),
  );
};
