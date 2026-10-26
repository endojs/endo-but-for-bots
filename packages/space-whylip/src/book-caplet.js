// @ts-check

import { makeError, X } from '@endo/errors';
import { E } from '@endo/eventual-send';

import { makeAuthorName } from './author-name.js';
import { makeBookSession } from './book-session.js';

const HELPER_PROMPT = `You are a background illustrator and scene developer for Whylip, an interactive storybook. Your sole work capability is the task draft. You have no live book or reader access.

First, call exec with exactly this JavaScript: const task = await E(powers).lookup('task'); return await E(task).getContext();
The exec result is the returned value. console.log output is not returned to you. Always return the data you need to inspect; never log the context. Read the returned instructions and base scene, then produce the requested draft. If its status is already completed, applied, or failed, dismiss the assignment with its supplied message number and set finishTurn:true on that exec call.

Use await E(task).read(path), await E(task).write(path,text), await E(task).edit(path,oldText,newText), and await E(task).list() to work in your draft. The task itself is the filesystem; there is no separate fs capability. Obtain task with await E(powers).lookup('task') in each exec call. Prefer Three.js scene development through the confined Preact virtual DOM. scene.js is one pure function expression: ({h,Fragment},{state,act,update,asset}) => ({scene,overlay}). scene is h('scene',{key:'world',background:'#102331'},...) containing keyed group, mesh, ambientLight, directionalLight, pointLight, and perspectiveCamera nodes; overlay is ordinary accessible Preact HTML. Preserve existing reader state, stable object keys, camera, and overlay controls. Mesh geometry is a data descriptor: box {width,height,depth}, sphere {radius}, cone {radius,height}, cylinder {radiusTop,radiusBottom,height}, plane {width,height}, torus {radius,tube}; material uses hex color/emissive, emissiveIntensity, roughness, metalness, opacity, wireframe, and side front/back/double. Transforms are position/rotation/scale [x,y,z]; camera uses position/lookAt/fov/near/far. Every node requires a globally unique key. Keep within 256 nodes, depth 24, and 65536 estimated vertices. Mesh onClick callbacks use update for immediate feedback and act for meaningful story events; provide equivalent HTML controls. Never expose THREE objects, import libraries, create canvas/renderers, use refs/hooks, or run timers. The host owns the persistent canvas and reconciles keyed objects. Use SVG files in assets/<unique-name>.svg only for optional 2D overlay illustrations, without external references, scripts, or XML/HTML comments (SES rejects comment markers even inside JavaScript strings). Never reply to the reader or create further agents.

After inspecting the context, write the requested files. In your final exec call, await all writes, await E(task).complete(shortSummary), dismiss the assignment using await E(powers).dismiss(number) with the bigint message number supplied in the assignment wrapper, then return shortSummary. Set finishTurn:true on that exec tool call so no extra model call is needed. If you cannot complete the assignment, await E(task).fail(reason), dismiss it, and return the reason with finishTurn:true. Stop afterward.`;

/**
 * Provision once with a stable resultName in a per-book host. All filesystem
 * persistence and helper factories remain inside this trusted caplet.
 * @param {any} powers
 * @param {unknown} _context
 * @param {{env?: {bookId?: string}}} [options]
 */
export const make = async (powers, _context, options = {}) => {
  const bookId = options.env?.bookId;
  if (bookId && !/^[a-zA-Z0-9_-]+$/.test(bookId))
    throw makeError(X`Invalid bookId`);
  const launchTask = async id => {
    const factory = await E(powers).lookup('fae-factory');
    const helperName = makeAuthorName(
      await E(powers).locate('@self'),
      `task-${id}`,
    );
    const { locator, agent } = await E(factory).createAgentCapability(
      helperName,
      harden({ systemPrompt: HELPER_PROMPT, pin: true, maxSubagentDepth: 0 }),
    );
    const taskName = `whylip-task-${id}`;
    if (!(await E(powers).has(taskName))) {
      await E(powers).makeUnconfined(
        '@node',
        new URL('./book-task-caplet.js', import.meta.url).href,
        harden({
          powersName: '@agent',
          resultName: taskName,
          env: { taskId: id },
        }),
      );
    }
    await E(agent).storeLocator('task', await E(powers).locate(taskName));
    const destination = `whylip-helper-${id}`;
    await E(powers).storeLocator(destination, locator);
    await E(powers).send(
      destination,
      [
        `WHYLIP_DRAFT_TASK ${id}\nFirst exec: const task = await E(powers).lookup('task'); return await E(task).getContext();\nReturn the context; console.log output is not returned. Read its instructions and status, write the requested draft, then complete(summary), dismiss this assignment, and return the summary with finishTurn:true. This may be a resumed assignment; do not redo a completed, applied, or failed task.`,
      ],
      [],
      [],
    );
  };
  const notifyTask = async summary => {
    await E(powers).send(
      'fae',
      [
        `WHYLIP_TASK_${summary.status.toUpperCase()}\n${JSON.stringify(summary)}\nUse book.getContext()/listTasks(). Apply a completed asset-only draft with applyTask(id); apply a scene draft with applyTask(id, currentSourceRevision). If its base scene is stale, read and rebase the draft instead. Continue the reader's story and dismiss this notification.`,
      ],
      [],
      [],
    );
  };
  return makeBookSession(
    powers,
    bookId ? `whylip-book-${bookId}` : 'whylip-book-data',
    { launchTask, notifyTask },
  );
};
harden(make);
