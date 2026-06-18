// @ts-check
/* eslint-disable no-continue */

import harden from '@endo/harden';

/** @import { ERef } from '@endo/far' */
/** @import { EndoHost } from '@endo/daemon' */

import { E } from '@endo/far';
import { isSpecialName } from '@endo/daemon/pet-name.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import {
  CONVERSABLE_TYPES,
  HUB_TYPES,
  NON_EXPANDABLE_TYPES,
  makeStaticTreePowers,
} from './inventory-tree-source.js';
import { makeChannelReorder, makeItemDragDrop } from './inventory-dnd.js';

/**
 * @typedef {object} InventoryOptions
 * @property {(value: unknown, id?: string, petNamePath?: string[], messageContext?: { number: bigint, edgeName: string }) => void | Promise<void>} showValue
 * @property {((petName: string | string[], formulaId: string) => void)} [onSelectConversation]
 * @property {string | null} [activeConversationPetName]
 * @property {boolean} [channelMode] - If true, show "Channels" header and channel-specific UI
 * @property {(channelPetName: string) => void} [onSelectChannel] - Called when a channel is selected
 * @property {string | null} [activeChannelPetName] - Currently active channel pet name
 * @property {string[]} [channelOrder] - Persisted channel display order
 * @property {(order: string[]) => void} [onChannelReorder] - Called when channels are reordered via drag
 * @property {Array<{key: string, channelPetName: string, label: string}>} [bookmarks] - Bookmarked threads
 * @property {(channelPetName: string, threadKey: string) => void} [onSelectBookmark] - Navigate to bookmarked thread
 * @property {(bookmark: {key: string, channelPetName: string, label: string}) => void} [onRemoveBookmark] - Remove a bookmark
 * @property {'chat' | 'forum' | 'outliner' | 'microblog'} [viewMode] - Current view mode
 * @property {(mode: 'chat' | 'forum' | 'outliner' | 'microblog') => void} [onViewModeChange] - Change view mode
 */

/**
 * @param {HTMLElement} $parent
 * @param {HTMLElement | null} _end
 * @param {ERef<EndoHost>} powers
 * @param {InventoryOptions} options
 * @param {string[]} [path] - Current path for nested inventories
 * @param {ERef<EndoHost>} [rootPowers] - Top-level powers for the whole tree,
 *   against which drag-and-drop link/move operate. Defaults to `powers` so the
 *   outermost level is its own root.
 * @param {string[]} [rootPrefix] - Absolute pet-name path from `rootPowers` to
 *   this level. Drag-and-drop addresses items by `[...rootPrefix, name]` so that
 *   items can be moved both up and down the tree in one coordinate space.
 */
export const inventoryComponent = async (
  $parent,
  _end,
  powers,
  {
    showValue,
    onSelectConversation,
    activeConversationPetName,
    channelMode,
    onSelectChannel,
    activeChannelPetName,
    channelOrder,
    onChannelReorder,
    bookmarks,
    onSelectBookmark,
    onRemoveBookmark,
    viewMode,
    onViewModeChange,
  },
  path = [],
  rootPowers = powers,
  rootPrefix = [],
) => {
  const $list = /** @type {HTMLElement} */ (
    $parent.querySelector('.pet-list') || $parent
  );

  // Update header text for channel mode
  if (channelMode && path.length === 0) {
    const $title = $parent.querySelector('.inventory-title');
    if ($title) {
      $title.textContent = 'Channels';
    }

    // Add channel action buttons if not already present
    const $header = $parent.querySelector('.inventory-header');
    if ($header && !$header.querySelector('.channel-actions')) {
      const $actions = document.createElement('span');
      $actions.className = 'channel-actions';

      const $newBtn = document.createElement('button');
      $newBtn.className = 'channel-action-btn';
      $newBtn.textContent = 'New';
      $newBtn.title = 'Create a new channel';

      const $joinBtn = document.createElement('button');
      $joinBtn.className = 'channel-action-btn';
      $joinBtn.textContent = 'Join';
      $joinBtn.title = 'Join an existing channel';

      $actions.appendChild($newBtn);
      $actions.appendChild($joinBtn);

      // Insert before the toggle label
      const $toggle = $header.querySelector('.inventory-toggle');
      if ($toggle) {
        $header.insertBefore($actions, $toggle);
      } else {
        $header.appendChild($actions);
      }

      // Inline form container (shared between New and Join)
      let $inlineForm = $parent.querySelector('.channel-inline-form');
      if (!$inlineForm) {
        $inlineForm = document.createElement('div');
        $inlineForm.className = 'channel-inline-form';
        // Insert between header and pet-list
        const $petList = $parent.querySelector('.pet-list');
        if ($petList) {
          $parent.insertBefore($inlineForm, $petList);
        } else {
          $parent.appendChild($inlineForm);
        }
      }

      /**
       * Show the "New Channel" inline form.
       */
      const showNewForm = () => {
        if (!$inlineForm) return;
        $inlineForm.innerHTML = '';
        $inlineForm.classList.add('visible');

        const $form = document.createElement('div');
        $form.className = 'channel-form';

        const $nameInput = document.createElement('input');
        $nameInput.type = 'text';
        $nameInput.placeholder = 'Channel name';
        $nameInput.className = 'channel-form-input';

        const $displayInput = document.createElement('input');
        $displayInput.type = 'text';
        $displayInput.placeholder = 'Your display name';
        $displayInput.className = 'channel-form-input';

        const $btnRow = document.createElement('div');
        $btnRow.className = 'channel-form-buttons';

        const $createBtn = document.createElement('button');
        $createBtn.className = 'channel-form-submit';
        $createBtn.textContent = 'Create';

        const $cancelBtn = document.createElement('button');
        $cancelBtn.className = 'channel-form-cancel';
        $cancelBtn.textContent = 'Cancel';

        $btnRow.appendChild($createBtn);
        $btnRow.appendChild($cancelBtn);

        $form.appendChild($nameInput);
        $form.appendChild($displayInput);
        $form.appendChild($btnRow);
        $inlineForm.appendChild($form);

        $nameInput.focus();

        $cancelBtn.onclick = () => {
          $inlineForm.classList.remove('visible');
          $inlineForm.innerHTML = '';
        };

        $createBtn.onclick = async () => {
          const petName = $nameInput.value.trim();
          const displayName = $displayInput.value.trim();
          if (!petName || !displayName) return;

          $createBtn.disabled = true;
          $createBtn.textContent = 'Creating...';
          try {
            await E(powers).makeChannel(petName, displayName);
            $inlineForm.classList.remove('visible');
            $inlineForm.innerHTML = '';
            // Auto-select the new channel
            if (onSelectChannel) {
              onSelectChannel(petName);
            }
          } catch (err) {
            window.reportError(/** @type {Error} */ (err));
            $createBtn.disabled = false;
            $createBtn.textContent = 'Create';
          }
        };

        // Submit on Enter in last input
        $displayInput.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            $createBtn.click();
          }
        });
      };

      /**
       * Show the "Join Channel" inline form.
       */
      const showJoinForm = () => {
        if (!$inlineForm) return;
        $inlineForm.innerHTML = '';
        $inlineForm.classList.add('visible');

        const $form = document.createElement('div');
        $form.className = 'channel-form';

        const $locatorInput = document.createElement('input');
        $locatorInput.type = 'text';
        $locatorInput.placeholder = 'Locator URL';
        $locatorInput.className = 'channel-form-input';

        const $nameInput = document.createElement('input');
        $nameInput.type = 'text';
        $nameInput.placeholder = 'Channel name (local)';
        $nameInput.className = 'channel-form-input';

        const $btnRow = document.createElement('div');
        $btnRow.className = 'channel-form-buttons';

        const $joinSubmit = document.createElement('button');
        $joinSubmit.className = 'channel-form-submit';
        $joinSubmit.textContent = 'Join';

        const $cancelBtn = document.createElement('button');
        $cancelBtn.className = 'channel-form-cancel';
        $cancelBtn.textContent = 'Cancel';

        $btnRow.appendChild($joinSubmit);
        $btnRow.appendChild($cancelBtn);

        $form.appendChild($locatorInput);
        $form.appendChild($nameInput);
        $form.appendChild($btnRow);
        $inlineForm.appendChild($form);

        $locatorInput.focus();

        $cancelBtn.onclick = () => {
          $inlineForm.classList.remove('visible');
          $inlineForm.innerHTML = '';
        };

        $joinSubmit.onclick = async () => {
          const locator = $locatorInput.value.trim();
          const petName = $nameInput.value.trim();
          if (!locator || !petName) return;

          $joinSubmit.disabled = true;
          $joinSubmit.textContent = 'Joining...';
          try {
            // Validate the locator URL and extract connection hints.
            const url = new URL(locator);
            const formulaNumber = url.searchParams.get('id');
            const nodeNumber = url.hostname;
            if (!formulaNumber) {
              throw new Error('Invalid locator: missing formula id');
            }
            // Register peer info from connection hints so the daemon
            // knows how to reach the remote node.
            const addresses = url.searchParams.getAll('at');
            if (addresses.length > 0 && nodeNumber) {
              await E(
                /** @type {{ addPeerInfo: (info: { node: string, addresses: string[] }) => Promise<void> }} */ (
                  /** @type {unknown} */ (powers)
                ),
              ).addPeerInfo({ node: nodeNumber, addresses });
            }
            // Pass the original endo:// locator to storeLocator so the
            // system can drop bare-identifier support in the future.
            await E(powers).storeLocator(petName, locator);
            $inlineForm.classList.remove('visible');
            $inlineForm.innerHTML = '';
            // Auto-select the new channel
            if (onSelectChannel) {
              onSelectChannel(petName);
            }
          } catch (err) {
            window.reportError(/** @type {Error} */ (err));
            $joinSubmit.disabled = false;
            $joinSubmit.textContent = 'Join';
          }
        };

        // Submit on Enter in last input
        $nameInput.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            $joinSubmit.click();
          }
        });
      };

      $newBtn.onclick = showNewForm;
      $joinBtn.onclick = showJoinForm;
    }
  }

  /** @type {Map<string, { $wrapper: HTMLElement, cleanup?: () => void }>} */
  const $names = new Map();

  // Item-move drag-and-drop (link/move within the tree). Operates in absolute
  // coordinates against `rootPowers`. See inventory-dnd.js.
  const itemDnd = makeItemDragDrop({ rootPowers });
  // Channel-list reordering (channel mode only). See inventory-dnd.js.
  const channelReorder = makeChannelReorder();

  /**
   * Create an inventory item with disclosure triangle.
   * @param {string} name
   */
  const createItem = name => {
    const itemPath = [...path, name];
    // Absolute path from the tree root, used for cross-level drag-and-drop.
    const absPath = [...rootPrefix, name];
    // Whether this item is a name hub that can accept a dropped item. Set once
    // the formula type is probed below; until then it rejects row drops, which
    // then fall through to the containing directory's list-level drop zone.
    let acceptsDrop = false;

    const $wrapper = document.createElement('div');
    $wrapper.className = 'pet-item-wrapper';
    if (isSpecialName(name)) {
      $wrapper.classList.add('special');
    }
    // In channel mode, hide items until we confirm they are channels
    if (channelMode) {
      $wrapper.style.display = 'none';
    }

    const $row = document.createElement('div');
    $row.className = 'pet-item-row';

    // Make non-special items draggable (carry the absolute path so the item
    // can be dropped at any level, up or down the tree).
    if (!isSpecialName(name)) {
      itemDnd.attachDragSource($row, absPath);
    }

    // Disclosure triangle
    const $disclosure = document.createElement('button');
    $disclosure.className = 'pet-disclosure';
    $disclosure.textContent = '▶';
    $disclosure.title = 'Expand';
    $row.appendChild($disclosure);

    const $name = document.createElement('span');
    $name.className = 'pet-name';
    $name.textContent = name;
    $name.title = 'Click to view';
    $row.appendChild($name);

    const $buttons = document.createElement('span');
    $buttons.className = 'pet-buttons';

    const $info = document.createElement('button');
    $info.className = 'info-button';
    $info.textContent = 'ℹ';
    $info.title = 'Inspect';
    $buttons.appendChild($info);

    // Cancel button (disabled for special names)
    const $cancel = document.createElement('button');
    $cancel.className = 'cancel-button';
    $cancel.textContent = '⊘';
    if (isSpecialName(name)) {
      $cancel.disabled = true;
      $cancel.title = 'Cannot cancel system name';
    } else {
      $cancel.title = 'Cancel incarnation';
    }
    $buttons.appendChild($cancel);

    // Cancel confirmation state
    let cancelConfirmTimer = 0;
    if (!isSpecialName(name)) {
      $cancel.addEventListener('click', e => {
        e.stopPropagation();
        if ($cancel.classList.contains('confirming')) {
          // Second click — execute cancel.
          clearTimeout(cancelConfirmTimer);
          $cancel.classList.remove('confirming');
          $cancel.title = 'Cancelling...';
          $cancel.disabled = true;
          E(powers)
            .cancel(/** @type {[string, ...string[]]} */ (itemPath))
            .then(() => {
              $cancel.classList.add('cancelled');
              $cancel.title = 'Cancelled';
            })
            .catch(err => {
              console.error('[inventory] Cancel failed:', err);
              $cancel.disabled = false;
              $cancel.title = 'Cancel incarnation';
            });
        } else {
          // First click — enter confirm state.
          $cancel.classList.add('confirming');
          $cancel.title = 'Click again to cancel';
          cancelConfirmTimer = /** @type {any} */ (
            setTimeout(() => {
              $cancel.classList.remove('confirming');
              $cancel.title = 'Cancel incarnation';
            }, 3000)
          );
        }
      });
    }

    // Remove button (disabled for special names)
    const $remove = document.createElement('button');
    $remove.className = 'remove-button';
    $remove.textContent = '×';
    if (isSpecialName(name)) {
      $remove.disabled = true;
      $remove.title = 'Cannot remove system name';
    } else {
      $remove.title = 'Remove';
    }
    $buttons.appendChild($remove);

    $row.appendChild($buttons);
    $wrapper.appendChild($row);

    // Children container (initially hidden)
    const $children = document.createElement('div');
    $children.className = 'pet-children';
    $wrapper.appendChild($children);

    // Drop target: dropping onto a hub row offers to link or move the dragged
    // item into that hub. Non-hub (leaf) rows are not drop targets — the event
    // bubbles to the containing directory's list-level drop zone instead.
    // `acceptsDrop` is probed asynchronously below, so it is read at event time.
    itemDnd.attachRowDropTarget($row, {
      absPath,
      acceptsDrop: () => acceptsDrop,
    });

    if (channelMode) {
      // Newest channels at top (reordered after type detection)
      $list.prepend($wrapper);
    } else {
      $list.appendChild($wrapper);
    }

    const inspectItem = () => {
      const idP = E(powers).identify(
        .../** @type {[string, ...string[]]} */ (itemPath),
      );
      const valueP = E(powers).lookup(itemPath);
      Promise.all([idP, valueP]).then(
        ([id, value]) => showValue(value, id, itemPath, undefined),
        window.reportError,
      );
    };

    $info.onclick = inspectItem;
    $remove.onclick = () =>
      E(powers)
        .remove(.../** @type {[string, ...string[]]} */ (itemPath))
        .catch(window.reportError);

    // Probe the formula type to detect conversable items and non-expandable types.
    // Items without a locator (e.g. children of an immutable ReadableTree) get
    // their remove button disabled since they cannot be individually removed.
    E(powers)
      .locate(.../** @type {[string, ...string[]]} */ (itemPath))
      .then(locator => {
        if (!locator) {
          $remove.disabled = true;
          $remove.title = 'Cannot remove (immutable)';
          // Immutable items cannot be relinked or relocated.
          $row.draggable = false;
          // Still allow clicking the name to inspect the value
          $name.classList.add('selectable');
          $name.onclick = inspectItem;
          return;
        }
        const url = new URL(/** @type {string} */ (locator));
        const type = url.searchParams.get('type');

        // Show type badge on the item row.
        if (type) {
          const $typeBadge = document.createElement('span');
          $typeBadge.className = 'pet-type-badge';
          $typeBadge.textContent = type;
          $typeBadge.title = `Formula type: ${type}`;
          $name.after($typeBadge);
        }

        // Hide disclosure triangle for known non-expandable types
        if (type && NON_EXPANDABLE_TYPES.includes(type)) {
          $disclosure.classList.add('hidden');
        }

        // Only name hubs can accept a dropped item.
        if (type && HUB_TYPES.includes(type)) {
          acceptsDrop = true;
        }

        // Channel mode: make channel items selectable, hide non-channels
        if (channelMode && type === 'channel' && onSelectChannel) {
          $wrapper.style.display = '';
          $wrapper.classList.add('channel-item');
          $wrapper.dataset.name = name;
          $name.title = 'Switch to this channel';
          $name.classList.add('selectable');
          $name.onclick = () => {
            onSelectChannel(name);
          };
          if (
            activeChannelPetName &&
            path.length === 0 &&
            name === activeChannelPetName
          ) {
            $wrapper.classList.add('active-channel');
          }

          // Per-channel three-dot menu for view mode switching
          if (onViewModeChange) {
            const $menuBtn = document.createElement('button');
            $menuBtn.className = 'channel-sidebar-menu-btn';
            $menuBtn.textContent = '\u22EE';
            $menuBtn.title = 'Channel options';
            $menuBtn.addEventListener('click', menuE => {
              menuE.stopPropagation();
              // Remove any existing sidebar menus
              const $existing = document.querySelector('.channel-sidebar-menu');
              if ($existing) $existing.remove();

              const $menu = document.createElement('div');
              $menu.className = 'channel-sidebar-menu';
              const modes =
                /** @type {Array<'chat' | 'forum' | 'outliner' | 'microblog'>} */ ([
                  'chat',
                  'forum',
                  'outliner',
                  'microblog',
                ]);
              for (const mode of modes) {
                const $item = document.createElement('button');
                $item.className = 'channel-sidebar-menu-item';
                if (mode === viewMode) $item.classList.add('active');
                $item.textContent =
                  mode.charAt(0).toUpperCase() + mode.slice(1);
                $item.addEventListener('click', () => {
                  $menu.remove();
                  onViewModeChange(mode);
                });
                $menu.appendChild($item);
              }

              // Position relative to button
              const rect = $menuBtn.getBoundingClientRect();
              $menu.style.position = 'fixed';
              $menu.style.left = `${rect.right + 4}px`;
              $menu.style.top = `${rect.top}px`;
              document.body.appendChild($menu);

              const dismiss = () => {
                $menu.remove();
                document.removeEventListener('click', dismiss);
              };
              requestAnimationFrame(() => {
                document.addEventListener('click', dismiss);
              });
            });
            $buttons.insertBefore($menuBtn, $buttons.firstChild);
          }

          // Reorder according to stored channel order
          if (channelOrder) {
            const orderIdx = channelOrder.indexOf(name);
            if (orderIdx >= 0) {
              const existingItems = /** @type {NodeListOf<HTMLElement>} */ (
                $list.querySelectorAll('.channel-item[data-name]')
              );
              let reinserted = false;
              for (const item of existingItems) {
                if (item === $wrapper) continue;
                const itemIdx = channelOrder.indexOf(
                  /** @type {string} */ (item.dataset.name),
                );
                if (itemIdx < 0 || itemIdx > orderIdx) {
                  $list.insertBefore($wrapper, item);
                  reinserted = true;
                  break;
                }
              }
              if (!reinserted) {
                $list.appendChild($wrapper);
              }
            }
          }

          // Make channel items draggable for reordering
          channelReorder.attachDragSource($row, $wrapper, name);

          // Render bookmarked threads under this channel
          if (bookmarks && bookmarks.length > 0) {
            const channelBookmarks = bookmarks.filter(
              b => b.channelPetName === name,
            );
            if (channelBookmarks.length > 0) {
              for (const bm of channelBookmarks) {
                const $bmItem = document.createElement('div');
                $bmItem.className = 'bookmarked-thread-item';
                $bmItem.dataset.key = bm.key;
                $bmItem.dataset.channel = bm.channelPetName;
                const $bmLabel = document.createElement('span');
                $bmLabel.className = 'bookmark-label';
                $bmLabel.textContent = `\u2605 ${bm.label}`;
                $bmLabel.title = `Thread #${bm.key} in ${bm.channelPetName}`;
                $bmItem.appendChild($bmLabel);
                if (onSelectBookmark) {
                  $bmItem.style.cursor = 'pointer';
                  $bmItem.addEventListener('click', () => {
                    onSelectBookmark(bm.channelPetName, bm.key);
                  });
                }
                if (onRemoveBookmark) {
                  $bmItem.addEventListener('contextmenu', ctxE => {
                    ctxE.preventDefault();
                    const $menu = document.createElement('div');
                    $menu.className = 'bookmark-context-menu';
                    const $removeBtn = document.createElement('button');
                    $removeBtn.textContent = 'Remove bookmark';
                    $removeBtn.addEventListener('click', () => {
                      onRemoveBookmark(bm);
                      $bmItem.remove();
                      $menu.remove();
                    });
                    $menu.appendChild($removeBtn);
                    $menu.style.position = 'fixed';
                    $menu.style.left = `${ctxE.clientX}px`;
                    $menu.style.top = `${ctxE.clientY}px`;
                    document.body.appendChild($menu);
                    const dismiss = () => {
                      $menu.remove();
                      document.removeEventListener('click', dismiss);
                    };
                    requestAnimationFrame(() => {
                      document.addEventListener('click', dismiss);
                    });
                  });
                }
                $children.appendChild($bmItem);
              }
              // Show the children container and update disclosure
              $children.style.display = '';
              $disclosure.textContent = '\u25BC';
              $disclosure.classList.add('expanded');
            }
          }
        }

        // Non-channel mode: detect conversable items
        if (!channelMode && onSelectConversation) {
          if (type && CONVERSABLE_TYPES.includes(type)) {
            $wrapper.classList.add('conversable');
            $name.title = 'Open conversation';
            $name.onclick = () => {
              onSelectConversation(name, /** @type {string} */ (locator));
            };
            if (
              activeConversationPetName &&
              path.length === 0 &&
              name === activeConversationPetName
            ) {
              $wrapper.classList.add('active-conversation');
            }
          } else {
            // Non-conversable: clicking the name opens the Show Value modal
            $name.classList.add('selectable');
            $name.onclick = inspectItem;
          }
        }
      })
      .catch(() => {
        // Item may have been removed
      });

    // Track expansion state and cleanup
    let isExpanded = false;
    /** @type {(() => void) | undefined} */
    let childCleanup;

    // Disclosure triangle click handler
    $disclosure.onclick = async () => {
      if (isExpanded) {
        // Collapse
        isExpanded = false;
        $disclosure.classList.remove('expanded');
        $disclosure.title = 'Expand';
        $children.classList.remove('expanded');
        // Clean up child subscriptions
        if (childCleanup) {
          childCleanup();
          childCleanup = undefined;
        }
        $children.innerHTML = '';
      } else {
        // Expand - try to load children
        $disclosure.classList.add('loading');
        try {
          const target =
            /** @type {ERef<{ __getMethodNames__: () => string[], list?: () => string[], followNameChanges?: () => AsyncIterator<{ add?: string, remove?: string }> }>} */ (
              await E(powers).lookup(itemPath)
            );
          // Use __getMethodNames__ to detect the target's capabilities
          // without probing methods that may not exist (avoids CapTP noise).
          // eslint-disable-next-line no-underscore-dangle
          const methods = await E(target).__getMethodNames__();

          /** @type {ERef<EndoHost> | undefined} */
          let nestedPowers;

          if (methods.includes('followNameChanges')) {
            // NameHub (directory, host, guest): use live subscription
            const changesIterator = E(
              /** @type {import('@endo/far').ERef<EndoHost>} */ (
                /** @type {unknown} */ (target)
              ),
            ).followNameChanges();

            nestedPowers = /** @type {ERef<EndoHost>} */ (
              /** @type {unknown} */ ({
                /** @param {string | string[]} subPathOrName */
                lookup: subPathOrName => {
                  const subPath =
                    typeof subPathOrName === 'string'
                      ? [subPathOrName]
                      : subPathOrName;
                  return E(powers).lookup([...itemPath, ...subPath]);
                },
                /** @param {string[]} subPath */
                remove: (...subPath) => {
                  const fullPath = [...itemPath, ...subPath];
                  return E(powers).remove(
                    .../** @type {[string, ...string[]]} */ (fullPath),
                  );
                },
                /** @param {string[]} subPath */
                identify: (...subPath) => {
                  const fullPath = [...itemPath, ...subPath];
                  return E(powers).identify(
                    .../** @type {[string, ...string[]]} */ (fullPath),
                  );
                },
                /** @param {string[]} subPath */
                locate: (...subPath) => {
                  const fullPath = [...itemPath, ...subPath];
                  return E(powers).locate(
                    .../** @type {[string, ...string[]]} */ (fullPath),
                  );
                },
                followNameChanges: () => changesIterator,
              })
            );
          } else if (methods.includes('list')) {
            // Static tree (ReadableTree, etc.): populate from list()
            const names = await E(target).list();
            nestedPowers = makeStaticTreePowers(target, names);
          }

          if (nestedPowers) {
            isExpanded = true;
            $disclosure.classList.remove('loading');
            $disclosure.classList.add('expanded');
            $disclosure.title = 'Collapse';
            $children.classList.add('expanded');

            const wrappedOnSelectConversation = onSelectConversation
              ? (
                  /** @type {string | string[]} */ leafName,
                  /** @type {string} */ locator,
                ) => {
                  const leafPath =
                    typeof leafName === 'string' ? [leafName] : leafName;
                  onSelectConversation([...itemPath, ...leafPath], locator);
                }
              : undefined;

            inventoryComponent(
              $children,
              null,
              nestedPowers,
              {
                showValue,
                onSelectConversation: wrappedOnSelectConversation,
                activeConversationPetName,
                channelMode,
                onSelectChannel,
                activeChannelPetName,
              },
              [], // Reset path since nestedPowers handles the prefix
              // Drag-and-drop stays in the root's absolute coordinate space so
              // items can move up out of this directory as well as down into it.
              rootPowers,
              absPath,
            ).catch(() => {
              // Silently handle errors (e.g., if the item is removed)
            });
          } else {
            // Not expandable (no list or followNameChanges)
            $disclosure.classList.remove('loading');
            $disclosure.classList.add('hidden');
          }
        } catch {
          // Lookup or introspection failed
          $disclosure.classList.remove('loading');
          $disclosure.classList.add('hidden');
        }
      }
    };

    return { $wrapper, cleanup: () => childCleanup?.() };
  };

  // ---- Channel list drag-and-drop reordering ----

  if (channelMode) {
    channelReorder.attachReorderZone($list, { onReorder: onChannelReorder });
  } else {
    // ---- List-level drop zone for link/move ----
    // Dropping onto the background of a directory's list links or moves the
    // dragged item into that directory (`rootPrefix`). At the outermost level
    // `rootPrefix` is empty, so this is how an item is moved *up* to the root.
    itemDnd.attachListDropZone($list, rootPrefix);
  }

  for await (const change of iterateReader(E(powers).followNameChanges())) {
    if ('add' in change) {
      const name = change.add;
      const item = createItem(name);
      $names.set(name, item);
    } else if ('remove' in change) {
      const item = $names.get(change.remove);
      if (item !== undefined) {
        item.cleanup?.();
        item.$wrapper.remove();
        $names.delete(change.remove);
      }
    }
  }
};
harden(inventoryComponent);
