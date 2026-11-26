// @ts-check

/** @import { ERef } from '@endo/eventual-send' */
/** @import { EndoHost } from '@endo/daemon' */

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { isSpecialName } from '@endo/daemon/pet-name.js';

import {
  Fragment,
  h,
  renderConfined,
  unmount,
  useState,
} from './setup-preact-container.js';
import { PROVIDERS, getProvider } from './provider-registry-client.js';

// The new-agent wizard — the substantive create flow of the
// chat-inventory-create-menu design (design § New-Agent Workflow). Three panes
// in one modal:
//
//   Pane 1  Harness selection      Lal / Fae / Genie (transitional; they
//                                  converge into a unified Endo agent harness).
//   Pane 2  Inference source       Provider by NAME (URLs hidden), API-key
//                                  paste per authShape, model pick.
//   Pane 3  Endowments             The nine capability-bank rows, shipped as a
//                                  documentation-only checklist this phase
//                                  (design § Phase 4).
//
// Submit does NOT introduce a new daemon API (the design excludes daemon
// changes). It does what a user would do by hand: it finds the chosen harness's
// outstanding configuration `form` message in the host inbox and submits it
// with { name, host, model, authToken } — the exact substrate setup-lal.js /
// setup-llm-provider.js drive from the CLI, here driven from Chat.

const HARNESSES = harden([
  {
    id: 'lal',
    name: 'Lal',
    description: 'Reply-chain transcripts; static tools.',
    // Manager-handle names that send Lal's provisioning form. The wizard
    // matches an outstanding form's sender against these on submit.
    formSenders: ['setup-lal', 'lal'],
  },
  {
    id: 'fae',
    name: 'Fae',
    description: 'Flat transcripts; dynamic tool discovery.',
    formSenders: ['llm-provider-factory-handle', 'setup-fae', 'fae'],
  },
  {
    id: 'genie',
    name: 'Genie',
    description: 'Sandboxed workspace; agentic coding via pi-ai.',
    formSenders: ['setup-genie', 'genie'],
  },
]);

// Pane 3's roster — the nine capability-bank families, documentation-only this
// phase. `@fs` is the first that will gain a working control (it composes the
// shippable mount flow); the rest surface the architectural direction.
const ENDOWMENT_ROWS = harden([
  {
    key: '@main',
    label: '@main worker',
    note: 'Runs on @main today; explicit per-tool worker choice arrives with the unified harness.',
  },
  {
    key: '@fs',
    label: '@fs (filesystem)',
    note: 'A scratch/snapshot mount or an existing mount-cap. Couples with @main for a posix sandbox.',
  },
  {
    key: '@node',
    label: 'Process execution (@node)',
    note: 'Sandboxed child-process capability; opt-in only inside an @fs + @main sandbox.',
  },
  {
    key: 'network',
    label: 'Network',
    note: 'A denial-pattern-attenuated fetch endowment with per-origin allow/deny.',
  },
  {
    key: 'git',
    label: 'Git operations',
    note: 'Composed with @fs and optionally network; ASKPASS credential injection.',
  },
  {
    key: 'env',
    label: 'Environment variables',
    note: 'A per-key attenuation map; the agent sees only the keys you grant.',
  },
  {
    key: 'credentials',
    label: 'Credential store',
    note: 'Share a subset of your provider credentials with a delegate agent.',
  },
  {
    key: 'userio',
    label: 'User I/O',
    note: 'Electron notifications / the Familiar tray for surfaces beyond the reply chain.',
  },
  {
    key: 'timer',
    label: 'Timer',
    note: "The daemon's timer formula, rate-limited by denial patterns.",
  },
  {
    key: 'delegates',
    label: 'Delegates',
    note: 'The right to create further agents (recursive attenuation).',
  },
]);

/**
 * Find and submit the chosen harness's outstanding configuration form.
 * Composes existing host primitives only (listMessages / reverseLocate /
 * submit). Throws a user-facing error when no matching form is outstanding.
 *
 * @param {ERef<EndoHost>} powers
 * @param {{ id: string, name: string, formSenders: string[] }} harness
 * @param {Record<string, string>} values - { name, host, model, authToken }
 */
const submitToManagerForm = async (powers, harness, values) => {
  const messages =
    /** @type {Array<{ type: string, number: bigint, from: string }>} */ (
      await E(powers).listMessages()
    );
  const forms = messages.filter(m => m.type === 'form');
  if (forms.length === 0) {
    throw new Error(
      `No outstanding provisioning form found. Start the ${harness.name} manager so it sends its configuration form, then submit again.`,
    );
  }

  // Resolve every form sender's name(s) in parallel, then prefer a form whose
  // sender matches this harness's known manager handles.
  const senderNames = await Promise.all(
    forms.map(form =>
      E(powers)
        .reverseLocate(form.from)
        .then(
          names => /** @type {string[]} */ (names),
          () => /** @type {string[]} */ ([]),
        ),
    ),
  );
  /** @type {{ number: bigint } | undefined} */
  let chosen;
  for (let i = 0; i < forms.length; i += 1) {
    if (senderNames[i].some(n => harness.formSenders.includes(n))) {
      chosen = forms[i];
      break;
    }
  }
  // Fall back to the sole outstanding form when the sender is unrecognized
  // (a manager handle the wizard does not yet know by name).
  if (!chosen && forms.length === 1) {
    chosen = forms[0];
  }
  if (!chosen) {
    throw new Error(
      `Found ${forms.length} provisioning forms but none from the ${harness.name} manager. Open the inbox and submit the right one by hand, or start the ${harness.name} manager.`,
    );
  }
  await E(powers).submit(chosen.number, values);
};

/**
 * The confined wizard view.
 *
 * @param {object} props
 * @param {ERef<EndoHost>} props.powers
 * @param {Set<string>} props.detected - Harness ids detected in the namespace.
 * @param {() => void} props.onClose
 * @param {(petName: string) => void} props.onCreated
 */
const AgentWizardView = ({ powers, detected, onClose, onCreated }) => {
  const [step, setStep] = useState(0);
  const [harnessId, setHarnessId] = useState(HARNESSES[0].id);
  const [providerId, setProviderId] = useState(PROVIDERS[0].id);
  const [apiKey, setApiKey] = useState('');
  const [remoteHost, setRemoteHost] = useState('');
  const [model, setModel] = useState('');
  const [showAttribution, setShowAttribution] = useState(false);
  const [referer, setReferer] = useState('');
  const [appName, setAppName] = useState('');
  const [petName, setPetName] = useState('');
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [submitting, setSubmitting] = useState(false);

  const harness = HARNESSES.find(x => x.id === harnessId) || HARNESSES[0];
  const provider = getProvider(providerId) || PROVIDERS[0];

  const goNext = () => {
    setError(null);
    setStep(s => Math.min(s + 1, 2));
  };
  const goBack = () => {
    setError(null);
    setStep(s => Math.max(s - 1, 0));
  };

  const submit = () => {
    if (submitting) return;
    const trimmedName = petName.trim();
    if (trimmedName === '') {
      setError('Agent pet name is required.');
      return;
    }
    if (isSpecialName(trimmedName)) {
      setError('Pet name cannot be a reserved special (@-prefixed) name.');
      return;
    }
    if (provider.authShape === 'apiKey' && apiKey.trim() === '') {
      setError(`${provider.name} needs an API key.`);
      return;
    }
    if (model.trim() === '') {
      setError('Pick or type a model.');
      return;
    }
    const host =
      provider.hostEditable && remoteHost.trim() !== ''
        ? remoteHost.trim()
        : provider.baseUrl;
    const values = harden({
      name: trimmedName,
      host,
      model: model.trim(),
      authToken: apiKey.trim(),
    });
    setError(null);
    setSubmitting(true);
    submitToManagerForm(powers, harness, values).then(
      () => {
        setSubmitting(false);
        onCreated(trimmedName);
        onClose();
      },
      err => {
        setSubmitting(false);
        setError(/** @type {Error} */ (err).message || String(err));
      },
    );
  };

  // ── Pane 1: harness ──────────────────────────────────────────────────────
  const pane1 = h(
    'div',
    { class: 'wizard-pane' },
    h('div', { class: 'wizard-pane-title' }, '1. Harness'),
    h(
      'div',
      {
        class: 'wizard-radio-group',
        role: 'radiogroup',
        'aria-label': 'Harness',
      },
      HARNESSES.map(x =>
        h(
          'label',
          {
            key: x.id,
            class: ['wizard-radio-row', harnessId === x.id && 'selected']
              .filter(Boolean)
              .join(' '),
          },
          h('input', {
            type: 'radio',
            name: 'wizard-harness',
            checked: harnessId === x.id,
            onChange: () => setHarnessId(x.id),
          }),
          h(
            'span',
            { class: 'wizard-radio-body' },
            h(
              'span',
              { class: 'wizard-radio-label' },
              x.name,
              detected.has(x.id)
                ? h('span', { class: 'wizard-badge detected' }, 'detected')
                : h('span', { class: 'wizard-badge' }, 'not detected'),
            ),
            h('span', { class: 'wizard-radio-desc' }, x.description),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'wizard-note' },
      'These harnesses will converge into a unified Endo agent harness; this choice will go away.',
    ),
  );

  // ── Pane 2: inference source ─────────────────────────────────────────────
  const pane2 = h(
    'div',
    { class: 'wizard-pane' },
    h('div', { class: 'wizard-pane-title' }, '2. Inference source'),
    h(
      'div',
      {
        class: 'wizard-radio-group',
        role: 'radiogroup',
        'aria-label': 'Provider',
      },
      PROVIDERS.map(p =>
        h(
          'label',
          {
            key: p.id,
            class: ['wizard-radio-row', providerId === p.id && 'selected']
              .filter(Boolean)
              .join(' '),
          },
          h('input', {
            type: 'radio',
            name: 'wizard-provider',
            checked: providerId === p.id,
            onChange: () => {
              setProviderId(p.id);
              setModel('');
            },
          }),
          h(
            'span',
            { class: 'wizard-radio-body' },
            h('span', { class: 'wizard-radio-label' }, p.name),
            h('span', { class: 'wizard-radio-desc' }, p.description),
          ),
        ),
      ),
    ),
    // Auth path by authShape (the seam the future OAuth button plugs into).
    provider.authShape === 'apiKey'
      ? h(
          'div',
          { class: 'wizard-field' },
          h('label', { for: 'wizard-apikey' }, 'API key'),
          h('input', {
            type: 'password',
            id: 'wizard-apikey',
            class: 'wizard-input',
            placeholder: 'paste your key',
            value: apiKey,
            autocomplete: 'off',
            onInput: (/** @type {{ target: { value: string } }} */ e) =>
              setApiKey(e.target.value),
          }),
          h(
            'div',
            { class: 'wizard-hint' },
            'Subscription sign-in (OAuth) is a later phase; paste a key for now.',
          ),
        )
      : h(
          'div',
          { class: 'wizard-hint' },
          provider.localAutoDetect
            ? 'No API key needed; this connects to Ollama on this machine.'
            : 'No API key needed by default.',
        ),
    // Ollama Remote surfaces a host field as a first-class control.
    provider.hostEditable
      ? h(
          'div',
          { class: 'wizard-field' },
          h('label', { for: 'wizard-remote-host' }, 'Ollama host'),
          h('input', {
            type: 'text',
            id: 'wizard-remote-host',
            class: 'wizard-input',
            placeholder: 'http://other-machine:11434/v1',
            value: remoteHost,
            autocomplete: 'off',
            onInput: (/** @type {{ target: { value: string } }} */ e) =>
              setRemoteHost(e.target.value),
          }),
        )
      : null,
    // OpenRouter attribution disclosure.
    provider.attribution
      ? h(
          'div',
          { class: 'wizard-disclosure' },
          h(
            'button',
            {
              type: 'button',
              class: 'wizard-disclosure-toggle',
              onClick: () => setShowAttribution(v => !v),
            },
            `${showAttribution ? '▾' : '▸'} Attribution (optional)`,
          ),
          showAttribution
            ? h(
                'div',
                { class: 'wizard-disclosure-body' },
                h('input', {
                  type: 'text',
                  class: 'wizard-input',
                  placeholder: 'HTTP-Referer',
                  value: referer,
                  autocomplete: 'off',
                  onInput: (/** @type {{ target: { value: string } }} */ e) =>
                    setReferer(e.target.value),
                }),
                h('input', {
                  type: 'text',
                  class: 'wizard-input',
                  placeholder: 'X-Title (app name)',
                  value: appName,
                  autocomplete: 'off',
                  onInput: (/** @type {{ target: { value: string } }} */ e) =>
                    setAppName(e.target.value),
                }),
              )
            : null,
        )
      : null,
    h(
      'div',
      { class: 'wizard-field' },
      h('label', { for: 'wizard-model' }, 'Model'),
      h('input', {
        type: 'text',
        id: 'wizard-model',
        class: 'wizard-input',
        list: 'wizard-model-list',
        placeholder: 'model id',
        value: model,
        autocomplete: 'off',
        onInput: (/** @type {{ target: { value: string } }} */ e) =>
          setModel(e.target.value),
      }),
      h(
        'datalist',
        { id: 'wizard-model-list' },
        provider.models.map(m => h('option', { key: m, value: m })),
      ),
      provider.modelHint
        ? h('div', { class: 'wizard-hint' }, provider.modelHint)
        : null,
    ),
  );

  // ── Pane 3: endowments (documentation-only this phase) ────────────────────
  const pane3 = h(
    'div',
    { class: 'wizard-pane' },
    h('div', { class: 'wizard-pane-title' }, '3. Endowments'),
    h(
      'div',
      { class: 'wizard-note' },
      'Endowment delivery lands in a later phase. This checklist documents the capability bank the agent will draw from; every capability is omitted by default (absence is the safer default).',
    ),
    h(
      'div',
      { class: 'wizard-endowments' },
      ENDOWMENT_ROWS.map(row =>
        h(
          'label',
          { key: row.key, class: 'wizard-endowment-row disabled' },
          h('input', { type: 'checkbox', disabled: true }),
          h(
            'span',
            { class: 'wizard-endowment-body' },
            h('span', { class: 'wizard-endowment-label' }, row.label),
            h('span', { class: 'wizard-endowment-note' }, row.note),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'wizard-field' },
      h('label', { for: 'wizard-petname' }, 'Agent pet name'),
      h('input', {
        type: 'text',
        id: 'wizard-petname',
        class: 'wizard-input',
        placeholder: 'my-agent',
        value: petName,
        autocomplete: 'off',
        onInput: (/** @type {{ target: { value: string } }} */ e) =>
          setPetName(e.target.value),
      }),
    ),
  );

  const panes = [pane1, pane2, pane3];

  return h(
    Fragment,
    null,
    h('div', { class: 'create-modal-backdrop', onClick: onClose }),
    h(
      'div',
      {
        class: 'create-modal wizard-modal',
        role: 'dialog',
        'aria-label': 'New agent',
        onKeyDown: (/** @type {{ key: string }} */ e) => {
          if (e.key === 'Escape') onClose();
        },
      },
      h(
        'div',
        { class: 'create-modal-header' },
        h('span', { class: 'create-modal-title' }, 'New agent'),
        h(
          'button',
          {
            type: 'button',
            class: 'create-modal-close',
            title: 'Close (Esc)',
            onClick: onClose,
          },
          '×',
        ),
      ),
      h(
        'div',
        { class: 'wizard-steps' },
        ['Harness', 'Inference', 'Endowments'].map((label, i) =>
          h(
            'span',
            {
              key: label,
              class: ['wizard-step', i === step && 'active', i < step && 'done']
                .filter(Boolean)
                .join(' '),
            },
            `${i + 1}. ${label}`,
          ),
        ),
      ),
      panes[step],
      error ? h('div', { class: 'create-modal-error' }, error) : null,
      h(
        'div',
        { class: 'create-modal-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'create-modal-cancel',
            onClick: step === 0 ? onClose : goBack,
          },
          step === 0 ? 'Cancel' : 'Back',
        ),
        step < 2
          ? h(
              'button',
              {
                type: 'button',
                class: 'create-modal-submit',
                onClick: goNext,
              },
              'Next',
            )
          : h(
              'button',
              {
                type: 'button',
                class: 'create-modal-submit',
                disabled: submitting,
                onClick: submit,
              },
              submitting ? 'Provisioning…' : 'Create agent',
            ),
      ),
    ),
  );
};
harden(AgentWizardView);

/**
 * Best-effort harness discovery: which of Lal/Fae/Genie are introduced in the
 * current namespace. Non-fatal — the wizard offers all three and annotates
 * detection, since the submit path depends on an outstanding manager form, not
 * on this probe.
 *
 * @param {ERef<EndoHost>} powers
 * @returns {Promise<Set<string>>}
 */
const detectHarnesses = async powers => {
  const found = new Set();
  const names = /** @type {string[]} */ (
    await E(powers)
      .list()
      .catch(() => [])
  );
  const lower = names.map(n => n.toLowerCase());
  for (const harness of HARNESSES) {
    if (lower.some(n => n === harness.id || n.includes(harness.id))) {
      found.add(harness.id);
    }
  }
  return found;
};

/**
 * Host factory for the new-agent wizard.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.$container
 * @param {() => ERef<EndoHost>} opts.getPowers
 * @param {(petName: string) => void} [opts.onCreated]
 * @returns {{ show: () => void, hide: () => void }}
 */
export const createAgentWizard = ({ $container, getPowers, onCreated }) => {
  const hide = () => {
    unmount($container);
    $container.innerHTML = '';
  };

  const render = (/** @type {Set<string>} */ detected) => {
    renderConfined(
      h(AgentWizardView, {
        powers: getPowers(),
        detected,
        onClose: hide,
        onCreated: petName => {
          if (onCreated) onCreated(petName);
        },
      }),
      $container,
    );
  };

  const show = () => {
    // Render immediately with an empty detection set so the modal appears
    // without waiting on the daemon, then re-render once discovery resolves.
    render(new Set());
    detectHarnesses(getPowers()).then(
      detected => render(detected),
      () => {},
    );
  };

  return harden({ show, hide });
};
harden(createAgentWizard);
