// @ts-check
/**
 * The subagent tools (designs/m9-interfaces.md 3.2, 4.3, 4.4; R3-39,
 * R4-69..R4-73, A.3): `spawnSubagent`, `askSubagent`, `stopSubagent`,
 * static entries of the tool table (D-M9-17), offered only while the
 * session holds a `Delegation` (`services.subagents`: absent at the depth
 * limit, R4-69). The state is the `subagents` runtime part's
 * (`../subagents.js`), reached as `context.runtime.subagents`.
 *
 * - `spawnSubagent({ name, systemPrompt?, attachments?, modelId?,
 *   reasoningEffort? })`: the name rule (`subagentNameSource`, D-M9-12) and
 *   uniqueness among the live children and the spawns in flight, an inline
 *   `systemPrompt` (D-M9-20), the attachments resolved by label, a model and
 *   an effort of the guard's size (D-M9-25: the factory checks them against
 *   the catalogue; absent, the child keeps the parent's); then
 *   `Delegation.spawn`, and the answered handle is bound under the name.
 * - `askSubagent({ name, task, timeoutSeconds?, attachments? })`: one ask
 *   per child, its deadline armed on the turn's endpoint (`timeoutSeconds`,
 *   default 86,400); `SubagentHandle.ask` answers the reply text already
 *   cut to the tool limit by the factory, which the tool records as it is.
 *   The deadline answers `askTimeout` and tells the child (`cancelAsk`).
 * - `stopSubagent({ name })`: `SubagentHandle.stop()` (the factory deletes
 *   the subtree, deepest first), then the name is unbound.
 *
 * Arguments are read with `parseClosedArgs`. Arguments over `inlineBytes`
 * (a long task or a long `systemPrompt`) arrive staged; the session cannot
 * parse a blob, so its exec vat splits them (`splitArgs`, D-M9-14): the
 * residual JSON comes back with each long string as a placeholder
 * (`"\u0000s<k>"`) and the strings as StagedTexts, which replace their
 * placeholders here. `attachments` is a list of `{ name, petName }` read as
 * a raw span and split into its elements (the closed reader has no list of
 * objects); each element is read by the closed reader. A `petName`
 * `subagents/<name>` names a child's handle in the part's map, any other is
 * a held object or stored JSON value in the label map.
 *
 * Every refusal comes before any send. Refusals the factory makes (the
 * tree limit, a lost child) arrive as the rejection's message and are
 * recorded as the failed result; the session composes none of them
 * (D-M9-19). No method of a held object is called: a handle is a factory
 * exo (D-M9-3). Guest rules.
 */
import { failed, ok } from './outcomes.js';
import {
  mailToolArgumentNames,
  textOf as mailTextOf,
  subagentLabelPrefix,
  subagentNameSource,
  texts,
  textOf,
} from '../../lib/guards/session.js';
import { limits } from '../../lib/limits.js';
import { parseClosedArgs } from '../../lib/tool-args.js';
import { fitsFrame, messageOf } from '../../lib/bounded.js';
import { isValidLabel } from '../labels.js';
import { fieldBytes, isStaged } from '../staging.js';
import { inspectFor } from './inspect-client.js';
import { notCapabilityText } from './inspection.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { ToolTableEntry } from '../tool-table.js' */
/** @import { ArgSpec, ArgKind } from '../../lib/tool-args.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

const ML = limits;
const NAME = RegExp(subagentNameSource);
/** The `splitArgs` placeholder of a staged string (`guards/base.js` SplitArgs). */
const PLACEHOLDER = '\u0000s';
/** A `splitArgs` answer that is neither a split nor a failed result. */
const SPLIT_FAILED = 'The staged arguments could not be read';

/**
 * Per argument name: its kind for the closed reader and its schema for the
 * model (one table, so the two cannot differ).
 * @type {Record<string, [ArgKind, Record<string, any>]>}
 */
const argumentsOf = {
  name: ['string', { type: 'string', pattern: subagentNameSource }],
  petName: ['string', { type: 'string' }],
  systemPrompt: ['string', { type: 'string' }],
  modelId: ['string', { type: 'string' }],
  reasoningEffort: ['string', { type: 'string' }],
  task: ['string', { type: 'string' }],
  timeoutSeconds: ['integer', { type: 'integer' }],
  attachments: [
    'raw',
    {
      type: 'array',
      items: { type: 'object', properties: { name: {}, petName: {} } },
    },
  ],
};

/**
 * A tool's closed spec and its description, from `mailToolArgumentNames`
 * (the first `required` names required).
 * @param {'spawnSubagent' | 'askSubagent' | 'stopSubagent' | 'attachment'} tool
 * @param {number} required
 * @param {string} [description]
 * @param {readonly string[]} [hidden] names the reader takes but the
 *   description does not offer (D-M9-25: an older factory's spawn)
 */
const toolOf = (tool, required, description = '', hidden = []) => {
  const names = mailToolArgumentNames[tool];
  /** @type {Record<string, any>} */
  const properties = {};
  for (const name of names) {
    if (!hidden.includes(name)) [, properties[name]] = argumentsOf[name];
  }
  return harden({
    /** @type {ArgSpec} */
    spec: {
      tool,
      fields: names.map((name, i) => ({
        name,
        kind: argumentsOf[name][0],
        required: i < required,
      })),
    },
    description: {
      name: tool,
      description,
      parameters: JSON.stringify({
        type: 'object',
        additionalProperties: false,
        properties,
        required: names.slice(0, required),
      }),
    },
  });
};

/** The harness's words after Fae's A.3 schemas. */
const tools = harden({
  spawnSubagent: toolOf(
    'spawnSubagent',
    1,
    'Create a subagent: a hidden helper session like yours holding only the attachments ({name, petName}; petName subagents/<name> passes a subagent). It runs on your backend with your model and reasoning effort unless you give modelId (a model of your backend) or reasoningEffort (one that model offers). Then use askSubagent and stopSubagent by its name.',
  ),
  askSubagent: toolOf(
    'askSubagent',
    2,
    `Send a task to a subagent and wait for its reply (timeoutSeconds, default ${ML.askTimeoutSeconds}); one question per subagent at a time.`,
  ),
  stopSubagent: toolOf(
    'stopSubagent',
    1,
    'Stop a subagent and delete it with its own subagents.',
  ),
  attachment: toolOf('attachment', 2),
});

/**
 * D-M9-25: `spawnSubagent` as offered on a factory whose `SpawnRequest`
 * predates `modelId` and `reasoningEffort` (the session part read it from
 * the factory's guard): the same tool without the two options.
 */
const spawnWithoutOptions = toolOf(
  'spawnSubagent',
  1,
  'Create a subagent: a hidden helper session like yours holding only the attachments ({name, petName}; petName subagents/<name> passes a subagent). It runs on your backend with your model and reasoning effort (this harness cannot choose them per subagent). Then use askSubagent and stopSubagent by its name.',
  ['modelId', 'reasoningEffort'],
).description;

/**
 * Read a tool's arguments, inline or staged (`splitArgs` in the exec vat).
 * @param {ArgSpec} spec
 * @param {any} args
 * @param {any} ports
 * @param {any} context
 * @returns {Promise<{ values: Map<string, any> } | { outcome: any }>}
 */
export const readStagedArgs = async (spec, args, ports, context) => {
  let json = args;
  /** @type {readonly any[]} */
  let staged = [];
  if (isStaged(args)) {
    // Staged arguments come with the round's writers (the adapter staged
    // them); without an exec vat the inspector answers execUnavailable.
    const outcome = await inspectFor(context)(
      harden({
        op: 'splitArgs',
        // The guard asks a target; `splitArgs` calls none (D-M9-14).
        target: ports.writers,
        writers: ports.writers,
        args,
        ...(ports.content === undefined ? {} : { content: ports.content }),
      }),
    );
    if (outcome?.status !== 'split')
      return {
        outcome: outcome?.status === 'failed' ? outcome : failed(SPLIT_FAILED),
      };
    ({ json, staged } = outcome.split);
  }
  const parsed = parseClosedArgs(json, spec);
  if (!parsed.ok) return { outcome: failed(parsed.text) };
  if (staged.length === 0) return { values: parsed.values };
  /** @type {Map<string, any>} */
  const values = new Map();
  for (const [key, value] of parsed.values) {
    values.set(
      key,
      typeof value === 'string' && value.startsWith(PLACEHOLDER)
        ? staged[Number(value.slice(PLACEHOLDER.length))]
        : value,
    );
  }
  return { values };
};
harden(readStagedArgs);

/**
 * The object a petName names for an attachment or a recipient: a child's
 * handle for `subagents/<name>` (the part's map), else the label map's
 * object binding (D-M9-23). Exported for the mail tools.
 * @param {any} context the ToolContext
 * @param {string} petName
 * @param {boolean} [allowCopy] copy data is a payload, never an address
 * @returns {{ value: any } | { refused: string }}
 */
export const heldObject = (context, petName, allowCopy = false) => {
  const { labels, subagents } = context.runtime;
  if (petName.startsWith(subagentLabelPrefix)) {
    const name = petName.slice(subagentLabelPrefix.length);
    const value = subagents?.handleOf(name);
    return value === undefined
      ? { refused: mailTextOf.noSubagent(name) }
      : { value };
  }
  const binding = labels.get(petName);
  if (binding === undefined) return { refused: textOf.unknownLabel(petName) };
  if (allowCopy && binding.kind === 'json')
    return { value: harden({ json: binding.text }) };
  if (binding.kind !== 'object') return { refused: notCapabilityText(petName) };
  return { value: binding.value };
};
harden(heldObject);

/**
 * The elements of a JSON array span (already checked JSON by the closed
 * reader), at most `max + 1` of them.
 * @param {string} span
 * @param {number} max
 */
const elementsOf = (span, max) => {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let start = 1;
  let quoted = false;
  for (let i = 1; i < span.length - 1 && out.length <= max; i += 1) {
    const c = span[i];
    if (quoted) {
      if (c === '\\') i += 1;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(span.slice(start, i));
      start = i + 1;
    }
  }
  const last = span.slice(start, -1);
  if (last.trim() !== '') out.push(last);
  return out;
};

/**
 * The `Attachments` of an `attachments` argument (absent: none).
 * @param {string | undefined} span
 * @param {any} context
 * @returns {{ attachments: any[] } | { outcome: any }}
 */
const attachmentsOf = (span, context) => {
  /** @type {any[]} */
  const attachments = [];
  if (span === undefined) return { attachments };
  if (span[0] !== '[')
    return {
      outcome: failed(
        textOf.argumentsNotJson('argument "attachments" must be an array'),
      ),
    };
  const elements = elementsOf(span, limits.maxAttachments);
  if (elements.length > limits.maxAttachments)
    return { outcome: failed(textOf.tooManyAttachments(elements.length)) };
  for (const element of elements) {
    const parsed = parseClosedArgs(element, tools.attachment.spec);
    if (!parsed.ok) return { outcome: failed(parsed.text) };
    const label = /** @type {string} */ (parsed.values.get('name'));
    if (!isValidLabel(label))
      return { outcome: failed(textOf.reservedLabel(label)) };
    if (attachments.some(a => a.label === label))
      return { outcome: failed(textOf.duplicateAttachment(label)) };
    const held = heldObject(context, parsed.values.get('petName'), true);
    if ('refused' in held) return { outcome: failed(held.refused) };
    attachments.push(harden({ label, value: held.value }));
  }
  return { attachments: harden(attachments) };
};

/**
 * @param {any} _ports
 * @param {any} services
 */
const available = (_ports, services) => services?.subagents !== undefined;

/**
 * Read the arguments, then the name, then `work(values, name, part,
 * request, context)`; a rejection of `work` is the failed result.
 * @param {'spawnSubagent' | 'askSubagent' | 'stopSubagent'} tool
 * @param {(values: Map<string, any>, name: string, part: any, request: any, context: any) => Promise<any> | any} work
 * @returns {ToolTableEntry['execute']}
 */
const withName = (tool, work) => async (request, ports, context) => {
  const read = await readStagedArgs(
    tools[tool].spec,
    request.args,
    ports,
    context,
  );
  if ('outcome' in read) return read.outcome;
  const name = read.values.get('name');
  if (!NAME.test(name)) return failed(mailTextOf.nameInvalid(name));
  try {
    return await work(
      read.values,
      name,
      context.runtime.subagents,
      request,
      context,
    );
  } catch (error) {
    return failed(messageOf(error));
  }
};

/** @type {ToolTableEntry} */
const spawnEntry = harden({
  name: 'spawnSubagent',
  site: 'guest',
  describe: (_ports, _services, runtime) =>
    runtime?.subagents?.spawnOptions?.() === false
      ? spawnWithoutOptions
      : tools.spawnSubagent.description,
  available,
  execute: withName(
    'spawnSubagent',
    async (values, name, part, _request, context) => {
      if (part.taken(name)) return failed(mailTextOf.subagentExists(name));
      const systemPrompt = values.get('systemPrompt');
      if (systemPrompt !== undefined) {
        const bytes = /** @type {number} */ (fieldBytes(systemPrompt));
        if (isStaged(systemPrompt) || bytes > ML.systemPromptBytes)
          return failed(
            mailTextOf.systemPromptTooLong(bytes, ML.systemPromptBytes),
          );
      }
      // D-M9-25: absent, the child keeps the parent's model and effort.
      const modelId = values.get('modelId');
      const reasoningEffort = values.get('reasoningEffort');
      for (const [field, value, limit] of /** @type {const} */ ([
        ['modelId', modelId, ML.modelIdUnits],
        ['reasoningEffort', reasoningEffort, ML.effortUnits],
      ])) {
        if (
          value !== undefined &&
          (isStaged(value) ||
            typeof value !== 'string' ||
            value.trim() === '' ||
            value.length > limit)
        )
          return failed(mailTextOf.spawnOptionInvalid(field, limit));
      }
      // D-M9-25: an older factory's closed SpawnRequest would refuse the
      // options with a raw guard error; its guard says so first.
      if (
        (modelId !== undefined || reasoningEffort !== undefined) &&
        (await part.whenSpawnOptions()) === false
      )
        return failed(texts.spawnOptionsUnsupported);
      const attached = attachmentsOf(values.get('attachments'), context);
      if ('outcome' in attached) return attached.outcome;
      const spawnRequest = harden({
        name,
        attachments: attached.attachments,
        at: part.at(),
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
        ...(modelId === undefined ? {} : { modelId }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      });
      if (attached.attachments.length && !fitsFrame(spawnRequest))
        return failed(texts.frameLimit);
      part.spawning(name, context.turn);
      /** @type {any} */
      let answer;
      try {
        answer = await E(part.delegation()).spawn(spawnRequest);
      } finally {
        part.spawned(name, answer?.handle, answer?.childKey);
      }
      return ok(mailTextOf.spawned(name));
    },
  ),
});

/** @type {ToolTableEntry} */
const askEntry = harden({
  name: 'askSubagent',
  site: 'guest',
  describe: () => tools.askSubagent.description,
  available,
  execute: withName('askSubagent', (values, name, part, request, context) => {
    const task = values.get('task');
    // A staged task's length in units is not known in this vat: it is
    // refused only when its bytes prove it longer (3 bytes a unit at most).
    if (
      isStaged(task)
        ? /** @type {number} */ (task.bytes) > 3 * ML.taskUnits
        : typeof task !== 'string' ||
          task.length === 0 ||
          task.length > ML.taskUnits
    )
      return failed(mailTextOf.taskInvalid(ML.taskUnits));
    const seconds = /** @type {number} */ (
      values.get('timeoutSeconds') ?? ML.askTimeoutSeconds
    );
    if (seconds < ML.minAskTimeoutSeconds || seconds > ML.maxAskTimeoutSeconds)
      return failed(
        mailTextOf.timeoutInvalid(
          ML.minAskTimeoutSeconds,
          ML.maxAskTimeoutSeconds,
        ),
      );
    const attached = attachmentsOf(values.get('attachments'), context);
    if ('outcome' in attached) return attached.outcome;
    const { opId } = request;
    const { generation } = context;
    const askRequest = harden({
      task,
      attachments: attached.attachments,
      at: part.at(),
    });
    if (attached.attachments.length && !fitsFrame(askRequest))
      return failed(texts.frameLimit);
    const opened = part.openAsk(name, {
      opId,
      turn: context.turn,
      generation,
      endpoint: context.endpoint,
      seconds,
    });
    if ('refused' in opened) return failed(opened.refused);
    E(opened.handle)
      .ask(askRequest)
      .then(
        answer => part.closeAsk(opId, generation, ok(answer.text)),
        error => part.closeAsk(opId, generation, failed(messageOf(error))),
      );
    return opened.entry.promise;
  }),
  deadline: ({ opId }, context) => {
    context.runtime.subagents?.timeout(opId, context.turn);
  },
});

/** @type {ToolTableEntry} */
const stopEntry = harden({
  name: 'stopSubagent',
  site: 'guest',
  describe: () => tools.stopSubagent.description,
  available,
  execute: withName('stopSubagent', async (_values, name, part) => {
    const handle = part.handleOf(name);
    if (handle === undefined) return failed(mailTextOf.noSubagent(name));
    await E(handle).stop();
    part.unbind(name);
    return ok(mailTextOf.stopped(name));
  }),
});

/** The entries appended to `toolTable` (seam S6), in `subagentToolNames` order. */
export const subagentToolEntries = harden([spawnEntry, askEntry, stopEntry]);
