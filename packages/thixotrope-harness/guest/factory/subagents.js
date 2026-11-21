// @ts-check
/**
 * The subagent tree: sessions the factory makes on a parent session's
 * behalf (designs/m9-interfaces.md D-M9-10, 3.1, 4.3, 4.4, 5; R4-69..R4-73,
 * R4-101, R4-102). The factory's tree is the system of record; a parent's
 * `subagents` runtime part only caches name -> handle and re-reads it with
 * `Delegation.children()` after a recovery.
 *
 * Objects it mints, each kept in a `WeakMap`:
 * - a `Delegation` per session row below the depth limit
 *   (`SessionServices.subagents`; none at the limit, R4-69);
 * - a `SubagentHandle` per child, bound in the post office as the child's
 *   mail address (`bindAddress`), so a parent may also `send` to it.
 *
 * Spawn: admission in the crank that receives the request (the name rule,
 * uniqueness among the parent's live children and its spawns in flight,
 * and the root tree's live descendants plus spawns in flight below
 * `maxDescendants`, R4-71), then the factory's ordinary creation through
 * the injected `create(options, { parent, endowments, link })` with the
 * parent's resolved backend (hence a subscription pool, which is chosen by
 * the Backend object itself), model, effort and preset, a hidden row
 * (`userInitiated: false`) and the listed attachments as the child's only
 * endowments (R4-70). Each spawn's reservation is stamped with the daemon
 * start it began in.
 *
 * Ask: one question in flight per child; the task goes through the post
 * office's `post` with `onReply`, so the child's reply never reaches the
 * parent's inbox (D-M9-8). The answer text is built here: a staged reply is
 * copied for the parent cut to the tool limit (`RelayWriters.copy` with
 * `maxUnits`, the attachment note as `suffix`); an inline one is answered
 * inline, or staged when the note makes it longer than `inlineBytes`.
 *
 * Stop and delete: depth-first through the injected `deleteSession`, one
 * session at a time; a node leaves the tree when its delete completes.
 *
 * Restarts (`restart(current)`): a reservation stamped with an earlier
 * start is released, or linked when the start listener completed its
 * creation (KM9, KM10); an ask stamped earlier is closed (its parent's
 * turn recovered, D-M9-16). Nothing here waits for a guest call (CC-110).
 *
 * Bounds (D-M9-13): one node per live child, one open ask per child,
 * reservations at most `maxDescendants` per tree. No lifetime count.
 *
 * Guest rules: prelude globals only; no clock (a spawn's `at` is the
 * parent's); names are compared in a loop over a parent's children, never
 * used as record keys.
 */
import { limits } from '../lib/limits.js';
import {
  interfaces as factoryInterfaces,
  texts as postOfficeTexts,
  textOf as postOfficeTextOf,
} from '../lib/guards/factory.js';
import {
  texts as mailTexts,
  textOf as mailTextOf,
  subagentNameSource,
} from '../lib/guards/session.js';
import { utf8Bytes } from '../lib/bounded.js';
import { stagePrompt } from '../session/prompt.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { Row, RowTable } from './rows.js' */
/** @import { StartCount } from './starts.js' */
/** @import { PostOffice } from './post-office.js' */
const { defineExoClass, makePromiseKit } = /** @type {GuestGlobals} */ (
  globalThis
);

const ML = limits;
const NAME = RegExp(subagentNameSource);
/** Units an ask answer's copy keeps before the tool limit's framing (4.3 step 5). */
export const ANSWER_UNITS = limits.toolOutputUnits - 1280;
/** `Delegation.children()` answers at most this many (`SubagentList`). */
const LISTED_CHILDREN = 64;
/** A parent chain longer than this is not followed (a guard, not a limit). */
const DEPTH_WALK = 64;

/**
 * What a child inherits from its parent: the parent's resolved creation
 * options (`session-options.js` `ResolvedOptions`).
 * @typedef {object} Inheritance
 * @property {any} backend
 * @property {string} modelId
 * @property {any} preset
 * @property {any} [presetSnapshot] the parent's preset snapshot: a child
 *   is made from it, never from a new snapshot of the live preset
 *   (D-M9-10, 4.4), so an operator's edit since cannot widen it
 * @property {string} [reasoningEffort]
 */

/**
 * @typedef {object} OpenAsk
 * @property {{ promise: Promise<any>, resolve: (value: any) => void, reject: (reason: any) => void }} kit
 * @property {number | undefined} postmark once the post office answered
 * @property {number} start the daemon start it was asked in
 * @property {boolean} closed answered or ended
 * @property {boolean} cancelled ended by a cancel, a stop or a restart
 */

/**
 * @typedef {object} Node one child
 * @property {Row} row
 * @property {Row} parent
 * @property {string} name
 * @property {any} handle
 * @property {OpenAsk | undefined} ask
 * @property {boolean} stopping
 */

/**
 * @typedef {object} Reservation a spawn in flight
 * @property {Row} root
 * @property {Row} parent
 * @property {string} name
 * @property {number} start
 * @property {Row | undefined} row the child's row once `create` added it
 * @property {boolean} released
 */

/**
 * @param {object} powers
 * @param {(options: Record<string, any>, how: { parent: Row, endowments: readonly any[], link: (row: Row) => void, presetSnapshot?: any }) => Promise<{ session: any, internal: any }>} powers.create
 *   the factory's creation (seam F3): stores `parent` on the new row, gives
 *   it `endowments` as its only `SessionServices.endowments`, calls
 *   `link(row)` once the row exists, and makes the session from
 *   `presetSnapshot` (the parent's) when given
 * @param {(session: any) => Promise<void>} powers.deleteSession
 * @param {RowTable} powers.rows
 * @param {PostOffice} powers.postOffice
 * @param {StartCount} powers.starts
 * @param {any} [powers.admin] the AgentHostAdmin: an inline answer longer
 *   than `inlineBytes` with its note is staged through `writersFor()`
 * @param {{ current: () => Record<string, any> }} [powers.settings] the
 *   harness settings (`maxDescendants`, `maxDepth`; defaults `limits`)
 */
export const makeSubagents = ({
  create,
  deleteSession,
  rows,
  postOffice,
  starts,
  admin,
  settings,
}) => {
  const I = factoryInterfaces;

  /**
   * @param {'maxDepth' | 'maxDescendants'} name
   * @returns {number}
   */
  const setting = name => {
    const value = settings?.current()[name];
    return typeof value === 'number' ? value : ML[name];
  };

  /** @type {((node: Node) => any) | undefined} */
  let makeHandle;
  /** @type {((row: Row) => any) | undefined} */
  let makeDelegation;
  /** @type {WeakMap<Row, Node>} */
  const nodes = new WeakMap();
  /** @type {WeakMap<Row, Set<Node>>} a row's children, in spawn order */
  const childrenOf = new WeakMap();
  /** @type {WeakMap<Row, any>} */
  const delegations = new WeakMap();
  /** @type {WeakMap<Row, Inheritance>} */
  const inherited = new WeakMap();
  /** @type {Set<Reservation>} */
  const reservations = new Set();
  /** @type {Set<Node>} nodes with an open ask (restart closes them) */
  const asking = new Set();

  /** @param {Row} row */
  const parentOf = row =>
    nodes.get(row)?.parent ?? /** @type {any} */ (row).parent;

  /** @param {Row} row */
  const depthOf = row => {
    let depth = 0;
    for (let at = parentOf(row); at !== undefined && depth < DEPTH_WALK;) {
      depth += 1;
      at = parentOf(at);
    }
    return depth;
  };

  /** @param {Row} row */
  const rootOf = row => {
    let root = row;
    for (let i = 0; i < DEPTH_WALK; i += 1) {
      const up = parentOf(root);
      if (up === undefined) break;
      root = up;
    }
    return root;
  };

  /** @param {Row} row */
  const gone = row => row.dropped;

  /** @type {WeakSet<Row>} rows whose children are being deleted */
  const closing = new WeakSet();
  /**
   * A parent that can no longer hold a child: dropped, deleting, or its
   * children's delete hook already ran.
   * @param {Row} row
   */
  const closed = row =>
    gone(row) || row.state === 'deleting' || closing.has(row);

  /**
   * Delete a child made under a parent that closed meanwhile (a spawn in
   * flight at the parent's delete, or one linked after a restart): the
   * child never joins the tree, so nothing else would delete it.
   * @param {Row} row
   */
  const deleteOrphan = row =>
    row.session === undefined || gone(row)
      ? Promise.resolve()
      : deleteSession(row.session);

  /**
   * A row's live children; nodes whose rows were dropped (a delete that
   * completed after a restart, KM11) leave the tree here.
   * @param {Row} row
   */
  const liveChildren = row => {
    const set = childrenOf.get(row);
    if (set === undefined) return [];
    for (const node of set) {
      if (gone(node.row)) {
        set.delete(node);
        nodes.delete(node.row);
      }
    }
    return [...set];
  };

  /** @param {Row} row live descendants below `row` */
  const descendants = row => {
    let n = 0;
    /** @type {Row[]} */
    const todo = [row];
    while (todo.length > 0) {
      const at = /** @type {Row} */ (todo.pop());
      for (const child of liveChildren(at)) {
        n += 1;
        todo.push(child.row);
      }
    }
    return n;
  };

  /** @param {Node} node */
  const stateOf = node => {
    if (node.stopping) return 'stopping';
    if (node.row.state === 'lost' || gone(node.row)) return 'lost';
    return node.ask === undefined ? 'ready' : 'asking';
  };

  /**
   * End a node's open ask (cancelled, stopped, a restart): the post office
   * closes the postmark and tells the child (`cancelMail`); a later reply is
   * consumed.
   * @param {Node} node
   * @param {string} reason
   */
  const endAsk = (node, reason) => {
    const { ask } = node;
    if (ask === undefined) return;
    node.ask = undefined;
    asking.delete(node);
    ask.closed = true;
    ask.cancelled = true;
    if (ask.postmark !== undefined) postOffice.cancelDelivery(ask.postmark);
    ask.kit.reject(Error(reason));
  };

  /**
   * The answer a reply makes for the parent (4.3 step 5).
   * @param {Node} node
   * @param {any} reply `post-office.js` `Reply`
   */
  const answerOf = async (node, reply) => {
    const edges = harden(
      reply.attachments.map((/** @type {any} */ a) => a.label),
    );
    const note =
      edges.length === 0 ? '' : postOfficeTextOf.answerAttachments(edges);
    const { body } = reply;
    if (typeof body === 'object') {
      const text = await postOffice.copy(body.blob, {
        maxUnits: ANSWER_UNITS,
        suffix: note,
        from: node.row.session,
        to: node.parent.session,
      });
      return harden({ text, edges });
    }
    const full = `${body}${note}`;
    if (utf8Bytes(full) <= limits.inlineBytes) {
      return harden({ text: full, edges });
    }
    return harden({
      text: await stagePrompt(admin, full, node.parent.session),
      edges,
    });
  };

  /**
   * @param {Node} node
   * @param {any} request `AskRequest`
   * @returns {Promise<any>} `AskAnswer`
   */
  const ask = async (node, { task, attachments, at }) => {
    if (stateOf(node) === 'lost') {
      throw Error(postOfficeTextOf.subagentLost(node.name));
    }
    if (node.stopping) throw Error(mailTexts.askAbandoned);
    if (node.ask !== undefined) {
      throw Error(mailTextOf.askInFlight(node.name));
    }
    /** @type {OpenAsk} */
    const open = {
      kit: makePromiseKit(),
      postmark: undefined,
      start: starts.current(),
      closed: false,
      cancelled: false,
    };
    node.ask = open;
    asking.add(node);
    const finish = () => {
      if (node.ask === open) {
        node.ask = undefined;
        asking.delete(node);
      }
      open.closed = true;
    };
    /** @param {any} reply */
    const onReply = reply => {
      if (open.closed) return;
      answerOf(node, reply).then(
        answer => {
          if (open.closed) {
            if (typeof answer.text === 'object')
              postOffice.release(answer.text);
            return;
          }
          finish();
          open.kit.resolve(answer);
        },
        error => {
          if (open.closed) return;
          finish();
          open.kit.reject(error);
        },
      );
    };
    postOffice
      .post({
        from: { row: node.parent },
        draft: harden({ to: [node.handle], body: task, attachments }),
        type: 'package',
        at,
        onReply,
      })
      .then(
        receipt => {
          const [result] = receipt.results;
          if (result.refused !== undefined) {
            if (open.closed) return;
            finish();
            open.kit.reject(
              Error(
                node.row.state === 'lost' || gone(node.row)
                  ? postOfficeTextOf.subagentLost(node.name)
                  : result.refused,
              ),
            );
            return;
          }
          open.postmark = result.postmark;
          // Cancelled before the post office answered: cancel it now.
          if (open.cancelled) {
            postOffice.cancelDelivery(result.postmark);
          }
        },
        error => {
          if (open.closed) return;
          finish();
          open.kit.reject(error);
        },
      );
    return open.kit.promise;
  };

  /**
   * Delete a child's subtree, deepest first, one session at a time; each
   * node leaves the tree when its own delete completed.
   * @param {Node} node
   * @returns {Promise<void>}
   */
  const deleteSubtree = async node => {
    node.stopping = true;
    endAsk(node, mailTexts.askAbandoned);
    for (const child of liveChildren(node.row)) {
      // eslint-disable-next-line no-await-in-loop
      await deleteSubtree(child);
    }
    if (!gone(node.row) && node.row.session !== undefined) {
      await deleteSession(node.row.session);
    }
    childrenOf.get(node.parent)?.delete(node);
    nodes.delete(node.row);
  };

  /**
   * The child's node, made once (a spawn's answer, or a restart linking a
   * creation the start listener completed).
   * @param {Row} parent
   * @param {Row} row
   * @param {string} name
   */
  const linkChild = (parent, row, name) => {
    const known = nodes.get(row);
    if (known !== undefined) return known;
    /** @type {Node} */
    const node = {
      row,
      parent,
      name,
      handle: undefined,
      ask: undefined,
      stopping: false,
    };
    makeHandle ??= defineExoClass(
      'SubagentHandle',
      I.SubagentHandle,
      /** @param {Node} child */
      child => ({ child }),
      {
        describe() {
          const { child } = this.state;
          return harden({
            name: child.name,
            state: stateOf(child),
            depth: depthOf(child.row),
          });
        },
        /** @param {any} request */
        ask(request) {
          return ask(this.state.child, request);
        },
        cancelAsk() {
          endAsk(this.state.child, mailTexts.askAbandoned);
          return undefined;
        },
        async stop() {
          await deleteSubtree(this.state.child);
          return undefined;
        },
      },
    );
    node.handle = makeHandle(node);
    postOffice.bindAddress(node.handle, row);
    nodes.set(row, node);
    let set = childrenOf.get(parent);
    if (set === undefined) {
      set = new Set();
      childrenOf.set(parent, set);
    }
    set.add(node);
    return node;
  };

  /** @param {Reservation} reservation */
  const release = reservation => {
    reservation.released = true;
    reservations.delete(reservation);
  };

  /**
   * @param {Row} parent
   * @param {any} request `SpawnRequest`
   */
  const spawn = async (parent, { name, attachments, at, systemPrompt }) => {
    if (closed(parent)) {
      throw Error(postOfficeTexts.notASession);
    }
    if (!NAME.test(name)) throw Error(mailTextOf.nameInvalid(name));
    for (const child of liveChildren(parent)) {
      if (child.name === name) throw Error(mailTextOf.subagentExists(name));
    }
    const root = rootOf(parent);
    let inFlight = 0;
    for (const r of reservations) {
      if (r.parent === parent && r.name === name) {
        throw Error(mailTextOf.subagentExists(name));
      }
      if (r.root === root) inFlight += 1;
    }
    const most = setting('maxDescendants');
    if (descendants(root) + inFlight >= most) {
      throw Error(postOfficeTextOf.treeLimit(most));
    }
    const from = inherited.get(parent);
    if (from === undefined) throw Error(postOfficeTexts.notASession);
    /** @type {Reservation} */
    const reservation = {
      root,
      parent,
      name,
      start: starts.current(),
      row: undefined,
      released: false,
    };
    reservations.add(reservation);
    const room = limits.titleUnits - name.length - 3;
    /** @type {Record<string, any>} */
    const options = {
      title: postOfficeTextOf.childTitle(parent.title.slice(0, room), name),
      backend: from.backend,
      modelId: from.modelId,
      preset: from.preset,
      userInitiated: false,
      at,
    };
    if (from.reasoningEffort !== undefined)
      options.reasoningEffort = from.reasoningEffort;
    if (systemPrompt !== undefined) options.systemPrompt = systemPrompt;
    /** @type {{ session: any, internal: any }} */
    let made;
    try {
      made = await create(harden(options), {
        parent,
        endowments: attachments,
        link: row => {
          reservation.row = row;
        },
        ...(from.presetSnapshot === undefined
          ? {}
          : { presetSnapshot: from.presetSnapshot }),
      });
      const row = rows.ofSession(made.session) ?? reservation.row;
      if (row !== undefined && closed(parent)) {
        // The parent was deleted while the child was made: the child goes
        // too, before the reservation is released.
        await deleteOrphan(row);
        throw Error(postOfficeTexts.notASession);
      }
    } finally {
      release(reservation);
    }
    const row = rows.ofSession(made.session) ?? reservation.row;
    if (row === undefined || gone(row)) {
      throw Error(postOfficeTextOf.subagentLost(name));
    }
    const node = linkChild(parent, row, name);
    return harden({ handle: node.handle, title: row.title, childKey: row.key });
  };

  /**
   * The `Delegation` of `row` (the services builder, seam F4), minted once;
   * undefined at the depth limit (R4-69). `from` is the row's resolved
   * creation options, what its children inherit.
   * @param {Row} row
   * @param {Inheritance} from
   */
  const delegationFor = (row, from) => {
    if (depthOf(row) >= setting('maxDepth')) return undefined;
    if (!inherited.has(row)) {
      inherited.set(
        row,
        harden({
          backend: from.backend,
          modelId: from.modelId,
          preset: from.preset,
          ...(from.presetSnapshot === undefined
            ? {}
            : { presetSnapshot: from.presetSnapshot }),
          ...(from.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: from.reasoningEffort }),
        }),
      );
    }
    let delegation = delegations.get(row);
    if (delegation === undefined) {
      makeDelegation ??= defineExoClass(
        'Delegation',
        I.Delegation,
        /** @param {Row} parent */
        parent => ({ parent }),
        {
          /** @param {any} request */
          spawn(request) {
            return spawn(this.state.parent, request);
          },
          children() {
            return harden(
              liveChildren(this.state.parent)
                .slice(0, LISTED_CHILDREN)
                .map(node =>
                  harden({
                    name: node.name,
                    handle: node.handle,
                    childKey: node.row.key,
                    state: stateOf(node),
                  }),
                ),
            );
          },
        },
      );
      delegation = makeDelegation(row);
      delegations.set(row, delegation);
    }
    return delegation;
  };

  /**
   * A delete hook (seam F5, the built `{ row, session }` context): the
   * row's children first, deepest first. The row is marked closing first,
   * so a spawn still in flight deletes its child when its creation answers
   * (the hook does not wait for it: a creation cut off by a restart may
   * never answer, and `restart` deletes such a child instead).
   * @param {{ row: Row, session?: any }} context
   */
  const deleteChildren = async ({ row }) => {
    closing.add(row);
    for (const child of liveChildren(row)) {
      // eslint-disable-next-line no-await-in-loop
      await deleteSubtree(child);
    }
  };

  /**
   * A daemon start (`current` = the start listener's `starts.next()`),
   * after the creations' recovery: release or link the spawns cut off,
   * close the asks cut off. Answers without waiting for any guest call.
   * @param {number} current
   */
  const restart = async current => {
    for (const reservation of [...reservations]) {
      if (reservation.start < current) {
        const { row, parent } = reservation;
        if (row !== undefined && !gone(row) && row.session !== undefined) {
          if (closed(parent)) {
            // Its parent was deleted meanwhile: never link under it.
            void deleteOrphan(row).catch(() => undefined);
          } else {
            linkChild(parent, row, reservation.name);
          }
        }
        release(reservation);
      }
    }
    for (const node of [...asking]) {
      if (node.ask !== undefined && node.ask.start < current) {
        endAsk(node, mailTexts.askAbandoned);
      }
    }
  };

  return harden({
    delegationFor,
    /**
     * @param {any} parentSession
     * @param {string} name
     * @param {string} [expectedKey]
     */
    findSubagentSession(parentSession, name, expectedKey) {
      const parent = rows.ofSession(parentSession);
      if (parent === undefined || closed(parent)) return undefined;
      const node = liveChildren(parent).find(child => child.name === name);
      if (
        !node ||
        node.stopping ||
        closed(node.row) ||
        node.row.state === 'lost' ||
        (expectedKey !== undefined && node.row.key !== expectedKey)
      )
        return undefined;
      return node.row.session;
    },
    deleteChildren,
    restart,
    /** @param {Row} row the child's node, if `row` is a live child */
    nodeOf: row => nodes.get(row),
    /** Bookkeeping sizes (tests, status). */
    status: () =>
      harden({ reservations: reservations.size, asking: asking.size }),
  });
};
harden(makeSubagents);

/** @typedef {ReturnType<typeof makeSubagents>} Subagents */
