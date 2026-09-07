// @ts-check
import harden from '@endo/harden';
import { createHash } from 'node:crypto';

/**
 * Explain the same conservative session graph used for vat collection.
 * Secrets, wire payloads, and individual guest heap objects are not exposed.
 * @param {{ workers: Array<{workerId: string, awake: boolean, debugLabel?: string}>, hubState: any, endpointExports: any, endpointPendingAnswers?: string[], connectedSessions?: string[], keep?: string[] }} options
 */
export const inspectVatReachability = ({
  workers,
  hubState,
  endpointExports,
  endpointPendingAnswers = [],
  connectedSessions = [],
  keep = [],
}) => {
  const ids = new Set(workers.map(worker => worker.workerId));
  for (const id of keep) if (!ids.has(id)) throw Error('Unknown keep worker');
  const kept = new Set(keep);
  const connected = new Set(connectedSessions);
  const published = new Set(Object.values(hubState?.publications ?? {}));
  /** @type {Map<string, any>} */
  const nodes = new Map(
    workers.map(worker => [
      worker.workerId,
      { ...worker, roots: [], path: undefined },
    ]),
  );
  /** @type {Map<string, {holder: string, target: string, kind: string}>} */
  const edges = new Map();
  /** @param {string} id @param {any} reason */
  const root = (id, reason) => {
    const node = nodes.get(id);
    if (
      !node.roots.some(
        existing => JSON.stringify(existing) === JSON.stringify(reason),
      )
    )
      node.roots.push(reason);
  };
  for (const worker of workers) {
    if (worker.awake) root(worker.workerId, { kind: 'awake' });
    if (kept.has(worker.workerId)) root(worker.workerId, { kind: 'keep' });
  }
  /** @type {Record<string, any>} */
  const refs = hubState?.refs ?? {};
  /** @param {string} refId @param {boolean} [resolver] */
  const targetOf = (refId, resolver = false) => {
    const row = refs[refId];
    if (!row || row.dead || (row.resolver && !resolver)) return undefined;
    let target = row.origin;
    let facade = false;
    if (
      target === 'endpoint' &&
      row.backing === 'export' &&
      row.flavor === 'object'
    ) {
      const description = endpointExports?.[`o+${row.position}`];
      if (
        description?.kind === 'resource' &&
        description.name === 'worker-facade'
      ) {
        target = description.description?.workerId;
        facade = true;
      }
    }
    return ids.has(target) ? { target, facade } : undefined;
  };
  /** @param {string} holder @param {string} refId @param {string} kind @param {boolean} [resolver] @param {boolean} [hostOperation] */
  const reference = (
    holder,
    refId,
    kind,
    resolver = false,
    hostOperation = false,
  ) => {
    const resolved = targetOf(refId, resolver);
    if (!resolved || (holder === 'endpoint' && !hostOperation)) return;
    const { target, facade } = resolved;
    const edge = { holder, target, kind: facade ? 'worker-facade' : kind };
    edges.set(JSON.stringify(edge), edge);
    if (holder === 'endpoint') root(target, { kind: 'host-operation' });
    else if (!ids.has(holder))
      root(target, {
        kind: 'remote-session',
        session: holder,
        connected: connected.has(holder),
        durable: Boolean(hubState?.sessions?.[holder]?.durable),
      });
  };
  for (const [refId, row] of Object.entries(refs)) {
    const resolved = targetOf(refId);
    if (resolved && published.has(refId))
      root(resolved.target, { kind: 'publication' });
    for (const holder of Object.keys(row.refcounts ?? {}))
      reference(holder, refId, 'reference');
    // Active listeners are strong callback obligations, unlike unrelated resolver
    // plumbing. A rooted producer must retain the vat running its callback.
    if (!row.dead)
      for (const listener of row.listeners ?? [])
        reference(row.origin, listener, 'listener', true, true);
  }
  const pendingHostAnswers = new Set(endpointPendingAnswers);
  for (const [holder, session] of Object.entries(
    /** @type {Record<string, any>} */ (hubState?.sessions ?? {}),
  )) {
    for (const [position, route] of Object.entries(
      /** @type {Record<string, any>} */ (session.answersOwed ?? {}),
    )) {
      const refId = route.ref ?? route.local;
      if (typeof refId === 'string')
        reference(
          holder,
          refId,
          'answer',
          false,
          pendingHostAnswers.has(position),
        );
    }
  }
  // Deposits and withdrawal waiters are hub-owned obligations with no ordinary
  // facing refcount. Keep them until the hub releases them, without identifiers.
  for (const refId of Object.values(
    /** @type {Record<string, string>} */ (hubState?.gifts ?? {}),
  )) {
    const resolved = targetOf(refId);
    if (resolved) root(resolved.target, { kind: 'gift' });
  }
  for (const waiters of Object.values(
    /** @type {Record<string, string[]>} */ (hubState?.giftWaiters ?? {}),
  )) {
    for (const refId of waiters) {
      const resolved = targetOf(refId, true);
      if (resolved) root(resolved.target, { kind: 'gift-waiter' });
    }
  }
  const ordered = [...nodes.values()].sort((a, b) =>
    a.workerId.localeCompare(b.workerId),
  );
  for (const node of ordered)
    if (node.roots.length) node.path = [node.workerId];
  const references = [...edges.values()].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const { holder, target } of references) {
      const from = nodes.get(holder);
      const to = nodes.get(target);
      if (from?.path && !to.path) {
        to.path = [...from.path, target];
        changed = true;
      }
    }
  }
  // Session keys can contain bearer resumption tokens. Fingerprint only at the
  // reporting boundary; graph traversal and root classification use exact keys.
  /** @param {string} session */
  const displaySession = session =>
    ids.has(session) || session === 'endpoint'
      ? session
      : `session:${createHash('sha256').update(session).digest('hex')}`;
  return harden({
    workers: ordered.map(node => ({
      ...node,
      roots: node.roots.map((/** @type {any} */ reason) =>
        reason.kind === 'remote-session'
          ? { ...reason, session: displaySession(reason.session) }
          : reason,
      ),
      reachable: node.path !== undefined,
    })),
    references: references.map(edge => ({
      ...edge,
      holder: displaySession(edge.holder),
      retaining:
        !ids.has(edge.holder) || nodes.get(edge.holder).path !== undefined,
    })),
    collectible: ordered
      .filter(node => node.path === undefined)
      .map(node => node.workerId),
  });
};
harden(inspectVatReachability);
