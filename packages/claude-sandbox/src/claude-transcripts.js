// @ts-check

/**
 * Resume decisions read from a session's persistent Claude config directory
 * on the host: Claude Code names each conversation transcript
 * `<session-uuid>.jsonl` under `projects/<project>/`. The helpers are
 * consulted before every spawn, never once at construction, so a first turn
 * killed before Claude persisted anything does not resume nothing, and a
 * post-restart turn resumes whenever a transcript exists.
 *
 * @module
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import nodePath from 'node:path';

/** Claude Code names each conversation transcript `<session-uuid>.jsonl`. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * @param {string} configHostDir Plain host backing directory of the
 *   session's `CLAUDE_CONFIG_DIR`.
 * @param {{ debug?: boolean }} [options] `debug` opts into the per-spawn
 *   transcript description. Callers read `ENDO_CLAUDE_DEBUG_RESUME` from
 *   `process.env` rather than a formula env so it can be turned on for
 *   sessions whose env was frozen at provision time (set it on the daemon and
 *   restart).
 */
export const makeTranscriptResume = (configHostDir, { debug = false } = {}) => {
  const projectsDir = nodePath.join(configHostDir, 'projects');
  const listTranscripts = () => {
    if (!existsSync(projectsDir)) return [];
    return readdirSync(projectsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry => {
        const projectDir = nodePath.join(projectsDir, entry.name);
        return readdirSync(projectDir)
          .filter(file => file.endsWith('.jsonl'))
          .map(file => nodePath.join(projectDir, file));
      });
  };
  // The newest non-empty transcript, named for the Claude Code session it
  // holds. Only a non-empty `*.jsonl` counts: Claude Code creates the per-cwd
  // project directory (and sibling scratch dirs such as `memory/`) as soon as
  // it starts, so a merely non-empty `projects/` is true even for a spawn that
  // died before writing a resumable turn — and resuming that errors out or
  // silently forks a fresh, context-free conversation.
  /** @returns {string | undefined} */
  const resolveResumeSessionId = () =>
    listTranscripts()
      .map(file => ({
        // Claude Code names each transcript for its session id. Anything
        // else is not ours to resume by name.
        id: nodePath.basename(file, '.jsonl'),
        // lstat, not stat: the config dir is guest-writable, so a planted
        // symlink or FIFO must read as "not a transcript", never be
        // followed.
        stat: lstatSync(file),
      }))
      .filter(
        ({ id, stat }) => stat.isFile() && stat.size > 0 && UUID_RE.test(id),
      )
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0]?.id;
  // Deliberately broader than the resolver: any non-empty transcript means a
  // turn already ran, even one this code cannot name. Such a session still
  // resumes, via the `--continue` fallback, rather than reading as fresh.
  const detectPriorConversation = () =>
    listTranscripts().some(file => {
      const stat = lstatSync(file);
      return stat.isFile() && stat.size > 0;
    });
  // Opt-in resume diagnostics: per spawn, the transcripts the detector saw
  // and whether the newest external user entry chained onto earlier turns —
  // the ground truth for "did the model actually resume its history".
  const describeTranscripts = () =>
    listTranscripts()
      // Regular files only: a FIFO planted in the guest-writable config dir
      // would otherwise block the worker in the read below.
      .filter(file => lstatSync(file).isFile())
      .map(file => {
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
        const prompts = lines
          .flatMap(line => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          })
          // A human turn: an external, non-sidechain user entry whose content
          // is plain text. Tool results are also `user` entries, with array
          // content.
          .filter(
            entry =>
              entry.type === 'user' &&
              entry.userType === 'external' &&
              !entry.isSidechain &&
              typeof entry.message?.content === 'string',
          );
        return {
          file: nodePath.basename(file),
          entries: lines.length,
          prompts: prompts.length,
          // How many turns saw the conversation so far. Anything short of
          // `prompts - 1` means context was lost mid-session.
          chained: prompts.filter(entry => entry.parentUuid).length,
          lastChained: prompts.length
            ? Boolean(prompts[prompts.length - 1].parentUuid)
            : null,
        };
      });
  return harden({
    listTranscripts,
    resolveResumeSessionId,
    detectPriorConversation,
    ...(debug ? { describeTranscripts } : {}),
  });
};
harden(makeTranscriptResume);
