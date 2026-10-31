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

// The filesystem-mount and scratch-space create flows — the shippable-today
// item types in the chat-inventory-create-menu design (design § 1 Filesystem
// mount, § 2 Scratch space). Both compose already-landed daemon primitives:
//
//   E(powers).provideMount(hostPath, petName)   — a live mount of a host dir
//   E(powers).provideScratchMount(petName)      — daemon-owned ephemeral storage
//
// There is no new daemon machinery here (the design excludes it): the modal
// gathers the pet name (both) and host path (mount only), validates locally,
// calls the verb, and surfaces the daemon's rejection (EACCES / ENOTDIR / name
// collision) as a per-field error bubble. The host filesystem picker the design
// names is a documented follow-up; the text path field is the shippable input.

/**
 * @typedef {'mount' | 'scratch'} MountKind
 */

/**
 * Local pet-name validation shared by both flows: non-empty, and not a reserved
 * special (`@`-prefixed) name. "Already in scope" collisions are left to the
 * daemon, whose rejection surfaces as the submit error.
 *
 * @param {string} petName
 * @returns {string | null} an error string, or null when valid
 */
const validatePetName = petName => {
  const trimmed = petName.trim();
  if (trimmed === '') return 'Pet name is required.';
  if (isSpecialName(trimmed)) {
    return 'Pet name cannot be a reserved special (@-prefixed) name.';
  }
  return null;
};

/**
 * The confined modal view. Holds its own field + error + submitting state via
 * hooks; the daemon calls thread through the `powers`/`onCreated`/`onClose`
 * props the host factory supplies.
 *
 * @param {object} props
 * @param {MountKind} props.kind
 * @param {ERef<EndoHost>} props.powers
 * @param {(petName: string) => void} props.onCreated
 * @param {() => void} props.onClose
 */
const CreateMountView = ({ kind, powers, onCreated, onClose }) => {
  const [petName, setPetName] = useState('');
  const [hostPath, setHostPath] = useState('');
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [submitting, setSubmitting] = useState(false);

  const isMount = kind === 'mount';
  const title = isMount ? 'New filesystem mount' : 'New scratch space';
  const description = isMount
    ? 'Mount a directory on this host under a pet name.'
    : 'Allocate daemon-owned scratch storage under a pet name.';

  const submit = () => {
    if (submitting) return;
    const nameError = validatePetName(petName);
    if (nameError) {
      setError(nameError);
      return;
    }
    const trimmedName = petName.trim();
    const trimmedPath = hostPath.trim();
    if (isMount && trimmedPath === '') {
      setError('Host path is required.');
      return;
    }
    setError(null);
    setSubmitting(true);
    const resultP = isMount
      ? E(powers).provideMount(trimmedPath, trimmedName)
      : E(powers).provideScratchMount(trimmedName);
    resultP.then(
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

  return h(
    Fragment,
    null,
    h('div', { class: 'create-modal-backdrop', onClick: onClose }),
    h(
      'div',
      {
        class: 'create-modal',
        role: 'dialog',
        'aria-label': title,
        onKeyDown: (/** @type {{ key: string }} */ e) => {
          if (e.key === 'Escape') onClose();
        },
      },
      h(
        'div',
        { class: 'create-modal-header' },
        h('span', { class: 'create-modal-title' }, title),
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
      h('div', { class: 'create-modal-desc' }, description),
      h(
        'div',
        { class: 'create-modal-field' },
        h('label', { for: 'create-mount-petname' }, 'Pet name'),
        h('input', {
          type: 'text',
          id: 'create-mount-petname',
          class: 'create-modal-input',
          placeholder: 'my-files',
          value: petName,
          autocomplete: 'off',
          autofocus: true,
          onInput: (/** @type {{ target: { value: string } }} */ e) =>
            setPetName(e.target.value),
          onKeyDown: (/** @type {{ key: string }} */ e) => {
            if (e.key === 'Enter' && !isMount) submit();
          },
        }),
      ),
      isMount
        ? h(
            'div',
            { class: 'create-modal-field' },
            h('label', { for: 'create-mount-path' }, 'Host path'),
            h('input', {
              type: 'text',
              id: 'create-mount-path',
              class: 'create-modal-input',
              placeholder: '/home/you/project',
              value: hostPath,
              autocomplete: 'off',
              onInput: (/** @type {{ target: { value: string } }} */ e) =>
                setHostPath(e.target.value),
              onKeyDown: (/** @type {{ key: string }} */ e) => {
                if (e.key === 'Enter') submit();
              },
            }),
            h(
              'div',
              { class: 'create-modal-hint' },
              'An absolute path to a directory. A host file picker is a follow-up.',
            ),
          )
        : h(
            'div',
            { class: 'create-modal-hint' },
            'Storage lives as long as the pet name is reachable; removing it lets the daemon reclaim the space.',
          ),
      error ? h('div', { class: 'create-modal-error' }, error) : null,
      h(
        'div',
        { class: 'create-modal-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'create-modal-cancel',
            onClick: onClose,
          },
          'Cancel',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'create-modal-submit',
            disabled: submitting,
            onClick: submit,
          },
          submitting ? 'Creating…' : 'Create',
        ),
      ),
    ),
  );
};
harden(CreateMountView);

/**
 * Host factory for the mount / scratch create modal. Renders the confined view
 * into `$container` on `show(kind)` and tears it down on `hide()`.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.$container
 * @param {() => ERef<EndoHost>} opts.getPowers - Returns the powers for the
 *   currently-displayed inventory (the active profile), resolved lazily so a
 *   profile switch is honored.
 * @param {(petName: string) => void} [opts.onCreated]
 * @returns {{ show: (kind: MountKind) => void, hide: () => void }}
 */
export const createMountModal = ({ $container, getPowers, onCreated }) => {
  const hide = () => {
    unmount($container);
    $container.innerHTML = '';
  };

  /** @param {MountKind} kind */
  const show = kind => {
    renderConfined(
      h(CreateMountView, {
        kind,
        powers: getPowers(),
        onCreated: petName => {
          if (onCreated) onCreated(petName);
        },
        onClose: hide,
      }),
      $container,
    );
    // Focus the first field once the confined tree is mounted (refs are
    // stripped under confinement, so reach for the rendered input host-side).
    const $first = /** @type {HTMLInputElement | null} */ (
      $container.querySelector('.create-modal-input')
    );
    if ($first) $first.focus();
  };

  return harden({ show, hide });
};
harden(createMountModal);
