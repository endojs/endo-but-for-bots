// @ts-check
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';

/** @typedef {{ label: string, kind: 'value'|'object'|'subagent', preview?: string, truncated?: boolean, childKey?: string }} InventoryRow */

const kindLabels = {
  value: 'Value',
  object: 'Object',
  subagent: 'Subagent',
};

/**
 * Mounted only while the selected agent's inventory is visible. A revision
 * covers every page; never display a mix of rows from different revisions.
 * @param {{ controller: any, sessionKey: string, revision?: number }} props
 */
const InventoryRows = ({ controller, sessionKey, revision }) => {
  const [rows, setRows] = useState(
    /** @type {InventoryRow[] | undefined} */ (undefined),
  );
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setFailed(false);
    const read = async () => {
      let page = await controller.getInventoryPage(sessionKey);
      let snapshotRevision = page.rev;
      const result = [];
      while (current) {
        // A stale cursor returns the first page of the newer revision.
        if (page.rev !== snapshotRevision) {
          result.length = 0;
          snapshotRevision = page.rev;
        }
        result.push(...page.rows);
        if (page.next === undefined) {
          setRows(result);
          return;
        }
        // eslint-disable-next-line no-await-in-loop
        page = await controller.getInventoryPage(sessionKey, page.next);
      }
    };
    read().catch(() => {
      if (current) setFailed(true);
    });
    return () => {
      current = false;
    };
  }, [controller, sessionKey, revision, attempt]);

  if (failed) {
    return h(
      'div',
      { class: 'thix-inventory-status', role: 'status' },
      'Inventory unavailable. ',
      h(
        'button',
        { type: 'button', onClick: () => setAttempt(n => n + 1) },
        'Retry',
      ),
    );
  }
  if (!rows || rows.length === 0) {
    return h(
      'p',
      { class: 'thix-inventory-status', role: 'status' },
      rows ? 'This agent’s inventory is empty.' : 'Loading inventory…',
    );
  }
  return h(
    'ul',
    { class: 'thix-inventory-list', 'aria-label': 'Inventory items' },
    rows.map(row =>
      h(
        'li',
        { key: row.label, 'data-label': row.label },
        row.kind === 'subagent' && row.label.startsWith('subagents/')
          ? h(
              'button',
              {
                type: 'button',
                class: 'thix-subagent-link',
                'aria-label': `Inspect ${row.label.slice('subagents/'.length)}`,
                onClick: () =>
                  controller.openSubagent(
                    sessionKey,
                    row.label.slice('subagents/'.length),
                    row.childKey,
                  ),
              },
              row.label,
            )
          : h('span', { class: 'thix-inventory-label' }, row.label),
        h('span', { class: 'thix-inventory-kind' }, kindLabels[row.kind]),
        row.preview === undefined
          ? null
          : h(
              'code',
              { class: 'thix-inventory-preview' },
              row.preview,
              row.truncated ? '…' : '',
            ),
      ),
    ),
  );
};

/** @param {{ state: any, controller: any, expanded: boolean }} props */
export const SessionInventory = ({ state, controller, expanded }) => {
  const selected = state.view?.info.key === state.activeKey;
  const contents = () => {
    if (!expanded) return null;
    let status;
    if (state.connection !== 'open') status = 'Inventory is offline.';
    else if (!selected || state.view.inventoryLoading)
      status = 'Loading inventory…';
    else if (state.view.inventoryRevision === undefined) {
      status = 'This session does not support inventory.';
    }
    if (status)
      return h('p', { class: 'thix-inventory-status', role: 'status' }, status);
    return h(InventoryRows, {
      key: state.activeKey,
      controller,
      sessionKey: state.activeKey,
      revision: state.view.inventoryRevision,
    });
  };
  return h(
    'aside',
    {
      id: 'thix-agent-inventory-items',
      class: 'thix-session-inventory',
      'aria-label': 'Agent inventory',
      'aria-hidden': !expanded,
      'data-expanded': String(expanded),
    },
    h(
      'div',
      { class: 'thix-inventory-sheet' },
      h('h2', { class: 'thix-inventory-title' }, 'Agent inventory'),
      contents(),
    ),
  );
};
