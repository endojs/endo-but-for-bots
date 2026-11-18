// @ts-check
/**
 * The @-mention addon and the attachment chips (W5.8;
 * `designs/m5-interfaces.md` 4.1 items 2-3; R6-40, P-40).
 *
 * The addon (`composer.addon`) watches the composer's text before the
 * caret: `@` (at the start or after white space) followed by up to 80 label
 * characters opens a list of the operator inventory's labels
 * (`E(E(powers.operator).getInventory()).list(cursor)`). Choosing one calls
 * `replaceRange` to put `@label ` in the text and keeps a chip `{ label,
 * value }`, the inventory row's presence. Only chosen labels become chips:
 * an `@word` typed or pasted stays text (R6-40).
 *
 * Chips live in this module's memory, never in browser storage (presences
 * do not survive a reload):
 * - while composing, by the session's row key (the addon's props carry no
 *   request id: the controller makes it when Send is pressed);
 * - from the first `send` of a draft until its promise answers, by the
 *   draft's `requestId`, so a resend after a reconnect (same page) sends
 *   the same chips and so the same receipt fingerprint (text and labels).
 *
 * Beside the draft, the labels (only) of the chips a draft was sent with
 * are kept in `localStorage` under `familiar.mentions:<requestId>` for the
 * draft's life. After a reload the controller resends a draft with no
 * receipt (`resend: true`); this module then has no chips for it, and if
 * the text still holds an `@label` it made, `send` throws
 * `attachmentsLost` (the controller keeps the draft and shows the text).
 *
 * A chip whose `@label` is no longer in the text at Send is dropped (as a
 * Floot token deleted from its editor); the rest go in insertion order.
 */
import { E } from '@endo/far';
import { h } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { draftSessionKeys, readDraft } from '../controller/drafts.js';
import {
  attachmentsLost,
  labelUnits,
  maxAttachments,
  maxInventoryPages,
  maxSuggestions,
  mentionTextOf,
  mentionTexts,
} from './texts.js';

/** The storage key prefix of a draft's attachment labels. */
export const MENTION_PREFIX = 'familiar.mentions:';

/**
 * `@` at the start or after white space, then up to `labelUnits` characters
 * that a label may hold and that do not end a mention (white space, `@`,
 * `/`, control characters), up to the caret.
 */
const QUERY = new RegExp(`(?:^|\\s)@([^\\s@/\\p{Cc}]{0,${labelUnits}})$`, 'u');

/**
 * The mention being typed: the range `[start, end)` that a choice replaces
 * (from the `@` to the caret) and the typed text after the `@`.
 *
 * @param {string} text
 * @param {number} caret
 * @returns {{ start: number, end: number, query: string } | undefined}
 */
export const mentionQuery = (text, caret) => {
  const end = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, end);
  const match = QUERY.exec(before);
  if (!match) return undefined;
  const query = match[1];
  return { start: end - query.length - 1, end, query };
};
harden(mentionQuery);

/**
 * Inventory rows whose label contains `query` (case folded), labels that
 * start with it first, at most `limit`.
 *
 * @template {{ label: string }} T
 * @param {readonly T[]} rows
 * @param {string} query
 * @param {number} [limit]
 * @returns {T[]}
 */
export const matchRows = (rows, query, limit = maxSuggestions) => {
  const folded = query.toLowerCase();
  const starts = [];
  const contains = [];
  for (const row of rows) {
    const label = row.label.toLowerCase();
    if (label.startsWith(folded)) starts.push(row);
    else if (label.includes(folded)) contains.push(row);
  }
  return [...starts, ...contains].slice(0, limit);
};
harden(matchRows);

/**
 * The labels of a `TurnStarted` record's (or `turn-start` event's)
 * `attachments`, strings only.
 *
 * @param {any} record
 * @returns {string[]}
 */
export const attachmentLabels = record => {
  const list = record && record.attachments;
  if (!Array.isArray(list)) return [];
  return list.filter(label => typeof label === 'string');
};
harden(attachmentLabels);

/**
 * @typedef {{ label: string, value: any }} Chip
 * @typedef {{ state: 'idle'|'loading'|'ready'|'error', rows: Chip[], error?: string }} InventoryState
 */

/** @returns {any} `localStorage`, or undefined where it is blocked */
const defaultStorage = () => {
  try {
    const storage = /** @type {any} */ (globalThis).localStorage;
    return storage && typeof storage.getItem === 'function'
      ? storage
      : undefined;
  } catch {
    return undefined;
  }
};

/** @param {unknown} error */
const messageOf = error =>
  error && typeof error === 'object' && 'message' in error
    ? String(/** @type {{ message: unknown }} */ (error).message)
    : String(error);

/**
 * One mention addon and chip renderer (the page has one; tests make their
 * own, and a simulated reload is a new one over the same storage).
 *
 * @param {object} [options]
 * @param {() => any} [options.storage] answers `localStorage` or a fake
 *   (`getItem`, `setItem`, `removeItem`, `key`, `length`)
 */
export const makeMentions = ({ storage: storageOf = defaultStorage } = {}) => {
  /**
   * Composing chips by session row key.
   * @type {Map<string, Chip[]>}
   */
  const composing = new Map();
  /**
   * Chips of a draft being sent, by request id.
   * @type {Map<string, Chip[]>}
   */
  const sending = new Map();
  /** @type {WeakMap<object, InventoryState & { token: number }>} */
  const inventories = new WeakMap();
  /** @type {Set<() => void>} */
  const listeners = new Set();

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  // ---------------------------------------------------------- label records

  /** @param {string} requestId */
  const readLabels = requestId => {
    const storage = storageOf();
    if (!storage) return undefined;
    try {
      const raw = storage.getItem(`${MENTION_PREFIX}${requestId}`);
      if (raw === null) return undefined;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter(label => typeof label === 'string')
        : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * @param {string} requestId
   * @param {string[]} labels
   */
  const writeLabels = (requestId, labels) => {
    const storage = storageOf();
    if (!storage) return;
    try {
      storage.setItem(`${MENTION_PREFIX}${requestId}`, JSON.stringify(labels));
    } catch {
      // quota or blocked storage: a reload then resends without the check
    }
  };

  /** @param {string} requestId */
  const clearLabels = requestId => {
    const storage = storageOf();
    if (!storage) return;
    try {
      storage.removeItem(`${MENTION_PREFIX}${requestId}`);
    } catch {
      // blocked storage
    }
  };

  /**
   * Remove the label records of drafts that no longer exist (a draft the
   * controller cleared after finding its receipt), keeping `keep`. Bounded
   * by the drafts in storage: one per session.
   *
   * @param {string} keep
   */
  const pruneLabels = keep => {
    const storage = storageOf();
    if (!storage) return;
    try {
      const live = new Set([keep]);
      for (const sessionKey of draftSessionKeys(storage)) {
        const draft = readDraft(storage, sessionKey);
        if (draft) live.add(draft.requestId);
      }
      const stale = [];
      const count = Number(storage.length);
      for (let index = 0; index < count; index += 1) {
        const key = storage.key(index);
        if (
          key !== null &&
          key.startsWith(MENTION_PREFIX) &&
          !live.has(key.slice(MENTION_PREFIX.length))
        ) {
          stale.push(key);
        }
      }
      for (const key of stale) storage.removeItem(key);
    } catch {
      // blocked storage
    }
  };

  // ---------------------------------------------------------- chips

  /**
   * @param {string | undefined} sessionKey
   * @returns {Chip[]}
   */
  const chipsFor = sessionKey =>
    sessionKey === undefined ? [] : [...(composing.get(sessionKey) ?? [])];

  /**
   * Keep a chosen inventory row as a chip (once per label).
   *
   * @param {string} sessionKey
   * @param {Chip} chip
   * @returns {boolean} false when the message already has `maxAttachments`
   */
  const addChip = (sessionKey, { label, value }) => {
    const chips = composing.get(sessionKey) ?? [];
    if (chips.some(chip => chip.label === label)) return true;
    if (chips.length >= maxAttachments) return false;
    composing.set(sessionKey, [...chips, { label, value }]);
    notify();
    return true;
  };

  /**
   * @param {string} sessionKey
   * @param {string} label
   */
  const removeChip = (sessionKey, label) => {
    const chips = composing.get(sessionKey);
    if (!chips) return;
    const rest = chips.filter(chip => chip.label !== label);
    if (rest.length === 0) composing.delete(sessionKey);
    else composing.set(sessionKey, rest);
    notify();
  };

  /**
   * @param {readonly Chip[]} chips
   * @param {string} text
   */
  const mentioned = (chips, text) =>
    chips.filter(chip => text.includes(`@${chip.label}`));

  // ---------------------------------------------------------- inventory

  /**
   * The inventory rows as last read for this connection's powers; a load
   * starts when none ran yet or `refresh` is set (the list opened again).
   *
   * @param {any} powers
   * @param {boolean} refresh
   * @returns {InventoryState}
   */
  const inventoryFor = (powers, refresh) => {
    if (!powers || typeof powers !== 'object') {
      return { state: 'idle', rows: [] };
    }
    let entry = inventories.get(powers);
    if (entry && entry.state !== 'idle' && !refresh) return entry;
    if (entry && entry.state === 'loading') return entry;
    const token = (entry ? entry.token : 0) + 1;
    entry = {
      state: 'loading',
      rows: entry ? entry.rows : [],
      token,
    };
    inventories.set(powers, entry);
    const load = async () => {
      const inventory = E(powers.operator).getInventory();
      /** @type {Chip[]} */
      const rows = [];
      /** @type {string | undefined} */
      let cursor;
      for (let page = 0; page < maxInventoryPages; page += 1) {
        // eslint-disable-next-line no-await-in-loop
        const answer = await (cursor === undefined
          ? E(inventory).list()
          : E(inventory).list(cursor));
        for (const row of answer.rows) {
          rows.push({ label: row.label, value: row.value });
        }
        if (answer.next === undefined) break;
        cursor = answer.next;
      }
      return rows;
    };
    load().then(
      rows => {
        const current = inventories.get(powers);
        if (!current || current.token !== token) return;
        inventories.set(powers, { state: 'ready', rows, token });
        notify();
      },
      error => {
        const current = inventories.get(powers);
        if (!current || current.token !== token) return;
        inventories.set(powers, {
          state: 'error',
          rows: [],
          error: mentionTextOf.inventoryError(messageOf(error)),
          token,
        });
        notify();
      },
    );
    return entry;
  };

  // ---------------------------------------------------------- send

  /**
   * `UiFeature.send` (m3-interfaces.md 9.2; m5-interfaces.md 4.1 item 2).
   *
   * @param {import('../../../resources/agent-host/impl/gateway/contract-m3.js').ComposerSendRequest} request
   * @returns {Promise<any> | undefined}
   */
  const send = ({ context, session, text, requestId, resend }) => {
    const held = sending.get(requestId);
    /** @type {Chip[]} */
    let chips;
    if (resend) {
      if (!held) {
        const labels = readLabels(requestId);
        if (labels && labels.some(label => text.includes(`@${label}`))) {
          throw Error(attachmentsLost);
        }
        return undefined;
      }
      chips = held;
    } else {
      pruneLabels(requestId);
      const sessionKey = context.controller.getState().activeKey;
      const fresh = chipsFor(sessionKey);
      if (sessionKey !== undefined) composing.delete(sessionKey);
      const known = new Set((held ?? []).map(chip => chip.label));
      chips = mentioned(
        [...(held ?? []), ...fresh.filter(chip => !known.has(chip.label))],
        text,
      ).slice(0, maxAttachments);
      if (fresh.length > 0) notify();
      if (chips.length === 0) {
        sending.delete(requestId);
        clearLabels(requestId);
        return undefined;
      }
      sending.set(requestId, chips);
      writeLabels(
        requestId,
        chips.map(chip => chip.label),
      );
    }
    const attachments = harden(
      chips.map(({ label, value }) => ({ label, value })),
    );
    return E(context.powers.composer)
      .submit(session, text, requestId, harden({ attachments }))
      .then(receipt => {
        sending.delete(requestId);
        clearLabels(requestId);
        return receipt;
      });
  };

  // ---------------------------------------------------------- components

  /**
   * The composer addon: the suggestion list while a mention is typed and
   * the chips the next message will carry.
   *
   * @param {import('../../../resources/agent-host/impl/gateway/contract-m3.js').ComposerAddonProps} props
   */
  const MentionAddon = ({ context, input, replaceRange }) => {
    const [, setTick] = useState(0);
    const memory = useRef({ open: false, highlight: 0, dismissed: -1 });
    /** @type {{ current: any }} */
    const latest = useRef({ open: false, matches: [] });
    useLayoutEffect(() => {
      const listener = () => setTick(tick => tick + 1);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }, []);

    const sessionKey = context.controller.getState().activeKey;
    const text = input ? input.text : '';
    const query = input ? mentionQuery(text, input.caret) : undefined;
    const open =
      query !== undefined &&
      sessionKey !== undefined &&
      memory.current.dismissed !== query.start;
    if (query === undefined) memory.current.dismissed = -1;
    const opened = open && !memory.current.open;
    if (opened) memory.current.highlight = 0;
    memory.current.open = open;
    const inventory = open
      ? inventoryFor(context.powers, opened)
      : { state: 'idle', rows: [] };
    const matches = open && query ? matchRows(inventory.rows, query.query) : [];
    const highlight = Math.min(
      memory.current.highlight,
      Math.max(0, matches.length - 1),
    );
    const chips =
      sessionKey === undefined ? [] : mentioned(chipsFor(sessionKey), text);
    const [refusal, setRefusal] = useState(
      /** @type {string|undefined} */ (undefined),
    );

    /** @param {Chip} row */
    const choose = row => {
      const current = input ? mentionQuery(input.text, input.caret) : undefined;
      if (!current || sessionKey === undefined) return;
      if (!addChip(sessionKey, row)) {
        setRefusal(mentionTexts.tooMany);
        return;
      }
      setRefusal(undefined);
      replaceRange(current.start, current.end, `@${row.label} `);
    };

    // One keyboard listener for the component's life (capture phase, so
    // the composer does not see the keys the open list uses); it reads the
    // latest render through `latest`.
    latest.current = { open, matches, query, choose };
    useLayoutEffect(() => {
      const document = /** @type {any} */ (globalThis).document;
      if (!document || typeof document.addEventListener !== 'function') {
        return undefined;
      }
      /** @param {any} event */
      const onKey = event => {
        const now = latest.current;
        if (event.isComposing || !now.open || now.matches.length === 0) return;
        const count = now.matches.length;
        const at = Math.min(memory.current.highlight, count - 1);
        const handled = () => {
          event.preventDefault();
          event.stopPropagation();
        };
        if (event.key === 'ArrowDown') {
          handled();
          memory.current.highlight = (at + 1) % count;
          setTick(tick => tick + 1);
        } else if (event.key === 'ArrowUp') {
          handled();
          memory.current.highlight = (at + count - 1) % count;
          setTick(tick => tick + 1);
        } else if (event.key === 'Enter' || event.key === 'Tab') {
          handled();
          now.choose(now.matches[at]);
        } else if (event.key === 'Escape') {
          handled();
          if (now.query) memory.current.dismissed = now.query.start;
          setTick(tick => tick + 1);
        }
      };
      document.addEventListener('keydown', onKey, true);
      return () => document.removeEventListener('keydown', onKey, true);
    }, []);

    /** @returns {any} */
    const list = () => {
      if (!open) return null;
      /** @type {any[]} */
      let items;
      if (inventory.state === 'error') {
        items = [
          h(
            'div',
            { class: 'thix-mention-note', role: 'alert' },
            inventory.error,
          ),
        ];
      } else if (matches.length === 0) {
        items = [
          h(
            'div',
            { class: 'thix-mention-note' },
            inventory.state === 'ready'
              ? mentionTexts.noMatches
              : mentionTexts.loading,
          ),
        ];
      } else {
        items = matches.map((row, index) =>
          h(
            'button',
            {
              key: row.label,
              type: 'button',
              role: 'option',
              class: `thix-mention-option${index === highlight ? ' on' : ''}`,
              'aria-selected': index === highlight ? 'true' : 'false',
              'data-label': row.label,
              // Keep the composer's focus and caret: choose on mousedown.
              /** @param {any} event */
              onMouseDown: event => {
                event.preventDefault();
                choose(row);
              },
            },
            `@${row.label}`,
          ),
        );
      }
      return h(
        'div',
        {
          class: 'thix-mention-menu',
          role: 'listbox',
          'aria-label': mentionTexts.suggestions,
        },
        items,
      );
    };

    if (!open && chips.length === 0 && refusal === undefined) return null;
    return h(
      'div',
      { class: 'thix-mentions' },
      list(),
      refusal === undefined
        ? null
        : h('div', { class: 'thix-mention-note', role: 'alert' }, refusal),
      chips.length === 0
        ? null
        : h(
            'div',
            { class: 'thix-mention-chips' },
            chips.map(chip =>
              h(
                'span',
                {
                  key: chip.label,
                  class: 'thix-attachment-chip pending',
                  'data-label': chip.label,
                },
                h('span', { class: 'thix-attachment-label' }, `@${chip.label}`),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'thix-attachment-remove',
                    'aria-label': mentionTexts.removeChip,
                    onClick: () => {
                      if (sessionKey !== undefined) {
                        removeChip(sessionKey, chip.label);
                      }
                    },
                  },
                  '×',
                ),
              ),
            ),
          ),
    );
  };

  /**
   * The transcript's attachment chips (`message.renderer`): one "Attached
   * object" chip per label of the turn's `TurnStarted.attachments`.
   *
   * @param {import('../../../resources/agent-host/impl/gateway/contract-m3.js').MessageRendererProps} props
   */
  const AttachmentChips = ({ record }) => {
    const labels = attachmentLabels(record);
    if (labels.length === 0) return null;
    return h(
      'div',
      { class: 'thix-attachments' },
      labels.map((label, index) =>
        h(
          'span',
          {
            key: `${index}`,
            class: 'thix-attachment-chip',
            title: mentionTexts.attachedObject,
            'data-label': label,
          },
          h(
            'span',
            { class: 'thix-attachment-kind' },
            mentionTexts.attachedObject,
          ),
          h('span', { class: 'thix-attachment-label' }, label),
        ),
      ),
    );
  };

  const features = harden([
    {
      id: 'mentions.addon',
      slot: 'composer.addon',
      component: MentionAddon,
      send,
    },
    {
      id: 'mentions.chips',
      slot: 'message.renderer',
      component: AttachmentChips,
    },
  ]);

  return harden({
    features,
    send,
    chipsFor,
    addChip,
    removeChip,
    MentionAddon,
    AttachmentChips,
  });
};
harden(makeMentions);
