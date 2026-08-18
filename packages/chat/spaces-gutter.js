// @ts-check
/* eslint-disable no-use-before-define */

import harden from '@endo/harden';

/** @import { ERef } from '@endo/eventual-send' */
/** @import { EndoHost } from '@endo/daemon' */

import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import {
  Fragment,
  h,
  renderConfined,
  useEffect,
  useState,
} from './setup-preact-container.js';
import { createAddSpaceModal } from './add-space-modal.js';
import { createEditSpaceModal } from './edit-space-modal.js';

/** @type {ReadonlySet<string>} */
const KNOWN_MODES = new Set([
  'channel',
  'whylip',
  'graph',
  'peers',
  'files',
  'floot',
  'management',
]);

/**
 * @typedef {'auto' | 'light' | 'dark' | 'high-contrast-light' | 'high-contrast-dark'} ColorScheme
 */

/**
 * @typedef {object} SpaceConfig
 * @property {string} id - unique identifier (sequential integer as string, e.g., "1", "2")
 * @property {string} name - display name (shown on hover)
 * @property {string} icon - emoji character
 * @property {string[]} profilePath - pet-name path to the agent
 * @property {'inbox' | 'channel' | 'whylip' | 'graph' | 'peers' | 'files' | 'floot' | 'management'} mode - interaction mode
 * @property {ColorScheme} [scheme] - color scheme preference (default: 'auto')
 * @property {string} [channelPetName] - pet name of the channel object (for channel mode)
 * @property {string} [proposedName] - display name for the channel creator
 * @property {string} [whylipSystemPrompt] - optional system prompt override (for whylip mode)
 * @property {'chat' | 'forum' | 'outliner' | 'microblog'} [viewMode] - channel view mode (default: 'chat')
 * @property {boolean} [ownedPersona] - whether the space owns the persona (for cleanup on delete)
 * @property {string} [lastChannelPetName] - last viewed channel in this space (restored on re-entry)
 * @property {string[]} [channelOrder] - persisted channel display order in sidebar
 * @property {Array<{key: string, channelPetName: string, label: string}>} [bookmarks] - bookmarked threads
 * @property {string[]} [audioPath] - pet-name path to an audio object (floot mic input)
 * @property {string[]} [ttsPath] - pet-name path to a text-to-speech object (floot spoken replies)
 * @property {string} [defaultSpaceId] - system-wide default space to open on
 *   load. Only meaningful on the home config (spaces/0), where it is a global
 *   preference shared by everyone; '' or absent means "open Home".
 */

/**
 * @typedef {object} SpacesGutterAPI
 * @property {() => Promise<void>} refresh - Reload spaces from pet-store
 * @property {(id: string) => void} selectSpace - Activate a space
 * @property {() => SpaceConfig[]} getSpaces - Get current space list
 * @property {(config: Omit<SpaceConfig, 'id'>) => Promise<string>} addSpace - Add a new space
 * @property {(id: string, updates: Partial<Pick<SpaceConfig, 'name' | 'icon' | 'scheme' | 'viewMode' | 'lastChannelPetName' | 'channelOrder' | 'bookmarks'>>) => Promise<void>} updateSpace - Update a space
 * @property {(id: string) => Promise<void>} removeSpace - Remove a space
 * @property {() => string} getActiveSpaceId - Get currently active space ID
 * @property {(path: string[]) => void} setActivePath - Report a navigation that
 *   did not come from the gutter, so the highlight follows it
 */

/** @type {SpaceConfig} */
const HOME_SPACE_DEFAULTS = harden({
  id: 'home',
  name: 'Home',
  icon: '🐈‍⬛',
  profilePath: [],
  mode: 'inbox',
  scheme: 'auto',
});
harden(HOME_SPACE_DEFAULTS);

const validSchemes = harden([
  'auto',
  'light',
  'dark',
  'high-contrast-light',
  'high-contrast-dark',
]);
harden(validSchemes);

/**
 * Check if two profile paths are equal.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
const pathsEqual = (a, b) => {
  if (a.length !== b.length) return false;
  return a.every((segment, i) => segment === b[i]);
};
harden(pathsEqual);

// Per-device default space (this browser). Overrides the system-wide default
// (stored on the home config). '' means "no per-device preference".
const DEVICE_DEFAULT_KEY = 'chat-default-space';

// Everything needed to OPEN the default space, cached beside the preference.
//
// The preference names a space; opening one needs its profile path and mode,
// which live on the daemon. Waiting for them meant the app mounted Home first
// and tore it down a round trip later — the default space was the second thing
// you saw, after paying to build something you did not ask for. Remembering
// where the space was last time makes it the first thing built instead.
//
// Strictly a cache: absent, stale, or unparseable, it is ignored and the
// original post-refresh path applies. `refresh()` rewrites it from the loaded
// configuration, so a space that moved or changed mode is corrected on the load
// after the change, and one that was removed is corrected during that load.
const BOOT_DEFAULT_KEY = 'chat-default-space-boot';

// Whether this browser shows the gutter. Absent means showing, so a device that
// has never touched the toggle — and one whose storage is unavailable — gets the
// bar rather than a page with no way back to the other spaces.
const GUTTER_VISIBLE_KEY = 'chat-spaces-gutter-hidden';

/**
 * Whether the spaces gutter should be showing on this device.
 *
 * Synchronous, like the boot cache, because the shell applies it before the
 * first paint rather than letting the gutter appear and then vanish.
 *
 * @returns {boolean}
 */
export const readGutterVisible = () => {
  try {
    return window.localStorage.getItem(GUTTER_VISIBLE_KEY) !== 'true';
  } catch {
    return true;
  }
};
harden(readGutterVisible);

/**
 * Remember whether the gutter is showing on this device.
 *
 * @param {boolean} visible
 */
export const writeGutterVisible = visible => {
  try {
    window.localStorage.setItem(GUTTER_VISIBLE_KEY, String(!visible));
  } catch {
    // A device that cannot remember the choice still honors it for this page.
  }
};
harden(writeGutterVisible);

const loadDeviceDefaultSpaceId = () => {
  try {
    return window.localStorage.getItem(DEVICE_DEFAULT_KEY) || '';
  } catch {
    return '';
  }
};

/**
 * The cached descriptor of the space to open on load, if one was cached.
 *
 * Synchronous by design: the caller uses it to choose what to mount before the
 * first paint, so anything asynchronous here would defeat the purpose.
 *
 * @returns {{ id: string, profilePath: string[], spaceInfo: object, scheme?: ColorScheme } | undefined}
 */
export const readBootDefaultSpace = () => {
  try {
    const raw = window.localStorage.getItem(BOOT_DEFAULT_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    // A cache written by another version is not worth interpreting.
    if (
      !parsed ||
      typeof parsed.id !== 'string' ||
      !Array.isArray(parsed.profilePath) ||
      !parsed.profilePath.every(segment => typeof segment === 'string') ||
      parsed.profilePath.length === 0 ||
      typeof parsed.spaceInfo !== 'object' ||
      parsed.spaceInfo === null
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
};
harden(readBootDefaultSpace);

// ── Confined Preact view ──────────────────────────────────────────────────
//
// The gutter's chrome (the space icons, the add-space button, and the
// per-space context menu) is a confined Preact tree rendered through the
// sanitizing `renderConfined`. Everything stateful — the pet-store load, the
// `followNameChanges` watcher, the add/edit modals, scheme application, and the
// Cmd+1..9 shortcuts — stays in the imperative host controller below and feeds
// the view pure-data snapshots (`GutterViewState`) plus a handful of callbacks.

/**
 * @typedef {object} GutterSpaceView
 * @property {string} id
 * @property {string} name
 * @property {string} icon
 * @property {boolean} isHome
 * @property {boolean} isDeviceDefault - the per-device default (this browser)
 * @property {boolean} isSystemDefault - the system-wide default (everyone)
 * @property {number} [shortcut] - 1..9 Cmd-shortcut number, if any
 */

/**
 * @typedef {object} GutterViewState
 * @property {GutterSpaceView[]} spaces
 * @property {string} activeSpaceId
 */

/**
 * @typedef {object} GutterMenuState
 * @property {string} spaceId
 * @property {string} name
 * @property {boolean} isHome
 * @property {boolean} isDeviceDefault
 * @property {boolean} isSystemDefault
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef {object} GutterController
 * @property {((state: GutterViewState) => void) | undefined} setState - wired by
 *   the view's mount effect; the host calls it to push a fresh snapshot.
 * @property {() => GutterViewState} getState - seeds the view's initial render.
 * @property {(id: string) => void} selectSpace
 * @property {(id: string) => void} editSpace
 * @property {(id: string) => void} deleteSpace
 * @property {(id: string, on: boolean) => void} setDeviceDefault
 * @property {(id: string, on: boolean) => void} setSystemDefault
 * @property {() => void} addSpace
 */

/**
 * One space icon button. Left-click selects; right-click opens the per-space
 * context menu at the cursor.
 *
 * @param {object} props
 * @param {GutterSpaceView} props.space
 * @param {boolean} props.active
 * @param {(id: string) => void} props.onSelect
 * @param {(space: GutterSpaceView, x: number, y: number) => void} props.onOpenMenu
 */
const SpaceItem = ({ space, active, onSelect, onOpenMenu }) => {
  const shortcutHint = space.shortcut ? ` (⌘${space.shortcut})` : '';
  return h(
    'div',
    {
      class: ['space-item', active && 'active', space.isHome && 'home']
        .filter(Boolean)
        .join(' '),
      'data-space-id': space.id,
      title: `${space.name}${shortcutHint}`,
      onClick: () => onSelect(space.id),
      /** @param {{ preventDefault: () => void, clientX: number, clientY: number }} e */
      onContextMenu: e => {
        e.preventDefault();
        onOpenMenu(space, e.clientX, e.clientY);
      },
    },
    h('span', { class: 'space-icon' }, space.icon),
    h('span', { class: 'space-badge', style: 'display: none;' }, '0'),
    space.shortcut
      ? h('span', { class: 'space-shortcut-badge' }, String(space.shortcut))
      : null,
  );
};
harden(SpaceItem);

/**
 * The per-space context menu (Edit / Delete), positioned at the cursor. Both
 * actions are always rendered; Delete is hidden (`display: none`) for the
 * indelible home space, matching the original `data-menu-scope` behavior the
 * component test asserts on. A focusable full-screen backdrop dismisses the
 * menu on an outside click or Escape, declaratively, instead of document-level
 * listeners.
 *
 * @param {object} props
 * @param {GutterMenuState} props.menu
 * @param {() => void} props.onClose
 * @param {(id: string) => void} props.onEdit
 * @param {(id: string) => void} props.onDelete
 * @param {(id: string, on: boolean) => void} props.onSetDeviceDefault
 * @param {(id: string, on: boolean) => void} props.onSetSystemDefault
 */
const SpaceContextMenu = ({
  menu,
  onClose,
  onEdit,
  onDelete,
  onSetDeviceDefault,
  onSetSystemDefault,
}) =>
  h(
    Fragment,
    null,
    h('div', {
      class: 'space-context-menu-backdrop',
      tabindex: -1,
      autofocus: true,
      onClick: onClose,
      /** @param {{ key?: string }} e */
      onKeyDown: e => {
        if (e.key === 'Escape') onClose();
      },
    }),
    h(
      'div',
      {
        class: 'space-context-menu visible',
        style: `left:${menu.x}px;top:${menu.y}px`,
        /** @param {{ stopPropagation: () => void }} e */
        onClick: e => e.stopPropagation(),
      },
      h('div', { class: 'context-menu-title' }, menu.name),
      h(
        'button',
        {
          class: `context-menu-item${menu.isDeviceDefault ? ' checked' : ''}`,
          'data-action': 'default-device',
          onClick: () => {
            onClose();
            onSetDeviceDefault(menu.spaceId, !menu.isDeviceDefault);
          },
        },
        h(
          'span',
          { class: 'context-menu-icon' },
          menu.isDeviceDefault ? '✓' : '📌',
        ),
        h(
          'span',
          null,
          menu.isDeviceDefault
            ? 'Default on this device'
            : 'Set default on this device',
        ),
      ),
      h(
        'button',
        {
          class: `context-menu-item${menu.isSystemDefault ? ' checked' : ''}`,
          'data-action': 'default-system',
          onClick: () => {
            onClose();
            onSetSystemDefault(menu.spaceId, !menu.isSystemDefault);
          },
        },
        h(
          'span',
          { class: 'context-menu-icon' },
          menu.isSystemDefault ? '✓' : '🌐',
        ),
        h(
          'span',
          null,
          menu.isSystemDefault
            ? 'Default for everyone'
            : 'Set default for everyone',
        ),
      ),
      h(
        'button',
        {
          class: 'context-menu-item',
          'data-action': 'edit',
          onClick: () => {
            onClose();
            onEdit(menu.spaceId);
          },
        },
        h('span', { class: 'context-menu-icon' }, '✏️'),
        h('span', null, 'Edit Space'),
      ),
      h(
        'button',
        {
          class: 'context-menu-item context-menu-delete',
          'data-action': 'delete',
          style: menu.isHome ? 'display: none;' : '',
          onClick: () => {
            onClose();
            onDelete(menu.spaceId);
          },
        },
        h('span', { class: 'context-menu-icon' }, '🗑'),
        h('span', null, 'Delete Space'),
      ),
    ),
  );
harden(SpaceContextMenu);

/**
 * The gutter view root: the home + user space icons, the add-space button, and
 * the per-space context menu. Driven entirely by the host `controller` — a
 * `GutterViewState` snapshot pushed via `controller.setState`, plus
 * select/edit/delete/add callbacks. Holds only its own ephemeral context-menu
 * state.
 *
 * @param {object} props
 * @param {GutterController} props.controller
 */
const SpacesGutterView = ({ controller }) => {
  const [state, setState] = useState(
    /** @type {GutterViewState} */ (controller.getState()),
  );
  // The controller is stable for the mount, so the bridge effect is mount-only
  // (object props can't be effect deps under the sanitizer). The mount effect
  // runs after the first paint, so a `pushState()` the host fired in between
  // (the initial pet-store load / watcher replay) would be lost; re-read the
  // live snapshot here to catch up before wiring further updates.
  useEffect(() => {
    controller.setState = setState;
    setState(controller.getState());
    return () => {
      if (controller.setState === setState) controller.setState = undefined;
    };
  }, [controller]);

  const [menu, setMenu] = useState(
    /** @type {GutterMenuState | null} */ (null),
  );

  /** @type {(space: GutterSpaceView, x: number, y: number) => void} */
  const onOpenMenu = (space, x, y) =>
    setMenu({
      spaceId: space.id,
      name: space.name,
      isHome: space.isHome,
      isDeviceDefault: space.isDeviceDefault,
      isSystemDefault: space.isSystemDefault,
      x,
      y,
    });

  return h(
    Fragment,
    null,
    h(
      'div',
      { class: 'spaces-gutter-inner' },
      h(
        'div',
        { class: 'spaces-list' },
        state.spaces.map(space =>
          h(SpaceItem, {
            key: space.id,
            space,
            active: space.id === state.activeSpaceId,
            onSelect: controller.selectSpace,
            onOpenMenu,
          }),
        ),
        h(
          'div',
          { class: 'space-item add-space-item', title: 'Add space' },
          h(
            'button',
            { class: 'add-space-button', onClick: () => controller.addSpace() },
            '+',
          ),
        ),
      ),
    ),
    menu
      ? h(SpaceContextMenu, {
          menu,
          onClose: () => setMenu(null),
          onEdit: controller.editSpace,
          onDelete: controller.deleteSpace,
          onSetDeviceDefault: controller.setDeviceDefault,
          onSetSystemDefault: controller.setSystemDefault,
        })
      : null,
  );
};
harden(SpacesGutterView);

/**
 * Create the spaces gutter component.
 *
 * @param {object} options
 * @param {HTMLElement} options.$container - Container element for the gutter
 * @param {HTMLElement} options.$modalContainer - Container for the add space modal
 * @param {ERef<EndoHost>} options.powers - Endo host powers
 * @param {string[]} options.currentProfilePath - Current profile path for initial selection
 * @param {(profilePath: string[], spaceInfo?: { mode: 'inbox' | 'channel' | 'whylip' | 'graph' | 'peers' | 'files' | 'floot' | 'management', channelPetName?: string, proposedName?: string, whylipSystemPrompt?: string, viewMode?: 'chat' | 'forum' | 'outliner' | 'microblog', channelOrder?: string[], bookmarks?: Array<{key: string, channelPetName: string, label: string}>, audioPath?: string[], ttsPath?: string[] }) => void} options.onNavigate - Navigate callback
 * @returns {SpacesGutterAPI}
 */
export const createSpacesGutter = ({
  $container,
  $modalContainer,
  powers,
  currentProfilePath,
  onNavigate,
}) => {
  // The gutter outlives every space change, so the path it highlights is
  // state rather than a construction-time fact. `setActivePath` below is how
  // navigation that did not come from here — a deep link, the header's home
  // control, a space that closed itself — keeps the highlight honest.
  let activePath = currentProfilePath;

  /** @type {Map<string, SpaceConfig>} */
  const spacesMap = new Map();
  /** @type {SpaceConfig} */
  let homeSpaceConfig = HOME_SPACE_DEFAULTS;
  /** @type {string} */
  let activeSpaceId = 'home'; // Will be updated after loading spaces
  // Whether the one-time "open the default space on load" has run, so a later
  // API-triggered refresh() (e.g. reconnect) never yanks the user elsewhere.
  let appliedInitialDefault = false;

  let deviceDefaultSpaceId = loadDeviceDefaultSpaceId();
  const systemDefaultSpaceId = () => homeSpaceConfig.defaultSpaceId || '';

  // Whether the app opened straight into the boot-cached default space, in
  // which case the one-shot default navigation below is already satisfied and
  // only needs checking against the spaces that actually loaded. Recognized by
  // the path rather than by a flag threaded down from the entry point, so the
  // cache's two readers cannot disagree about what was opened.
  const booted = readBootDefaultSpace();
  const bootedDefaultSpaceId =
    booted !== undefined && pathsEqual(booted.profilePath, activePath)
      ? booted.id
      : '';

  /**
   * Get spaces as sorted array.
   *
   * @returns {SpaceConfig[]}
   */
  const getSpacesArray = () => {
    return [...spacesMap.values()].sort(
      (a, b) => parseInt(a.id, 10) - parseInt(b.id, 10),
    );
  };

  /**
   * Find the space ID that matches a profile path.
   *
   * @param {string[]} profilePath
   * @returns {string} The matching space ID, or 'home' if none matches
   */
  const findSpaceForPath = profilePath => {
    // Empty path is home
    if (profilePath.length === 0) {
      return 'home';
    }
    // Check user spaces
    for (const space of spacesMap.values()) {
      if (pathsEqual(space.profilePath, profilePath)) {
        return space.id;
      }
    }
    // No match, default to home
    return 'home';
  };

  /**
   * Update active space based on current profile path.
   */
  const syncActiveSpaceToPath = () => {
    activeSpaceId = findSpaceForPath(activePath);
  };

  /**
   * Handle when the active space is removed - refocus on home.
   */
  const handleActiveSpaceRemoved = () => {
    if (activeSpaceId !== 'home' && !spacesMap.has(activeSpaceId)) {
      activeSpaceId = 'home';
      onNavigate(homeSpaceConfig.profilePath);
    }
  };

  /**
   * Add a new space.
   *
   * @param {Omit<SpaceConfig, 'id'>} config
   * @returns {Promise<string>}
   */
  const addSpace = async config => {
    // Generate next sequential ID
    const existingIds = [...spacesMap.keys()]
      .map(id => parseInt(id, 10))
      .filter(n => !Number.isNaN(n));
    const nextId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;
    const id = String(nextId);
    const spaceConfig = harden({ ...config, id });

    // Ensure 'spaces' directory exists
    await null; // safe-await-separator
    try {
      await E(powers).lookup('spaces');
    } catch {
      // Directory doesn't exist, create it
      await E(powers).makeDirectory('spaces');
    }

    // Store as passable object (not JSON)
    await E(powers).storeValue(spaceConfig, ['spaces', id]);

    // Add to map immediately and select the new space
    spacesMap.set(id, spaceConfig);
    selectSpace(id);

    return id;
  };

  /**
   * Remove a space and clean up associated daemon-level pet names
   * and browser-side address book entries.
   *
   * For channel spaces:
   * - The handle and agent pet names in the root pet store are removed
   *   so that recreating a space with the same name produces a fresh agent.
   * - All localStorage address-book entries scoped to this persona are
   *   cleared so a recreated space starts with an empty address book.
   *
   * @param {string} id
   * @returns {Promise<void>}
   */
  const removeSpace = async id => {
    // Cannot remove home space
    if (id === 'home') return;

    await null; // safe-await-separator

    // Look up the space config before removing it so we know what to clean up.
    const config = spacesMap.get(id);
    if (
      config &&
      config.mode === 'channel' &&
      config.profilePath.length > 0 &&
      config.ownedPersona !== false
    ) {
      const agentPetName = config.profilePath[0];
      // config.name is the spaceName passed to provideHost (the handle pet name).
      const handlePetName = config.name;

      // Clear browser-side address book entries for this persona.
      // The channelComponent stores nicknames under keys like
      // "channel-names:<personaId>:<channelName>" where personaId is
      // profilePath.join('/').  Without this cleanup, recreating a space
      // with the same name would inherit the old persona's nicknames.
      try {
        const personaId = config.profilePath.join('/');
        const prefix = `channel-names:${personaId}:`;
        const keysToRemove = [];
        for (let i = 0; i < window.localStorage.length; i += 1) {
          const key = window.localStorage.key(i);
          if (key && key.startsWith(prefix)) {
            keysToRemove.push(key);
          }
        }
        for (const key of keysToRemove) {
          window.localStorage.removeItem(key);
        }
      } catch {
        // localStorage not available
      }

      // Remove the handle so provideHost creates a new agent next time.
      try {
        await E(powers).remove(handlePetName);
      } catch {
        // May not exist
      }
      // Remove the agent pet name so the old agent can be garbage collected.
      try {
        await E(powers).remove(agentPetName);
      } catch {
        // May not exist
      }
    }

    try {
      await E(powers).remove('spaces', id);
    } catch {
      // May not exist
    }
    // Eagerly remove from map and navigate home if this was the active space.
    // The watcher will also fire, but handleSpaceRemoved no longer navigates
    // (to avoid bouncing during edits).
    spacesMap.delete(id);
    handleActiveSpaceRemoved();
    pushState();
  };

  /**
   * Update an existing space's configuration.
   *
   * @param {string} id
   * @param {Partial<Pick<SpaceConfig, 'name' | 'icon' | 'scheme' | 'viewMode' | 'defaultSpaceId'>>} updates
   * @returns {Promise<void>}
   */
  const updateSpace = async (id, updates) => {
    if (id === 'home') {
      // Home space: enforce indelible name and profilePath
      const updated = harden({
        ...homeSpaceConfig,
        ...updates,
        name: 'Home',
        profilePath: [],
        id: 'home',
        mode: /** @type {const} */ ('inbox'),
      });

      await null; // safe-await-separator
      // Ensure 'spaces' directory exists
      try {
        await E(powers).lookup('spaces');
      } catch {
        await E(powers).makeDirectory('spaces');
      }
      await E(powers).storeValue(updated, ['spaces', '0']);

      homeSpaceConfig = updated;

      // If home is active, apply the new scheme
      if (activeSpaceId === 'home') {
        applyScheme(updated.scheme);
      }
      pushState();
      return;
    }

    const existing = spacesMap.get(id);
    if (!existing) return;

    const updated = harden({
      ...existing,
      ...updates,
    });

    await null; // safe-await-separator
    await E(powers).storeValue(updated, ['spaces', id]);

    spacesMap.set(id, updated);

    // If this is the active space, apply the new scheme
    if (id === activeSpaceId) {
      applyScheme(updated.scheme);
    }
    pushState();
  };

  /**
   * Apply a color scheme to the document.
   *
   * @param {ColorScheme} [scheme]
   */
  const applyScheme = scheme => {
    if (!scheme || scheme === 'auto') {
      document.documentElement.removeAttribute('data-scheme');
    } else {
      document.documentElement.setAttribute('data-scheme', scheme);
    }
    // Notify Monaco editors to update their theme
    document.dispatchEvent(new CustomEvent('endo-theme-change'));
  };

  /**
   * The navigation descriptor for a space — what `onNavigate` needs to mount
   * it. Shared by `selectSpace` and the boot cache so a space opened from the
   * cache is mounted exactly as clicking it would have mounted it.
   *
   * @param {SpaceConfig} space
   */
  const spaceInfoFor = space => ({
    mode: space.mode,
    channelPetName: space.lastChannelPetName || space.channelPetName,
    proposedName: space.proposedName,
    whylipSystemPrompt: space.whylipSystemPrompt,
    viewMode: space.viewMode,
    channelOrder: space.channelOrder,
    bookmarks: space.bookmarks,
    audioPath: space.audioPath,
    ttsPath: space.ttsPath,
  });

  /**
   * Select and activate a space.
   *
   * @param {string} id
   */
  const selectSpace = id => {
    // Handle home space specially
    if (id === 'home') {
      activeSpaceId = 'home';
      applyScheme(homeSpaceConfig.scheme);
      pushState();
      onNavigate(homeSpaceConfig.profilePath);
      return;
    }

    const space = spacesMap.get(id);
    if (!space) return;

    activeSpaceId = id;
    applyScheme(space.scheme);
    pushState();
    onNavigate(space.profilePath, spaceInfoFor(space));
  };

  /**
   * Write (or clear) the boot cache for whichever space would be opened on the
   * next load. Called wherever the answer can change: after `refresh()` has the
   * configurations, and when either default preference is set.
   */
  const updateBootDefaultSpace = () => {
    const target = deviceDefaultSpaceId || systemDefaultSpaceId();
    const space =
      target && target !== 'home' ? spacesMap.get(target) : undefined;
    try {
      if (space === undefined) {
        // No default, or one that no longer resolves: the next load opens Home,
        // and a stale entry would send it somewhere the user did not choose.
        window.localStorage.removeItem(BOOT_DEFAULT_KEY);
      } else {
        window.localStorage.setItem(
          BOOT_DEFAULT_KEY,
          JSON.stringify({
            id: space.id,
            profilePath: space.profilePath,
            spaceInfo: spaceInfoFor(space),
            scheme: space.scheme,
          }),
        );
      }
    } catch {
      // localStorage unavailable (private mode); the app just pays the round
      // trip on the next load, as it did before the cache existed.
    }
  };

  /**
   * Set (or clear) the per-device default space. Persisted in localStorage, so
   * it is scoped to this browser and overrides the system-wide default.
   *
   * @param {string} id
   * @param {boolean} on
   */
  const setDeviceDefaultSpace = (id, on) => {
    deviceDefaultSpaceId = on ? id : '';
    try {
      if (deviceDefaultSpaceId) {
        window.localStorage.setItem(DEVICE_DEFAULT_KEY, deviceDefaultSpaceId);
      } else {
        window.localStorage.removeItem(DEVICE_DEFAULT_KEY);
      }
    } catch {
      // localStorage unavailable (private mode); the in-memory value still
      // drives this session's view.
    }
    updateBootDefaultSpace();
    pushState();
  };

  /**
   * Set (or clear) the system-wide default space. Persisted on the home config
   * (spaces/0) so it is shared across everyone and every device; the per-device
   * default, when set, still wins on load.
   *
   * @param {string} id
   * @param {boolean} on
   */
  const setSystemDefaultSpace = (id, on) => {
    updateSpace('home', { defaultSpaceId: on ? id : '' })
      .then(updateBootDefaultSpace)
      .catch(window.reportError);
  };

  /**
   * Open the configured default space on first load — the per-device default
   * (this browser) if set, otherwise the system-wide default. Runs once, and
   * only when the app opened at Home, so an explicit deep-link is never
   * overridden.
   */
  const applyInitialDefaultSpace = () => {
    if (appliedInitialDefault) return;
    appliedInitialDefault = true;
    // The app already opened this space from the boot cache, so there is
    // nothing to redirect — unless the cache was stale, in which case we are
    // showing a space that no longer exists and Home is where we belong.
    if (bootedDefaultSpaceId) {
      if (!spacesMap.has(bootedDefaultSpaceId)) {
        selectSpace('home');
      }
      return;
    }
    // Only redirect a plain Home open; a deep-linked path stays put. This
    // runs once per gutter, and the gutter is built once per page load, so
    // returning to Home later is never mistaken for a fresh open.
    if (activePath.length !== 0) return;
    const target = deviceDefaultSpaceId || systemDefaultSpaceId();
    // '' and 'home' both mean "stay on Home", which is where we already are.
    if (!target || target === 'home') return;
    if (!spacesMap.has(target)) return; // stale / since-removed
    selectSpace(target);
  };

  /**
   * Build the pure-data snapshot the confined view renders from. Home is always
   * first; user spaces follow in numeric id order. The 1-indexed Cmd-shortcut
   * (⌘1=home, ⌘2=first user space, …) is attached for the first nine items.
   *
   * @returns {GutterViewState}
   */
  const buildViewState = () => {
    const allSpaces = [homeSpaceConfig, ...getSpacesArray()];
    const systemDefault = systemDefaultSpaceId();
    return {
      activeSpaceId,
      spaces: allSpaces.map((space, index) => {
        const shortcutNum = index + 1;
        /** @type {GutterSpaceView} */
        const view = {
          id: space.id,
          name: space.name,
          icon: space.icon,
          isHome: space.id === 'home',
          isDeviceDefault: space.id === deviceDefaultSpaceId,
          isSystemDefault: space.id === systemDefault,
        };
        if (shortcutNum >= 1 && shortcutNum <= 9) {
          view.shortcut = shortcutNum;
        }
        return view;
      }),
    };
  };

  // The host-owned controller passed to the confined `SpacesGutterView`. Not
  // hardened: the view writes its `setState` setter onto it during mount. The
  // edit/add callbacks reach the modals declared further below; they only run
  // on user interaction, long after init completes.
  /** @type {GutterController} */
  const controller = {
    setState: undefined,
    getState: buildViewState,
    selectSpace,
    editSpace: id => {
      if (id === 'home') {
        homeEditModal.show(homeSpaceConfig);
      } else {
        const space = spacesMap.get(id);
        if (space) {
          editSpaceModal.show(space);
        }
      }
    },
    deleteSpace: id => {
      removeSpace(id).catch(window.reportError);
    },
    setDeviceDefault: setDeviceDefaultSpace,
    setSystemDefault: setSystemDefaultSpace,
    addSpace: () => showAddSpaceDialog(),
  };

  /**
   * Repaint the mounted view with the latest snapshot. Replaces the old
   * imperative `render()`: every site that mutated `spacesMap`,
   * `activeSpaceId`, or `homeSpaceConfig` now pushes through here.
   */
  const pushState = () => {
    if (controller.setState) {
      controller.setState(buildViewState());
    }
  };

  // Initialize the add space modal
  const addSpaceModal = createAddSpaceModal({
    $container: $modalContainer,
    powers,
    getUsedIcons: () => {
      const icons = new Set();
      // Home space icon is always considered used
      icons.add(homeSpaceConfig.icon);
      for (const space of spacesMap.values()) {
        icons.add(space.icon);
      }
      return icons;
    },
    onSubmit: async data => {
      const spaceConfig = {
        name: data.name,
        icon: data.icon,
        profilePath: data.profilePath,
        mode: /** @type {'inbox' | 'channel' | 'whylip' | 'graph' | 'peers' | 'files' | 'floot' | 'management'} */ (
          KNOWN_MODES.has(data.layout) ? data.layout : 'inbox'
        ),
        scheme: data.scheme || 'auto',
      };
      if (data.channelPetName) {
        spaceConfig.channelPetName = data.channelPetName;
      }
      if (data.proposedName) {
        spaceConfig.proposedName = data.proposedName;
      }
      if (data.whylipSystemPrompt) {
        spaceConfig.whylipSystemPrompt = data.whylipSystemPrompt;
      }
      if (data.viewMode) {
        spaceConfig.viewMode = data.viewMode;
      }
      if (typeof data.ownedPersona === 'boolean') {
        spaceConfig.ownedPersona = data.ownedPersona;
      }
      if (
        Array.isArray(data.audioPath) &&
        data.audioPath.every(p => typeof p === 'string')
      ) {
        spaceConfig.audioPath = data.audioPath;
      }
      if (
        Array.isArray(data.ttsPath) &&
        data.ttsPath.every(p => typeof p === 'string')
      ) {
        spaceConfig.ttsPath = data.ttsPath;
      }
      await addSpace(spaceConfig);
    },
    onClose: () => {
      // Modal closed
    },
    getExistingChannelSpaces: () => {
      const result = [];
      for (const space of spacesMap.values()) {
        if (space.mode === 'channel') {
          result.push({
            id: space.id,
            name: space.name,
            icon: space.icon,
            profilePath: space.profilePath,
          });
        }
      }
      return result;
    },
  });

  // The add-space modal renders by assigning `innerHTML` on `$modalContainer`,
  // which detaches anything else mounted there. The edit modals are confined
  // Preact components that append a persistent mount, so sharing the container
  // left the "edit space" button blank once the add-space modal had rendered.
  // Give the edit modals their own overlay container, inserted as a sibling so
  // the add-space modal's re-renders never touch it. Both edit modals are
  // Preact (each renders nothing while closed) so they can share one container.
  const $editModalContainer = document.createElement('div');
  $editModalContainer.className = 'spaces-modal-overlay';
  const $modalParent = $modalContainer.parentNode;
  if ($modalParent) {
    $modalParent.insertBefore($editModalContainer, $modalContainer.nextSibling);
  } else {
    $modalContainer.appendChild($editModalContainer);
  }

  // Initialize the edit space modal (for regular spaces)
  const editSpaceModal = createEditSpaceModal({
    $container: $editModalContainer,
    onSubmit: async (id, data) => {
      /** @type {Partial<Pick<SpaceConfig, 'name' | 'icon' | 'scheme' | 'viewMode'>>} */
      const updates = {
        name: data.name,
        icon: data.icon,
        scheme: data.scheme || 'auto',
      };
      if (data.viewMode) {
        updates.viewMode = data.viewMode;
      }
      await updateSpace(id, updates);
    },
    onClose: () => {
      // Modal closed
    },
  });

  // Initialize the home edit modal (no name field)
  const homeEditModal = createEditSpaceModal({
    $container: $editModalContainer,
    showName: false,
    onSubmit: async (_id, data) => {
      await updateSpace('home', {
        icon: data.icon,
        scheme: data.scheme || 'auto',
      });
    },
    onClose: () => {
      // Modal closed
    },
  });

  /**
   * Show dialog to add a new space.
   */
  const showAddSpaceDialog = () => {
    addSpaceModal.show();
  };

  /**
   * Validate that a value is a valid SpaceConfig.
   *
   * @param {unknown} value
   * @param {string} id
   * @returns {SpaceConfig | null}
   */
  const validateSpaceConfig = (value, id) => {
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    const obj = /** @type {Record<string, unknown>} */ (value);
    // Must have required string fields
    if (typeof obj.name !== 'string') return null;
    if (typeof obj.icon !== 'string') return null;
    if (!Array.isArray(obj.profilePath)) return null;
    if (!obj.profilePath.every(p => typeof p === 'string')) return null;
    // Mode is optional, default to 'inbox'
    const mode =
      /** @type {'inbox' | 'channel' | 'whylip' | 'graph' | 'peers' | 'files' | 'floot' | 'management'} */ (
        typeof obj.mode === 'string' && KNOWN_MODES.has(obj.mode)
          ? obj.mode
          : 'inbox'
      );
    // Scheme is optional, default to 'auto'
    const scheme =
      typeof obj.scheme === 'string' && validSchemes.includes(obj.scheme)
        ? /** @type {ColorScheme} */ (obj.scheme)
        : 'auto';
    const result = {
      id,
      name: obj.name,
      icon: obj.icon,
      profilePath: obj.profilePath,
      mode,
      scheme,
    };
    if (typeof obj.channelPetName === 'string') {
      result.channelPetName = obj.channelPetName;
    }
    if (typeof obj.proposedName === 'string') {
      result.proposedName = obj.proposedName;
    }
    if (typeof obj.whylipSystemPrompt === 'string') {
      result.whylipSystemPrompt = obj.whylipSystemPrompt;
    }
    if (
      typeof obj.viewMode === 'string' &&
      (obj.viewMode === 'chat' ||
        obj.viewMode === 'forum' ||
        obj.viewMode === 'outliner' ||
        obj.viewMode === 'microblog')
    ) {
      result.viewMode = obj.viewMode;
    }
    if (typeof obj.ownedPersona === 'boolean') {
      result.ownedPersona = obj.ownedPersona;
    }
    if (typeof obj.lastChannelPetName === 'string') {
      result.lastChannelPetName = obj.lastChannelPetName;
    }
    if (
      Array.isArray(obj.audioPath) &&
      obj.audioPath.every(p => typeof p === 'string')
    ) {
      result.audioPath = obj.audioPath;
    }
    if (
      Array.isArray(obj.ttsPath) &&
      obj.ttsPath.every(p => typeof p === 'string')
    ) {
      result.ttsPath = obj.ttsPath;
    }
    if (typeof obj.defaultSpaceId === 'string') {
      result.defaultSpaceId = obj.defaultSpaceId;
    }
    if (
      Array.isArray(obj.channelOrder) &&
      obj.channelOrder.every(n => typeof n === 'string')
    ) {
      result.channelOrder = obj.channelOrder;
    }
    if (
      Array.isArray(obj.bookmarks) &&
      obj.bookmarks.every(
        b =>
          typeof b === 'object' &&
          b !== null &&
          typeof b.key === 'string' &&
          typeof b.channelPetName === 'string' &&
          typeof b.label === 'string',
      )
    ) {
      result.bookmarks = obj.bookmarks;
    }
    return /** @type {SpaceConfig} */ (harden(result));
  };

  /**
   * Load a single space config from the pet-store.
   *
   * @param {string} id
   * @returns {Promise<SpaceConfig | null>}
   */
  const loadSpaceConfig = async id => {
    try {
      // eslint-disable-next-line @jessie.js/safe-await-separator
      const value = await E(powers).lookup(['spaces', id]);
      return validateSpaceConfig(value, id);
    } catch {
      return null;
    }
  };

  /**
   * Handle a space being added.
   *
   * @param {string} id
   */
  const handleSpaceAdded = async id => {
    if (id === '0') {
      // Reload home config
      const config = await loadSpaceConfig('0');
      if (config) {
        homeSpaceConfig = harden({
          ...HOME_SPACE_DEFAULTS,
          icon: config.icon,
          scheme: config.scheme,
          ...(config.defaultSpaceId
            ? { defaultSpaceId: config.defaultSpaceId }
            : {}),
        });
        if (activeSpaceId === 'home') {
          applyScheme(homeSpaceConfig.scheme);
        }
      }
      pushState();
      return;
    }
    const config = await loadSpaceConfig(id);
    if (config) {
      spacesMap.set(id, config);
      pushState();
    }
  };

  /**
   * Handle a space being removed by the watcher.
   *
   * Note: storeValue triggers a remove+add pair, so we must not navigate
   * away from the active space here — that would cause edits to bounce
   * the user back to home.  Navigation on true deletion is handled by
   * removeSpace itself.
   *
   * @param {string} id
   */
  const handleSpaceRemoved = id => {
    if (id === '0') {
      homeSpaceConfig = HOME_SPACE_DEFAULTS;
      if (activeSpaceId === 'home') {
        applyScheme(homeSpaceConfig.scheme);
      }
      pushState();
      return;
    }
    spacesMap.delete(id);
    pushState();
  };

  /**
   * Watch the spaces directory for changes.
   *
   * @returns {Promise<void>}
   */
  const watchSpaces = async () => {
    await null; // safe-await-separator
    try {
      // Ensure spaces directory exists
      try {
        await E(powers).lookup('spaces');
      } catch {
        // Directory doesn't exist yet, create it
        await E(powers).makeDirectory('spaces');
      }

      // Get the spaces directory and watch for changes
      const spacesDir = await E(powers).lookup('spaces');
      const changesRef = E(
        /** @type {ERef<EndoHost>} */ (spacesDir),
      ).followNameChanges();
      const changes = iterateReader(
        /** @type {Parameters<typeof iterateReader>[0]} */ (
          /** @type {unknown} */ (changesRef)
        ),
      );

      for await (const change of changes) {
        const { add, remove } =
          /** @type {{ add?: string, remove?: string }} */ (change);
        if (add) {
          handleSpaceAdded(add).catch(window.reportError);
        }
        if (remove) {
          handleSpaceRemoved(remove);
        }
      }
    } catch {
      // Watching failed - fall back to non-reactive behavior
    }
  };

  /**
   * Load spaces from pet-store.
   *
   * @returns {Promise<void>}
   */
  const refresh = async () => {
    spacesMap.clear();
    homeSpaceConfig = HOME_SPACE_DEFAULTS;

    await null; // safe-await-separator
    try {
      // Check if 'spaces' directory exists by trying to list it
      const spaceIds = await E(powers).list('spaces');

      // Load all space configs in parallel
      const loadPromises = [];
      for await (const id of spaceIds) {
        loadPromises.push(
          loadSpaceConfig(id).then(config => {
            if (config) {
              if (id === '0') {
                // Space 0 is the home config — merge icon/scheme plus the
                // system-wide default-space preference.
                homeSpaceConfig = harden({
                  ...HOME_SPACE_DEFAULTS,
                  icon: config.icon,
                  scheme: config.scheme,
                  ...(config.defaultSpaceId
                    ? { defaultSpaceId: config.defaultSpaceId }
                    : {}),
                });
              } else {
                spacesMap.set(id, config);
              }
            }
          }),
        );
      }
      await Promise.all(loadPromises);
    } catch {
      // 'spaces' directory doesn't exist yet - that's fine
    }

    // Set active space based on current profile path
    syncActiveSpaceToPath();
    // Now that the configurations are known, record where the next load should
    // start. This is also what corrects a cache for a space that has since
    // moved, changed mode, or been removed.
    updateBootDefaultSpace();
    pushState();
  };

  /**
   * Get list of current spaces.
   *
   * @returns {SpaceConfig[]}
   */
  const getSpaces = () => getSpacesArray();

  /**
   * Get currently active space ID.
   *
   * @returns {string}
   */
  const getActiveSpaceId = () => activeSpaceId;

  /**
   * Point the gutter at a profile path something else navigated to.
   *
   * Advisory on purpose: when the space already open still matches the path,
   * the highlight stays where it is. Several spaces can share one profile path
   * — a chat and a file view of the same host, say — and re-deriving from the
   * path alone would quietly move the highlight to whichever of them was
   * created first.
   *
   * @param {string[]} path
   */
  const setActivePath = path => {
    activePath = path;
    const open =
      activeSpaceId === 'home' ? homeSpaceConfig : spacesMap.get(activeSpaceId);
    if (open && pathsEqual(open.profilePath, path)) {
      return;
    }
    activeSpaceId = findSpaceForPath(path);
    const opened =
      activeSpaceId === 'home' ? homeSpaceConfig : spacesMap.get(activeSpaceId);
    if (opened) {
      applyScheme(opened.scheme);
    }
    pushState();
  };

  /**
   * Handle keyboard shortcuts (Cmd+1..9).
   *
   * @param {KeyboardEvent} e
   */
  const handleKeydown = e => {
    // Check for Cmd+1 through Cmd+9 (or Ctrl on non-Mac)
    if (!e.metaKey && !e.ctrlKey) return;
    if (e.shiftKey || e.altKey) return;

    const key = e.key;
    const num = parseInt(key, 10);
    if (Number.isNaN(num) || num < 1 || num > 9) return;

    // 1-indexed: Cmd+1=home, Cmd+2=first user space, etc.
    const allSpaces = [homeSpaceConfig, ...getSpacesArray()];
    const index = num - 1;
    if (index < allSpaces.length) {
      e.preventDefault();
      selectSpace(allSpaces[index].id);
    }
  };

  // Set up keyboard listener
  document.addEventListener('keydown', handleKeydown);

  // Show shortcut badges when Command/Ctrl is held
  const handleModifierKeydown = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Meta' || e.key === 'Control') {
      $container.classList.add('show-shortcuts');
    }
  };
  const handleModifierKeyup = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Meta' || e.key === 'Control') {
      $container.classList.remove('show-shortcuts');
    }
  };
  // Also hide shortcuts when window loses focus
  const handleBlur = () => {
    $container.classList.remove('show-shortcuts');
  };
  document.addEventListener('keydown', handleModifierKeydown);
  document.addEventListener('keyup', handleModifierKeyup);
  window.addEventListener('blur', handleBlur);

  // The context menu dismisses itself via its in-tree focusable backdrop
  // (outside-click / Escape), so no document-level dismissal listeners are
  // needed here.

  // Mount the confined view once; subsequent repaints go through pushState().
  renderConfined(h(SpacesGutterView, { controller }), $container);

  // Load spaces, open the configured default space (once), then start watching.
  refresh()
    .then(() => applyInitialDefaultSpace())
    .then(() => watchSpaces())
    .catch(window.reportError);

  return harden({
    refresh,
    selectSpace,
    getSpaces,
    addSpace,
    updateSpace,
    removeSpace,
    getActiveSpaceId,
    setActivePath,
  });
};
harden(createSpacesGutter);
