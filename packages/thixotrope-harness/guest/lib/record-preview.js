// @ts-check
/**
 * How a history page shows one turn record (`designs/m2-interfaces.md` 4.9
 * and 6): text fields cut to previews, a staged field kept as it is, a
 * `ToolIntents` record cut to the intents that fit `PREVIEW_INTENTS_BYTES`.
 * One rule for both readers of the log: the session vat's history of its
 * kept turns (`guest/session/history.js`) and the agent host's `History` of
 * archived ones (`resources/agent-host/impl/archive/history.js`), so a turn
 * reads the same before and after it is sealed.
 *
 * The two readers differ only in what a staged field is (a vat `StagedText`
 * with its Blob, or an archived field keyed by blob key), how one intent is
 * measured, and whether a cut copy is hardened; the caller passes those.
 *
 * Runs in vats and in Node. Guest rules: no clock, no data-dependent keys.
 */
import { limits } from './limits.js';
import { previewText } from './bounded.js';

/** Bytes kept free in a history page for its wrapper. */
export const PAGE_SLACK = 512;
/** Bytes one ToolIntents record may take in a preview. */
export const PREVIEW_INTENTS_BYTES = 6144;
/** Bytes of a turn preview besides its records (keys, ids, state). */
export const TURN_PREVIEW_KEYS_BYTES = 64;

/**
 * @typedef {object} PreviewRules
 * @property {(value: any) => boolean} isStaged a staged field is its own
 *   preview
 * @property {(intent: any) => number} intentBytes the bytes one (cut)
 *   intent counts against `PREVIEW_INTENTS_BYTES`
 * @property {(value: any) => any} [finish] applied to every cut copy
 *   (default `harden`; the agent host passes the identity, it builds its
 *   shown form afterwards)
 */

/**
 * The record cut to its preview: the record itself when nothing needed a
 * cut, else a copy with the cut fields.
 * @param {any} record
 * @param {PreviewRules} rules
 * @returns {any}
 */
export const previewRecord = (
  record,
  { isStaged, intentBytes, finish = harden },
) => {
  /** @param {any} t */
  const message = t =>
    isStaged(t) ? t : previewText(t, limits.messagePreviewUnits);
  /** @param {any} t */
  const tool = t => (isStaged(t) ? t : previewText(t, limits.toolPreviewUnits));
  switch (record.kind) {
    case 'turn-started': {
      const input = message(record.input);
      return input === record.input ? record : finish({ ...record, input });
    }
    case 'partial':
    case 'round-settled': {
      const text = message(record.text);
      return text === record.text ? record : finish({ ...record, text });
    }
    case 'turn-settled': {
      if (record.final === undefined) return record;
      const final = message(record.final);
      return final === record.final ? record : finish({ ...record, final });
    }
    case 'tool-result': {
      const result = tool(record.result);
      return result === record.result ? record : finish({ ...record, result });
    }
    case 'tool-intents': {
      let bytes = 0;
      let changed = false;
      /** @type {any[]} */
      const intents = [];
      for (const intent of record.intents) {
        const args = tool(intent.args);
        const one = args === intent.args ? intent : finish({ ...intent, args });
        if (one !== intent) changed = true;
        bytes += intentBytes(one);
        if (bytes > PREVIEW_INTENTS_BYTES && intents.length > 0) {
          changed = true;
          break;
        }
        intents.push(one);
      }
      return changed
        ? finish({ ...record, intents: finish(intents) })
        : record;
    }
    default:
      return record;
  }
};
harden(previewRecord);
