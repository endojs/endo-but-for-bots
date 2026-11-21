// @ts-check
import { h } from 'preact';
import { useEffect, useId, useState } from 'preact/hooks';

/** @typedef {{ label: string, kind: 'value'|'object'|'subagent', preview?: string, truncated?: boolean, childKey?: string }} InventoryRow */

/** @typedef {{ name: string, path: string, children: Map<string, InventoryNode>, row?: InventoryRow }} InventoryNode */

/** @param {InventoryRow[]} rows */
const inventoryTree = rows => {
  /** @type {Map<string, InventoryNode>} */
  const root = new Map();
  for (const row of rows) {
    let children = root;
    let path = '';
    for (const name of row.label.split('/')) {
      path += name;
      let node = children.get(name);
      if (!node) {
        node = { name, path, children: new Map() };
        children.set(name, node);
      }
      if (path === row.label) node.row = row;
      children = node.children;
      path += '/';
    }
  }
  return root;
};

const kindLabels = { object: 'Object', value: 'Value', subagent: 'Subagent' };
const alphabetic = new Intl.Collator('en', { sensitivity: 'base' });

/** @param {{ row: InventoryRow, name: string, controller: any, sessionKey: string }} props */
const InventoryItem = ({ row, name, controller, sessionKey }) => {
  const alias =
    row.kind === 'subagent' && row.label.startsWith('subagents/')
      ? row.label.slice('subagents/'.length)
      : undefined;
  const content = [
    h('span', { class: 'thix-inventory-label' }, name),
    h('span', { class: 'thix-inventory-kind' }, kindLabels[row.kind]),
    alias &&
      h('span', { class: 'thix-inventory-arrow', 'aria-hidden': true }, '›'),
    row.preview !== undefined &&
      h(
        'code',
        { class: 'thix-inventory-preview' },
        row.preview,
        row.truncated ? '…' : '',
      ),
  ];
  return h(
    'li',
    { 'data-label': row.label, title: row.label },
    alias
      ? h(
          'button',
          {
            class: 'thix-inventory-row thix-subagent-link',
            type: 'button',
            'aria-label': `Inspect ${alias}`,
            onClick: () =>
              controller.openSubagent(sessionKey, alias, row.childKey),
          },
          content,
        )
      : h('div', { class: 'thix-inventory-row' }, content),
  );
};

/** @param {{ node: InventoryNode, expanded: boolean, toggle: () => void, children?: import('preact').ComponentChildren }} props */
const InventoryFolder = ({ node, expanded, toggle, children }) => {
  const listId = useId();
  return h(
    'li',
    { 'data-directory': node.path },
    h(
      'button',
      {
        class: 'thix-inventory-folder',
        type: 'button',
        title: node.path,
        'aria-controls': listId,
        'aria-expanded': expanded,
        onClick: toggle,
      },
      h('span', { class: 'thix-inventory-caret', 'aria-hidden': true }, '▸'),
      h('span', { class: 'thix-inventory-folder-name' }, node.name),
    ),
    h(
      'ul',
      { class: 'thix-inventory-list', id: listId, hidden: !expanded },
      children,
    ),
  );
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
  const [collapsed, setCollapsed] = useState(
    /** @type {Set<string>} */ (new Set()),
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
  /**
   * @param {Map<string, InventoryNode>} nodes
   * @returns {import('preact').ComponentChildren}
   */
  const entries = nodes => {
    const sorted = [...nodes.values()].sort(
      (a, b) =>
        alphabetic.compare(a.name, b.name) ||
        (a.name === b.name ? 0 : a.name < b.name ? -1 : 1),
    );
    return sorted.flatMap(node => [
      node.row &&
        h(InventoryItem, {
          key: `leaf:${node.path}`,
          row: node.row,
          name: node.name,
          controller,
          sessionKey,
        }),
      node.children.size > 0 &&
        h(
          InventoryFolder,
          {
            key: `folder:${node.path}`,
            node,
            expanded: !collapsed.has(node.path),
            toggle: () =>
              setCollapsed(previous => {
                const next = new Set(previous);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              }),
          },
          entries(node.children),
        ),
    ]);
  };
  return h(
    'ul',
    { class: 'thix-inventory-list', 'aria-label': 'Inventory items' },
    entries(inventoryTree(rows)),
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
