// @ts-check

/** @import { ERef } from '@endo/eventual-send' */
/** @import { EndoHost } from '@endo/daemon' */

import harden from '@endo/harden';

import {
  Fragment,
  h,
  renderConfined,
  unmount,
  useState,
} from './setup-preact-container.js';
import { createMountModal } from './create-mount-modal.js';
import { createPlaceholderModal } from './create-placeholder-modal.js';
import { createAgentWizard } from './create-agent-wizard.js';

// The inventory `+` create menu — the pop-over that lists the whole-cloth item
// types Chat can mint (design § UI Affordance, § Whole-cloth Item Types). It is
// a pop-over (not a modal), anchored to the `+` button at the TOP of the
// inventory, honoring the slash-command selector's keyboard discipline: arrow
// keys navigate, Enter picks, Escape dismisses.
//
// Picking a type hands off to the right modal: the working mount / scratch
// flows, the documented passable / structured placeholders, or the three-pane
// new-agent wizard.

/**
 * @typedef {object} MenuItem
 * @property {string} key
 * @property {string} icon
 * @property {string} label
 * @property {string} description
 * @property {boolean} [ready] - Whether the flow is live (vs. placeholder).
 */

/** @type {MenuItem[]} */
const MENU_ITEMS = harden([
  {
    key: 'mount',
    icon: '📁',
    label: 'Filesystem mount',
    description: 'Mount a host directory under a pet name.',
    ready: true,
  },
  {
    key: 'scratch',
    icon: '🗒️',
    label: 'Scratch space',
    description: 'Daemon-owned ephemeral storage.',
    ready: true,
  },
  {
    key: 'passable',
    icon: '🔢',
    label: 'Passable value',
    description: 'A primitive, list, or record.',
  },
  {
    key: 'structured',
    icon: '🧩',
    label: 'Structured value',
    description: 'A value matching an @endo/patterns pattern.',
  },
  {
    key: 'agent',
    icon: '🤖',
    label: 'New agent',
    description: 'Provision a Lal / Fae / Genie agent.',
    ready: true,
  },
]);

/**
 * The confined pop-over view.
 *
 * @param {object} props
 * @param {(key: string) => void} props.onPick
 * @param {() => void} props.onClose
 */
const CreateMenuView = ({ onPick, onClose }) => {
  const [active, setActive] = useState(0);

  /** @param {{ key: string, preventDefault?: () => void }} e */
  const onKeyDown = e => {
    if (e.key === 'ArrowDown') {
      if (e.preventDefault) e.preventDefault();
      setActive(i => (i + 1) % MENU_ITEMS.length);
    } else if (e.key === 'ArrowUp') {
      if (e.preventDefault) e.preventDefault();
      setActive(i => (i - 1 + MENU_ITEMS.length) % MENU_ITEMS.length);
    } else if (e.key === 'Enter') {
      if (e.preventDefault) e.preventDefault();
      onPick(MENU_ITEMS[active].key);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return h(
    Fragment,
    null,
    // A transparent backdrop dismisses the pop-over on an outside click,
    // declaratively (no document-level listener).
    h('div', { class: 'create-menu-backdrop', onClick: onClose }),
    h(
      'div',
      {
        class: 'create-menu',
        role: 'menu',
        tabindex: 0,
        autofocus: true,
        'aria-label': 'Create inventory item',
        onKeyDown,
      },
      MENU_ITEMS.map((item, i) =>
        h(
          'button',
          {
            key: item.key,
            type: 'button',
            role: 'menuitem',
            class: ['create-menu-item', i === active && 'active']
              .filter(Boolean)
              .join(' '),
            onMouseEnter: () => setActive(i),
            onClick: () => onPick(item.key),
          },
          h('span', { class: 'create-menu-icon' }, item.icon),
          h(
            'span',
            { class: 'create-menu-text' },
            h(
              'span',
              { class: 'create-menu-label' },
              item.label,
              item.ready
                ? null
                : h('span', { class: 'create-menu-soon' }, 'soon'),
            ),
            h('span', { class: 'create-menu-desc' }, item.description),
          ),
        ),
      ),
    ),
  );
};
harden(CreateMenuView);

/**
 * Wire the inventory `+` button to its pop-over create menu and the per-type
 * create modals. Instantiates the modal factories once (sharing the modal
 * container) and dispatches by picked type.
 *
 * @param {object} opts
 * @param {HTMLButtonElement} opts.$button - The `+` header-row button.
 * @param {HTMLElement} opts.$menuContainer - Where the pop-over renders.
 * @param {HTMLElement} opts.$modalContainer - Where the per-type modals render.
 * @param {() => ERef<EndoHost>} opts.getPowers - Powers for the active profile's
 *   inventory (resolved lazily so profile switches are honored).
 * @param {(petName: string) => void} [opts.onCreated] - Called with the new
 *   item's pet name after a successful create.
 * @returns {{ open: () => void, close: () => void, toggle: () => void, dispose: () => void }}
 */
export const createInventoryCreateMenu = ({
  $button,
  $menuContainer,
  $modalContainer,
  getPowers,
  onCreated,
}) => {
  const notifyCreated = (/** @type {string} */ petName) => {
    if (onCreated) onCreated(petName);
  };

  const mountModal = createMountModal({
    $container: $modalContainer,
    getPowers,
    onCreated: notifyCreated,
  });
  const placeholderModal = createPlaceholderModal({
    $container: $modalContainer,
  });
  const agentWizard = createAgentWizard({
    $container: $modalContainer,
    getPowers,
    onCreated: notifyCreated,
  });

  let open = false;

  const close = () => {
    if (!open) return;
    open = false;
    unmount($menuContainer);
    $menuContainer.innerHTML = '';
    $button.setAttribute('aria-expanded', 'false');
    $button.focus();
  };

  /** @param {string} key */
  const pick = key => {
    close();
    if (key === 'mount' || key === 'scratch') {
      mountModal.show(/** @type {'mount' | 'scratch'} */ (key));
    } else if (key === 'passable' || key === 'structured') {
      placeholderModal.show(key);
    } else if (key === 'agent') {
      agentWizard.show();
    }
  };

  const openMenu = () => {
    if (open) return;
    open = true;
    $button.setAttribute('aria-expanded', 'true');
    renderConfined(
      h(CreateMenuView, { onPick: pick, onClose: close }),
      $menuContainer,
    );
    const $menu = /** @type {HTMLElement | null} */ (
      $menuContainer.querySelector('.create-menu')
    );
    if ($menu) $menu.focus();
  };

  const toggle = () => {
    if (open) {
      close();
    } else {
      openMenu();
    }
  };

  const onButtonClick = () => toggle();
  $button.addEventListener('click', onButtonClick);

  const dispose = () => {
    close();
    $button.removeEventListener('click', onButtonClick);
  };

  return harden({ open: openMenu, close, toggle, dispose });
};
harden(createInventoryCreateMenu);
