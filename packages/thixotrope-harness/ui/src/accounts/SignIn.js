// @ts-check
/**
 * "Add account" and "Sign in again" (the Subscriptions panel): a guided
 * subscription sign-in a person can follow with no terminal.
 *
 * The page talks to the gateway's `SubscriptionSignIn` service
 * (`resources/agent-host/impl/subscriptions/sign-in-service.js`), which
 * runs in the agent host: the provider's tokens are exchanged and written
 * there and never come to this page. What this page sees is the
 * authorization page's address (Claude), the device page and its one-time
 * code (ChatGPT), and the state of the sign-in. What it sends is the pasted
 * `code#state` (Claude), or, as a fallback, a pasted login file, taken
 * from its field at the moment of sending and cleared (as the Secrets
 * panel sends values: over this page's WebSocket to the agent host, never
 * through the hub).
 *
 * - `AddAccount`: provider, label (default "Claude Account N" / "ChatGPT
 *   Account N"), pool (the provider's pool, else a new one), then the
 *   provider's steps; on success the Secret is written and the member is in
 *   the pool, and the pool list refreshes so it shows its usage reading.
 * - `SignInAgain`: the same steps for an existing member; its Secret's
 *   value is replaced in place (no new Secret or member).
 *
 * The page follows a sign-in with `PendingSignIn.wait(rev)`, which answers
 * when the state changes (or after a while unchanged), until it finishes.
 */
import { E } from '@endo/far';
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { limits } from '../../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */

/** The words of the sign-in (harness texts). */
export const signInTexts = harden({
  open: 'Add account',
  title: 'Add a subscription account',
  againTitle: /** @param {string} name */ name => `Sign in again: ${name}`,
  again: 'Sign in again',
  againNamed: /** @param {string} name */ name => `Sign in again to "${name}"`,
  provider: 'Provider',
  claude: 'Claude',
  codex: 'ChatGPT (Codex)',
  label: 'Account label',
  pool: 'Pool',
  newPool: /** @param {string} name */ name => `A new pool, "${name}"`,
  start: 'Start sign-in',
  starting: 'Starting…',
  cancel: 'Cancel',
  close: 'Close',
  startAgain: 'Start again',
  needLabel: 'Enter a label for this account',
  labelTaken: 'A subscription in this pool already has this label',
  noService:
    'This gateway cannot sign accounts in from the browser (it predates the feature).',
  asking: 'Asking ChatGPT for a one-time code…',
  saving: 'Saving the account…',
  expires: /** @param {string} at */ at => `This sign-in expires at ${at}.`,
  claudeSteps: [
    'Open the Claude sign-in page (it opens in a new tab).',
    'Sign in with the Claude account you want to add, then press Authorize.',
    'The page then shows a code. Copy all of it.',
    'Paste it here and press Finish.',
  ],
  claudeLink: 'Open the Claude sign-in page',
  code: 'Code from the page',
  finish: 'Finish',
  finishing: 'Finishing…',
  codexSteps: [
    'Open the ChatGPT device page (it opens in a new tab).',
    'Sign in with the ChatGPT account you want to add.',
    'Enter the one-time code shown below.',
    'Approve. This dialog notices by itself and finishes.',
  ],
  codexLink: 'Open the ChatGPT device page',
  userCode: 'One-time code',
  waiting: 'Waiting for you to approve…',
  deviceNote:
    'If ChatGPT refuses the code, device-code sign-in may need to be turned on in the security settings of this ChatGPT account. Or use a login file below.',
  fallback: 'Use a login file instead',
  fallbackCodex:
    'On a computer where "codex login" worked, open ~/.codex/auth.json, copy its whole contents and paste them here.',
  fallbackClaude:
    'Paste the contents of a Claude credentials export (the .credentials.json of a computer where Claude Code is signed in).',
  fallbackField: 'Login file contents',
  useFile: 'Use this file',
  noFile: 'Paste the file contents first',
  fileTooLarge: 'That is larger than a login file; nothing was sent',
  done: /** @param {string} name */ name => `Signed in: ${name}.`,
  created: harden({
    member: 'The account was added to the pool.',
    pool: 'The account was added to a new pool. Choose it as the backend of a preset (Settings, Presets) to use it in sessions.',
    replaced: 'The account’s credential was replaced.',
  }),
  failed: 'The sign-in did not finish.',
});

/** Login files larger than this are refused here (the service's bound). */
const LOGIN_FILE_UNITS = 64 * 1024;

/** The pool label a first account of a provider makes (the service's). */
export const defaultPoolLabels = harden({
  claude: 'Claude subscriptions',
  codex: 'ChatGPT subscriptions',
});

const kindOfProvider = harden({ claude: 'claude-pool', codex: 'codex-pool' });
const accountWord = harden({ claude: 'Claude', codex: 'ChatGPT' });

const TERMINAL = harden(['done', 'failed', 'expired', 'cancelled']);

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error =>
  error && typeof error === 'object' && 'message' in error
    ? String(/** @type {{ message: unknown }} */ (error).message)
    : String(error);

/**
 * The first free "Claude Account N" / "ChatGPT Account N".
 * @param {'claude' | 'codex'} provider
 * @param {any[]} pools the accounts view's pools
 */
export const defaultLabel = (provider, pools) => {
  const taken = new Set(
    pools.flatMap(pool => pool.members.map((/** @type {any} */ m) => m.label)),
  );
  for (let n = 1; ; n += 1) {
    const label = `${accountWord[provider]} Account ${n}`;
    if (!taken.has(label)) return label;
  }
};

/**
 * Follow one pending sign-in: its description, kept current with
 * `wait(rev)` while the component shows it.
 * @param {any} pending
 * @param {(fn: () => Promise<any>) => Promise<any>} call
 */
const useSignIn = (pending, call) => {
  const [view, setView] = useState(/** @type {any} */ (undefined));
  const [error, setError] = useState('');
  useEffect(() => {
    if (pending === undefined) return undefined;
    let live = true;
    setView(undefined);
    setError('');
    void (async () => {
      try {
        let current = await call(() => E(pending).describe());
        while (live) {
          setView(current);
          if (TERMINAL.includes(current.state)) break;
          // eslint-disable-next-line no-await-in-loop -- one wait at a time
          current = await E(pending).wait(current.rev);
        }
      } catch (thrown) {
        if (live) setError(messageOf(thrown));
      }
    })();
    return () => {
      live = false;
    };
  }, [pending]);
  return { view, setView, error, setError };
};

/**
 * The steps of one pending sign-in, and its outcome.
 * @param {{
 *   pending: any,
 *   call: (fn: () => Promise<any>) => Promise<any>,
 *   onDone: (view: any) => void,
 *   onRestart: () => void,
 *   onClose: () => void,
 * }} props
 */
const SignInSteps = ({ pending, call, onDone, onRestart, onClose }) => {
  const { view, setView, error, setError } = useSignIn(pending, call);
  const [busy, setBusy] = useState('');
  const codeField = useRef(/** @type {any} */ (null));
  const fileField = useRef(/** @type {any} */ (null));
  const reported = useRef(false);
  // A sign-in left behind (the panel closed) is cancelled, so it does not
  // hold one of the service's few places until it expires.
  const latest = useRef(/** @type {any} */ (undefined));
  latest.current = view;
  useEffect(
    () => () => {
      const last = latest.current;
      if (last === undefined || !TERMINAL.includes(last.state))
        E(pending)
          .cancel()
          .catch(() => {});
    },
    [pending],
  );

  useEffect(() => {
    if (view?.state === 'done' && !reported.current) {
      reported.current = true;
      onDone(view);
    }
  }, [view?.state]);

  /**
   * @param {string} what
   * @param {() => Promise<any>} body answers the new description
   */
  const act = async (what, body) => {
    setBusy(what);
    setError('');
    await null;
    try {
      const next = await call(body);
      if (next) setView(next);
    } catch (thrown) {
      setError(messageOf(thrown));
    } finally {
      setBusy('');
    }
  };

  const finishClaude = () => {
    const field = codeField.current;
    const pasted = String(field?.value ?? '').trim();
    if (field) field.value = '';
    return act('finish', () => E(pending).complete(pasted));
  };

  const useFile = () => {
    const field = fileField.current;
    const text = String(field?.value ?? '');
    if (field) field.value = '';
    if (text.trim() === '') {
      setError(signInTexts.noFile);
      return Promise.resolve();
    }
    if (text.length > LOGIN_FILE_UNITS) {
      setError(signInTexts.fileTooLarge);
      return Promise.resolve();
    }
    return act('file', () => E(pending).useLoginFile(text));
  };

  const closeButton = h(
    'button',
    {
      type: 'button',
      class: 'm4-btn',
      'data-action': 'close-sign-in',
      // Closing unmounts the steps, which cancels a sign-in still waiting.
      onClick: onClose,
    },
    view !== undefined && TERMINAL.includes(view.state)
      ? signInTexts.close
      : signInTexts.cancel,
  );

  const errorLine = error
    ? h('div', { class: 'm4-error', role: 'alert' }, error)
    : null;

  if (view === undefined)
    return h(
      'div',
      { class: 'm4-sign-in-steps' },
      errorLine ?? h('p', { class: 'm4-note' }, signInTexts.starting),
      h('div', { class: 'm4-secret-actions' }, closeButton),
    );

  if (view.state === 'done') {
    const created = /** @type {Record<string, string>} */ (signInTexts.created)[
      view.result?.created
    ];
    return h(
      'div',
      { class: 'm4-sign-in-steps', 'data-sign-in': 'done' },
      h(
        'div',
        { class: 'm4-notice', role: 'status' },
        `${signInTexts.done(view.label)}${created ? ` ${created}` : ''}`,
      ),
      h('div', { class: 'm4-secret-actions' }, closeButton),
    );
  }

  if (TERMINAL.includes(view.state)) {
    return h(
      'div',
      { class: 'm4-sign-in-steps', 'data-sign-in': view.state },
      h(
        'div',
        {
          class: 'm4-error',
          role: 'alert',
          'data-code': view.error?.code ?? view.state,
        },
        view.error?.text ?? signInTexts.failed,
      ),
      view.provider === 'codex' && view.error?.code === 'DEVICE_NOT_ENABLED'
        ? h('p', { class: 'm4-note' }, signInTexts.deviceNote)
        : null,
      errorLine,
      h(
        'div',
        { class: 'm4-secret-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'm4-btn primary',
            'data-action': 'restart-sign-in',
            onClick: onRestart,
          },
          signInTexts.startAgain,
        ),
        closeButton,
      ),
    );
  }

  const steps =
    view.provider === 'claude'
      ? signInTexts.claudeSteps
      : signInTexts.codexSteps;
  const fallback = h(
    'details',
    { class: 'm4-sign-in-fallback' },
    h('summary', null, signInTexts.fallback),
    h(
      'p',
      { class: 'm4-note' },
      view.provider === 'codex'
        ? signInTexts.fallbackCodex
        : signInTexts.fallbackClaude,
    ),
    h(
      'label',
      null,
      signInTexts.fallbackField,
      h('textarea', {
        class: 'm4-input m4-sign-in-file',
        name: 'login-file',
        rows: 4,
        autocomplete: 'off',
        spellcheck: false,
        ref: fileField,
        disabled: busy !== '' || view.state === 'finishing',
      }),
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'm4-btn',
        'data-action': 'use-login-file',
        disabled: busy !== '' || view.state === 'finishing',
        onClick: () => void useFile(),
      },
      signInTexts.useFile,
    ),
  );

  return h(
    'div',
    { class: 'm4-sign-in-steps', 'data-sign-in': view.state },
    view.state === 'starting'
      ? h('p', { class: 'm4-note', role: 'status' }, signInTexts.asking)
      : h(
          'ol',
          { class: 'm4-sign-in-list' },
          h(
            'li',
            null,
            steps[0],
            ' ',
            h(
              'a',
              {
                class: 'm4-btn primary',
                'data-action':
                  view.provider === 'claude' ? 'open-authorize' : 'open-device',
                href:
                  view.provider === 'claude'
                    ? view.authorizeUrl
                    : view.verificationUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
              },
              view.provider === 'claude'
                ? signInTexts.claudeLink
                : signInTexts.codexLink,
            ),
          ),
          h('li', null, steps[1]),
          view.provider === 'claude'
            ? h('li', null, steps[2])
            : h(
                'li',
                null,
                steps[2],
                h(
                  'div',
                  {
                    class: 'm4-sign-in-code',
                    'aria-label': signInTexts.userCode,
                    'data-user-code': '',
                  },
                  view.userCode,
                ),
              ),
          view.provider === 'claude'
            ? h(
                'li',
                null,
                steps[3],
                h(
                  'form',
                  {
                    class: 'm4-row-form',
                    onSubmit: (/** @type {Event} */ event) => {
                      event.preventDefault();
                      void finishClaude();
                    },
                  },
                  h('input', {
                    class: 'm4-input',
                    name: 'code',
                    type: 'text',
                    autocomplete: 'off',
                    spellcheck: false,
                    'aria-label': signInTexts.code,
                    placeholder: 'code#state',
                    ref: codeField,
                    disabled: busy !== '' || view.state === 'finishing',
                  }),
                  h(
                    'button',
                    {
                      type: 'submit',
                      class: 'm4-btn primary',
                      'data-action': 'finish-sign-in',
                      disabled: busy !== '' || view.state === 'finishing',
                    },
                    busy === 'finish'
                      ? signInTexts.finishing
                      : signInTexts.finish,
                  ),
                ),
              )
            : h(
                'li',
                null,
                steps[3],
                h(
                  'p',
                  { class: 'm4-note', role: 'status' },
                  view.state === 'finishing'
                    ? signInTexts.saving
                    : signInTexts.waiting,
                ),
              ),
        ),
    view.provider === 'codex' && view.state !== 'finishing'
      ? h('p', { class: 'm4-note' }, signInTexts.deviceNote)
      : null,
    view.provider === 'claude' && view.state === 'finishing'
      ? h('p', { class: 'm4-note', role: 'status' }, signInTexts.saving)
      : null,
    h(
      'p',
      { class: 'm4-note' },
      signInTexts.expires(
        new Date(view.expiresAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
      ),
    ),
    errorLine,
    fallback,
    h('div', { class: 'm4-secret-actions' }, closeButton),
  );
};

/**
 * The "Add account" button and its dialog.
 * @param {{
 *   feed: import('./feed.js').AccountsFeed,
 *   pools: any[],
 *   call?: (fn: () => Promise<any>) => Promise<any>,
 *   onChanged?: (pool: any) => void | Promise<void>,
 * }} props
 */
export const AddAccount = ({ feed, pools, call = fn => fn(), onChanged }) => {
  const [open, setOpen] = useState(false);
  /** @type {['claude' | 'codex', (v: 'claude' | 'codex') => void]} */
  const [provider, setProvider] = useState(
    /** @type {'claude' | 'codex'} */ ('claude'),
  );
  const [label, setLabel] = useState('');
  const [labelEdited, setLabelEdited] = useState(false);
  // The chosen pool's index among this provider's pools, or -1: a new one.
  const [poolIndex, setPoolIndex] = useState(0);
  const [pending, setPending] = useState(/** @type {any} */ (undefined));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const service = feed.signInService();

  const ofProvider = pools.filter(
    pool => pool.kind === kindOfProvider[provider],
  );
  const chosenPool =
    poolIndex >= 0 && poolIndex < ofProvider.length
      ? ofProvider[poolIndex]
      : undefined;
  const shownLabel = labelEdited ? label : defaultLabel(provider, pools);

  if (!open)
    return h(
      'div',
      { class: 'm4-add-account' },
      h(
        'button',
        {
          type: 'button',
          class: 'm4-btn primary',
          'data-action': 'add-account',
          onClick: () => {
            setError('');
            setPending(undefined);
            setOpen(true);
          },
        },
        signInTexts.open,
      ),
    );

  const close = () => {
    setOpen(false);
    setPending(undefined);
    setLabelEdited(false);
    setLabel('');
  };

  if (service === undefined)
    return h(
      'div',
      { class: 'm4-add-account open' },
      h(
        'p',
        { class: 'm4-note', 'data-note': 'no-sign-in' },
        signInTexts.noService,
      ),
      h(
        'button',
        { type: 'button', class: 'm4-btn', onClick: close },
        signInTexts.close,
      ),
    );

  const start = async () => {
    const name = shownLabel.trim();
    if (name === '') {
      setError(signInTexts.needLabel);
      return;
    }
    if (chosenPool?.members.some((/** @type {any} */ m) => m.label === name)) {
      setError(signInTexts.labelTaken);
      return;
    }
    setBusy(true);
    setError('');
    await null;
    try {
      const made = await call(() =>
        chosenPool === undefined
          ? E(service).begin(provider, name)
          : E(service).begin(provider, name, chosenPool.backend),
      );
      setPending(made);
    } catch (thrown) {
      setError(messageOf(thrown));
    } finally {
      setBusy(false);
    }
  };

  return h(
    'div',
    {
      class: 'm4-add-account open',
      role: 'group',
      'aria-label': signInTexts.title,
    },
    h('h3', null, signInTexts.title),
    pending !== undefined
      ? h(SignInSteps, {
          pending,
          call,
          onDone: () => {
            void onChanged?.(chosenPool?.backend);
          },
          onRestart: () => setPending(undefined),
          onClose: close,
        })
      : h(
          'form',
          {
            class: 'm4-sign-in-form',
            onSubmit: (/** @type {Event} */ event) => {
              event.preventDefault();
              void start();
            },
          },
          h(
            'fieldset',
            { class: 'm4-sign-in-providers' },
            h('legend', null, signInTexts.provider),
            .../** @type {const} */ (['claude', 'codex']).map(choice =>
              h(
                'label',
                { class: 'm4-sign-in-choice' },
                h('input', {
                  type: 'radio',
                  name: 'provider',
                  value: choice,
                  checked: provider === choice,
                  disabled: busy,
                  onChange: () => {
                    setProvider(choice);
                    setPoolIndex(0);
                    setError('');
                  },
                }),
                signInTexts[choice],
              ),
            ),
          ),
          h(
            'label',
            null,
            signInTexts.label,
            h('input', {
              class: 'm4-input',
              name: 'label',
              type: 'text',
              autocomplete: 'off',
              maxLength: limits.labelUnits,
              value: shownLabel,
              disabled: busy,
              onInput: (/** @type {any} */ event) => {
                setLabelEdited(true);
                setLabel(event.currentTarget.value);
              },
            }),
          ),
          h(
            'label',
            null,
            signInTexts.pool,
            h(
              'select',
              {
                class: 'm4-input',
                name: 'pool',
                value: String(chosenPool === undefined ? -1 : poolIndex),
                disabled: busy,
                onChange: (/** @type {any} */ event) =>
                  setPoolIndex(Number(event.currentTarget.value)),
              },
              ...ofProvider.map((pool, index) =>
                h('option', { value: String(index) }, pool.label),
              ),
              h(
                'option',
                { value: '-1' },
                signInTexts.newPool(defaultPoolLabels[provider]),
              ),
            ),
          ),
          error ? h('div', { class: 'm4-error', role: 'alert' }, error) : null,
          h(
            'div',
            { class: 'm4-secret-actions' },
            h(
              'button',
              {
                type: 'submit',
                class: 'm4-btn primary',
                'data-action': 'start-sign-in',
                disabled: busy,
              },
              busy ? signInTexts.starting : signInTexts.start,
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'm4-btn',
                'data-action': 'cancel-add-account',
                onClick: close,
              },
              signInTexts.cancel,
            ),
          ),
        ),
  );
};

/**
 * "Sign in again" for one member of a pool: its Secret is replaced in
 * place once the provider's steps succeed.
 * @param {{
 *   feed: import('./feed.js').AccountsFeed,
 *   pool: any,
 *   label: string,
 *   call?: (fn: () => Promise<any>) => Promise<any>,
 *   onChanged?: (pool: any) => void | Promise<void>,
 *   onClose: () => void,
 * }} props
 */
export const SignInAgain = ({
  feed,
  pool,
  label,
  call = fn => fn(),
  onChanged,
  onClose,
}) => {
  const [pending, setPending] = useState(/** @type {any} */ (undefined));
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const service = feed.signInService();

  useEffect(() => {
    if (service === undefined) return undefined;
    let live = true;
    setPending(undefined);
    setError('');
    void (async () => {
      try {
        const made = await call(async () => {
          const member = await feed.memberOf(pool.backend, label);
          if (member === undefined)
            throw Error(`No active subscription "${label}" in this pool`);
          return E(service).beginAgain(pool.backend, member);
        });
        if (live) setPending(made);
        else
          E(made)
            .cancel()
            .catch(() => {});
      } catch (thrown) {
        if (live) setError(messageOf(thrown));
      }
    })();
    return () => {
      live = false;
    };
  }, [pool.backend, label, attempt]);

  return h(
    'div',
    {
      class: 'm4-add-account open',
      role: 'group',
      'aria-label': signInTexts.againTitle(label),
      'data-again': label,
    },
    h('h3', null, signInTexts.againTitle(label)),
    service === undefined
      ? h('p', { class: 'm4-note' }, signInTexts.noService)
      : null,
    error ? h('div', { class: 'm4-error', role: 'alert' }, error) : null,
    pending !== undefined
      ? h(SignInSteps, {
          pending,
          call,
          onDone: () => {
            void onChanged?.(pool.backend);
          },
          onRestart: () => setAttempt(n => n + 1),
          onClose,
        })
      : h(
          'div',
          { class: 'm4-secret-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'm4-btn',
              'data-action': 'close-sign-in',
              onClick: onClose,
            },
            signInTexts.close,
          ),
        ),
  );
};
